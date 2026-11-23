import { existsSync } from "node:fs";
import { refuseTestPlainFile } from "./test-plain-files.ts";
import { basename, relative, resolve } from "node:path";
import { defineTool, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { CONFIG_FILE, readProjectConfig, moduleConfigFile, configModuleFor, moduleConfigsOf, withConfigModule } from "./config.ts";
import { checkPlainFile, formatCheckResults } from "./plain/check.ts";
import { describeDrift, describeModules, type ModuleStatus, type WorkLoop } from "./regenerate/loop.ts";
import { describeJob, pulseName, type Job, type JobRegistry } from "./regenerate/jobs.ts";
import { currentChat } from "./chat-scope.ts";
import { whyFailed } from "./regenerate/diagnose-job.ts";
import { didNotLand } from "./regenerate/failure-reports.ts";
import { runningLaunched, stopLaunched } from "./regenerate/launch.ts";
import type { LaunchTrack } from "./launch-track.ts";
import { projectDirOf } from "./regenerate/paths.ts";
import { findTestScripts } from "./regenerate/test-scripts.ts";
import { surfaceOf } from "./surface.ts";

/**
 * The tools that act on the work loop - `regenerate`, `drift` and `halt` - defined once, for the conversation and for the
 * skills alike: a skill that regenerates what a spec holds, or reads how far it is regenerated, uses the conversation's
 * own tools, on the conversation's loop, never copies of them.
 */

type AnyTool = ToolDefinition<any, any, any>;

export const WORKING_DIR_PARAM = Type.Optional(
  Type.String({
    description:
      "The folder the .plain files are in, relative to where turri was started - as if it had been started there " +
      "(e.g. \"plain\"). plain_file is then relative to it - hubspot.plain, not plain/hubspot.plain. Default: where " +
      "turri was started.",
  }),
);

export const MODEL_PARAM = Type.Optional(
  Type.String({
    description:
      "The model for the agents of this one call: a provider/model-id, or its name as the user said it. " +
      "Omitted: the coding model the module's config names, else the conversation's. " +
      "To change it for every later pulse, set coding-model with settings instead.",
  }),
);

/**
 * Why a module cannot be built with the config it would be built with: two of the modules it requires have a config
 * file of their own (`configModuleFor`); or, in a project where modules have their own files, it has none - nor any
 * module it requires - and config.turri.yaml alone names no unit testing script, so every pulse would stop for want of
 * one. The files there are and the script each names, and what to do. Undefined when it can be built - and while a unit
 * testing script is being written in the project, which may be its own: the work loop holds it until it has one.
 */
export function unbuildableConfig(plainFile: string): string | undefined {
  const root = projectDirOf(plainFile);
  let own: string | undefined;
  try {
    own = configModuleFor(plainFile);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  const files = moduleConfigsOf(root);
  if (files.length === 0 || own !== undefined || findTestScripts(root).unit !== undefined) return undefined;
  const scripts = files.map((each) => {
    const unit = withConfigModule(each, () => findTestScripts(root).unit);
    return `${moduleConfigFile(each)}${unit !== undefined ? ` (${relative(root, unit)})` : ""}`;
  });
  const name = basename(plainFile, ".plain");
  return (
    `${basename(plainFile)} would be built with ${CONFIG_FILE} alone - it has no ${moduleConfigFile(name)}, and none of the ` +
    `modules it requires has one - and that names no unit testing script, so every pulse would stop. The modules' own ` +
    `files: ${scripts.join(", ")}. Name its testing scripts in its own file - the settings tool, with module ${basename(plainFile)} - ` +
    `or ask the user which, when the ***plain does not make it plain.`
  );
}

/** `work`, once the module asked for can be built with the config it would be built with - refused before anything is planned otherwise (`unbuildableConfig`). */
export function whenBuildable<T>(plainFile: string, work: () => T): T {
  const unbuildable = unbuildableConfig(plainFile);
  if (unbuildable !== undefined) throw new Error(`Nothing was started: ${unbuildable}`);
  return work();
}

export const WAIT_PARAM = Type.Optional(
  Type.Boolean({
    description:
      "Block until the work finishes instead of returning a pulse id. Defaults to false in the " +
      "interactive TUI and true elsewhere, where a pulse would not outlive the turn.",
  }),
);

/**
 * A render tool's arguments as if turri had been started in `working_dir`: the .plain file
 * and the build folder made absolute from there, and that folder as `base`.
 */
export function fromWorkingDir<T extends { working_dir?: string; plain_file?: string; build_dir?: string }>(
  cwd: string,
  params: T,
): T & { base: string } {
  const base = params.working_dir !== undefined && params.working_dir.trim() !== "" ? resolve(cwd, params.working_dir) : cwd;
  let plainFile = params.plain_file !== undefined ? resolve(base, params.plain_file) : undefined;
  if (params.plain_file !== undefined && plainFile !== undefined && !existsSync(plainFile)) {
    // plain/hubspot.plain with working_dir plain: the folder named twice. Taken from where it is.
    const fromSession = resolve(cwd, params.plain_file);
    if (existsSync(fromSession)) plainFile = fromSession;
    else {
      throw new Error(
        `There is no .plain file at ${plainFile}` +
          (base !== cwd ? ` - plain_file is relative to working_dir (${relative(cwd, base) || "."}), so do not repeat the folder in it.` : "."),
      );
    }
  }
  return {
    ...params,
    base,
    ...(plainFile !== undefined ? { plain_file: plainFile } : {}),
    ...(params.build_dir !== undefined ? { build_dir: resolve(base, params.build_dir) } : {}),
  };
}

/**
 * A call that waits for its pulses - print, json and rpc modes, or `wait: true` - in the chat it was made in: every pulse
 * of that chat that was not there when it was made, and ends while it waits, is told in its reply.
 */
export interface Wait {
  chat: string | undefined;
  before: ReadonlySet<string>;
}

/** The calls waiting now, by registry. */
const waits = new WeakMap<JobRegistry, Set<Wait>>();

/** A call in this chat starts waiting, from the pulses there are now. */
export function startWait(jobs: JobRegistry): Wait {
  const wait: Wait = { chat: currentChat()?.id, before: new Set(jobs.list().map((job) => job.id)) };
  const set = waits.get(jobs) ?? new Set();
  set.add(wait);
  waits.set(jobs, set);
  return wait;
}

/** A call is done waiting: what ends now is told as any pulse's end is. */
export function endWait(jobs: JobRegistry, wait: Wait): void {
  waits.get(jobs)?.delete(wait);
}

/**
 * Whether a pulse that ended is told by a call still waiting in its chat - its agent is told it in that call's reply, so
 * a turn of its own to say it again would only repeat it.
 */
export function toldByWaitingCall(jobs: JobRegistry, job: Job): boolean {
  for (const wait of waits.get(jobs) ?? []) if (wait.chat === job.chat && !wait.before.has(job.id)) return true;
  return false;
}

/** A module's why while it waits for a testing script being written (loop.ts SCRIPT_BEING_WRITTEN). */
const SCRIPT_WAIT = /, which is being written$/;
/** How often a waiting call looks again while its module waits for a testing script. */
const SCRIPT_POLL_MS = 500;

/** How much of each pulse that ran while a call waited is told: the rest is pulses' with its id. */
const RAN_CHARS = 3_000;

/**
 * What the loop is doing for a spec's modules, for the conversation - and, waiting, the pulses that ran meanwhile and how
 * each ended, then how each module stands: `ran` is the registry and the call's wait (startWait).
 */
export async function loopReply(loop: WorkLoop, statuses: ModuleStatus[], wait: boolean, ran?: { jobs: JobRegistry; wait: Wait }) {
  try {
    if (wait) {
      await loop.drain();
      // A module held for a testing script being written - beside this call, by a skill run - starts once it is: a call
      // that waits waits for that too, rather than say it waits and end before its pulse runs.
      while (loop.status().some((status) => statuses.some((asked) => asked.plainFile === status.plainFile) && SCRIPT_WAIT.test(status.why ?? ""))) {
        await new Promise((resolve) => setTimeout(resolve, SCRIPT_POLL_MS));
        await loop.drain();
      }
    }
  } finally {
    if (ran !== undefined) endWait(ran.jobs, ran.wait);
  }
  const now = wait ? loop.status().filter((status) => statuses.some((asked) => asked.plainFile === status.plainFile)) : statuses;
  const jobIds = now.flatMap((status) => (status.running !== undefined ? [status.running.jobId] : []));
  const pulses = wait && ran !== undefined ? ran.jobs.list().filter((job) => job.chat === ran.wait.chat && !ran.wait.before.has(job.id)).sort((a, b) => a.sequence - b.sequence) : [];
  const cut = (text: string) => (text.length > RAN_CHARS ? `${text.slice(0, RAN_CHARS)}\n… cut short: pulses with its id tells the whole of it` : text);
  const text = [
    ...(pulses.length > 0
      ? [
          `What ran while you waited - ${pulses.length} pulse${pulses.length === 1 ? "" : "s"}:`,
          ...pulses.map((job) => `\n<pulse id="${job.id}" landed="${didNotLand(job) ? "no" : "yes"}">\n${cut(didNotLand(job) ? whyFailed(job) : describeJob(job))}\n</pulse>`),
          "",
          "How each module stands now:",
        ]
      : []),
    describeModules(now),
    "",
    wait
      ? "Tell the user how it went."
      : "It regenerates in the background. " +
        "Nothing to wait for: if what you are doing has a next step - a question to ask, a file to edit, functional specs to conform - take it now, " +
        "in this same turn, and tell the user what runs and what is planned alongside it, never as a reply that ends your turn - " +
        "and that the two of you can go on with the ***plain, or anything else, meanwhile: they need not wait for it. " +
        "Use pulses with a pulse's id if they ask how it is going.",
  ].join("\n");
  return { content: [{ type: "text" as const, text }], details: { jobIds } };
}

/** Halt a pulse by its id, or the start of it: what it was, and what moves up behind it. `reason`: why, kept with it. */
export function stopJob(jobs: JobRegistry, named: string, reason?: string, loop?: WorkLoop): string {
  // A planned row, or a module by its name: the module is halted - its rows are planned again from the spec each look.
  const module = /^planned-/.test(named.trim()) || !jobs.list().some((job) => job.id.startsWith(named.trim())) ? loop?.halt(named, reason) : undefined;
  if (module !== undefined) return module;
  const matches = jobs.list().filter((job) => job.id.startsWith(named.trim()));
  // /pulses is the terminal's: in a host, the pulses tool lists them.
  if (matches.length === 0) return `No pulse ${named}. ${surfaceOf(jobs) !== undefined ? "The pulses tool lists them." : "/pulses shows them."}`;
  if (matches.length > 1) return `'${named}' matches ${matches.map((job) => job.id).join(", ")}. Give more of the id.`;
  const target = matches[0]!;
  const behind = jobs.list().filter((job) => job.status === "queued" && job.waitingOn.includes(target.id));
  const stopped = jobs.stop(target.id);
  if (stopped === undefined) return `${pulseName(target)} is already ${target.status}.`;
  if (reason !== undefined && reason.trim() !== "") stopped.note = `Halted: ${reason.trim()}`;
  const queued = behind.length > 0 ? ` Queued behind it, now moving up: ${behind.map((job) => `${pulseName(job)} (${job.id})`).join(", ")}.` : "";
  // A spec diff's change is in the .plain files: stopping its render does not take it out of the spec.
  const inSpec =
    target.kind === "regenerate"
      ? " Its change is still in the .plain files: nothing more is regenerated in that codebase until the spec changes or it is asked " +
        "for again with regenerate - then it is regenerated with the rest. To drop the change, take it out of the spec and regenerate."
      : "";
  return stopped.status === "stopped"
    ? `Stopped ${pulseName(target)} (${target.id}) before it started.${queued}${inSpec}`
    : `Stopping ${pulseName(target)} (${target.id}): its agent is being stopped now.${queued}${inSpec}`;
}

export interface LoopToolsOptions {
  /** Where turri was started: the folder plain_file and working_dir are relative to. */
  cwd: string;
  /** The pulses the tools act on. */
  jobs?: JobRegistry;
  /** The work loop the tools act on - the conversation's, for a call in it. */
  loop?: (ctx: ExtensionContext) => WorkLoop;
  /** The model a pulse of this call regenerates on: the one named, or the module's coding model. Default: the one named. */
  model?: (ctx: ExtensionContext, plainFile: string, named?: string) => string | undefined;
  /** Whether a call waits for its work to finish, given what it asked. Default: only when it asked to. */
  wait?: (ctx: ExtensionContext, asked?: boolean) => boolean;
}

/** The module to act on: the .plain file named, or the one the project's config.turri.yaml names. */
function plainFileOf(cwd: string, given: { plain_file?: string; working_dir?: string }, what: string): string {
  const located = fromWorkingDir(cwd, given);
  const named = located.plain_file ?? readProjectConfig(located.base).module;
  if (named === undefined) throw new Error(`Name the .plain file to ${what}, or set module: in ${CONFIG_FILE}.`);
  const plainFile = resolve(located.base, named);
  refuseTestPlainFile(plainFile);
  return plainFile;
}

/** Whether a /regenerate's words ask for the module from scratch - its code deleted, and all of it regenerated again - or a /conform's, for its conformance tests written again. */
export function asksFromScratch(words: string): boolean {
  return FROM_SCRATCH.test(words);
}

/** Whether a /regenerate or /conform asking for its module from scratch asks for its whole requires chain with it. */
export function asksWholeChain(words: string): boolean {
  return /\bchain\b|\bevery module\b|\ball (the )?modules\b/i.test(words);
}

const FROM_SCRATCH =
  /\b(from (scratch|nothing|zero|the (start|beginning|ground up))|start(ing)? (it )?(over|afresh)|afresh|anew|clean slate|(delete|wipe|remove|drop|throw away)\b.{0,30}\b(module|code|codebase|everything|all of it))/i;

/** regenerate: regenerate a module's code up to its spec as it is now. */
export function regenerateTool(options: LoopToolsOptions & { loop: (ctx: ExtensionContext) => WorkLoop }): AnyTool {
  return defineTool({
    name: "regenerate",
    label: "Regenerate",
    description:
      "Regenerate a .plain module's code from its spec as the files have it now - and every module it requires, bottom of the " +
      "requires chain first. Call it after any change to the spec, by any means: the file tools, a skill, the user in an " +
      "editor. It takes no diff: what is left to regenerate - from what each module's code was regenerated from to its spec now - is " +
      "worked out and planned into pulses, and a pulse running that regenerates something the spec no longer wants is stopped and " +
      "rolled back. Nothing to do where the code is regenerated from the spec as it is. With funcIds named - each as module:func-id - those are " +
      "regenerated though their spec did not change - their code taken out and built anew, better made, never left as it was - " +
      "planned into pulses as any change is, the ones next to each other together; their conformance tests stay as they are.",
    promptSnippet: "regenerate a module's code from its spec as it is now - after any change to the spec",
    promptGuidelines: [
      "Call regenerate after editing a .plain file with the file tools - or when the user says they changed one - instead of working out a diff: turri compares what is regenerated with the spec now.",
      "regenerate returns at once with what runs and what is planned. Report it, keep talking, and use pulses when the user asks; the pulses report when they finish.",
      "When the user wants a functionality to come out differently, change its spec - the spec is what persists - then regenerate. When they want ones already built regenerated as their spec stands - better made, on another model, after many patches - name them in funcIds, each as module:func-id, all in one call.",
      "A change to a file the spec links - an API surface, a mapping document - is a change to the spec: regenerate sees it by itself, and regenerates every functional spec that uses what links it.",
      "Never stop pulses and start them again yourself to follow a spec change: regenerate does it.",
      "Set from_scratch only when the user asks for the module to be regenerated from scratch - started over, its code deleted - in this conversation, or agrees to it when a module's status says it has to start over: never to fix a pulse that did not land.",
      'from_scratch "module" takes out the code where the module is built; the modules below keep theirs, and the module starts from a copy of the code below it. "chain" takes out every codebase of its requires chain, the base\'s too, and builds all of it again from the bottom: use it after modules were split, merged or moved (refactor-module), or when the user asks for the whole chain.',
    ],
    parameters: Type.Object({
      plain_file: Type.Optional(Type.String({ description: "Path to the .plain file. Omitted: the module the project's config.turri.yaml names" })),
      working_dir: WORKING_DIR_PARAM,
      funcIds: Type.Optional(
        Type.Array(Type.String(), {
          description: "Functional specs already built, each as module:func-id (todo:add-task), to regenerate though their spec did not change. Omitted: what the spec now differs from the code in",
        }),
      ),
      from_scratch: Type.Optional(
        Type.Union([Type.Literal("module"), Type.Literal("chain")], {
          description:
            "Only when the user asks for it: the module's code and conformance tests deleted - committed first, so its lineage keeps them - and the whole module regenerated from its spec. " +
            '"chain": every module of its requires chain too, built again from the bottom',
        }),
      ),
      model: MODEL_PARAM,
      wait: WAIT_PARAM,
    }),
    async execute(_id, given, _signal, _onUpdate, ctx) {
      const plainFile = plainFileOf(options.cwd, given, "regenerate");
      return whenBuildable(plainFile, async () => {
        const check = checkPlainFile(plainFile);
        // The parser's message as it gives it, a test plain file out of place, and turri's next step for the old syntax.
        if (!check.ok) throw new Error(`${relative(options.cwd, plainFile) || plainFile} does not parse, so nothing can be regenerated from it yet:\n${formatCheckResults([check])}`);
        const again = given.funcIds ?? [];
        if (again.length > 0 && given.from_scratch !== undefined) throw new Error("Name funcIds or set from_scratch, not both: from scratch regenerates every one of them.");
        const model = options.model !== undefined ? options.model(ctx, plainFile, given.model) : given.model;
        const loop = options.loop(ctx);
        const request = { ...(model !== undefined ? { model } : {}) };
        const wait = options.wait !== undefined ? options.wait(ctx, given.wait) : given.wait === true;
        const waiting = wait && options.jobs !== undefined ? { jobs: options.jobs, wait: startWait(options.jobs) } : undefined;
        let statuses: ModuleStatus[];
        try {
          statuses =
            given.from_scratch !== undefined
              ? await loop.fromScratch(plainFile, { ...request, chain: given.from_scratch === "chain" })
              : again.length > 0
                ? await loop.regenerateAgain(plainFile, again, request)
                : await loop.bringUp(plainFile, request);
        } catch (error) {
          if (waiting !== undefined) endWait(waiting.jobs, waiting.wait);
          throw error;
        }
        return loopReply(loop, statuses, wait, waiting);
      });
    },
  });
}

/** drift: what is left to regenerate - planning nothing, starting nothing. */
export function driftTool(options: LoopToolsOptions & { loop: (ctx: ExtensionContext) => WorkLoop }): AnyTool {
  return defineTool({
    name: "drift",
    label: "Drift",
    description:
      "How far a module's code has drifted from its spec: in each codebase where it lives, what is left to regenerate - the " +
      "functional specs to add, change, regenerate again or take out, and reqs or definitions alone - and the conformance tests " +
      "left to write, those scheduled ahead of their code, what is regenerating now, and why nothing is regenerated where nothing is; " +
      "with nothing left, it says the module is fully regenerated. It plans nothing and starts nothing, and calls no model.",
    promptSnippet: "drift: what is left to regenerate in a module, code and conformance tests - starting nothing",
    promptGuidelines: [
      "Use drift when the user asks what is left to build, whether a module is up to date with its spec, or what changed since it was last regenerated. To see how it is planned into pulses, and the next pulse's prompt, use pulses with plain_file.",
    ],
    parameters: Type.Object({
      plain_file: Type.Optional(Type.String({ description: "Path to the .plain file. Omitted: the module the project's config.turri.yaml names" })),
      working_dir: WORKING_DIR_PARAM,
    }),
    async execute(_id, given, _signal, _onUpdate, ctx) {
      const reports = options.loop(ctx).drift(plainFileOf(options.cwd, given, "look at"));
      return { content: [{ type: "text" as const, text: describeDrift(reports) }], details: { modules: reports.length } };
    },
  });
}

const HALT_PARAMS = Type.Object({
  job_id: Type.Optional(Type.String({ description: "The pulse's id, or the start of it; a planned row's id (planned-<module>-...), or a module's name, halts the module" })),
  reason: Type.Optional(Type.String({ description: "Why it is halted, kept with it - what the spec now says that it did not, say" })),
  launched: Type.Optional(Type.String({ description: 'What a launch started, by name; a module\'s name for its launch under way and what it started; or "all"' })),
});

/** halt: stop a pulse, a module's planned pulses, a launch under way, or what a launch started. */
export function haltTool(options: { jobs: JobRegistry; workLoop?: () => WorkLoop | undefined; launches?: LaunchTrack }): AnyTool {
  const { jobs } = options;
  return defineTool({
    name: "halt",
    label: "Halt",
    description:
      "Halt a pulse, a module's planned pulses, or a launch. A pulse: a queued one never starts, a running one has its " +
      "agent stopped at once, and the pulses queued behind it move up - what a running pulse already changed is rolled back, and what " +
      "it was regenerating counts as not regenerated. A planned row (planned-<module>-...) or a module's name halts the module: its " +
      "running pulse stopped, none of its planned pulses started, and the modules built on it waiting - until it is asked for again " +
      "with regenerate; a spec change does not start it. A module whose .plain file is gone is dropped. launched: what a launch " +
      "started, by name; a module's name, its launch under way and what it started; or all.",
    promptSnippet: "halt a pulse, or a launch and what it started",
    promptGuidelines: [
      "Halt a pulse only when the user asks, or your instructions say to. Name which one, and say which pulses were queued behind it - they will now run.",
      "Halting a planned row halts its whole module - one planned pulse cannot be taken out alone, as the plan is made again from the spec. To drop work, change the spec.",
      "A planned row for a module that is no longer in the project is halted the same way, and dropped.",
    ],
    parameters: HALT_PARAMS,
    async execute(_id, params) {
      if (params.job_id === undefined && params.launched === undefined) throw new Error("Say what to halt: a job_id, or a launch (launched).");
      const lines: string[] = [];
      if (params.job_id !== undefined) lines.push(stopJob(jobs, params.job_id, params.reason, options.workLoop?.()));
      if (params.launched !== undefined) lines.push(await haltLaunched(params.launched, options.launches));
      return { content: [{ type: "text" as const, text: lines.join("\n") }], details: {} };
    },
  });
}

/** Halt what a launch started by its name, a module's launch under way and what it started, or every one: what was halted, said. */
export async function haltLaunched(which: string, launches: LaunchTrack | undefined): Promise<string> {
  const all = which === "all";
  const underWay = launches !== undefined && (all || launches.pending(which) !== undefined) ? await launches.stop(all ? undefined : which) : [];
  const module = !all && runningLaunched(which).length > 0 && !runningLaunched().some((item) => item.name === which);
  const before = runningLaunched();
  const stopped = await stopLaunched(all ? {} : module || underWay.length > 0 ? { moduleName: which } : { name: which });
  // The launches whose servers those were, with nothing of them left running: stopped too - a host hears it, and the next
  // launch of the codebase launches anew.
  const codebases = new Set(before.filter((item) => item.exited !== undefined).map((item) => item.moduleName));
  for (const codebase of codebases) launches?.halted(codebase);
  const halted = [...underWay.map((id) => `the launch ${id}`), ...stopped];
  return halted.length > 0 ? `Halted ${halted.join(", ")}.` : `Nothing a launch started is running${all ? "" : ` as ${which}`}, and no launch of it is under way.`;
}
