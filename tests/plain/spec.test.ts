import { describe, expect, it } from "vitest";
import { plainFileParser } from "../../src/plain/parser.ts";
import {
  ACCEPTANCE_TESTS,
  CONFORMANCE_TESTS,
  DEFINITIONS,
  FUNCTIONAL_REQUIREMENTS,
  collectLinkedResources,
  getFirstFrid,
  getFrids,
  getFridsBefore,
  getFridsRange,
  getNextFrid,
  getPreviousFrid,
  getSpecificationsForFrid,
  hasAcceptanceTests,
  isSemanticId,
  iterateFunctionalSpecs,
  type CollectedLinkedResource,
  type MarshalledPlainSource,
} from "../../src/plain/spec.ts";
import { InvalidFridArgument } from "../../src/plain/errors.ts";

/** Port of tests/test_plainspec.py. */

const parseSimple = () => plainFileParser("simple.plain", ["tests/data/"])[1];

const link = (target: string) => ({ text: target, target });
const scenario = (id: string, text: string, linkedResources: Array<{ text: string; target: string }> = []) => ({ id, text, linked_resources: linkedResources });
const functionality = (
  id: string,
  markdown: string,
  { conformance = [], acceptance = [], links = [] }: { conformance?: unknown[]; acceptance?: unknown[]; links?: unknown[] } = {},
) => ({ id, markdown, linked_resources: links, [CONFORMANCE_TESTS]: conformance, [ACCEPTANCE_TESTS]: acceptance });

const fourFunctionalities = (): MarshalledPlainSource => ({
  [DEFINITIONS]: [{ markdown: "- :Thing: is a thing." }],
  [FUNCTIONAL_REQUIREMENTS]: [1, 2, 3, 4].map((i) =>
    functionality(`f${i}`, `Functionality ${i}.`, {
      conformance: [scenario(`f${i}-works`, `Functionality ${i} works.`, [link(`c${i}.md`)])],
      acceptance: [scenario(`f${i}-flow`, `Functionality ${i} flows.`, [link(`a${i}.md`)])],
      links: [link(`r${i}.md`)],
    }),
  ),
});

function collectedTargets(tree: MarshalledPlainSource, includeTestScenarios: boolean, frid: string | null = null): [boolean, string[]] {
  const linkedResources: CollectedLinkedResource[] = [];
  const reached = collectLinkedResources(tree, linkedResources, null, includeTestScenarios, frid);
  return [reached, linkedResources.map((resource) => resource.target)];
}

describe("plain spec", () => {
  it("rejects a plain source tree that is not an object", () => {
    expect(() => collectLinkedResources([] as unknown as MarshalledPlainSource, [], null, true)).toThrow("plain_source_tree must be a dictionary.");
  });

  it("finds acceptance scenarios", () => {
    const tree = {
      [FUNCTIONAL_REQUIREMENTS]: [functionality("first", "First functionality."), functionality("second", "Second functionality.", { acceptance: [scenario("works", "It works.")] })],
    };
    expect(hasAcceptanceTests(tree)).toBe(true);
  });

  it("finds no acceptance scenarios when there are none", () => {
    const tree = { [FUNCTIONAL_REQUIREMENTS]: [functionality("first", "First functionality."), functionality("second", "Second functionality.")] };
    expect(hasAcceptanceTests(tree)).toBe(false);
  });

  it("finds no acceptance scenarios when there are no functional specs", () => {
    expect(hasAcceptanceTests({})).toBe(false);
  });

  it("yields the func-ids of a simple module", () => {
    expect([...getFrids(parseSimple())]).toEqual(["simple-functionality"]);
  });

  it("gives the first func-id", () => {
    expect(getFirstFrid(parseSimple())).toBe("simple-functionality");
  });

  it("throws for the next func-id of a functionality that does not exist", () => {
    expect(() => getNextFrid(parseSimple(), "missing")).toThrow("Functionality missing does not exist.");
  });

  it("gives no next func-id after the last", () => {
    expect(getNextFrid(parseSimple(), "simple-functionality")).toBeNull();
  });

  it("throws for the previous func-id of a functionality that does not exist", () => {
    expect(() => getPreviousFrid(parseSimple(), "missing")).toThrow("Functionality missing does not exist.");
  });

  it("gives no previous func-id before the first", () => {
    expect(getPreviousFrid(parseSimple(), "simple-functionality")).toBeNull();
  });

  it("builds the specifications for a func-id", () => {
    const tree = parseSimple();
    expect(() => getSpecificationsForFrid(tree, "a")).toThrow("Functionality a does not exist.");

    const [specifications, codeVariables] = getSpecificationsForFrid(tree, getFirstFrid(tree)!);
    expect(specifications).toEqual({
      definitions: [],
      "implementation reqs": ["- Simple implementation requirement"],
      "test reqs": [],
      "functional specs": ["Simple functionality"],
      conformance_tests: [],
      acceptance_tests: [],
    });
    expect(codeVariables).toBeNull();
  });

  it("yields the func-ids in file order", () => {
    expect([...getFrids(fourFunctionalities())]).toEqual(["f1", "f2", "f3", "f4"]);
  });

  it("gives the func-ids before one", () => {
    expect(getFridsBefore(fourFunctionalities(), "f3")).toEqual(["f1", "f2"]);
  });

  it("takes the functional specs up to the func-id, and its scenarios", () => {
    expect(getSpecificationsForFrid(fourFunctionalities(), "f2")[0]).toEqual({
      definitions: ["- :Thing: is a thing."],
      "implementation reqs": [],
      "test reqs": [],
      "functional specs": ["Functionality 1.", "Functionality 2."],
      conformance_tests: [{ id: "f2-works", text: "Functionality 2 works." }],
      acceptance_tests: [{ id: "f2-flow", text: "Functionality 2 flows." }],
    });
  });

  it("puts code variables in place in the scenarios", () => {
    const tree = fourFunctionalities();
    (tree[FUNCTIONAL_REQUIREMENTS] as Array<Record<string, unknown>>)[0]![CONFORMANCE_TESTS] = [
      { id: "greets", text: "It prints {{ greeting }}.", linked_resources: [], code_variables: [{ name: "greeting", value: "hello" }] },
    ];
    const [specifications, codeVariables] = getSpecificationsForFrid(tree, "f1");
    expect(specifications.conformance_tests).toEqual([{ id: "greets", text: "It prints hello." }]);
    expect(codeVariables).toEqual({ greeting: "hello" });
  });

  it("collects linked resources up to the func-id, with its scenarios' only", () => {
    expect(collectedTargets(fourFunctionalities(), true, "f2")).toEqual([true, ["a2.md", "c2.md", "r1.md", "r2.md"]]);
  });

  it("collects every functional spec's and scenario's linked resources without a func-id", () => {
    const [reached, targets] = collectedTargets(fourFunctionalities(), true);
    expect(reached).toBe(false);
    expect(targets).toEqual(["a", "c", "r"].flatMap((kind) => [1, 2, 3, 4].map((i) => `${kind}${i}.md`)).sort());
  });

  it("can leave out the scenarios' linked resources", () => {
    expect(collectedTargets(fourFunctionalities(), false)[1]).toEqual(["r1.md", "r2.md", "r3.md", "r4.md"]);
  });

  it("rejects collecting up to a func-id that does not exist", () => {
    expect(() => collectLinkedResources(fourFunctionalities(), [], null, true, "f9")).toThrow("frid f9 does not exist.");
  });

  it("takes a range of func-ids from its start through its end", () => {
    expect(getFridsRange(fourFunctionalities(), "f2", "f3")).toEqual(["f2", "f3"]);
  });

  it("takes a range without an end through the last func-id", () => {
    expect(getFridsRange(fourFunctionalities(), "f3")).toEqual(["f3", "f4"]);
  });

  it("rejects a range whose start is not a func-id", () => {
    expect(() => getFridsRange(fourFunctionalities(), "f9")).toThrow(InvalidFridArgument);
    expect(() => getFridsRange(fourFunctionalities(), "f9")).toThrow("Invalid start functionality ID: f9");
  });

  it("rejects a range whose end is not a func-id", () => {
    expect(() => getFridsRange(fourFunctionalities(), "f1", "f9")).toThrow("Invalid end functionality ID: f9");
  });

  it("rejects a range whose start comes after its end", () => {
    expect(() => getFridsRange(fourFunctionalities(), "f3", "f2")).toThrow("must be before");
  });

  it.each(["a", "add-task", "add-task-2", "2", "a-b-c", "x1-y2"])("accepts %j as a semantic id", (text) => {
    expect(isSemanticId(text)).toBe(true);
  });

  it.each(["", "-", "---", "-add-task", "add-task-", "add--task", "add_task", "Add-task", "add task", "add.task", "ädd"])(
    "rejects %j as a semantic id",
    (text) => {
      expect(isSemanticId(text)).toBe(false);
    },
  );
});

/** turri's own iterator, for a host. */
describe("functional spec iterator", () => {
  it("iterates every functional spec with its own context", () => {
    const walked = [...iterateFunctionalSpecs(fourFunctionalities())];
    expect(walked.map(({ funcId }) => funcId)).toEqual(["f1", "f2", "f3", "f4"]);
    expect(walked[2]!.specifications["functional specs"]).toEqual(["Functionality 1.", "Functionality 2.", "Functionality 3."]);
    expect(walked[2]!.specifications.acceptance_tests).toEqual([{ id: "f3-flow", text: "Functionality 3 flows." }]);
  });
});
