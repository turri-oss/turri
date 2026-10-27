import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildConformancePrompt } from "../../src/regenerate/prompt.ts";
import { conformanceLabel, labelsPrompt, labelsPromptFor, misplacedConformanceTests, misplacedTestsPrompt, missingTestLabels, scenarioLabel } from "../../src/regenerate/test-kinds.ts";

let tests: string;
beforeEach(() => {
  tests = mkdtempSync(join(tmpdir(), "turri-test-kinds-"));
});
afterEach(() => rmSync(tests, { recursive: true, force: true }));

/** register's scenarios: one of each kind. */
const register = {
  funcId: "register",
  conformance: [{ id: "twice", text: "Registering twice with one email is refused." }],
  acceptance: [{ id: "then-log-in", text: "A new user can log in." }],
};

describe("telling which scenario a test carries out", () => {
  it("finds the file's label and a test for each scenario, of either kind", () => {
    writeFileSync(join(tests, "test_conformance_register.py"), "# conformance tests of users:register\n# conformance scenario twice of users:register\ndef test_a(): ...\n");
    mkdirSync(join(tests, "acceptance"));
    writeFileSync(join(tests, "acceptance", "test_acceptance_register.py"), "# Acceptance scenario then-log-in of users:register\ndef test_b(): ...\n");
    expect(missingTestLabels(tests, "users", register)).toEqual([]);
  });

  it("says which scenario has no test of its own, and when the file is unlabelled", () => {
    writeFileSync(join(tests, "test_register.py"), "# conformance scenario twice of users:register\n");
    expect(missingTestLabels(tests, "users", register)).toEqual([
      'No test file is labelled "conformance tests of users:register".',
      'No test is labelled "acceptance scenario then-log-in of users:register": A new user can log in.',
    ]);
  });

  it("matches a label on the whole key: todo:log-in's is never found in todo:log-in-2's", () => {
    writeFileSync(join(tests, "test_x.py"), "# conformance tests of todo:log-in-2\n# conformance scenario ok of todo:log-in-2\n");
    const logIn = { funcId: "log-in", conformance: [{ id: "ok", text: "It logs in." }], acceptance: [] };
    expect(missingTestLabels(tests, "todo", logIn)).toHaveLength(2);
    expect(missingTestLabels(tests, "todo", { ...logIn, funcId: "log-in-2" })).toEqual([]);
  });

  it("asks for the file's label alone for a functional spec given no scenarios", () => {
    writeFileSync(join(tests, "test_x.py"), "# conformance tests of todo:log-in\n");
    expect(missingTestLabels(tests, "todo", { funcId: "log-in", conformance: [], acceptance: [] })).toEqual([]);
  });

  it("never takes another module's label for the functional spec's own", () => {
    writeFileSync(join(tests, "test_x.py"), "# conformance tests of base:log-in\n");
    expect(missingTestLabels(tests, "todo", { funcId: "log-in", conformance: [], acceptance: [] })).toEqual(['No test file is labelled "conformance tests of todo:log-in".']);
  });
});

describe("asking for the labels", () => {
  it("asks for every functional spec's missing labels in one request, a line each, keeping the labels there already", () => {
    const prompt = labelsPromptFor(
      "todo",
      ["add-task", "list-tasks", "delete-task"].map((funcId) => ({ funcId, missing: funcId === "add-task" ? [] : [`No test file is labelled "${conformanceLabel("todo", funcId)}".`] })),
      false,
    );
    expect(prompt).toContain("Missing, for functional specs todo:list-tasks and todo:delete-task:");
    expect(prompt).toContain('No test file is labelled "conformance tests of todo:list-tasks".');
    expect(prompt).toContain('No test file is labelled "conformance tests of todo:delete-task".');
    expect(prompt).toContain("A file that tests several functional specs has one such line for each.");
    expect(prompt).toContain('"conformance scenario <scenario-id> of todo:list-tasks"');
    expect(prompt).toContain("Keep every label and every test that is there already");
  });

  it("never says the tests pass before anything has checked, and says there are none when the folder is empty", () => {
    const missing = labelsPrompt("todo", "log-in", ['No test file is labelled "conformance tests of todo:log-in".']);
    expect(missing).not.toContain("The tests pass");
    expect(missing).toContain("not labelled yet");
    expect(labelsPrompt("todo", "log-in", ["x"], true)).toContain("There are no tests in your tests folder");
  });
});

describe("the conformance prompt", () => {
  const input = (scenarios: { conformance?: Array<{ id: string; text: string }>; acceptance?: Array<{ id: string; text: string }> }) => ({
    moduleName: "users",
    funcId: "register",
    funcIds: ["log-in", "register"],
    specifications: {
      "definitions": [],
      "implementation reqs": [],
      "test reqs": ["- pytest"],
      "functional specs": ["A user can log in.", "A user can register."],
      conformance_tests: scenarios.conformance ?? [],
      acceptance_tests: scenarios.acceptance ?? [],
    } as never,
    linkedResources: [],
    manifest: ["app.py"],
  });

  it("gives each scenario under its label, in its kind's tag, and carries out exactly them - no test of its own", () => {
    const prompt = buildConformancePrompt(input({ conformance: register.conformance, acceptance: register.acceptance }));
    expect(prompt).toContain("<conformance tests>\nconformance scenario twice of users:register:\nRegistering twice with one email is refused.\n</conformance tests>");
    expect(prompt).toContain("<acceptance tests>\nacceptance scenario then-log-in of users:register:\nA new user can log in.\n</acceptance tests>");
    expect(prompt).toContain("carry out the scenarios");
    expect(prompt).toContain("Write no test that is not a scenario's");
    expect(prompt).toContain('"conformance tests of users:register"');
    expect(prompt).not.toContain("as if no acceptance tests had been given");
  });

  it("leaves out the tag of a kind with no scenarios", () => {
    const prompt = buildConformancePrompt(input({ conformance: register.conformance }));
    expect(prompt).toContain("<conformance tests>");
    expect(prompt).not.toContain("<acceptance tests>\n");
  });
});

describe("conformance tests in the code folder", () => {
  /** A file in the code folder under test. */
  const write = (file: string, content: string) => {
    mkdirSync(join(tests, file, ".."), { recursive: true });
    writeFileSync(join(tests, file), content);
  };

  it("are found by their label, or as test files named or foldered for conformance or acceptance", () => {
    write("src/app.py", "print('hi')\n");
    write("tests/test_app.py", "def test_unit(): pass\n");
    write("conformance_tests/test_conformance.py", "def test_x(): pass\n");
    write("tests/test_login.py", `# ${conformanceLabel("todo", "log-in")}\ndef test_login(): pass\n`);
    write("tests/test_accept_1.py", `# ${scenarioLabel("acceptance", "works", "todo", "add-task")}\n`);
    expect(misplacedConformanceTests(tests).sort()).toEqual(["conformance_tests/test_conformance.py", "tests/test_accept_1.py", "tests/test_login.py"]);
  });

  it("are none in a code folder with only code and its unit tests - the working notes may name a label", () => {
    write("src/app.py", "print('hi')\n");
    write("tests/test_app.py", "def test_unit(): pass\n");
    write(".turri-notes.md", `- ${conformanceLabel("todo", "log-in")} are in the tests folder\n`);
    expect(misplacedConformanceTests(tests)).toEqual([]);
  });

  it("are sent back to be removed by the code agent, and moved by the conformance agent", () => {
    expect(misplacedTestsPrompt(["tests/test_login.py"], "/p/code")).toContain("are not yours to write");
    expect(misplacedTestsPrompt(["tests/test_login.py"], "/p/code", "/p/tests")).toContain("live in your working directory, /p/tests");
  });
});
