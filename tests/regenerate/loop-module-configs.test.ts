import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pinnedConfigModule, withConfigModule } from "../../src/config.ts";
import { regenerateTool, toldByWaitingCall, whenBuildable } from "../../src/loop-tools.ts";
import { createJobRegistry, describeJob } from "../../src/regenerate/jobs.ts";
import { createWorkLoop, describeModules, type JobRunner } from "../../src/regenerate/loop.ts";
import { recordHistory } from "../../src/regenerate/lineage.ts";
import { readRecord, writeCodeRecord, writeTestsRecord } from "../../src/regenerate/records.ts";
import { findTestScripts } from "../../src/regenerate/test-scripts.ts";
import { writingScript } from "../../src/regenerate/scripts-being-written.ts";
import { testPlainFile, writePlain } from "../test-plain.ts";

// A project of two modules on two stacks, as a person sets one up: a Python backend and a TypeScript frontend side by
// side, each module's own file naming its unit testing script, config.turri.yaml naming none - test_scripts/ holds
// both, so it alone decides nothing.
let dir: string;
let cwd: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "turri-loop-module-configs-"));
  cwd = process.cwd();
  process.chdir(dir);
  writeFileSync(join(dir, "config.turri.yaml"), "conformance-tests: true\n");
  writeFileSync(join(dir, "config.turri.backend.yaml"), "unittests-script: test_scripts/run_unittests_python.sh\n");
  writeFileSync(join(dir, "config.turri.frontend.yaml"), "unittests-script: test_scripts/run_unittests_typescript.sh\n");
  mkdirSync(join(dir, "test_scripts"));
  for (const script of ["run_unittests_python.sh", "run_unittests_typescript.sh"]) writeFileSync(join(dir, "test_scripts", script), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  writePlain(dir, "backend.plain", app(["Serve the orders.", "Serve the invoices."], "is Python."));
  writePlain(dir, "frontend.plain", app(["Show the orders.", "Show the invoices."], "is TypeScript."));
});
afterEach(() => {
  process.chdir(cwd);
  rmSync(dir, { recursive: true, force: true });
});

/** A functional spec's func-id, from its text: "Serve the orders." is serve-the-orders. */
const slug = (line: string) => line.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const app = (specs: string[], reqs: string, requires?: string) => `${requires !== undefined ? `---\nrequires: [${requires}]\n---\n\n` : ""}***implementation reqs***\n\n- :Implementation: ${reqs}\n\n***test reqs***\n\n- :ConformanceTests: are written.\n\n***functional specs***\n\n${specs.map((line) => `# ${slug(line)}\n${line}`).join("\n\n")}\n`;

/** A runner that lands what it is given, noting the module config each pulse runs with and the unit testing script it finds. Held while `hold` is set. */
function runner() {
  const ran: Array<{ module: string; title: string; config: string | undefined; unit: string | undefined }> = [];
  const gate: { hold?: Promise<void>; release?: () => void } = {};
  const holdNext = () => {
    gate.hold = new Promise<void>((resolve) => (gate.release = resolve));
  };
  const run: JobRunner = async (job) => {
    const unit = findTestScripts(dir).unit;
    ran.push({ module: job.moduleName, title: job.planned.title, config: pinnedConfigModule(), unit: unit !== undefined ? relative(dir, unit) : undefined });
    const hold = gate.hold;
    gate.hold = undefined;
    if (hold !== undefined) await hold;
    mkdirSync(job.buildDir, { recursive: true });
    writeFileSync(join(job.buildDir, `${job.moduleName}.txt`), `${job.planned.title}\n`, { flag: "a" });
    writeCodeRecord(job.buildDir, job.spec.tree);
    recordHistory(job.buildDir, job.planned.title);
    return { landed: true, report: "landed" };
  };
  return { ran, gate, holdNext, run };
}

describe("a job's module config", () => {
  it("is the one pinned when it was queued, not when it gets a slot", async () => {
    const registry = createJobRegistry({ maxRunning: 1 });
    let release: (() => void) | undefined;
    const first = registry.start({ kind: "regenerate", summary: "first", run: () => new Promise((resolve) => (release = () => resolve({ report: "done" }))) });
    const seen: Array<string | undefined> = [];
    const second = withConfigModule("backend", () =>
      registry.start({
        kind: "regenerate",
        summary: "second",
        run: async () => {
          seen.push(pinnedConfigModule());
          return { report: "done" };
        },
      }),
    );
    // The first holds the one slot; the second waits for it, outside the work that queued it.
    await vi.waitFor(() => expect(release).toBeDefined());
    expect(second.status).toBe("queued");
    release!();
    await registry.wait(first.id);
    await registry.wait(second.id);
    expect(seen).toEqual(["backend"]);
    expect(second.configModule).toBe("backend");
    expect(first.configModule).toBeUndefined();
    expect(describeJob(registry.get(second.id)!)).toContain("second (built with config.turri.backend.yaml): succeeded");
  });
});

describe("a module with a config file of its own", () => {
  it("is built pulse after pulse with it, side by side with another module and its own", async () => {
    const { ran, holdNext, gate, run } = runner();
    const loop = createWorkLoop({ registry: createJobRegistry({ maxRunning: 1 }), cwd: dir, planner: false, run });
    holdNext();
    await loop.bringUp("backend.plain");
    // The backend's first pulse runs; the person asks for the frontend while it does.
    await loop.bringUp("frontend.plain");
    gate.release!();
    await loop.drain();
    const of = (module: string) => ran.filter((pulse) => pulse.module === module).map(({ config, unit }) => ({ config, unit }));
    expect(of("backend")).toEqual([
      { config: "backend", unit: "test_scripts/run_unittests_python.sh" },
      { config: "backend", unit: "test_scripts/run_unittests_python.sh" },
    ]);
    expect(of("frontend")).toEqual([
      { config: "frontend", unit: "test_scripts/run_unittests_typescript.sh" },
      { config: "frontend", unit: "test_scripts/run_unittests_typescript.sh" },
    ]);
  });

  it("builds the modules built on it that have none of their own - every codebase of the chain", async () => {
    const { ran, run } = runner();
    const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, run });
    writePlain(dir, "backend_auth.plain", app(["Log in."], "is Python.", "backend"));
    await loop.bringUp("backend_auth.plain");
    await loop.drain();
    expect(ran.length).toBeGreaterThan(0);
    expect(new Set(ran.map((pulse) => `${pulse.config} ${pulse.unit}`))).toEqual(new Set(["backend test_scripts/run_unittests_python.sh"]));
    expect(ran.some((pulse) => pulse.module === "backend_auth")).toBe(true);
  });

  it("writes the conformance tests of its functional specs with scenarios with it too, once its code is built", async () => {
    writePlain(dir, "backend.plain", app(["Serve the orders."], "is Python."));
    mkdirSync(join(dir, "tests", "backend"), { recursive: true });
    writeFileSync(join(dir, "tests", "backend", "serve-the-orders.plain"), testPlainFile("backend", "serve-the-orders", { acceptance: ["# lists\nThe orders are listed."] }));
    writeFileSync(join(dir, "test_scripts", "run_conformance_tests_python.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const { run } = runner();
    const conformed: Array<string | undefined> = [];
    const runConformance: JobRunner = async (job) => {
      conformed.push(pinnedConfigModule());
      writeTestsRecord(join(dir, "plain_modules", job.moduleName, "tests"), job.planned.step.tree);
      recordHistory(job.buildDir, `conformance tests: ${job.planned.title}`);
      return { landed: true, report: "passed" };
    };
    const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, run, runConformance });
    const [status] = await loop.bringUp("backend.plain");
    await loop.drain();
    expect(conformed).toEqual(["backend"]);
    expect(status!.configModule).toBe("backend");
  });

  it("built before its file was there, takes it on its next spec change", async () => {
    writeFileSync(join(dir, "config.turri.yaml"), "conformance-tests: true\nunittests-script: test_scripts/run_unittests_python.sh\n");
    rmSync(join(dir, "config.turri.backend.yaml"));
    writePlain(dir, "backend.plain", app(["Serve the orders."], "is Python."));
    const { ran, run } = runner();
    const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, run });
    await loop.bringUp("backend.plain");
    await loop.drain();
    writeFileSync(join(dir, "config.turri.backend.yaml"), "unittests-script: test_scripts/run_unittests_python.sh\n");
    writePlain(dir, "backend.plain", app(["Serve the orders.", "Serve the invoices."], "is Python."));
    await loop.bringUp("backend.plain");
    await loop.drain();
    expect(ran.map((pulse) => pulse.config)).toEqual([undefined, "backend"]);
  });

  it("is said where the loop says what runs and what is planned", async () => {
    const { run } = runner();
    const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, run });
    const statuses = await loop.lookAhead("backend.plain");
    expect(describeModules(statuses)).toContain("backend (backend.plain, built with config.turri.backend.yaml):");
    expect(loop.status()[0]!.configModule).toBe("backend");
  });
});

describe("the chat's tools in a project of module config files", () => {
  const ctx = {} as ExtensionContext;

  it("tell, when the call waits, each pulse that ran and how it ended - not only that the module is now up to date", async () => {
    const { run: land } = runner();
    const registry = createJobRegistry();
    // Each pulse, as it runs, is one the waiting call tells: its end starts no turn of its own to say it again.
    const toldWhileRunning: boolean[] = [];
    const run: JobRunner = async (job, onDelta) => {
      toldWhileRunning.push(toldByWaitingCall(registry, registry.list().find((pulse) => pulse.status === "running")!));
      return land(job, onDelta);
    };
    const loop = createWorkLoop({ registry, cwd: dir, planner: false, run });
    const tool = regenerateTool({ cwd: dir, jobs: registry, loop: () => loop, wait: () => true });
    const result = await tool.execute("call", { plain_file: "backend.plain" }, undefined, undefined, ctx);
    const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
    const ran = registry.list();
    expect(ran).toHaveLength(2);
    expect(text).toContain("What ran while you waited - 2 pulses:");
    for (const job of ran) expect(text).toContain(`<pulse id="${job.id}" landed="yes">`);
    expect(text.indexOf("What ran while you waited")).toBeLessThan(text.indexOf("backend is up to date"));
    expect(toldWhileRunning).toEqual([true, true]);
    // The call returned: a pulse that ends from now on is told as any is.
    for (const job of ran) expect(toldByWaitingCall(registry, job)).toBe(false);
    // Called again with nothing left to do: no pulse ran, and none is told.
    const again = await tool.execute("call", { plain_file: "backend.plain" }, undefined, undefined, ctx);
    expect(again.content.map((part) => (part.type === "text" ? part.text : "")).join("")).not.toContain("What ran");
  });

  it("refuse a module with no file of its own, nor one below it, when config.turri.yaml alone names no unit testing script - naming the modules' files and their scripts", async () => {
    const { ran, run } = runner();
    const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, run });
    const tool = regenerateTool({ cwd: dir, loop: () => loop, wait: () => false });
    writePlain(dir, "api.plain", app(["Serve the orders."], "is Python."));
    await expect(tool.execute("call", { plain_file: "api.plain" }, undefined, undefined, ctx)).rejects.toThrow(
      "Nothing was started: api.plain would be built with config.turri.yaml alone - it has no config.turri.api.yaml, and none of the modules it " +
        "requires has one - and that names no unit testing script, so every pulse would stop. The modules' own files: " +
        "config.turri.backend.yaml (test_scripts/run_unittests_python.sh), config.turri.frontend.yaml (test_scripts/run_unittests_typescript.sh).",
    );
    expect(loop.status()).toEqual([]);
    expect(ran).toEqual([]);
  });

  it("refuse a module two of the modules it requires have files of their own, naming them", async () => {
    const { ran, run } = runner();
    const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, run });
    const tool = regenerateTool({ cwd: dir, loop: () => loop, wait: () => false });
    writePlain(dir, "frontend.plain", app(["Show the orders."], "is TypeScript.", "backend"));
    writePlain(dir, "web.plain", app(["Show the invoices."], "is TypeScript.", "frontend"));
    await expect(tool.execute("call", { plain_file: "web.plain" }, undefined, undefined, ctx)).rejects.toThrow(
      "Nothing was started: web.plain requires modules that each have a config file of their own - config.turri.frontend.yaml, config.turri.backend.yaml",
    );
    expect(ran).toEqual([]);
  });

  it("build with config.turri.yaml alone a module with no file of its own when it names a script", () => {
    writeFileSync(join(dir, "config.turri.yaml"), "conformance-tests: true\nunittests-script: test_scripts/run_unittests_python.sh\n");
    expect(whenBuildable(join(dir, "api.plain"), () => pinnedConfigModule() ?? "none")).toBe("none");
  });

  it("refuses to build with a config that does not parse - it would be read as empty, every setting at its default", () => {
    writeFileSync(join(dir, "config.turri.yaml"), "coding-model: p/small\ncoding-model: p/big\n");
    writeFileSync(join(dir, "api.plain"), "***implementation reqs***\n\n- :Implementation: is Python.\n\n***functional specs***\n\n# ping\nPing.\n");
    expect(() => whenBuildable(join(dir, "api.plain"), () => "started")).toThrow(/^Nothing was started: config\.turri\.yaml, line 2: coding-model is set twice\. A config that does not parse is read as empty/);
  });
});

describe("a missing unit testing script where modules have config files of their own", () => {
  it("is said to be named in the module's own file - which file names which - not in config.turri.yaml", () => {
    writePlain(dir, "api.plain", app(["Serve the orders."], "is Python."));
    const note = findTestScripts(dir, join(dir, "api.plain")).notes?.unit ?? "";
    expect(note).toContain(
      "No module config file applies here, so config.turri.yaml alone is read - the modules' own are config.turri.backend.yaml, config.turri.frontend.yaml, " +
        "and config.turri.backend.yaml names test_scripts/run_unittests_python.sh; config.turri.frontend.yaml names test_scripts/run_unittests_typescript.sh.",
    );
    expect(note).not.toContain("name the one to use in config.turri.yaml");
    expect(findTestScripts(dir, join(dir, "backend.plain")).notes?.unit).toBeUndefined();
  });
});

describe("a module with no config file of its own where the modules have theirs", () => {
  const ctx = {} as ExtensionContext;
  beforeEach(() => rmSync(join(dir, "config.turri.frontend.yaml")));

  it("is never given a script another module's file names, though it is the only one in test_scripts/ - only one nobody's file names", () => {
    rmSync(join(dir, "test_scripts", "run_unittests_typescript.sh"));
    expect(findTestScripts(dir, join(dir, "frontend.plain")).unit).toBeUndefined();
    expect(findTestScripts(dir, join(dir, "backend.plain")).unit).toBe(join(dir, "test_scripts", "run_unittests_python.sh"));
    writeFileSync(join(dir, "test_scripts", "run_unittests_react.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    rmSync(join(dir, "test_scripts", "run_unittests_python.sh"));
    writeFileSync(join(dir, "config.turri.backend.yaml"), "unittests-script: test_scripts/run_unittests_python.sh\n");
    expect(findTestScripts(dir, join(dir, "frontend.plain")).unit).toBe(join(dir, "test_scripts", "run_unittests_react.sh"));
  });

  it("waits for a unit testing script of its own instead of starting a pulse with another module's - and starts once its own file names one", async () => {
    rmSync(join(dir, "test_scripts", "run_unittests_typescript.sh"));
    const { ran, run } = runner();
    const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, run });
    // Asked for before any module had a file of its own: nothing refused it, and the loop looks after it.
    rmSync(join(dir, "config.turri.backend.yaml"));
    const stopWriting = writingScript({ project: dir, kind: "unit" });
    await loop.bringUp("frontend.plain");
    expect(loop.status()[0]!.why).toBe("waiting for its unit testing script, which is being written");
    // The backend's script is written and named in its file; the frontend's is not written yet.
    writeFileSync(join(dir, "config.turri.backend.yaml"), "unittests-script: test_scripts/run_unittests_python.sh\n");
    stopWriting();
    await loop.drain();
    expect(ran).toEqual([]);
    const [waiting] = loop.status();
    expect(waiting!.running).toBeUndefined();
    expect(waiting!.why).toContain("waiting for a unit testing script of its own");
    expect(waiting!.why).toContain("config.turri.backend.yaml names test_scripts/run_unittests_python.sh");
    // Its own is written and named.
    writeFileSync(join(dir, "test_scripts", "run_unittests_typescript.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    writeFileSync(join(dir, "config.turri.frontend.yaml"), "unittests-script: test_scripts/run_unittests_typescript.sh\n");
    await loop.bringUp("frontend.plain");
    await loop.drain();
    expect(new Set(ran.map(({ module, config, unit }) => `${module} ${config} ${unit}`))).toEqual(new Set(["frontend frontend test_scripts/run_unittests_typescript.sh"]));
  });

  it("is not refused while a unit testing script is being written in the project - the loop holds it", async () => {
    // Only the backend's script there: without one being written, the call is refused.
    rmSync(join(dir, "test_scripts", "run_unittests_typescript.sh"));
    const { ran, run } = runner();
    const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, run });
    const tool = regenerateTool({ cwd: dir, loop: () => loop, wait: () => false });
    await expect(tool.execute("call", { plain_file: "frontend.plain" }, undefined, undefined, ctx)).rejects.toThrow("Nothing was started: frontend.plain would be built with config.turri.yaml alone");
    const stopWriting = writingScript({ project: dir, kind: "unit" });
    try {
      const result = await tool.execute("call", { plain_file: "frontend.plain" }, undefined, undefined, ctx);
      expect(result.content.map((part) => (part.type === "text" ? part.text : "")).join("")).toContain("waiting for its unit testing script, which is being written");
      expect(ran).toEqual([]);
    } finally {
      stopWriting();
    }
  });
});
