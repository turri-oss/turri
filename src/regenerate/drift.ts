import { DEFAULT_CONCEPTS, extractConceptsFromDefinition, extractConceptsFromSpecText } from "../plain/concepts.ts";
import { ACCEPTANCE_TESTS, CONFORMANCE_TESTS, DEFINITIONS, FUNCTIONAL_REQUIREMENTS, REQUIRED_FUNCTIONAL_SPECS, type MarshalledPlainSource } from "../plain/spec.ts";
import { codeTree, conformanceTarget, marksRegenerateAgain } from "./records.ts";
import { applyChanges, changesBetween, isMove, parseTree, resourcesChanged, serializeTree, type SpecChange } from "./spec-steps.ts";

/**
 * The work, derived from the records - see docs/regenerating.md. Nothing here is stored: what is left
 * to build is the difference between what a record says is built and what the spec says now, worked
 * out again whenever either changes.
 *
 * - Code work: from the code record to the spec as the code sees it.
 * - Conformance work: from the tests record to what the conformance tests are to be written for now -
 *   the functional specs the code is built from that have scenarios.
 *
 * A job is a set of those changes. What it tells its agents follows from the functional specs it
 * touches - its cases - and a running job is stopped once the spec no longer wants what it makes.
 */

/** Everything left to build in the code: from what the code record says it is built from, to the spec now. */
export function codeWork(record: MarshalledPlainSource | null, spec: MarshalledPlainSource): SpecChange[] {
  return changesBetween(serializeTree(codeTree(record ?? {})), serializeTree(codeTree(spec)));
}

/** Everything left to do in the conformance tests: from what the tests record says they are written for, to what they are to be now. */
export function conformanceWork(tests: MarshalledPlainSource | null, code: MarshalledPlainSource | null, spec: MarshalledPlainSource): SpecChange[] {
  return changesBetween(serializeTree(tests ?? {}), serializeTree(conformanceTarget(code, tests, spec)));
}

/**
 * A functional spec a job touches: its func-id, its first line, and the module it belongs to - a func-id is unique in its
 * module, so a func-id alone can mean two.
 */
export interface TouchedSpec {
  funcId: string;
  text: string;
  module?: string;
}

/**
 * What a job does to the functional specs, and so what its agents are told:
 *
 * - fresh: the module requires none and nothing is built - the project is set up first.
 * - add: functional specs that are new - a func-id the spec did not have.
 * - patch: functional specs changed - their text, their scenarios, or a concept they use: a
 *   change to what is built, never built again from scratch. A functional spec moved, and nothing else, is none.
 * - again: functional specs marked to regenerate again (`regenerate` with functionalities named): their code is built, and is regenerated again - rewritten
 *   or started over, doing what the spec says now - with what it replaces taken out.
 * - delete: functional specs taken out - a func-id the spec no longer has. One renamed is a delete and an add.
 * - mechanical: none of those - no functional spec of any module of the chain touched: only reqs, or definitions no
 *   functional spec uses. Existing tests may change only mechanically, and no new ones are written.
 *
 * The functional specs of the modules below are cased as the codebase's own are, each with its module: the codebase at
 * the tip of a chain holds their code. A job can hold several of add, patch and delete at once: its prompt has a section
 * for each.
 */
export interface JobCases {
  fresh: boolean;
  add: TouchedSpec[];
  patch: TouchedSpec[];
  again: TouchedSpec[];
  delete: TouchedSpec[];
  mechanical: boolean;
  /**
   * A conformance job's: each functional spec it touches, its scenarios by case - in the order of add, patch, again and
   * delete. None for a code job: the code record holds no scenario.
   */
  scenarios?: ScenarioCases[];
}

/** A scenario as a conformance job names it: its kind, its scenario-id, its text. */
export interface ScenarioRef {
  kind: "conformance" | "acceptance";
  id: string;
  text: string;
}

/**
 * What a conformance job does to the tests of one functional spec, scenario by scenario - compared with the tests record
 * by kind and scenario-id, as functional specs are by func-id:
 *
 * - added: write its tests; changed: rewrite them to the scenario as it reads now; removed: delete the tests labelled
 *   with it; unchanged: its tests stay as they are.
 * - A scenario-id renamed, or a scenario moved between conformance and acceptance - its label changes - is one removed
 *   and one added. One moved between test plain files of the same functional spec is nothing.
 * - `codeChanged`: the functional spec's code moved under its unchanged scenarios - its text or a file it links changed
 *   (`text`), it was regenerated again (`again`), or a concept it uses changed (`concept`): their tests are run on the
 *   new code, and those that fail are fixed against the scenario.
 */
export interface ScenarioCases extends TouchedSpec {
  added: ScenarioRef[];
  changed: ScenarioRef[];
  removed: ScenarioRef[];
  unchanged: ScenarioRef[];
  codeChanged?: "text" | "again" | "concept";
}

type ScenarioCarrier = FunctionalItem & { [CONFORMANCE_TESTS]?: Array<{ id: string; text: string; linked_resources?: unknown }>; [ACCEPTANCE_TESTS]?: Array<{ id: string; text: string; linked_resources?: unknown }> };

/** Whether an item of a tree carries scenarios - a tree of the conformance tests' - rather than being the code's. */
const carriesScenarios = (item: FunctionalItem | undefined): boolean => item !== undefined && (CONFORMANCE_TESTS in item || ACCEPTANCE_TESTS in item);

/** Every scenario of an item, by its kind and scenario-id. */
function scenariosIn(item: ScenarioCarrier | undefined): Map<string, ScenarioRef & { line: string }> {
  const found = new Map<string, ScenarioRef & { line: string }>();
  for (const kind of ["conformance", "acceptance"] as const) {
    for (const scenario of (item?.[kind === "conformance" ? CONFORMANCE_TESTS : ACCEPTANCE_TESTS] ?? [])) {
      found.set(`${kind} ${scenario.id}`, { kind, id: scenario.id, text: scenario.text, line: JSON.stringify([scenario.text.trim(), scenario.linked_resources ?? []]) });
    }
  }
  return found;
}

/** What of a functional spec the code is built from: everything but its scenarios. */
function codeOf(item: FunctionalItem | undefined): string {
  if (item === undefined) return "";
  const { [CONFORMANCE_TESTS]: _conformance, [ACCEPTANCE_TESTS]: _acceptance, regenerate_again: _again, ...rest } = item as ScenarioCarrier & { regenerate_again?: unknown };
  return JSON.stringify({ ...rest, markdown: rest.markdown.trim() });
}

/** A functional spec's scenarios by case, from the item its tests were written for to the one they are to be. */
function scenarioCasesOf(spec: TouchedSpec, was: FunctionalItem | undefined, is: FunctionalItem | undefined, code?: ScenarioCases["codeChanged"]): ScenarioCases {
  const before = scenariosIn(was);
  const after = scenariosIn(is);
  const plain = ({ kind, id, text }: ScenarioRef & { line: string }): ScenarioRef => ({ kind, id, text });
  const cases: ScenarioCases = { ...spec, added: [], changed: [], removed: [], unchanged: [] };
  for (const [key, scenario] of after) {
    const old = before.get(key);
    if (old === undefined) cases.added.push(plain(scenario));
    else if (old.line !== scenario.line) cases.changed.push(plain(scenario));
    else cases.unchanged.push(plain(scenario));
  }
  for (const [key, scenario] of before) if (!after.has(key)) cases.removed.push(plain(scenario));
  const moved = code ?? (was !== undefined && is !== undefined && codeOf(was) !== codeOf(is) ? "text" : undefined);
  return moved !== undefined && cases.unchanged.length > 0 ? { ...cases, codeChanged: moved } : cases;
}

interface FunctionalItem {
  id: string;
  markdown: string;
  module?: string;
}

const functionalSpecs = (tree: MarshalledPlainSource): FunctionalItem[] => (tree[FUNCTIONAL_REQUIREMENTS] as FunctionalItem[] | undefined) ?? [];
const inheritedSpecs = (tree: MarshalledPlainSource): FunctionalItem[] => (tree[REQUIRED_FUNCTIONAL_SPECS] as FunctionalItem[] | undefined) ?? [];

const firstLine = (markdown: string) => markdown.trim().split("\n")[0]!.trim();

/** An item of a serialized tree, read back. */
const itemOfLine = (line: string | undefined): FunctionalItem | undefined => {
  if (line === undefined) return undefined;
  try {
    return JSON.parse(line) as FunctionalItem;
  } catch {
    return undefined;
  }
};

/** The concept a definition defines, from its text. */
const definedBy = (markdown: string): string[] => extractConceptsFromDefinition(markdown)[0];

/** The concepts a text names, the predefined ones left out. */
const namedIn = (text: string): string[] => extractConceptsFromSpecText(text).filter((concept) => !DEFAULT_CONCEPTS.has(concept));

/**
 * Every concept a functional spec uses: those its text names, and those their definitions name in
 * turn, as far as it goes.
 */
export function conceptsUsed(markdown: string, definitions: Array<{ markdown: string }>): Set<string> {
  const byConcept = new Map<string, string>();
  for (const definition of definitions) for (const concept of definedBy(definition.markdown)) byConcept.set(concept, definition.markdown);
  const used = new Set<string>();
  const visit = (text: string) => {
    for (const concept of namedIn(text)) {
      if (used.has(concept)) continue;
      used.add(concept);
      const definition = byConcept.get(concept);
      if (definition !== undefined) visit(definition);
    }
  };
  visit(markdown);
  return used;
}

/**
 * The cases of a job: `before` is the tree it starts from - the record, or what the jobs ahead of it
 * leave - and `changes` the changes it makes, found from `before`. `fresh`: the module requires none
 * and nothing is built.
 *
 * A functional spec is patched when its item changed, or when a concept it uses - as the spec after
 * the job defines it, or as it was defined before - is defined anew, changed or taken out by the job.
 * `module`: the module whose codebase it is - its own functional specs are that module's.
 */
export function casesOf(before: MarshalledPlainSource, changes: SpecChange[], options: { fresh?: boolean; module?: string } = {}): JobCases {
  const beforeText = serializeTree(before);
  const after = parseTree(applyChanges(beforeText, changes));
  const own = options.module !== undefined ? { module: options.module } : {};
  const touchedOf = (item: FunctionalItem, required: boolean): TouchedSpec => ({
    funcId: item.id,
    text: firstLine(item.markdown),
    ...(required ? (item.module !== undefined ? { module: item.module } : {}) : own),
  });
  const add: TouchedSpec[] = [];
  const patch: TouchedSpec[] = [];
  const again: TouchedSpec[] = [];
  const removed: TouchedSpec[] = [];
  /** Each functional spec touched, as the tests record has it and as it is to be: its scenarios' cases are worked out from them. */
  const items = new Map<string, { was?: FunctionalItem; is?: FunctionalItem }>();
  const keyOf = (spec: TouchedSpec) => `${spec.module ?? ""}:${spec.funcId}`;
  const seen = (spec: TouchedSpec, was: FunctionalItem | undefined, is: FunctionalItem | undefined) => {
    items.set(keyOf(spec), { ...(was !== undefined ? { was } : {}), ...(is !== undefined ? { is } : {}) });
    return spec;
  };
  for (const change of changes) {
    // A module below's functional specs are cased as the codebase's own are: the codebase at the tip holds their code.
    if (change.section !== FUNCTIONAL_REQUIREMENTS && change.section !== REQUIRED_FUNCTIONAL_SPECS) continue;
    const required = change.section === REQUIRED_FUNCTIONAL_SPECS;
    const was = itemOfLine(change.before);
    const is = itemOfLine(change.after);
    // Marked to regenerate again: regenerated again, whatever else changed in its text - its own or, required, another module's.
    if (change.kind === "change" && is !== undefined && marksRegenerateAgain(was)) {
      again.push(seen(touchedOf(is, required), was, is));
      continue;
    }
    // Moved, and nothing else: none.
    if (isMove(change)) continue;
    if (change.kind === "add" && is !== undefined) add.push(seen(touchedOf(is, required), undefined, is));
    else if (change.kind === "remove" && was !== undefined) removed.push(seen(touchedOf(was, required), was, undefined));
    else if (change.kind === "change" && is !== undefined) patch.push(seen(touchedOf(is, required), was, is));
  }

  // The concepts the job defines anew, changes or takes out.
  const redefined = new Set<string>();
  for (const change of changes) {
    if (change.section !== DEFINITIONS) continue;
    for (const line of [change.before, change.after]) {
      const item = itemOfLine(line);
      if (item !== undefined) for (const concept of definedBy(item.markdown)) redefined.add(concept);
    }
  }
  // Every functional spec of the chain, as it is after the job and as it was: those of the modules below, then the
  // codebase's own - the order every case lists them in.
  const chainOf = (tree: MarshalledPlainSource) => [...inheritedSpecs(tree).map((item) => ({ item, required: true })), ...functionalSpecs(tree).map((item) => ({ item, required: false }))];
  const chain = chainOf(after);
  if (redefined.size > 0) {
    const touched = new Set([...add, ...patch, ...again].map(keyOf));
    const definitionsAfter = (after[DEFINITIONS] as Array<{ markdown: string }> | undefined) ?? [];
    const definitionsBefore = (before[DEFINITIONS] as Array<{ markdown: string }> | undefined) ?? [];
    for (const { item, required } of chain) {
      const spec = touchedOf(item, required);
      if (touched.has(keyOf(spec))) continue;
      const uses = new Set([...conceptsUsed(item.markdown, definitionsAfter), ...conceptsUsed(item.markdown, definitionsBefore)]);
      if ([...redefined].some((concept) => uses.has(concept))) patch.push(seen(spec, item, item));
    }
  }
  // In the chain's order: one taken out where it was.
  const orderIn = (specs: Array<{ item: FunctionalItem; required: boolean }>) => new Map(specs.map(({ item, required }, index) => [keyOf(touchedOf(item, required)), index]));
  const inOrder = (list: TouchedSpec[], order: Map<string, number>) => list.sort((a, b) => (order.get(keyOf(a)) ?? Number.MAX_SAFE_INTEGER) - (order.get(keyOf(b)) ?? Number.MAX_SAFE_INTEGER));
  const order = orderIn(chain);
  for (const list of [add, patch, again]) inOrder(list, order);
  inOrder(removed, orderIn(chainOf(before)));

  // The conformance tests' trees carry the scenarios: each functional spec touched, scenario by scenario.
  const touchedItems = [...items.values()];
  const scenarios = touchedItems.some(({ was, is }) => carriesScenarios(was) || carriesScenarios(is))
    ? [
        ...add.map((spec) => scenarioCasesOf(spec, undefined, items.get(keyOf(spec))?.is)),
        ...patch.map((spec) => {
          const { was, is } = items.get(keyOf(spec)) ?? {};
          return scenarioCasesOf(spec, was, is, was === is ? "concept" : undefined);
        }),
        ...again.map((spec) => scenarioCasesOf(spec, items.get(keyOf(spec))?.was, items.get(keyOf(spec))?.is, "again")),
        ...removed.map((spec) => scenarioCasesOf(spec, items.get(keyOf(spec))?.was, undefined)),
      ]
    : undefined;
  return {
    fresh: options.fresh === true,
    add,
    patch,
    again,
    delete: removed,
    mechanical: add.length === 0 && patch.length === 0 && again.length === 0 && removed.length === 0,
    ...(scenarios !== undefined ? { scenarios } : {}),
  };
}

/** Two changes are the same change when they do the same to the same item. */
function sameChange(a: SpecChange, b: SpecChange): boolean {
  return a.section === b.section && a.kind === b.kind && (a.before ?? "") === (b.before ?? "") && (a.after ?? "") === (b.after ?? "");
}

/**
 * Whether a running job may finish: every change it makes is still part of the work as it is now -
 * both measured from the same record, which nothing changes while the job runs. When one is not, the
 * job is making something the spec no longer wants, and it is stopped and rolled back.
 */
/**
 * Why a running job is no longer wanted, in a line: the files it links that hold something else now - the commonest
 * cause, a resource edited while the job regenerated from it - else the items whose text changed under it, by section
 * and place.
 */
export function whyNotWanted(running: SpecChange[], work: SpecChange[]): string {
  const taken = new Set<number>();
  const gone = running.filter((mine) => {
    const at = work.findIndex((change, index) => !taken.has(index) && sameChange(mine, change));
    if (at === -1) return true;
    taken.add(at);
    return false;
  });
  const files = new Set<string>();
  const items: string[] = [];
  for (const mine of gone) {
    // The same item as the spec has it now: by section and place.
    const now = work.find((change) => change.section === mine.section && change.position === mine.position);
    const changedFiles = now !== undefined ? resourcesChanged(mine.after, now.after).map((resource) => resource.target) : [];
    if (changedFiles.length > 0) changedFiles.forEach((file) => files.add(file));
    else items.push(`${mine.section} ${mine.position}`);
  }
  const parts = [
    ...(files.size > 0 ? [`${[...files].join(", ")} ${files.size === 1 ? "holds" : "hold"} something else now`] : []),
    ...(items.length > 0 ? [`${items.join(", ")} ${items.length === 1 ? "reads" : "read"} otherwise now`] : []),
  ];
  return parts.length > 0 ? parts.join("; ") : "the spec it was building from changed";
}

export function stillWanted(running: SpecChange[], work: SpecChange[]): boolean {
  const taken = new Set<number>();
  return running.every((mine) => {
    const at = work.findIndex((change, index) => !taken.has(index) && sameChange(mine, change));
    if (at === -1) return false;
    taken.add(at);
    return true;
  });
}
