import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  ACCEPTANCE_TESTS,
  CONFORMANCE_TESTS,
  DEFINITIONS,
  FUNCTIONAL_REQUIREMENTS,
  NON_FUNCTIONAL_REQUIREMENTS,
  REQUIRED_FUNCTIONAL_SPECS,
  TEST_PLAIN_FILES,
  TEST_REQUIREMENTS,
  type MarshalledPlainSource,
  type SpecificationItem,
} from "../plain/spec.ts";
import { committedText } from "./lineage.ts";

/**
 * What a module is built from, in two records - see docs/regenerating.md.
 *
 * - The code record, `code/.turri.json`: the spec the code is built from, without what is only
 *   for conformance - the test reqs, the test plain files, and each functional spec's scenarios.
 * - The tests record, `tests/.turri.json`: the functional specs the conformance tests are
 *   written for - a subset of the code record's, each with its func-id and its scenarios - the
 *   definitions and implementation reqs they were written against, and the test reqs they follow.
 *
 * A functional spec is known by its func-id - with its module, for one a module below has - in both: a record
 * written when functional specs were numbered is old (`isOldRecord`), and its codebase is regenerated from scratch.
 *
 * The tests record is always a substate of the code record: a conformance test exercises
 * functionality, and only functionality in the code can be tested. Each record is committed with
 * what it describes, in the module's `.plaingit`, so rolling a unit of work back puts it back too.
 */

// Defined beside the paths, which import nothing of turri's: what reads it as it loads - testing.ts - never waits on this module.
export { RECORD_FILE } from "./paths.ts";
import { RECORD_FILE } from "./paths.ts";

/**
 * A functional spec in the code record marked to regenerate again: its code is built, and is to be regenerated again
 * all the same - `regenerate` with functionalities named. The mark makes the record differ from the spec at that item,
 * so the work loop plans it as it plans any change, and the job that regenerates it writes the item back without it.
 */
export const REGENERATE_AGAIN = "regenerate_again";

/** Whether a record's item is marked to regenerate again. */
export function marksRegenerateAgain(item: unknown): boolean {
  return typeof item === "object" && item !== null && (item as Record<string, unknown>)[REGENERATE_AGAIN] === true;
}

type Item = SpecificationItem & { id?: string; module?: string; [CONFORMANCE_TESTS]?: unknown[]; [ACCEPTANCE_TESTS]?: unknown[] };

const itemsOf = (tree: MarshalledPlainSource | null | undefined, heading: string): Item[] => ((tree?.[heading] as Item[] | undefined) ?? []).slice();

/** A tree without the sections it has nothing in, as the parser leaves them out. */
function withoutEmpty(tree: MarshalledPlainSource): MarshalledPlainSource {
  return Object.fromEntries(Object.entries(tree).filter(([, value]) => !Array.isArray(value) || value.length > 0));
}

/** A functional spec as the code sees it: without its scenarios, which are the conformance tests' alone. */
function withoutScenarios(item: Item): Item {
  const { [CONFORMANCE_TESTS]: _conformance, [ACCEPTANCE_TESTS]: _acceptance, ...rest } = item;
  return rest;
}

/** The spec as the code is built from it: no test reqs, no test plain files, and no scenarios on the functional specs. */
export function codeTree(tree: MarshalledPlainSource): MarshalledPlainSource {
  const { [TEST_REQUIREMENTS]: _testReqs, [TEST_PLAIN_FILES]: _testPlainFiles, ...rest } = tree;
  return withoutEmpty({
    ...rest,
    [FUNCTIONAL_REQUIREMENTS]: itemsOf(tree, FUNCTIONAL_REQUIREMENTS).map(withoutScenarios),
    [REQUIRED_FUNCTIONAL_SPECS]: itemsOf(tree, REQUIRED_FUNCTIONAL_SPECS).map(withoutScenarios),
  });
}

/** A functional spec's identity in a tree: its func-id, with its module for one a module below has. */
export function identityOf(item: { id?: string; module?: string }): string {
  return `${item.module ?? ""}:${item.id ?? ""}`;
}

/** A linked resource as the trees compared have it: its link, and the hash of what its file holds. */
interface DigestedResource {
  text: string;
  target: string;
  digest?: string;
}

/** Every linked resource in a tree, wherever an item has them - a functional spec, its acceptance tests, a definition, a req. */
function mapResources(value: unknown, map: (resource: DigestedResource) => DigestedResource): unknown {
  if (Array.isArray(value)) return value.map((entry) => mapResources(entry, map));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) =>
      key === "linked_resources" && Array.isArray(entry) ? [key, (entry as DigestedResource[]).map(map)] : [key, mapResources(entry, map)],
    ),
  );
}

/**
 * A module's tree with the hash of each linked resource's content beside its link: the file is part of the spec,
 * so a change to what it holds is a change to the item that links it - and, a definition linking it, to every
 * functional spec using the concept. Found as the parser finds it: the spec's own folder first, then the other
 * template folders, then the current directory.
 */
export function withResourceDigests(tree: MarshalledPlainSource, dirs: string[]): MarshalledPlainSource {
  return mapResources(tree, (resource) => {
    for (const path of [...dirs.map((dir) => resolve(dir, resource.target)), resolve(resource.target)]) {
      try {
        return { ...resource, digest: createHash("sha256").update(readFileSync(path)).digest("hex") };
      } catch {
        /* not here */
      }
    }
    return resource;
  }) as MarshalledPlainSource;
}

/**
 * A record written before linked resources were hashed, with the hashes of `spec` where its links are the same:
 * what it was built from is taken to be the resource as it is now, rather than every item linking one built again.
 */
export function adoptDigests(record: MarshalledPlainSource | null, spec: MarshalledPlainSource): MarshalledPlainSource | null {
  if (record === null) return null;
  const digests = new Map<string, string>();
  mapResources(spec, (resource) => {
    if (resource.digest !== undefined) digests.set(`${resource.text}\n${resource.target}`, resource.digest);
    return resource;
  });
  return mapResources(record, (resource) => {
    if (resource.digest !== undefined) return resource;
    const digest = digests.get(`${resource.text}\n${resource.target}`);
    return digest === undefined ? resource : { ...resource, digest };
  }) as MarshalledPlainSource;
}

/** Items of a section, tagged with the module they come from, unless they already say. */
const taggedWith = (items: Item[], module: string): Item[] => items.map((item) => (item.module !== undefined ? item : { ...item, module }));

/**
 * The spec a codebase is built from: the spec of its whole requires chain, as its code holds it. A
 * codebase is built on the code of the modules below it, so its code implements their definitions and
 * implementation reqs too: those come tagged with their module, bottom of the chain first, and the
 * module's own untagged after them. An item a lower module already has - the same text, from an import
 * they share - is not the module's own again: its code implements it already. The functional specs of the
 * modules below are the ones it inherits, as the parser gives them; its test reqs are its own.
 *
 * `trees`: every module of the chain, bottom first - the module itself last.
 */
export function chainTree(trees: Array<{ module: string; tree: MarshalledPlainSource }>): MarshalledPlainSource {
  const own = trees.at(-1);
  if (own === undefined) return {};
  const lower = trees.slice(0, -1);
  const section = (heading: string): Item[] => {
    const seen = new Set<string>();
    const out: Item[] = [];
    for (const { module, tree } of lower) {
      for (const item of taggedWith(itemsOf(tree, heading), module)) {
        const text = item.markdown.trim();
        if (seen.has(text)) continue;
        seen.add(text);
        out.push(item);
      }
    }
    for (const item of itemsOf(own.tree, heading)) if (!seen.has(item.markdown.trim())) out.push(item);
    return out;
  };
  return withoutEmpty({
    ...own.tree,
    [DEFINITIONS]: section(DEFINITIONS),
    [NON_FUNCTIONAL_REQUIREMENTS]: section(NON_FUNCTIONAL_REQUIREMENTS),
  });
}

/**
 * What a new module's codebase starts from, copied from the code of the module it requires: that module's
 * record, as a lower module's - its own definitions and implementation reqs tagged with it, its functional
 * specs among the ones inherited. The new module has built nothing of its own yet.
 */
export function inheritedRecord(source: MarshalledPlainSource, sourceModule: string): MarshalledPlainSource {
  const inherited = [
    ...itemsOf(source, REQUIRED_FUNCTIONAL_SPECS),
    ...itemsOf(source, FUNCTIONAL_REQUIREMENTS).map((item) => ({ ...withoutScenarios(item), module: sourceModule })),
  ];
  return withoutEmpty({
    [DEFINITIONS]: taggedWith(itemsOf(source, DEFINITIONS), sourceModule),
    [NON_FUNCTIONAL_REQUIREMENTS]: taggedWith(itemsOf(source, NON_FUNCTIONAL_REQUIREMENTS), sourceModule),
    [REQUIRED_FUNCTIONAL_SPECS]: inherited,
  });
}

/** Which functional specs are to have conformance tests, by func-id. Default: every one. */
export type Chosen = (funcId: string) => boolean;

/**
 * What the conformance tests are to be written for, now: of the functional specs the code is built
 * from, those chosen, each as the spec has it now with its scenarios - and the code's
 * definitions and implementation reqs, with the test reqs as the spec has them now. In the spec's order, a functional
 * spec matched to the code and the tests by its func-id.
 *
 * Conformance follows the code, never goes ahead of it: a functional spec whose code is not caught up
 * with the spec - its text in the code record is not the spec's, the code record does not have it at
 * all, or has it marked to regenerate again - stays as the tests record has it, until the code lands. Its tests are
 * taken out only once the spec and the code have both dropped it. Tests marked to regenerate again with their code
 * (`regenerateAgain`) differ from the target once the code lands: written against the code it replaced, they are
 * conformance work again, though the spec's text never changed.
 */
export function conformanceTarget(code: MarshalledPlainSource | null, tests: MarshalledPlainSource | null, spec: MarshalledPlainSource, chosen: Chosen = () => true): MarshalledPlainSource {
  const built = new Map(itemsOf(code, FUNCTIONAL_REQUIREMENTS).map((item) => [item.id, item]));
  const now = itemsOf(spec, FUNCTIONAL_REQUIREMENTS);
  const inSpec = new Set(now.map((item) => item.id));
  const tested = itemsOf(tests, FUNCTIONAL_REQUIREMENTS);
  const testedById = new Map(tested.map((item) => [item.id, item]));
  const specs: Item[] = [];
  for (const current of now) {
    const have = built.get(current.id);
    if (have !== undefined && have.markdown.trim() === current.markdown.trim() && !marksRegenerateAgain(have)) {
      if (chosen(current.id ?? "")) specs.push(current);
      continue;
    }
    // The code is behind the spec here - built from other text, not built, or being regenerated again: its tests stay
    // as they are until it catches up.
    const kept = testedById.get(current.id);
    if (kept !== undefined) specs.push(kept);
  }
  // Taken out of the spec, its tests go once the code has dropped it too.
  for (const kept of tested) if (!inSpec.has(kept.id) && built.has(kept.id)) specs.push(kept);
  return withoutEmpty({
    [DEFINITIONS]: itemsOf(code, DEFINITIONS),
    [NON_FUNCTIONAL_REQUIREMENTS]: itemsOf(code, NON_FUNCTIONAL_REQUIREMENTS),
    [TEST_REQUIREMENTS]: itemsOf(spec, TEST_REQUIREMENTS),
    [FUNCTIONAL_REQUIREMENTS]: specs,
  });
}

/**
 * Of the functional specs given, by func-id, those the code record does not have as `tree` has them - not built,
 * or built from other text: no conformance test can be written for them yet. `tree` is a spec, or what conformance
 * tests are written for.
 */
export function notBuilt(code: MarshalledPlainSource | null, tree: MarshalledPlainSource, funcIds: string[]): string[] {
  const built = new Map(itemsOf(code, FUNCTIONAL_REQUIREMENTS).map((item) => [item.id, item]));
  const wanted = new Map(itemsOf(tree, FUNCTIONAL_REQUIREMENTS).map((item) => [item.id, item]));
  return funcIds.filter((funcId) => {
    const item = wanted.get(funcId);
    const have = built.get(funcId);
    return item === undefined || have === undefined || have.markdown.trim() !== item.markdown.trim();
  });
}

/**
 * Whether a record was written when functional specs were numbered, before they had func-ids: a functional spec without
 * one, or one a module below has named by its number. Nothing is built on such a record - the codebase is regenerated
 * from scratch, with its chain, once the person agrees.
 */
export function isOldRecord(record: MarshalledPlainSource | null): boolean {
  if (record === null) return false;
  if ((record as { [OLD]?: boolean })[OLD] === true) return true;
  const items = [...itemsOf(record, FUNCTIONAL_REQUIREMENTS), ...itemsOf(record, REQUIRED_FUNCTIONAL_SPECS)];
  return items.some((item) => typeof item.id !== "string" || "frid" in item);
}

/** What an older layout of a record is read as: old, and nothing else of it. */
const OLD = "old record";

/** A record's text as the tree it holds - an older layout as an old record - or null when it is not one. */
function readRecordText(text: string | undefined): MarshalledPlainSource | null {
  if (text === undefined) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  // A layout from before the tree was all a record held: older still than numbered functional specs.
  if (typeof (raw as { version?: unknown }).version === "number" || "functionalities" in raw) return { [OLD]: true };
  return raw as MarshalledPlainSource;
}

function readFileText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * A record in `dir`: as the module's last commit has it, by default - what the harness itself wrote
 * when the last unit of work landed, never what an agent's shell changed since - or, with `onDisk`,
 * the file as it is. Null when there is none.
 */
export function readRecord(dir: string, options: { onDisk?: boolean } = {}): MarshalledPlainSource | null {
  const committed = options.onDisk === true ? undefined : committedText(dir, RECORD_FILE);
  return readRecordText(committed ?? readFileText(join(dir, RECORD_FILE)));
}

/** Write the code record: the tree, as the code sees it. */
export function writeCodeRecord(codeDir: string, tree: MarshalledPlainSource): void {
  mkdirSync(codeDir, { recursive: true });
  writeFileSync(join(codeDir, RECORD_FILE), `${JSON.stringify(codeTree(tree), null, 2)}\n`);
}

/** Write the tests record: a conformance target, as it now is built. */
export function writeTestsRecord(testsDir: string, tree: MarshalledPlainSource): void {
  mkdirSync(testsDir, { recursive: true });
  writeFileSync(join(testsDir, RECORD_FILE), `${JSON.stringify(withoutEmpty(tree), null, 2)}\n`);
}
