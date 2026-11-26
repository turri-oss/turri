import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { CONFIG_FILE, inheritModel, modelSpec, projectModels, readProjectConfig, roleModel, withConfigModule } from "../config.ts";
import { captureDefaults, type CaptureRole } from "./models.ts";
import { slashed } from "../regenerate/paths.ts";
import { findTestScripts, testingScriptSkill, type ScriptKind } from "../regenerate/test-scripts.ts";
import { checkPlainFile, type CheckResult } from "../plain/check.ts";
import { conformanceOf, stdlibCatalogue, stdlibTemplates } from "../stdlib.ts";
import { AREAS_TOOL, askAgent, watched, COMPACT_TOOL, CONCEPTS_TOOL, CONVENTIONS_TOOL, CORRECTIONS_TOOL, definitionsOf, EDITS_TOOL, FEATURE_TOOL, FEATURES_TOOL, INTERFACE_TOOL, leftOutOf, MODULES_TOOL, OWNERS_TOOL, records, REFERENCE_CHECKED_TOOL, REFERENCE_TOOL, strings, SURVEY_TOOL, text, TRIAL_TOOL, type AgentOptions } from "./agents.ts";
import { buildOrder, covers, entriesOf, filesOf, kebab, linesOf, renderArea, testEvidence, type TestEvidence } from "./area.ts";
import { entriesIn, entryFile, entrySurface, interfaceConcept, renderReference, interfaceDefinition, interfaceGaps, interfaceIn, leftOutPaths, namedExactly, namedIn, optionsNotInReference, referenceOf, shownSurface } from "./interface.ts";
import { assemble, featureKey, featurePaths, featuresOf, leavesOf, mergedInto, MODULE_SPECS, outlinedFeature, sharedName, writeCapture, type AssembledModule, type Assembly, type ConceptConflict } from "./assemble.ts";
import { conventionProblems, correctionProblems, divisionProblems, moduleProblems, referenceProblems, editProblems, featureProblems, gapProblems, outlineProblems, reconciledProblems, scenarioBudget, splitProblems, surveyProblems, trialProblems, unplaced, type CheckedModule, type GatheringGiven } from "./checks.ts";
import { buildMap, INTERFACE_KINDS, type CodeMap } from "./map.ts";
import { CaptureTracker, type CaptureStatus } from "./progress.ts";
import { capturePlan } from "./plan.ts";
import { pythonInterface } from "./python-interface.ts";
import { configInUse, configInUseProblem, startingConfig } from "./config.ts";
import { renderReport, summaryOf } from "./report.ts";
import { writeTestingScript, type ScriptWriter } from "./scripts.ts";
import { captureDir, newState, readState, reportFile, saveState, type InterfaceEntry, type InterfaceExclusion, type InterfaceKind, type Convention, type Correction, type InterfaceSurface, type AreaState, type CapturedFeature, type CapturedSpec, type CaptureState, type Definition, type FeatureOutline, type Part, type ScriptOutcome, type Survey, type TrialOutcome } from "./state.ts";
import { copyOriginal, trialBatches, trialTestReqs, type TrialScenario } from "./trial.ts";

/**
 * Capture: an existing codebase captured into ***plain, offline, into a folder of its own - `plain/` in the codebase by
 * default - after which the ***plain is worked on and the original abandoned (docs/capture.md).
 *
 * Cost follows features, not lines: no agent sees more than a fixed budget however large the codebase is. A map built
 * with no model; a survey of the whole of it, folded, that settles the conventions every feature follows; areas split
 * until each fits; each leaf outlined into features; the features divided, each behaviour one feature's; a writer for
 * each feature, side by side, its scenarios as many as the original's tests of it are dense; each part's features
 * gathered into modules by concern, in the order they are built; concepts defined twice reconciled; a readability pass over each module's
 * ***plain alone; its interface checked against the code; its scenarios tried on a copy of the original; then the files,
 * the parser's check and the report. Every answer is saved as it comes, so a capture stopped part-way goes on from where
 * it was.
 */

export interface CaptureOptions {
  /** The codebase to capture. */
  root: string;
  /** Where the ***plain goes: `<root>/plain` unless given. */
  plainDir?: string;
  /** The harness model from which capture chooses its provider and default tiers. */
  model?: string;
  /** Written into the new project's config, when given. */
  harnessModel?: string;
  codingModel?: string;
  /** How many agents work at once. */
  parallel?: number;
  signal?: AbortSignal;
  /** A line of progress: an area split, a feature captured. */
  progress?: (line: string) => void;
  /** Each change in where it is - its stage, its features, each agent at work and what it did last - for a live view. */
  watch?: (status: CaptureStatus) => void;
  /** An area of more lines than this is split; one of fewer is outlined. */
  leafLines?: number;
  /** How many characters of the map an agent is shown. */
  mapBudget?: number;
  /** The most functional specs areas are gathered into one module with. */
  moduleSpecs?: number;
  /** Writes a part's testing script: turri's skill for it unless given. */
  writeScript?: ScriptWriter;
  /**
   * The folder whose config is in use where the capture was started - the chat's, the command line's: the captured
   * project's config starts as it (`capture/config.ts`). None: it starts empty.
   */
  configFrom?: string;
}

export interface CaptureResult {
  plainDir: string;
  reportFile: string;
  summary: string;
  modules: string[];
  specs: number;
  /** Areas and features that could not be captured. */
  uncaptured: number;
  /** Modules the parser fails. */
  failing: number;
}

/** A capture that cannot start, or cannot go on: said as it is, nothing written but what was before. */
export class CaptureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaptureError";
  }
}

/** Lines above which an area is split rather than outlined: about what one agent can outline from a map and a look. */
export const LEAF_LINES = Number(process.env.TURRI_CAPTURE_LEAF_LINES ?? 6000);
/** Characters of the map an agent is shown: about six thousand tokens. */
export const MAP_BUDGET = 24_000;
/** How many agents work at once, unless told. */
export const DEFAULT_PARALLEL = 8;
/** How many concepts one reconciling agent is given, and how many functional specs one readability pass reads. */
const CONFLICTS_PER_AGENT = 20;
const SPECS_PER_PASS = 30;
/** The most surfaces of the interface one writer is given to capture: past this, another writer takes the rest. */
const SURFACES_PER_WRITER = 30;
/** The most surfaces of the interface a writer is shown, file by file. */
const INTERFACE_LISTED = 200;
/** The most lines of the files defining the interface one agent takes it from, and the most files. */
const REFERENCE_LINES = 4000;
const REFERENCE_FILES = 12;
/** Characters of a part's features the agent that gathers them into modules is shown: about thirty thousand tokens. */
const GATHERING_BUDGET = 120_000;
/** Tool calls an agent trying scenarios on the original makes before it is told to hand over: installing it, then a few a scenario. */
const TRIAL_CALLS = 100;
/** The least a turn of an agent trying scenarios may take: installing the original and running them takes a while. */
const TRIAL_TURN_MS = 30 * 60 * 1000;

/** The output folder's state as it stands: nothing there, a capture to go on with, or something capture must not touch. */
export function plainDirState(plainDir: string): { kind: "empty" } | { kind: "resume"; state: CaptureState } | { kind: "finished" } | { kind: "taken"; why: string } {
  if (!existsSync(plainDir)) return { kind: "empty" };
  if (!statSync(plainDir).isDirectory()) return { kind: "taken", why: `${plainDir} is a file` };
  const state = readState(plainDir);
  if (state?.finished !== undefined) return { kind: "finished" };
  if (state !== undefined) return { kind: "resume", state };
  const entries = readdirSync(plainDir).filter((entry) => entry !== ".turri" && entry !== ".DS_Store");
  return entries.length === 0 ? { kind: "empty" } : { kind: "taken", why: `${plainDir} holds ${entries.slice(0, 3).join(", ")}${entries.length > 3 ? ", ..." : ""} and no capture of turri's` };
}

/** Run a whole capture - or go on with one stopped part-way. */
export async function runCapture(options: CaptureOptions): Promise<CaptureResult> {
  const root = resolve(options.root);
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new CaptureError(`${root} is not a folder to capture.`);
  const plainDir = resolve(options.plainDir ?? join(root, "plain"));
  const found = plainDirState(plainDir);
  if (found.kind === "finished") {
    throw new CaptureError(`${plainDir} holds a finished capture already - its report is ${reportFile(plainDir)}. To capture again, move that folder out of the way.`);
  }
  if (found.kind === "taken") throw new CaptureError(`Nothing captured: ${found.why}. Capture writes into a folder of its own - name another.`);
  const source = options.configFrom !== undefined ? configInUse(options.configFrom) : undefined;
  const unusable = found.kind === "empty" ? configInUseProblem(source) : undefined;
  if (unusable !== undefined) throw new CaptureError(unusable);
  const tracker = new CaptureTracker(root, options.progress, options.watch);
  const map = buildMap(root, { exclude: [plainDir] });
  if (!map.files.some((file) => file.kind === "source")) throw new CaptureError(`${root} holds no source code to capture.`);
  const state = found.kind === "resume" ? found.state : newState(root);
  if (found.kind === "resume") tracker.said(`going on with the capture started ${state.started}`);
  state.plan ??= found.kind === "resume" ? { kind: "staged", reason: "continuing a capture started before compact captures" } : capturePlan(map);
  const save = () => {
    saveState(plainDir, state);
    tracker.counted(state);
  };
  save();
  tracker.said(`${state.plan.kind} capture: ${state.plan.reason}`);
  // The config in use, from the start - after the state, so a capture stopped here goes on: its agents run on its models,
  // and the project it writes keeps them.
  const given = { ...(options.harnessModel !== undefined ? { harnessModel: options.harnessModel } : {}), ...(options.codingModel !== undefined ? { codingModel: options.codingModel } : {}) };
  if (found.kind === "empty") writeFileSync(join(plainDir, CONFIG_FILE), startingConfig(source, given));
  const inUse = projectModels(readProjectConfig(plainDir));
  const model = options.model ?? modelSpec(inUse.harness);
  const codingModel = options.codingModel ?? modelSpec(inUse.coding);

  const run = new CaptureRun({ ...options, root, plainDir, ...(model !== undefined ? { model } : {}), ...(codingModel !== undefined ? { codingModel } : {}), given }, map, state, save, tracker);
  tracker.stage("surveying");
  await run.survey();
  await run.checkConventions();
  await run.extractInterface();
  if (state.plan.kind === "compact") await run.compact();
  if (state.plan.kind === "staged") {
    tracker.stage("outlining");
    await Promise.all(state.survey!.parts.map((part) => run.outlineArea(part.name)));
    await run.divide();
    tracker.stage("capturing");
    await Promise.all(state.survey!.parts.map((part) => run.captureFeatures(part.name)));
    await run.fillInterface();
    await run.gatherModules();
    await run.reconcile();
    await run.readability();
  }
  await run.verifyInterface();
  await run.trialScenarios();
  tracker.stage("writing");
  run.write();
  await run.scripts();
  return run.finish();
}

/** The testing scripts a captured project gets: conformance tests are on in it, so both. */
const SCRIPT_KINDS: ScriptKind[] = ["unit", "conformance"];

/** Runs no more than `limit` at once, the rest waiting their turn. */
function limiter(limit: number): <T>(work: () => Promise<T>) => Promise<T> {
  let running = 0;
  const waiting: Array<() => void> = [];
  return async (work) => {
    if (running >= limit) await new Promise<void>((go) => waiting.push(go));
    running += 1;
    try {
      return await work();
    } finally {
      running -= 1;
      waiting.shift()?.();
    }
  };
}

class CaptureRun {
  private readonly options: CaptureOptions & { root: string; plainDir: string; given: { harnessModel?: string; codingModel?: string } };
  private readonly map: CodeMap;
  private readonly state: CaptureState;
  private readonly save: () => void;
  private readonly tracker: CaptureTracker;
  private readonly progress: (line: string) => void;
  private readonly limited: <T>(work: () => Promise<T>) => Promise<T>;
  private readonly leafLines: number;
  private readonly budget: number;
  private readonly models: Record<CaptureRole, string | undefined>;

  constructor(options: CaptureOptions & { root: string; plainDir: string; given: { harnessModel?: string; codingModel?: string } }, map: CodeMap, state: CaptureState, save: () => void, tracker: CaptureTracker) {
    this.options = options;
    const defaults = captureDefaults(options.model, options.codingModel);
    const config = readProjectConfig(options.plainDir);
    const tier = (role: CaptureRole) => modelSpec(inheritModel(roleModel(config, role), defaults[role]));
    this.models = { capture: tier("capture"), "capture-analysis": tier("capture-analysis"), "capture-exploration": tier("capture-exploration") };
    tracker.said(`models: exploration ${this.models["capture-exploration"]}, analysis ${this.models["capture-analysis"]}, reasoning and writing ${this.models.capture}`);
    this.map = map;
    this.state = state;
    this.save = save;
    this.tracker = tracker;
    this.progress = (line) => tracker.said(line);
    this.limited = limiter(Math.max(1, options.parallel ?? DEFAULT_PARALLEL));
    this.leafLines = options.leafLines ?? LEAF_LINES;
    this.budget = options.mapBudget ?? MAP_BUDGET;
  }

  private stopIfAsked(): void {
    if (this.options.signal?.aborted === true) throw new CaptureError("The capture was stopped. Run it again to go on from where it was.");
  }

  private agent(label: string, prompt: string | string[], context: string, extra: Pick<AgentOptions, "reads" | "rules" | "calls">, role: AgentOptions["role"] = "capture"): AgentOptions {
    const model = this.models[role];
    return {
      plainDir: this.options.plainDir,
      root: this.options.root,
      role,
      ...(model !== undefined ? { model } : {}),
      ...(this.options.signal !== undefined ? { signal: this.options.signal } : {}),
      label: `capture ${label}`,
      watch: this.tracker.agent(label),
      prompt,
      context,
      ...extra,
    };
  }

  /** Analysis of evidence: plans, checks and trials, including corrections the evidence requires. */
  private analysis(label: string, prompt: string, context: string, extra: Pick<AgentOptions, "reads" | "calls">): AgentOptions {
    return this.agent(label, prompt, context, { ...extra, rules: false }, "capture-analysis");
  }

  private codebaseBlock(): string {
    return `<codebase>\n${this.options.root}\n</codebase>`;
  }

  async survey(): Promise<void> {
    if (this.state.survey !== undefined) return;
    this.stopIfAsked();
    this.progress("surveying the codebase");
    const context = [
      this.codebaseBlock(),
      `<map>\n${renderArea(this.map, ["."], this.budget)}\n</map>`,
      `<manifests>\n${this.manifests()}\n</manifests>`,
      `<docs>\n${this.docs()}\n</docs>`,
      `<standard library>\n${stdlibCatalogue()}\n</standard library>`,
    ].join("\n\n");
    const { answer, problems } = await this.limited(() =>
      askAgent(
        this.agent("survey", "survey", context, { reads: true, rules: true, calls: 45 }),
        { ...SURVEY_TOOL, convert: (params): Survey => ({ parts: records(params.parts).map(partOf), leftOut: leftOutOf(params.left_out), assumptions: strings(params.assumptions), separateConcerns: text(params.separate_concerns) || undefined }) },
        (survey) => surveyProblems(this.map, survey),
      ),
    );
    if (answer === undefined) throw new CaptureError(`The survey of the codebase did not hold, so nothing could be captured:\n- ${problems.join("\n- ")}`);
    this.state.survey = answer;
    for (const part of answer.parts) this.state.areas[part.name] ??= { id: part.name, name: part.name, about: part.about, paths: part.paths, part: part.name };
    this.save();
    this.progress(`surveyed: ${answer.parts.map((part) => `${part.name}${part.stdlibStack !== undefined ? ` (${part.stdlibStack})` : ""}`).join(", ")}`);
  }

  /**
   * Each part's conventions checked against the code before any writer is given them: every feature follows them, so
   * one that is wrong is wrong everywhere. An agent reads the code each names and corrects what does not hold; a check
   * that never holds leaves them as surveyed, and the report says so.
   */
  async checkConventions(): Promise<void> {
    const pending = this.state.survey!.parts.filter((part) => (part.conventions ?? []).length > 0 && this.state.conventionsChecked?.[part.name] === undefined);
    if (pending.length === 0) return;
    this.tracker.stage("checking", pending.length);
    await Promise.all(
      pending.map((part) =>
        this.limited(async () => {
          this.stopIfAsked();
          this.progress(`checking the ${part.conventions!.length} conventions of ${part.name} against the code`);
          const known = new Set(part.definitions.map((definition) => definition.concept));
          const context = [
            this.codebaseBlock(),
            `<part>\n${part.name} - ${part.about}\n</part>`,
            `<concepts>\n${part.definitions.map((definition) => `- ${definition.text}`).join("\n") || "None."}\n</concepts>`,
            `<conventions>\n${part.conventions!.map((convention, at) => `${at + 1}. ${convention.text}\n   decided in: ${convention.where.join(", ")}`).join("\n")}\n</conventions>`,
          ].join("\n\n");
          const { answer, problems } = await askAgent(
            this.analysis(`check ${part.name}`, "check-conventions", context, { reads: true, calls: 30 }),
            { ...CONVENTIONS_TOOL, convert: (params) => ({ conventions: conventionsOf(params.conventions), changes: strings(params.changes) }) },
            (answer) => [...(answer.conventions.length === 0 ? ["Give every convention as the code has it - those that hold too."] : []), ...conventionProblems(this.map, answer.conventions, known)],
          );
          if (answer !== undefined) part.conventions = answer.conventions;
          (this.state.conventionsChecked ??= {})[part.name] = answer !== undefined ? { changes: answer.changes } : { changes: [], failed: `the check did not hold: ${problems.join(" ")}` };
          this.save();
          this.tracker.worked();
          this.progress(
            answer === undefined
              ? `could not check the conventions of ${part.name} - kept as surveyed`
              : answer.changes.length === 0
                ? `every convention of ${part.name} holds`
                : `corrected the conventions of ${part.name}: ${answer.changes.length} change${answer.changes.length === 1 ? "" : "s"}`,
          );
        }),
      ),
    );
  }

  /**
   * Each part's interface taken from the code as data, before any feature is outlined: the files where the map found
   * it, so many lines an agent, each agent listing every command, argument, option, route and environment variable they
   * define - every name, what it takes, its choices, its default and its help, word for word - with where; every literal
   * checked against the code it cites, and every surface the map found listed or excluded with why (`referenceProblems`).
   * A part whose interface was taken gets its interface concept, which links the reference every writer then works from.
   */
  async extractInterface(): Promise<void> {
    const leftOut = this.state.survey!.leftOut.map((item) => item.path);
    const parts = this.state.survey!.parts.filter((part) => !(this.state.interfaceTaken ?? []).includes(part.name));
    const work: Array<{ part: Part; key: string; files: string[]; label: string }> = [];
    for (const part of parts) {
      const files = filesOf(this.map, part.paths).filter((file) => file.kind !== "test" && !leftOut.some((path) => covers(path, file.path)) && file.surfaces.some((surface) => INTERFACE_KINDS.has(surface.kind)));
      const batches: string[][] = [];
      let batch: string[] = [];
      let lines = 0;
      for (const file of files) {
        if (batch.length > 0 && (lines + file.lines > REFERENCE_LINES || batch.length >= REFERENCE_FILES)) {
          batches.push(batch);
          batch = [];
          lines = 0;
        }
        batch.push(file.path);
        lines += file.lines;
      }
      if (batch.length > 0) batches.push(batch);
      // The map found none: one agent looks for it, from the entry points.
      if (batches.length === 0) batches.push([]);
      batches.forEach((files, at) => {
        const key = files.join(", ") || "(the map found none)";
        if (this.state.interfaces?.[part.name]?.[key] === undefined) work.push({ part, key, files, label: `reference ${part.name}${batches.length > 1 ? ` ${at + 1}` : ""}` });
      });
    }
    if (work.length > 0) {
      this.tracker.stage("extracting", work.length);
      this.progress(`taking the interface from the code: ${work.length === 1 ? "an agent" : `${work.length} agents`}`);
      await Promise.all(
        work.map((item) =>
          this.limited(async () => {
            this.stopIfAsked();
            const listed = item.files.map((path) => {
              const file = this.map.files.find((candidate) => candidate.path === path)!;
              const names = [...new Set(file.surfaces.filter((surface) => INTERFACE_KINDS.has(surface.kind)).map((surface) => `\`${surface.name}\``))];
              return `- ${path} - ${file.lines} lines; the map found ${names.slice(0, 60).join(", ")}${names.length > 60 ? `, and ${names.length - 60} more` : ""}`;
            });
            const context = [
              this.codebaseBlock(),
              `<part>\n${item.part.name} - ${item.part.about}\n</part>`,
              `<files>\n${listed.length > 0 ? listed.join("\n") : "The map found no interface in the part's files: find it - from its entry points, where its arguments, routes and variables are read."}\n</files>`,
              `<map>\n${renderArea(this.map, item.part.paths, Math.floor(this.budget / 2))}\n</map>`,
            ].join("\n\n");
            const { answer, problems } = await askAgent(this.agent(item.label, "reference", context, { reads: true, rules: false, calls: 60 }, "capture-exploration"), { ...REFERENCE_TOOL, convert: referenceAnswerOf }, (answer) =>
              referenceProblems(this.map, this.options.root, item.files, answer),
            );
            ((this.state.interfaces ??= {})[item.part.name] ??= {})[item.key] = answer ?? { failed: `what its agent handed over did not hold: ${problems.join(" ")}` };
            this.save();
            this.tracker.worked();
            this.progress(answer !== undefined ? `took ${answer.entries.length} piece${answer.entries.length === 1 ? "" : "s"} of ${item.part.name}'s interface from ${item.files.length === 1 ? item.files[0] : `${item.files.length} files`}` : `could not take ${item.part.name}'s interface from ${item.key}`);
          }),
        ),
      );
    }
    await this.checkReference(parts);
    for (const part of parts) {
      const concept = interfaceConcept(part.name);
      const api = pythonInterface(this.map, part.paths);
      if (api) (this.state.pythonInterfaces ??= {})[part.name] = api;
      if ((api || referenceOf(this.state, part.name).entries.length > 0) && !part.definitions.some((definition) => definition.concept === concept)) part.definitions.push({ concept, text: interfaceDefinition(part.name) });
      (this.state.interfaceTaken ??= []).push(part.name);
    }
    this.save();
  }

  /**
   * Each part of the interface reference checked against the code by a fresh agent, as the conventions are: what the
   * checks of the code cannot see - a help text cut to its first line, choices left out or worked out when it runs, an
   * environment variable read through a constant - corrected or added, every entry again checked against the code it
   * cites. A check that never holds leaves the reference as it was taken, and the report says so.
   */
  private async checkReference(parts: Part[]): Promise<void> {
    const work = parts.flatMap((part) =>
      Object.entries(this.state.interfaces?.[part.name] ?? {}).flatMap(([key, batch], at, all) =>
        "entries" in batch && batch.checked === undefined ? [{ part, key, batch, label: `check reference ${part.name}${all.length > 1 ? ` ${at + 1}` : ""}` }] : [],
      ),
    );
    if (work.length === 0) return;
    this.tracker.stage("extracting", work.length);
    this.progress(`checking the interface reference against the code: ${work.length === 1 ? "an agent" : `${work.length} agents`}`);
    await Promise.all(
      work.map((item) =>
        this.limited(async () => {
          this.stopIfAsked();
          const files = item.key === "(the map found none)" ? [] : item.key.split(", ");
          const context = [
            this.codebaseBlock(),
            `<part>\n${item.part.name} - ${item.part.about}\n</part>`,
            `<the reference>\nAs it was taken from ${files.length > 0 ? files.join(", ") : "the part's code"}:\n\n${renderReference(item.part.name, item.batch.entries)}\n${item.batch.entries.map((entry) => `- \`${entry.name}\`${entry.command !== undefined ? ` of \`${entry.command}\`` : ""}: ${entry.where}${entry.also.length > 0 ? `, also ${entry.also.join(", ")}` : ""}`).join("\n")}\n${item.batch.excluded.length > 0 ? `\nLeft out: ${item.batch.excluded.map((excluded) => `\`${excluded.name}\` (${excluded.path}) - ${excluded.why}`).join("; ")}\n` : ""}</the reference>`,
            `<map>\n${renderArea(this.map, item.part.paths, Math.floor(this.budget / 2))}\n</map>`,
          ].join("\n\n");
          const { answer, problems } = await askAgent(
            this.analysis(item.label, "check-reference", context, { reads: true, calls: 60 }),
            { ...REFERENCE_CHECKED_TOOL, convert: (params) => ({ ...referenceAnswerOf(params), changes: strings(params.changes) }) },
            (answer) => [...(item.batch.entries.length > 0 && answer.entries.length === 0 ? ["Give every entry as the code has it - those that hold too."] : []), ...referenceProblems(this.map, this.options.root, files, answer)],
          );
          const batch = this.state.interfaces![item.part.name]![item.key]!;
          if ("entries" in batch) {
            if (answer !== undefined) {
              batch.entries = answer.entries;
              batch.excluded = answer.excluded;
              batch.checked = { changes: answer.changes };
            } else batch.checked = { failed: `the check did not hold: ${problems.join(" ")}` };
          }
          this.save();
          this.tracker.worked();
          this.progress(answer === undefined ? `could not check ${item.part.name}'s interface reference - kept as taken` : answer.changes.length === 0 ? `${item.part.name}'s interface reference holds` : `corrected ${item.part.name}'s interface reference: ${answer.changes.length} change${answer.changes.length === 1 ? "" : "s"}`);
        }),
      ),
    );
  }

  /**
   * The interface among some paths, for an agent: the reference's entries there - exact, taken from the code - and what
   * the map found there that the reference neither lists nor excludes; the map's alone where no reference was taken.
   */
  private interfaceFor(part: string, paths: string[]): { entries: InterfaceEntry[]; unlisted: InterfaceSurface[] } {
    const reference = referenceOf(this.state, part);
    const found = interfaceIn(this.map, paths, leftOutPaths(this.state));
    if (reference.entries.length === 0) return { entries: [], unlisted: found };
    const listed = reference.entries.map(entrySurface);
    return {
      entries: entriesIn(reference.entries, paths),
      unlisted: found.filter((surface) => !listed.some((entry) => namedIn(surface, entry.name)) && !reference.excluded.some((item) => namedExactly(surface, item.name))),
    };
  }

  /** What a feature's writer is told of the interface in its files: the reference's entries, exact, and what to do with them. */
  private writerInterfaceBlock(part: string, paths: string[]): string {
    const api = this.state.pythonInterfaces?.[part];
    const library = api ? `\n<public Python API>\nThese exact public imports and signatures are already in ${interfaceConcept(part)}'s linked reference. Use the concept where you describe their behaviour. Keep literal lists and signatures in the reference; write what a caller observes in the spec.\n${api.slice(0, this.budget)}\n</public Python API>` : "";
    const { entries, unlisted } = this.interfaceFor(part, paths);
    if (referenceOf(this.state, part).entries.length === 0) {
      return interfaceBlock("the interface in your files", "Every option, command, route, screen and environment variable the code defines in your feature's files - capture exactly each your feature owns:", unlisted) + library;
    }
    const concept = interfaceConcept(part);
    return referenceBlock(
      "the interface in your files",
      `Taken from the code, every literal checked against it: ${concept}'s reference, which every functional spec using ${concept} carries. Of these, capture what each your feature owns does - by its exact name, using ${concept}. What one takes, its choices, its default and its help are the reference's: say them only where a behaviour turns on them, and never otherwise than here.`,
      entries,
      unlisted,
    ) + library;
  }

  /** What a writer of the interface no feature captured is given: those pieces, with the reference's entry of each. */
  private gapBlock(part: string, gaps: InterfaceSurface[]): string {
    const { entries } = referenceOf(this.state, part);
    const exact = entries.filter((entry) => gaps.some((gap) => gap.name === entrySurface(entry).name && gap.path === entryFile(entry)));
    const rest = gaps.filter((gap) => !exact.some((entry) => gap.name === entrySurface(entry).name && gap.path === entryFile(entry)));
    return referenceBlock("the interface to capture", "Named in no functional spec of the part - capture each exactly, or drop it, by name, with why:", exact, rest);
  }

  /** The manifests near the root, each cut short: what the codebase is built on. */
  private manifests(): string {
    const files = this.map.files.filter((file) => file.kind === "manifest" && file.path.split("/").length <= 3).sort((a, b) => a.path.split("/").length - b.path.split("/").length);
    return this.excerpts(files.map((file) => file.path), 3000, 16_000) || "None found.";
  }

  /** The READMEs near the root, cut short. */
  private docs(): string {
    const files = this.map.files.filter((file) => /^readme/i.test(file.path.split("/").at(-1)!) && file.path.split("/").length <= 2);
    return this.excerpts(files.map((file) => file.path), 6000, 8000) || "None found.";
  }

  private excerpts(paths: string[], each: number, total: number): string {
    const parts: string[] = [];
    let used = 0;
    for (const path of paths) {
      if (used >= total) break;
      let body: string;
      try {
        body = readFileSync(join(this.map.root, ...path.split("/")), "utf8");
      } catch {
        continue;
      }
      const cut = body.length > each ? `${body.slice(0, each)}\n[... ${body.length - each} more characters]` : body;
      parts.push(`### ${path}\n${cut.trimEnd()}`);
      used += cut.length;
    }
    return parts.join("\n\n");
  }

  private part(name: string): Part {
    return this.state.survey!.parts.find((part) => part.name === name)!;
  }

  /** Write one small program in one turn. Nothing from a partial draft enters the state: the staged path can take over. */
  async compact(): Promise<void> {
    const parts = this.state.survey!.parts;
    const expand = (why: string) => {
      this.state.plan = { kind: "staged", reason: `expanded from compact: ${why}` };
      this.save();
      this.progress(`staged capture: ${this.state.plan.reason}`);
    };
    if (parts.length !== 1) return expand(`the survey found ${parts.length} parts`);
    if (this.state.survey?.separateConcerns) return expand(this.state.survey.separateConcerns);
    const part = parts[0]!;
    const key = featureKey(part.name, part.name);
    if (this.state.features[key]?.captured !== undefined) return;
    const { entries, unlisted } = this.interfaceFor(part.name, part.paths);
    const surfaces = [...entries.map(entrySurface), ...unlisted];
    const checkedPlan = capturePlan(this.map, surfaces.length);
    if (checkedPlan.kind === "staged") return expand(checkedPlan.reason);
    this.stopIfAsked();
    this.tracker.stage("compact-writing");
    const evidence = testEvidence(this.map, part.paths);
    const budget = scenarioBudget(evidence.reduce((sum, file) => sum + file.lines, 0));
    const area = this.state.areas[part.name]!;
    const context = [this.areaContext(area, this.budget), stackBlock(part), `<concepts>\n${part.definitions.map((d) => d.text).join("\n")}\n</concepts>`, this.writerInterfaceBlock(part.name, part.paths), testsBlock(evidence, budget)].join("\n\n");
    const { answer, problems } = await askAgent(
      this.agent(`compact ${part.name}`, "compact", context, { reads: true, rules: true, calls: 40 }),
      { ...COMPACT_TOOL, convert: (params) => ({ feature: params.feature ? capturedOf(params.feature as Record<string, unknown>) : undefined, expand: text(params.expand) }) },
      ({ feature, expand }) => {
        if (feature === undefined) return expand ? [] : ["Give the feature, or say why it needs separate writers in expand."];
        if (expand) return ["Give only one of feature and expand."];
        return [...featureProblems(feature, part.definitions, budget), ...gapProblems(feature, surfaces)];
      },
    );
    if (answer?.feature === undefined) return expand(answer?.expand || `the single writer's answer did not hold: ${problems.join(" ")}`);
    if (answer.feature.specs.length > (this.options.moduleSpecs ?? MODULE_SPECS)) return expand("the specs do not fit in one module");
    area.features = [{ name: part.name, title: part.name, about: part.about, paths: part.paths }];
    this.state.features[key] = { key, captured: answer.feature };
    this.save();
    this.progress(`captured ${part.name} in one pass: ${answer.feature.specs.length} functional specs`);
  }

  /** Outline an area: split it and outline its areas, or outline it into features - whichever is left to do. */
  async outlineArea(id: string): Promise<void> {
    const area = this.state.areas[id]!;
    if (area.failed !== undefined) return;
    if (area.children === undefined && area.features === undefined) {
      const files = filesOf(this.map, area.paths);
      const splittable = linesOf(files) > this.leafLines && entriesOf(this.map, area.paths).length >= 2;
      if (!splittable || !(await this.split(area))) await this.outline(area);
    }
    if (area.children !== undefined) await Promise.all(area.children.map((child) => this.outlineArea(child)));
  }

  /** Capture a part's features, side by side - all but those the division merged into others. */
  async captureFeatures(part: string): Promise<void> {
    await Promise.all(featuresOf(this.state, part).map(({ leaf, feature }) => this.feature(leaf, feature)));
  }

  /**
   * Each part's features divided, once all its areas are outlined: each behaviour given to one feature, a feature that
   * is a slice of another's behaviour merged into it. A part outlined as one area was outlined by one agent that saw all
   * of it, and a part whose features are being written already keeps them as they are. A division that never holds
   * leaves each feature owning what it was outlined for.
   */
  async divide(): Promise<void> {
    const pending = this.state.survey!.parts.filter(
      (part) => this.state.divided?.[part.name] === undefined && leavesOf(this.state, part.name).length > 1 && !featuresOf(this.state, part.name, { merged: true }).some(({ key }) => this.state.features[key] !== undefined),
    );
    if (pending.length === 0) return;
    this.tracker.stage("dividing", pending.length);
    await Promise.all(
      pending.map((part) =>
        this.limited(async () => {
          this.stopIfAsked();
          const features = featuresOf(this.state, part.name, { merged: true });
          const keys = features.map(({ key }) => key);
          this.progress(`dividing the ${features.length} features of ${part.name}`);
          const context = [`<part>\n${part.name} - ${part.about}\n</part>`, `<features of ${part.name}, in build order>\n${this.featureList(part.name, { paths: true })}\n</features of ${part.name}>`].join("\n\n");
          const convert = (params: Record<string, unknown>) => ({
            owns: records(params.features).map((item) => ({ feature: text(item.feature), owns: text(item.owns) })),
            merged: records(params.merged).map((item) => ({ feature: text(item.feature), into: strings(item.into), why: text(item.why) })),
          });
          const { answer, problems } = await askAgent(this.analysis(`divide ${part.name}`, "divide", context, { reads: false, calls: 3 }), { ...OWNERS_TOOL, convert }, (answer) => divisionProblems(keys, answer));
          (this.state.divided ??= {})[part.name] =
            answer !== undefined
              ? { owns: Object.fromEntries(answer.owns.map((item) => [item.feature, item.owns])), merged: Object.fromEntries(answer.merged.map((item) => [item.feature, { into: item.into, why: item.why }])) }
              : { owns: {}, merged: {}, failed: `the division did not hold: ${problems.join(" ")}` };
          this.save();
          this.tracker.worked();
          this.progress(answer !== undefined ? `divided the features of ${part.name}${answer.merged.length > 0 ? `: ${answer.merged.map((item) => `${item.feature} merged into ${item.into.join(", ")}`).join("; ")}` : ""}` : `could not divide the features of ${part.name} - each owns what it was outlined for`);
        }),
      ),
    );
  }

  /**
   * A part's features in build order, area by area - each with what it owns once divided, else what it was outlined
   * for - for the division and for each writer: `mine` marks a writer's own, and leaves out those merged; `paths` adds
   * where each is built. Folded to a budget: where each is built goes first, then what the features of other areas own,
   * then their titles - a writer's own area is always listed whole.
   */
  private featureList(part: string, options: { mine?: string; paths?: boolean }): string {
    const division = this.state.divided?.[part];
    const mineLeaf = options.mine?.split("#")[0];
    const levels = ["paths", "owns", "titles", "keys"] as const;
    const render = (fold: (typeof levels)[number]) =>
      leavesOf(this.state, part)
        .flatMap((leaf) => {
          const features = (leaf.features ?? []).map((feature) => ({ key: featureKey(leaf.id, feature.name), feature })).filter(({ key }) => options.mine === undefined || division?.merged[key] === undefined);
          if (features.length === 0) return [];
          const level = leaf.id === mineLeaf ? "owns" : fold;
          return [
            `## ${leaf.id} - ${leaf.about}`,
            ...features.flatMap(({ key, feature }) => {
              const mark = options.mine === undefined ? "- " : key === options.mine ? "-> " : "   ";
              if (level === "keys") return [`${mark}${key}`];
              if (level === "titles") return [`${mark}${key} - ${feature.title}`];
              const line = `${mark}${key} - ${feature.title}: ${division?.owns[key] ?? feature.about}`;
              return options.paths === true && level === "paths" ? [line, `  built in: ${feature.paths.join(", ")}`] : [line];
            }),
          ];
        })
        .join("\n");
    const budget = options.mine === undefined ? this.budget * 2 : this.budget;
    let listed = "";
    for (const fold of levels) {
      listed = render(fold);
      if (listed.length <= budget) break;
    }
    return listed;
  }

  private areaContext(area: AreaState, budget: number): string {
    const part = this.part(area.part);
    return [
      this.codebaseBlock(),
      `<part>\n${part.name} - ${part.about}\n</part>`,
      `<area>\n${area.id} - ${area.about}\n</area>`,
      `<map>\n${renderArea(this.map, area.paths, budget)}\n</map>`,
    ].join("\n\n");
  }

  /** Split an area into areas in build order. False when the split never held - it is outlined instead. */
  private async split(area: AreaState): Promise<boolean> {
    this.stopIfAsked();
    const convert = (params: Record<string, unknown>) => ({
      areas: records(params.areas).map((item) => ({ name: kebab(text(item.name)) || text(item.name), about: text(item.about), paths: strings(item.paths).map(trimSlash) })),
      leftOut: leftOutOf(params.left_out),
    });
    const { answer, problems } = await this.limited(() =>
      askAgent(this.analysis(`split ${area.id}`, "split", this.areaContext(area, this.budget), { reads: true, calls: 15 }), { ...AREAS_TOOL, convert }, (answer) => splitProblems(this.map, area.paths, answer)),
    );
    if (answer === undefined) {
      this.progress(`could not split ${area.id} - outlining it whole: ${problems[0] ?? ""}`);
      return false;
    }
    const ordered = buildOrder(this.map, answer.areas);
    area.children = ordered.map((child) => {
      const id = `${area.id}/${child.name}`;
      this.state.areas[id] = { id, name: child.name, about: child.about, paths: child.paths, part: area.part };
      return id;
    });
    area.leftOut = [...answer.leftOut, ...unplaced(this.map, area.paths, answer.areas, answer.leftOut).map((path) => ({ path, why: "placed in no area by the split" }))];
    this.save();
    this.progress(`split ${area.id} into ${ordered.map((child) => child.name).join(", ")}`);
    return true;
  }

  private async outline(area: AreaState): Promise<void> {
    this.stopIfAsked();
    const convert = (params: Record<string, unknown>) => ({
      features: records(params.features).map(
        (item): FeatureOutline => ({ name: kebab(text(item.name)) || text(item.name), title: text(item.title), about: text(item.about), paths: strings(item.paths).map(trimSlash) }),
      ),
      leftOut: leftOutOf(params.left_out),
    });
    const { answer, problems } = await this.limited(() =>
      askAgent(this.analysis(`outline ${area.id}`, "outline", `${stackBlock(this.part(area.part))}\n\n${this.areaContext(area, this.budget)}`, { reads: true, calls: 25 }), { ...FEATURES_TOOL, convert }, (answer) =>
        outlineProblems(this.map, area.paths, answer),
      ),
    );
    if (answer === undefined) {
      area.failed = `its outline did not hold: ${problems.join(" ")}`;
      this.save();
      this.progress(`could not outline ${area.id}`);
      return;
    }
    area.features = answer.features;
    area.leftOut = answer.leftOut;
    this.save();
    this.progress(`outlined ${area.id}: ${answer.features.length} feature${answer.features.length === 1 ? "" : "s"}`);
  }

  private async feature(area: AreaState, feature: FeatureOutline): Promise<void> {
    const key = featureKey(area.id, feature.name);
    const known = this.state.features[key];
    if (known?.captured !== undefined || known?.failed !== undefined) return;
    this.stopIfAsked();
    const part = this.part(area.part);
    const division = this.state.divided?.[part.name];
    // What the division merged into it is its own to capture: the merged features' files are where it is built too.
    const taken = mergedInto(this.state, key);
    const paths = featurePaths(this.state, key);
    const evidence = testEvidence(this.map, paths);
    const budget = scenarioBudget(evidence.reduce((sum, file) => sum + file.lines, 0));
    // A feature the harness added for the interface no feature captured: its writer captures each surface, or says why not.
    const gaps = feature.interface;
    const context = [
      this.codebaseBlock(),
      `<part>\n${part.name} - ${part.about}\n</part>`,
      stackBlock(part),
      `<concepts>\n${part.definitions.map((definition) => `- ${definition.text}`).join("\n") || "None given."}\n</concepts>`,
      `<features of ${part.name}>\nEvery feature of the part, in build order, with what it owns - yours marked:\n${this.featureList(part.name, { mine: key })}\n</features of ${part.name}>`,
      [
        "<feature>",
        `${key} - ${feature.title}: ${feature.about}`,
        ...(division?.owns[key] !== undefined ? [`What it owns: ${division.owns[key]}`] : []),
        ...taken.map((from) => `Merged into it: ${from.key} - ${outlinedFeature(this.state, from.key)?.about ?? ""} (${from.why})`),
        `Where it is built: ${paths.join(", ")}`,
        "</feature>",
      ].join("\n"),
      gaps !== undefined ? this.gapBlock(part.name, gaps) : this.writerInterfaceBlock(part.name, paths),
      testsBlock(evidence, budget),
      `<map>\n${renderArea(this.map, paths, Math.floor(this.budget / 2))}\n</map>`,
    ].join("\n\n");
    const { answer, problems }: { answer?: CapturedFeature & { title?: string }; problems: string[] } = await this.limited(() => {
      this.stopIfAsked();
      if (gaps === undefined) return askAgent(this.agent(`feature ${key}`, "feature", context, { reads: true, rules: true, calls: 40 }), { ...FEATURE_TOOL, convert: capturedOf }, (captured) => featureProblems(captured, part.definitions, budget));
      return askAgent(
        this.agent(`interface ${key}`, ["feature", "interface"], context, { reads: true, rules: true, calls: 40 }),
        { ...INTERFACE_TOOL, convert: (params) => ({ ...capturedOf(params), title: text(params.title) }) },
        // A writer may find none of them is the software's interface: then it drops them all, and writes nothing.
        (captured) => [...(captured.title === "" ? ["Give the feature a title."] : []), ...featureProblems(captured, part.definitions, budget, { mayBeEmpty: true }), ...gapProblems(captured, gaps)],
      );
    });
    if (answer?.title !== undefined) feature.title = answer.title;
    this.state.features[key] = answer !== undefined ? { key, captured: withoutTitle(answer) } : { key, failed: `what its writer handed over did not hold: ${problems.join(" ")}` };
    this.save();
    this.progress(answer !== undefined ? `captured ${key}: ${answer.specs.length} functional spec${answer.specs.length === 1 ? "" : "s"}` : `could not capture ${key}`);
  }

  /**
   * The interface no feature captured, once every feature is written: each option, command, route, screen and
   * environment variable of the code the part's ***plain names nowhere goes to a writer of its own - a feature added to
   * the area whose files define it, so many surfaces a writer - which captures each exactly, or drops it, by name, with
   * why. Once a part: a capture stopped part-way asks again only the writers that never answered.
   */
  async fillInterface(): Promise<void> {
    const pending = this.state.survey!.parts.filter((part) => !(this.state.interfaceFilled ?? []).includes(part.name));
    if (pending.length === 0) return;
    const gaps = interfaceGaps(this.map, this.state, assemble(this.state, this.options.moduleSpecs));
    const asked: Array<{ leaf: AreaState; feature: FeatureOutline }> = [];
    for (const part of pending) {
      const leaves = leavesOf(this.state, part.name);
      const before = leaves.flatMap((leaf) => (leaf.features ?? []).filter((feature) => feature.interface !== undefined).map((feature) => ({ leaf, feature })));
      if (before.length > 0) {
        asked.push(...before.filter(({ leaf, feature }) => this.state.features[featureKey(leaf.id, feature.name)] === undefined));
        continue;
      }
      const byLeaf = new Map<AreaState, InterfaceSurface[]>();
      for (const gap of gaps.filter((candidate) => candidate.part === part.name)) {
        const leaf = leaves.find((candidate) => candidate.paths.some((path) => covers(path, gap.path))) ?? leaves.at(-1);
        if (leaf !== undefined) byLeaf.set(leaf, [...(byLeaf.get(leaf) ?? []), { path: gap.path, kind: gap.kind, name: gap.name }]);
      }
      for (const [leaf, surfaces] of byLeaf) {
        for (let at = 0; at < surfaces.length; at += SURFACES_PER_WRITER) {
          const batch = surfaces.slice(at, at + SURFACES_PER_WRITER);
          const taken = new Set((leaf.features ?? []).map((feature) => feature.name));
          let name = "interface";
          for (let n = 2; taken.has(name); n += 1) name = `interface-${n}`;
          const feature: FeatureOutline = { name, title: "The rest of its interface", about: "the interface of its code no other feature captured", paths: [...new Set(batch.map((surface) => surface.path))], interface: batch };
          (leaf.features ??= []).push(feature);
          asked.push({ leaf, feature });
        }
      }
    }
    this.save();
    if (asked.length > 0) {
      const surfaces = asked.reduce((sum, { feature }) => sum + (feature.interface?.length ?? 0), 0);
      this.tracker.stage("filling", asked.length);
      this.progress(`capturing the interface no feature named: ${surfaces} option${surfaces === 1 ? "" : "s"}, command${surfaces === 1 ? "" : "s"}, route${surfaces === 1 ? "" : "s"} or variable${surfaces === 1 ? "" : "s"}`);
      await Promise.all(asked.map(({ leaf, feature }) => this.feature(leaf, feature).then(() => this.tracker.worked())));
    }
    this.state.interfaceFilled = [...(this.state.interfaceFilled ?? []), ...pending.map((part) => part.name)];
    this.save();
  }

  /**
   * Each module's interface checked against the code, once its ***plain reads well: every option, command, route,
   * field, message and exit code its functional specs and scenarios state, by an agent that reads the code deciding it
   * and corrects what is wrong or left out - over the readability pass, which never sees the code. A correction that
   * never holds is not made: what the ***plain said stays.
   */
  async verifyInterface(): Promise<void> {
    const { modules, shared } = assemble(this.state, this.options.moduleSpecs);
    const pending = modules.filter((module) => !(this.state.verified ?? []).includes(module.name));
    if (pending.length === 0) return;
    this.tracker.stage("verifying", pending.length);
    this.progress(`checking the interface of ${pending.length} module${pending.length === 1 ? "" : "s"} against the code`);
    await Promise.all(
      pending.map((module) =>
        this.limited(async () => {
          this.stopIfAsked();
          const sharedModule = shared.find((candidate) => candidate.name === module.shared)!;
          const known = new Set([...sharedModule.definitions, ...module.definitions].map((definition) => definition.concept));
          const paths = [...new Set(module.features.flatMap((feature) => featurePaths(this.state, feature.key)))];
          const own = this.interfaceFor(module.part, paths);
          const reference = referenceOf(this.state, module.part);
          const specs = module.features.flatMap((feature) => feature.specs);
          // An option the ***plain names that the code does not define: found mechanically, for the check to settle.
          const invented = reference.entries.length > 0 ? optionsNotInReference(specs.flatMap((spec) => [spec.text, ...spec.conformance.map((scenario) => scenario.text), ...spec.acceptance.map((scenario) => scenario.text)]).join("\n"), reference.entries) : [];
          const corrections: Correction[] = [];
          for (let at = 0; at < specs.length; at += SPECS_PER_PASS) {
            const chunk = specs.slice(at, at + SPECS_PER_PASS);
            const byId = new Map(chunk.map((spec) => [spec.funcId, spec]));
            const context = [
              this.codebaseBlock(),
              readabilityContext(module, sharedModule.definitions, chunk, stackBlock(this.part(module.part))),
              referenceBlock(
                "the interface in its code",
                reference.entries.length > 0
                  ? `Taken from the code, every literal checked against it - ${interfaceConcept(module.part)}'s reference, which the ***plain carries. The ***plain must agree with it, and with the code:`
                  : "Every option, command, route, screen and environment variable the code of this module's features defines:",
                own.entries,
                own.unlisted,
              ),
              ...(invented.length > 0 ? [`<options the ***plain names that the reference does not have>\n${invented.map((option) => `\`${option}\``).join(", ")} - an option the code does not define is wrong, unless the code shows otherwise.\n</options the ***plain names that the reference does not have>`] : []),
              `<map>\n${renderArea(this.map, paths, Math.floor(this.budget / 2))}\n</map>`,
            ].join("\n\n");
            const { answer } = await askAgent(
              this.agent(`verify ${module.name}`, "verify", context, { reads: true, rules: true, calls: 40 }, "capture-analysis"),
              {
                ...CORRECTIONS_TOOL,
                convert: (params) =>
                  records(params.corrections).map((item): Correction => ({ funcId: text(item.func_id), ...(text(item.scenario_id) !== "" ? { scenarioId: text(item.scenario_id) } : {}), text: text(item.text), why: text(item.why) })),
              },
              (answer) => correctionProblems(answer, byId, known),
            );
            for (const correction of answer ?? []) {
              const spec = byId.get(correction.funcId)!;
              const was = correction.scenarioId === undefined ? spec.text : [...spec.conformance, ...spec.acceptance].find((scenario) => scenario.id === correction.scenarioId)?.text;
              if (correction.text !== was) corrections.push(correction);
            }
          }
          (this.state.corrections ??= {})[module.name] = corrections;
          (this.state.verified ??= []).push(module.name);
          this.save();
          this.tracker.worked();
          this.progress(corrections.length === 0 ? `the interface of ${module.name} holds` : `corrected the interface of ${module.name}: ${corrections.length} correction${corrections.length === 1 ? "" : "s"}`);
        }),
      ),
    );
  }

  /**
   * Each part's features gathered into modules by concern and put in the order they are built, once every feature is
   * written. A module is a concern of its own - what a person looks for in one file - never one that holds everything:
   * the code's areas, gathered by size alone, can put a small codebase's every concern in one. And a module is built on
   * the code of the modules before it, its scenarios run as soon as it is: a module whose scenarios send a request comes
   * after the one that sends it. The areas are in the order of their code's imports, which is not that order - the code
   * that runs everything imports everything, yet everything needs it built first. An agent reads every feature's
   * functional specs and scenarios, and the modules as the areas make them, and gathers and orders them, naming what each
   * needs of those before it; a scenario that needs a module after its own whatever the order is rewritten. Once only,
   * before anything is done module by module: what never holds leaves the modules as the code's areas make them.
   */
  async gatherModules(): Promise<void> {
    if (this.state.edited.length > 0 || (this.state.verified ?? []).length > 0 || this.state.written === true) return;
    const { modules } = assemble(this.state, this.options.moduleSpecs);
    const pending = this.state.survey!.parts.filter((part) => this.state.gathered?.[part.name] === undefined && this.gatheredFeatures(part.name).length > 1);
    if (pending.length === 0) return;
    this.tracker.stage("gathering", pending.length);
    await Promise.all(
      pending.map((part) =>
        this.limited(async () => {
          this.stopIfAsked();
          const features = this.gatheredFeatures(part.name);
          const byArea = modules.filter((module) => module.part === part.name);
          this.progress(`gathering the ${features.length} features of ${part.name} into modules`);
          const given: GatheringGiven = {
            features: new Map(features.map(({ key, specs }) => [key, specs])),
            known: this.knownConcepts(part.name),
            reserved: new Set(this.state.survey!.parts.map((candidate) => sharedName(candidate.name))),
            moduleSpecs: this.options.moduleSpecs ?? MODULE_SPECS,
          };
          const context = [
            `<part>\n${part.name} - ${part.about}\n</part>`,
            `<features of ${part.name}, area by area, in the order of their code>\n${gatheringList(features, GATHERING_BUDGET)}\n</features of ${part.name}>`,
            `<modules as the code's areas make them>\n${byArea.map((module) => `- ${module.name} - ${module.about}: ${module.features.map((feature) => feature.key).join(", ")}`).join("\n")}\n</modules as the code's areas make them>`,
          ].join("\n\n");
          const convert = (params: Record<string, unknown>) => ({
            modules: records(params.modules).map((item) => ({ name: kebab(text(item.name)) || text(item.name), about: text(item.about), features: strings(item.features), needs: strings(item.needs) })),
            rewrites: records(params.rewrites).map((item) => ({ feature: text(item.feature), funcId: text(item.func_id), scenarioId: text(item.scenario_id), text: text(item.text), why: text(item.why) })),
          });
          const { answer, problems } = await askAgent(this.agent(`modules ${part.name}`, "modules", context, { reads: false, rules: true, calls: 3 }), { ...MODULES_TOOL, convert }, (answer) => moduleProblems(answer, given));
          (this.state.gathered ??= {})[part.name] = answer !== undefined ? answer : { modules: [], rewrites: [], failed: `the gathering did not hold: ${problems.join(" ")}` };
          this.save();
          this.tracker.worked();
          this.progress(
            answer === undefined
              ? `could not gather the features of ${part.name} into modules - they are as the code's areas make them`
              : `gathered the features of ${part.name} into ${answer.modules.length} module${answer.modules.length === 1 ? "" : "s"}: ${answer.modules.map((module) => module.name).join(", ")}${answer.rewrites.length > 0 ? `; ${answer.rewrites.length} scenario${answer.rewrites.length === 1 ? "" : "s"} rewritten` : ""}`,
          );
        }),
      ),
    );
  }

  /** A part's features a module can hold, in the order of their code: written, with functional specs. */
  private gatheredFeatures(part: string): GatheringFeature[] {
    const division = this.state.divided?.[part];
    return featuresOf(this.state, part).flatMap(({ key, leaf, feature }) => {
      const specs = this.state.features[key]?.captured?.specs ?? [];
      return specs.length === 0 ? [] : [{ key, area: leaf, title: feature.title, owns: division?.owns[key] ?? feature.about, specs }];
    });
  }

  /**
   * Each module's scenarios tried on the original, once its ***plain is checked against the code and before it is
   * written. They are what the regenerated code's conformance tests check, written by agents that read the original but
   * never ran it - so one can expect a terminal its test will not give, a site on the internet, wrapping at a width
   * nobody set. An agent with a shell on a copy of the original - its files, installed there by the agent - runs each as
   * its conformance test will, under the test reqs: one the original does otherwise is corrected to what it does, one
   * nothing outside can check is removed, and what a test must set up for the original to act as they say joins the test
   * reqs. So many scenarios an agent; a module's agents one after another in a copy of its own, removed once they are
   * done. What never holds is left as it was, and the report says so.
   */
  async trialScenarios(): Promise<void> {
    const assembly = assemble(this.state, this.options.moduleSpecs, { trials: false });
    const pending = assembly.modules
      .filter((module) => !(this.state.tried ?? []).includes(module.name))
      .map((module) => ({ module, batches: trialBatches(module) }))
      .map((item) => ({ ...item, left: item.batches.filter((_, at) => this.state.trials?.[item.module.name]?.[String(at + 1)] === undefined).length }));
    if (pending.length === 0) return;
    const total = pending.reduce((sum, item) => sum + item.left, 0);
    if (total > 0) {
      const scenarios = pending.reduce((sum, item) => sum + item.batches.reduce((inner, batch) => inner + batch.length, 0), 0);
      this.tracker.stage("trying", total);
      this.progress(`trying ${scenarios} scenario${scenarios === 1 ? "" : "s"} on the original: ${total === 1 ? "an agent" : `${total} agents`}`);
    }
    await Promise.all(pending.map((item) => (item.left === 0 ? this.triedAll(item.module.name) : this.limited(() => this.trialModule(item.module, item.batches, assembly)))));
  }

  private async triedAll(module: string): Promise<void> {
    if (!(this.state.tried ?? []).includes(module)) (this.state.tried ??= []).push(module);
    this.save();
  }

  /** A module's scenarios tried on a copy of the original of its own, so many an agent, one after another. */
  private async trialModule(module: AssembledModule, batches: TrialScenario[][], assembly: Assembly): Promise<void> {
    const dir = join(captureDir(this.options.plainDir), "trial", module.name);
    const original = join(dir, "original");
    const part = this.part(module.part);
    const checked = checkedModule(module, assembly.shared);
    try {
      for (const [at, batch] of batches.entries()) {
        const key = String(at + 1);
        if (this.state.trials?.[module.name]?.[key] !== undefined) continue;
        this.stopIfAsked();
        const installed = existsSync(original);
        if (!installed) copyOriginal(this.map, original);
        const label = `trial ${module.name}${batches.length > 1 ? ` ${at + 1}` : ""}`;
        const context = this.trialContext(part, module, batch, assembly, { folder: original, installed });
        const convert = (params: Record<string, unknown>) => ({
          results: records(params.scenarios).map((item) => {
            const corrected = text(item.text);
            const why = text(item.why);
            return { funcId: text(item.func_id), scenarioId: text(item.scenario_id), outcome: text(item.outcome) as TrialOutcome, ran: text(item.ran), ...(corrected !== "" ? { text: corrected } : {}), ...(why !== "" ? { why } : {}) };
          }),
          specs: records(params.functional_specs).map((item): Correction => ({ funcId: text(item.func_id), text: text(item.text), why: text(item.why) })),
          testReqs: strings(params.test_reqs).map((req) => req.replace(/^-\s+/, "")),
        });
        const { answer, problems } = await askAgent(
          { ...this.analysis(label, "trial", context, { reads: true, calls: TRIAL_CALLS }), shell: { workdir: original, home: dir }, turnAtLeastMs: TRIAL_TURN_MS },
          { ...TRIAL_TOOL, convert },
          (answer) => trialProblems(answer, batch, checked),
        );
        ((this.state.trials ??= {})[module.name] ??= {})[key] = answer ?? { failed: `what its agent handed over did not hold: ${problems.join(" ")}` };
        this.save();
        this.tracker.worked();
        this.progress(answer === undefined ? `could not try ${label.slice("trial ".length)}'s scenarios on the original - kept as they were` : `tried ${batch.length} scenario${batch.length === 1 ? "" : "s"} of ${module.name} on the original: ${trialSummary(answer.results)}`);
      }
      await this.triedAll(module.name);
    } finally {
      // The copy, its installs, its home and its caches: what an agent ran the original in, never kept.
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** What an agent trying scenarios is given: how the tests run, the conventions, the functional specs, the scenarios, its folder. */
  private trialContext(part: Part, module: AssembledModule, batch: TrialScenario[], assembly: Assembly, copy: { folder: string; installed: boolean }): string {
    const sharedModule = assembly.shared.find((candidate) => candidate.name === module.shared)!;
    const conformance = part.stdlibStack !== undefined && part.stdlibConformance === true ? stdlibTemplates().find((template) => template.name === conformanceOf(part.stdlibStack!)) : undefined;
    // What the trials before this one found a test must set up: of this part's modules, so far.
    const found = trialTestReqs(assembly.modules.filter((candidate) => candidate.part === part.name).flatMap((candidate) => Object.values(this.state.trials?.[candidate.name] ?? {})));
    const reqs = [...sharedModule.testReqs, ...found.filter((req) => !sharedModule.testReqs.includes(req))];
    const specs = new Map(module.features.flatMap((feature) => feature.specs).map((spec) => [spec.funcId, spec]));
    const funcIds = [...new Set(batch.map((scenario) => scenario.funcId))];
    return [
      `<part>\n${part.name} - ${part.about}\n</part>`,
      [
        "<how its conformance tests run>",
        ...(conformance !== undefined ? [`### ${conformance.name}`, conformance.text.trim(), ""] : []),
        ...(reqs.length > 0 ? ["### The part's test reqs", ...reqs.map((req) => `- ${req}`)] : conformance === undefined ? ["None written: run each scenario as a black-box test would - from outside, its output captured, its input not a terminal."] : []),
        "</how its conformance tests run>",
      ].join("\n"),
      ...((part.conventions ?? []).length > 0 ? [`<conventions>\n${part.conventions!.map((convention) => `- ${convention.text}`).join("\n")}\n</conventions>`] : []),
      `<definitions>\n${[...sharedModule.definitions, ...module.definitions].map((definition) => `- ${definition.text}`).join("\n") || "None."}\n</definitions>`,
      `<functional specs of ${module.name}>\n${funcIds.map((funcId) => `# ${funcId}\n${specs.get(funcId)?.text ?? ""}`).join("\n\n")}\n</functional specs of ${module.name}>`,
      `<scenarios to try>\n${batch.map((scenario) => `### ${scenario.funcId}, scenario ${scenario.scenarioId} (${scenario.kind})\n${scenario.text}`).join("\n\n")}\n</scenarios to try>`,
      `<your folder>\n${slashed(copy.folder)} - a copy of the original codebase: its files as git has them, ${copy.installed ? "where an agent before you tried other scenarios of the module - what it installed may be there: look before installing again" : "nothing installed"}.\n</your folder>`,
    ].join("\n\n");
  }

  /** Concepts defined in different words by different features, given one definition each. */
  async reconcile(): Promise<void> {
    const conflicts = assemble(this.state, this.options.moduleSpecs).conflicts;
    if (conflicts.length === 0) return;
    const batches: ConceptConflict[][] = [];
    for (let at = 0; at < conflicts.length; at += CONFLICTS_PER_AGENT) batches.push(conflicts.slice(at, at + CONFLICTS_PER_AGENT));
    this.tracker.stage("reconciling", batches.length);
    this.progress(`reconciling ${conflicts.length} concept${conflicts.length === 1 ? "" : "s"} defined twice`);
    await Promise.all(
      batches.map((batch, index) =>
        this.limited(async () => {
          this.stopIfAsked();
          const part = batch[0]!.part;
          const known = this.knownConcepts(part);
          const others = this.definitionsOf(part);
          const context = batch
            .map((conflict) =>
              [
                `<concept name="${conflict.concept}" part="${conflict.part}">`,
                "Its definitions:",
                ...conflict.texts.map((given) => `- ${given}`),
                "Used in:",
                ...conflict.uses.slice(0, 4).map((use) => `- ${use.where}: ${use.text.slice(0, 400).replace(/\n/g, " ")}`),
                "</concept>",
              ].join("\n"),
            )
            .concat(`<concepts you may use>\n${[...known].join(", ")}\n</concepts you may use>`)
            .join("\n\n");
          const asked = batch.map((conflict) => conflict.concept);
          const { answer } = await askAgent(this.agent(`concepts ${index + 1}`, "concepts", context, { reads: false, rules: true, calls: 3 }), { ...CONCEPTS_TOOL, convert: (params) => definitionsOf(params.definitions) }, (answer) =>
            reconciledProblems(answer, asked, known, others),
          );
          // What never held keeps the first definition given: one of the writers' own.
          for (const conflict of batch) {
            const given = answer?.find((definition) => definition.concept === conflict.concept)?.text ?? conflict.texts[0]!;
            (this.state.reconciled[conflict.part] ??= {})[conflict.concept] = given;
          }
          this.save();
          this.tracker.worked();
        }),
      ),
    );
  }

  /** Every concept a part's modules may use: the part's own, and every one its features defined. */
  private knownConcepts(part: string): Set<string> {
    return new Set(this.definitionsOf(part).map((definition) => definition.concept));
  }

  /** A part's definitions: its own, and the first of each its features defined - or the one reconciled. */
  private definitionsOf(part: string): Definition[] {
    const found = new Map(this.part(part).definitions.map((definition) => [definition.concept, definition]));
    const reconciled = this.state.reconciled[part] ?? {};
    for (const leaf of leavesOf(this.state, part)) {
      for (const feature of leaf.features ?? []) {
        for (const definition of this.state.features[featureKey(leaf.id, feature.name)]?.captured?.definitions ?? []) {
          if (!found.has(definition.concept)) found.set(definition.concept, reconciled[definition.concept] !== undefined ? { concept: definition.concept, text: reconciled[definition.concept]! } : definition);
        }
      }
    }
    return [...found.values()];
  }

  /** Each module's ***plain read for readability alone, its functional specs rewritten where they read as code. */
  async readability(): Promise<void> {
    const { modules, shared } = assemble(this.state, this.options.moduleSpecs);
    const pending = modules.filter((module) => !this.state.edited.includes(module.name));
    if (pending.length === 0) return;
    this.tracker.stage("reading", pending.length);
    this.progress(`reading ${pending.length} module${pending.length === 1 ? "" : "s"} for readability`);
    await Promise.all(
      pending.map((module) =>
        this.limited(async () => {
          this.stopIfAsked();
          const sharedModule = shared.find((candidate) => candidate.name === module.shared)!;
          const known = new Set([...sharedModule.definitions, ...module.definitions].map((definition) => definition.concept));
          const specs = module.features.flatMap((feature) => feature.specs);
          const edits: Record<string, string> = {};
          for (let at = 0; at < specs.length; at += SPECS_PER_PASS) {
            const chunk = specs.slice(at, at + SPECS_PER_PASS);
            const originals = new Map(chunk.map((spec) => [spec.funcId, spec.text]));
            const context = readabilityContext(module, sharedModule.definitions, chunk, stackBlock(this.part(module.part)));
            const { answer } = await askAgent(
              this.agent(`readability ${module.name}`, "readability", context, { reads: false, rules: true, calls: 3 }),
              { ...EDITS_TOOL, convert: (params) => records(params.edits).map((item) => ({ funcId: text(item.func_id), text: text(item.text) })) },
              (answer) => answer.flatMap((edit) => editProblems(edit.funcId, edit.text, originals.get(edit.funcId), known)),
            );
            // What did not hold is left as the writer had it: the pass is an optimiser, never a gate.
            for (const edit of answer ?? []) if (edit.text !== originals.get(edit.funcId) && editProblems(edit.funcId, edit.text, originals.get(edit.funcId), known).length === 0) edits[edit.funcId] = edit.text;
          }
          this.state.edits[module.name] = edits;
          this.state.edited.push(module.name);
          this.save();
          this.tracker.worked();
        }),
      ),
    );
  }

  /** Write the ***plain - once: the testing scripts are written for it, and may name themselves in its config. */
  write(): void {
    const assembly = assemble(this.state, this.options.moduleSpecs);
    if (assembly.modules.length === 0) throw new CaptureError("Nothing could be captured: no feature of the codebase held. Run it again to try the areas and features that failed once more.");
    if (this.state.written === true) return;
    writeCapture(this.options.plainDir, this.map, this.state, assembly, this.options.given);
    this.state.written = true;
    this.save();
  }

  /**
   * Each part's testing scripts, written by turri's skills on the ***plain just written - on the coding model when one
   * was given - side by side. One that is not written does not stop the capture: the report says why, and what to ask.
   */
  async scripts(): Promise<void> {
    const assembly = assemble(this.state, this.options.moduleSpecs);
    const parts = this.state.survey!.parts;
    const asked = parts.flatMap((part) => {
      const first = assembly.modules.find((module) => module.part === part.name);
      if (first === undefined) return [];
      return SCRIPT_KINDS.map((kind) => ({ key: `${part.name}:${kind}`, part, module: first.name, ...(parts.length > 1 ? { configModule: first.name } : {}), kind }));
    });
    const pending = asked.filter((item) => this.state.scripts?.[item.key] === undefined);
    if (pending.length === 0) return;
    this.tracker.stage("scripts", pending.length);
    this.progress(`writing ${pending.length === 1 ? "a testing script" : `${pending.length} testing scripts`}`);
    await Promise.all(
      pending.map((item) =>
        this.limited(async () => {
          this.stopIfAsked();
          const outcome = await this.script(item);
          (this.state.scripts ??= {})[item.key] = outcome;
          this.save();
          this.tracker.worked();
          const { what } = testingScriptSkill(item.kind);
          this.progress("written" in outcome ? `wrote the ${what} of ${item.part.name}: ${outcome.written}` : `no ${what} for ${item.part.name}: ${outcome.failed}`);
        }),
      ),
    );
  }

  private async script(item: { part: Part; module: string; configModule?: string; kind: ScriptKind }): Promise<ScriptOutcome> {
    const { plainDir, root, signal } = this.options;
    const model = this.models.capture;
    try {
      await watched(this.tracker.agent(testingScriptSkill(item.kind).what), signal, () =>
        (this.options.writeScript ?? writeTestingScript)({
          plainDir,
          root,
          module: item.module,
          ...(item.configModule !== undefined ? { configModule: item.configModule } : {}),
          part: item.part,
          kind: item.kind,
          ...(model !== undefined ? { model } : {}),
          ...(signal !== undefined ? { signal } : {}),
        }),
      );
    } catch (error) {
      this.stopIfAsked();
      return { failed: error instanceof Error ? error.message : String(error) };
    }
    const found = withConfigModule(item.configModule, () => findTestScripts(plainDir, join(plainDir, `${item.module}.plain`)))[item.kind];
    return found !== undefined ? { written: slashed(relative(plainDir, found)) } : { failed: "its skill ended with no script written" };
  }

  /** Check the ***plain, write the report, and mark the capture finished. */
  finish(): CaptureResult {
    const { plainDir } = this.options;
    const assembly = assemble(this.state, this.options.moduleSpecs);
    const checks: CheckResult[] = assembly.modules.map((module) => checkPlainFile(join(plainDir, `${module.name}.plain`)));
    this.state.finished = new Date().toISOString();
    const report = renderReport({ root: this.options.root, plainDir, map: this.map, state: this.state, assembly, checks });
    writeFileSync(reportFile(plainDir), report);
    this.save();
    const specs = assembly.modules.reduce((sum, module) => sum + module.features.reduce((inner, feature) => inner + feature.specs.length, 0), 0);
    const failedAreas = Object.values(this.state.areas).filter((area) => area.failed !== undefined).length;
    const failedFeatures = Object.values(this.state.features).filter((feature) => feature.failed !== undefined).length;
    return {
      plainDir,
      reportFile: reportFile(plainDir),
      summary: summaryOf({ plainDir, map: this.map, assembly, state: this.state, checks }),
      modules: assembly.modules.map((module) => module.name),
      specs,
      uncaptured: failedAreas + failedFeatures,
      failing: checks.filter((check) => !check.ok).length,
    };
  }
}

function trimSlash(path: string): string {
  return path.replace(/^\.\/(?=.)/, "").replace(/\/+$/, "") || ".";
}

function partOf(item: Record<string, unknown>): Part {
  const stack = text(item.stdlib_stack);
  return {
    name: kebab(text(item.name)) || text(item.name),
    about: text(item.about),
    paths: strings(item.paths).map(trimSlash),
    ...(stack !== "" ? { stdlibStack: stack.replace(/\.plain$/, "") } : {}),
    ...(item.stdlib_conformance === true ? { stdlibConformance: true } : {}),
    implementationReqs: strings(item.implementation_reqs).map((req) => req.replace(/^-\s+/, "")),
    conventions: conventionsOf(item.conventions),
    testReqs: strings(item.test_reqs).map((req) => req.replace(/^-\s+/, "")),
    definitions: definitionsOf(item.definitions),
  };
}

function capturedOf(params: Record<string, unknown>): CapturedFeature {
  const scenarios = (value: unknown) => records(value).map((item) => ({ id: text(item.scenario_id), text: text(item.text) }));
  return {
    specs: records(params.functional_specs).map((item) => ({ funcId: text(item.func_id), text: text(item.text), conformance: scenarios(item.conformance), acceptance: scenarios(item.acceptance) })),
    definitions: definitionsOf(params.definitions),
    assumptions: strings(params.assumptions),
    uncertain: strings(params.uncertain),
    dropped: strings(params.dropped),
  };
}

/** The interface among some files, file by file, for an agent: each name the code gives it, so many at most. */
export function interfaceBlock(tag: string, lead: string, surfaces: InterfaceSurface[]): string {
  if (surfaces.length === 0) return `<${tag}>\nThe map found none in these files: find it in the code.\n</${tag}>`;
  const byFile = new Map<string, string[]>();
  for (const surface of surfaces.slice(0, INTERFACE_LISTED)) byFile.set(surface.path, [...(byFile.get(surface.path) ?? []), surface.kind === "env" ? `\`${surface.name}\` (environment variable)` : `\`${surface.name}\``]);
  const more = surfaces.length > INTERFACE_LISTED ? [`and ${surfaces.length - INTERFACE_LISTED} more, in these files and others of yours`] : [];
  return [`<${tag}>`, lead, ...[...byFile].map(([path, names]) => `- ${path}: ${names.join(", ")}`), ...more, `</${tag}>`].join("\n");
}

/**
 * The interface among some files, for an agent: the reference's entries - each with every name, what it takes, its
 * choices and its default, and where - and, after them, what the map found there that the reference does not list.
 */
export function referenceBlock(tag: string, lead: string, entries: InterfaceEntry[], unlisted: InterfaceSurface[]): string {
  if (entries.length === 0 && unlisted.length === 0) return `<${tag}>\nNone in these files: find it in the code.\n</${tag}>`;
  const line = (entry: InterfaceEntry) => {
    const facts = [
      ...(entry.aliases.length > 0 ? [`also ${entry.aliases.map((alias) => `\`${alias}\``).join(", ")}`] : []),
      ...(entry.takes !== undefined ? [`takes \`${entry.takes}\``] : []),
      ...(entry.choices.length > 0 ? [`one of ${entry.choices.map((choice) => `\`${choice}\``).join(", ")}`] : []),
      ...(entry.default !== undefined ? [`default \`${entry.default}\``] : []),
      ...(entry.hidden === true ? ["hidden"] : []),
    ];
    return `- ${entry.kind}${entry.command !== undefined ? ` of \`${entry.command}\`` : ""} \`${entry.name}\`${facts.length > 0 ? ` - ${facts.join("; ")}` : ""} (${entry.where})`;
  };
  const shown = entries.slice(0, INTERFACE_LISTED).map(line);
  const more = entries.length > INTERFACE_LISTED ? [`and ${entries.length - INTERFACE_LISTED} more - the reference lists them all`] : [];
  const others =
    unlisted.length > 0
      ? [entries.length > 0 ? "Found by the map, and in no entry of the reference - read each where it is:" : "", ...unlisted.slice(0, INTERFACE_LISTED).map((surface) => `- ${shownSurface(surface)}`)].filter((text) => text !== "")
      : [];
  return [`<${tag}>`, lead, ...shown, ...more, ...others, `</${tag}>`].join("\n");
}

/** An agent's part of the interface reference, as it handed it over. */
function referenceAnswerOf(params: Record<string, unknown>): { entries: InterfaceEntry[]; excluded: InterfaceExclusion[] } {
  const given = (value: unknown) => (typeof value === "string" && value.trim() !== "" ? value.trim() : undefined);
  return {
    entries: records(params.entries).map((item): InterfaceEntry => {
      const command = given(item.command);
      const takes = given(item.takes);
      const value = typeof item.default === "string" && item.default.trim() !== "" ? item.default.trim() : undefined;
      const help = typeof item.help === "string" && item.help.trim() !== "" ? item.help : undefined;
      return {
        kind: text(item.kind) as InterfaceKind,
        name: text(item.name),
        aliases: strings(item.aliases),
        ...(command !== undefined ? { command } : {}),
        ...(takes !== undefined ? { takes } : {}),
        choices: strings(item.choices),
        ...(value !== undefined ? { default: value } : {}),
        ...(item.repeatable === true ? { repeatable: true } : {}),
        ...(item.required === true ? { required: true } : {}),
        ...(item.hidden === true ? { hidden: true } : {}),
        ...(help !== undefined ? { help } : {}),
        details: strings(item.details),
        where: text(item.where),
        also: strings(item.also).map(trimSlash),
      };
    }),
    excluded: records(params.excluded).map((item) => ({ name: text(item.name), path: trimSlash(text(item.path)), why: text(item.why) })),
  };
}

/** A feature's answer as the state keeps it: the title an interface writer gave goes to its outline. */
function withoutTitle(answer: CapturedFeature): CapturedFeature {
  return { specs: answer.specs, definitions: answer.definitions, assumptions: answer.assumptions, uncertain: answer.uncertain, dropped: answer.dropped };
}

/** Conventions as an agent handed them over: each a line, and the files that decide it. */
function conventionsOf(value: unknown): Convention[] {
  return records(value).map((convention) => ({ text: text(convention.text).replace(/^-\s+/, ""), where: strings(convention.where).map(trimSlash) }));
}

/** A module as its order's and its trials' checks see it: its functional specs by func-id, and the concepts it may use. */
function checkedModule(module: AssembledModule, shared: Assembly["shared"]): CheckedModule {
  const sharedModule = shared.find((candidate) => candidate.name === module.shared);
  return {
    specs: new Map(module.features.flatMap((feature) => feature.specs).map((spec) => [spec.funcId, spec])),
    known: new Set([...(sharedModule?.definitions ?? []), ...module.definitions].map((definition) => definition.concept)),
  };
}

/** A text's first line, cut to so many characters. */
function cut(text: string, chars: number): string {
  const line = text.trim().split("\n")[0]!.trim();
  return line.length > chars ? `${line.slice(0, chars)}...` : line;
}

/** A feature as the agent that gathers a part's features into modules is shown it. */
export interface GatheringFeature {
  key: string;
  area: AreaState;
  title: string;
  /** What it owns, as the division said, else what it was outlined for. */
  owns: string;
  specs: CapturedSpec[];
}

/**
 * A part's features for the agent that gathers them into modules, area by area in the order of their code: each with
 * what it owns, the first line of each functional spec, and its scenarios - cut shorter, then left out, until they fit
 * the budget.
 */
export function gatheringList(features: GatheringFeature[], budget: number): string {
  const render = (scenarioChars: number | undefined) => {
    const lines: string[] = [];
    let area: string | undefined;
    for (const feature of features) {
      if (feature.area.id !== area) {
        if (area !== undefined) lines.push("");
        area = feature.area.id;
        lines.push(`## ${feature.area.id} - ${feature.area.about}`);
      }
      lines.push(`### ${feature.key} - ${feature.title}: ${cut(feature.owns, 300)}`);
      for (const spec of feature.specs) {
        lines.push(`- ${spec.funcId}: ${cut(spec.text, 200)}`);
        if (scenarioChars !== undefined) for (const scenario of [...spec.conformance, ...spec.acceptance]) lines.push(`  - scenario ${scenario.id}: ${cut(scenario.text, scenarioChars)}`);
      }
    }
    return lines.join("\n");
  };
  for (const chars of [400, 160, 60]) {
    const listed = render(chars);
    if (listed.length <= budget) return listed;
  }
  return render(undefined);
}

/** What trying some scenarios on the original found, in a line: `22 held, 2 corrected, 1 removed`. */
function trialSummary(results: Array<{ outcome: TrialOutcome }>): string {
  const outcomes: Array<[TrialOutcome, string]> = [
    ["held", "held"],
    ["corrected", "corrected"],
    ["removed", "removed"],
    ["untried", "not tried"],
  ];
  return outcomes
    .map(([outcome, said]) => [results.filter((result) => result.outcome === outcome).length, said] as const)
    .filter(([count]) => count > 0)
    .map(([count, said]) => `${count} ${said}`)
    .join(", ");
}

/** How many test names of one file a writer is shown. */
const TESTS_LISTED = 15;

/**
 * The original's tests in a feature's files, for its writer: how many lines each holds and what they are called - where
 * its scenarios go - and how many scenarios it may write, more the more the original tests it.
 */
export function testsBlock(evidence: TestEvidence[], budget: number): string {
  const lines = evidence.reduce((sum, file) => sum + file.lines, 0);
  const files = evidence.map((file) => {
    const names = file.tests.slice(0, TESTS_LISTED).join(", ");
    const more = file.tests.length > TESTS_LISTED ? `, and ${file.tests.length - TESTS_LISTED} more` : "";
    return `- ${file.path} - ${file.lines} lines: ${names}${more}`;
  });
  return [
    "<the original's tests>",
    evidence.length === 0
      ? `No file of your feature is a test of the original - its tests may be elsewhere: grep for what it does. You may write up to ${budget} scenarios.`
      : `The original tests your feature's files in ${lines} lines - you may write up to ${budget} scenarios, the most where these are densest:`,
    ...files,
    "</the original's tests>",
  ].join("\n");
}

function readabilityContext(module: AssembledModule, shared: Array<{ text: string }>, specs: AssembledModule["features"][number]["specs"], stack: string): string {
  return [
    stack,
    `<definitions>\n${[...shared, ...module.definitions].map((definition) => `- ${definition.text}`).join("\n") || "None."}\n</definitions>`,
    `<functional specs of ${module.name}>\n${specs.map((spec) => `# ${spec.funcId}\n${spec.text}${scenariosOf(spec)}`).join("\n\n")}\n</functional specs of ${module.name}>`,
  ].join("\n\n");
}

/** A functional spec's scenarios, under it, for the readability pass: what they pin, its text need not say. */
function scenariosOf(spec: CapturedSpec): string {
  const lines = [...spec.conformance.map((scenario) => `- conformance ${scenario.id}: ${scenario.text}`), ...spec.acceptance.map((scenario) => `- acceptance ${scenario.id}: ${scenario.text}`)];
  return lines.length === 0 ? "" : `\n<scenarios of ${spec.funcId}>\n${lines.join("\n")}\n</scenarios of ${spec.funcId}>`;
}

/**
 * What a part is built on, as a writer is told it: the standard library's templates it imports - the stack, its kind's
 * common one, its language's - in full, and its own implementation reqs. All of it is the default: what the code does
 * because of it is never restated.
 */
export function stackBlock(part: Part): string {
  const templates = new Map(stdlibTemplates().map((template) => [template.name, template]));
  const imported: string[] = [];
  const visit = (name: string) => {
    const template = templates.get(name);
    if (template === undefined || imported.includes(name) || name.includes("/conformance/")) return;
    for (const below of template.imports) visit(below);
    imported.push(name);
  };
  if (part.stdlibStack !== undefined) visit(part.stdlibStack);
  return [
    "<stack>",
    ...(imported.length > 0 ? ["Built on turri's standard library - what these say the code does is settled already: never write it again.", ""] : []),
    ...imported.flatMap((name) => [`### ${name}`, templates.get(name)!.text, ""]),
    ...(part.implementationReqs.length > 0 ? ["### The part's own implementation reqs", ...part.implementationReqs.map((req) => `- ${req}`), ""] : []),
    ...((part.conventions ?? []).length > 0
      ? ["### The part's conventions - settled from its code: every functional spec and scenario follows them, and none decides them again", ...part.conventions!.map((convention) => `- ${convention.text}`)]
      : []),
    "</stack>",
  ].join("\n");
}
