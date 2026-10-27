import { mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkPlainFile, checkPlainTargets, checkTouchedPlain, formatCheckResults } from "../../src/plain/check.ts";
import { testPlainFileRefusal, testPlainFilesOf } from "../../src/test-plain-files.ts";

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "turri-check-")));
  writeFileSync(join(dir, "config.turri.yaml"), "conformance-tests: false\n");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(path: string, text: string): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
}

const testPlainFile = (module: string, funcId: string, conformance = "", acceptance = "") =>
  `---\nmodule: ${module}\nfunc_id: ${funcId}\n---\n\n***conformance tests***\n\n${conformance}\n***acceptance tests***\n\n${acceptance}`;

const TODO = `***definitions***

- :Task: is a thing to do.

***implementation reqs***

- A requirement.

***functional specs***

# add-task
A :Task: can be added.

# list-tasks
Every :Task: is listed.

# delete-task
A :Task: can be deleted.
`;

/** The todo module, every functional spec with its test plain file. */
function todo(): void {
  write("todo.plain", TODO);
  write("tests/todo/add-task.plain", testPlainFile("todo", "add-task", "# add-one\nIt adds one.\n\n# add-two\nIt adds two.\n", "# add-then-list\nAdd, then list.\n"));
  write("tests/todo/list-tasks.plain", testPlainFile("todo", "list-tasks", "# lists\nIt lists.\n"));
  write("tests/todo/delete-task.plain", testPlainFile("todo", "delete-task"));
}

describe("checkPlainFile", () => {
  it("lists each functional spec of a module that passes with its test plain file and its scenarios", () => {
    todo();
    const result = checkPlainFile(join(dir, "todo.plain"));

    expect(result.ok).toBe(true);
    expect(result.moduleName).toBe("todo");
    expect(formatCheckResults([result])).toBe(
      [
        "PASS  todo.plain  3 functional specs",
        "        add-task     tests/todo/add-task.plain     2 conformance, 1 acceptance",
        "        list-tasks   tests/todo/list-tasks.plain   1 conformance",
        "        delete-task  tests/todo/delete-task.plain  no scenarios - not tested",
      ].join("\n"),
    );
  });

  it("lists every functional spec without a test plain file at once", () => {
    write("todo.plain", TODO);
    write("tests/todo/add-task.plain", testPlainFile("todo", "add-task"));
    const result = checkPlainFile(join(dir, "todo.plain"));

    expect(result.ok).toBe(false);
    expect(formatCheckResults([result])).toBe(
      [
        "FAIL  todo.plain  2 functional specs without a test plain file",
        "        list-tasks - add tests/todo/list-tasks.plain",
        "        delete-task - add tests/todo/delete-task.plain",
      ].join("\n"),
    );
  });

  it("names a required module's functional spec without a test plain file by its module", () => {
    write("base.plain", "***implementation reqs***\n\n- A requirement.\n\n***functional specs***\n\n# start\nIt starts.\n");
    write("app.plain", "---\nrequires:\n  - base\n---\n\n***implementation reqs***\n\n- A requirement.\n\n***functional specs***\n\n# run\nIt runs.\n");
    write("tests/app/run.plain", testPlainFile("app", "run"));

    expect(checkPlainFile(join(dir, "app.plain")).problems).toEqual(["base:start - add tests/base/start.plain"]);
  });

  it("sees a linked resource written after a check that did not find it - in a folder of its own - and one taken away", () => {
    write("app.plain", "***definitions***\n\n- :Api: is the API in [resources/provider/openapi.yaml](resources/provider/openapi.yaml).\n\n***implementation reqs***\n\n- Python.\n\n***functional specs***\n\n# call-the-api\nCall the :Api:.\n");
    write("tests/app/call-the-api.plain", testPlainFile("app", "call-the-api"));
    // Checked before the resource is written - as a check run beside the write that makes it.
    expect(checkPlainFile(join(dir, "app.plain")).error).toContain("Link resources/provider/openapi.yaml does not exist");
    write("resources/provider/openapi.yaml", "openapi: 3.1.0\n");
    expect(checkPlainFile(join(dir, "app.plain")).ok).toBe(true);
    unlinkSync(join(dir, "resources", "provider", "openapi.yaml"));
    expect(checkPlainFile(join(dir, "app.plain")).ok).toBe(false);
  });

  it("sees a scenario written after a check", () => {
    todo();
    expect(checkPlainFile(join(dir, "todo.plain")).functionalSpecs![2]!.conformance).toBe(0);
    write("tests/todo/delete-task.plain", testPlainFile("todo", "delete-task", "# deletes\nIt deletes.\n"));
    expect(checkPlainFile(join(dir, "todo.plain")).functionalSpecs![2]!.conformance).toBe(1);
  });

  it("reports a syntax error with the parser's own message", () => {
    write("broken.plain", "***definitions***\n\n***Nope:***\n");
    const result = checkPlainFile(join(dir, "broken.plain"));

    expect(result.ok).toBe(false);
    expect(result.errorType).toBe("PlainSyntaxError");
    expect(result.error).toContain("Syntax error at line 3 in module 'broken'");
    expect(result.error).toContain("Invalid specification heading");
    expect(result.nextStep).toBeUndefined();
  });

  it("keeps the parser's message for the old syntax and adds turri's next step", () => {
    write("todo.plain", "***implementation reqs***\n\n- A requirement.\n\n***functional specs***\n\n- A task can be added.\n");
    const output = formatCheckResults([checkPlainFile(join(dir, "todo.plain"))]);

    expect(output).toContain("FAIL  todo.plain  PlainSyntaxError");
    expect(output).toContain("Content before the first `# <func-id>` heading in the functional specs section (`A task can be added.`). A functionality is a `# <func-id>` heading followed by its body; the previous syntax is not supported.");
    expect(output).toContain("        todo.plain is in the old ***plain syntax. Ask turri to convert it: it goes one module at a time, proposing func-ids and test plain files, and asks you before writing anything.");
  });

  it("passes a module with no functional specs yet, and says so", () => {
    write("empty.plain", "***implementation reqs***\n\n- A requirement.\n");
    const result = checkPlainFile(join(dir, "empty.plain"));

    expect(result.ok).toBe(true);
    expect(result.functionalSpecs).toEqual([]);
    expect(formatCheckResults([result])).toBe("PASS  empty.plain  no functional specs yet");
  });

  it("refuses a test plain file, naming its module and its functional spec", () => {
    todo();
    const result = checkPlainFile(join(dir, "tests", "todo", "add-task.plain"));
    expect(result.ok).toBe(false);
    expect(result.error).toBe("`tests/todo/add-task.plain` is a test plain file of `todo`; name `todo.plain`, or `todo:add-task` for that one functional spec.");
  });

  it("rejects a file that is not a .plain file", () => {
    expect(checkPlainFile("README.md").error).toContain("Not a .plain file");
  });

  it("rejects a file that does not exist", () => {
    expect(checkPlainFile(join(dir, "nope.plain")).error).toBe("File does not exist.");
  });
});

describe("checking a directory", () => {
  it("checks every .plain module in it", () => {
    todo();
    write("notes.md", "ignored");
    const results = checkPlainTargets(dir);
    expect(results.map((result) => [result.moduleName, result.ok])).toEqual([["todo", true]]);
  });

  it("refuses a test folder, naming its module", () => {
    todo();
    expect(checkPlainTargets(join(dir, "tests", "todo"))[0]!.error).toBe("`tests/todo/` is the test folder of `todo`; name `todo.plain`.");
  });

  it("finds every test plain file outside its module's folder, once, at the end", () => {
    todo();
    write("tests/add-task.plain", testPlainFile("todo", "add-task"));
    write("tests/todos/x.plain", testPlainFile("todo", "add-task"));
    write("tests/todo/elsewhere.plain", testPlainFile("base", "start"));

    const results = checkPlainTargets(join(dir, "todo.plain"));
    expect(formatCheckResults(results.slice(1))).toBe(
      [
        "FAIL  tests/  3 test plain files outside a module's folder",
        "        tests/add-task.plain - move it to tests/todo/ (its module: todo)",
        "        tests/todo/elsewhere.plain - its module: is base, not todo; move it to tests/base/",
        "        tests/todos/x.plain - no module todos; module: todo is in tests/todo/",
      ].join("\n"),
    );
  });
});

describe("checking what a change touched", () => {
  it("checks a touched test plain file as its module", () => {
    todo();
    write("tests/todo/list-tasks.plain", testPlainFile("todo", "list-tasks", "# lists\nA :Note: is listed.\n"));
    const [result] = checkTouchedPlain([join(dir, "tests", "todo", "list-tasks.plain")]);
    expect(result!.file).toBe(join(dir, "todo.plain"));
    expect(result!.error).toContain("Concept :Note: used in scenario `lists` is not defined in module 'todo'");
  });

  it("refuses a test plain file written outside its module's folder", () => {
    todo();
    write("tests/stray.plain", testPlainFile("todo", "add-task"));
    expect(formatCheckResults(checkTouchedPlain([join(dir, "tests", "stray.plain")]))).toContain("tests/stray.plain - move it to tests/todo/ (its module: todo)");
  });

  it("checks the module of a test plain file the change deleted", () => {
    todo();
    unlinkSync(join(dir, "tests", "todo", "delete-task.plain"));
    expect(checkTouchedPlain([join(dir, "tests", "todo", "delete-task.plain")])[0]!.problems).toEqual(["delete-task - add tests/todo/delete-task.plain"]);
  });
});

describe("test plain files of a module", () => {
  it("lists every .plain file in the module's folder of the test folder, sorted", () => {
    todo();
    write("tests/todo/more/extra.plain", testPlainFile("todo", "add-task"));
    expect(testPlainFilesOf(join(dir, "todo.plain")).map((path) => path.slice(dir.length + 1))).toEqual([
      "tests/todo/add-task.plain",
      "tests/todo/delete-task.plain",
      "tests/todo/list-tasks.plain",
      "tests/todo/more/extra.plain",
    ]);
  });

  it("finds them in the folder test-dir names", () => {
    writeFileSync(join(dir, "config.turri.yaml"), "test-dir: scenarios\n");
    write("todo.plain", TODO);
    write("scenarios/todo/add-task.plain", testPlainFile("todo", "add-task"));
    expect(testPlainFilesOf(join(dir, "todo.plain")).map((path) => path.slice(dir.length + 1))).toEqual(["scenarios/todo/add-task.plain"]);
    expect(testPlainFileRefusal(join(dir, "scenarios", "todo", "add-task.plain"))).toContain("is a test plain file of `todo`");
  });

  it("takes a module's .plain file for no test plain file", () => {
    todo();
    expect(testPlainFileRefusal(join(dir, "todo.plain"))).toBeUndefined();
  });
});
