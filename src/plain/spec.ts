import { createHash } from "node:crypto";
import { InvalidFridArgument } from "./errors.ts";
import type { LinkedResource } from "./markdown.ts";

/**
 * Port of plain_spec.py. The reference keeps its names for a functional spec's id - `frid`, `get_frids` - and so do
 * the ports here: a frid is the functional spec's func-id, the `# <func-id>` heading it is written under.
 */

export const DEFINITIONS = "definitions";
export const NON_FUNCTIONAL_REQUIREMENTS = "implementation reqs";
export const TEST_REQUIREMENTS = "test reqs";
export const FUNCTIONAL_REQUIREMENTS = "functional specs";
export const CONFORMANCE_TESTS = "conformance_tests";
export const ACCEPTANCE_TESTS = "acceptance_tests";
export const CONFORMANCE_TEST_HEADING = "conformance tests";
export const ACCEPTANCE_TEST_HEADING = "acceptance tests";
/**
 * Where a module's tree carries the functional specs it inherits through `requires`: every
 * functional spec of every module it requires, transitively, bottom of the chain first, each
 * with its module. turri's, not the reference parser's.
 */
export const REQUIRED_FUNCTIONAL_SPECS = "required functional specs";
/**
 * Where a module's tree carries the test plain files bound to its chain, as the reference's parse output has them
 * (`test_plain_files`): each file's path, from the module's folder, to the functional spec it binds to. turri's.
 */
export const TEST_PLAIN_FILES = "test plain files";

/** The sections whose content is a list of `- ` items. */
export const LIST_SECTION_HEADINGS = [DEFINITIONS, NON_FUNCTIONAL_REQUIREMENTS, TEST_REQUIREMENTS];

export const ALLOWED_SPECIFICATION_HEADINGS = [...LIST_SECTION_HEADINGS, FUNCTIONAL_REQUIREMENTS];

export const ALLOWED_IMPORT_SPECIFICATION_HEADINGS = LIST_SECTION_HEADINGS;

/**
 * A func-id or scenario-id: segments of lowercase letters and digits, with one hyphen between segments. So a hyphen
 * never starts or ends an id, two hyphens never touch, and an id is never only hyphens.
 */
export const SEMANTIC_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isSemanticId(text: string): boolean {
  return SEMANTIC_ID_PATTERN.test(text);
}

export interface CodeVariable {
  name: string;
  value: string;
}

/** An item of a list section: definitions, implementation reqs, test reqs. */
export interface SpecificationItem {
  markdown: string;
  linked_resources?: LinkedResource[];
  code_variables?: CodeVariable[];
}

/** A conformance or acceptance scenario, bound to its functional spec from a test plain file. */
export interface ScenarioItem {
  id: string;
  text: string;
  linked_resources: LinkedResource[];
  code_variables?: CodeVariable[];
}

/** A functional spec: its func-id, its body, its links, and the scenarios of its test plain files. */
export interface FunctionalSpecItem {
  id: string;
  markdown: string;
  linked_resources: LinkedResource[];
  [CONFORMANCE_TESTS]: ScenarioItem[];
  [ACCEPTANCE_TESTS]: ScenarioItem[];
  code_variables?: CodeVariable[];
}

/** A functional spec inherited through `requires`, with the module it belongs to. */
export interface InheritedSpecificationItem extends FunctionalSpecItem {
  module: string;
}

/** What `TEST_PLAIN_FILES` holds for each test plain file: the functional spec it binds to. */
export interface TestPlainFileBinding {
  module: string;
  func_id: string;
}

/** A scenario as it is regenerated with: its scenario-id and its text, code variables put in place. */
export interface ScenarioText {
  id: string;
  text: string;
}

/**
 * The functional specs a module inherits through `requires`, rendered: each with its
 * module, its func-id, and its scenarios.
 */
export function getInheritedFunctionalSpecs(
  tree: MarshalledPlainSource,
  replaceCodeVariables = true,
): Array<{ module: string; funcId: string; spec: string; conformanceTests: ScenarioText[]; acceptanceTests: ScenarioText[] }> {
  const items = (tree[REQUIRED_FUNCTIONAL_SPECS] as InheritedSpecificationItem[] | undefined) ?? [];
  return items.map((item) => {
    const codeVariables: Record<string, string> = {};
    const scenarios = (list: ScenarioItem[] | undefined) =>
      (list ?? []).map((scenario) => ({ id: scenario.id, text: getSpecificationItemMarkdown(scenario, codeVariables, replaceCodeVariables, "text") }));
    return {
      module: item.module,
      funcId: item.id,
      spec: getSpecificationItemMarkdown(item, codeVariables, replaceCodeVariables),
      conformanceTests: scenarios(item[CONFORMANCE_TESTS]),
      acceptanceTests: scenarios(item[ACCEPTANCE_TESTS]),
    };
  });
}

/** The marshalled tree: heading -> list of items. Functional specs are named by their func-ids, in file order. */
export interface MarshalledPlainSource {
  [heading: string]: unknown;
}

export function getSpecificationItems(
  tree: MarshalledPlainSource,
  heading: string,
): SpecificationItem[] | undefined {
  const value = tree[heading];
  return Array.isArray(value) ? (value as SpecificationItem[]) : undefined;
}

/** The functional specs of a tree, in file order. */
export function getFunctionalSpecs(tree: MarshalledPlainSource): FunctionalSpecItem[] {
  const value = tree[FUNCTIONAL_REQUIREMENTS];
  return Array.isArray(value) ? (value as FunctionalSpecItem[]) : [];
}

/** True if any functional spec of the tree has acceptance scenarios. */
export function hasAcceptanceTests(tree: MarshalledPlainSource): boolean {
  return getFunctionalSpecs(tree).some((item) => (item[ACCEPTANCE_TESTS] ?? []).length > 0);
}

export interface CollectedLinkedResource extends LinkedResource {
  sections: string[];
}

export function collectSpecificationLinkedResources(
  specification: { linked_resources?: LinkedResource[] },
  specificationHeading: string,
  linkedResourcesList: CollectedLinkedResource[],
): void {
  for (const resource of specification.linked_resources ?? []) {
    let resourceFound = false;
    for (const resourceMap of linkedResourcesList) {
      if (resource.text === resourceMap.text) {
        if (resource.target !== resourceMap.target) {
          throw new Error(
            `The file ${resource.target} is linked to multiple linked resources with the same text: ${resource.text}`,
          );
        }
      } else if (resource.target === resourceMap.target) {
        if (resource.text !== resourceMap.text) {
          throw new Error(
            `The linked resource ${resource.text} is linked to multiple files: ${resourceMap.target}`,
          );
        }
      } else {
        continue;
      }

      if (resourceFound) {
        throw new Error(`Duplicate linked resource found: ${resource.text} (${resource.target})`);
      }

      resourceFound = true;
      resourceMap.sections.push(specificationHeading);
    }

    if (!resourceFound) {
      linkedResourcesList.push({
        text: resource.text,
        target: resource.target,
        sections: [specificationHeading],
      });
    }
  }
}

/**
 * Add the linked resources of the tree to `linkedResourcesList` and sort the list by link text.
 *
 * `specificationsList` limits the sections read; null or empty reads every section. The functional specs are read up
 * to and including `frid`, or all of them when it is null. With `includeTestScenarios` the links of the conformance
 * and acceptance scenarios are added too, for `frid` alone when one is given. Returns true when `frid` was reached.
 */
export function collectLinkedResources(
  tree: MarshalledPlainSource,
  linkedResourcesList: CollectedLinkedResource[],
  specificationsList: string[] | null,
  includeTestScenarios: boolean,
  frid: string | null = null,
): boolean {
  if (tree === null || typeof tree !== "object" || Array.isArray(tree)) {
    throw new TypeError("plain_source_tree must be a dictionary.");
  }

  if (frid !== null && ![...getFrids(tree)].includes(frid)) {
    throw new Error(`frid ${frid} does not exist.`);
  }

  const sectionsToCollect = ALLOWED_SPECIFICATION_HEADINGS.filter(
    (heading) => heading in tree && (!specificationsList || specificationsList.length === 0 || specificationsList.includes(heading)),
  );
  let fridReached = false;
  for (const heading of sectionsToCollect) {
    for (const specification of (tree[heading] as Array<SpecificationItem & Partial<FunctionalSpecItem>>) ?? []) {
      collectSpecificationLinkedResources(specification, heading, linkedResourcesList);

      if (heading !== FUNCTIONAL_REQUIREMENTS) continue;

      if (includeTestScenarios && (frid === null || frid === specification.id)) {
        for (const scenario of [...(specification[CONFORMANCE_TESTS] ?? []), ...(specification[ACCEPTANCE_TESTS] ?? [])]) {
          collectSpecificationLinkedResources(scenario, FUNCTIONAL_REQUIREMENTS, linkedResourcesList);
        }
      }

      if (specification.id === frid) {
        fridReached = true;
        break;
      }
    }
  }

  linkedResourcesList.sort((a, b) => (a.text < b.text ? -1 : a.text > b.text ? 1 : 0));

  return fridReached;
}

/**
 * The FRID iterator: the func-ids of the tree's functional specs, in file order.
 * Everything that walks the spec one functional spec at a time - rendering, ranges, context
 * building - is driven by this.
 */
export function* getFrids(tree: MarshalledPlainSource): Generator<string> {
  for (const functionality of getFunctionalSpecs(tree)) yield functionality.id;
}

export function getFirstFrid(tree: MarshalledPlainSource): string | null {
  const first = getFrids(tree).next();
  return first.done ? null : first.value;
}

export function getNextFrid(tree: MarshalledPlainSource, frid: string): string | null {
  const iterator = getFrids(tree);
  for (const candidate of iterator) {
    if (candidate === frid) {
      const next = iterator.next();
      return next.done ? null : next.value;
    }
  }
  throw new Error(`Functionality ${frid} does not exist.`);
}

export function getPreviousFrid(tree: MarshalledPlainSource, frid: string): string | null {
  let previous: string | null = null;
  for (const candidate of getFrids(tree)) {
    if (candidate === frid) return previous;
    previous = candidate;
  }
  throw new Error(`Functionality ${frid} does not exist.`);
}

/** The func-ids that come before `targetFrid` in the specification, in order. */
export function getFridsBefore(tree: MarshalledPlainSource, targetFrid: string): string[] {
  const before: string[] = [];
  for (const frid of getFrids(tree)) {
    if (frid === targetFrid) break;
    before.push(frid);
  }
  return before;
}

/**
 * The text under `key` of the item, with its code variables recorded in `codeVariables` and, when
 * `replaceCodeVariables` is set, their values put in place of the `{{ name }}` placeholders.
 */
export function getSpecificationItemMarkdown(
  specificationItem: { code_variables?: CodeVariable[] },
  codeVariables: Record<string, string>,
  replaceCodeVariables: boolean,
  key = "markdown",
): string {
  let markdown = String((specificationItem as Record<string, unknown>)[key]);
  for (const codeVariable of specificationItem.code_variables ?? []) {
    if (codeVariable.name in codeVariables) {
      if (codeVariables[codeVariable.name] !== codeVariable.value) {
        throw new Error(
          `Code variable ${codeVariable.name} has multiple values: ${codeVariables[codeVariable.name]} and ${codeVariable.value}`,
        );
      }
    } else {
      codeVariables[codeVariable.name] = codeVariable.value;
    }

    if (replaceCodeVariables) {
      markdown = markdown.split(`{{ ${codeVariable.name} }}`).join(codeVariable.value);
    }
  }
  return markdown;
}

export interface Specifications {
  [DEFINITIONS]: string[];
  [NON_FUNCTIONAL_REQUIREMENTS]: string[];
  [TEST_REQUIREMENTS]: string[];
  [FUNCTIONAL_REQUIREMENTS]: string[];
  [CONFORMANCE_TESTS]: ScenarioText[];
  [ACCEPTANCE_TESTS]: ScenarioText[];
}

/**
 * The specifications that build `frid`: every list section, the functional specs up to and including `frid`, and
 * the conformance and acceptance scenarios of `frid` as `{id, text}` entries.
 *
 * Returns the specifications and the code variables they use (null when there are none). Throws when `frid` is not
 * in the tree.
 */
export function getSpecificationsForFrid(
  tree: MarshalledPlainSource,
  frid: string,
  replaceCodeVariables = true,
): [Specifications, Record<string, string> | null] {
  const functionalities = getFunctionalSpecs(tree);
  const position = functionalities.findIndex((item) => item.id === frid);
  if (position === -1) throw new Error(`Functionality ${frid} does not exist.`);

  const codeVariables: Record<string, string> = {};
  const texts = (items: Array<{ code_variables?: CodeVariable[] }>, key = "markdown") =>
    items.map((item) => getSpecificationItemMarkdown(item, codeVariables, replaceCodeVariables, key));
  const scenarios = (items: ScenarioItem[]) => {
    const scenarioTexts = texts(items, "text");
    return items.map((item, index) => ({ id: item.id, text: scenarioTexts[index]! }));
  };
  const listOf = (heading: string) => getSpecificationItems(tree, heading) ?? [];

  const functionality = functionalities[position]!;
  const specifications: Specifications = {
    [DEFINITIONS]: texts(listOf(DEFINITIONS)),
    [NON_FUNCTIONAL_REQUIREMENTS]: texts(listOf(NON_FUNCTIONAL_REQUIREMENTS)),
    [TEST_REQUIREMENTS]: texts(listOf(TEST_REQUIREMENTS)),
    [FUNCTIONAL_REQUIREMENTS]: texts(functionalities.slice(0, position + 1)),
    [CONFORMANCE_TESTS]: scenarios(functionality[CONFORMANCE_TESTS] ?? []),
    [ACCEPTANCE_TESTS]: scenarios(functionality[ACCEPTANCE_TESTS] ?? []),
  };

  return [specifications, Object.keys(codeVariables).length > 0 ? codeVariables : null];
}

/** Iterate every functional spec with the context that should be rendered for it. turri's, for a host. */
export function* iterateFunctionalSpecs(
  tree: MarshalledPlainSource,
  replaceCodeVariables = true,
): Generator<{ funcId: string; specifications: Specifications; codeVariables: Record<string, string> | null }> {
  for (const funcId of getFrids(tree)) {
    const [specifications, codeVariables] = getSpecificationsForFrid(tree, funcId, replaceCodeVariables);
    yield { funcId, specifications, codeVariables };
  }
}

export function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function getHashValue(specifications: unknown): string {
  return hashText(JSON.stringify(specifications, null, 4));
}

/** The func-ids from `start` through `end` inclusive, or through the last one when `end` is not given. */
export function getFridsRange(tree: MarshalledPlainSource, start: string, end?: string): string[] {
  const frids = [...getFrids(tree)];
  // Python prints the list with repr.
  const valid = `[${frids.map((frid) => `'${frid}'`).join(", ")}]`;

  if (!frids.includes(start)) {
    throw new InvalidFridArgument(`Invalid start functionality ID: ${start}. Valid IDs are: ${valid}.`);
  }

  let endIdx: number;
  if (end !== undefined) {
    if (!frids.includes(end)) {
      throw new InvalidFridArgument(`Invalid end functionality ID: ${end}. Valid IDs are: ${valid}.`);
    }
    endIdx = frids.indexOf(end) + 1;
  } else {
    endIdx = frids.length;
  }

  const startIdx = frids.indexOf(start);
  if (startIdx >= endIdx) {
    throw new InvalidFridArgument(`Start functionality ID: ${start} must be before end functionality ID: ${end}.`);
  }

  return frids.slice(startIdx, endIdx);
}
