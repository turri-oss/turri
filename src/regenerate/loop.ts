import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { plainFileParser, withParseCache } from "../plain/parser.ts";
import { STDLIB_ROOT } from "../plain/stdlib.ts";
import { ACCEPTANCE_TESTS, CONFORMANCE_TESTS, FUNCTIONAL_REQUIREMENTS, REQUIRED_FUNCTIONAL_SPECS, TEST_PLAIN_FILES, TEST_REQUIREMENTS, type MarshalledPlainSource, type TestPlainFileBinding } from "../plain/spec.ts";
import { testPlainFilesOf } from "../test-plain-files.ts";
import { reportActivity, reportStage } from "./activity.ts";
import { llmChunkAgents, MAX_LINES_PER_JOB, MAX_SPECS_PER_JOB, planChunks, stepsOf, type ChunkAgents, type PlanInput } from "./chunk-plan.ts";
import { commitNotes, landWork, recordHistory, resetToLastCommit } from "./lineage.ts";
import { firstLine, record } from "./ledger.ts";
import { NOTES_FILE, recordPulse, type SpecGap } from "./notes.ts";
import { createJobRegistry, formatDuration, type Job, type JobRegistry, type PulseCases } from "./jobs.ts";
import { moduleLanes } from "./lanes.ts";
import type { Steering } from "./steer.ts";
import {
  adoptDigests,
  chainTree,
  codeTree,
  conformanceTarget,
  marksRegenerateAgain,
  REGENERATE_AGAIN,
  inheritedRecord,
  isOldRecord,
  notBuilt,
  readRecord,
  RECORD_FILE,
  withResourceDigests,
  writeCodeRecord,
  writeTestsRecord,
  hasScenarios,
  identityOf,
  testedFuncIds,
} from "./records.ts";
import { describeSpecDiffConformance, renderSpecDiffConformance } from "./conform.ts";
import { conformanceDirFor } from "./conformance.ts";
import { modulesRoot, projectRootOf } from "./paths.ts";
import { configForSpec, stackForModule, stackPinned, testDirOf, withStack } from "../config.ts";
import { describeSpecChange } from "./prompt.ts";
import { resolveTemplateDirs } from "./paths.ts";
import { builtTips, copyRequiredCode, importingModules, isImportModule, newlyRequired, resolveRequiresChain, startFromScratch, type ChainEntry } from "./requires.ts";
import { describeSpecDiff, renderSpecDiff, specFilesOf, type SpecSnapshot } from "./regenerate.ts";
import { locateDiffLines, type DiffWhere } from "./diff-view.ts";
import { agentChanges, changeDiffInFiles } from "./change-view.ts";
import { createSteering, MAX_STEERS, markTold, steer, waitingSteer, type JobSteering } from "./steering.ts";
import { projectDirOf } from "./paths.ts";
import { changesBetween, parseTree, serializeTree, type SpecChange, type SpecStep } from "./spec-steps.ts";
import { listFiles } from "./testing.ts";
import { makeRenames, pureRenames, renameText } from "./renames.ts";
import { casesOf, codeWork, stillWanted, whyNotWanted, type JobCases, type ScenarioCases, type TouchedSpec } from "./drift.ts";
import { testingGap } from "./testing-steps.ts";
import { baseFolderDrift, baseOfCodebase, seedFromBaseFolder } from "./base-folder.ts";
import { BASE_RECORD_FILE } from "./paths.ts";
import { onScriptRunEnded, scriptBeingWritten } from "./scripts-being-written.ts";
import { conformanceTestsOn } from "../conformance-switch.ts";
import { findTestScripts, projectRootFor, type ScriptKind } from "./test-scripts.ts";

/**
 * The work loop - see docs/regenerating.md.
 *
 * Nothing is queued. For every codebase it has been asked to bring up to its spec, the loop works out
 * what is left to build - from the code record to the spec of the codebase's requires chain, as the
 * .plain files have it now - has the planner cut it into jobs, and runs the first. When a job ends, or
 * the spec changes, it works it out again. A plan is kept only while the spec and the record it was cut
 * from stay as they were.
 *
 * Code accumulates up a requires chain: a module is built on a copy of the code of the one it requires.
 * So the codebase of a chain is its furthest-built module - its tip - and a change to a module below is
 * made there. The codebases below it are left as they were, their records saying what they are built
 * from; one is brought up to its own spec again only when a module not built yet is to start from it.
 *
 * - A module waits while one it is built on has work left, or a job running.
 * - A running job the spec no longer wants - one of its changes is no longer part of the work - is
 *   stopped, and what it did rolled back. Otherwise it finishes, and the next plan starts from what it
 *   landed.
 * - A job that does not land halts its codebase: nothing more runs there until the spec changes or it is
 *   asked for again.
 */

/** A planned job: its title, why, its cases, and its step - its diff and the spec it leaves. */
export interface PlannedJob {
  title: string;
  reason: string;
  cases: JobCases;
  step: SpecStep;
  /** What it builds: the code, or the conformance tests of what the code is built from. */
  track: Track;
}

/** The two things a codebase is brought up in: its code, and - on the code as built - its conformance tests. */
export type Track = "code" | "conformance";

/** What renders a job. Injectable, so the loop can be tested without a model. */
export type JobRunner = (
  job: {
    plainFile: string;
    moduleName: string;
    buildDir: string;
    spec: SpecSnapshot;
    planned: PlannedJob;
    model?: string;
    cwd: string;
    /** A code job's: how the loop steers it when the spec changes inside what it regenerates - and the record it lands. */
    steering?: JobSteering;
  },
  onDelta: (delta: string) => void,
) => Promise<{ landed: boolean; report: string; story?: string; specGaps?: SpecGap[] }>;

/** A codebase as the loop sees it, for the person. */
export interface ModuleStatus {
  module: string;
  plainFile: string;
  /** The job running now, if one is. */
  running?: { jobId: string; title: string; steered?: string[] };
  /**
   * The jobs planned after it, in order: the module's code jobs, then its conformance jobs. The conformance tests of
   * its functional specs with scenarios, behind while its code is still to build - `afterCode`, `specs` those
   * functional specs as `module:func-id` - come last: they are planned into pulses only once the code is built, but are
   * shown, so what follows the code is seen.
   */
  planned: Array<{ title: string; cases: JobCases; track: Track; planning?: true; afterCode?: true; specs?: string[] }>;
  /**
   * What the plan of its code did not do as asked: the person's wishes its planner did not follow and why, an answer
   * that did not hold, a group split for its size.
   */
  planNotes?: string[];
  /** Why nothing runs there, when nothing does. */
  why?: string;
  /** What asking for conformance tests changed there, when it changed nothing: they are written for what is built already. */
  conformanceNote?: string;
  /**
   * It now requires modules its code was not built on - `requires` - and is built only once its code is started
   * over on them: these codebases' code and tests taken out, kept in their history, and built again from the
   * bottom of the chain. Or - `old` - these codebases were built when functional specs were numbered, before they had
   * func-ids: nothing is built on them, and the whole chain is regenerated from scratch. Never done unasked:
   * `startOver` does it.
   */
  startOver?: { requires: string[]; codebases: string[]; old?: true };
  /** The stack it is built with - its config.turri.<stack>.yaml over config.turri.yaml - when one is. */
  stack?: string;
  /** Pure renames turri makes once the running pulse ends - a func-id or a scenario-id, nothing else with it: nothing regenerated. */
  renames?: string[];
  /**
   * The base folder its codebase started from (base-folder.ts): the folder as `base-folder:` named it, and how many of
   * the files that came from it the codebase has still - carried up with the code to a module built on it. None when it
   * started from none, or has no code yet.
   */
  base?: { folder: string; files: number };
}

interface ModuleState {
  /** The module's requires chain, bottom first: the module itself last. */
  chain: ChainEntry[];
  /** The .plain file the person asked for: steering is read for it. */
  askedFile: string;
  model?: string;
  /**
   * The stack it is built with, pinned when it was asked for (`stackForModule`) - none, the project's config alone: its
   * plans, pulses and testing scripts read the config with it, whatever is chosen since.
   */
  stack?: { name: string | undefined };
  guidance: string[];
  /** The code's plan: planned again when the spec, where it starts from or the steering it followed changes. */
  plan?: { specKey: string; from: string; steeringKey: string; jobs: PlannedJob[]; notes: string[] };
  /** The conformance tests' plan, apart from the code's: planned from what they are written for. */
  /** `codeKey`: the code record it was planned against - what the tests are written for follows the code; it changed, the plan is made again. */
  conformancePlan?: { specKey: string; from: string; codeKey: string; jobs: PlannedJob[] };
  running?: {
    jobId: string;
    /** Its number among the module's pulses this session, from 1: what the regeneration calls it. */
    number: number;
    planned: PlannedJob;
    from: MarshalledPlainSource;
    after: MarshalledPlainSource;
    stopping?: boolean;
    /** Running on although the spec moved on from it - allow-to-stop-jobs is false - and why: said once a reason. */
    keptDespite?: string;
    /** A code job's steering: what it lands, what its agent is told, and how many times it was steered. */
    steering?: JobSteering;
    /** Stopped for the conformance tests of a module below - asked for by the person - and why: its codebase is deleted once it settles. */
    discard?: string;
  };
  /** The conformance tests a job a functional spec, as the person asked when they asked for them - not one job for all. */
  conformanceSeparately?: boolean;
  /**
   * The functional specs conform named, when it named some (by identity, records.ts `identityOf`): the conformance track
   * writes their tests alone, the others' left as they are - behind, as drift says - until the module is asked for again
   * or conform names none. Each functional spec as it read then: one whose text or scenarios change after joins them.
   */
  conformanceOnly?: { specs: Set<string>; read: Map<string, string> };
  /** The track being planned into jobs now, nothing running: what is next is shown while it is. */
  planning?: Track;
  /** When the planning now going on began: what the live panel counts from. */
  planningSince?: number;
  /** The conformance tests halted, the code going on: until the spec or the code changes from `key`, or they are asked for again. */
  conformanceHalted?: { why: string; key: string };
  /**
   * Nothing runs here until the spec changes from `specKey`, or it is asked for again. `pulse`: the one that did not
   * land - its number, and the trees it went between - for the regeneration to say which items it was regenerating.
   */
  halted?: { why: string; specKey: string; pulse?: { number: number; before: string; after: string }; cause?: string };
  /** Halted by the person (`WorkLoop.halt`): nothing runs here until it is asked for again - a spec change does not start it. */
  held?: { why: string };
  /** Its base folder as the status says it, and what it was read at - the two records' times: read again only when either moves. */
  base?: { at: string; base: ModuleStatus["base"] };
  /** How many pulses have started here this session: the next is numbered one more. */
  pulses?: number;
  /** The spec as the last look read it. */
  seen?: SpecSnapshot;
  /** Why the last look started nothing here. */
  why?: string;
  /** The module below it that it waits for, while it does: not planned until that one is built. */
  waitsFor?: string;
  /** Its code has to be started over on modules it was not built on - see `ModuleStatus.startOver`. */
  startOver?: ModuleStatus["startOver"];
}

/** What is left to regenerate in a codebase - see `WorkLoop.drift`. */
export interface DriftReport {
  module: string;
  plainFile: string;
  /** The code's work, from its record to the spec now: null, none - built from the spec as it is. */
  code: JobCases | null | undefined;
  /** The conformance tests' work: null, none; undefined, none are written here. */
  conformance: JobCases | null | undefined;
  running?: { jobId: string; title: string };
  /** Why nothing is regenerated there: halted, or its spec does not parse. */
  why?: string;
  startOver?: ModuleStatus["startOver"];
  /** Pure renames not made yet - a func-id or a scenario-id, nothing else changed with it: made by turri, nothing regenerated. */
  renames?: string[];
  /** How its base folder stands against what its codebase started from, when they do not agree (base-folder.ts). */
  baseFolder?: string;
  /** conform named these functional specs, as `module:func-id`: the conformance tests are written for them alone until the module is asked for again. */
  conformanceOnly?: string[];
  /** Conformance tests are off here (`conformance-tests:`): none written or run. */
  conformanceOff?: true;
}

/** What is left to regenerate, as the conversation and the command line read it. */
export function describeDrift(reports: DriftReport[]): string {
  if (reports.length === 0) return "Nothing to look at: no module of that spec.";
  const cases = (work: JobCases) => casesText(work);
  // Fully regenerated: in every codebase the code - and its conformance tests, where there are any - regenerated from
  // the spec as it is, nothing regenerating or waiting, and nothing holding the codebase back. A pulse that did not
  // land leaves its work undone, so it shows as drift.
  // conformance: null is no drift, undefined none written here - either is regenerated; a case list is work left.
  const regenerated = reports.every((report) => report.code === null && (report.conformance === null || report.conformance === undefined) && (report.renames ?? []).length === 0);
  const settled = reports.every((report) => report.running === undefined && report.why === undefined && report.startOver === undefined);
  const verdict = regenerated && settled ? "\nFully regenerated: every codebase is regenerated from the spec as it is, and nothing is regenerating." : "";
  return reports
    .map((report) => {
      const lines = [`${report.module} (${basename(report.plainFile)}):`];
      if (report.code === null) lines.push("  code: regenerated from the spec as it is - no drift");
      else if (report.code !== undefined) lines.push(`  code: drifted from the spec - to regenerate: ${cases(report.code)}`);
      if (report.conformance === null) lines.push("  conformance tests: written for what is built - no drift");
      else if (report.conformance !== undefined) {
        lines.push(
          report.conformanceOnly !== undefined
            ? `  conformance tests: to write or change - conform asked for ${report.conformanceOnly.join(", ")} alone: the others wait for conform with no names, or the module asked for again`
            : "  conformance tests: to write or change - written once the code is built, or now with conform",
          ...conformanceLines(report.module, report.conformance),
        );
      }
      else lines.push(report.conformanceOff === true ? "  conformance tests: off (conformance-tests: false) - none written or run" : "  conformance tests: none written here");
      for (const rename of report.renames ?? []) lines.push(`  renames ${rename} - the records and the tests' labels only, nothing regenerated`);
      if (report.baseFolder !== undefined) lines.push(`  ${report.baseFolder}`);
      if (report.running !== undefined) lines.push(`  regenerating now: pulse ${report.running.jobId} - ${report.running.title}`);
      if (report.why !== undefined) lines.push(`  ${report.why}`);
      if (report.startOver !== undefined) {
        lines.push(
          report.startOver.old === true
            ? `  it has to be regenerated from scratch, with its whole chain, before anything more is regenerated there: ${OLD_RECORDS_WHY(report.startOver.codebases)}`
            : `  it has to be regenerated from scratch on ${report.startOver.requires.join(", ")} before anything more is regenerated there`,
        );
      }
      return lines.join("\n");
    })
    .join("\n") + verdict;
}

/** A codebase as the loop has just looked at it: its chain, its spec now, and what its code is built from (`codeTree` form). */
export interface SeenSpec {
  chain: ChainEntry[];
  tree: MarshalledPlainSource;
  built: MarshalledPlainSource;
}

export interface WorkLoop {
  /**
   * Bring a spec's module up to the spec as the .plain files have it now - in the codebases where its
   * code lives, and every module it is built on that has to be built first - planning and starting the
   * first jobs. Asked again, it clears a halt. Also what a spec change is: the loop works out the work
   * again. `specChange`: brought up because its spec was changed, not asked for - a module the person halted stays
   * halted. Says what it planned.
   */
  bringUp(plainFile: string, options?: { model?: string; guidance?: string; specChange?: boolean }): Promise<ModuleStatus[]>;
  /**
   * Regenerate functional specs of a module again, their spec changed or not - each named by its func-id: each is marked to regenerate again in
   * the record of every codebase it is built in - committed - and they are brought up to their spec, the marked ones
   * planned as any change is. Their code is there: the jobs that regenerate them are told to regenerate it again, not
   * to build it anew.
   */
  regenerateAgain(plainFile: string, funcIds: string | string[], options?: { model?: string; guidance?: string }): Promise<ModuleStatus[]>;
  /**
   * What is left to regenerate, for a spec's module, in each codebase where its code lives: the code's work from its
   * record to the spec now, and the conformance tests' - planning nothing, starting nothing.
   */
  drift(plainFile: string): DriftReport[];
  /**
   * Write and run the conformance tests of a spec's module - of the functional specs named, or of every one - on the
   * code as it is built, in the codebases where its code lives: for this session, whatever the config says. Asked
   * again, it clears a halt. Says what it planned.
   */
  conformance(plainFile: string, options?: { funcIds?: string[]; model?: string; separately?: boolean }): Promise<ModuleStatus[]>;
  /**
   * Start over the codebases of a spec's module that now require a module their code was not built on (see
   * `ModuleStatus.startOver`): their code and conformance tests taken out - committed, so their history keeps
   * them - and the module brought up, from the bottom of its chain. Destructive: asked for only once the person
   * agreed. Says what it planned.
   */
  startOver(plainFile: string, options?: { model?: string }): Promise<ModuleStatus[]>;
  /**
   * Regenerate a spec's module from scratch: every codebase where its code lives taken back to nothing - its code and
   * conformance tests taken out, committed so its history keeps them - and the module brought up from its spec, planned
   * into pulses as any work is. With `chain`, every codebase of its requires chains too, the base's included: nothing
   * below is copied up, and the whole chain is built again from the bottom - after modules were split or moved, when
   * the code below was laid out for modules that are no more. Destructive: asked for only when the person asked for
   * it. Says what it planned.
   */
  fromScratch(plainFile: string, options?: { model?: string; guidance?: string; chain?: boolean }): Promise<ModuleStatus[]>;
  /**
   * Halt a module's planned work, as the person asked: `target` is a planned row's id (`planned-<module>-...`) or the
   * module's name. A module's pulses are planned again from its spec each look, so it is the module that is halted, not
   * one row: its pulse running is stopped and rolled back, nothing is planned or started there - nor in the modules built
   * on it, which wait for it - until it is asked for again; a spec change does not start it. A module whose .plain file is
   * gone is forgotten. Says what it did - undefined when the target names no module the loop looks after.
   */
  halt(target: string, reason?: string): string | undefined;
  /** Every codebase the loop looks after, bottom of each chain first. */
  status(): ModuleStatus[];
  /**
   * The jobs planned after the running ones, as jobs are listed - queued, each after the one before it -
   * for the job panel and pulses. Not started, they are not the registry's: planned again, they change.
   */
  planned(): Job[];
  /**
   * What the regeneration draws on top of the files: the .plain files asked for, and each codebase's pulses - running and
   * planned, numbered, with the trees each goes between - and why nothing moves there, when nothing does.
   */
  mapPlan(): MapPlan;
  /** Resolves once nothing runs and nothing more can start. */
  drain(): Promise<void>;
  /** In a dry run: the job each codebase would start, with the spec it would be given. */
  firsts(): Array<{ module: string; plainFile: string; buildDir: string; spec: SpecSnapshot; planned: PlannedJob }>;
}

/** A pulse as the regeneration places it: by the items its trees differ in. */
export interface MapPulse {
  /** Its number among the module's pulses this session - planned ones' provisional. */
  number: number;
  title: string;
  track: Track;
  running: boolean;
  /** Its id in the jobs listed - the running job's, or the planned row's - for the pulse list to go to. */
  rowId: string;
  /** The trees it goes between, serialized. */
  before: string;
  after: string;
  /**
   * The conformance tests that follow the code still to build - not planned, so with no trees: the functional specs they
   * are written for, each as `module:func-id`.
   */
  specs?: string[];
}

/** A codebase as the regeneration reads the loop. */
export interface MapCodebase {
  module: string;
  plainFile: string;
  buildDir: string;
  /** The pulses running and planned, in order. */
  pulses: MapPulse[];
  /** The track the planner is cutting now. */
  planning?: Track;
  /** The module below it that it waits for. */
  waitsFor?: string;
  /** Whether any of its functional specs has scenarios, and so conformance tests. */
  conformance: boolean;
  /** Why nothing runs there, when nothing does. */
  why?: string;
  /** What asking for conformance tests changed there, when it changed nothing: they are written for what is built already. */
  conformanceNote?: string;
  /**
   * Halted, or the planner found no plan: it needs the person. `pulse`, the pulse that did not land; `cause`, what went
   * wrong in it, in a few words - its tests never passed, the machine lacks a toolchain.
   */
  stuck?: { why: string; pulse?: { number: number; before: string; after: string }; cause?: string };
}

export interface MapPlan {
  /** The .plain files asked for, in the order they were. */
  files: string[];
  codebases: MapCodebase[];
}

const tipOf = (chain: ChainEntry[]): ChainEntry => chain.at(-1)!;

/** When a file was last written, as a key - none when it is not there. */
const modifiedAt = (path: string): string => {
  try {
    return String(statSync(path).mtimeMs);
  } catch {
    return "-";
  }
};

/** Whether a module's codebase has been started: code in it, or a record. */
const started = (entry: ChainEntry) => listFiles(entry.buildDir).length > 0 || readRecord(entry.buildDir) !== null;

/** The spec a codebase is built from, as the .plain files have it now: its whole requires chain's. */
export function chainSpec(chain: ChainEntry[]): SpecSnapshot {
  // Each module's linked resources hashed where its links point: what a file holds is part of the spec.
  const trees = chain.map((entry) => {
    const dirs = resolveTemplateDirs(entry.plainFile);
    // Its test plain files bound to it: each functional spec with its scenarios, and every one of them with a test plain file.
    return { module: entry.moduleName, tree: withResourceDigests(plainFileParser(basename(entry.plainFile), dirs, { allowNoFunctionalities: true, testDir: testDirOf(entry.plainFile) })[1], dirs) };
  });
  const tip = tipOf(chain);
  return { moduleName: tip.moduleName, plainFile: tip.plainFile, tree: chainTree(trees), chain };
}

/**
 * The chains a request for `plainFile` brings up: where its module's code lives - every built tip whose
 * chain holds it, one per branch - or, with none, its own chain. Each from its furthest-built module on:
 * the codebases below that are left as they are.
 */
function chainsFor(plainFile: string): ChainEntry[][] {
  const tips = builtTips(plainFile);
  return tips.length > 0 ? tips : [resolveRequiresChain(plainFile, [], undefined, { allowNoFunctionalities: true })];
}

/**
 * The modules a .plain file is built as: itself - or, an import module, the modules importing it whose code is started.
 * An import module is no codebase; one no started module imports has nothing to build yet - its reqs are built with the
 * first module that imports it.
 */
function codebasesOf(plainFile: string): string[] {
  if (!isImportModule(plainFile)) return [plainFile];
  return importingModules(plainFile).filter((file) => {
    try {
      return builtTips(file).length > 0 || started(resolveRequiresChain(file, [], undefined, { allowNoFunctionalities: true }).at(-1)!);
    } catch {
      return false;
    }
  });
}

/** How many functional specs of its own a codebase has built - none when it was only started from the code below it. */
function ownBuilt(entry: ChainEntry): number {
  return ((readRecord(entry.buildDir)?.[FUNCTIONAL_REQUIREMENTS] as unknown[] | undefined) ?? []).length;
}

/** How many of a module's functional specs are completed in the codebase a run delivers - see `functionalityCompletion`. */
export interface ModuleCompletion {
  module: string;
  /** Its own functional specs, as its spec has them now. */
  specified: number;
  /** Of those, the ones the delivered codebase's code record has as the spec has them now. */
  completed: number;
  /** Its own functional specs with scenarios: those that are tested - one with no test plain file is not. */
  withScenarios: number;
  /** Of the completed ones, those its conformance tests are recorded as written for, as the spec has them now - their scenarios too. */
  conformanceTested: number;
  /** Those conformance-tested ones, by func-id: for a host that shows each functional spec's state. */
  tested: string[];
  /** Its functional specs not completed, by func-id. */
  incomplete: string[];
}

/**
 * The functional specs of a spec's whole requires chain, completed or not, in the codebase each chain delivers: its
 * furthest-built module's code - which holds the code of every module below it. A functional spec is completed when that
 * codebase's code record, as last committed, holds it as the spec has it now - the same text, the linked files it uses
 * holding the same, no definition it uses changed, not marked to regenerate again. A record moves only when a pulse
 * lands, its unit tests passing (and its conformance tests, when they are on), so completed is landed and passing.
 * The modules above the delivered codebase have nothing completed. One entry per chain; planning nothing, calling no model.
 */
export function functionalityCompletion(plainFile: string): Array<{ codebase: string; modules: ModuleCompletion[] }> {
  return withParseCache(() =>
    chainsFor(resolve(plainFile)).map((chain) => {
      let delivered = -1;
      chain.forEach((entry, index) => {
        if (readRecord(entry.buildDir) !== null) delivered = index;
      });
      // Of each module's functional specs, those with scenarios: what "tested of specified" counts over.
      let whole: MarshalledPlainSource | undefined;
      try {
        whole = chainSpec(chain).tree;
      } catch {
        whole = undefined;
      }
      const ownItems = (tree: MarshalledPlainSource | undefined, module: string, own: boolean) =>
        ((tree?.[own ? FUNCTIONAL_REQUIREMENTS : REQUIRED_FUNCTIONAL_SPECS] as Array<{ markdown: string; module?: string; id: string }> | undefined) ?? []).filter((item) => own || item.module === module);
      const counts: ModuleCompletion[] = chain.map((entry, index) => ({
        module: entry.moduleName,
        specified: entry.funcIds.length,
        withScenarios: ownItems(whole, entry.moduleName, index === chain.length - 1).filter(hasScenarios).length,
        completed: 0,
        conformanceTested: 0,
        tested: [],
        incomplete: [...entry.funcIds],
      }));
      if (delivered === -1) return { codebase: tipOf(chain).buildDir, modules: counts };
      const codebase = chain.slice(0, delivered + 1);
      const tip = tipOf(codebase);
      const spec = chainSpec(codebase).tree;
      const record = readRecord(tip.buildDir);
      const changes = codeWork(record, spec);
      // Its own: what the work loop would regenerate - new, changed, a concept it uses changed, or marked again.
      const cases = casesOf(codeTree(record ?? {}), changes, { module: tip.moduleName });
      const touched = new Set([...cases.add, ...cases.patch, ...cases.again].map((spec) => `${spec.module ?? tip.moduleName}:${spec.funcId}`));
      // The modules' below it: an item the record does not have as the spec has it.
      for (const change of changes) {
        if (change.section !== REQUIRED_FUNCTIONAL_SPECS || change.after === undefined) continue;
        try {
          const item = JSON.parse(change.after) as { module?: string; id?: string };
          if (item.module !== undefined && item.id !== undefined) touched.add(`${item.module}:${item.id}`);
        } catch {
          /* not an item */
        }
      }
      // A functional spec as the tests are written for it: its text and its scenarios.
      const reads = (item: Record<string, unknown> | undefined): string | undefined => {
        if (item === undefined) return undefined;
        const scenarios = (key: string) => ((item[key] as Array<{ id?: string; text?: string }> | undefined) ?? []).map((scenario) => [scenario.id, scenario.text]);
        return JSON.stringify([String(item.markdown ?? "").trim(), scenarios(CONFORMANCE_TESTS), scenarios(ACCEPTANCE_TESTS)]);
      };
      const specText = (module: string, funcId: string): string | undefined =>
        reads(ownItems(spec, module, module === tip.moduleName).find((item) => item.id === funcId) as Record<string, unknown> | undefined);
      // What the conformance tests are written for, in the same codebase: its suite holds the chain's.
      const testsRecord = readRecord(conformanceDirFor(tip.moduleName, modulesRoot(projectDirOf(tip.plainFile))));
      codebase.forEach((entry, index) => {
        const count = counts[index]!;
        const completed = entry.funcIds.filter((funcId) => !touched.has(`${entry.moduleName}:${funcId}`));
        // Tests marked to regenerate again were written against code since replaced: not conformance tested until rewritten.
        const tested = ownItems(testsRecord ?? undefined, entry.moduleName, entry.moduleName === tip.moduleName).filter(
          (item) => item.id !== undefined && !marksRegenerateAgain(item) && reads(item as Record<string, unknown>) === specText(entry.moduleName, item.id),
        );
        count.completed = completed.length;
        count.tested = completed.filter((funcId) => tested.some((item) => item.id === funcId));
        count.conformanceTested = count.tested.length;
        count.incomplete = entry.funcIds.filter((funcId) => !completed.includes(funcId));
      });
      return { codebase: tip.buildDir, modules: counts };
    }),
  );
}

/** The modules of a chain to build: its furthest-built one, and those above it - or, none built, all of it. */
function toBuild(chain: ChainEntry[]): ChainEntry[] {
  let from = 0;
  chain.forEach((entry, index) => {
    if (started(entry)) from = index;
  });
  return chain.slice(from);
}

export function createWorkLoop(options: {
  registry: JobRegistry;
  cwd: string;
  /** The model a job renders on, asked when a module is brought up. */
  modelFor?: (plainFile: string) => string | undefined;
  /** The planner's agents. false: none - a functional spec a job. Default: the LLM ones, on `plannerModel`. */
  planner?: ChunkAgents | false;
  /** The planner's model, read afresh each plan - the chat's, in a conversation. */
  plannerModel?: string | (() => string | undefined);
  /** How the person wants the work cut and ordered, for every plan of a spec's module. */
  steering?: (plainFile: string) => Steering[];
  /** Renders a job. Default: a spec diff render that lands on its unit tests. */
  run?: JobRunner;
  /** Writes and runs a conformance job's tests. Default: a spec diff's conformance run, the whole suite with it. */
  runConformance?: JobRunner;
  /**
   * Under `release-after-pulse: true`, what releases a pulse that landed, as its last stage - before the pulse ends, so
   * the module's next pulse starts on what is released. Its last reply goes in the pulse's report. Not given: nothing is.
   */
  release?: (input: { plainFile: string; moduleName: string; title: string; onDelta: (delta: string) => void }) => Promise<string>;
  /** Plan, and keep the job each codebase would start (`firsts`) - but start none. */
  dryRun?: boolean;
  /**
   * Told each time the loop looks at a codebase whose spec parses: its chain, the spec as the .plain files have it now,
   * and what its code is built from - what the test advisor watches (advisor-runs.ts). Nothing it does is the loop's
   * concern: one that throws is ignored.
   */
  onSpec?: (seen: SeenSpec) => void;
}): WorkLoop {
  const modules = new Map<string, ModuleState>();
  const order: string[] = [];
  const run: JobRunner = options.run ?? defaultRunner;
  const runConformance: JobRunner = options.runConformance ?? defaultConformanceRunner;
  // One tick at a time: each reads the records and the spec, and decides.
  let ticking: Promise<void> = Promise.resolve();

  const tipEntry = (state: ModuleState) => tipOf(state.chain);
  /** Where what the loop decides for a module is recorded: its tip's project, the module and the pulse it is about. */
  const loopPlace = (state: ModuleState, job: string) => {
    const tip = tipEntry(state);
    return { project: projectRootOf(tip.buildDir), module: tip.moduleName, job };
  };
  /** `work` with the codebase's stack chosen - the one it was asked for with - when it has one pinned. */
  const inStack = <T>(state: ModuleState, work: () => T): T => (state.stack !== undefined ? withStack(state.stack.name, work) : work());
  const keyOf = (spec: SpecSnapshot) => serializeTree(codeTree(spec.tree));

  /** What a codebase is built from: its record, or - nothing built - what it starts from, the code of the module it requires. */
  const builtOf = (state: ModuleState): MarshalledPlainSource => {
    const tip = tipEntry(state);
    const record = readRecord(tip.buildDir);
    if (record !== null) return codeTree(record);
    const below = state.chain.find((entry) => entry.moduleName === tip.requires);
    const source = below === undefined ? null : readRecord(below.buildDir);
    return source === null ? {} : codeTree(inheritedRecord(source, below!.moduleName));
  };

  /** Where a codebase's conformance tests are: the module's tests folder. */
  const testsDirOf = (state: ModuleState) => {
    const tip = tipEntry(state);
    return conformanceDirFor(tip.moduleName, modulesRoot(projectDirOf(tip.plainFile)));
  };

  /** What the conformance tests are written for, by their record - nothing, when there is none. */
  const testedOf = (state: ModuleState): MarshalledPlainSource => readRecord(testsDirOf(state)) ?? {};

  /** What the code is built from, as a key: a conformance plan made against other code is made again. */
  const codeKeyOf = (state: ModuleState): string => serializeTree(readRecord(tipEntry(state).buildDir) ?? {});

  /**
   * What the conformance tests are to be written for now: of what the code is built from, the functional specs with
   * scenarios, with the test reqs as the spec has them. `from`: the tests the work starts from - what a running pulse will land, when the work
   * after it is planned ahead - else the tests record as it is. Read from the record alone, a pulse still writing a
   * functional spec's tests would not count them: one whose code is behind the spec would be planned out, its tests
   * taken out again once they landed.
   */
  const conformanceOf = (state: ModuleState, spec: SpecSnapshot, from?: MarshalledPlainSource, narrowed = true): MarshalledPlainSource => {
    const tests = from ?? readRecord(testsDirOf(state));
    const whole = conformanceTarget(readRecord(tipEntry(state).buildDir), tests, spec.tree);
    const target = narrowed ? onlyNamed(state, whole, tests, spec.tree) : whole;
    // No functional spec to test, and none tested: nothing to write - the reqs alone are no conformance job.
    const specsIn = (tree: MarshalledPlainSource | null) =>
      ((tree?.[FUNCTIONAL_REQUIREMENTS] as unknown[] | undefined) ?? []).length + ((tree?.[REQUIRED_FUNCTIONAL_SPECS] as unknown[] | undefined) ?? []).length;
    return specsIn(target) === 0 && specsIn(tests) === 0 ? (tests ?? {}) : target;
  };

  /**
   * Whether a codebase's conformance tests are written: with test reqs to write them by, and code to test. What they are
   * written for is the functional specs with scenarios (conformanceOf): a scenario added, changed or taken out, the
   * functional spec's text changed, regenerated again or taken out - the tests of each are behind, and are written.
   */
  const conformanceWanted = (state: ModuleState, spec: SpecSnapshot): boolean =>
    conformanceTestsOn(tipEntry(state).plainFile) &&
    ((spec.tree[TEST_REQUIREMENTS] as unknown[] | undefined) ?? []).length > 0 && readRecord(tipEntry(state).buildDir) !== null && gapOf(state, spec) === undefined;

  /**
   * The step of adding tests a codebase skipped - its functional specs have scenarios, and it has no test reqs or no
   * conformance testing script for its stack: no conformance pulse of it starts, in the loop or from conform, and it
   * waits on that step until the spec or the scripts change.
   */
  const gapOf = (state: ModuleState, spec: SpecSnapshot) => {
    const tip = tipEntry(state);
    return testingGap({ moduleName: tip.moduleName, plainFile: tip.plainFile, tree: spec.tree, buildDir: tip.buildDir });
  };

  /**
   * The functional specs conform is asked for, as the spec has them now - refused when one is not in the spec, or has no
   * scenarios to test.
   */
  const askedSpecs = (moduleName: string, spec: MarshalledPlainSource, funcIds: string[]): void => {
    const items = (spec[FUNCTIONAL_REQUIREMENTS] as Array<{ id: string }> | undefined) ?? [];
    const unknown = funcIds.filter((funcId) => !items.some((item) => item.id === funcId));
    if (unknown.length > 0) throw new Error(`${moduleName} has no functional spec ${namesOf(moduleName, unknown)}. Nothing was started.`);
    const untested = funcIds.filter((funcId) => !hasScenarios(items.find((item) => item.id === funcId)));
    if (untested.length > 0) {
      throw new Error(
        `${namesOf(moduleName, untested)} ${untested.length === 1 ? "has" : "have"} no scenarios - no test plain file - so there is nothing to test: ` +
          "write the conformance or acceptance scenarios first, with change_plain, and their tests are written once the code is built. Nothing was started.",
      );
    }
  };

  /**
   * Whether a codebase lacks a testing script of this kind that is being written in the background now: it waits for it,
   * rather than fail for want of it, and is looked at again once the run ends.
   */
  const awaitsScript = (state: ModuleState, kind: ScriptKind): boolean => {
    const tip = tipEntry(state);
    const root = projectRootFor(tip.plainFile, tip.buildDir);
    return scriptBeingWritten(root, kind, stackForModule(tip.plainFile)) && findTestScripts(root, tip.plainFile, tip.buildDir)[kind] === undefined;
  };

  /**
   * The base folder a codebase started from, as its status says it. Counting the files still there looks at each, and the
   * status is read often: so it is read again only when the base record or the code record moved - a pulse landed.
   */
  const baseOfState = (state: ModuleState): ModuleStatus["base"] => {
    const dir = tipEntry(state).buildDir;
    const at = [BASE_RECORD_FILE, RECORD_FILE].map((name) => modifiedAt(join(dir, name))).join(":");
    if (state.base?.at !== at) {
      const started = baseOfCodebase(dir);
      state.base = { at, base: started !== undefined ? { folder: started.folder, files: started.files.length } : undefined };
    }
    return state.base.base;
  };

  /**
   * What the conformance tests are to be written for, as conform narrowed it to the functional specs it named: every other
   * functional spec as the tests are written for it now - its tests neither written, changed nor taken out. One whose text
   * or scenarios changed since joins those named: a change to it is work again.
   */
  const onlyNamed = (state: ModuleState, target: MarshalledPlainSource, tests: MarshalledPlainSource | null, tree: MarshalledPlainSource): MarshalledPlainSource => {
    const only = state.conformanceOnly;
    if (only === undefined) return target;
    for (const section of [FUNCTIONAL_REQUIREMENTS, REQUIRED_FUNCTIONAL_SPECS]) {
      for (const item of (tree[section] as Array<{ id?: string; module?: string }> | undefined) ?? []) {
        const key = identityOf(item);
        if (!only.specs.has(key) && only.read.get(key) !== JSON.stringify(item)) only.specs.add(key);
      }
    }
    const narrowed: MarshalledPlainSource = { ...target };
    for (const section of [FUNCTIONAL_REQUIREMENTS, REQUIRED_FUNCTIONAL_SPECS]) {
      const tested = new Map((((tests?.[section] as Array<{ id?: string; module?: string }> | undefined) ?? [])).map((item) => [identityOf(item), item]));
      const wanted = ((target[section] as Array<{ id?: string; module?: string }> | undefined) ?? []).flatMap((item) => {
        if (only.specs.has(identityOf(item))) return [item];
        // Not named: as its tests are written for it now, or - none written - not at all.
        const kept = tested.get(identityOf(item));
        return kept !== undefined ? [kept] : [];
      });
      // Taken out of the target and not named: its tests are kept, as they are.
      const inTarget = new Set(wanted.map(identityOf));
      for (const [key, item] of tested) if (!only.specs.has(key) && !inTarget.has(key)) wanted.push(item);
      if (wanted.length > 0) narrowed[section] = wanted;
      else delete narrowed[section];
    }
    return narrowed;
  };

  /** The functional specs conform named - its own module's func-ids - and every functional spec as it reads now, to tell a change to one after. */
  const namedOnly = (state: ModuleState, funcIds: string[]): NonNullable<ModuleState["conformanceOnly"]> => {
    const tree = chainSpec(state.chain).tree;
    const read = new Map<string, string>();
    for (const section of [FUNCTIONAL_REQUIREMENTS, REQUIRED_FUNCTIONAL_SPECS]) {
      for (const item of (tree[section] as Array<{ id?: string; module?: string }> | undefined) ?? []) read.set(identityOf(item), JSON.stringify(item));
    }
    return { specs: new Set(funcIds.map((id) => identityOf({ id }))), read };
  };

  /** The work of a track, from where it is built from to what it is to be - for the conformance tests, as conform narrowed them unless `narrowed` is false. */
  const workOf = (track: Track, from: MarshalledPlainSource, state: ModuleState, spec: SpecSnapshot, narrowed = true) =>
    track === "code" ? codeWork(from, spec.tree) : changesBetween(serializeTree(from), serializeTree(conformanceOf(state, spec, from, narrowed)));

  /** The codebases brought up in this look: one left behind is never waited for. */
  let looking = new Set<ModuleState>();

  /**
   * The module below this one that it waits for, and why: one with a job running, code left to build, or conformance
   * tests wanted and not yet written and passing - a codebase starts from the code and the conformance tests below it,
   * so they pass before anything is built on them. Conformance tests below that did not pass hold it until they do.
   */
  const waitingOn = (state: ModuleState): { module: string; why: string } | undefined => {
    for (const entry of state.chain.slice(0, -1)) {
      const below = modules.get(entry.buildDir);
      if (below === undefined || (!looking.has(below) && below.running === undefined)) continue;
      const waiting = (why: string) => ({ module: entry.moduleName, why: `waiting for ${entry.moduleName}: ${why}` });
      if (below.running !== undefined) return waiting(below.running.planned.track === "conformance" ? "its conformance tests are being written" : "the code it is built on is not built yet");
      if (below.held !== undefined) return waiting("you halted it - nothing is built on it until it is asked for again");
      const spec = chainSpec(below.chain);
      if (codeWork(builtOf(below), spec.tree).length > 0) return waiting("the code it is built on is not built yet");
      if (below.conformanceHalted !== undefined) return waiting(`its conformance tests did not pass - ${below.conformanceHalted.why}`);
      if (conformanceWanted(below, spec) && workOf("conformance", testedOf(below), below, spec).length > 0) return waiting("its conformance tests are not written yet");
    }
    return undefined;
  };

  /**
   * Steer the running code job when the spec moved on inside what it regenerates: its target moved to the spec as it
   * now is there, its agent told - now, in its turn, or when the step it is at ends - its view in the panel moved too.
   * Whatever else changed is the next job's. True when it was steered: not a third time, unless into a steer still
   * waiting.
   */
  const trySteer = (state: ModuleState, spec: SpecSnapshot, own: SpecChange[], work: SpecChange[]): boolean => {
    const running = state.running;
    const steering = running?.steering;
    if (running === undefined || steering === undefined || running.planned.track !== "code") return false;
    const waiting = waitingSteer(steering) !== undefined;
    if (steering.steers >= MAX_STEERS && !waiting) return false;
    const moved = steer(steering, running.from, own, (tree) => workOf("code", tree, state, spec));
    if (moved === undefined) return false;
    // Steered, everything it regenerates is wanted - else something it regenerates was taken out, and that is no steer.
    if (!stillWanted(changesBetween(serializeTree(running.from), serializeTree(moved.target)), work)) return false;
    const why = whyNotWanted(own, work);
    steering.target = moved.target;
    steering.agent = moved.agent;
    if (!waiting) steering.steers += 1;
    steering.notes.push(why);
    running.after = moved.target;
    const text = waitingSteer(steering);
    if (text !== undefined && steering.deliver?.(text) === true) markTold(steering);
    const tip = tipEntry(state);
    const job = options.registry.get(running.jobId);
    if (job !== undefined) {
      const shown = changeDiffInFiles(
        agentChanges(changesBetween(serializeTree(running.from), serializeTree(steering.agent)), "code"),
        relative(projectDirOf(tip.plainFile), tip.plainFile) || basename(tip.plainFile),
        (diff) => whereInFiles(diff, state.chain),
      );
      options.registry.setDiff(job.id, shown.diff, shown.where);
    }
    reportActivity(`  ⇢ steered pulse ${running.jobId} (${steering.steers} of ${MAX_STEERS}): ${why}`);
    return true;
  };

  /** How the person wants a codebase's work planned: the conversation's and AGENTS.md's steering, then the requests'. */
  const steeringOf = (state: ModuleState): Steering[] => [
    ...(options.steering?.(state.askedFile) ?? []),
    ...state.guidance.map((text) => ({ source: "the request that asked for the work", text })),
  ];
  const steeringKeyOf = (state: ModuleState): string => JSON.stringify(steeringOf(state));

  const plan = async (state: ModuleState, spec: SpecSnapshot, from: MarshalledPlainSource, track: Track = "code"): Promise<{ jobs: PlannedJob[]; notes: string[] }> => {
    const tip = tipEntry(state);
    const current = track === "code" ? codeTree(spec.tree) : conformanceOf(state, spec, from);
    const specFile = relative(options.cwd, tip.plainFile);
    let specText = "";
    try {
      specText = readFileSync(tip.plainFile, "utf8");
    } catch {
      /* the layout is only for how the diffs read */
    }
    const steering = steeringOf(state);
    const separately = track === "conformance" && state.conformanceSeparately === true;
    // How big a pulse may be: the module's config, else the defaults.
    const config = configForSpec(tip.plainFile);
    const limits = { specs: config.maxSpecsPerPulse ?? MAX_SPECS_PER_JOB, lines: config.maxLinesPerPulse ?? MAX_LINES_PER_JOB };
    const testPlainPath = track === "conformance" ? testPlainPathOf(spec.tree, tip.moduleName, tip.plainFile, dirname(specFile)) : undefined;
    // A pure rename is turri's to make before the next pulse, not a delete and an add: the work is planned from the code as renamed.
    const renamed = track === "code" ? pureRenames(from, readRecord(testsDirOf(state)), spec.tree, tip.moduleName) : undefined;
    const base = renamed !== undefined && renamed.renames.length > 0 && renamed.code !== null ? codeTree(renamed.code) : from;
    const input: PlanInput = { base, current, specFile, specText, steering, track, moduleName: tip.moduleName, limits, ...(separately ? { separately } : {}), ...(testPlainPath !== undefined ? { testPlainPath } : {}) };
    const model = typeof options.plannerModel === "function" ? options.plannerModel() : options.plannerModel;
    const agents = options.planner === false ? undefined : (options.planner ?? llmChunkAgents({ cwd: options.cwd, model: model ?? state.model, label: `${basename(tip.plainFile)} planner` }));
    reportStage(`${tip.moduleName}: planning the ${track === "code" ? "work" : "conformance tests"} into pulses`);
    const notes: string[] = [];
    const draft = await planChunks(input, agents, notes);
    const fresh = tip.requires === null && (track === "code" ? !started(tip) : readRecord(testsDirOf(state)) === null);
    const jobs = stepsOf(input, draft).map((job, index) => {
      // Its cases from its own change: the spec before it to the spec after it - the plan's changes are numbered from where the plan starts.
      const cases = casesOf(parseTree(job.step.before), changesBetween(job.step.before, job.step.after), { fresh: fresh && index === 0, module: tip.moduleName });
      return { title: job.title, reason: job.reason, cases, step: job.step, track };
    });
    return { jobs, notes };
  };

  /** Plan a track: while the planner works, the codebase says so rather than showing nothing - or, a job running, the old plan. */
  const planIdle = async (state: ModuleState, spec: SpecSnapshot, from: MarshalledPlainSource, track: Track): Promise<{ jobs: PlannedJob[]; notes: string[] }> => {
    state.planning = track;
    state.planningSince = Date.now();
    // Planning takes a while - the planner is an agent: what shows the work says so at once, not when the first pulse starts.
    options.registry.notify?.();
    try {
      return await plan(state, spec, from, track);
    } finally {
      state.planning = undefined;
      state.planningSince = undefined;
      options.registry.notify?.();
    }
  };

  /** A dry run's first jobs, by codebase: what each would start. */
  const firsts = new Map<string, { spec: SpecSnapshot; planned: PlannedJob }>();

  const startJob = (state: ModuleState, spec: SpecSnapshot, from: MarshalledPlainSource, planned: PlannedJob) => {
    // Halted while it was being planned: the plan is made, nothing starts.
    if (state.held !== undefined) {
      state.why = state.held.why;
      return;
    }
    const tip = tipEntry(state);
    if (options.dryRun === true) {
      firsts.set(tip.buildDir, { spec: planned.track === "conformance" ? spec : { ...spec, tree: planned.step.tree }, planned });
      state.why = `would start: ${planned.title}`;
      return;
    }
    const conformance = planned.track === "conformance";
    // A code job can be steered while it regenerates: its target moves with the spec, inside what it regenerates.
    const steering = conformance ? undefined : createSteering(planned.step.tree, tip.moduleName);
    // Shown as its agent is given it: the job's own items, from whichever file they are written in - its imports too, and
    // for the conformance tests the test plain files of the functional specs whose scenarios it carries out.
    const moduleFile = relative(projectDirOf(tip.plainFile), tip.plainFile) || basename(tip.plainFile);
    const shown = changeDiffInFiles(
      agentChanges(planned.step.changes, planned.track),
      moduleFile,
      (diff) => whereInFiles(diff, state.chain),
      conformance ? { module: tip.moduleName, pathOf: testPlainPathOf(spec.tree, tip.moduleName, tip.plainFile, dirname(moduleFile)) } : undefined,
    );
    const job: Job = options.registry.start({
      kind: conformance ? "conformance" : "regenerate",
      summary: `${basename(tip.plainFile)} ${conformance ? "conformance: " : ""}${planned.title}`,
      module: tip.moduleName,
      // Numbered as regen numbers it: the module's pulses this session, from 1.
      pulse: (state.pulses ?? 0) + 1,
      title: planned.title,
      diff: shown.diff,
      // Its lines where they are written: the module's .plain file, those it imports, and those of the modules below it.
      diffWhere: shown.where,
      // The functional specs it covers, by case - its own module's, and those of modules below it.
      cases: pulseCases(planned.cases, tip.moduleName),
      ...(state.model !== undefined ? { model: state.model } : {}),
      lanes: [...moduleLanes(tip.plainFile)],
      rerun: `turri regenerate ${relative(options.cwd, tip.plainFile) || basename(tip.plainFile)}`,
      run: async (onDelta) => {
        // The guardrail: a conformance job tests only code that is built - the code record, read as the job starts, has every functional spec it tests as it tests it.
        if (conformance) {
          const testing = [...planned.cases.add, ...planned.cases.patch, ...planned.cases.again];
          const missing = notBuilt(readRecord(tip.buildDir), planned.step.tree, testing, tip.moduleName);
          if (missing.length > 0) {
            const record = relative(options.cwd, join(tip.buildDir, RECORD_FILE));
            const notBuiltText = `${refsOf(tip.moduleName, missing)} ${missing.length === 1 ? "is" : "are"} not built`;
            return {
              report:
                `Not started: this conformance pulse is to test ${refsOf(tip.moduleName, testing)}, and ${notBuiltText} - ` +
                `${record} does not have ${missing.length === 1 ? "it" : "them"} as the spec has ${missing.length === 1 ? "it" : "them"}. ` +
                "No conformance test is written for code that is not built. Tell the user, and see with drift which code pulse regenerates it.",
              details: { passed: false, landed: false, notBuilt: notBuiltText },
            };
          }
        }
        // Nothing here yet: the codebase starts as a copy of the one it is built on, recorded as what it inherits.
        if (tip.requires !== null && !started(tip)) {
          const below = state.chain.find((entry) => entry.moduleName === tip.requires);
          const source = below === undefined ? null : readRecord(below.buildDir);
          if (below !== undefined && source !== null) {
            // Its conformance tests come with the code, and what they are written for, as what it inherits.
            copyRequiredCode(below.buildDir, tip.buildDir, tip.moduleName, below.moduleName);
          }
        }
        // Nothing here yet, and nothing below: the codebase starts from its base folder, when the config names one.
        if (tip.requires === null && !started(tip)) inStack(state, () => seedFromBaseFolder(tip.buildDir, tip.plainFile, tip.moduleName));
        // A conformance job is shown the spec whole - its test reqs and scenarios are its to write from.
        const result = await (conformance ? runConformance : run)(
          {
            plainFile: tip.plainFile,
            moduleName: tip.moduleName,
            buildDir: tip.buildDir,
            spec: conformance ? spec : { ...spec, tree: planned.step.tree },
            planned,
            model: state.model,
            cwd: options.cwd,
            ...(steering !== undefined ? { steering } : {}),
          },
          onDelta,
        );
        const report = result.report;
        // Released as its last stage, when the config says so: the module's next pulse starts on what is released.
        let released: string | undefined;
        if (result.landed && options.release !== undefined && configForSpec(tip.plainFile).releaseAfterPulse === true) {
          reportStage(`module ${tip.moduleName}: releasing what this pulse landed (release-after-pulse)`);
          try {
            released = `Released after the pulse: ${(await options.release({ plainFile: tip.plainFile, moduleName: tip.moduleName, title: planned.title, onDelta })).trim()}`;
          } catch (error) {
            // What landed stays landed: a release that fails is said, and the next pulse goes on.
            released = `The release after the pulse failed: ${error instanceof Error ? error.message : String(error)}`;
          }
          reportActivity(`  ${released.split("\n")[0]}`);
        }
        return {
          report: released !== undefined ? `${report}\n\n${released}` : report,
          details: {
            passed: result.landed,
            landed: result.landed,
            ...(released !== undefined ? { released: true } : {}),
            ...(result.story !== undefined ? { story: result.story } : {}),
            // The spec gaps its agents met, for a headless run to say - in the chat the report puts them to the person.
            ...(result.specGaps !== undefined && result.specGaps.length > 0 ? { specGaps: result.specGaps } : {}),
          },
        };
      },
    });
    state.pulses = (state.pulses ?? 0) + 1;
    state.running = { jobId: job.id, number: state.pulses, planned, from, after: planned.step.tree, ...(steering !== undefined ? { steering } : {}) };
    void options.registry.wait(job.id).then(
      (settled) => settle(state, settled),
      () => settle(state, undefined),
    );
  };

  /** A pulse as a halt keeps it: its number, and the trees it went between. */
  // A codebase taken back to nothing, and what the loop held of it - plans, halts - with it: built again from the start.
  const startAgain = (entry: ChainEntry, why: string) => {
    startFromScratch(entry, why);
    const state = modules.get(entry.buildDir);
    if (state === undefined) return;
    state.plan = undefined;
    state.conformancePlan = undefined;
    state.halted = undefined;
    state.conformanceHalted = undefined;
    state.startOver = undefined;
  };
  // A codebase built on a module whose conformance tests the person asked for: disposable - deleted whole, its history with
  // it - and what the loop held of it, so it is regenerated from the start, on the module once its tests pass.
  const discard = (entry: ChainEntry, why: string) => {
    rmSync(dirname(entry.buildDir), { recursive: true, force: true });
    reportActivity(`  ${entry.moduleName}: its codebase is deleted - ${why}`);
    const state = modules.get(entry.buildDir);
    if (state === undefined) return;
    state.plan = undefined;
    state.conformancePlan = undefined;
    state.halted = undefined;
    state.conformanceHalted = undefined;
    state.startOver = undefined;
  };
  const pulseOf = (running: NonNullable<ModuleState["running"]>) => ({ number: running.number, before: serializeTree(running.from), after: serializeTree(running.after) });
  // What went wrong in a pulse that did not land, in a few words: the tests it stopped at, else its error's first line.
  const causeOf = (job: Job | undefined): { cause?: string } => {
    const stoppedAt = (job?.details as { stoppedAt?: unknown } | undefined)?.stoppedAt;
    if (stoppedAt === "unit tests" || stoppedAt === "conformance" || stoppedAt === "regression") {
      return { cause: stoppedAt === "unit tests" ? "its unit tests never passed" : stoppedAt === "conformance" ? "its conformance tests never passed" : "the whole conformance suite never passed" };
    }
    const error = job?.error?.split("\n").find((line) => line.trim() !== "")?.trim();
    return error !== undefined ? { cause: error } : {};
  };

  const settle = (state: ModuleState, settled: Job | undefined) => {
    const running = state.running;
    state.running = undefined;
    const landed = settled?.status === "succeeded" && (settled.details as { landed?: boolean } | undefined)?.landed === true;
    if (running !== undefined && !landed && running.planned.track === "conformance") {
      // Conformance tests that did not pass - nor the code fixes they made - are gone, and they halt: the code goes on.
      resetToLastCommit(tipEntry(state).buildDir);
      state.conformancePlan = undefined;
      if (running.stopping !== true) {
        const unbuilt = (settled?.details as { notBuilt?: string } | undefined)?.notBuilt;
        const why =
          settled?.status === "stopped"
            ? `pulse ${running.jobId} was stopped`
            : unbuilt !== undefined
              ? `conformance pulse ${running.jobId} ("${running.planned.title}") did not start: ${unbuilt}`
              : `conformance pulse ${running.jobId} ("${running.planned.title}") did not pass`;
        state.conformanceHalted = { why: `${why} - its conformance tests are written again once the spec or the code changes, or they are asked for again`, key: conformanceKey(state) };
        // Nothing more is built on code whose conformance tests did not pass: its code halts too, and what is above waits.
        let key = "";
        try {
          key = keyOf(chainSpec(state.chain));
        } catch {
          /* a spec that does not parse halts it all the same */
        }
        state.halted = { why: `${why} - nothing more is built on it until its conformance tests pass`, specKey: key, pulse: pulseOf(running), ...(settled?.status === "stopped" ? {} : causeOf(settled)) };
        record({ kind: "loop.halted", why: firstLine(state.halted.why, 300), track: "conformance" }, loopPlace(state, running.jobId));
      }
    } else if (running !== undefined && !landed) {
      // What it wrote and never committed is gone: code, tests and record agree again.
      resetToLastCommit(tipEntry(state).buildDir);
      state.plan = undefined;
      // Stopped for the conformance tests of a module below: the codebase is deleted, and regenerated from it after.
      if (running.discard !== undefined) discard(tipEntry(state), running.discard);
      if (running.stopping !== true) {
        let key = "";
        try {
          key = keyOf(chainSpec(state.chain));
        } catch {
          /* a spec that does not parse halts it all the same */
        }
        const why = settled?.status === "stopped" ? `pulse ${running.jobId} was stopped` : `pulse ${running.jobId} ("${running.planned.title}") did not land`;
        state.halted = { why: `${why} - it runs again once the spec changes, or the module is asked for again`, specKey: key, pulse: pulseOf(running), ...(settled?.status === "stopped" ? {} : causeOf(settled)) };
        record({ kind: "loop.halted", why: firstLine(state.halted.why, 300), track: "code" }, loopPlace(state, running.jobId));
      }
    } else {
      const own = running?.planned.track === "conformance" ? state.conformancePlan : state.plan;
      if (own !== undefined) {
        own.jobs.shift();
        if (running !== undefined) own.from = serializeTree(running.after);
      }
    }
    // What it did, in the notes every agent after reads - once anything it did not land is rolled back, so the line stays.
    if (running !== undefined) notePulse(state, running, settled, landed);
    void tick();
  };

  /**
   * A pulse's line in the notes, written as it ends: what it regenerated, whether it landed, how it went - the rounds,
   * the test runs, what the debugger found - and where its log is, for whoever wants the whole of it. Committed
   * with it.
   */
  const notePulse = (state: ModuleState, running: NonNullable<ModuleState["running"]>, settled: Job | undefined, landed: boolean) => {
    const tip = tipEntry(state);
    const details = settled?.details as { story?: string; notBuilt?: string } | undefined;
    const outcome = landed
      ? "landed"
      : settled?.status === "stopped" || running.stopping === true
        ? "stopped - rolled back"
        : details?.notBuilt !== undefined
          ? `did not start: ${details.notBuilt}`
          : "did not pass - rolled back";
    const log = settled?.logFile !== undefined ? ` · log ${relative(projectDirOf(tip.plainFile), settled.logFile)}` : "";
    const took = settled !== undefined ? ` · ${formatDuration(settled)}${settled.usage.cost > 0 ? ` · $${settled.usage.cost.toFixed(2)}` : ""}` : "";
    const what = `${running.planned.track === "conformance" ? "conformance tests: " : ""}${running.planned.title}`;
    // A conformance pulse's line is the tests' notes', beside them: the coding agents never read of the black-box tests.
    const notesDir = running.planned.track === "conformance" ? testsDirOf(state) : tip.buildDir;
    recordPulse(notesDir, `${what} - ${outcome}${details?.story !== undefined ? `; ${details.story}` : ""}${took}${log}`, `${tip.moduleName} pulse ${running.number}`);
    commitNotes(notesDir, NOTES_FILE, `pulse ${running.number} ${landed ? "landed" : "rolled back"}: ${what}`, landed ? (settled?.startedAt ?? Date.now()) : undefined);
  };

  /**
   * A record written before linked resources were hashed has the hashes of the files as they are now - committed, with
   * nothing running there - so the code is taken to be built from them, rather than everything linking one built again.
   */
  const hashResources = (state: ModuleState, spec: SpecSnapshot) => {
    // A dry run only reads.
    if (options.dryRun === true) return;
    const code = tipEntry(state).buildDir;
    for (const dir of [code, testsDirOf(state)]) {
      const record = readRecord(dir);
      const hashed = adoptDigests(record, spec.tree);
      if (record === null || hashed === null || serializeTree(hashed) === serializeTree(record)) continue;
      (dir === code ? writeCodeRecord : writeTestsRecord)(dir, hashed);
      recordHistory(dir, "the record's linked resources hashed, as their files are now");
    }
  };

  /** What a conformance halt holds for: the spec and what the code is built from, as they are. */
  const conformanceKey = (state: ModuleState): string => {
    try {
      return `${serializeTree(chainSpec(state.chain).tree)}\n${serializeTree(readRecord(tipEntry(state).buildDir) ?? {})}`;
    } catch {
      return "";
    }
  };

  /** Look at every codebase once, bottom of each chain first, and start what can start. */
  const tick = (): Promise<void> => {
    ticking = ticking
      .then(() => withParseCache(() => lookAll()))
      .catch((error: unknown) => reportActivity(`  the work loop: ${error instanceof Error ? error.message : String(error)}`));
    return ticking;
  };
  // A testing script written in the background, or not: what waited for it is looked at again - started, or failed for want of it.
  onScriptRunEnded(() => {
    if (asked.size > 0 && options.dryRun !== true) void tick();
  });

  /** The files asked for, each with how: what the loop brings up, worked out again each look. */
  const asked = new Map<string, { model?: string; guidance?: string }>();

  /**
   * The modules asked for whose plan is not made yet - their code being deleted, what is left being worked out, the
   * planner not started - by name, with since when: each shows as being planned from the moment it is asked for, not
   * only once the planner runs, so the person never looks at nothing.
   */
  const preparing = new Map<string, { since: number; plainFile: string }>();
  const preparingFor = async <T>(plainFile: string, work: () => Promise<T>): Promise<T> => {
    const name = basename(plainFile).replace(/\.plain$/, "");
    if (preparing.has(name)) return work();
    preparing.set(name, { since: Date.now(), plainFile: resolve(options.cwd, plainFile) });
    options.registry.notify?.();
    // A frame to draw it in before what follows: deleting a codebase and committing it hold the event loop.
    await new Promise((resolve) => setTimeout(resolve, 20));
    try {
      return await work();
    } finally {
      preparing.delete(name);
      options.registry.notify?.();
    }
  };

  /** The codebases the requests bring up now - where each module's code lives, and what is to be built on it. */
  const active = (): Set<ModuleState> => {
    const states = new Set<ModuleState>();
    for (const [file, request] of asked) {
      let chains: ChainEntry[][];
      try {
        chains = chainsFor(file);
      } catch {
        continue;
      }
      for (const chain of chains) for (const entry of toBuild(chain)) states.add(track(chain.slice(0, chain.indexOf(entry) + 1), file, request));
    }
    return states;
  };

  /** A codebase the loop no longer looks after: nothing of it is shown, planned or waited for. */
  const forget = (state: ModuleState) => {
    const key = tipEntry(state).buildDir;
    modules.delete(key);
    order.splice(order.indexOf(key), 1);
  };

  const lookAll = async () => {
    // A .plain file taken out of the project is asked for no more, and a codebase whose module's file is gone is
    // forgotten - nothing running there - rather than shown waiting for a plan it will never have.
    for (const file of [...asked.keys()]) if (!existsSync(file)) asked.delete(file);
    for (const key of [...order]) {
      const state = modules.get(key)!;
      if (state.running === undefined && !existsSync(tipEntry(state).plainFile)) forget(state);
    }
    const now = active();
    looking = now;
    // Why each codebase stands as it does, before this look: one that changed is told, as a plan that changed is - a
    // module that starts or stops waiting moves no job, and would otherwise go unseen until something else did.
    const whyBefore = new Map([...modules.values()].map((state) => [state, state.why]));
    try {
      for (const key of order) {
        const state = modules.get(key)!;
        // A codebase left behind - built on since - is not looked at, unless a job of it is still running; what it had
        // planned, or waited for, is no longer shown.
        if (now.has(state) || state.running !== undefined) await inStack(state, () => look(state));
        else {
          state.why = "left behind: the code is built on further up the chain, where changes to it are made";
          state.waitsFor = undefined;
          state.plan = undefined;
          state.conformancePlan = undefined;
        }
      }
    } finally {
      if ([...modules.values()].some((state) => state.why !== whyBefore.get(state))) options.registry.notify?.();
    }
  };

  const look = async (state: ModuleState) => {
    const tip = tipEntry(state);
    let spec: SpecSnapshot;
    try {
      spec = chainSpec(state.chain);
    } catch (error) {
      state.why = `its spec does not parse: ${error instanceof Error ? error.message : String(error)}`;
      // Not planned from a spec that does not parse: what it waited for, and the plan, were the spec's before.
      state.waitsFor = undefined;
      if (state.running === undefined) {
        state.plan = undefined;
        state.conformancePlan = undefined;
      }
      return;
    }
    const specKey = keyOf(spec);
    state.seen = spec;
    if (options.onSpec !== undefined) {
      try {
        options.onSpec({ chain: state.chain, tree: spec.tree, built: builtOf(state) });
      } catch {
        /* what watches the spec never stops the loop */
      }
    }

    if (state.running !== undefined) {
      if (state.running.stopping === true) return;
      // The stop rule: every change the running job makes is still part of the work, measured from the same record.
      const track = state.running.planned.track;
      const own = changesBetween(serializeTree(state.running.from), serializeTree(state.running.after));
      let work = workOf(track, state.running.from, state, spec);
      // A change inside what it regenerates steers it, rather than stopping it or leaving it to the next job.
      if (!stillWanted(own, work) && trySteer(state, spec, own, work)) work = workOf(track, state.running.from, state, spec);
      const ownNow = changesBetween(serializeTree(state.running.from), serializeTree(state.running.after));
      if (!stillWanted(ownNow, work)) {
        const why = whyNotWanted(ownNow, work);
        // The project may have it run to its end instead: what it lands, the next job regenerates the change on top of.
        if (configForSpec(tip.plainFile).allowToStopJobs === false) {
          if (state.running.keptDespite !== why) {
            state.running.keptDespite = why;
            reportActivity(`  ${tip.moduleName}: pulse ${state.running.jobId} runs on although ${why} - allow-to-stop-jobs is false: the change is regenerated on top of what it lands`);
          }
        } else {
          state.running.stopping = true;
          state.why = `pulse ${state.running.jobId} was stopped: ${why}, which it was regenerating from`;
          record({ kind: "loop.stopped", why: firstLine(why, 300) }, loopPlace(state, state.running.jobId));
          reportActivity(`  ${tip.moduleName}: ${state.why}`);
          options.registry.stop(
            state.running.jobId,
            `Stopped by turri, not by you: ${why}, which it was regenerating from. What it had done is rolled back, and the spec as it is now is regenerated instead. To have a running pulse finish first and the change regenerated on top of it, set allow-to-stop-jobs: false in config.turri.yaml.`,
          );
          return;
        }
      }
      // Still wanted: what comes after it is planned now, from what it will land - not once it has. The steering
      // changed, the code's is planned again too: what is not running yet follows it.
      const planOf = track === "code" ? state.plan : state.conformancePlan;
      const steeringKey = steeringKeyOf(state);
      if (planOf === undefined || planOf.specKey !== specKey || (track === "code" && state.plan?.steeringKey !== steeringKey)) {
        const running = state.running;
        // Shown as being planned on the regeneration; the status goes on showing the running job.
        const rest = workOf(track, running.after, state, spec).length === 0 ? { jobs: [], notes: [] } : await planIdle(state, spec, running.after, track);
        const next = { specKey, from: serializeTree(running.from), jobs: [running.planned, ...rest.jobs] };
        if (state.running === running) {
          if (track === "code") state.plan = { ...next, steeringKey, notes: rest.notes };
          else state.conformancePlan = { ...next, codeKey: codeKeyOf(state) };
        }
      }
      return;
    }
    hashResources(state, spec);
    if (state.held !== undefined) {
      state.why = state.held.why;
      state.waitsFor = undefined;
      return;
    }
    if (state.halted !== undefined) {
      if (state.halted.specKey === specKey) {
        state.why = state.halted.why;
        return;
      }
      state.halted = undefined;
    }
    state.startOver = undefined;
    // Built when functional specs were numbered, before func-ids: nothing is built on it - its chain starts over.
    const old = oldCodebases(state.chain);
    if (old.length > 0) {
      state.startOver = { requires: [], codebases: old.map((entry) => entry.moduleName), old: true };
      state.why = OLD_RECORDS_WHY(old.map((entry) => entry.moduleName));
      return;
    }
    const fresh = newlyRequired(state.chain);
    if (fresh !== undefined && fresh.rebuild.some((entry) => entry.buildDir === tip.buildDir)) {
      const codebases = fresh.rebuild.map((entry) => entry.moduleName);
      state.startOver = { requires: fresh.modules, codebases };
      state.why =
        `it now requires ${fresh.modules.join(", ")}, which its code was not built on: it is built only once ` +
        `${codebases.join(", ")} ${codebases.length === 1 ? "is" : "are"} started over - code and conformance tests taken out, kept in the history, and built again on ${fresh.modules.join(", ")}`;
      return;
    }
    const below = waitingOn(state);
    state.waitsFor = below?.module;
    if (below !== undefined) {
      state.why = below.why;
      return;
    }
    // A func-id or a scenario-id renamed, and nothing else with it: turri renames it in the records and relabels the tests
    // itself, as one unit of work - no pulse, the code untouched. Failing, it is rolled back whole, and the codebase halts
    // rather than build the functional spec anew.
    const renamed = options.dryRun === true || readRecord(tip.buildDir) === null ? undefined : pureRenames(readRecord(tip.buildDir), readRecord(testsDirOf(state)), spec.tree, tip.moduleName);
    if (renamed !== undefined && renamed.renames.length > 0) {
      const made = makeRenames({ buildDir: tip.buildDir, testsDir: testsDirOf(state), moduleName: tip.moduleName, renamed, place: { project: projectRootOf(tip.buildDir), module: tip.moduleName } });
      if (!made) {
        state.halted = { why: `renaming ${renamed.renames.map(renameText).join(", ")} failed, and was rolled back - it is tried again once the spec changes, or the module is asked for again`, specKey };
        state.why = state.halted.why;
        record({ kind: "loop.halted", why: firstLine(state.halted.why, 300), track: "code" }, { project: projectRootOf(tip.buildDir), module: tip.moduleName });
        return;
      }
    }
    // The module's code first, every job of it; then its conformance tests - once, for the module as built, with one
    // explorer and one run of the whole suite - and only then is anything built on it (waitingOn).
    const from = builtOf(state);
    const codeLeft = codeWork(from, spec.tree).length > 0;
    if (state.conformanceHalted !== undefined && state.conformanceHalted.key !== conformanceKey(state)) state.conformanceHalted = undefined;
    if (!codeLeft && conformanceWanted(state, spec) && state.conformanceHalted === undefined) {
      const tested = testedOf(state);
      if (workOf("conformance", tested, state, spec).length > 0) {
        const testedKey = serializeTree(tested);
        const existing = state.conformancePlan;
        // Made again when the spec, the tests or the code it was planned against moved: what the tests are written for
        // follows the code, and a plan made before a code pulse landed would test it as it was.
        if (existing === undefined || existing.specKey !== specKey || existing.from !== testedKey || existing.codeKey !== codeKeyOf(state) || existing.jobs.length === 0) {
          state.conformancePlan = { specKey, from: testedKey, codeKey: codeKeyOf(state), jobs: (await planIdle(state, spec, tested, "conformance")).jobs };
        }
        const next = state.conformancePlan!.jobs[0];
        if (next !== undefined) {
          state.why = undefined;
          startJob(state, spec, tested, next);
          return;
        }
      } else {
        state.conformancePlan = undefined;
      }
    }
    if (!codeLeft) {
      state.plan = undefined;
      // Its scenarios untested for a step of adding tests it skipped: no conformance pulse starts - it waits on that step.
      const gap = state.conformanceHalted === undefined && readRecord(tip.buildDir) !== null ? gapOf(state, spec) : undefined;
      state.why =
        state.conformanceHalted?.why ??
        (gap === undefined
          ? UP_TO_DATE
          : gap.step === "conformance testing script" && awaitsScript(state, "conformance")
            ? SCRIPT_BEING_WRITTEN("conformance testing script")
            : `waiting for its ${gap.step}: ${gap.text}`);
      return;
    }
    const fromKey = serializeTree(from);
    const steeringKey = steeringKeyOf(state);
    if (state.plan === undefined || state.plan.specKey !== specKey || state.plan.from !== fromKey || state.plan.steeringKey !== steeringKey || state.plan.jobs.length === 0) {
      const { jobs, notes } = await planIdle(state, spec, from, "code");
      state.plan = { specKey, from: fromKey, steeringKey, jobs, notes };
      if (jobs.length === 0) {
        state.why = NO_PLAN;
        return;
      }
    }
    if (awaitsScript(state, "unit")) {
      state.why = SCRIPT_BEING_WRITTEN("unit testing script");
      return;
    }
    state.why = undefined;
    startJob(state, spec, from, state.plan.jobs[0]!);
  };

  const statusOf = (state: ModuleState): ModuleStatus => describe(state).status;

  /** The modules asked for that the loop holds nothing of yet - turri just opened, say: their code being planned all the same. */
  const preparingAlone = (): Array<ModuleStatus & { since: number }> => {
    const held = new Set(order.map((key) => tipEntry(modules.get(key)!).moduleName));
    return [...preparing]
      .filter(([name]) => !held.has(name))
      .map(([name, { since, plainFile }]) => ({
        module: name,
        plainFile,
        planned: [{ title: "the work", cases: { fresh: false, add: [], patch: [], again: [], delete: [], mechanical: false }, track: "code" as const, planning: true as const }],
        since,
      }));
  };

  /** A codebase's status, and beside each job it lists as planned, the planned job it is - none for one being planned or scheduled. */
  const describe = (state: ModuleState): ReturnType<typeof describeIn> => inStack(state, () => describeIn(state));
  const describeIn = (state: ModuleState): { status: ModuleStatus; jobs: Array<PlannedJob | undefined>; ahead: Array<{ title: string; specs: string[] } | undefined> } => {
    // What runs next: the code's jobs, then the conformance tests' - the module's, once its code is built - the running job first.
    const running = state.running?.planned;
    const own = (jobs: PlannedJob[] | undefined) => (jobs ?? []).filter((job) => job !== running);
    // A track being planned again shows as that, not as its plan before - and a module asked for, from that moment, as
    // its code being planned: its code deleted, what is left worked out, before the planner runs.
    const planningTrack = state.running === undefined ? (state.planning ?? (preparing.has(tipEntry(state).moduleName) ? "code" : undefined)) : undefined;
    const replanning = planningTrack;
    const jobs = [
      ...(running !== undefined ? [running] : []),
      ...(replanning === "code" ? [] : own(state.plan?.jobs)),
      ...(replanning === "conformance" ? [] : own(state.conformancePlan?.jobs)),
    ];
    const lastCode = jobs.findLastIndex((job) => job.track === "code");
    const planningNow: ModuleStatus["planned"] =
      planningTrack !== undefined
        ? [
            {
              title: planningTrack === "conformance" ? "the conformance tests" : "the work",
              cases: { fresh: false, add: [], patch: [], again: [], delete: [], mechanical: false },
              track: planningTrack,
              planning: true,
            },
          ]
        : [];
    // The conformance tests that follow the code still to build - of its functional specs with scenarios whose tests
    // are not written for them as they read now: planned once the code is built, shown now.
    const codeToBuild = lastCode !== -1 || planningTrack === "code";
    const seen = state.seen?.tree;
    // Not with a step of adding tests skipped: they are not planned until it is taken.
    const testReqs =
      ((seen?.[TEST_REQUIREMENTS] as unknown[] | undefined) ?? []).length > 0 &&
      codeToBuild &&
      testingGap({ moduleName: tipEntry(state).moduleName, plainFile: tipEntry(state).plainFile, tree: seen!, buildDir: tipEntry(state).buildDir }) === undefined;
    // Those of the modules below too: the tip's suite holds the chain's.
    const tested = testedOf(state);
    const sections = [REQUIRED_FUNCTIONAL_SPECS, FUNCTIONAL_REQUIREMENTS];
    const written = new Set(sections.flatMap((section) => ((tested[section] as unknown[] | undefined) ?? []).map((item) => JSON.stringify(item))));
    const behind = sections.flatMap((section) => ((seen?.[section] as Array<{ id: string; module?: string }> | undefined) ?? []).filter((item) => hasScenarios(item) && !written.has(JSON.stringify(item))));
    const afterCode: ModuleStatus["planned"] =
      codeToBuild && testReqs && behind.length > 0 && state.conformanceHalted === undefined && !jobs.some((job) => job.track === "conformance")
        ? [{ title: "conformance tests", cases: { fresh: false, add: [], patch: [], again: [], delete: [], mechanical: false }, track: "conformance", afterCode: true, specs: behind.map((item) => `${item.module ?? tipEntry(state).moduleName}:${item.id}`) }]
        : [];
    const listed: Array<{ entry: ModuleStatus["planned"][number]; job?: PlannedJob }> = [
      ...planningNow.map((entry) => ({ entry })),
      ...jobs.map((job) => ({ entry: { title: job.title, cases: job.cases, track: job.track }, job })),
      ...afterCode.map((entry) => ({ entry })),
    ];
    const planned = listed.map((item) => item.entry);
    const tip = tipEntry(state);
    // While a pulse runs, the renames made once it ends: shown as renames, never as a functional spec taken out and one added.
    const renames = state.running !== undefined && state.running.planned.track === "code" && seen !== undefined ? pureRenames(readRecord(tip.buildDir), readRecord(testsDirOf(state)), seen, tip.moduleName).renames : [];
    const base = baseOfState(state);
    const status: ModuleStatus = {
      module: tip.moduleName,
      plainFile: tip.plainFile,
      ...(base !== undefined ? { base } : {}),
      ...(renames.length > 0 ? { renames: renames.map(renameText) } : {}),
      ...(state.stack?.name !== undefined ? { stack: state.stack.name } : {}),
      ...(state.running !== undefined
        ? {
            running: {
              jobId: state.running.jobId,
              title: state.running.planned.title,
              ...(state.running.steering !== undefined && state.running.steering.steers > 0 ? { steered: [...state.running.steering.notes] } : {}),
            },
          }
        : {}),
      planned: state.running !== undefined ? planned.slice(1) : planned,
      ...(replanning !== "code" && (state.plan?.notes.length ?? 0) > 0 ? { planNotes: [...state.plan!.notes] } : {}),
      ...(state.running === undefined && state.why !== undefined ? { why: state.why } : {}),
      ...(state.running === undefined && state.startOver !== undefined ? { startOver: state.startOver } : {}),
    };
    const shown = state.running !== undefined ? listed.slice(1) : listed;
    return { status, jobs: shown.map((item) => item.job), ahead: shown.map((item) => (item.entry.afterCode === true ? { title: item.entry.title, specs: item.entry.specs ?? [] } : undefined)) };
  };

  /**
   * Look after a codebase - its chain up to it - from now on; says its state. `pin`: its stack is worked out again - its
   * tip's (`stackForModule`) - unless `keep`, and it has one: a spec change keeps the stack it was asked for with.
   */
  const track = (chain: ChainEntry[], askedFile: string, request: { model?: string; guidance?: string }, pin?: { keep?: boolean }): ModuleState => {
    const tip = tipOf(chain);
    let state = modules.get(tip.buildDir);
    if (state === undefined) {
      state = { chain, askedFile, guidance: [] };
      modules.set(tip.buildDir, state);
      // Bottom of the chain first: a codebase is looked at after those it is built on.
      const at = order.findIndex((key) => modules.get(key)!.chain.some((entry) => entry.buildDir === tip.buildDir));
      if (at === -1) order.push(tip.buildDir);
      else order.splice(at, 0, tip.buildDir);
    }
    state.chain = chain;
    state.askedFile = askedFile;
    // Kept only when it is a stack: a module pinned to none - built before its stack's file was there - takes its own.
    const keep = pin?.keep === true && !stackPinned() && state.stack?.name !== undefined;
    if (pin !== undefined && !keep) state.stack = { name: stackForModule(tip.plainFile) };
    // Its model as its stack has it: a stack's file can name a coding model of its own.
    const model = request.model ?? inStack(state, () => options.modelFor?.(tip.plainFile));
    if (model !== undefined) state.model = model;
    if (request.guidance !== undefined && !state.guidance.includes(request.guidance)) state.guidance.push(request.guidance);
    return state;
  };

  const loop: WorkLoop = {
    async bringUp(plainFile, given = {}) {
      const now = async () => {
        const { specChange, ...request } = given;
        const files = codebasesOf(resolve(options.cwd, plainFile));
        for (const file of files) asked.set(file, { ...asked.get(file), ...request });
        // Asked for, it is built with its stack - the one the call names, its own, or the one chosen now - pinned, whatever
        // is chosen later; a spec change keeps the one it was asked for with.
        const pin = { keep: specChange === true };
        const states = withParseCache(() =>
          files.flatMap((file) => chainsFor(file).flatMap((chain) => toBuild(chain).map((entry) => track(chain.slice(0, chain.indexOf(entry) + 1), file, request, pin)))),
        );
        // Asked again, a halted codebase is tried again - one the person halted too, unless only its spec changed.
        for (const state of states) {
          state.halted = undefined;
          if (specChange !== true) state.held = undefined;
          // Asked for again: its conformance tests are written for every functional spec with scenarios, not only those conform named.
          if (specChange !== true) state.conformanceOnly = undefined;
        }
        await tick();
        return [...new Set(states)].map(statusOf);
      };
      // Asked for, it shows as being planned at once; a spec change is looked at quietly, as every change is.
      return given.specChange === true ? now() : preparingFor(plainFile, now);
    },
    async regenerateAgain(plainFile, given, request = {}) {
      return preparingFor(plainFile, async () => {
        const asked = resolve(options.cwd, plainFile);
        const own = resolveRequiresChain(asked, [], undefined, { allowNoFunctionalities: true });
        const module = tipOf(own).moduleName;
        const funcIds = funcIdsNamed(module, [...new Set(Array.isArray(given) ? given : [given])]);
        const chains = chainsFor(asked);
        for (const chain of chains) {
          const tip = tipOf(chain);
          if (modules.get(tip.buildDir)?.running !== undefined) throw new Error(`${tip.moduleName} has a pulse running: ask again once it is done.`);
        }
        const found = new Set<string>();
        for (const chain of chains) {
          const tip = tipOf(chain);
          const record = readRecord(tip.buildDir);
          if (record === null) continue;
          const section = tip.moduleName === module ? FUNCTIONAL_REQUIREMENTS : REQUIRED_FUNCTIONAL_SPECS;
          const items = (record[section] as Array<{ module?: string; id?: string }> | undefined) ?? [];
          const named = (item: { module?: string; id?: string }) => (section === FUNCTIONAL_REQUIREMENTS || item.module === module ? (item.id ?? "") : "");
          const taken = items.flatMap((item) => (funcIds.includes(named(item)) ? [named(item)] : []));
          if (taken.length === 0) continue;
          for (const funcId of taken) found.add(funcId);
          const marked = items.map((item) => (funcIds.includes(named(item)) ? { ...item, [REGENERATE_AGAIN]: true } : item));
          writeCodeRecord(tip.buildDir, { ...record, [section]: marked } as MarshalledPlainSource);
          // Its conformance tests were written against the code being replaced: marked with it, in the tests record of the
          // same codebase - the tip's suite holds the chain's - they are written again, checked against the new code, and
          // rewritten where they relied on what the old code chose, once it lands.
          const testsDir = conformanceDirFor(tip.moduleName, modulesRoot(projectDirOf(tip.plainFile)));
          const tests = readRecord(testsDir);
          const tested = (tests?.[section] as Array<{ module?: string; id?: string }> | undefined) ?? [];
          if (tested.some((item) => taken.includes(named(item)))) {
            const again = tested.map((item) => (taken.includes(named(item)) ? { ...item, [REGENERATE_AGAIN]: true } : item));
            writeTestsRecord(testsDir, { ...tests, [section]: again } as MarshalledPlainSource);
          }
          recordHistory(tip.buildDir, `${namesOf(module, taken)} to regenerate again`);
        }
        const missing = funcIds.filter((funcId) => !found.has(funcId));
        if (found.size === 0) throw new Error(`${namesOf(module, missing)} ${missing.length === 1 ? "is" : "are"} not built anywhere, so there is nothing to regenerate again: regenerate builds what is not built.`);
        const statuses = await loop.bringUp(plainFile, request);
        if (missing.length > 0) reportActivity(`  ${namesOf(module, missing)} ${missing.length === 1 ? "is" : "are"} not built anywhere - nothing to regenerate again there`);
        return statuses;
      });
    },
    drift(plainFile) {
      const file = resolve(options.cwd, plainFile);
      return withParseCache(() =>
        chainsFor(file).flatMap((chain) =>
          toBuild(chain).map((entry): DriftReport => {
            const codebase = chain.slice(0, chain.indexOf(entry) + 1);
            const tip = tipOf(codebase);
            // The codebase as the loop knows it, or - never asked for - as its records have it.
            const state = modules.get(tip.buildDir) ?? { chain: codebase, askedFile: file, guidance: [] };
            return inStack(state, (): DriftReport => {
              const report: DriftReport = { module: tip.moduleName, plainFile: tip.plainFile, code: undefined, conformance: undefined, ...(conformanceTestsOn(tip.plainFile) ? {} : { conformanceOff: true as const }) };
              let spec: SpecSnapshot;
              try {
                spec = chainSpec(codebase);
              } catch (error) {
                return { ...report, why: `its spec does not parse: ${error instanceof Error ? error.message : String(error)}` };
              }
              // A pure rename is no work: shown as one, and the work worked out as though it were made.
              const record = readRecord(tip.buildDir);
              const renamed = record === null ? undefined : pureRenames(record, readRecord(testsDirOf(state)), spec.tree, tip.moduleName);
              if (renamed !== undefined && renamed.renames.length > 0) report.renames = renamed.renames.map(renameText);
              const from = renamed?.code !== undefined && renamed.code !== null ? codeTree(renamed.code) : builtOf(state);
              const fresh = tip.requires === null && !started(tip);
              // A codebase that requires nothing starts from its base folder: one changed since, or missing, is said.
              const base = tip.requires === null ? baseFolderDrift(tip.buildDir, tip.plainFile) : undefined;
              if (base !== undefined) report.baseFolder = base;
              const code = codeWork(from, spec.tree);
              report.code = code.length === 0 ? null : casesOf(from, code, { fresh, module: tip.moduleName });
              if (conformanceWanted(state, spec)) {
                const tested = renamed?.tests ?? testedOf(state);
                // Against the code record as renamed, when a rename is to be made: the tests follow it.
                const tests =
                  renamed !== undefined && renamed.renames.length > 0
                    ? changesBetween(serializeTree(tested), serializeTree(conformanceTarget(renamed.code, tested, spec.tree)))
                    : workOf("conformance", tested, state, spec, false);
                report.conformance = tests.length === 0 ? null : casesOf(tested, tests, { module: tip.moduleName });
                // Narrowed by conform to the functional specs it named: the others wait, and why is said.
                const only = state.conformanceOnly;
                if (only !== undefined && tests.length > 0) report.conformanceOnly = [...only.specs].map((key) => (key.startsWith(":") ? `${tip.moduleName}${key}` : key));
              }
              if (state.running !== undefined) report.running = { jobId: state.running.jobId, title: state.running.planned.title };
              const halted = state.held?.why ?? state.halted?.why ?? state.conformanceHalted?.why;
              if (halted !== undefined) report.why = halted;
              else {
                // Its scenarios untested for a step of adding tests it skipped: said, as the loop says it.
                const gap = gapOf(state, spec);
                if (gap !== undefined) report.why = `waiting for its ${gap.step}: ${gap.text}`;
              }
              if (state.startOver !== undefined) report.startOver = state.startOver;
              const old = oldCodebases(codebase);
              if (old.length > 0) report.startOver = { requires: [], codebases: old.map((entry) => entry.moduleName), old: true };
              return report;
            });
          }),
        ),
      );
    },
    async conformance(plainFile, request = {}) {
      const file = resolve(options.cwd, plainFile);
      asked.set(file, { ...asked.get(file), ...(request.model !== undefined ? { model: request.model } : {}) });
      const own = resolveRequiresChain(file, [], undefined, { allowNoFunctionalities: true });
      const self = tipOf(own);
      // What the person asks for comes first. Its tests are written in its own codebase, before anything is built on it:
      // a codebase built on it - by a module above - is disposable, and is deleted, a pulse running there stopped first;
      // the module above is regenerated from it once they pass. Only when there are tests to write: asked again for tests
      // it has, nothing is touched.
      if (!conformanceTestsOn(self.plainFile)) {
        throw new Error(
          `Conformance tests are off for ${self.moduleName} (conformance-tests: false, or unset): nothing is conformance tested. ` +
            "They are turned on in the chat - by asking for them - or with conformance-tests: true in config.turri.yaml. Nothing was started.",
        );
      }
      const named = request.funcIds === undefined ? undefined : funcIdsNamed(self.moduleName, [...new Set(request.funcIds)]);
      const ownSpec = chainSpec(own).tree;
      const withScenarios = testedFuncIds(ownSpec);
      // Refused before anything is touched: nothing to test, a functional spec not there, or one with no scenarios.
      if (withScenarios.length === 0) {
        throw new Error(
          `No functional spec of ${self.moduleName} has scenarios - none has a test plain file - so there is nothing to test: ` +
            "write the conformance or acceptance scenarios first, with change_plain, and their tests are written once the code is built. Nothing was started.",
        );
      }
      if (named !== undefined && named.length > 0) askedSpecs(self.moduleName, ownSpec, named);
      // A step of adding tests skipped - its test reqs, or the conformance testing script for its stack: refused, naming it.
      const gap = testingGap({ moduleName: self.moduleName, plainFile: self.plainFile, tree: ownSpec, buildDir: self.buildDir });
      if (gap !== undefined) throw new Error(`${gap.text} Nothing was started.`);
      const tested = new Set(((readRecord(conformanceDirFor(self.moduleName, modulesRoot(projectDirOf(self.plainFile))))?.[FUNCTIONAL_REQUIREMENTS] as Array<{ id?: string }> | undefined) ?? []).map((item) => item.id));
      const toWrite = (named !== undefined && named.length > 0 ? named : withScenarios).some((funcId) => !tested.has(funcId));
      let wentBack = false;
      if (readRecord(self.buildDir) !== null && toWrite) {
        const why = `${self.moduleName}'s conformance tests were asked for, and they come before anything is built on it`;
        for (const chain of builtTips(file)) {
          const above = chain.slice(chain.findIndex((entry) => entry.buildDir === self.buildDir) + 1);
          if (above.length === 0) continue;
          wentBack = true;
          for (const entry of above) {
            const running = modules.get(entry.buildDir)?.running;
            if (running === undefined) {
              if (started(entry)) discard(entry, why);
              continue;
            }
            if (running.stopping === true && running.discard !== undefined) continue;
            running.stopping = true;
            running.discard = why;
            reportActivity(`  ${entry.moduleName}: pulse ${running.jobId} is stopped and its codebase deleted - ${why}`);
            options.registry.stop(
              running.jobId,
              `Stopped because you asked for ${self.moduleName}'s conformance tests: they come before anything is built on it. ` +
                `${entry.moduleName}'s codebase is deleted, and it is regenerated from ${self.moduleName} once they pass.`,
            );
          }
        }
      }
      const tracked = withParseCache(() =>
        (wentBack ? [own] : chainsFor(file)).flatMap((chain) => toBuild(chain).map((entry) => track(chain.slice(0, chain.indexOf(entry) + 1), file, request, {}))),
      );
      // The module asked for, in its own codebase - and those below it: never the codebases built on it.
      const asking = tracked.find((state) => tipEntry(state).buildDir === self.buildDir);
      const states = asking !== undefined ? tracked.filter((state) => own.some((entry) => entry.buildDir === tipEntry(state).buildDir)) : tracked;
      const tip = asking ?? states.at(-1);
      const asks = named !== undefined && named.length > 0 ? named : undefined;
      // Its tests are written already, and a codebase built on it holds its code: nothing to write, nothing touched.
      if (asking === undefined && asks !== undefined && tip !== undefined) {
        throw new Error(`${self.moduleName}'s conformance tests for ${namesOf(self.moduleName, asks)} are written already. Nothing was started.`);
      }
      // Only the module asked for: one job for all of its tests, or one a functional spec, as this request asks; a halt cleared.
      for (const state of tip !== undefined ? [tip] : []) {
        const separately = request.separately === true;
        if ((state.conformanceSeparately === true) !== separately) state.conformancePlan = undefined;
        state.conformanceSeparately = separately;
        // Named: their tests alone - the others left as they are until the module is asked for again, or conform names none.
        state.conformanceOnly = asks !== undefined ? namedOnly(state, asks) : undefined;
        state.conformancePlan = undefined;
        state.conformanceHalted = undefined;
        state.halted = undefined;
        state.held = undefined;
      }
      await tick();
      return [...new Set(states)].map((state) => {
        const status = statusOf(state);
        const writing = status.running !== undefined || status.planned.some((job) => job.track === "conformance");
        if (state !== tip || writing) return status;
        return {
          ...status,
          conformanceNote:
            asks !== undefined
              ? `the conformance tests of ${namesOf(status.module, asks)} are written for ${asks.length === 1 ? "it" : "them"} as built: there is nothing to write`
              : `the conformance tests of ${status.module} are written for every functional spec with scenarios, as built: there is nothing to write`,
        };
      });
    },
    async startOver(plainFile, request = {}) {
      const file = resolve(options.cwd, plainFile);
      const own = resolveRequiresChain(file, [], undefined, { allowNoFunctionalities: true });
      const rebuild = new Map<string, { entry: ChainEntry; requires: string[] }>();
      for (const chain of [...chainsFor(file), own]) {
        const fresh = newlyRequired(chain);
        for (const entry of fresh?.rebuild ?? []) rebuild.set(entry.buildDir, { entry, requires: fresh!.modules });
      }
      if (rebuild.size === 0) {
        // Built when functional specs were numbered: the whole chain is regenerated from scratch.
        if ([...chainsFor(file), own].some((chain) => oldCodebases(chain).length > 0)) return loop.fromScratch(plainFile, { ...request, chain: true });
        throw new Error(`Nothing of ${tipOf(own).moduleName} has to be started over: its code is built on every module it requires.`);
      }
      for (const { entry } of rebuild.values()) {
        if (modules.get(entry.buildDir)?.running !== undefined) throw new Error(`${entry.moduleName} has a pulse running: ask again once it is done.`);
      }
      for (const { entry, requires } of rebuild.values()) startAgain(entry, `it now requires ${requires.join(", ")}, which its code was not built on`);
      return loop.bringUp(plainFile, request);
    },
    async fromScratch(plainFile, { chain, ...request } = {}) {
      return preparingFor(plainFile, async () => {
        const file = resolve(options.cwd, plainFile);
        // Where its code lives: the tips its module is built in, or - none built yet - its own codebase. The whole chain:
        // every codebase in those chains, bottom first - a tip taken back to nothing is otherwise started from a copy of
        // the code below it.
        const chains = chainsFor(file);
        const codebases = [...new Map((chain === true ? chains.flat() : chains.map(tipOf)).map((entry) => [entry.buildDir, entry])).values()];
        for (const entry of codebases) {
          if (modules.get(entry.buildDir)?.running !== undefined) throw new Error(`${entry.moduleName} has a pulse running: halt it, or ask again once it is done.`);
        }
        const why = chain === true ? "asked to be regenerated from scratch, with its whole chain" : "asked to be regenerated from scratch";
        for (const entry of codebases) if (started(entry)) startAgain(entry, why);
        return loop.bringUp(plainFile, request);
      });
    },
    halt(target, reason) {
      const named = target.trim();
      // A planned row's module - the longest name its id starts with, as a name may hold a hyphen - or a module by its name.
      const state = order
        .map((key) => modules.get(key)!)
        .filter((candidate) => {
          const name = tipEntry(candidate).moduleName;
          return named === name || named.startsWith(`planned-${name}-`);
        })
        .sort((a, b) => tipEntry(b).moduleName.length - tipEntry(a).moduleName.length)[0];
      if (state === undefined) return undefined;
      const tip = tipEntry(state);
      if (state.running === undefined && !existsSync(tip.plainFile)) {
        forget(state);
        asked.delete(tip.plainFile);
        return `${tip.moduleName} is no longer in the project - ${basename(tip.plainFile)} is gone - so nothing was to be built there: it is dropped from the regeneration.`;
      }
      const planned = statusOf(state).planned.length;
      const said = reason !== undefined && reason.trim() !== "" ? ` (${reason.trim()})` : "";
      state.held = { why: `you halted it${said} - nothing runs here until it is asked for again` };
      state.why = state.held.why;
      state.waitsFor = undefined;
      state.plan = undefined;
      state.conformancePlan = undefined;
      const running = state.running;
      if (running !== undefined && running.stopping !== true) {
        running.stopping = true;
        options.registry.stop(running.jobId, `Halted by you${said}: what it had done is rolled back, and nothing more runs in ${tip.moduleName} until it is asked for again.`);
      }
      const above = order
        .map((key) => modules.get(key)!)
        .filter((other) => other !== state && looking.has(other) && other.chain.some((entry) => entry.buildDir === tip.buildDir))
        .map((other) => tipEntry(other).moduleName);
      void tick();
      return [
        `Halted ${tip.moduleName}${said}:`,
        running !== undefined ? ` its running pulse ${running.jobId} is being stopped, and what it had done rolled back;` : "",
        planned > 0 ? ` its ${planned} planned pulse${planned === 1 ? "" : "s"} will not start.` : " nothing more is planned there.",
        " Pulses that landed stay.",
        above.length > 0 ? ` ${above.join(", ")} ${above.length === 1 ? "waits" : "wait"} for it.` : "",
        ` It runs again only when asked for - regenerate ${basename(tip.plainFile)} - a spec change does not start it.`,
      ].join("");
    },
    status() {
      return [...order.map((key) => statusOf(modules.get(key)!)), ...preparingAlone().map(({ since: _since, ...status }) => status)];
    },
    planned() {
      const now = Date.now();
      let sequence = Number.MAX_SAFE_INTEGER;
      // The last job - running or planned - of each module, by name: what a module waiting for it waits behind.
      const lastOf = new Map<string, string>();
      // A module asked for that the loop holds nothing of yet: being planned, from the moment it was asked for.
      const early = preparingAlone().map(({ module: name, since }): Job => ({
        id: `planned-${name}-preparing`,
        kind: "regenerate",
        summary: `${name}.plain - being planned`,
        module: name,
        note: "Being planned into pulses now. The first starts as soon as the plan is made.",
        status: "queued",
        sequence: sequence--,
        queuedAt: since,
        startedAt: since,
        waitingOn: [],
        tail: "",
        activity: [],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
        agents: [],
        transcript: [],
        planning: { since },
      }));
      return [...early, ...order.flatMap((key) => {
        const state = modules.get(key)!;
        const tip = tipEntry(state);
        const status = statusOf(state);
        let before = status.running?.jobId;
        if (before !== undefined) lastOf.set(tip.moduleName, before);
        const row = (id: string, summary: string, note: string, waitingOn: string[], conformance = false): Job => ({
          id,
          kind: conformance ? "conformance" : "regenerate",
          summary,
          module: tip.moduleName,
          note,
          ...(state.model !== undefined ? { model: state.model } : {}),
          status: "queued",
          sequence: sequence--,
          queuedAt: now,
          startedAt: now,
          waitingOn,
          tail: "",
          activity: [],
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
          agents: [],
          transcript: [],
        });
        // Waiting for the module below it: not planned yet, but in the queue all the same - behind what it waits for.
        if (state.running === undefined && state.waitsFor !== undefined) {
          const behind = lastOf.get(state.waitsFor);
          const id = `planned-${tip.moduleName}-waiting`;
          lastOf.set(tip.moduleName, id);
          return [
            row(
              id,
              `${basename(tip.plainFile)} - waits for ${state.waitsFor}`,
              `Not planned yet: its work is planned into pulses once ${state.waitsFor} is built - the code it is built on.`,
              behind !== undefined ? [behind] : [],
            ),
          ];
        }
        return status.planned.map((job, index): Job => {
          const planned = row(
            `planned-${tip.moduleName}-${index + 1}`,
            `${basename(tip.plainFile)} ${job.track === "conformance" ? "conformance: " : ""}${job.title}`,
            job.afterCode === true
              ? `Not planned yet: the conformance tests${job.specs !== undefined && job.specs.length > 0 ? ` of ${job.specs.join(", ")}` : ""} are planned into pulses once the module's code is built.`
            : job.planning === true
              ? `Being planned into pulses now: ${job.title}. The first starts as soon as the plan is made.`
              : `Planned, not started: ${casesText(job.cases)}. It is planned again whenever the spec changes or a pulse before it ends.`,
            before !== undefined ? [before] : [],
            job.track === "conformance",
          );
          if (job.planning === true) planned.planning = { since: state.planningSince ?? preparing.get(tip.moduleName)?.since ?? now };
          before = planned.id;
          lastOf.set(tip.moduleName, planned.id);
          return planned;
        });
      })];
    },
    firsts() {
      return order.flatMap((key) => {
        const first = firsts.get(key);
        const tip = tipEntry(modules.get(key)!);
        return first === undefined ? [] : [{ module: tip.moduleName, plainFile: tip.plainFile, buildDir: tip.buildDir, ...first }];
      });
    },
    mapPlan() {
      return {
        files: [...asked.keys()],
        codebases: order.map((key): MapCodebase => {
          const state = modules.get(key)!;
          const tip = tipEntry(state);
          const { jobs, ahead } = describe(state);
          const running = state.running;
          let next = running?.number ?? state.pulses ?? 0;
          const pulses: MapPulse[] = [
            ...(running !== undefined
              ? [{ number: running.number, title: running.planned.title, track: running.planned.track, running: true, rowId: running.jobId, before: serializeTree(running.from), after: serializeTree(running.after) }]
              : []),
            ...jobs.flatMap((job, index): MapPulse[] => {
              const rowId = `planned-${tip.moduleName}-${index + 1}`;
              // The conformance tests that follow the code still to build: numbered among the rest, their functional specs by name.
              const following = ahead[index];
              if (following !== undefined) return [{ number: (next += 1), title: following.title, track: "conformance", running: false, rowId, before: "", after: "", specs: following.specs }];
              return job === undefined ? [] : [{ number: (next += 1), title: job.title, track: job.track, running: false, rowId, before: job.step.before, after: job.step.after }];
            }),
          ];
          const gaveUp = running === undefined && state.why === NO_PLAN ? { why: NO_PLAN } : undefined;
          const stuck = running === undefined && state.halted !== undefined ? { why: state.halted.why, ...(state.halted.pulse !== undefined ? { pulse: state.halted.pulse } : {}), ...(state.halted.cause !== undefined ? { cause: state.halted.cause } : {}) } : gaveUp;
          return {
            module: tip.moduleName,
            plainFile: tip.plainFile,
            buildDir: tip.buildDir,
            pulses,
            conformance: testedFuncIds(state.seen?.tree).length > 0,
            ...(state.planning !== undefined ? { planning: state.planning } : {}),
            ...(running === undefined && state.waitsFor !== undefined ? { waitsFor: state.waitsFor } : {}),
            ...(running === undefined && state.why !== undefined ? { why: state.why } : {}),
            ...(stuck !== undefined ? { stuck } : {}),
          };
        }),
      };
    },
    async drain() {
      for (;;) {
        // A pulse that settles meanwhile ticks again: its next pulse is started by that tick, so it is waited for too.
        const looking = ticking;
        await looking;
        if (looking !== ticking) continue;
        const running = order.map((key) => modules.get(key)!.running?.jobId).filter((id): id is string => id !== undefined);
        if (running.length === 0) return;
        await Promise.all(running.map((id) => options.registry.wait(id).catch(() => undefined)));
        // Its settling ticks: let it start what comes next before looking again.
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    },
  };
  return loop;
}

/** The codebases of a chain built when functional specs were numbered, before func-ids: their code or tests record is old. */
function oldCodebases(chain: ChainEntry[]): ChainEntry[] {
  return chain.filter((entry) => isOldRecord(readRecord(entry.buildDir)) || isOldRecord(readRecord(conformanceDirFor(entry.moduleName, modulesRoot(projectDirOf(entry.plainFile))))));
}

/** Why nothing is built on codebases with old records. */
const OLD_RECORDS_WHY = (codebases: string[]): string =>
  `${codebases.join(", ")} ${codebases.length === 1 ? "was" : "were"} built when functional specs were numbered, before they had func-ids: nothing more is built on ${codebases.length === 1 ? "it" : "them"} - the whole chain is regenerated from scratch once you agree`;

/** Why nothing runs in a codebase whose code - and conformance tests, where they are wanted - is built from its spec as it is. */
export const UP_TO_DATE = "built from the ***plain as it is";

/** Why a codebase with work left has no plan: the planner found none. */
/** Why a codebase waits for a testing script being written in the background. */
const SCRIPT_BEING_WRITTEN = (what: string) => `waiting for its ${what}, which is being written`;
const NO_PLAN = "the planner found no way to cut the work into pulses that hold together";

/**
 * Where the functional specs' test plain files of a module's chain are, by func-id and module - the module's own when none
 * is named - under `base`, the folder the module's file is named in: as the parse bound them, else where one is to be,
 * `<test-dir>/<module>/<func-id>.plain`.
 */
function testPlainPathOf(tree: MarshalledPlainSource, moduleName: string, plainFile: string, base: string): (funcId: string, module?: string) => string {
  const bound = Object.entries((tree[TEST_PLAIN_FILES] as Record<string, TestPlainFileBinding> | undefined) ?? {});
  const fallback = relative(dirname(plainFile), testDirOf(plainFile));
  return (funcId, module = moduleName) => {
    const name = bound.find(([, binding]) => binding.module === module && binding.func_id === funcId)?.[0] ?? join(fallback, module, `${funcId}.plain`);
    return join(base, name);
  };
}

/** A diff's lines placed in the .plain files of a chain - the tip's first - named as they are from the project. */
function whereInFiles(diff: string, chain: ChainEntry[]): DiffWhere {
  try {
    // The test plain files too: a conformance pulse's diff has their lines.
    const files = [...chain].reverse().flatMap((entry) => [...specFilesOf(entry.plainFile), ...testPlainFilesOf(entry.plainFile)]);
    // A standard library template by its import path, not by where turri happens to be.
    const nameOf = (path: string) => (path.startsWith(`${STDLIB_ROOT}/stdlib/`) ? relative(STDLIB_ROOT, path) : relative(projectDirOf(chain.at(-1)!.plainFile), path) || basename(path));
    const unique = [...new Set(files)].map((path) => ({ name: nameOf(path), text: readFileSync(path, "utf8") }));
    return locateDiffLines(diff, unique);
  } catch {
    return {};
  }
}

/**
 * The conformance tests' work, a line a functional spec, each with its scenarios counted by case and why else its tests
 * are behind: "todo:add-task   1 added, 1 changed". What a case is follows from the tests record, by scenario-id: a
 * scenario added there is new to the tests, one changed reads otherwise, one removed is taken out - and a functional spec
 * whose code changed under scenarios unchanged has their tests run on the new code.
 */
function conformanceLines(module: string, cases: JobCases): string[] {
  const name = (touched: TouchedSpec) => `${touched.module ?? module}:${touched.funcId}`;
  const why: Record<NonNullable<ScenarioCases["codeChanged"]>, string> = { text: "its code changed", again: "its code was regenerated again", concept: "a concept it uses changed" };
  const counted = (spec: ScenarioCases): string => {
    const parts = [
      ...(spec.added.length > 0 ? [`${spec.added.length} added`] : []),
      ...(spec.changed.length > 0 ? [`${spec.changed.length} changed`] : []),
      ...(spec.removed.length > 0 ? [`${spec.removed.length} removed`] : []),
      ...(spec.codeChanged !== undefined ? [`${why[spec.codeChanged]} - ${spec.unchanged.length} to run on it`] : []),
    ];
    return parts.length > 0 ? parts.join(", ") : "its text changed";
  };
  const rows: Array<[string, string]> =
    cases.scenarios !== undefined
      ? cases.scenarios.map((spec): [string, string] => [name(spec), cases.delete.some((gone) => name(gone) === name(spec)) ? `taken out - its tests go (${spec.removed.length} removed)` : counted(spec)])
      : [
          ...cases.add.map((touched): [string, string] => [name(touched), "scenarios to write tests for"]),
          ...cases.patch.map((touched): [string, string] => [name(touched), "its text or its scenarios changed"]),
          ...cases.again.map((touched): [string, string] => [name(touched), "its code was regenerated again"]),
          ...cases.delete.map((touched): [string, string] => [name(touched), "taken out - its tests go"]),
        ];
  if (rows.length === 0) return ["    the test reqs or what they are written against changed"];
  const width = Math.max(...rows.map(([name]) => name.length));
  return rows.map(([name, why]) => `    ${name.padEnd(width)}   ${why}`);
}

/** Functional specs as a person names them: `module:func-id`, each. */
export function namesOf(module: string, funcIds: string[]): string {
  return funcIds.map((funcId) => `${module}:${funcId}`).join(", ");
}

/** Functional specs of a chain as a person names them: `module:func-id`, each - the codebase's own with `module`. */
function refsOf(module: string, specs: Array<{ module?: string; funcId: string }>): string {
  return specs.map((spec) => `${spec.module ?? module}:${spec.funcId}`).join(", ");
}

/**
 * The func-ids a person names in a module, each as `module:func-id` - a bare func-id, or another module's, is refused:
 * a func-id is unique in its module only.
 */
export function funcIdsNamed(module: string, names: string[]): string[] {
  return names.map((name) => {
    const at = name.lastIndexOf(":");
    if (at === -1) throw new Error(`Name the functional spec as ${module}:${name} - a func-id with its module. Nothing was done.`);
    const [named, funcId] = [name.slice(0, at), name.slice(at + 1)];
    if (named !== module) throw new Error(`${name} is not a functional spec of ${module}: name ${named}'s .plain file for it. Nothing was done.`);
    return funcId;
  });
}

/** What a job does, in a few words: its cases, each functional spec by its func-id - with its module, a module below's. */
function casesText(cases: JobCases): string {
  const named = (specs: TouchedSpec[]) => specs.map((spec) => (spec.module !== undefined ? `${spec.module}:${spec.funcId}` : spec.funcId)).join(", ");
  const parts = [
    ...(cases.fresh ? ["sets the project up"] : []),
    ...(cases.add.length > 0 ? [`adds ${named(cases.add)}`] : []),
    ...(cases.patch.length > 0 ? [`changes ${named(cases.patch)}`] : []),
    ...(cases.again.length > 0 ? [`regenerates ${named(cases.again)} again`] : []),
    ...(cases.delete.length > 0 ? [`takes out ${named(cases.delete)}`] : []),
  ];
  return parts.length > 0 ? parts.join(", ") : "no functional spec - reqs or definitions only";
}

/** The codebases the loop looks after, as the person reads them: what runs, what is planned after it, and why nothing does. */
/**
 * The coding agent's task for a dry run's first job, built as the render builds it - and all it did rolled back. Not for
 * a conformance job: its prompt is built from what the code holds once it is built.
 */
export async function promptOf(first: ReturnType<WorkLoop["firsts"]>[number]): Promise<string | undefined> {
  if (first.planned.track !== "code") return undefined;
  const result = await renderSpecDiff({
    plainFile: first.plainFile,
    diff: first.planned.step.textDiff,
    applied: "already applied",
    spec: first.spec,
    cases: first.planned.cases,
    dryRun: true,
  });
  return result.task;
}

/** The first job a codebase would start, and the prompt its coding agent would get. */
export interface JobPreview {
  module: string;
  title: string;
  track: Track;
  cases: JobCases;
  /** The coding agent's task, whole. Not for a conformance job: it is built from what the code holds once it is built. */
  task?: string;
}

/**
 * What bringing a spec's module up would start, in each codebase, and the prompt of each - planned on a loop of its own
 * that starts nothing. A codebase `busy` says is running a job is left out: a dry run starts from its last commit, and
 * what the next job there is given depends on what the running one lands.
 */
export async function previewJobs(options: {
  plainFile: string;
  cwd: string;
  model?: string;
  plannerModel?: string;
  steering?: (plainFile: string) => Steering[];
  /** Whether a codebase, by its module, has a job running. */
  busy?: (module: string) => boolean;
}): Promise<{ statuses: ModuleStatus[]; previews: JobPreview[]; busy: string[] }> {
  const loop = createWorkLoop({
    registry: createJobRegistry(),
    cwd: options.cwd,
    dryRun: true,
    ...(options.model !== undefined ? { modelFor: () => options.model } : {}),
    ...(options.plannerModel !== undefined ? { plannerModel: options.plannerModel } : {}),
    ...(options.steering !== undefined ? { steering: options.steering } : {}),
  });
  const statuses = await loop.bringUp(options.plainFile, options.model !== undefined ? { model: options.model } : {});
  const previews: JobPreview[] = [];
  const busy: string[] = [];
  for (const first of loop.firsts()) {
    if (options.busy?.(first.module) === true) {
      busy.push(first.module);
      continue;
    }
    const preview: JobPreview = { module: first.module, title: first.planned.title, track: first.planned.track, cases: first.planned.cases };
    const task = await promptOf(first);
    if (task !== undefined) preview.task = task;
    previews.push(preview);
  }
  return { statuses, previews, busy };
}

/** Nothing runs, is planned or is waiting there, as its code is built from its spec as it is. */
export function isUpToDate(status: ModuleStatus): boolean {
  return status.why === UP_TO_DATE && status.running === undefined && status.planned.length === 0 && status.startOver === undefined;
}

export function describeModules(statuses: ModuleStatus[], options: { for?: "chat" | "command line" } = {}): string {
  if (statuses.length === 0) return "Nothing is being built.";
  const startOver = (status: ModuleStatus): string[] => {
    if (status.startOver === undefined) return [];
    const { requires, codebases } = status.startOver;
    if (status.startOver.old === true) {
      return options.for === "command line"
        ? [`  turri regenerate ${basename(status.plainFile)} --start-over regenerates it from scratch, with its whole chain`]
        : [
            `  Ask the user whether to regenerate ${status.module} from scratch, with its whole chain, and say why: ${codebases.join(", ")} ` +
              `${codebases.length === 1 ? "was" : "were"} built when functional specs were numbered, before they had func-ids, so nothing more ` +
              "can be built on it - its code and conformance tests are taken out, kept in its history, and every module of the chain " +
              `is built again from the bottom. Only if they agree, call regenerate with ${basename(status.plainFile)} and from_scratch: "chain".`,
          ];
    }
    return options.for === "command line"
      ? [`  turri regenerate ${basename(status.plainFile)} --start-over starts ${codebases.join(", ")} over`]
      : [
          `  Ask the user whether to start ${codebases.join(", ")} over, and say why: ${codebases.join(", ")} was built without ` +
            `${requires.join(", ")}, so no change to its code can bring ${requires.join(", ")} in - its code and conformance ` +
            "tests are taken out, kept in its history, and built again from the bottom of the chain. Only if they agree, " +
            `call regenerate with ${basename(status.plainFile)} and from_scratch: "module".`,
        ];
  };
  return statuses
    .map((status) => {
      // Nothing to do there: said in a sentence, not as a status.
      if (isUpToDate(status)) return `${status.module} is up to date: its code is built from the ***plain as it is now in ${basename(status.plainFile)}, so there is nothing to regenerate.`;
      const lines = [`${status.module} (${basename(status.plainFile)}${status.stack !== undefined ? `, stack ${status.stack}` : ""}):`];
      if (status.running !== undefined) {
        lines.push(`  running: pulse ${status.running.jobId} - ${status.running.title}`);
        // Steered, not stopped or planned again: what changed went to its agent.
        for (const why of status.running.steered ?? []) lines.push(`    ⇢ steered: ${why} - its agent was told, and it lands the ***plain as it is now there`);
      }
      for (const rename of status.renames ?? []) lines.push(`  renames ${rename} once the running pulse ends - the records and the tests' labels, nothing regenerated`);
      status.planned.forEach((job, index) =>
        lines.push(
          job.afterCode === true
            ? `  ${index + 1}. conformance tests${job.specs !== undefined && job.specs.length > 0 ? ` of ${job.specs.join(", ")}` : ""} - planned once the code is built`
            : job.planning === true
              ? `  ${index + 1}. ${job.track === "conformance" ? "conformance tests: " : ""}${job.title} - being planned into pulses`
            : `  ${index + 1}. ${job.track === "conformance" ? "conformance tests: " : ""}${job.title} - ${casesText(job.cases)}`,
        ),
      );
      if (status.planNotes !== undefined) lines.push("  what the plan did not do as asked:", ...status.planNotes.map((note) => `    - ${note}`));
      if (status.why !== undefined) lines.push(`  ${status.why}`);
      if (status.conformanceNote !== undefined) lines.push(`  ${status.conformanceNote}`);
      lines.push(...startOver(status));
      return lines.join("\n");
    })
    .join("\n");
}

/**
 * A conformance job: its tests written and run for its change - a failure judged, the test or the code fixed - then the
 * whole suite, the tests the module inherits with it. Passing, what the tests are written for is recorded and committed;
 * otherwise all of it - the code's fixes too - is undone.
 */
const defaultConformanceRunner: JobRunner = async (job, onDelta) => {
  const result = await renderSpecDiffConformance({
    plainFile: job.plainFile,
    diff: job.planned.step.textDiff,
    change: describeSpecChange(job.planned.step.changes, job.moduleName),
    cwd: job.cwd,
    applied: "already applied",
    spec: job.spec,
    cases: job.planned.cases,
    recorded: job.planned.step.tree,
    ...(job.model !== undefined ? { model: job.model } : {}),
    onDelta,
  });
  if (result.passed) {
    writeTestsRecord(result.conformanceDir, job.planned.step.tree);
    landWork(job.buildDir, `conformance tests: ${job.planned.title}`);
  }
  return { landed: result.passed, report: describeSpecDiffConformance(result), ...(result.specGaps !== undefined ? { specGaps: result.specGaps } : {}) };
};

/** The functional specs a pulse covers, by case, each with the module whose spec it is: a host's to light and mark. */
export function pulseCases(cases: JobCases, moduleName: string): PulseCases {
  const of = (specs: TouchedSpec[]) => specs.map((spec) => ({ module: spec.module ?? moduleName, funcId: spec.funcId }));
  return { add: of(cases.add), patch: of(cases.patch), again: of(cases.again), delete: of(cases.delete) };
}

/**
 * A module's first pulse when it builds one functional spec - the project set up and the smallest thing that runs: it lands on its
 * unit tests alone, with no review. A reviewer, and an arbiter after it, on a scaffold is time spent before anything can
 * be tried.
 */
export function skipsReview(cases: JobCases): boolean {
  return cases.fresh && cases.add.length <= 1 && cases.patch.length === 0 && cases.again.length === 0 && cases.delete.length === 0;
}

/** A job as a spec diff render, landed on its unit tests: conformance is a track of its own. */
const defaultRunner: JobRunner = async (job, onDelta) => {
  const result = await renderSpecDiff({
    plainFile: job.plainFile,
    diff: job.planned.step.textDiff,
    cwd: job.cwd,
    applied: "already applied",
    spec: job.spec,
    cases: job.planned.cases,
    ...(skipsReview(job.planned.cases) ? { unitReview: false } : {}),
    ...(job.model !== undefined ? { model: job.model } : {}),
    ...(job.steering !== undefined ? { steering: job.steering } : {}),
    onDelta,
  });
  // Landed code can be tried.
  return { landed: result.passed, report: describeSpecDiff(result), story: codeStory(result),
    ...(result.specGaps !== undefined ? { specGaps: result.specGaps } : {}),
  };
};

/** How a code pulse went, for its line in the notes: the rounds it took, its test runs, what the debugger found. */
export function codeStory(result: { attempts?: number; runs?: unknown[]; diagnosed?: string[]; restructured?: boolean }): string | undefined {
  if (result.restructured === true) return "only restructured, nothing regenerated";
  const attempts = result.attempts ?? 0;
  const runs = result.runs?.length ?? 0;
  const rounds = `${attempts} round${attempts === 1 ? "" : "s"} of the unit tests, ${runs} test run${runs === 1 ? "" : "s"}`;
  const found = (result.diagnosed ?? []).map((cause) => `the debugger: ${cause}`);
  return [rounds, ...found].join("; ");
}
