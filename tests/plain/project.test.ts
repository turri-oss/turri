import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MissingTestPlainFileError, PlainSyntaxError } from "../../src/plain/errors.ts";
import { parseProject, type ProjectParseResult } from "../../src/plain/project.ts";
import { ACCEPTANCE_TESTS, CONFORMANCE_TESTS, getFunctionalSpecs } from "../../src/plain/spec.ts";

/** Port of tests/test_project.py. */

const MODULE =
  "***definitions***\n\n- :Task: is a thing to do.\n\n***implementation reqs***\n\n- A req.\n\n" +
  "***functional specs***\n\n# add-task\nA :Task: can be added.\n\n# list-tasks\nEvery :Task: is listed.\n";

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "turri-project-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** A test plain file, each section only with scenarios: one with none is a syntax error. */
const scenarioFile = (module: string, funcId: string, conformance = "", acceptance = "") =>
  `---\nmodule: ${module}\nfunc_id: ${funcId}\n---\n${conformance !== "" ? `\n***conformance tests***\n\n${conformance}` : ""}${acceptance !== "" ? `\n***acceptance tests***\n\n${acceptance}` : ""}`;

const parse = (root: string, requireTestPlainFiles = false, testDirs?: string[]) =>
  parseProject("todo.plain", [root], testDirs ?? [join(root, "tests")], requireTestPlainFiles);

const functionalities = (result: ProjectParseResult, module = "todo") =>
  Object.fromEntries(getFunctionalSpecs(new Map(result.chain).get(module)!).map((item) => [item.id, item]));

const scenarioIds = (functionality: { [CONFORMANCE_TESTS]: Array<{ id: string }> }) => functionality[CONFORMANCE_TESTS].map((scenario) => scenario.id);

function messageOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("it parsed");
}

describe("binding test plain files", () => {
  it("merges the scenarios into the functionality they bind to", () => {
    const root = tmp();
    write(join(root, "todo.plain"), MODULE);
    write(join(root, "tests/todo/add-task.plain"), scenarioFile("todo", "add-task", "# add-one\nAdding one :Task: shows it.\n", "# add-then-list\nAdd, then list.\n"));

    const result = parse(root);

    expect(result.testPlainFiles.map((bound) => [bound.name, bound.parsed.module, bound.parsed.funcId])).toEqual([["tests/todo/add-task.plain", "todo", "add-task"]]);
    expect(functionalities(result)["add-task"]![CONFORMANCE_TESTS]).toEqual([{ id: "add-one", text: "Adding one :Task: shows it.", linked_resources: [] }]);
    expect(functionalities(result)["add-task"]![ACCEPTANCE_TESTS]).toEqual([{ id: "add-then-list", text: "Add, then list.", linked_resources: [] }]);
    expect(functionalities(result)["list-tasks"]![CONFORMANCE_TESTS]).toEqual([]);
  });

  it("takes the place and name of a test plain file as convention only", () => {
    const root = tmp();
    write(join(root, "todo.plain"), MODULE);
    write(join(root, "tests/anything.plain"), scenarioFile("todo", "list-tasks", "# lists\nIt lists.\n"));
    expect(scenarioIds(functionalities(parse(root))["list-tasks"]!)).toEqual(["lists"]);
  });

  it("merges the files bound to one functionality in path order", () => {
    const root = tmp();
    write(join(root, "todo.plain"), MODULE);
    write(join(root, "tests/b.plain"), scenarioFile("todo", "add-task", "# from-b\nFrom b.\n"));
    write(join(root, "tests/a.plain"), scenarioFile("todo", "add-task", "# from-a\nFrom a.\n"));
    write(join(root, "tests/sub/c.plain"), scenarioFile("todo", "add-task", "# from-c\nFrom c.\n"));

    const result = parse(root);

    expect(scenarioIds(functionalities(result)["add-task"]!)).toEqual(["from-a", "from-b", "from-c"]);
    expect(result.testPlainFiles.map((bound) => bound.name)).toEqual(["tests/a.plain", "tests/b.plain", "tests/sub/c.plain"]);
  });

  it("reads the test folders in the order given", () => {
    const root = tmp();
    write(join(root, "todo.plain"), MODULE);
    write(join(root, "more/b.plain"), scenarioFile("todo", "add-task", "# from-b\nFrom b.\n"));
    write(join(root, "tests/a.plain"), scenarioFile("todo", "add-task", "# from-a\nFrom a.\n"));

    const result = parse(root, false, [join(root, "more"), join(root, "tests")]);

    expect(scenarioIds(functionalities(result)["add-task"]!)).toEqual(["from-b", "from-a"]);
    expect(result.testPlainFiles.map((bound) => bound.name)).toEqual(["more/b.plain", "tests/a.plain"]);
  });

  it("takes a missing test folder for none", () => {
    const root = tmp();
    write(join(root, "todo.plain"), MODULE);
    expect(parse(root).testPlainFiles).toEqual([]);
  });

  it("rejects a scenario-id used twice across the files of one functionality", () => {
    const root = tmp();
    write(join(root, "todo.plain"), MODULE);
    write(join(root, "tests/a.plain"), scenarioFile("todo", "add-task", "# works\nIt works.\n"));
    write(join(root, "tests/b.plain"), scenarioFile("todo", "add-task", "", "# works\nIt works again.\n"));
    expect(messageOf(() => parse(root))).toBe(
      "Plain syntax error: Syntax error at line 8 in test plain file 'tests/b.plain': Duplicate scenario-id `works` for functionality 'todo:add-task'; it is first used at line 8 in test plain file 'tests/a.plain'.",
    );
  });

  it("allows one scenario-id for two functionalities", () => {
    const root = tmp();
    write(join(root, "todo.plain"), MODULE);
    write(join(root, "tests/a.plain"), scenarioFile("todo", "add-task", "# works\nIt works.\n"));
    write(join(root, "tests/b.plain"), scenarioFile("todo", "list-tasks", "# works\nIt works.\n"));
    expect(() => parse(root)).not.toThrow();
  });

  it("rejects a module outside the chain", () => {
    const root = tmp();
    write(join(root, "todo.plain"), MODULE);
    write(join(root, "tests/a.plain"), scenarioFile("tasks", "add-task", "# works\nIt works.\n"));
    expect(messageOf(() => parse(root))).toBe(
      "Plain syntax error: Test plain file 'tests/a.plain' binds to module 'tasks', which is not the entry module or one of its required modules (todo).",
    );
  });

  it("rejects a func-id the module does not have", () => {
    const root = tmp();
    write(join(root, "todo.plain"), MODULE);
    write(join(root, "tests/a.plain"), scenarioFile("todo", "delete-task", "# works\nIt works.\n"));
    expect(messageOf(() => parse(root))).toBe(
      "Plain syntax error: Test plain file 'tests/a.plain' binds to functionality 'todo:delete-task', which module 'todo' does not have.",
    );
  });

  it("rejects a .plain file under a test folder without the binding keys", () => {
    const root = tmp();
    write(join(root, "todo.plain"), MODULE);
    write(join(root, "tests/helper.plain"), "***definitions***\n\n- :Helper: helps.\n");
    expect(messageOf(() => parse(root))).toBe(
      "Plain syntax error: File 'tests/helper.plain' is under a test folder but is not a test plain file: its frontmatter needs the keys `module:` and `func_id:`.",
    );
  });

  it("rejects a file under a test folder with invalid frontmatter", () => {
    const root = tmp();
    write(join(root, "todo.plain"), MODULE);
    write(join(root, "tests/broken.plain"), "---\nmodule: [\n---\n");
    expect(() => parse(root)).toThrow(PlainSyntaxError);
    expect(messageOf(() => parse(root))).toContain("File 'tests/broken.plain' under a test folder has invalid frontmatter");
  });

  it("names its file in a test plain file's error", () => {
    const root = tmp();
    write(join(root, "todo.plain"), MODULE);
    write(join(root, "tests/a.plain"), "---\nmodule: todo\nfunc_id: add-task\n---\n\n***conformance tests***\n");
    expect(messageOf(() => parse(root))).toContain("in test plain file 'tests/a.plain': The `***conformance tests***` section has no scenarios");
  });

  it("checks the scenarios' concepts against the module they bind to", () => {
    const root = tmp();
    write(join(root, "todo.plain"), MODULE);
    write(join(root, "tests/a.plain"), scenarioFile("todo", "add-task", "# works\nA :Task: and a :Note: are added.\n"));
    expect(messageOf(() => parse(root))).toBe(
      "Plain syntax error: Found 1 errors in test plain file 'tests/a.plain':\nSyntax error at line 8 in test plain file 'tests/a.plain': Concept :Note: used in scenario `works` is not defined in module 'todo'.",
    );
  });

  it("lets the scenarios name imported and exported concepts", () => {
    const root = tmp();
    write(join(root, "shared.plain"), "***definitions***\n\n- :Clock: tells the time.\n");
    write(
      join(root, "core.plain"),
      '---\nexported_concepts: [":Task:"]\n---\n\n***definitions***\n\n- :Task: is a thing to do.\n\n' +
        "***implementation reqs***\n\n- A req.\n\n***functional specs***\n\n# store-task\nA :Task: is stored.\n",
    );
    write(
      join(root, "todo.plain"),
      "---\nrequires:\n  - core\nimport:\n  - shared\n---\n\n***implementation reqs***\n\n- A req.\n\n" +
        "***functional specs***\n\n# add-task\nA :Task: can be added at a :Clock: time.\n",
    );
    write(join(root, "tests/todo/add-task.plain"), scenarioFile("todo", "add-task", "# works\nA :Task: at :Clock:.\n"));
    write(join(root, "tests/core/store-task.plain"), scenarioFile("core", "store-task", "# stores\nA :Task: is kept.\n"));

    const result = parse(root);

    expect(scenarioIds(functionalities(result, "core")["store-task"]!)).toEqual(["stores"]);
    expect(scenarioIds(functionalities(result)["add-task"]!)).toEqual(["works"]);
  });

  it("does not let a required module's scenarios name the top module's concepts", () => {
    const root = tmp();
    write(join(root, "core.plain"), "***implementation reqs***\n\n- A req.\n\n***functional specs***\n\n# store-task\nIt stores.\n");
    write(join(root, "todo.plain"), "---\nrequires:\n  - core\n---\n\n" + MODULE);
    write(join(root, "tests/core/store-task.plain"), scenarioFile("core", "store-task", "# stores\nA :Task: is kept.\n"));
    expect(messageOf(() => parse(root))).toContain("Concept :Task: used in scenario `stores` is not defined in module 'core'");
  });

  it("asks for a test plain file for every functionality when they are required", () => {
    const root = tmp();
    write(join(root, "todo.plain"), MODULE);
    write(join(root, "tests/a.plain"), scenarioFile("todo", "add-task", "# works\nIt works.\n"));

    expect(() => parse(root)).not.toThrow();
    expect(() => parse(root, true)).toThrow(MissingTestPlainFileError);
    expect(messageOf(() => parse(root, true))).toBe(
      "Functionality todo:list-tasks has no test plain file. Add one, by convention tests/todo/list-tasks.plain, with the add-test-scenarios skill.",
    );
  });

  it.each([
    // The minimal file: the frontmatter and the two markers on adjacent lines.
    "---\nmodule: todo\nfunc_id: list-tasks\n---\n***conformance tests***\n***acceptance tests***\n",
    // The conventional placeholder comment in an empty conformance section.
    "---\nmodule: todo\nfunc_id: list-tasks\n---\n\n***conformance tests***\n\n> add conformance test scenarios here\n\n***acceptance tests***\n",
  ])("refuses a test plain file with empty sections, though the reference's check asks for one", (content) => {
    const root = tmp();
    write(join(root, "todo.plain"), MODULE);
    write(join(root, "tests/a.plain"), scenarioFile("todo", "add-task", "# works\nIt works.\n"));
    write(join(root, "tests/b.plain"), content);
    expect(messageOf(() => parse(root, true))).toContain("The `***conformance tests***` section has no scenarios");
  });

  it("checks the required modules first", () => {
    const root = tmp();
    write(join(root, "core.plain"), "***implementation reqs***\n\n- A req.\n\n***functional specs***\n\n# store-task\nIt stores.\n");
    write(join(root, "todo.plain"), "---\nrequires:\n  - core\n---\n\n" + MODULE);
    expect(messageOf(() => parse(root, true))).toContain("Functionality core:store-task has no test plain file");
  });
});
