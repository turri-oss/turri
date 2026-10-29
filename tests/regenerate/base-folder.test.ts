import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkPlainFile } from "../../src/plain/check.ts";
import {
  baseFiles,
  baseFolderDrift,
  baseOfCodebase,
  inCodebaseOf,
  MissingBaseFolderError,
  readBaseRecord,
  seedFromBaseFolder,
} from "../../src/regenerate/base-folder.ts";
import { createJobRegistry } from "../../src/regenerate/jobs.ts";
import { recordHistory } from "../../src/regenerate/lineage.ts";
import { createWorkLoop, describeDrift, type JobRunner } from "../../src/regenerate/loop.ts";
import { codeFixerTask } from "../../src/regenerate/conformance-agents.ts";
import { baseFolderBlock, buildRegressionFixPrompt, buildSpecDiffPrompt, reviewedSpec } from "../../src/regenerate/prompt.ts";
import { writeCodeRecord } from "../../src/regenerate/records.ts";
import { listFiles } from "../../src/regenerate/testing.ts";
import { checkBaseFolders } from "../../src/setup.ts";
import { writeTestScripts } from "../test-scripts.ts";

// A project whose code starts from a base folder: an existing app's source, an image, and what never belongs in a
// codebase - installed dependencies.
let dir: string;
let cwd: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "turri-base-folder-")));
  cwd = process.cwd();
  process.chdir(dir);
  writeFileSync(join(dir, "config.turri.yaml"), "module: app.plain\nbase-folder: existing\n");
  writeTestScripts(dir);
  file("existing/src/main.py", "print('hello')\n");
  file("existing/assets/logo.svg", "<svg/>\n");
  file("existing/node_modules/left-pad/index.js", "module.exports = 1;\n");
  file("app.plain", app(["Say hello."]));
});
afterEach(() => {
  process.chdir(cwd);
  rmSync(dir, { recursive: true, force: true });
});

function file(path: string, text: string): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
}

const slug = (line: string) => line.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const app = (specs: string[], requires?: string) =>
  `${requires !== undefined ? `---\nrequires:\n  - ${requires}\n---\n\n` : ""}***implementation reqs***\n\n- :Implementation: is Python.\n\n***functional specs***\n\n${specs.map((line) => `# ${slug(line)}\n${line}`).join("\n\n")}\n`;

/** A runner that lands what it is given, noting the files each pulse found its codebase holding as it started. */
function runner(touch?: (buildDir: string) => void) {
  const ran: Array<{ module: string; files: string[] }> = [];
  const run: JobRunner = async (job) => {
    ran.push({ module: job.moduleName, files: listFiles(job.buildDir).sort() });
    touch?.(job.buildDir);
    writeFileSync(join(job.buildDir, `${job.moduleName}.py`), `# ${job.planned.title}\n`, { flag: "a" });
    writeCodeRecord(job.buildDir, job.spec.tree);
    recordHistory(job.buildDir, job.planned.title);
    return { landed: true, report: "landed" };
  };
  return { ran, run };
}

const codeOf = (module: string) => join(dir, "plain_modules", module, "code");

describe("a base folder", () => {
  it("is what a codebase that requires nothing starts from - every file but installed dependencies - recorded, and never written to", () => {
    const record = seedFromBaseFolder(codeOf("app"), join(dir, "app.plain"), "app");
    expect(record).toMatchObject({ folder: "existing", files: ["assets/logo.svg", "src/main.py"] });
    expect(readFileSync(join(codeOf("app"), "src", "main.py"), "utf8")).toBe("print('hello')\n");
    expect(existsSync(join(codeOf("app"), "node_modules"))).toBe(false);
    expect(readBaseRecord(codeOf("app"))).toEqual(record);
    // The record is never code: not listed, not shown, not copied as a file the agents wrote.
    expect(listFiles(codeOf("app")).sort()).toEqual(["assets/logo.svg", "src/main.py"]);
  });

  it("taken from a git repo, is what git sees: tracked files, and untracked ones it does not ignore", () => {
    const git = (...args: string[]) => spawnSync("git", ["-C", join(dir, "existing"), ...args], { encoding: "utf8" });
    git("init", "-q");
    file("existing/.gitignore", "build/\n");
    file("existing/build/out.bin", "x");
    git("add", "src/main.py", ".gitignore");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "start");
    expect(baseFiles(join(dir, "existing"))).toEqual([".gitignore", "assets/logo.svg", "node_modules/left-pad/index.js", "src/main.py"]);
    file("existing/.gitignore", "build/\nnode_modules/\n");
    expect(baseFiles(join(dir, "existing"))).toEqual([".gitignore", "assets/logo.svg", "src/main.py"]);
  });

  it("is seeded by the work loop before the codebase's first pulse, and only then", async () => {
    const { ran, run } = runner();
    const loop = createWorkLoop({ registry: createJobRegistry({ maxRunning: 1 }), cwd: dir, planner: false, run });
    await loop.bringUp("app.plain");
    await loop.drain();
    expect(ran[0]).toEqual({ module: "app", files: ["assets/logo.svg", "src/main.py"] });
    // A later pulse starts from what the last one left, not from the folder again.
    file("app.plain", app(["Say hello.", "Say goodbye."]));
    await loop.bringUp("app.plain", { specChange: true });
    await loop.drain();
    expect(ran[1]!.files).toEqual(["app.py", "assets/logo.svg", "src/main.py"]);
  });

  it("reaches a module built on the codebase that started from it as that codebase finished it - changed files and all", async () => {
    file("app.plain", app(["Say hello."], "core"));
    file("core.plain", app(["Store the greeting."]));
    // The core's pulse changes a file that came from the base folder.
    const { ran, run } = runner((buildDir) => {
      if (buildDir === codeOf("core")) appendFileSync(join(buildDir, "src", "main.py"), "print('changed by core')\n");
    });
    const loop = createWorkLoop({ registry: createJobRegistry({ maxRunning: 1 }), cwd: dir, planner: false, run });
    await loop.bringUp("app.plain");
    await loop.drain();
    expect(ran.map((pulse) => pulse.module)).toEqual(["core", "app"]);
    expect(ran[1]!.files).toEqual(["assets/logo.svg", "core.py", "src/main.py"]);
    expect(readFileSync(join(codeOf("app"), "src", "main.py"), "utf8")).toContain("changed by core");
    // What it started from comes up with the code: the app's agents are told of the base folder too.
    expect(baseOfCodebase(codeOf("app"))).toEqual({ folder: "existing", files: ["assets/logo.svg", "src/main.py"] });
    expect(readFileSync(join(dir, "existing", "src", "main.py"), "utf8")).toBe("print('hello')\n");
  });

  it("is started from again when the module is regenerated from scratch, as it is then", async () => {
    const { ran, run } = runner();
    const loop = createWorkLoop({ registry: createJobRegistry({ maxRunning: 1 }), cwd: dir, planner: false, run });
    await loop.bringUp("app.plain");
    await loop.drain();
    file("existing/assets/icon.png", "png");
    expect(baseFolderDrift(codeOf("app"), join(dir, "app.plain"))).toBe("its base folder existing changed since its codebase started from it - regenerate it from scratch to start again from it");
    expect(describeDrift(loop.drift("app.plain"))).toContain("  its base folder existing changed since its codebase started from it");
    await loop.fromScratch("app.plain");
    await loop.drain();
    expect(ran.at(-1)!.files).toEqual(["assets/icon.png", "assets/logo.svg", "src/main.py"]);
    expect(baseFolderDrift(codeOf("app"), join(dir, "app.plain"))).toBeUndefined();
  });

  it("not there stops the first pulse before it starts - and validate, doctor and drift say so beforehand", async () => {
    writeFileSync(join(dir, "config.turri.yaml"), "module: app.plain\nbase-folder: nowhere\n");
    expect(() => seedFromBaseFolder(codeOf("app"), join(dir, "app.plain"), "app")).toThrow(MissingBaseFolderError);
    expect(checkPlainFile(join(dir, "app.plain")).warnings).toEqual(["its base folder nowhere (base-folder:) is not there - its codebase's first pulse stops until it is"]);
    expect(checkBaseFolders(dir)).toEqual([expect.objectContaining({ level: "missing", name: "base folder nowhere" })]);
    const { ran, run } = runner();
    const loop = createWorkLoop({ registry: createJobRegistry({ maxRunning: 1 }), cwd: dir, planner: false, run });
    expect(describeDrift(loop.drift("app.plain"))).toContain("its base folder nowhere is not there - its first pulse stops until it is");
    await loop.bringUp("app.plain");
    await loop.drain();
    expect(ran).toEqual([]);
  });

  it("is in the status a host reads of the module: the folder, and how many of its files the codebase has still", async () => {
    const { run } = runner();
    const loop = createWorkLoop({ registry: createJobRegistry({ maxRunning: 1 }), cwd: dir, planner: false, run });
    // Nothing built yet: no code, so none.
    expect(loop.status().find((status) => status.module === "app")?.base).toBeUndefined();
    await loop.bringUp("app.plain");
    await loop.drain();
    expect(loop.status().find((status) => status.module === "app")!.base).toEqual({ folder: "existing", files: 2 });
    // A file from it taken out by a pulse that lands: counted again.
    const { run: removing } = runner((buildDir) => rmSync(join(buildDir, "assets", "logo.svg")));
    const again = createWorkLoop({ registry: createJobRegistry({ maxRunning: 1 }), cwd: dir, planner: false, run: removing });
    file("app.plain", app(["Say hello.", "Say goodbye."]));
    await again.bringUp("app.plain");
    await again.drain();
    expect(again.status().find((status) => status.module === "app")!.base).toEqual({ folder: "existing", files: 1 });
  });

  it("is in the status of a module built on the codebase that started from it - and of none that did not", async () => {
    file("app.plain", app(["Say hello."], "core"));
    file("core.plain", app(["Store the greeting."]));
    const { run } = runner();
    const loop = createWorkLoop({ registry: createJobRegistry({ maxRunning: 1 }), cwd: dir, planner: false, run });
    await loop.bringUp("app.plain");
    await loop.drain();
    expect(loop.status().find((status) => status.module === "app")!.base).toEqual({ folder: "existing", files: 2 });

    writeFileSync(join(dir, "config.turri.yaml"), "module: other.plain\n");
    file("other.plain", app(["Say other."]));
    await loop.bringUp("other.plain");
    await loop.drain();
    expect(loop.status().find((status) => status.module === "other")).toBeDefined();
    expect(loop.status().find((status) => status.module === "other")!.base).toBeUndefined();
  });

  it("is said by doctor with its files when it is there", () => {
    expect(checkBaseFolders(dir)).toEqual([{ level: "ok", name: "base folder existing", detail: "2 files to start a codebase from - named in config.turri.yaml" }]);
  });
});

describe("what a coding agent is told of a base folder", () => {
  it("is that its codebase started from it, and the files from it still there - for code or files alike - capped", () => {
    const files = Array.from({ length: 205 }, (_, at) => `img/${String(at).padStart(3, "0")}.png`);
    const block = baseFolderBlock({ folder: "brand", files })!;
    expect(block).toContain('<base folder name="brand">\nThis codebase started from a copy of the base folder brand.');
    expect(block).toContain("code to build on, files to\nuse, or both");
    expect(block).toContain("- img/199.png\n- ... and 5 more\n</base folder>");
    expect(block).not.toContain("img/200.png");
  });

  it("is in the coding agent's prompt, with what it keeps - and nothing built yet is said as the folder's files, not an empty folder", () => {
    const prompt = buildSpecDiffPrompt({
      moduleName: "app",
      diff: "",
      specifications: { definitions: [], "implementation reqs": [], "test reqs": [], "functional specs": [], "conformance tests": [], "acceptance tests": [] } as never,
      funcIds: [],
      required: [],
      linkedResources: [{ text: "logo", target: "existing/assets/logo.svg", content: "<svg/>", inCodebase: "assets/logo.svg" }],
      codebase: "src/main.py",
      empty: false,
      base: { folder: "existing", files: ["assets/logo.svg", "src/main.py"] },
    });
    expect(prompt).toContain("Nothing is built from the specification yet: the working directory holds what the base folder had");
    expect(prompt).toContain('<base folder name="existing">');
    expect(prompt).toContain("- What came from the base folder stays, used where it is, unless a functional spec asks otherwise");
    // A linked file from the base folder is in the codebase already: its path there, never a copy.
    expect(prompt).toContain('<resource name="logo" path="existing/assets/logo.svg" in-codebase="assets/logo.svg">');
    expect(prompt).not.toContain("code-copy=");
  });

  it("tells a codebase's first pulse to build on what the base folder had, never to set the project up anew", () => {
    const input = {
      moduleName: "app", diff: "", specifications, funcIds: [], required: [], linkedResources: [], codebase: "src/main.py", empty: false,
      cases: { fresh: true, add: [{ funcId: "say-hello", text: "Say hello." }], patch: [], again: [], delete: [] } as never,
    };
    const from = buildSpecDiffPrompt({ ...input, base });
    expect(from).toContain("- Nothing is built from the specification yet, and the codebase holds what the base folder had.");
    expect(from).not.toContain("set the project up first");
    expect(buildSpecDiffPrompt(input)).toContain("- Nothing is built yet: set the project up first");
  });

  it("marks a linked file in-codebase only when it came from the base folder and the codebase has it still", () => {
    seedFromBaseFolder(codeOf("app"), join(dir, "app.plain"), "app");
    const plainFile = join(dir, "app.plain");
    expect(inCodebaseOf(join(dir, "existing", "assets", "logo.svg"), codeOf("app"), plainFile)).toBe("assets/logo.svg");
    expect(inCodebaseOf(join(dir, "elsewhere", "logo.svg"), codeOf("app"), plainFile)).toBeUndefined();
    rmSync(join(codeOf("app"), "assets", "logo.svg"));
    expect(inCodebaseOf(join(dir, "existing", "assets", "logo.svg"), codeOf("app"), plainFile)).toBeUndefined();
  });

  const specifications = { definitions: [], "implementation reqs": [], "test reqs": [], "functional specs": [], "conformance tests": [], "acceptance tests": [] } as never;
  const base = { folder: "existing", files: ["assets/logo.svg", "src/main.py"] };

  it("is told the reviewer too: what came from it is not the work's, kept - neither scope crept in nor left over", () => {
    const spec = reviewedSpec({ moduleName: "app", specifications, funcIds: [], change: "(a change)", base });
    expect(spec).toContain('<base folder name="existing">');
    expect(spec).toContain("a file from it that no functional spec names is kept as it is -\nnot scope crept in, nor something left to clean up");
    expect(reviewedSpec({ moduleName: "app", specifications, funcIds: [], change: "(a change)" })).not.toContain("<base folder");
  });

  it("is told the repair agent and the code fixer too, with what a fix keeps", () => {
    const repair = buildRegressionFixPrompt({ moduleName: "app", funcIds: [], specifications, failure: "it failed", base });
    expect(repair).toContain('<base folder name="existing">');
    expect(repair).toContain("- What came from the base folder stays, used where it is");
    seedFromBaseFolder(codeOf("app"), join(dir, "app.plain"), "app");
    const fixer = codeFixerTask({ buildDir: codeOf("app"), spec: { moduleName: "app", text: "(the spec)" } });
    expect(fixer).toContain('<base folder name="existing">\nThis codebase started from a copy of the base folder existing.');
    expect(fixer).toContain("- What came from the base folder stays, used where it is");
    expect(codeFixerTask({ buildDir: codeOf("other"), spec: { moduleName: "other", text: "(the spec)" } })).not.toContain("<base folder");
  });
});
