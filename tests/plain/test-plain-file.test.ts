import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PlainSyntaxError } from "../../src/plain/errors.ts";
import {
  isTestPlainFile,
  parseTestPlainFileSource,
  scenarioItem,
  scenariosOf,
  validateScenarioConcepts,
} from "../../src/plain/test-plain-file.ts";

/** Port of tests/test_test_plain_file.py. */

const fixturesDir = "tests/data/testplainfile";
const parse = (fileName: string, codeVariables: Record<string, Record<string, string>> = {}) =>
  parseTestPlainFileSource(readFileSync(join(fixturesDir, fileName), "utf8"), fileName, [fixturesDir], codeVariables);

function messageOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(PlainSyntaxError);
    return (error as Error).message;
  }
  throw new Error("it parsed");
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("test plain files", () => {
  it("binds a valid file to its functionality and keeps the scenarios verbatim", () => {
    const parsed = parse("valid.plain");

    expect([parsed.name, parsed.module, parsed.funcId]).toEqual(["valid.plain", "task-manager", "add-task"]);
    expect(parsed.conformanceTests.map(scenarioItem)).toEqual([
      {
        id: "add-first-task",
        text: 'Adding a :Task: named "Buy milk" to an empty :TaskList: shows one :Task: named "Buy milk".\n  - :App: prints `Added task 1: Buy milk`.',
        linked_resources: [],
      },
      {
        id: "add-without-name",
        text: "given:\n  - an empty :TaskList:\nwhen:\n  - :User: runs `todo add`\nthen:\n  - stderr is `Error: name is required`\n  - exit status is 1",
        linked_resources: [],
      },
      {
        id: "gherkin-shape",
        text: 'Scenario: adding a task with a note\n  Given an empty :TaskList:\n  When :User: adds "Buy milk"\n\n  Then :TaskList: shows it',
        linked_resources: [],
      },
      {
        id: "links-the-notes",
        text: "The output matches [the notes](notes.md).",
        linked_resources: [{ text: "the notes", target: "notes.md" }],
      },
    ]);
    expect(parsed.acceptanceTests.map(scenarioItem)).toEqual([
      { id: "add-then-list", text: '- :User: adds a :Task: named "Buy milk".\n- `todo list` shows `1 Buy milk`.', linked_resources: [] },
    ]);
    expect(scenariosOf(parsed).map((scenario) => scenario.lineNumber)).toEqual([10, 14, 26, 33, 38]);
  });

  it.each([
    ["missing_acceptance_section.plain", ["works"], []],
    ["acceptance_only.plain", [], ["rejects-empty"]],
  ])("lets %s leave out a section it has no scenarios for", (fileName, conformance, acceptance) => {
    const parsed = parse(fileName);
    expect([parsed.module, parsed.funcId]).toEqual(["task-manager", "add-task"]);
    expect([parsed.conformanceTests.map((scenario) => scenario.id), parsed.acceptanceTests.map((scenario) => scenario.id)]).toEqual([conformance, acceptance]);
  });

  it.each([
    ["empty_sections.plain", 6],
    ["minimal.plain", 5],
    // A comment is no scenario.
    ["comment_only_conformance.plain", 6],
  ])("refuses a section with no scenarios in %s, at its heading", (fileName, line) => {
    expect(() => parse(fileName)).toThrow(
      `Plain syntax error: Syntax error at line ${line} in test plain file '${fileName}': The \`***conformance tests***\` section has no scenarios. Leave out a section with none.`,
    );
  });

  it.each([
    ["no_sections.plain", "Plain syntax error: Test plain file 'no_sections.plain' has no scenarios. A functional spec with none has no test plain file: delete it."],
    [
      "sections_out_of_order.plain",
      "Plain syntax error: Syntax error at line 11 in test plain file 'sections_out_of_order.plain': The `***conformance tests***` section must come before `***acceptance tests***`.",
    ],
    ["duplicate_section.plain", "Plain syntax error: Syntax error at line 11 in test plain file 'duplicate_section.plain': Duplicate section `***conformance tests***`."],
    [
      "unknown_section.plain",
      "Plain syntax error: Syntax error at line 11 in test plain file 'unknown_section.plain': Invalid section (`***definitions***`). A test plain file has the sections `***conformance tests***` and `***acceptance tests***`, in this order.",
    ],
    [
      "extra_frontmatter_key.plain",
      "Plain syntax error: Test plain file 'extra_frontmatter_key.plain' has the frontmatter key `description:`; only `module:` and `func_id:` are allowed.",
    ],
    ["missing_func_id.plain", "Plain syntax error: Test plain file 'missing_func_id.plain' has no `func_id:` key in its frontmatter."],
    ["module_not_a_string.plain", "Plain syntax error: Test plain file 'module_not_a_string.plain': the frontmatter key `module:` must be a non-empty string."],
    [
      "duplicate_scenario_id.plain",
      "Plain syntax error: Syntax error at line 13 in test plain file 'duplicate_scenario_id.plain': Duplicate scenario-id `works`; it is first used at line 8.",
    ],
    [
      "invalid_scenario_id.plain",
      "Plain syntax error: Syntax error at line 8 in test plain file 'invalid_scenario_id.plain': Invalid scenario-id (`Works Well`). A scenario-id is lowercase letters and digits, with single hyphens between them.",
    ],
    [
      "content_before_section.plain",
      "Plain syntax error: Syntax error at line 6 in test plain file 'content_before_section.plain': Content before the first section (`It works.`); a test plain file starts with `***conformance tests***`.",
    ],
    [
      "content_before_scenario.plain",
      "Plain syntax error: Syntax error at line 8 in test plain file 'content_before_scenario.plain': Content before the first `# <scenario-id>` heading in the `conformance tests` section (`It works.`).",
    ],
    [
      "scenario_before_section.plain",
      "Plain syntax error: Syntax error at line 6 in test plain file 'scenario_before_section.plain': Scenario `works` comes before the first section; a test plain file starts with `***conformance tests***`.",
    ],
    ["empty_scenario.plain", "Plain syntax error: Syntax error at line 8 in test plain file 'empty_scenario.plain': Scenario `works` has no text."],
  ])("rejects %s, saying where", (fileName, message) => {
    expect(messageOf(() => parse(fileName))).toBe(message);
  });

  it("names the file and the scenario of a missing link", () => {
    expect(messageOf(() => parse("missing_link.plain"))).toMatch(
      /^Plain syntax error: Link missing\.md in test plain file 'missing_link\.plain', scenario `works` does not exist\. Linked resources are looked up relative to the following directories/,
    );
  });

  it("rejects a link to a plain file", () => {
    expect(messageOf(() => parse("link_to_plain_file.plain"))).toContain("Referenced resource 'valid.plain' in test plain file");
  });

  it.each(["-works", "works-", "works--well", "-", "--", "works_well", "Works"])("checks the syntax of the scenario-id %s", (scenarioId) => {
    const text = `---\nmodule: m\nfunc_id: f\n---\n\n***conformance tests***\n\n# ${scenarioId}\nIt works.\n\n***acceptance tests***\n`;
    expect(messageOf(() => parseTestPlainFileSource(text, "f.plain", [], {}))).toContain(`Invalid scenario-id (\`${scenarioId}\`)`);
  });

  const head = "---\nmodule: todo\nfunc_id: add-task\n---\n\n***conformance tests***\n\n";
  const tail = "";

  it.each([
    // A shell comment, and one that repeats a scenario-id.
    '```bash\n# create an empty list, then add a task\n# add-first-task\ntodo add "Buy milk"\n```',
    // A line that looks like a section marker.
    "```\n***\ntodo 1.0\n***\n```",
    // Lines that look like comments.
    "```\n> todo add Buy milk\nAdded task 1: Buy milk\n> todo list\n```",
    // A tilde fence, indented, with a backtick fence line inside it.
    "  ~~~\n  # not a heading\n  ```\n  ~~~",
  ])("keeps the lines inside a code fence as scenario text: %s", (body) => {
    const text = head + `# add-first-task\nThe commands below add a task.\n\n${body}\nThe task is listed.\n` + tail;
    const parsed = parseTestPlainFileSource(text, "add-task.plain", [], {});
    expect(parsed.conformanceTests.map((scenario) => scenario.id)).toEqual(["add-first-task"]);
    expect(parsed.conformanceTests[0]!.text).toBe(`The commands below add a task.\n\n${body}\nThe task is listed.`);
  });

  it("starts a scenario at a heading after a closed code fence", () => {
    const text = head + "# first\n```\n# not a heading\n```\n\n# second\nIt works.\n" + tail;
    expect(parseTestPlainFileSource(text, "add-task.plain", [], {}).conformanceTests.map((scenario) => scenario.id)).toEqual(["first", "second"]);
  });

  it("rejects a code fence that is not closed", () => {
    const text = head + "# first\nIt works:\n```\ntodo add\n" + tail;
    expect(messageOf(() => parseTestPlainFileSource(text, "add-task.plain", [], {}))).toBe(
      "Plain syntax error: Syntax error at line 8 in test plain file 'add-task.plain': Scenario `first` has a code fence that is not closed.",
    );
  });

  it("takes a code fence before the first scenario for content before a heading", () => {
    const text = head + "```\n# not a heading\n```\n\n# first\nIt works.\n" + tail;
    expect(messageOf(() => parseTestPlainFileSource(text, "add-task.plain", [], {}))).toContain(
      "Syntax error at line 8 in test plain file 'add-task.plain': Content before the first `# <scenario-id>` heading",
    );
  });

  it("rejects invalid frontmatter", () => {
    expect(messageOf(() => parseTestPlainFileSource("---\nmodule: [\n---\n", "broken.plain", [], {}))).toContain(
      "Test plain file 'broken.plain' has invalid frontmatter",
    );
  });

  it("runs Liquid with the template folders", () => {
    const dir = mkdtempSync(join(tmpdir(), "turri-tpf-"));
    dirs.push(dir);
    writeFileSync(join(dir, "shape.plain"), "  - exit status is {{ status | code_variable }}");
    const text =
      "---\nmodule: m\nfunc_id: f\n---\n\n***conformance tests***\n\n# works\n" +
      'It works.\n{% include "shape.plain", status: "0" %}\n';
    const parsed = parseTestPlainFileSource(text, "f.plain", [dir], {});
    expect(scenarioItem(parsed.conformanceTests[0]!)).toEqual({
      id: "works",
      text: "It works.\n  - exit status is {{ status }}",
      linked_resources: [],
      code_variables: [{ name: "status", value: "0" }],
    });
  });

  it("names the file in a Liquid error", () => {
    const text = "---\nmodule: m\nfunc_id: f\n---\n\n***conformance tests***\n\n# works\nIt {{ works\n";
    expect(messageOf(() => parseTestPlainFileSource(text, "f.plain", [], {}))).toContain("Invalid Liquid at f.plain:");
  });

  it("checks the scenarios' concepts against the concepts the module can name", () => {
    const parsed = parse("valid.plain");
    expect(validateScenarioConcepts(parsed, new Set([":Task:", ":TaskList:", ":App:", ":User:"]))).toEqual([]);
    expect(validateScenarioConcepts(parsed, new Set([":Task:", ":App:", ":User:"]))).toEqual([
      "Syntax error at line 10 in test plain file 'valid.plain': Concept :TaskList: used in scenario `add-first-task` is not defined in module 'task-manager'.",
      "Syntax error at line 14 in test plain file 'valid.plain': Concept :TaskList: used in scenario `add-without-name` is not defined in module 'task-manager'.",
      "Syntax error at line 26 in test plain file 'valid.plain': Concept :TaskList: used in scenario `gherkin-shape` is not defined in module 'task-manager'.",
    ]);
  });

  it("needs no definition for a predefined concept", () => {
    const scenario = { id: "works", lineNumber: 8, text: ":ConformanceTests: start :Implementation:.", linkedResources: [], codeVariables: [] };
    const parsed = { name: "f.plain", module: "m", funcId: "f", conformanceTests: [scenario], acceptanceTests: [] };
    expect(validateScenarioConcepts(parsed, new Set())).toEqual([]);
  });

  it.each([
    [{ module: "m", func_id: "f" }, true],
    [{ module: "m" }, false],
    [{}, false],
    [{ description: "x" }, false],
  ])("takes the frontmatter %o for a test plain file's: %s", (metadata, expected) => {
    expect(isTestPlainFile(metadata)).toBe(expected);
  });
});
