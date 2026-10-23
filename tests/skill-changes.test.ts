import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { changedFiles, plainWriteRefusal, plainWriteTools, projectFiles } from "../src/plain-files.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "turri-skill-changes-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("what a skill run changed", () => {
  it("is every .plain file and linked resource added, changed or removed - not the built code, the dependencies or turri's own folders", () => {
    writeFileSync(join(root, "frontend.plain"), "***functional specs***\n\n- Show.\n");
    writeFileSync(join(root, "old.plain"), "***functional specs***\n\n- Old.\n");
    mkdirSync(join(root, "plain_modules", "frontend", "code"), { recursive: true });
    mkdirSync(join(root, ".turri"), { recursive: true });
    const before = projectFiles(root);

    writeFileSync(join(root, "frontend.plain"), "***implementation reqs***\n\n- Use the [brand theme](resources/brand-theme.css).\n\n***functional specs***\n\n- Show.\n");
    mkdirSync(join(root, "resources"));
    writeFileSync(join(root, "resources", "brand-theme.css"), ":root { --brand: #0a7; }\n");
    rmSync(join(root, "old.plain"));
    writeFileSync(join(root, "plain_modules", "frontend", "code", "app.ts"), "export {};\n");
    writeFileSync(join(root, ".turri", "log"), "x\n");

    expect(changedFiles(before, projectFiles(root, before.keys()))).toEqual(["frontend.plain", "old.plain (removed)", join("resources", "brand-theme.css")]);
  });

  it("is the testing scripts and config.turri*.yaml too - those named in the config, whatever they are called", () => {
    writeFileSync(join(root, "config.turri.yaml"), "unittests-script: checks/unit.sh\n");
    mkdirSync(join(root, "checks"));
    writeFileSync(join(root, "checks", "unit.sh"), "#!/bin/sh\n");
    mkdirSync(join(root, "test_scripts"));
    writeFileSync(join(root, "test_scripts", "run_conformance_tests_python.sh"), "#!/bin/sh\n");
    const before = projectFiles(root);

    writeFileSync(join(root, "config.turri.yaml"), "unittests-script: checks/unit.sh\nconformance-tests: false\n");
    writeFileSync(join(root, "checks", "unit.sh"), "#!/bin/sh\nexit 0\n");
    writeFileSync(join(root, "test_scripts", "run_conformance_tests_python.sh"), "#!/bin/sh\nexit 0\n");

    expect(changedFiles(before, projectFiles(root, before.keys()))).toEqual([
      join("checks", "unit.sh"),
      "config.turri.yaml",
      join("test_scripts", "run_conformance_tests_python.sh"),
    ]);
  });

  it("is not a release, or what the app it started writes, changing while it ran", () => {
    writeFileSync(join(root, "taskmgr.plain"), "***functional specs***\n\n- List tasks.\n");
    mkdirSync(join(root, "dist", "task-manager", "tests"), { recursive: true });
    writeFileSync(join(root, "dist", "task-manager", "taskmgr.log"), "started\n");
    writeFileSync(join(root, "dist", "task-manager", "tests", "test_app.py"), "def test(): pass\n");
    const before = projectFiles(root);

    rmSync(join(root, "dist", "task-manager", "taskmgr.log"));
    writeFileSync(join(root, "dist", "task-manager", "tests", "test_app.py"), "def test(): assert True\n");
    writeFileSync(join(root, "dist", "task-manager", "widgets.py"), "x = 1\n");

    expect(changedFiles(before, projectFiles(root, before.keys()))).toEqual([]);
  });

  it("is a resource the run changed and stopped linking", () => {
    writeFileSync(join(root, "app.plain"), "***implementation reqs***\n\n- Use the [theme](theme.css).\n");
    writeFileSync(join(root, "theme.css"), "a {}\n");
    const before = projectFiles(root);

    writeFileSync(join(root, "app.plain"), "***implementation reqs***\n\n- Use no theme.\n");
    writeFileSync(join(root, "theme.css"), "b {}\n");

    expect(changedFiles(before, projectFiles(root, before.keys()))).toEqual(["app.plain", "theme.css"]);
  });

  it("is nothing when the skill wrote nothing - whatever it said", () => {
    writeFileSync(join(root, "frontend.plain"), "x\n");
    expect(changedFiles(projectFiles(root), projectFiles(root))).toEqual([]);
  });
});

describe("what a skill's agent may write", () => {
  beforeEach(() => {
    writeFileSync(join(root, "taskmgr.plain"), "***implementation reqs***\n\n- Use the [theme](resources/theme.css).\n");
    mkdirSync(join(root, "resources"));
    writeFileSync(join(root, "resources", "theme.css"), "a {}\n");
    writeFileSync(join(root, "notes.md"), "mine\n");
    mkdirSync(join(root, "dist", "task-manager"), { recursive: true });
    writeFileSync(join(root, "dist", "task-manager", "widgets.py"), "x = 1\n");
  });

  it("is a .plain file, a resource it links, or a new file a resource or testing script could be", () => {
    expect(plainWriteRefusal(root, "taskmgr.plain")).toBeUndefined();
    expect(plainWriteRefusal(root, join(root, "resources", "theme.css"))).toBeUndefined();
    expect(plainWriteRefusal(root, join("resources", "logo.svg"))).toBeUndefined();
    expect(plainWriteRefusal(root, "run_unittests_python.sh")).toBeUndefined();
  });

  it("is never a release, the built code, turri's folders, a file the ***plain does not link, or outside the project", () => {
    expect(plainWriteRefusal(root, join("dist", "task-manager", "widgets.py"))).toMatch(/not the project's \*\*\*plain/);
    expect(plainWriteRefusal(root, join("dist", "task-manager", "new.py"))).toMatch(/not the project's \*\*\*plain/);
    expect(plainWriteRefusal(root, join("plain_modules", "taskmgr", "code", "app.py"))).toMatch(/not the project's \*\*\*plain/);
    expect(plainWriteRefusal(root, join(".turri", "x"))).toMatch(/not the project's \*\*\*plain/);
    expect(plainWriteRefusal(root, "notes.md")).toMatch(/no .plain file links it/);
    expect(plainWriteRefusal(root, join(root, "..", "elsewhere.plain"))).toMatch(/outside the project/);
  });

  it("is refused by its write and edit tools before anything is written", async () => {
    const [write, edit] = plainWriteTools(root);
    const call = (tool: typeof write, params: object) => tool!.execute("id", params, undefined, undefined, {} as never);
    await expect(call(write, { path: join("dist", "task-manager", "widgets.py"), content: "x = 2\n" })).rejects.toThrow(/not the project's/);
    await expect(call(edit, { path: join("dist", "task-manager", "widgets.py"), edits: [{ oldText: "x = 1", newText: "x = 2" }] })).rejects.toThrow(/not the project's/);
    expect(readFileSync(join(root, "dist", "task-manager", "widgets.py"), "utf8")).toBe("x = 1\n");

    await call(write, { path: join("resources", "brand", "logo.svg"), content: "<svg/>" });
    expect(readFileSync(join(root, "resources", "brand", "logo.svg"), "utf8")).toBe("<svg/>");
  });
});
