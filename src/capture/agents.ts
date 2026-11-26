import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { readProjectConfig, roleTurnLimitMs } from "../config.ts";
import { PACKAGE_ROOT } from "../environment.ts";
import { ask, BEGIN, createExecutor, timeTurns } from "../pi.ts";
import { withActivity, type ActivitySink } from "../regenerate/activity.ts";
import { confinedTools } from "../regenerate/confine.ts";
import { STDLIB_DIR } from "../regenerate/paths.ts";

/**
 * Capture's agents, each fresh, each with one thing to hand over through a submit tool of its own: the survey, its
 * conventions checked, a split, an outline, a part's features divided, a feature, the interface no feature captured, a
 * part's features gathered into modules, concepts reconciled, a module's readability pass, its interface checked against the code,
 * its scenarios tried on the original. The harness checks what each hands over and sends it back with what is wrong, a
 * few times at most; what still does not hold is the harness's to deal with - a feature left uncaptured, the report
 * saying so - never a stop of the whole capture.
 */

/** How many times an answer that does not hold is sent back. */
export const RETRIES = 2;

/** How long one turn of a capture agent may take, unless the config says: exploring takes a while. */
export const CAPTURE_TURN_LIMIT_MS = 10 * 60 * 1000;

const PROMPTS_DIR = join(PACKAGE_ROOT, "genome", "capture");

// These reviewers can only return edits to existing text. Keep the rules for that text and the full source/reference
// evidence; they have no modules, stacks, integrations, testing scripts or regeneration workflow to design.
const REVIEW_TEXT_RULES = ["concise-specs", "concise-specs-examples", "func-specs", "test-plain-files", "definitions", "linked-resources", "bullet-continuation", "semantic-ids"];

/** One of capture's prompts, from genome/capture. */
export function capturePrompt(name: string): string {
  return readFileSync(join(PROMPTS_DIR, `${name}.md`), "utf8").trim();
}

export interface AgentOptions {
  /** The capture's output folder: where turri keeps the agent's logs, never what it reads. */
  plainDir: string;
  /** The codebase, which the agent reads. */
  root: string;
  role: "capture" | "capture-analysis";
  model?: string;
  label: string;
  /** Its prompt's name in genome/capture, after the shared one - or several, in order. */
  prompt: string | string[];
  /** What it is given for this run: its part of the map, its feature, ... */
  context: string;
  /** Whether it reads the codebase - not the agents that work from ***plain alone. */
  reads: boolean;
  /** Whether it gets the ***plain rules - the agents that write ***plain. */
  rules: boolean;
  /** Tool calls before it is told to hand over. */
  calls: number;
  /**
   * A shell of its own, on this machine behind every wall an agent's shell has, and file tools that read and write `workdir`
   * alone - in place of the read-only tools over the codebase: the agent that runs a copy of the original. Its home, its
   * temporary folder and its package caches are kept under `home`.
   */
  shell?: { workdir: string; home: string };
  /** The least a turn of it may take, whatever the config says - unless it turns the limit off: an agent with much to run. */
  turnAtLeastMs?: number;
  /** Who watches it at work: the capture's status. */
  watch?: AgentWatch;
  /** Stops it mid-turn: the capture stopped. */
  signal?: AbortSignal;
}

/** Who watches an agent at work - the capture's status: when it starts, what it does, what it costs, when it ends. */
export interface AgentWatch {
  started(): void;
  /** A tool call it made, or a result worth a line: `○ read app/main.py`. */
  did(line: string): void;
  /** What it is at this moment - thinking, waiting for the model, writing a call - or nothing. */
  now(label: string | undefined): void;
  /** What one model response cost, in dollars. */
  spent(cost: number): void;
  ended(): void;
}

/** What the agent's session reports, handed to its watch - and the capture's stop, which ends its turn. */
function watchedBy(watch: AgentWatch | undefined, signal: AbortSignal | undefined): ActivitySink {
  return {
    stage: () => {},
    activity: (line) => watch?.did(line),
    now: (label) => watch?.now(label),
    usage: (usage) => watch?.spent(usage.cost),
    transcript: () => {},
    ...(signal !== undefined ? { signal } : {}),
  };
}

/** Ask an agent for one answer, sending it back with what is wrong until it holds. Undefined, with the last problems, when it never did. */
export async function askAgent<A>(
  options: AgentOptions,
  tool: { name: string; label: string; description: string; parameters: TSchema; convert: (params: Record<string, unknown>) => A },
  check: (answer: A) => string[],
): Promise<{ answer?: A; problems: string[] }> {
  return watched(options.watch, options.signal, () => answerOf(options, tool, check));
}

/** Work of agents its watch sees from start to end - each tool call, each answer's cost - and the capture's stop ends. */
export async function watched<T>(watch: AgentWatch | undefined, signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
  watch?.started();
  try {
    return await withActivity(watchedBy(watch, signal), work);
  } finally {
    watch?.ended();
  }
}

async function answerOf<A>(
  options: AgentOptions,
  tool: { name: string; label: string; description: string; parameters: TSchema; convert: (params: Record<string, unknown>) => A },
  check: (answer: A) => string[],
): Promise<{ answer?: A; problems: string[] }> {
  let answer: A | undefined;
  const submit = defineTool({
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters,
    async execute(_id, params) {
      answer = tool.convert(params as Record<string, unknown>);
      return { content: [{ type: "text" as const, text: "Recorded." }], details: {}, terminate: true };
    },
  }) as ToolDefinition;
  const fence =
    options.shell !== undefined
      ? confinedTools({ workdir: options.shell.workdir, read: [options.shell.workdir], write: [options.shell.workdir], shellHome: options.shell.home })
      : options.reads
        ? confinedTools({ workdir: options.root, read: [options.root, STDLIB_DIR], write: [], noBash: true })
        : undefined;
  const session = await createExecutor({
    cwd: options.plainDir,
    customTools: [submit, ...(fence?.tools ?? [])],
    tools: [...(fence?.names ?? []), submit.name],
    model: options.model,
    rules: options.rules && (options.prompt === "verify" || options.prompt === "readability") ? REVIEW_TEXT_RULES : options.rules,
    label: options.label,
    role: options.role,
    ...(fence !== undefined ? { system: fence.note } : {}),
    task: [capturePrompt("capture"), ...[options.prompt].flat().map(capturePrompt), options.context].join("\n\n"),
    budget: { calls: options.calls, finish: [submit.name] },
  });
  const limit = turnLimit(options.plainDir, options.role);
  timeTurns(session, limit === 0 ? 0 : Math.max(limit, options.turnAtLeastMs ?? 0));
  let problems: string[] = [];
  try {
    await ask(session, BEGIN);
    for (let again = 0; ; again += 1) {
      problems = answer === undefined ? [`You did not call ${submit.name}.`] : check(answer);
      if (problems.length === 0) return { answer, problems };
      if (again >= RETRIES) return { problems };
      answer = undefined;
      await ask(session, `That does not hold:\n- ${problems.join("\n- ")}\n\nCall ${submit.name} again, with it fixed.`);
    }
  } finally {
    session.dispose();
  }
}

function turnLimit(plainDir: string, role: AgentOptions["role"]): number {
  try {
    return roleTurnLimitMs(readProjectConfig(plainDir), role) ?? CAPTURE_TURN_LIMIT_MS;
  } catch {
    return CAPTURE_TURN_LIMIT_MS;
  }
}

const Strings = (description: string) => Type.Array(Type.String(), { description });
const Definitions = Type.Array(
  Type.Object({
    concept: Type.String({ description: "The concept, between colons: :Note:." }),
    text: Type.String({ description: "One plain sentence that starts with the concept: \":Note: is a short text a :User: keeps.\"" }),
  }),
);
const LeftOutSchema = Type.Array(Type.Object({ path: Type.String(), why: Type.String() }), { description: "What is not captured, by path, with why." });

/** A list of strings an agent handed over, its blanks dropped. */
export function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter((item) => item !== "") : [];
}

function records(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => item !== null && typeof item === "object") : [];
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function definitionsOf(value: unknown): Array<{ concept: string; text: string }> {
  return records(value).map((item) => ({ concept: text(item.concept), text: text(item.text) }));
}

export function leftOutOf(value: unknown): Array<{ path: string; why: string }> {
  return records(value).map((item) => ({ path: text(item.path).replace(/\/+$/, "") || ".", why: text(item.why) }));
}

const ConventionSchema = Type.Object({
  text: Type.String({ description: "One fact every feature follows, exact - the stream, the text, the code - without the leading - ." }),
  where: Strings("The files whose code decides it, relative to the codebase."),
});

export const CONVENTIONS_TOOL = {
  name: "submit_capture_conventions",
  label: "Submit the conventions",
  description: "Every convention as the code has it - those that hold word for word, those corrected, and any the code shows that was missed - and what you changed.",
  parameters: Type.Object({
    conventions: Type.Array(ConventionSchema),
    changes: Strings("What you changed, a line each, with why - citing the code. None when every convention held."),
  }),
};

export const SURVEY_TOOL = {
  name: "submit_capture_survey",
  label: "Submit the survey",
  description: "The codebase's parts, each with its stack, its implementation and test reqs and its core concepts; what is left out; what you assumed.",
  parameters: Type.Object({
    parts: Type.Array(
      Type.Object({
        name: Type.String({ description: "Short kebab-case." }),
        about: Type.String({ description: "What the part is, in a line." }),
        paths: Strings("Its folders and files, relative to the codebase - . for the whole of it."),
        stdlib_stack: Type.Optional(Type.String({ description: "A standard library stack it imports, stdlib/<kind>/<stack> - only one the original agrees with." })),
        stdlib_conformance: Type.Optional(Type.Boolean({ description: "Import that stack's conformance template too." })),
        implementation_reqs: Strings("How it is built, one fact each, without the leading - ."),
        conventions: Type.Optional(
          Type.Array(ConventionSchema, {
            description:
              "What every feature does the same way and a user or a script relies on: how errors are written, the exit code or status of each kind of failure, how input and output act when not a terminal, and what reaches the other side of every call it makes or answers - the headers it adds, how bodies and headers are encoded, when a body is read.",
          }),
        ),
        test_reqs: Strings("How its conformance tests run, one fact each, and what each sets up so the software acts the same on every run and machine - empty when the conformance template says it all."),
        definitions: Definitions,
      }),
    ),
    left_out: LeftOutSchema,
    assumptions: Strings("What you decided where the codebase left it open, a line each."),
    separate_concerns: Type.Optional(Type.String({ description: "Only for a single part whose behaviour demonstrably needs separate writers: name distinct independently useful concerns that cannot fit one readable module of eight functional specs. Omit when one compact writer can capture it." })),
  }),
};

export const REFERENCE_TOOL = {
  name: "submit_capture_reference",
  label: "Submit the interface reference",
  description:
    "Every piece of the interface the files you were given define - each command, argument, option, route and environment variable - exactly as the code has it, each with where it is defined; and what the map found there that is not the software's interface, with why.",
  parameters: Type.Object({
    entries: Type.Array(
      Type.Object({
        kind: Type.Union([Type.Literal("command"), Type.Literal("argument"), Type.Literal("option"), Type.Literal("route"), Type.Literal("env"), Type.Literal("other")]),
        name: Type.String({ description: "Exactly as the code has it: --proxy, http, httpie plugins install, GET /notes/<int:id> (the code's own parameter syntax), HTTPIE_CONFIG_DIR." }),
        aliases: Strings("Every other name it has, as the code has each: -x."),
        command: Type.Optional(Type.String({ description: "For an argument or option: one actual command, as typed. Repeat a shared option's entry for each command accepting it; never join commands into a made-up command name." })),
        takes: Type.Optional(Type.String({ description: "What it takes: its value's form or type, as the code names it - its metavar, its type, a body." })),
        choices: Strings("The values it accepts when the code lists them, each exactly as the code has it."),
        default: Type.Optional(Type.String({ description: "Its default, exactly as the code has it. Left out when it has none." })),
        repeatable: Type.Optional(Type.Boolean()),
        required: Type.Optional(Type.Boolean()),
        hidden: Type.Optional(Type.Boolean({ description: "True when it is left out of its help." })),
        help: Type.Optional(Type.String({ description: "Its help text, word for word as the code has it, placeholders and all - never a summary." })),
        details: Strings("A route's parameters, fields and answers, a line each: query page: int, 1 by default; 201: the note created."),
        where: Type.String({ description: "path:line - the file it is defined in, relative to the codebase, and the line." }),
        also: Strings("Other files its literals come from: where a default or its choices are worked out."),
      }),
    ),
    excluded: Type.Array(Type.Object({ name: Type.String(), path: Type.String(), why: Type.String() }), { description: "What the map found in your files that is not the software's interface - an option of a development script, say - by name, with why. None when none." }),
  }),
};

export const REFERENCE_CHECKED_TOOL = {
  name: "submit_capture_reference_checked",
  label: "Submit the checked reference",
  description: "Every entry of the interface reference as the code has it - those that hold word for word, those corrected, those missed - every exclusion, and what you changed.",
  parameters: Type.Object({
    ...REFERENCE_TOOL.parameters.properties,
    changes: Strings("What you changed, a line each, with why - the file, and what its code does. None when every entry held."),
  }),
};

export const AREAS_TOOL = {
  name: "submit_capture_areas",
  label: "Submit the areas",
  description: "Your area split into smaller areas, in build order, every file in one of them or left out.",
  parameters: Type.Object({
    areas: Type.Array(
      Type.Object({
        name: Type.String({ description: "Short kebab-case, from what the area does." }),
        about: Type.String({ description: "What it does, in a line." }),
        paths: Strings("Its folders and files, relative to the codebase."),
      }),
    ),
    left_out: LeftOutSchema,
  }),
};

export const FEATURES_TOOL = {
  name: "submit_capture_features",
  label: "Submit the features",
  description: "Your area's features, in build order, each with the folders and files where it is built.",
  parameters: Type.Object({
    features: Type.Array(
      Type.Object({
        name: Type.String({ description: "Short kebab-case." }),
        title: Type.String({ description: "A few words." }),
        about: Type.String({ description: "What it lets someone do, in a line." }),
        paths: Strings("Where it is built, relative to the codebase."),
      }),
    ),
    left_out: LeftOutSchema,
  }),
};

export const OWNERS_TOOL = {
  name: "submit_capture_owners",
  label: "Submit the owners",
  description: "Each behaviour given to one feature: what every feature that stays owns, and the features merged into others.",
  parameters: Type.Object({
    features: Type.Array(
      Type.Object({
        feature: Type.String({ description: "The feature's key, as listed: <area>#<feature>." }),
        owns: Type.String({ description: "What it alone captures, in a line: its options, commands, messages and behaviour." }),
      }),
      { description: "Every feature that stays." },
    ),
    merged: Type.Array(
      Type.Object({
        feature: Type.String({ description: "The key of the feature merged." }),
        into: Strings("The keys of the features that take its behaviour."),
        why: Type.String({ description: "Why, in a line." }),
      }),
      { description: "Features whose behaviour others own whole - none when none." },
    ),
  }),
};

const ScenarioSchema = Type.Array(Type.Object({ scenario_id: Type.String(), text: Type.String() }));

export const FEATURE_TOOL = {
  name: "submit_capture_feature",
  label: "Submit the feature",
  description: "The feature's functional specs in build order, each with its scenarios when it needs them; the new concepts they use; what you assumed, are unsure of and dropped.",
  parameters: Type.Object({
    functional_specs: Type.Array(
      Type.Object({
        func_id: Type.String({ description: "Short kebab-case, unique in the feature." }),
        text: Type.String({ description: "What the software does, as ***plain: its first line the behaviour, then its detail." }),
        conformance: Type.Optional(ScenarioSchema),
        acceptance: Type.Optional(ScenarioSchema),
      }),
    ),
    definitions: Definitions,
    assumptions: Strings("What you decided where the code left it open."),
    uncertain: Strings("What you captured without being sure of it."),
    dropped: Strings("Behaviour judged incidental and left out."),
  }),
};

export const INTERFACE_TOOL = {
  name: "submit_capture_interface",
  label: "Submit the interface",
  description: "The interface no feature captured, as a feature of its own: its title, its functional specs with their scenarios, the new concepts they use; what you assumed and are unsure of; and each surface dropped as not the software's interface, by name, with why.",
  parameters: Type.Object({
    title: Type.String({ description: "A few words for what they are, as a feature of the module: Proxies and network options." }),
    ...FEATURE_TOOL.parameters.properties,
    dropped: Strings("Each surface that is not the software's interface - a development script's option, a variable only its tests read - by its name, with why."),
  }),
};

export const COMPACT_TOOL = {
  name: "submit_capture_compact",
  label: "Submit the compact capture",
  description: "The whole small part as one feature, or why it needs separate writers. Give exactly one.",
  parameters: Type.Object({ feature: Type.Optional(FEATURE_TOOL.parameters), expand: Type.Optional(Type.String()) }),
};

export const CORRECTIONS_TOOL = {
  name: "submit_capture_corrections",
  label: "Submit the corrections",
  description: "Each interface fact the ***plain gets wrong or leaves out, corrected: the functional spec's func-id, a scenario's id when it is the scenario, its whole new text, and why from the code. None when everything holds.",
  parameters: Type.Object({
    corrections: Type.Array(
      Type.Object({
        func_id: Type.String(),
        scenario_id: Type.Optional(Type.String({ description: "Only when the correction is to this scenario of the functional spec." })),
        text: Type.String({ description: "The whole new text of the functional spec, or of the scenario." }),
        why: Type.String({ description: "What was wrong or missing, citing the code: file and what it does." }),
      }),
    ),
  }),
};

export const MODULES_TOOL = {
  name: "submit_capture_modules",
  label: "Submit the modules",
  description:
    "The part's features gathered into modules by concern, in the order the modules are built - each with its name, what it is, its features and the modules before it that it needs; and the scenarios rewritten to need only the modules before their own.",
  parameters: Type.Object({
    modules: Type.Array(
      Type.Object({
        name: Type.String({ description: "Short kebab-case, the concern: output-formatting, sessions." }),
        about: Type.String({ description: "What it is, in a line." }),
        features: Strings("Its features, by key as listed, in the order its functional specs are written."),
        needs: Strings("The modules before it whose behaviour its functional specs build on and its scenarios run, by name - none for the first."),
      }),
      { description: "Every module, in the order they are built: every feature in one of them." },
    ),
    rewrites: Type.Array(
      Type.Object({
        feature: Type.String({ description: "The feature's key, as listed." }),
        func_id: Type.String(),
        scenario_id: Type.String(),
        text: Type.String({ description: "The scenario's whole new text." }),
        why: Type.String({ description: "The later module it needed, and how it now checks the same without it." }),
      }),
      { description: "Scenarios that would need a module after their own whatever the order, rewritten - none when none." },
    ),
  }),
};

export const TRIAL_TOOL = {
  name: "submit_capture_trial",
  label: "Submit the trial",
  description:
    "What the original did with each scenario you were given - held, corrected to what it does, removed as nothing outside can check it, or untried with why - the functional specs it contradicts, corrected, and what its conformance tests must set up.",
  parameters: Type.Object({
    scenarios: Type.Array(
      Type.Object({
        func_id: Type.String(),
        scenario_id: Type.String(),
        outcome: Type.Union([Type.Literal("held"), Type.Literal("corrected"), Type.Literal("removed"), Type.Literal("untried")]),
        ran: Type.String({ description: "What you ran against the original - the command or the request - and what it answered, in a line." }),
        text: Type.Optional(Type.String({ description: "A corrected scenario's whole new text - with the setup only it needs, which is never a test req." })),
        why: Type.Optional(Type.String({ description: "Why it was corrected, removed or not tried." })),
      }),
      { description: "Every scenario you were given, each once." },
    ),
    functional_specs: Type.Array(
      Type.Object({ func_id: Type.String(), text: Type.String({ description: "Its whole new text." }), why: Type.String({ description: "What the original does, and what you ran that shows it." }) }),
      { description: "Functional specs whose text the original contradicts, corrected - none when none." },
    ),
    test_reqs: Strings("What every conformance test of the part must set up for the original to act as the scenarios say, one fact each with :ConformanceTests: as the subject - none when the test reqs say it all. What only some scenarios need goes in their own text, corrected; a test req names no scenario or functional spec."),
  }),
};

export const CONCEPTS_TOOL = {
  name: "submit_capture_concepts",
  label: "Submit the concepts",
  description: "One definition for each concept, serving every use of it.",
  parameters: Type.Object({ definitions: Definitions }),
};

export const EDITS_TOOL = {
  name: "submit_capture_edits",
  label: "Submit the edits",
  description: "The new text of each functional spec you rewrote, by its func-id - none when none needs it.",
  parameters: Type.Object({ edits: Type.Array(Type.Object({ func_id: Type.String(), text: Type.String() })) }),
};

export { records, text };
