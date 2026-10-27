import { simpleCycles } from "./cycles.ts";
import { PlainSyntaxError } from "./errors.ts";
import { renderToMarkdown, type AnyNode, type Section } from "./markdown.ts";
import {
  ACCEPTANCE_TESTS,
  DEFINITIONS,
  FUNCTIONAL_REQUIREMENTS,
  NON_FUNCTIONAL_REQUIREMENTS,
  TEST_REQUIREMENTS,
  getSpecificationItems,
  type MarshalledPlainSource,
  type SpecificationItem,
} from "./spec.ts";

/** Port of concept_utils.py. */

/**
 * ***plain's own concepts, each with what it means, in a line: every module can name them, and none may define them.
 * turri's, not the reference parser's - it has only the names.
 */
export const DEFAULT_CONCEPT_DEFINITIONS: Readonly<Record<string, string>> = {
  ":ConformanceTests:": "the tests, written apart from the code, that check it conforms to the functional specs",
  ":UnitTests:": "the unit tests written with the code of each functional spec",
  ":AcceptanceTest:": "a test that checks one functional spec does what its acceptance tests say",
  ":AcceptanceTests:": "the tests that check a functional spec does what its acceptance tests say",
  ":Implementation:": "the software that implements the module's functional specs",
  ":plainDefinitions:": "the content of the module's ***definitions*** section",
  ":plainImplementationReqs:": "the content of the module's ***implementation reqs*** section",
  ":plainFunctionality:": "the content of the module's ***functional specs*** section",
  ":plainTestReqs:": "the content of the module's ***test reqs*** section",
  ":plainImplementationCode:": "the code generated from the module",
};

/** Reserved concept names that must not be redefined in the definitions section. */
export const DEFAULT_CONCEPTS = new Set(Object.keys(DEFAULT_CONCEPT_DEFINITIONS));

/** What a concept's name is made of, between its two colons. */
const CONCEPT_CHARACTERS = "+\\-.0-9A-Z_a-z";

const DEFINITION_PATTERN = /-\s(:[^:]+:)(?:,\s*:[^:]+:)*/;
const CONCEPT_CANDIDATE_PATTERN = /:[^:]+:/g;
const VALID_CONCEPT_PATTERN = new RegExp(`^:[${CONCEPT_CHARACTERS}]+:`);
const SPEC_CONCEPT_PATTERN = new RegExp(`:[${CONCEPT_CHARACTERS}]+:`, "g");
const TYPED_CONCEPT_PATTERN = new RegExp(`:[${CONCEPT_CHARACTERS}]*$`);

/** Every concept written in a piece of text - `:User:` - with where it is, as the parser reads concepts in a spec. */
export function findConcepts(text: string): Array<{ concept: string; start: number; end: number }> {
  return [...text.matchAll(SPEC_CONCEPT_PATTERN)].map((match) => ({ concept: match[0], start: match.index, end: match.index + match[0].length }));
}

/** The concept being typed at the end of a piece of text - `:Us` - with where it starts, or undefined when there is none. */
export function conceptBeingTyped(text: string): { typed: string; start: number } | undefined {
  const match = TYPED_CONCEPT_PATTERN.exec(text);
  if (match === null) return undefined;
  // A colon that closes a concept is not one that opens the next.
  if (findConcepts(text).some(({ end }) => end - 1 === match.index)) return undefined;
  return { typed: match[0], start: match.index };
}

/** A definition's text after the concepts it defines: `is a person who signs up` of `- :User: is a person who signs up`. */
export function definitionText(text: string): string {
  const match = DEFINITION_PATTERN.exec(text);
  return (match === null ? text : text.slice(match.index + match[0].length)).trim();
}

export function extractConceptsFromDefinition(text: string): [string[], string[]] {
  const match = DEFINITION_PATTERN.exec(text);
  if (!match) {
    return [
      [],
      [
        `Syntax error: Invalid definition specification text: ${text}. Should start with \`- :<concept>:\` ` +
          "(where <concept> is any string that does not contain `:`).",
      ],
    ];
  }

  const candidates = match[0].match(CONCEPT_CANDIDATE_PATTERN) ?? [];
  const valid: string[] = [];
  const errors: string[] = [];
  for (const candidate of candidates) {
    if (VALID_CONCEPT_PATTERN.test(candidate)) {
      valid.push(candidate);
    } else {
      errors.push(
        `Syntax error: Invalid concept: ${candidate}. Should contain only letters, numbers, hyphens and dots.`,
      );
    }
  }
  return [valid, errors];
}

export function extractConceptsFromSpecText(text: string): string[] {
  return text.match(SPEC_CONCEPT_PATTERN) ?? [];
}

export function collectConcepts(plainSource: MarshalledPlainSource): [string[], string[]] {
  const definitions = getSpecificationItems(plainSource, DEFINITIONS);
  if (definitions === undefined) return [[], []];

  const concepts: string[] = [];
  const errors: string[] = [];
  for (const definition of definitions) {
    const [newConcepts, newErrors] = extractConceptsFromDefinition(definition.markdown);
    errors.push(...newErrors);
    concepts.push(...newConcepts);
  }
  return [concepts, errors];
}

function validateConceptsInSpec(spec: SpecificationItem, concepts: Set<string>, specGroup: string): string[] {
  const errors: string[] = [];
  for (const used of extractConceptsFromSpecText(spec.markdown)) {
    if (!concepts.has(used) && !DEFAULT_CONCEPTS.has(used)) {
      errors.push(
        `Syntax error: Concept ${used} is not defined in the definitions. ${specGroup}: ${spec.markdown}`,
      );
    }
  }
  return errors;
}

function validateConceptsInSpecGroup(
  specGroup: string,
  plainSource: MarshalledPlainSource,
  concepts: Set<string>,
): string[] {
  const specs = getSpecificationItems(plainSource, specGroup);
  if (specs === undefined) return [];
  return specs.flatMap((spec) => validateConceptsInSpec(spec, concepts, specGroup));
}

export function validateConcepts(marshalled: MarshalledPlainSource): string[] {
  const errors: string[] = [];
  const concepts = new Set(DEFAULT_CONCEPTS);

  const [newConcepts, newErrors] = collectConcepts(marshalled);
  errors.push(...newErrors);

  const uniqueNewConcepts = new Set(newConcepts);
  const intersection = [...uniqueNewConcepts].filter((c) => concepts.has(c));

  if (uniqueNewConcepts.size < newConcepts.length || intersection.length > 0) {
    const misused = new Set(newConcepts.filter((c) => newConcepts.filter((o) => o === c).length > 1));
    for (const c of intersection) misused.add(c);
    errors.push(`Syntax error: Concepts were defined multiple times: ${[...misused].join(", ")} .`);
  }

  const treeBasedConcepts = new Set([...DEFAULT_CONCEPTS, ...uniqueNewConcepts]);

  for (const specGroup of [
    NON_FUNCTIONAL_REQUIREMENTS,
    TEST_REQUIREMENTS,
    FUNCTIONAL_REQUIREMENTS,
    DEFINITIONS,
  ]) {
    errors.push(...validateConceptsInSpecGroup(specGroup, marshalled, treeBasedConcepts));
  }

  for (const funcSpec of getSpecificationItems(marshalled, FUNCTIONAL_REQUIREMENTS) ?? []) {
    for (const test of funcSpec[ACCEPTANCE_TESTS] ?? []) {
      errors.push(...validateConceptsInSpec(test, treeBasedConcepts, ACCEPTANCE_TESTS));
    }
  }

  return errors;
}

export function findConceptDefinitionsInPlainSource(concept: string, definitions: Section | null): AnyNode[] {
  const found: AnyNode[] = [];
  if (definitions === null) return found;

  for (const definition of definitions.children) {
    const rendered = renderToMarkdown(definition);
    const [definedConcepts] = extractConceptsFromDefinition(rendered);
    if (!definedConcepts.includes(concept)) continue;

    found.push(definition);
    const usedConcepts = extractConceptsFromSpecText(rendered).filter(
      (used) => used !== concept && !DEFAULT_CONCEPTS.has(used),
    );
    for (const used of usedConcepts) {
      found.push(...findConceptDefinitionsInPlainSource(used, definitions));
    }
  }

  return found;
}

function buildAdjacencyList(
  definitions: SpecificationItem[],
): [Map<string, string[]>, Map<string, SpecificationItem>] {
  const adjacency = new Map<string, string[]>();
  const conceptDefinitions = new Map<string, SpecificationItem>();

  for (const definition of definitions) {
    const text = definition.markdown;
    const [newConcepts] = extractConceptsFromDefinition(text);
    const usedConcepts = new Set(
      extractConceptsFromSpecText(text).filter(
        (used) => !newConcepts.includes(used) && !DEFAULT_CONCEPTS.has(used),
      ),
    );

    for (const newConcept of newConcepts) {
      if (!adjacency.has(newConcept)) adjacency.set(newConcept, []);
    }
    for (const used of usedConcepts) {
      if (!adjacency.has(used)) adjacency.set(used, []);
      adjacency.get(used)!.push(...newConcepts);
    }
    for (const newConcept of newConcepts) {
      conceptDefinitions.set(newConcept, definition);
    }
  }

  return [adjacency, conceptDefinitions];
}

/**
 * The order graphlib's `TopologicalSorter.static_order` gives, reproduced.
 *
 * It hands out every node that is ready at once, in the order the nodes were first
 * added, then the nodes each one frees, in the order it frees them - Kahn's algorithm
 * one generation at a time. The ordering of independent concepts therefore depends on
 * insertion order, and the Python tests assert that exact order - a generic topological
 * sort would pass the dependency constraints but produce a different sequence.
 */
function topologicalSort(successors: Map<string, string[]>): { order: string[]; cycle: string[] | null } {
  const inDegree = new Map<string, number>();
  for (const node of successors.keys()) inDegree.set(node, 0);
  for (const [, targets] of successors) {
    for (const target of targets) inDegree.set(target, (inDegree.get(target) ?? 0) + 1);
  }

  let generation = [...successors.keys()].filter((node) => (inDegree.get(node) ?? 0) === 0);
  const order: string[] = [];
  const remaining = new Map(inDegree);
  for (const node of generation) remaining.delete(node);

  while (generation.length > 0) {
    const next: string[] = [];
    for (const node of generation) {
      order.push(node);
      for (const child of successors.get(node) ?? []) {
        const degree = (remaining.get(child) ?? 0) - 1;
        remaining.set(child, degree);
        if (degree === 0) {
          next.push(child);
          remaining.delete(child);
        }
      }
    }
    generation = next;
  }

  if (remaining.size > 0) return { order, cycle: [...remaining.keys()] };
  return { order, cycle: null };
}

export const MAX_REPORTED_CYCLES = 10;

/**
 * The elementary cycles in the graph, each as a "Cycle N: :A: -> :B: -> :A:" line followed by the definition of
 * every concept in the cycle. Arrows point from a definition to a concept it mentions, each cycle starts at its
 * earliest-defined concept, and cycles are ordered by definition position, so the report reads top to bottom like
 * the file. At most MAX_REPORTED_CYCLES are listed; the search stops once one more than that is found.
 */
export function formatCyclesError(
  adjacency: Map<string, string[]>,
  conceptDefinitions: Map<string, SpecificationItem>,
): string {
  const position = new Map([...conceptDefinitions.keys()].map((concept, index) => [concept, index]));
  const at = (concept: string) => position.get(concept)!;
  // Keyed in definition order, so a search cut short by the limit has found the earliest cycles.
  const byPosition = new Map<string, string[]>();
  for (const concept of [...conceptDefinitions.keys(), ...adjacency.keys()]) {
    if (!byPosition.has(concept)) byPosition.set(concept, adjacency.get(concept)!);
  }
  let cycles: string[][] = [];
  for (const found of simpleCycles(byPosition, MAX_REPORTED_CYCLES + 1)) {
    // Reversed, since the edges point from a used concept to the one defined with it.
    const cycle = [...found].reverse();
    let first = 0;
    cycle.forEach((concept, index) => {
      if (at(concept) < at(cycle[first]!)) first = index;
    });
    cycles.push([...cycle.slice(first), ...cycle.slice(0, first)]);
  }
  cycles.sort((a, b) => {
    if (at(a[0]!) !== at(b[0]!)) return at(a[0]!) - at(b[0]!);
    if (a.length !== b.length) return a.length - b.length;
    for (let i = 0; i < a.length; i += 1) if (at(a[i]!) !== at(b[i]!)) return at(a[i]!) - at(b[i]!);
    return 0;
  });

  let lines: string[];
  if (cycles.length > MAX_REPORTED_CYCLES) {
    cycles = cycles.slice(0, MAX_REPORTED_CYCLES);
    lines = [
      `Plain syntax error: Found more than ${MAX_REPORTED_CYCLES} cycles in concept definitions. Cycles are not allowed.`,
      `Showing the first ${MAX_REPORTED_CYCLES}.`,
    ];
  } else {
    lines = [`Plain syntax error: Found ${cycles.length} cycle(s) in concept definitions. Cycles are not allowed.`];
  }
  cycles.forEach((cycle, index) => {
    lines.push("");
    lines.push(`Cycle ${index + 1}: ` + [...cycle, cycle[0]].join(" -> "));
    // Concepts defined on one line can share a cycle; that line is printed once.
    lines.push(...new Set(cycle.map((concept) => conceptDefinitions.get(concept)!.markdown)));
  });
  return lines.join("\n");
}

export function sortDefinitions(definitions: SpecificationItem[]): void {
  if (definitions.length <= 1) return;

  const [adjacency, conceptDefinitions] = buildAdjacencyList(definitions);
  const { order, cycle } = topologicalSort(adjacency);

  if (cycle !== null) throw new PlainSyntaxError(formatCyclesError(adjacency, conceptDefinitions));

  if (order.length === 0) return;

  const definitionOrder = new Map<SpecificationItem, number>();
  order.forEach((concept, index) => {
    // Python keys this map by definition and lets later concepts overwrite, so a
    // definition that introduces several concepts takes the index of its last one.
    const definition = conceptDefinitions.get(concept);
    if (definition !== undefined) definitionOrder.set(definition, index);
  });

  definitions.sort((a, b) => (definitionOrder.get(a) ?? 0) - (definitionOrder.get(b) ?? 0));
}
