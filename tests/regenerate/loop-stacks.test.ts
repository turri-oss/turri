import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chooseStack, chosenStack } from "../../src/config.ts";
import { regenerateTool, withCallStack } from "../../src/loop-tools.ts";
import { createJobRegistry, describeJob } from "../../src/regenerate/jobs.ts";
import { createWorkLoop, describeModules, type JobRunner } from "../../src/regenerate/loop.ts";
import { recordHistory } from "../../src/regenerate/lineage.ts";
import { writeCodeRecord, writeTestsRecord } from "../../src/regenerate/records.ts";
import { findTestScripts } from "../../src/regenerate/test-scripts.ts";

// A project of two stacks, as a person sets one up: a Python backend and a TypeScript frontend side by side, each
// stack's file naming its own unit testing script, config.turri.yaml naming none - test_scripts/ holds both, so it
// alone decides nothing.
let dir: string;
let cwd: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "turri-loop-stacks-"));
  cwd = process.cwd();
  process.chdir(dir);
  writeFileSync(join(dir, "config.turri.yaml"), "conformance-tests: false\n");
  writeFileSync(join(dir, "config.turri.backend.yaml"), "unittests-script: test_scripts/run_unittests_python.sh\n");
  writeFileSync(join(dir, "config.turri.frontend.yaml"), "unittests-script: test_scripts/run_unittests_typescript.sh\n");
  mkdirSync(join(dir, "test_scripts"));
  for (const script of ["run_unittests_python.sh", "run_unittests_typescript.sh"]) writeFileSync(join(dir, "test_scripts", script), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  writeFileSync(join(dir, "backend.plain"), app(["Serve the orders.", "Serve the invoices."], "is Python."));
  writeFileSync(join(dir, "frontend.plain"), app(["Show the orders.", "Show the invoices."], "is TypeScript."));
});
afterEach(() => {
  chooseStack(undefined);
  process.chdir(cwd);
  rmSync(dir, { recursive: true, force: true });
});

const app = (specs: string[], reqs: string) => `***implementation reqs***\n\n- :Implementation: ${reqs}\n\n***test reqs***\n\n- :ConformanceTests: are written.\n\n***functional specs***\n\n${specs.map((line) => `- ${line}`).join("\n\n")}\n`;

/** A runner that lands what it is given, noting the stack each pulse runs with and the unit testing script it finds. Held while `hold` is set. */
function runner() {
  const ran: Array<{ module: string; title: string; stack: string | undefined; unit: string | undefined }> = [];
  const gate: { hold?: Promise<void>; release?: () => void } = {};
  const holdNext = () => {
    gate.hold = new Promise<void>((resolve) => (gate.release = resolve));
  };
  const run: JobRunner = async (job) => {
    const unit = findTestScripts(dir).unit;
    ran.push({ module: job.moduleName, title: job.planned.title, stack: chosenStack(), unit: unit !== undefined ? relative(dir, unit) : undefined });
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

describe("a job's stack", () => {
  it("is the one chosen when it was queued, not when it gets a slot - whatever is chosen while it waits", async () => {
    const registry = createJobRegistry({ maxRunning: 1 });
    let release: (() => void) | undefined;
    const first = registry.start({ kind: "regenerate", summary: "first", run: () => new Promise((resolve) => (release = () => resolve({ report: "done" }))) });
    chooseStack("backend");
    const seen: Array<string | undefined> = [];
    const second = registry.start({
      kind: "regenerate",
      summary: "second",
      run: async () => {
        seen.push(chosenStack());
        return { report: "done" };
      },
    });
    // The first holds the one slot; the second waits for it while another stack is chosen.
    await vi.waitFor(() => expect(release).toBeDefined());
    expect(second.status).toBe("queued");
    chooseStack("frontend");
    release!();
    await registry.wait(first.id);
    await registry.wait(second.id);
    expect(seen).toEqual(["backend"]);
    expect(second.stack).toBe("backend");
    expect(first.stack).toBeUndefined();
    expect(describeJob(registry.get(second.id)!)).toContain("second (stack backend): succeeded");
  });
});

describe("a module of a project of stacks", () => {
  it("is built pulse after pulse with the stack it was asked for, though another is chosen while it is built", async () => {
    const { ran, holdNext, gate, run } = runner();
    const loop = createWorkLoop({ registry: createJobRegistry({ maxRunning: 1 }), cwd: dir, planner: false, run });
    chooseStack("backend");
    holdNext();
    await loop.bringUp("backend.plain");
    // The backend's first pulse runs; the person moves to the frontend - and asks for it - while it does.
    chooseStack("frontend");
    await loop.bringUp("frontend.plain");
    gate.release!();
    await loop.drain();
    const of = (module: string) => ran.filter((pulse) => pulse.module === module).map(({ stack, unit }) => ({ stack, unit }));
    expect(of("backend")).toEqual([
      { stack: "backend", unit: "test_scripts/run_unittests_python.sh" },
      { stack: "backend", unit: "test_scripts/run_unittests_python.sh" },
    ]);
    expect(of("frontend")).toEqual([
      { stack: "frontend", unit: "test_scripts/run_unittests_typescript.sh" },
      { stack: "frontend", unit: "test_scripts/run_unittests_typescript.sh" },
    ]);
  });

  it("keeps its stack when its spec changes while another is chosen - asked for again, it takes the one chosen then", async () => {
    const { ran, run } = runner();
    const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, run });
    writeFileSync(join(dir, "backend.plain"), app(["Serve the orders."], "is Python."));
    chooseStack("backend");
    await loop.bringUp("backend.plain");
    await loop.drain();
    chooseStack("frontend");
    writeFileSync(join(dir, "backend.plain"), app(["Serve the orders.", "Serve the invoices."], "is Python."));
    await loop.bringUp("backend.plain", { specChange: true });
    await loop.drain();
    expect(ran.map((pulse) => pulse.stack)).toEqual(["backend", "backend"]);
    // Asked for, not changed: the stack chosen now.
    writeFileSync(join(dir, "backend.plain"), app(["Serve the orders.", "Serve the invoices.", "Serve the refunds."], "is Python."));
    await loop.bringUp("backend.plain");
    await loop.drain();
    expect(ran.at(-1)!.stack).toBe("frontend");
  });

  it("reads the rest of its config with its stack too - conformance tests its stack's file turns on are written once its code is built", async () => {
    writeFileSync(join(dir, "config.turri.backend.yaml"), "unittests-script: test_scripts/run_unittests_python.sh\nconformance-tests: true\n");
    writeFileSync(join(dir, "backend.plain"), app(["Serve the orders."], "is Python."));
    const { run } = runner();
    const conformed: Array<string | undefined> = [];
    const runConformance: JobRunner = async (job) => {
      conformed.push(chosenStack());
      writeTestsRecord(join(dir, "plain_modules", job.moduleName, "tests"), job.planned.step.tree);
      recordHistory(job.buildDir, `conformance tests: ${job.planned.title}`);
      return { landed: true, report: "passed" };
    };
    const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, run, runConformance });
    chooseStack("backend");
    const [status] = await loop.bringUp("backend.plain");
    chooseStack(undefined);
    await loop.drain();
    expect(conformed).toEqual(["backend"]);
    expect(status!.stack).toBe("backend");
  });

  it("says the stack it is built with where it says what runs and what is planned", async () => {
    const { run } = runner();
    const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, run, dryRun: true });
    chooseStack("backend");
    const statuses = await loop.bringUp("backend.plain");
    expect(describeModules(statuses)).toContain("backend (backend.plain, stack backend):");
    chooseStack(undefined);
    expect(loop.status()[0]!.stack).toBe("backend");
  });
});

describe("the chat's tools in a project of stacks", () => {
  const ctx = {} as ExtensionContext;

  it("build a module with the stack named in the call, whatever the session has chosen - and leave the session's choice as it was", async () => {
    const { ran, run } = runner();
    const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, run });
    const tool = regenerateTool({ cwd: dir, loop: () => loop, wait: () => false });
    await tool.execute("call", { plain_file: "backend.plain", stack: "backend" }, undefined, undefined, ctx);
    await tool.execute("call", { plain_file: "frontend.plain", stack: "frontend" }, undefined, undefined, ctx);
    await loop.drain();
    expect(ran.map((pulse) => `${pulse.module} ${pulse.stack} ${pulse.unit}`).sort()).toEqual([
      "backend backend test_scripts/run_unittests_python.sh",
      "backend backend test_scripts/run_unittests_python.sh",
      "frontend frontend test_scripts/run_unittests_typescript.sh",
      "frontend frontend test_scripts/run_unittests_typescript.sh",
    ]);
    expect(chosenStack()).toBeUndefined();
  });

  it("refuse a module that would be built with no stack when config.turri.yaml alone names no unit testing script - naming the stacks and their scripts", async () => {
    const { ran, run } = runner();
    const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, run });
    const tool = regenerateTool({ cwd: dir, loop: () => loop, wait: () => false });
    await expect(tool.execute("call", { plain_file: "backend.plain" }, undefined, undefined, ctx)).rejects.toThrow(
      "Nothing was started: backend.plain would be built with no stack - config.turri.yaml alone - and that names no unit testing script, so every pulse would stop. " +
        "The project's stacks: backend (config.turri.backend.yaml: test_scripts/run_unittests_python.sh), frontend (config.turri.frontend.yaml: test_scripts/run_unittests_typescript.sh).",
    );
    expect(loop.status()).toEqual([]);
    expect(ran).toEqual([]);
  });

  it("build with the stack the session has chosen when the call names none", async () => {
    const { ran, run } = runner();
    const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, run });
    const tool = regenerateTool({ cwd: dir, loop: () => loop, wait: () => false });
    chooseStack("frontend");
    await tool.execute("call", { plain_file: "frontend.plain" }, undefined, undefined, ctx);
    await loop.drain();
    expect(ran.map((pulse) => pulse.stack)).toEqual(["frontend", "frontend"]);
  });

  it("refuse a stack the project has no file for, and take none - config.turri.yaml alone - when it names its own script", () => {
    expect(() => withCallStack(join(dir, "backend.plain"), "mobile", () => "built")).toThrow("There is no stack mobile in");
    expect(() => withCallStack(join(dir, "backend.plain"), "mobile", () => "built")).toThrow("Its stacks: backend, frontend - or none.");
    writeFileSync(join(dir, "config.turri.yaml"), "conformance-tests: false\nunittests-script: test_scripts/run_unittests_python.sh\n");
    expect(withCallStack(join(dir, "backend.plain"), undefined, () => chosenStack() ?? "none")).toBe("none");
    expect(withCallStack(join(dir, "backend.plain"), "none", () => chosenStack() ?? "none")).toBe("none");
  });
});

describe("a missing unit testing script in a project of stacks", () => {
  it("is said to be in a stack's file when none is chosen - which stack names which - not to be named in config.turri.yaml", () => {
    const note = findTestScripts(dir).notes?.unit ?? "";
    expect(note).toContain("name the one to use in the config.turri.<stack>.yaml of the stack that builds it");
    expect(note).toContain(
      "No stack is chosen, so config.turri.yaml alone is read - this project's stacks are backend, frontend, and config.turri.backend.yaml names " +
        "test_scripts/run_unittests_python.sh; config.turri.frontend.yaml names test_scripts/run_unittests_typescript.sh.",
    );
    expect(note).not.toContain("name the one to use in config.turri.yaml");
    chooseStack("backend");
    expect(findTestScripts(dir).notes?.unit).toBeUndefined();
  });
});
