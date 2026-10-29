import { existsSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { defineTool, type ExtensionAPI, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { chatBusy } from "./chat-idle.ts";
import type { ChatLink } from "./chats.ts";
import { readProjectConfig } from "./config.ts";
import { modulePlainFile } from "./plain/parser.ts";
import type { AdvisorQuestion } from "./regenerate/advisor-records.ts";
import type { AdvisorVerdict, EvaluateRequest, TestAdvisor } from "./regenerate/advisor-runs.ts";
import type { WorkLoop } from "./regenerate/loop.ts";
import { projectDirOf, resolveTemplateDirs } from "./regenerate/paths.ts";
import { resolveRequiresChain } from "./regenerate/requires.ts";
import { refuseTestPlainFile } from "./test-plain-files.ts";

/**
 * The test advisor in the chat (docs/test-advisor.md). The advisor decides; the chat is the only writer of the ***plain.
 * A finished verdict reaches the chat the person looks at once it is idle - never interrupting it: a yes is a message
 * that starts a turn, in which the chat tells the person and writes the scenarios with change_plain, asking nothing; a
 * no is one line drawn by turri, starting no turn. What else the chat is told of the advisor - in its system prompt, in a
 * change's result - is here too, and its own way to it, evaluate_tests.
 */

/** Why, in a few words, by the first question of a yes. */
const WHY: Partial<Record<AdvisorQuestion, string>> = {
  "silent-failure": "a wrong implementation could look right",
  divergence: "it can be read two ways",
  cost: "a bug in it would be costly",
};

const specOf = (verdict: AdvisorVerdict) => `${verdict.module}:${verdict.funcId}`;

/** The line a no is drawn as: the functional spec, and the classifier's reading in a few words - a no has no evidence. */
export function noLine(verdict: AdvisorVerdict): string {
  const only = verdict.report.questions.map((answered) => answered.question);
  const reading = only.length > 0 && only.every((question) => question === "revisited") ? "its unit tests cover it as it is built on" : "nothing silent to get wrong";
  return `${specOf(verdict)} doesn't need testing scenarios - ${reading}.`;
}

/** The line the chat is to tell the person a yes in. */
export function yesLine(verdict: AdvisorVerdict): string {
  const why = verdict.report.questions.map((answered) => WHY[answered.question]).find((reason) => reason !== undefined);
  return `${specOf(verdict)} needs testing scenarios${why !== undefined ? ` - ${why}` : ""}. Writing them now.`;
}

/** A yes's report, as the chat's agent is given it: the questions that were a yes with their evidence, and the inputs. */
export function describeReport(verdict: AdvisorVerdict): string[] {
  return [
    "Why it needs testing:",
    ...verdict.report.questions.map((answered) => `- ${answered.question}: ${answered.evidence}`),
    "Inputs to cover:",
    ...(verdict.report.inputs.length === 0
      ? ["- none picked: cover its expected use, as the rules on test plain files say"]
      : verdict.report.inputs.map((input, index) =>
          "agreed" in input
            ? `${index + 1}. input: ${input.input} - agreed output: ${input.agreed}`
            : `${index + 1}. input: ${input.input} - split: ${input.readings.map((reading, at) => `(${at + 1}) ${reading}`).join("; ")}`,
        )),
  ];
}

/** The turn a batch of yeses starts: each one's report, and what the chat is to do with them - asking the person nothing. */
export function yesTask(verdicts: AdvisorVerdict[]): string {
  const where = (path: string, project: string) => relative(project, path) || path;
  return [
    `My test advisor judged that ${verdicts.length === 1 ? "this functional spec needs" : "these functional specs need"} explicit testing scenarios. You write them now.`,
    "",
    ...verdicts.flatMap((verdict) => [
      `<functional_spec name="${specOf(verdict)}" plain_file="${where(verdict.plainFile, verdict.project)}" tested_in="${where(verdict.tip, verdict.project)}" test_plain_file="${verdict.testFile}">`,
      ...describeReport(verdict),
      "</functional_spec>",
      "",
    ]),
    "What to do, in this turn, asking the person nothing:",
    `1. Tell the person in a line for each, e.g. "${yesLine(verdicts[0]!)}"`,
    "2. With change_plain, write whatever the step-7 guard would refuse, in this order, only what is missing: the ***test reqs*** of the module",
    "   it is tested in - the stack's conformance template, stdlib/<kind>/conformance/<stack>, imported, or the module's own - then the",
    "   conformance testing script for its stack, with implement-conformance-testing-script - cultivate, plainFile the module it is tested in,",
    "   which returns at once: go straight on - then the scenarios in its test plain file.",
    "3. Cover each input of the report that is this functional spec's: an agreed one with the readers' output, never a placeholder such as",
    "   <name> where a value belongs; a split one settled by the reading most consistent with the functional spec and its module - say which",
    "   reading you took. Leave out an input that exercises another functional spec, or nothing this one says.",
    "4. Ask the person nothing: the change is visible, and turri tests the scenarios once the code is built.",
  ].join("\n");
}

/** The line a no is drawn as, in the transcript and in no model's context. */
const ADVISOR_ENTRY = "turri_advisor";

/** How long a verdict waits before the chat is looked at again, while the person types or it cannot be told yet. */
export const ADVISOR_RECHECK_MS = 2000;

/**
 * A chat's verdicts: held until the chat is idle - its agent done, and nothing typed in its editor - then delivered
 * together: one turn for every yes, one line for each no. A verdict no longer about its functional spec as it is - its
 * text changed, or it was given scenarios meanwhile - is let go.
 */
export function verdictDelivery(pi: ExtensionAPI, link: ChatLink, context: () => ExtensionContext | undefined): { put(verdict: AdvisorVerdict): void } {
  const waiting: AdvisorVerdict[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;

  pi.registerEntryRenderer(ADVISOR_ENTRY, (entry, _options, theme) => {
    const data = entry.data as { text: string } | undefined;
    if (data === undefined) return undefined;
    const box = new Box(1, 0);
    box.addChild(new Text(theme.fg("muted", data.text), 0, 0));
    return box;
  });

  const busy = () => chatBusy(link, context);

  const later = (ms: number) => {
    if (timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      deliver();
    }, ms);
    timer.unref?.();
  };

  const deliver = () => {
    if (waiting.length === 0) return;
    if (busy()) {
      // Its agent ending says so (agent_settled); the person's typing does not, so it is looked at again.
      later(ADVISOR_RECHECK_MS);
      return;
    }
    const now = waiting.splice(0).filter((verdict) => {
      try {
        return verdict.current();
      } catch {
        return false;
      }
    });
    const yes = now.filter((verdict) => verdict.report.verdict === "yes");
    try {
      for (const verdict of now.filter((verdict) => verdict.report.verdict === "no")) pi.appendEntry(ADVISOR_ENTRY, { text: noLine(verdict) });
      if (yes.length > 0) {
        // A follow-up, never a steer: should a turn start in between, this waits for it to end.
        void pi.sendMessage(
          { customType: "turri_advisor_verdict", content: yesTask(yes), display: false, details: { specs: yes.map(specOf) } },
          { triggerTurn: true, deliverAs: "followUp" },
        );
      }
    } catch {
      // Not bound to its session yet: kept, and tried again.
      waiting.unshift(...now);
      later(ADVISOR_RECHECK_MS);
      return;
    }
    for (const verdict of now) verdict.delivered();
  };

  pi.on("agent_settled", () => deliver());
  pi.on("session_start", () => later(0));

  return {
    put(verdict) {
      // A newer verdict on the same functional spec replaces the one waiting.
      const at = waiting.findIndex((known) => known.project === verdict.project && specOf(known) === specOf(verdict));
      if (at !== -1) waiting.splice(at, 1);
      waiting.push(verdict);
      // The rest of what arrives at once comes with it.
      later(0);
    },
  };
}

/**
 * The test advisor and the chat, in its system prompt while the session has the advisor and the project wants it: the
 * two ways an evaluation starts, what to say while it runs, what to do with its verdict, and when to ask for one.
 */
export const TEST_ADVISOR_BLOCK = [
  "<test advisor>",
  "My test advisor decides whether a functional spec needs explicit testing scenarios - whether it could fail silently, be read two ways, or",
  "cost a lot when wrong - in the background. You are the only writer of the ***plain: it writes nothing, and you write what its yes calls for.",
  "An evaluation starts two ways:",
  "- By itself, for each new or changed functional spec that has no scenarios. A change's result names the ones it took up.",
  "- When you call evaluate_tests - even for a text it judged already. Call it when the person asks whether a functional spec needs tests,",
  "  and on your own, as another way of saying what one means: when pulses keep failing on a complicated functional spec, scenarios may pin",
  "  down what it should do - say why in its reason. A functional spec with scenarios is not evaluated.",
  "When a change's result or evaluate_tests says a functional spec is being evaluated, tell the person so in a line, and go on: nothing waits",
  "for it. Its verdict comes back to this chat once you are idle:",
  "- A yes is a message with its report: tell the person in a line, then write with change_plain what testing it needs - the test reqs, the",
  "  conformance testing script and its scenarios, in that order and only what is missing - as the message says, asking the person nothing.",
  "- A no is a line turri draws itself: there is nothing for you to do.",
  "When the person asks you for scenarios (\"write conformance scenarios for core:add-task\"), decide and write them yourself, with change_plain,",
  "as a ***plain change they see, as the rules say - whatever test-advisor says.",
  "</test advisor>",
].join("\n");

/** Each work loop's session's test advisor - the chat's and a host's loops have one. */
const advisorsOfLoops = new WeakMap<WorkLoop, () => TestAdvisor | undefined>();

/** The test advisor of the session a work loop is in. */
export function bindAdvisor(loop: WorkLoop, advisor: () => TestAdvisor | undefined): void {
  advisorsOfLoops.set(loop, advisor);
}

/**
 * What a change's tool result tells the chat's agent of the test advisor: the functional specs it has taken up, so the
 * agent tells the person they are being evaluated - nothing when it has taken up none.
 */
export function advisingNote(loop: WorkLoop, plainFile: string): string {
  const taking = advisorsOfLoops.get(loop)?.()?.taking(projectDirOf(resolve(plainFile))) ?? [];
  if (taking.length === 0) return "";
  return [
    `My test advisor is evaluating ${taking.join(", ")} in the background, to see whether ${taking.length === 1 ? "it needs" : "they need"} explicit testing scenarios.`,
    "Tell the person, in a line, that testing scenarios are being evaluated for them, and go on - there is nothing to wait for: the verdict",
    "comes back to this chat.",
  ].join("\n");
}

/** The functional specs evaluate_tests is given, each as the advisor is asked for it - or, not found, why. */
function namedSpecs(cwd: string, names: string[], plainFile: string | undefined): Array<{ name: string; asked?: EvaluateRequest; missing?: string }> {
  const named = plainFile ?? readProjectConfig(cwd).module;
  const base = named !== undefined ? resolve(cwd, named) : undefined;
  if (base !== undefined) refuseTestPlainFile(base);
  if (base !== undefined && !existsSync(base)) throw new Error(`There is no .plain file at ${base}.`);
  const chain = (() => {
    try {
      return base !== undefined ? resolveRequiresChain(base, [], undefined, { allowNoFunctionalities: true }) : [];
    } catch {
      return [];
    }
  })();
  return names.map((given) => {
    const name = given.trim();
    const at = name.lastIndexOf(":");
    if (at === -1 && base === undefined) return { name, missing: `name it as module:func-id - there is no plain_file, and no module: in the project's config` };
    const module = at === -1 ? basename(base!, ".plain") : name.slice(0, at);
    const funcId = at === -1 ? name : name.slice(at + 1);
    const own = chain.find((link) => link.moduleName === module)?.plainFile ?? modulePlainFile(module, resolveTemplateDirs(base ?? join(cwd, `${module}.plain`)));
    if (own === null || own === undefined || !existsSync(own)) return { name: `${module}:${funcId}`, missing: `there is no module ${module} here` };
    // A module below the one named: its scenarios are tested in the one named, at the top of the chain.
    const tip = base !== undefined && chain.some((link) => link.moduleName === module) && resolve(own) !== resolve(base) ? { tip: base } : {};
    return { name: `${module}:${funcId}`, asked: { module, funcId, plainFile: resolve(own), ...tip } };
  });
}

/** What an evaluation asked for came to, by functional spec - each named `module:func-id`, a missing one with why. */
export interface EvaluateOutcome {
  /** Being evaluated now: the verdict comes to the chat the person looks at. */
  started: string[];
  /** Being evaluated already. */
  already: string[];
  /** With scenarios already: not evaluated. */
  scenarios: string[];
  /** Not found, with why. */
  missing: string[];
}

/**
 * The test advisor asked to evaluate functional specs - `module:func-id`s, or func-ids of `plainFile`'s module (else the
 * one the project's config names) - even a text it judged already, and whatever `test-advisor` says: `evaluate_tests`'s
 * and a host's `evaluateTests`. It returns at once.
 */
export function evaluateTests(cwd: string, advisor: TestAdvisor | undefined, funcIds: string[], options: { plainFile?: string; reason?: string } = {}): EvaluateOutcome {
  if (advisor === undefined) throw new Error("This session has no test advisor: it runs in the chat and a host only.");
  if (funcIds.length === 0) throw new Error("Name the functional specs to evaluate, each as module:func-id.");
  const said: EvaluateOutcome = { started: [], already: [], scenarios: [], missing: [] };
  for (const spec of namedSpecs(cwd, funcIds, options.plainFile)) {
    if (spec.asked === undefined) {
      said.missing.push(`${spec.name}: ${spec.missing}`);
      continue;
    }
    const outcome = advisor.evaluate({ ...spec.asked, ...(options.reason !== undefined ? { reason: options.reason } : {}) });
    if (outcome === "missing") said.missing.push(`${spec.name}: its module has no such functional spec`);
    else said[outcome].push(spec.name);
  }
  return said;
}

/**
 * evaluate_tests: the chat's own way to the test advisor - a functional spec evaluated in the background, whatever
 * `test-advisor` says, and even when its text was judged already. It returns at once; the verdict comes back to the chat
 * as the advisor's verdicts do. In the chat and a host only: the session has an advisor.
 */
export function evaluateTestsTool(options: { cwd: string; advisor: () => TestAdvisor | undefined }): ToolDefinition {
  return defineTool({
    name: "evaluate_tests",
    label: "Evaluate tests",
    description:
      "Have turri's test advisor evaluate, in the background, whether functional specs need explicit testing scenarios - even one it judged " +
      "already, and whatever test-advisor says. It returns at once; the verdict comes back to this chat: a yes as a message to write the " +
      "scenarios on, a no as a line. A functional spec that has scenarios is not evaluated.",
    promptSnippet: "evaluate_tests: have the test advisor judge whether functional specs need testing scenarios, in the background",
    promptGuidelines: [
      "Call evaluate_tests when the person asks whether a functional spec needs tests (\"does add-task need tests?\"), rather than judging it yourself.",
      "Call it on your own too, as another way of saying what a functional spec means: when pulses keep failing on a complicated functional spec, scenarios may pin down what it should do - say so in reason.",
      "It returns at once: tell the person testing scenarios are being evaluated, and go on. On a yes, write the scenarios as the verdict's message says.",
    ],
    parameters: Type.Object({
      funcIds: Type.Array(Type.String(), { description: "The functional specs, each as module:func-id (core:add-task) - or a func-id alone, of plain_file's module" }),
      plain_file: Type.Optional(
        Type.String({ description: "The .plain file a func-id alone is of, and whose chain the scenarios are tested in. Omitted: the module the project's config.turri.yaml names" }),
      ),
      reason: Type.Optional(Type.String({ description: "Why you ask, for the advisor to weigh: \"the coding agent failed three times to implement it\"" })),
    }),
    async execute(_id, params) {
      const said = evaluateTests(options.cwd, options.advisor(), params.funcIds, { ...(params.plain_file !== undefined ? { plainFile: params.plain_file } : {}), ...(params.reason !== undefined ? { reason: params.reason } : {}) });
      const list = (names: string[]) => names.join(", ");
      const one = (names: string[], single: string, many: string) => (names.length === 1 ? single : many);
      const text = [
        ...(said.started.length > 0 ? [`Testing scenarios for ${list(said.started)} are being evaluated in the background; the verdict comes back to this chat.`] : []),
        ...(said.already.length > 0 ? [`${list(said.already)} ${one(said.already, "is", "are")} being evaluated already; the verdict comes back to this chat.`] : []),
        ...(said.scenarios.length > 0 ? [`${list(said.scenarios)} ${one(said.scenarios, "has", "have")} scenarios already, so ${one(said.scenarios, "it is", "they are")} not evaluated: tested as the scenarios say.`] : []),
        ...(said.missing.length > 0 ? [`Not evaluated - ${said.missing.join("; ")}.`] : []),
        ...(said.started.length + said.already.length > 0 ? ["Tell the person so in a line, and go on: there is nothing to wait for."] : []),
      ].join("\n");
      return { content: [{ type: "text" as const, text }], details: said };
    },
  }) as ToolDefinition;
}
