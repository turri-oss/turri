import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ACCEPTANCE_TESTS, CONFORMANCE_TESTS, FUNCTIONAL_REQUIREMENTS, REQUIRED_FUNCTIONAL_SPECS, type MarshalledPlainSource } from "../plain/spec.ts";
import { reportActivity } from "./activity.ts";
import { record, type LedgerPlace } from "./ledger.ts";
import { abandonWork, landWork, moduleDirOf, startWork } from "./lineage.ts";
import { hasScenarios, marksRegenerateAgain, writeCodeRecord, writeTestsRecord } from "./records.ts";
import { listFiles } from "./testing.ts";

/**
 * Pure renames - see docs/regenerating.md. A func-id or a scenario-id given another name, and nothing else changed with
 * it, is no work for an agent: the code does what it did, and the tests test what they did. turri rewrites the records to
 * the new name and relabels the tests itself, as one unit of work - no agent, no testing script, the code untouched.
 *
 * - A func-id renamed: in the trees, a functional spec taken out and one added, identical but for their func-id - its
 *   text, its links and its scenarios the same. Its test plain file's `func_id:` changes with it; where that file is
 *   is free.
 * - A scenario-id renamed: under a functional spec otherwise unchanged, a scenario taken out and one of the same kind
 *   and text added.
 * - A rename together with any other change - the text, a scenario - stays a delete and an add, built anew. A module
 *   file renamed is a new module.
 */

type Item = { id?: string; module?: string; markdown?: string; [key: string]: unknown };
type Scenario = { id: string; text: string; linked_resources?: unknown };

export type PureRename =
  | { kind: "func-id"; module: string; from: string; to: string }
  | { kind: "scenario-id"; module: string; funcId: string; scenario: "conformance" | "acceptance"; from: string; to: string };

/** The renames found, and the records as they are once made - in memory: nothing is written here. */
export interface Renamed {
  renames: PureRename[];
  code: MarshalledPlainSource | null;
  tests: MarshalledPlainSource | null;
}

const SECTIONS = [REQUIRED_FUNCTIONAL_SPECS, FUNCTIONAL_REQUIREMENTS];
const KINDS = [
  ["conformance", CONFORMANCE_TESTS],
  ["acceptance", ACCEPTANCE_TESTS],
] as const;

/** A value as text with its keys sorted: two items alike whatever order their keys came in. */
function stable(value: unknown): string {
  const sorted = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(sorted);
    if (entry !== null && typeof entry === "object") return Object.fromEntries(Object.keys(entry).sort().map((key) => [key, sorted((entry as Record<string, unknown>)[key])]));
    return entry;
  };
  return JSON.stringify(sorted(value));
}

/** What of a functional spec the code is built from, but its func-id: its text, its links. */
function codeOf(item: Item): string {
  const { id: _id, [CONFORMANCE_TESTS]: _conformance, [ACCEPTANCE_TESTS]: _acceptance, regenerate_again: _again, ...rest } = item;
  return stable({ ...rest, markdown: String(rest.markdown ?? "").trim() });
}

const scenariosOf = (item: Item | undefined, key: string): Scenario[] => (item?.[key] as Scenario[] | undefined) ?? [];

/** A scenario as it reads, but its scenario-id: its text and its links. */
const readsAs = (scenario: Scenario) => stable({ text: scenario.text.trim(), linked_resources: scenario.linked_resources ?? [] });

/** Every scenario of a functional spec, by kind and scenario-id, as it reads. */
function scenarioKeys(item: Item | undefined): string {
  return stable(KINDS.map(([kind, key]) => scenariosOf(item, key).map((scenario) => `${kind} ${scenario.id} ${readsAs(scenario)}`).sort()));
}

const sectionOf = (tree: MarshalledPlainSource | null, heading: string): Item[] => ((tree?.[heading] as Item[] | undefined) ?? []).slice();

/**
 * The pure renames from what the code and its tests are built for to the spec now, in the codebase of `module`. `code`
 * and `tests` are its records, `spec` its chain's spec with the scenarios on each functional spec.
 */
export function pureRenames(code: MarshalledPlainSource | null, tests: MarshalledPlainSource | null, spec: MarshalledPlainSource, module: string): Renamed {
  const renames: PureRename[] = [];
  let codeNow = code;
  let testsNow = tests;
  for (const heading of SECTIONS) {
    const own = heading === FUNCTIONAL_REQUIREMENTS;
    const moduleOf = (item: Item) => (own ? module : (item.module ?? ""));
    const key = (item: Item) => `${moduleOf(item)}:${item.id ?? ""}`;
    const built = sectionOf(codeNow, heading);
    const now = sectionOf(spec, heading);
    const tested = sectionOf(testsNow, heading);
    const inSpec = new Set(now.map(key));
    const inCode = new Set(built.map(key));
    const fresh = now.filter((item) => !inCode.has(key(item)));
    const taken = new Set<Item>();
    const renamed = new Map<string, string>();
    for (const gone of built.filter((item) => !inSpec.has(key(item)) && !marksRegenerateAgain(item))) {
      const testedItem = tested.find((item) => key(item) === key(gone));
      // Its tests, when it has them, written for it as it is built: the same text, not marked to be written again.
      if (testedItem !== undefined && (marksRegenerateAgain(testedItem) || codeOf(testedItem) !== codeOf(gone))) continue;
      const match = fresh.find(
        (item) =>
          !taken.has(item) &&
          moduleOf(item) === moduleOf(gone) &&
          codeOf(item) === codeOf(gone) &&
          (testedItem !== undefined ? scenarioKeys(testedItem) === scenarioKeys(item) : !hasScenarios(item)),
      );
      if (match === undefined) continue;
      taken.add(match);
      renamed.set(key(gone), match.id ?? "");
      renames.push({ kind: "func-id", module: moduleOf(gone), from: gone.id ?? "", to: match.id ?? "" });
    }
    if (renamed.size > 0) {
      const rename = (item: Item) => (renamed.has(key(item)) ? { ...item, id: renamed.get(key(item)) } : item);
      codeNow = { ...codeNow, [heading]: built.map(rename) };
      if (testsNow !== null) testsNow = { ...testsNow, [heading]: tested.map(rename) };
    }

    // Scenario-ids renamed, under a functional spec whose code and tests are caught up and nothing else of it changed.
    const builtNow = new Map(sectionOf(codeNow, heading).map((item) => [key(item), item]));
    const nowByKey = new Map(now.map((item) => [key(item), item]));
    let changed = false;
    const testedNow = sectionOf(testsNow, heading).map((item) => {
      const current = nowByKey.get(key(item));
      const have = builtNow.get(key(item));
      if (current === undefined || have === undefined || marksRegenerateAgain(item) || marksRegenerateAgain(have)) return item;
      if (codeOf(item) !== codeOf(current) || codeOf(have) !== codeOf(current)) return item;
      const pairs: PureRename[] = [];
      for (const [kind, scenarioKey] of KINDS) {
        const was = scenariosOf(item, scenarioKey);
        const is = scenariosOf(current, scenarioKey);
        const wasIds = new Set(was.map((scenario) => scenario.id));
        const isIds = new Set(is.map((scenario) => scenario.id));
        // A scenario kept under its id must read as it did: one changed is no rename.
        for (const scenario of was) {
          const kept = is.find((other) => other.id === scenario.id);
          if (kept !== undefined && readsAs(kept) !== readsAs(scenario)) return item;
        }
        const removed = was.filter((scenario) => !isIds.has(scenario.id));
        const added = is.filter((scenario) => !wasIds.has(scenario.id));
        if (removed.length !== added.length) return item;
        const used = new Set<Scenario>();
        for (const scenario of removed) {
          const match = added.find((other) => !used.has(other) && readsAs(other) === readsAs(scenario));
          if (match === undefined) return item;
          used.add(match);
          pairs.push({ kind: "scenario-id", module: moduleOf(item), funcId: item.id ?? "", scenario: kind, from: scenario.id, to: match.id });
        }
      }
      if (pairs.length === 0) return item;
      renames.push(...pairs);
      changed = true;
      return { ...item, [CONFORMANCE_TESTS]: current[CONFORMANCE_TESTS], [ACCEPTANCE_TESTS]: current[ACCEPTANCE_TESTS] };
    });
    if (changed && testsNow !== null) testsNow = { ...testsNow, [heading]: testedNow };
  }
  return { renames, code: codeNow, tests: testsNow };
}

/** A rename as a person reads it. */
export function renameText(rename: PureRename): string {
  return rename.kind === "func-id"
    ? `${rename.module}:${rename.from} to ${rename.module}:${rename.to}`
    : `${rename.scenario} scenario ${rename.from} of ${rename.module}:${rename.funcId} to ${rename.to}`;
}

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Where a label's key ends: never inside a longer func-id or scenario-id. */
const END = "(?![a-z0-9_]|-[a-z0-9])";

/** A test file's text with the labels of the renames rewritten to the new names - matched on the whole key. */
export function relabelled(text: string, renames: PureRename[]): string {
  let out = text;
  for (const rename of renames) {
    if (rename.kind === "func-id") {
      const id = "[a-z0-9]+(?:-[a-z0-9]+)*";
      out = out.replace(
        new RegExp(`\\b(conformance tests of|(?:conformance|acceptance) scenario ${id} of) ${escaped(rename.module)}:${escaped(rename.from)}${END}`, "g"),
        `$1 ${rename.module}:${rename.to}`,
      );
    } else {
      out = out.replace(
        new RegExp(`\\b${rename.scenario} scenario ${escaped(rename.from)} of ${escaped(rename.module)}:${escaped(rename.funcId)}${END}`, "g"),
        `${rename.scenario} scenario ${rename.to} of ${rename.module}:${rename.funcId}`,
      );
    }
  }
  return out;
}

/**
 * Make the renames in a codebase, as one unit of work: the code record and the tests record rewritten to the new names,
 * the tests relabelled, committed together - or, failing anywhere, rolled back whole. No agent runs, and the code is not
 * touched. Returns whether it landed.
 */
export function makeRenames(options: { buildDir: string; testsDir: string; moduleName: string; renamed: Renamed; place?: LedgerPlace }): boolean {
  const { buildDir, testsDir, moduleName, renamed } = options;
  if (renamed.renames.length === 0) return true;
  const said = renamed.renames.map(renameText).join(", ");
  const unit = startWork([buildDir, testsDir], moduleName);
  try {
    if (renamed.code !== null) writeCodeRecord(buildDir, renamed.code);
    if (renamed.tests !== null) writeTestsRecord(testsDir, renamed.tests);
    for (const file of listFiles(testsDir)) {
      const path = join(testsDir, file);
      const text = readFileSync(path, "utf8");
      const now = relabelled(text, renamed.renames);
      if (now !== text) writeFileSync(path, now);
    }
    const subject = `renamed ${said}`;
    landWork(buildDir, subject);
    if (moduleDirOf(buildDir) !== moduleDirOf(testsDir)) landWork(testsDir, subject);
  } catch (error) {
    abandonWork(unit, moduleName, `renaming ${said} failed: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
  for (const rename of renamed.renames) record({ kind: "loop.renamed", what: rename.kind, from: rename.from, to: rename.to, spec: rename.kind === "func-id" ? `${rename.module}:${rename.to}` : `${rename.module}:${rename.funcId}` }, options.place);
  reportActivity(`  ${moduleName}: renamed ${said} - the records and the tests' labels, nothing regenerated`);
  return true;
}
