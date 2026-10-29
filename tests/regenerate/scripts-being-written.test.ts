import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createJobRegistry } from "../../src/regenerate/jobs.ts";
import { recordHistory } from "../../src/regenerate/lineage.ts";
import { createWorkLoop, type JobRunner } from "../../src/regenerate/loop.ts";
import { writeCodeRecord } from "../../src/regenerate/records.ts";
import { scriptBeingWritten, writingScript } from "../../src/regenerate/scripts-being-written.ts";
import { scriptKindOfSkill } from "../../src/regenerate/test-scripts.ts";
import { testPlainFile, writePlain } from "../test-plain.ts";

// A project whose module is written, and whose unit testing script is not yet: the chat started the skill that writes
// it in the background, and regenerated at once.
let dir: string;
let cwd: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "turri-scripts-being-written-")));
  cwd = process.cwd();
  process.chdir(dir);
  writeFileSync(join(dir, "config.turri.yaml"), "module: app.plain\n");
  writePlain(dir, "app.plain", "***implementation reqs***\n\n- :Implementation: is Python.\n\n***functional specs***\n\n# add-task\nAdd a task to the list.\n");
});
afterEach(() => {
  process.chdir(cwd);
  rmSync(dir, { recursive: true, force: true });
});

/** A runner that lands what it is given, noting each pulse it ran. */
function runner() {
  const ran: string[] = [];
  const run: JobRunner = async (job) => {
    ran.push(job.planned.title);
    mkdirSync(job.buildDir, { recursive: true });
    writeFileSync(join(job.buildDir, "app.txt"), `${job.planned.title}\n`, { flag: "a" });
    writeCodeRecord(job.buildDir, job.spec.tree);
    recordHistory(job.buildDir, job.planned.title);
    return { landed: true, report: "landed" };
  };
  return { ran, run };
}

const writeUnitScript = () => {
  mkdirSync(join(dir, "test_scripts"), { recursive: true });
  writeFileSync(join(dir, "test_scripts", "run_unittests_python.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
};

/** The loop's look after a run ends, which it starts by itself. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 50));

describe("a module whose unit testing script is being written in the background", () => {
  it("waits for it rather than fail for want of it, and is built once the script is written", async () => {
    const { ran, run } = runner();
    const loop = createWorkLoop({ registry: createJobRegistry({ maxRunning: 1 }), cwd: dir, planner: false, run });
    const written = writingScript({ project: dir, kind: "unit" });
    await loop.bringUp("app.plain");
    expect(ran).toEqual([]);
    expect(loop.status()[0]!.why).toBe("waiting for its unit testing script, which is being written");

    writeUnitScript();
    written();
    await settled();
    await loop.drain();
    expect(ran).toHaveLength(1);
  });

  it("is not held by a script written for another stack", async () => {
    writeFileSync(join(dir, "config.turri.app.yaml"), "");
    const { ran, run } = runner();
    const loop = createWorkLoop({ registry: createJobRegistry({ maxRunning: 1 }), cwd: dir, planner: false, run });
    const written = writingScript({ project: dir, kind: "unit", stack: "web" });
    try {
      await loop.bringUp("app.plain");
      await loop.drain();
      expect(ran).toHaveLength(1);
    } finally {
      written();
    }
  });

  it("is not held once the run ended without writing it: its pulse starts, and fails for want of the script as it would", async () => {
    const { ran, run } = runner();
    const loop = createWorkLoop({ registry: createJobRegistry({ maxRunning: 1 }), cwd: dir, planner: false, run });
    const written = writingScript({ project: dir, kind: "unit" });
    await loop.bringUp("app.plain");
    expect(ran).toEqual([]);
    written();
    await settled();
    await loop.drain();
    expect(ran).toHaveLength(1);
  });
});

/** A loop whose registry notes, at each notify, why the module stands as it does - what a host reads on onPlanChange. */
function heard(run: JobRunner) {
  const whys: Array<string | undefined> = [];
  const holder: { loop?: ReturnType<typeof createWorkLoop> } = {};
  const registry = createJobRegistry({ maxRunning: 1, onNotify: () => whys.push(holder.loop?.status()[0]?.why) });
  holder.loop = createWorkLoop({ registry, cwd: dir, planner: false, run });
  return { loop: holder.loop, whys };
}

describe("a host following a module that waits for its script", () => {
  it("is told as it starts waiting for its unit testing script, and again as it stops - the script written", async () => {
    const { ran, run } = runner();
    const { loop, whys } = heard(run);
    const written = writingScript({ project: dir, kind: "unit" });
    await loop.bringUp("app.plain");
    expect(whys.at(-1)).toBe("waiting for its unit testing script, which is being written");

    const before = whys.length;
    writeUnitScript();
    written();
    await settled();
    await loop.drain();
    expect(ran).toHaveLength(1);
    expect(whys.length).toBeGreaterThan(before);
    expect(whys.at(-1)).not.toBe("waiting for its unit testing script, which is being written");
  });

  it("is told as it stops waiting when the run ended without the script, though no pulse could start sooner", async () => {
    const { run } = runner();
    const { loop, whys } = heard(run);
    const written = writingScript({ project: dir, kind: "unit" });
    await loop.bringUp("app.plain");
    const before = whys.length;
    written();
    await settled();
    await loop.drain();
    expect(whys.slice(before).some((why) => why !== "waiting for its unit testing script, which is being written")).toBe(true);
  });

  it("is told as it starts and stops waiting for its conformance testing script, once its code is built", async () => {
    writeUnitScript();
    writePlain(dir, "app.plain", "***implementation reqs***\n\n- :Implementation: is Python.\n\n***test reqs***\n\n- :ConformanceTests: are written.\n\n***functional specs***\n\n# add-task\nAdd a task to the list.\n");
    mkdirSync(join(dir, "tests", "app"), { recursive: true });
    writeFileSync(join(dir, "tests", "app", "add-task.plain"), testPlainFile("app", "add-task", { conformance: ["# adds-one\nAdding Milk lists Milk."] }));
    const { run } = runner();
    const { loop, whys } = heard(run);
    const written = writingScript({ project: dir, kind: "conformance" });
    await loop.bringUp("app.plain");
    await loop.drain();
    expect(whys.at(-1)).toBe("waiting for its conformance testing script, which is being written");
    written();
    await settled();
    expect(whys.at(-1)).toMatch(/^waiting for its conformance testing script: /);
  });
});

describe("a testing script being written", () => {
  it("is of the kind its skill writes, and no longer once its run ends", () => {
    expect(scriptKindOfSkill("implement-unit-testing-script")).toBe("unit");
    expect(scriptKindOfSkill("implement-conformance-testing-script")).toBe("conformance");
    expect(scriptKindOfSkill("analyze-func-specs")).toBeUndefined();
    const written = writingScript({ project: dir, kind: "conformance", stack: "backend" });
    expect(scriptBeingWritten(dir, "conformance", "backend")).toBe(true);
    expect(scriptBeingWritten(dir, "conformance")).toBe(true);
    expect(scriptBeingWritten(dir, "conformance", "frontend")).toBe(false);
    expect(scriptBeingWritten(dir, "unit", "backend")).toBe(false);
    written();
    expect(scriptBeingWritten(dir, "conformance", "backend")).toBe(false);
  });
});
