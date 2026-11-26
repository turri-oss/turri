import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureInScratch } from "../regenerate/paths.ts";
import type { SurfaceKind } from "./map.ts";
import type { CapturePlan } from "./plan.ts";

/**
 * What a capture keeps as it goes, in `<plain>/.turri/capture/state.json`: every agent's answer, saved as it comes. A
 * capture stopped part-way - turri quit, the machine slept - is started again from it, asking no agent twice; a capture
 * that finished is never run over.
 */

export const STATE_VERSION = 1;

export interface Definition {
  /** `:Note:`. */
  concept: string;
  /** The definition's text, starting with the concept: `:Note: is a short text a :User: keeps.` */
  text: string;
}

export interface LeftOut {
  path: string;
  why: string;
}

/**
 * What every feature of a part does the same way and a user or a script relies on - how an error is written, the exit
 * code or status of each kind of failure, how it acts when its input or output is not a terminal, what reaches the other
 * side of a call it makes or answers - settled once, by the survey, from the code that does it, and handed to every writer
 * as settled.
 */
export interface Convention {
  /** One fact, exact: `A usage error prints the usage and the message to standard error and exits with 1.` */
  text: string;
  /** The files whose code decides it. */
  where: string[];
}

/** A part of the codebase on a stack of its own - a backend, a frontend - captured as a chain of modules of its own. */
export interface Part {
  name: string;
  about: string;
  paths: string[];
  /** The standard library's stack it imports, when one matches the original without contradicting it. */
  stdlibStack?: string;
  /** Whether it imports that stack's conformance template too. */
  stdlibConformance?: boolean;
  implementationReqs: string[];
  /** Absent in a capture started before conventions were settled. */
  conventions?: Convention[];
  testReqs: string[];
  definitions: Definition[];
}

export interface Survey {
  separateConcerns?: string;
  parts: Part[];
  leftOut: LeftOut[];
  assumptions: string[];
}

/** A surface of the code's interface - an option, a command, a route, a screen, an environment variable - and its file. */
export interface InterfaceSurface {
  path: string;
  kind: SurfaceKind | InterfaceKind;
  name: string;
}

export type InterfaceKind = "command" | "argument" | "option" | "route" | "env" | "other";

/**
 * One piece of the software's interface as the code defines it - what a user, a client or a script calls by name -
 * taken from the code by an agent, every literal it gives checked against the code it cites. The entries of a part are
 * its interface reference, a linked resource every functional spec about it carries: exact where prose would guess.
 */
export interface InterfaceEntry {
  kind: InterfaceKind;
  /** Exactly as the code has it: `--proxy`, `http`, `httpie plugins install`, `GET /notes/{id}`, `HTTPIE_CONFIG_DIR`. */
  name: string;
  /** Every other name it has: `-x`. */
  aliases: string[];
  /** The command an argument or an option belongs to: `http`, `httpie plugins install`. */
  command?: string;
  /** What it takes: its value's form or type - `PROTOCOL:PROXY_URL`, `int`, `a JSON body`. */
  takes?: string;
  /** The values it accepts, when the code lists them, each as the code has it. */
  choices: string[];
  /** Its default, as the code has it. */
  default?: string;
  repeatable?: boolean;
  required?: boolean;
  /** Left out of its help. */
  hidden?: boolean;
  /** Its help text, word for word. */
  help?: string;
  /** A route's parameters, fields and answers, a line each: `query page: int, 1 by default`, `201: the note created`. */
  details: string[];
  /** Where it is defined, `path:line`. */
  where: string;
  /** Other files its literals come from: where a default or the choices are worked out. */
  also: string[];
}

/** A surface of the map left out of the reference, with why: an option of a development script, say. */
export interface InterfaceExclusion {
  name: string;
  path: string;
  why: string;
}

/** What one agent took of a part's interface from some of its files - or why it could not. */
export type InterfaceBatch =
  | {
      entries: InterfaceEntry[];
      excluded: InterfaceExclusion[];
      /** Its check against the code, by a fresh agent: what it changed and why, or why it did not hold. */
      checked?: { changes: string[] } | { failed: string };
    }
  | { failed: string };

/** A feature of a leaf area, as its outline names it: what a feature writer is given to capture. */
export interface FeatureOutline {
  name: string;
  title: string;
  about: string;
  /** The folders and files it owns, where its writer starts looking. */
  paths: string[];
  /**
   * Set on a feature the harness added once the features were written: the interface of its area's code that no
   * feature captured, which its writer captures - every one, or says why it is not the software's interface.
   */
  interface?: InterfaceSurface[];
}

/** A correction the interface check made to a functional spec or to one of its scenarios: its whole new text, and why. */
export interface Correction {
  funcId: string;
  /** The scenario corrected, when it is a scenario. */
  scenarioId?: string;
  text: string;
  why: string;
}

export interface Scenario {
  id: string;
  text: string;
}

export interface CapturedSpec {
  funcId: string;
  text: string;
  conformance: Scenario[];
  acceptance: Scenario[];
}

/** What a feature writer captured of one feature. */
export interface CapturedFeature {
  specs: CapturedSpec[];
  definitions: Definition[];
  uncertain: string[];
  dropped: string[];
  assumptions: string[];
}

export interface AreaState {
  id: string;
  name: string;
  about: string;
  paths: string[];
  part: string;
  /** Split into areas, or a leaf outlined into features - or neither yet. */
  children?: string[];
  features?: FeatureOutline[];
  leftOut?: LeftOut[];
  /** Why it could not be captured, when it could not. */
  failed?: string;
}

/**
 * A part's features divided, once every area is outlined and before any is written: each behaviour one feature's. The
 * outlines are made area by area, each from its own files, so the same behaviour - an option parsed in one area, acted
 * on in another - can be outlined twice; written twice, it says the same in different words, or contradicts itself.
 */
export interface Division {
  /** What each feature that stays alone captures, by feature key. */
  owns: Record<string, string>;
  /** Features whose behaviour others own whole, by key: the features that took it, and why. Never written. */
  merged: Record<string, { into: string[]; why: string }>;
  /** Why the features were not divided, when they were not: each owns what it was outlined for. */
  failed?: string;
}

/** A module of a part as its features were gathered: its concern, its features, and what it needs of the modules before it. */
export interface GatheredModule {
  /** Short kebab-case: the concern - `output-formatting`, `sessions`. */
  name: string;
  about: string;
  /** Its features, by key, in the order its functional specs are written. */
  features: string[];
  /** The modules before it whose behaviour its functional specs build on and its scenarios run, by name. */
  needs: string[];
}

/** A scenario rewritten so it needs only the modules before its own: its feature, its functional spec, its whole new text and why. */
export interface ModuleRewrite {
  /** The feature's key. */
  feature: string;
  funcId: string;
  scenarioId: string;
  text: string;
  why: string;
}

/**
 * A part's features gathered into modules by concern and put in the order they are built, once every feature is written.
 * A module is a concern of its own - what a person looks for in one file - never one that holds everything. It is built
 * on the code of the modules before it, and its scenarios run as soon as it is: a module whose scenarios send a request
 * comes after the one that sends it, whatever the code's imports say.
 */
export interface PartModules {
  /** In the order they are built. */
  modules: GatheredModule[];
  /** Scenarios that needed a module after their own whatever the order, rewritten. */
  rewrites: ModuleRewrite[];
  /** Why the modules are as the code's areas make them, in the order of their code, when they are. */
  failed?: string;
}

/** What the original did with a scenario run against it as its conformance test will run it. */
export type TrialOutcome = "held" | "corrected" | "removed" | "untried";

export interface TrialResult {
  funcId: string;
  scenarioId: string;
  outcome: TrialOutcome;
  /** What was run against the original, and what it answered. */
  ran: string;
  /** A corrected scenario's whole new text. */
  text?: string;
  /** Why it was corrected, removed or not tried. */
  why?: string;
}

/**
 * What one agent found trying some of a module's scenarios on a copy of the original: each scenario's outcome, the
 * functional specs the original contradicts, corrected, and what a conformance test must set up - or why it could not.
 */
export type TrialBatch = { results: TrialResult[]; specs: Correction[]; testReqs: string[] } | { failed: string };

export interface FeatureState {
  /** `<area id>#<feature name>`. */
  key: string;
  captured?: CapturedFeature;
  failed?: string;
}

export interface CaptureState {
  version: number;
  /** The codebase captured, absolute. */
  root: string;
  started: string;
  /** Saved before the survey. An older capture without a plan continues on the staged pipeline. */
  plan?: CapturePlan;
  survey?: Survey;
  /** The areas by id, each part's root area named as the part. */
  areas: Record<string, AreaState>;
  /** Each part's interface taken from the code, by part, then by the files each agent was given (their paths joined). */
  interfaces?: Record<string, Record<string, InterfaceBatch>>;
  /** Parts whose interface reference is whole: every batch answered - and its concept defined. */
  interfaceTaken?: string[];
  /** Each part's conventions checked against the code, by part: what the check changed and why, or why it did not hold. */
  conventionsChecked?: Record<string, { changes: string[]; failed?: string }>;
  /** Each part's features divided, by part - absent until its areas are all outlined. */
  divided?: Record<string, Division>;
  /** Parts whose interface no feature captured was given to writers of its own, once every feature was written. */
  interfaceFilled?: string[];
  features: Record<string, FeatureState>;
  /** Each part's features gathered into modules by concern, in the order they are built, by part - none for a part of one feature. */
  gathered?: Record<string, PartModules>;
  /** Concepts defined twice with different texts, as reconciled - by concept, a part's. */
  reconciled: Record<string, Record<string, string>>;
  /** The readability pass's new texts, by module and func-id. */
  edits: Record<string, Record<string, string>>;
  /** Modules whose readability pass ran - edited or not. */
  edited: string[];
  /** The interface check's corrections, by module, applied over the readability pass's texts. */
  corrections?: Record<string, Correction[]>;
  /** Modules whose interface was checked against the code - corrected or not. */
  verified?: string[];
  /** Each module's scenarios tried on the original, by module, then by batch - its number, from 1. */
  trials?: Record<string, Record<string, TrialBatch>>;
  /** Modules whose scenarios were all tried on the original - held or not. */
  tried?: string[];
  /** Whether the ***plain files are written: written once, the testing scripts then written for them. */
  written?: boolean;
  /** Each part's testing scripts, by `<part>:<unit | conformance>`: where each is, or why there is none. */
  scripts?: Record<string, ScriptOutcome>;
  finished?: string;
}

/** A testing script a capture had written: where it is in the project, or why there is none. */
export type ScriptOutcome = { written: string } | { failed: string };

export function captureDir(plainDir: string): string {
  const scratch = join(plainDir, ".turri");
  return ensureInScratch(scratch, join(scratch, "capture"));
}

export function stateFile(plainDir: string): string {
  return join(plainDir, ".turri", "capture", "state.json");
}

export function reportFile(plainDir: string): string {
  return join(plainDir, ".turri", "capture", "report.md");
}

/** The state a capture left in `plainDir`, or undefined when there is none - or one turri cannot read, which is started over. */
export function readState(plainDir: string): CaptureState | undefined {
  const file = stateFile(plainDir);
  if (!existsSync(file)) return undefined;
  try {
    const state = JSON.parse(readFileSync(file, "utf8")) as CaptureState;
    return state.version === STATE_VERSION ? state : undefined;
  } catch {
    return undefined;
  }
}

export function newState(root: string): CaptureState {
  return { version: STATE_VERSION, root, started: new Date().toISOString(), areas: {}, features: {}, reconciled: {}, edits: {}, edited: [] };
}

/** Save the state whole, through a file beside it: a capture stopped mid-write leaves the last state as it was. */
export function saveState(plainDir: string, state: CaptureState): void {
  const file = stateFile(plainDir);
  captureDir(plainDir);
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(temporary, file);
}
