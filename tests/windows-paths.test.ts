import { describe, expect, it, vi } from "vitest";

// turri's own code with Windows paths, on any machine: node:path is Node's win32 one, so `join`, `relative` and `sep`
// behave as they do on Windows. Only code that never touches the disk is tested here - the disk is still this machine's.
vi.mock("node:path", async () => {
  const actual = await vi.importActual<typeof import("node:path")>("node:path");
  return { ...actual.win32, default: actual.win32 };
});

const { isWithin, slashed, resolveTemplateDirs } = await import("../src/regenerate/paths.ts");
const { importLabel } = await import("../src/regenerate/spec-map.ts");
const { ownChanges } = await import("../src/background-skills.ts");
const { sandboxGapOf } = await import("../src/regenerate/environment-error.ts");
const { scriptCommand } = await import("../src/regenerate/test-scripts.ts");

describe("paths on Windows", () => {
  it("runs these tests with Windows paths", async () => {
    const { join, sep } = await import("node:path");
    expect(sep).toBe("\\");
    expect(join("C:\\project", "dist", "app")).toBe("C:\\project\\dist\\app");
  });

  it("knows a path inside a folder, though it does not start with the folder and a slash", () => {
    expect(isWithin("C:\\project\\plain_modules\\app\\code\\main.py", "C:\\project")).toBe(true);
    expect(isWithin("C:\\project", "C:\\project")).toBe(true);
    // Written with forward slashes, as Windows takes them too.
    expect(isWithin("C:/project/code/main.py", "C:\\project")).toBe(true);
  });

  it("does not take a sibling folder whose name starts the same for one inside", () => {
    expect(isWithin("C:\\project-old\\main.py", "C:\\project")).toBe(false);
  });

  it("does not take a path above the folder, or on another drive, for one inside", () => {
    expect(isWithin("C:\\main.py", "C:\\project")).toBe(false);
    expect(isWithin("C:\\project\\..\\other\\main.py", "C:\\project")).toBe(false);
    // relative() across drives gives an absolute path, which starts with neither `..` nor the separator.
    expect(isWithin("D:\\project\\main.py", "C:\\project")).toBe(false);
  });

  it("takes a folder named with two dots for one inside", () => {
    expect(isWithin("C:\\project\\..cache\\x", "C:\\project")).toBe(true);
  });

  it("writes a relative path with forward slashes for a name, as git and the parser do", () => {
    expect(slashed("src\\app\\main.py")).toBe("src/app/main.py");
    expect(slashed("main.py")).toBe("main.py");
  });

  it("splits PLAIN_TEMPLATE_DIRS as Windows splits PATH, keeping each drive letter whole", () => {
    const before = process.env.PLAIN_TEMPLATE_DIRS;
    process.env.PLAIN_TEMPLATE_DIRS = "C:\\templates\\one;D:\\shared\\two";
    try {
      const dirs = resolveTemplateDirs("C:\\project\\app.plain");
      expect(dirs).toContain("C:\\templates\\one");
      expect(dirs).toContain("D:\\shared\\two");
      expect(dirs).not.toContain("C:\\project\\C");
    } finally {
      if (before === undefined) delete process.env.PLAIN_TEMPLATE_DIRS;
      else process.env.PLAIN_TEMPLATE_DIRS = before;
    }
  });

  it("names a standard library template by its import path, and a project's file from the project, with forward slashes", () => {
    expect(importLabel("C:\\turri\\stdlib\\backend\\python-fastapi.plain", "C:\\work\\app", "C:\\turri")).toBe("stdlib/backend/python-fastapi");
    expect(importLabel("C:\\work\\app\\shared\\common.plain", "C:\\work\\app")).toBe("shared/common");
  });

  it("finds the testing script a background skill wrote by its file name, whatever the separator", () => {
    const changed = ["test_scripts\\run_unittests_python.sh", "app.plain", "config.turri.yaml"];
    expect(ownChanges(changed, "unit")).toEqual(["test_scripts\\run_unittests_python.sh", "config.turri.yaml"]);
  });

  it("hands a testing script its folders with forward slashes, which Git Bash's tools read no escapes in", () => {
    const command = scriptCommand("C:\\Users\\anton\\shop\\test_scripts\\run_conformance_tests.sh", [
      "C:\\Users\\anton\\shop\\plain_modules\\app\\code",
      "C:\\Users\\anton\\shop\\plain_modules\\app\\tests",
    ]);
    expect(command).toBe("bash 'C:/Users/anton/shop/test_scripts/run_conformance_tests.sh' 'C:/Users/anton/shop/plain_modules/app/code' 'C:/Users/anton/shop/plain_modules/app/tests'");
  });

  it("reads no sandbox gap from an error, as Windows has no OS sandbox to hide a file", () => {
    const text = "EPERM opening /c/Users/anton/.local/share/mise/installs/node/24.16.0/lib/node_modules/npm/bin/npm-cli.js";
    expect(sandboxGapOf(text, { exists: () => true, platform: "win32" })).toBeUndefined();
  });
});
