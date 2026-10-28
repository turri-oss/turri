import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ACCEPTANCE_TESTS, CONFORMANCE_TESTS, type ScenarioItem } from "../plain/spec.ts";
import { ensureInScratch } from "./paths.ts";

/**
 * The test advisor's file: `.turri/advisor/<module>.json` in the project - what it made of each functional spec of the
 * module it looked at, by func-id, keyed by a hash of its text (docs/test-advisor.md). Local to this machine: `.turri`
 * ignores itself, so it is never committed - another machine starts with none, and classifies only what changes there.
 *
 * An entry is current while its hash is the functional spec's text's: a text that changes makes it stale, and the
 * functional spec is looked at again. `pending` is written the moment the advisor sees a functional spec, so quitting
 * loses nothing: the next start in the chat or a host picks it up.
 */

export const ADVISOR_DIR = "advisor";

/** The four questions, each a yes or a no: could it fail silently, be read two ways, be built on later, cost much when wrong. */
export const ADVISOR_QUESTIONS = ["silent-failure", "divergence", "revisited", "cost"] as const;
export type AdvisorQuestion = (typeof ADVISOR_QUESTIONS)[number];

/** A question that was a yes, with its evidence in a line: the wrong output, the input read two ways, what would change, the consequence. */
export interface AdvisorAnswer {
  question: AdvisorQuestion;
  evidence: string;
}

/** An input to cover: one the readers agreed on, with its output, or one they split on, with each reading the verifier kept. */
export type AdvisorInput = { input: string; agreed: string } | { input: string; readings: string[] };

/** What the advisor made of a functional spec: its verdict, the questions that were a yes, and on a yes the inputs to cover. */
export interface AdvisorReport {
  verdict: "yes" | "no";
  questions: AdvisorAnswer[];
  inputs: AdvisorInput[];
}

/** Where an entry is: seen and not finished, classified yes or no, or failed - tried again only once its text changes. */
export type AdvisorState = "pending" | "yes" | "no" | "failed";

/** A scenario turri wrote: its kind, its scenario-id and a hash of its text - turri's while both still match. */
export interface AdvisorScenario {
  kind: "conformance" | "acceptance";
  id: string;
  hash: string;
}

export interface AdvisorEntry {
  funcId: string;
  /** The hash of the functional spec's text the entry is about (textHash). */
  hash: string;
  state: AdvisorState;
  report?: AdvisorReport;
  /** The model the advisor ran on. */
  model?: string;
  /** When the entry was last written, ISO. */
  at: string;
  /** The scenarios turri wrote for this text. */
  scenarios?: AdvisorScenario[];
  /** Why it failed, for a failed one. */
  reason?: string;
  /** The tip's .plain file, from the project: where the chain's test reqs and conformance testing script are. */
  tip?: string;
}

export interface AdvisorFile {
  module: string;
  /** The module's .plain file, from the project. */
  plainFile: string;
  entries: Record<string, AdvisorEntry>;
}

/** The hash a functional spec's text is known by: its text, trimmed. */
export function textHash(text: string): string {
  return createHash("sha256").update(text.trim()).digest("hex").slice(0, 16);
}

/** The folder of a project's advisor files. */
export function advisorDir(project: string): string {
  return join(resolve(project), ".turri", ADVISOR_DIR);
}

/** A module's advisor file. */
export function advisorPath(project: string, module: string): string {
  return join(advisorDir(project), `${module}.json`);
}

/** A module's advisor file, or nothing when there is none or it does not read. */
export function readAdvisor(project: string, module: string): AdvisorFile | undefined {
  try {
    const parsed = JSON.parse(readFileSync(advisorPath(project, module), "utf8")) as AdvisorFile;
    return parsed !== null && typeof parsed === "object" && typeof parsed.entries === "object" && parsed.entries !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** A functional spec's entry, or nothing. */
export function advisorEntry(project: string, module: string, funcId: string): AdvisorEntry | undefined {
  return readAdvisor(project, module)?.entries[funcId];
}

/** Whether an entry is about the text as it is now: one that is not, or none, is stale, and the functional spec is looked at again. */
export function isCurrent(entry: AdvisorEntry | undefined, hash: string): entry is AdvisorEntry {
  return entry !== undefined && entry.hash === hash;
}

/** Write a functional spec's entry, in place of the one it had. `plainFile` is the module's, from the project. */
export function putAdvisorEntry(project: string, module: string, plainFile: string, entry: Omit<AdvisorEntry, "at"> & { at?: string }): AdvisorEntry {
  const file = readAdvisor(project, module) ?? { module, plainFile, entries: {} };
  const written: AdvisorEntry = { ...entry, at: entry.at ?? new Date().toISOString() };
  file.plainFile = plainFile;
  file.entries[entry.funcId] = written;
  writeAdvisor(project, file);
  return written;
}

/** Take a functional spec's entry out - its functional spec is gone. */
export function removeAdvisorEntry(project: string, module: string, funcId: string): void {
  const file = readAdvisor(project, module);
  if (file === undefined || file.entries[funcId] === undefined) return;
  delete file.entries[funcId];
  writeAdvisor(project, file);
}

function writeAdvisor(project: string, file: AdvisorFile): void {
  const scratch = join(resolve(project), ".turri");
  ensureInScratch(scratch, advisorDir(project));
  const path = advisorPath(project, file.module);
  // Written whole, then moved in place: a turri killed part-way never leaves half a file.
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`);
  renameSync(temporary, path);
}

/** Every pending entry of a project's advisor files, with the module and its .plain file - what a start picks up. */
export function pendingEntries(project: string): Array<{ module: string; plainFile: string; entry: AdvisorEntry }> {
  const dir = advisorDir(project);
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const file = readAdvisor(project, name.slice(0, -".json".length));
    if (file === undefined) return [];
    return Object.values(file.entries)
      .filter((entry) => entry.state === "pending")
      .map((entry) => ({ module: file.module, plainFile: file.plainFile, entry }));
  });
}

/** A functional spec's scenarios, each with its kind and the hash of its text. */
export function scenariosOf(item: unknown): AdvisorScenario[] {
  const of = (key: string, kind: AdvisorScenario["kind"]) =>
    (((item as Record<string, unknown> | null)?.[key] as ScenarioItem[] | undefined) ?? []).map((scenario) => ({ kind, id: scenario.id, hash: textHash(scenario.text) }));
  return [...of(CONFORMANCE_TESTS, "conformance"), ...of(ACCEPTANCE_TESTS, "acceptance")];
}

/**
 * The scenarios of a functional spec that are the person's: every one, but those turri wrote - by its entry - whose
 * kind, scenario-id and text hash still match. One the person changed is theirs from then on.
 */
export function personsScenarios(entry: AdvisorEntry | undefined, item: unknown): AdvisorScenario[] {
  const turris = new Set((entry?.scenarios ?? []).map((scenario) => `${scenario.kind} ${scenario.id} ${scenario.hash}`));
  return scenariosOf(item).filter((scenario) => !turris.has(`${scenario.kind} ${scenario.id} ${scenario.hash}`));
}
