import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { plainFileParser } from "../../src/plain/parser.ts";
import { recordHistory } from "../../src/regenerate/lineage.ts";
import { resolveTemplateDirs } from "../../src/regenerate/paths.ts";
import { chainTree, codeTree, conformanceTarget, hasScenarios, inheritedRecord, inheritedTestsRecord, isOldRecord, notBuilt, readRecord, RECORD_FILE, testedFuncIds, writeCodeRecord } from "../../src/regenerate/records.ts";
import { writePlain } from "../test-plain.ts";
import { listFiles } from "../../src/regenerate/testing.ts";

let dir: string;
let build: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "turri-records-"));
  build = join(dir, "build");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Functional specs of the codebase's own, by func-id, as notBuilt takes and gives them. */
const refs = (funcIds: string[]) => funcIds.map((funcId) => ({ funcId }));
const items = (texts: string[]) => texts.map((markdown) => ({ markdown }));
/** Functional specs, each with its func-id and no scenarios. */
const specs = (entries: Array<[string, string]>) => entries.map(([id, markdown]) => ({ id, markdown, linked_resources: [], conformance_tests: [], acceptance_tests: [] }));
/** Functional specs, each with its func-id and one acceptance scenario: what conformance tests are written for. */
const tested = (entries: Array<[string, string]>) => specs(entries).map((item) => ({ ...item, acceptance_tests: [{ id: "works", text: `${item.markdown} It works.` }] }));

describe("a codebase built on another's code", () => {
  const base = { definitions: items(["- :User: is a person."]), "implementation reqs": items(["- :Implementation: is Python."]), "functional specs": specs([["register", "A :User: registers."]]) };

  it("starts from that code's record as a lower module's: its definitions and reqs tagged with it, its functional specs inherited - none of its own", () => {
    expect(inheritedRecord(base, "base")).toEqual({
      definitions: [{ markdown: "- :User: is a person.", module: "base" }],
      "implementation reqs": [{ markdown: "- :Implementation: is Python.", module: "base" }],
      "required functional specs": [{ id: "register", markdown: "A :User: registers.", linked_resources: [], module: "base" }],
    });
  });

  it("is built from the whole chain's definitions and reqs - the lower modules' tagged, bottom first, and one the module shares with them only once", () => {
    const top = { definitions: items(["- :User: is a person.", "- :Page: is a screen."]), "implementation reqs": items(["- Uses Flask."]), "functional specs": specs([["show-a-page", "Show a :Page:."]]) };
    expect(chainTree([{ module: "base", tree: base }, { module: "top", tree: top }])).toEqual({
      definitions: [{ markdown: "- :User: is a person.", module: "base" }, { markdown: "- :Page: is a screen." }],
      "implementation reqs": [{ markdown: "- :Implementation: is Python.", module: "base" }, { markdown: "- Uses Flask." }],
      "functional specs": specs([["show-a-page", "Show a :Page:."]]),
    });
  });
});

describe("a record written by an earlier turri", () => {
  it("is old when it is in an earlier format: nothing is built on it", () => {
    mkdirSync(build, { recursive: true });
    writeFileSync(
      join(build, RECORD_FILE),
      JSON.stringify({ version: 2, module: "app", "functional specs": [{ module: "app", frid: "1", spec: "- One.", unitTests: "passed" }] }),
    );
    expect(isOldRecord(readRecord(build))).toBe(true);
  });

  it("is old when it is in the first format", () => {
    mkdirSync(build, { recursive: true });
    writeFileSync(join(build, RECORD_FILE), JSON.stringify({ module: "app", functionalities: { "1": { frid: "1", unitTests: "passed", specifications: {} } } }));
    expect(isOldRecord(readRecord(build))).toBe(true);
  });

  it("is old when its functional specs were numbered, before they had func-ids", () => {
    expect(isOldRecord({ "functional specs": [{ markdown: "- One." }] })).toBe(true);
    expect(isOldRecord({ "required functional specs": [{ markdown: "- One.", module: "base", frid: "1" }] })).toBe(true);
    expect(isOldRecord({ "functional specs": specs([["one", "One."]]) })).toBe(false);
    expect(isOldRecord({ "implementation reqs": items(["- A requirement."]) })).toBe(false);
  });

  it("is nothing built when it does not read", () => {
    mkdirSync(build, { recursive: true });
    writeFileSync(join(build, RECORD_FILE), "not json");
    expect(readRecord(build)).toBeNull();
  });
});

describe("what the code is built from", () => {
  it("leaves out the test reqs, the test plain files and every functional spec's scenarios", () => {
    const tree = {
      "test reqs": items(["- Tests use pytest."]),
      "test plain files": { "tests/app/one.plain": { module: "app", func_id: "one" } },
      "functional specs": [{ id: "one", markdown: "One.", linked_resources: [], conformance_tests: [{ id: "works", text: "It works.", linked_resources: [] }], acceptance_tests: [] }],
    };
    expect(codeTree(tree)).toEqual({ "functional specs": [{ id: "one", markdown: "One.", linked_resources: [] }] });
  });
});

describe("what the conformance tests are written for", () => {
  const code = { "functional specs": specs([["add-task", "Add a task."], ["list-tasks", "List the tasks."]]) };

  it("takes each functional spec the code is built from as the spec has it, in the spec's order, matched by func-id", () => {
    const spec = { "functional specs": tested([["list-tasks", "List the tasks."], ["add-task", "Add a task."]]) };
    expect((conformanceTarget(code, null, spec)["functional specs"] as Array<{ id: string }>).map((item) => item.id)).toEqual(["list-tasks", "add-task"]);
  });

  it("keeps a functional spec's tests as they are while its code is behind its spec", () => {
    const tests = { "functional specs": tested([["add-task", "Add a task."]]) };
    const spec = { "functional specs": tested([["add-task", "Add a task, named."], ["list-tasks", "List the tasks."]]) };
    expect(conformanceTarget(code, tests, spec)["functional specs"]).toEqual([...tested([["add-task", "Add a task."]]), ...tested([["list-tasks", "List the tasks."]])]);
  });

  it("takes out the tests of a functional spec only once the code has dropped it too", () => {
    const tests = { "functional specs": tested([["add-task", "Add a task."], ["list-tasks", "List the tasks."]]) };
    const spec = { "functional specs": tested([["add-task", "Add a task."]]) };
    expect((conformanceTarget(code, tests, spec)["functional specs"] as Array<{ id: string }>).map((item) => item.id)).toEqual(["add-task", "list-tasks"]);
    const dropped = { "functional specs": specs([["add-task", "Add a task."]]) };
    expect((conformanceTarget(dropped, tests, spec)["functional specs"] as Array<{ id: string }>).map((item) => item.id)).toEqual(["add-task"]);
  });

  it("leaves out a functional spec with no scenarios - an empty test plain file is not tested", () => {
    const spec = { "functional specs": [...tested([["add-task", "Add a task."]]), ...specs([["list-tasks", "List the tasks."]])] };
    expect((conformanceTarget(code, null, spec)["functional specs"] as Array<{ id: string }>).map((item) => item.id)).toEqual(["add-task"]);
  });

  it("takes out the tests of a functional spec whose scenarios were all taken out, its code built", () => {
    const tests = { "functional specs": tested([["add-task", "Add a task."], ["list-tasks", "List the tasks."]]) };
    const spec = { "functional specs": [...tested([["add-task", "Add a task."]]), ...specs([["list-tasks", "List the tasks."]])] };
    expect((conformanceTarget(code, tests, spec)["functional specs"] as Array<{ id: string }>).map((item) => item.id)).toEqual(["add-task"]);
  });

  it("knows a functional spec with scenarios of either kind as tested", () => {
    expect(hasScenarios(specs([["add-task", "Add a task."]])[0])).toBe(false);
    expect(hasScenarios(tested([["add-task", "Add a task."]])[0])).toBe(true);
    expect(hasScenarios({ ...specs([["add-task", "Add a task."]])[0], conformance_tests: [{ id: "adds", text: "It adds." }] })).toBe(true);
    expect(testedFuncIds({ "functional specs": [...specs([["list-tasks", "List."]]), ...tested([["add-task", "Add."]])] })).toEqual(["add-task"]);
  });

  it("takes in the functional specs of the modules below with scenarios, each by its module and func-id - the tip's suite holds the chain's", () => {
    const below = (entries: Array<[string, string]>, scenarios = true) => (scenarios ? tested(entries) : specs(entries)).map((item) => ({ ...item, module: "base" }));
    const built = { "required functional specs": below([["register", "A user registers."], ["log-in", "A user logs in."]], false), "functional specs": specs([["add-task", "Add a task."]]) };
    const spec = { "required functional specs": [...below([["register", "A user registers."]]), ...below([["log-in", "A user logs in."]], false)], "functional specs": tested([["add-task", "Add a task."]]) };
    const target = conformanceTarget(built, null, spec);
    expect(target["required functional specs"]).toEqual(below([["register", "A user registers."]]));
    expect((target["functional specs"] as Array<{ id: string }>).map((item) => item.id)).toEqual(["add-task"]);
    // The code of one below behind its spec: its tests stay as they are.
    const now = { ...spec, "required functional specs": below([["register", "A user registers twice."]]) };
    expect(conformanceTarget(built, target, now)["required functional specs"]).toEqual(below([["register", "A user registers."]]));
    expect(notBuilt(built, now, [{ module: "base", funcId: "register" }, { funcId: "add-task" }], "app")).toEqual([{ module: "base", funcId: "register" }]);
  });

  it("starts a module built on another from that one's tests record, as what it inherits", () => {
    const below = { "test reqs": items(["- :ConformanceTests: use pytest."]), definitions: items(["- :User: is a person."]), "functional specs": tested([["register", "A :User: registers."]]) };
    expect(inheritedTestsRecord(below, "base")).toEqual({
      "test reqs": items(["- :ConformanceTests: use pytest."]),
      definitions: [{ markdown: "- :User: is a person.", module: "base" }],
      "required functional specs": tested([["register", "A :User: registers."]]).map((item) => ({ ...item, module: "base" })),
    });
  });

  it("names the functional specs the code record does not have as the spec has them", () => {
    const spec = { "functional specs": specs([["add-task", "Add a task."], ["list-tasks", "List every task."], ["delete-task", "Delete a task."]]) };
    expect(notBuilt(code, spec, refs(["add-task", "list-tasks", "delete-task"]))).toEqual(refs(["list-tasks", "delete-task"]));
  });
});

describe("the code record on disk", () => {
  it("is written without the sections it has nothing in", () => {
    writeCodeRecord(build, { definitions: [], "functional specs": specs([["one", "One."]]) });
    expect(JSON.parse(readFileSync(join(build, RECORD_FILE), "utf8"))).toEqual({ "functional specs": [{ id: "one", markdown: "One.", linked_resources: [] }] });
  });

  it("is left out of the build manifest", () => {
    mkdirSync(build, { recursive: true });
    writeFileSync(join(build, "app.py"), "print('hi')\n");
    writeCodeRecord(build, { "functional specs": specs([["one", "One."]]) });

    expect(existsSync(join(build, RECORD_FILE))).toBe(true);
    expect(listFiles(build)).toEqual(["app.py"]);
  });

  it("is read as the harness last committed it - a change an agent's shell made to the file is not carried on", () => {
    const code = join(dir, "plain_modules", "app", "code");
    const spec = (items: Array<[string, string]>) => ({ "implementation reqs": [{ markdown: "- Python." }], "functional specs": items.map(([id, markdown]) => ({ id, markdown, linked_resources: [] })) });
    writeCodeRecord(code, spec([["say-hello", "Say hello."]]));
    writeFileSync(join(code, "app.py"), "print('hello')\n");
    recordHistory(code, "render app:say-hello");
    // An agent's shell rewrites the record mid-render: it claims a functional spec nobody built.
    writeFileSync(join(code, RECORD_FILE), JSON.stringify(spec([["say-hello", "Say hello."], ["launch", "Launch the rockets."]])));
    expect(readRecord(code)).toEqual(spec([["say-hello", "Say hello."]]));
    expect(readRecord(code, { onDisk: true })!["functional specs"]).toHaveLength(2);
  });
});

describe("conformance is optional", () => {
  const NO_TEST_REQS = `***implementation reqs***\n\n- A requirement.\n\n***functional specs***\n\n# one\nOne.\n`;
  const WITH_TEST_REQS = `***implementation reqs***\n\n- A requirement.\n\n***test reqs***\n\n- Conformance tests run with pytest.\n\n***functional specs***\n\n# one\nOne.\n`;

  it("refuses to write conformance tests without test reqs", async () => {
    const { renderConformanceTests } = await import("../../src/regenerate/conformance.ts");
    writePlain(dir, "app.plain", NO_TEST_REQS);
    writeFileSync(join(build_dir(), "placeholder.txt"), "code");

    await expect(
      renderConformanceTests({ plainFile: join(dir, "app.plain"), funcId: "one", buildDir: build, dryRun: true }),
    ).rejects.toThrow(/has no test reqs/);
  });

  it("is available when the module has test reqs", () => {
    writePlain(dir, "app.plain", WITH_TEST_REQS);
    const t = plainFileParser("app.plain", resolveTemplateDirs(join(dir, "app.plain")))[1];
    expect(t["test reqs"]).toHaveLength(1);
  });

  function build_dir() {
    const { mkdirSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(build, { recursive: true });
    return build;
  }
});
