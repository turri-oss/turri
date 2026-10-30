import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createJobRegistry } from "../../src/regenerate/jobs.ts";
import type { JobCases } from "../../src/regenerate/drift.ts";
import { moduleLanes } from "../../src/regenerate/lanes.ts";
import { createWorkLoop, describeDrift, describeModules, skipsReview, UP_TO_DATE, type JobRunner } from "../../src/regenerate/loop.ts";
import { codeTree, readRecord, writeCodeRecord, writeTestsRecord } from "../../src/regenerate/records.ts";
import { recordHistory } from "../../src/regenerate/lineage.ts";
import { copyRequiredCode } from "../../src/regenerate/requires.ts";
import { snapshotSpec } from "../../src/regenerate/regenerate.ts";
import { testPlainFile, writePlain } from "../test-plain.ts";

let dir: string;
let cwd: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "turri-loop-"));
  cwd = process.cwd();
  process.chdir(dir);
  writeFileSync(join(dir, "config.yaml"), "");
  // A conformance testing script, never run here - the runners are stubs - but without one no conformance pulse starts.
  mkdirSync(join(dir, "test_scripts"));
  writeFileSync(join(dir, "test_scripts", "run_conformance_tests_python.sh"), "#!/bin/sh\nexit 0\n");
});
afterEach(() => {
  process.chdir(cwd);
  rmSync(dir, { recursive: true, force: true });
});

/** A functional spec's func-id, from its text: "Say hello." is say-hello. */
const slug = (text: string) => text.split("\n")[0]!.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
/** A functional spec: its text, its func-id from it - or, for one whose text changes, its func-id given. */
type Spec = string | [string, string];
const specOf = (spec: Spec): [string, string] => (typeof spec === "string" ? [slug(spec), spec] : spec);
const block = (spec: Spec) => {
  const [id, text] = specOf(spec);
  return `# ${id}\n${text}`;
};
const app = (specs: Spec[], reqs = "is Python.") => `***implementation reqs***\n\n- :Implementation: ${reqs}\n\n***test reqs***\n\n- :ConformanceTests: use pytest.\n\n***functional specs***\n\n${specs.map(block).join("\n\n")}\n`;
const codeDir = (module = "app") => join(dir, "plain_modules", module, "code");
/** A functional spec's test plain file with a scenario - an acceptance one unless given: what makes it tested. */
const scenariosIn = (funcId: string, module = "app", scenario = "# works\nIt works.") => {
  mkdirSync(join(dir, "tests", module), { recursive: true });
  writeFileSync(join(dir, "tests", module, `${funcId}.plain`), testPlainFile(module, funcId, { acceptance: [scenario] }));
};

/** A runner that lands what it is given, as a render does: the record, committed. Held while `hold` is set. */
function runner() {
  const ran: Array<{ module: string; title: string; add: string[]; patch: string[]; fresh: boolean }> = [];
  const gate: { hold?: Promise<void>; release?: () => void; land: boolean } = { land: true };
  const holdNext = () => {
    gate.hold = new Promise<void>((resolve) => (gate.release = resolve));
  };
  const run: JobRunner = async (job) => {
    // Its agent is in its turn: a steer reaches it at once.
    if (job.steering !== undefined) job.steering.deliver = () => true;
    ran.push({ module: job.moduleName, title: job.planned.title, add: job.planned.cases.add.map((spec) => spec.funcId), patch: job.planned.cases.patch.map((spec) => spec.funcId), fresh: job.planned.cases.fresh });
    const hold = gate.hold;
    gate.hold = undefined;
    if (hold !== undefined) await hold;
    if (!gate.land) return { landed: false, report: "did not pass" };
    // As a render leaves it: code, and the record of what it is built from, committed.
    mkdirSync(job.buildDir, { recursive: true });
    writeFileSync(join(job.buildDir, `${job.moduleName}.py`), `# ${job.planned.title}\n`, { flag: "a" });
    // Steered while it ran, it lands what it was steered to - as a render does.
    writeCodeRecord(job.buildDir, job.steering?.target ?? job.spec.tree);
    recordHistory(job.buildDir, job.planned.title);
    return { landed: true, report: "landed" };
  };
  return { ran, gate, holdNext, run };
}

describe("releasing after each pulse", () => {
  it("releases what each pulse landed as its last stage, under release-after-pulse - before the next pulse starts", async () => {
    writeFileSync(join(dir, "config.yaml"), "release-after-pulse: true\n");
    writePlain(dir, "app.plain", app(["Say hello.", "Say goodbye.", "Count to ten."]));
    const { ran, run } = runner();
    const events: string[] = [];
    const tracked: JobRunner = async (job, onDelta) => {
      events.push(`build ${job.planned.title}`);
      return run(job, onDelta);
    };
    const registry = createJobRegistry();
    const loop = createWorkLoop({
      registry,
      cwd: dir,
      planner: false,
      run: tracked,
      release: async ({ moduleName, title }) => {
        events.push(`release ${title}`);
        return `${moduleName} is running`;
      },
    });
    await loop.bringUp("app.plain");
    await loop.drain();
    expect(ran).toHaveLength(3);
    // One release a pulse, each before the next pulse builds.
    expect(events).toEqual(["build Say hello.", "release Say hello.", "build Say goodbye.", "release Say goodbye.", "build Count to ten.", "release Count to ten."]);
    expect(registry.list().every((job) => job.report?.includes("Released after the pulse: app is running"))).toBe(true);
  });

  it("releases nothing when release-after-pulse is off - the default - or the pulse did not land", async () => {
    writePlain(dir, "app.plain", app(["Say hello."]));
    const { gate, run } = runner();
    const release = vi.fn(async () => "released");
    let loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, run, release });
    await loop.bringUp("app.plain");
    await loop.drain();
    expect(release).not.toHaveBeenCalled();

    rmSync(join(dir, "plain_modules"), { recursive: true, force: true });
    writeFileSync(join(dir, "config.yaml"), "release-after-pulse: true\n");
    gate.land = false;
    loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, run, release });
    await loop.bringUp("app.plain");
    await loop.drain();
    expect(release).not.toHaveBeenCalled();
  });

  it("keeps what a pulse landed when its release fails, and says so", async () => {
    writeFileSync(join(dir, "config.yaml"), "release-after-pulse: true\n");
    writePlain(dir, "app.plain", app(["Say hello."]));
    const { run } = runner();
    const registry = createJobRegistry();
    const loop = createWorkLoop({ registry, cwd: dir, planner: false, run, release: async () => { throw new Error("port 8000 is taken"); } });
    await loop.bringUp("app.plain");
    await loop.drain();
    expect(registry.list()[0]).toMatchObject({ status: "succeeded", details: { landed: true } });
    expect(registry.list()[0]!.report).toContain("The release after the pulse failed: port 8000 is taken");
  });
});

describe("the work loop", () => {
  it("plans the work not running yet again when the steering changes - a running pulse goes on - and says what the planner did not follow", async () => {
    writePlain(dir, "app.plain", app(["Say hello.", "Say goodbye.", "Count to ten.", "Count to twenty."]));
    const { ran, gate, holdNext, run } = runner();
    let wishes: string[] = [];
    const seen: Array<string[]> = [];
    const planner = {
      group: async (specs: Array<{ number: number }>, _check: unknown, steering?: Array<{ text: string }>) => {
        seen.push((steering ?? []).map((entry) => entry.text));
        // Grouped only once it is asked to be: the counting together, the rest alone.
        return wishes.length === 0
          ? undefined
          : { groups: specs.length === 4 ? [{ specs: [1], title: "Hello" }, { specs: [2], title: "Goodbye" }, { specs: [3, 4], title: "Counting" }] : [{ specs: [1], title: "Goodbye" }, { specs: [2, 3], title: "Counting" }], notes: "Hello and goodbye stay apart: they build nothing together." };
      },
      place: async () => undefined,
    };
    const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner, steering: () => wishes.map((text) => ({ source: "the conversation", text })), run });
    holdNext();
    const [first] = await loop.bringUp("app.plain");
    expect(first!.planned).toHaveLength(3);
    expect(first!.planNotes).toContain("the grouping was not given - a functional spec a pulse");

    // Steered while the first pulse runs: the spec is as it was, and what comes after it is planned again.
    wishes = ["Group the counting together."];
    const [steered] = await loop.bringUp("app.plain");
    expect(steered!.running?.title).toBe("Say hello.");
    expect(steered!.planned.map((job) => job.title)).toEqual(["Goodbye", "Counting"]);
    expect(steered!.planNotes).toEqual(["the grouping: Hello and goodbye stay apart: they build nothing together."]);
    expect(describeModules([steered!])).toContain("what the plan did not do as asked:\n    - the grouping: Hello and goodbye stay apart");
    expect(seen.at(-1)).toEqual(["Group the counting together."]);

    // Asked again, the steering as it was: the plan is kept, no agent asked.
    const asked = seen.length;
    await loop.bringUp("app.plain");
    expect(seen).toHaveLength(asked);
    gate.release!();
    await loop.drain();
    expect(ran.map((job) => job.title)).toEqual(["Say hello.", "Goodbye", "Counting"]);
  });

  it("plans again with a request's new guidance when nothing runs", async () => {
    writePlain(dir, "app.plain", app(["Say hello.", "Say goodbye."]));
    const guided: string[][] = [];
    const planner = {
      group: async (_specs: unknown, _check: unknown, steering?: Array<{ text: string }>) => (guided.push((steering ?? []).map((entry) => entry.text)), undefined),
      place: async () => undefined,
    };
    // A dry run plans and starts nothing: what is planned stays planned.
    const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner, dryRun: true, run: runner().run });
    await loop.bringUp("app.plain");
    await loop.bringUp("app.plain");
    expect(guided).toEqual([[]]);
    await loop.bringUp("app.plain", { guidance: "Hello and goodbye together." });
    expect(guided).toEqual([[], ["Hello and goodbye together."]]);
  });

  it("builds a module nothing is built of, job by job, until its code record is the spec as the code sees it - its first job fresh", async () => {
    writePlain(dir, "app.plain", app(["Say hello.", "Say goodbye.", "Count to ten."]));
    const { ran, run } = runner();
    const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, run });
    await loop.bringUp("app.plain");
    await loop.drain();
    expect(ran.map((job) => job.add)).toEqual([["say-hello"], ["say-goodbye"], ["count-to-ten"]]);
    expect(ran.map((job) => job.fresh)).toEqual([true, false, false]);
    expect(readRecord(codeDir())).toEqual(codeTree(snapshotSpec(join(dir, "app.plain"), { cwd: dir }).tree));
    expect(loop.status()[0]).toMatchObject({ module: "app", planned: [], why: "built from the ***plain as it is" });
    expect(describeModules(loop.status())).toBe("app is up to date: its code is built from the ***plain as it is now in app.plain, so there is nothing to regenerate.");
  });

  it("is not fully regenerated while a pulse that ended without passing has its work undone - and is, once it lands", async () => {
    writePlain(dir, "app.plain", app(["Say hello."]));
    const { gate, run } = runner();
    const registry = createJobRegistry();
    const loop = createWorkLoop({ registry, cwd: dir, planner: false, run });
    // It ends - succeeded, not failed - without passing: nothing of it lands, and the codebase is halted.
    gate.land = false;
    await loop.bringUp("app.plain");
    await loop.drain();
    expect(registry.list()[0]).toMatchObject({ status: "succeeded", details: { passed: false, landed: false } });
    expect(readRecord(codeDir())).toBeNull();
    const drift = describeDrift(loop.drift("app.plain"));
    expect(drift).toContain("code: drifted from the spec - to regenerate: sets the project up, adds app:say-hello");
    expect(drift).toMatch(/pulse \w+ \("Say hello\."\) did not land - it runs again once the spec changes, or the module is asked for again/);
    expect(drift).not.toContain("Fully regenerated");
    // Asked again, it lands: then, and only then, the module is fully regenerated.
    gate.land = true;
    await loop.bringUp("app.plain");
    await loop.drain();
    expect(describeDrift(loop.drift("app.plain"))).toContain("Fully regenerated: every codebase is regenerated from the spec as it is");
  });

  it("writes each pulse's line into the notes as it ends - landed or rolled back - and commits it, so the next pulse keeps it", async () => {
    writePlain(dir, "app.plain", app(["Say hello.", "Say goodbye."]));
    const { gate, run } = runner();
    const told: JobRunner = async (job, onDelta) => ({ ...(await run(job, onDelta)), story: "2 rounds of the unit tests, 5 test runs" });
    const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, run: told });
    await loop.bringUp("app.plain");
    await loop.drain();
    const { readNotes } = await import("../../src/regenerate/notes.ts");
    const git = (...args: string[]) => execFileSync("git", ["--git-dir", join(dir, "plain_modules", "app", ".plaingit"), "--work-tree", join(dir, "plain_modules", "app"), ...args], { encoding: "utf8" });
    const pulses = readNotes(codeDir()).pulses;
    expect(pulses).toHaveLength(2);
    expect(pulses[0]).toMatch(/^\[[^\]]* · app pulse 1\] Say hello\. - landed; 2 rounds of the unit tests, 5 test runs · \d+s/);
    expect(pulses[1]).toContain("app pulse 2] Say goodbye. - landed");
    // Each in its pulse's own commit: nothing left uncommitted, no commit of its own.
    expect(git("status", "--porcelain")).toBe("");
    expect(git("log", "--format=%s")).not.toContain("pulse 1 landed");
    // A pulse that does not pass is rolled back - and its line kept, in a commit of its own.
    writePlain(dir, "app.plain", app(["Say hello.", "Say goodbye.", "Count to ten."]));
    gate.land = false;
    await loop.bringUp("app.plain");
    await loop.drain();
    expect(readNotes(codeDir()).pulses.at(-1)).toContain("app pulse 3] Count to ten. - did not pass - rolled back");
    expect(git("log", "-1", "--format=%s")).toBe("pulse 3 rolled back: Count to ten.\n");
    expect(git("status", "--porcelain")).toBe("");
  });

  it("keeps the spec gaps a pulse's agents met in its job's details, for a headless run to say", async () => {
    writePlain(dir, "app.plain", app(["Say hello."]));
    const { run } = runner();
    const gap = { question: "Should hello be capitalised?", assumption: "Hello is capitalised" };
    const registry = createJobRegistry();
    const loop = createWorkLoop({ registry, cwd: dir, planner: false, run: async (job, onDelta) => ({ ...(await run(job, onDelta)), specGaps: [gap] }) });
    await loop.bringUp("app.plain");
    await loop.drain();
    expect(registry.list().map((job) => (job.details as { specGaps?: unknown }).specGaps)).toEqual([[gap]]);
  });

  it("has nothing to do when only the test reqs changed", async () => {
    writePlain(dir, "app.plain", app(["Say hello."]));
    const { ran, run } = runner();
    const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, run });
    await loop.bringUp("app.plain");
    await loop.drain();
    writePlain(dir, "app.plain", app(["Say hello."]).replace("use pytest.", "use pytest, one file each."));
    await loop.bringUp("app.plain");
    await loop.drain();
    expect(ran).toHaveLength(1);
  });

  it("plans again from what landed when the spec changes, and patches the functional spec that changed", async () => {
    writePlain(dir, "app.plain", app(["Say hello.", "Say goodbye."]));
    const { ran, run } = runner();
    const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, run });
    await loop.bringUp("app.plain");
    await loop.drain();
    writePlain(dir, "app.plain", app([["say-hello", "Say hello loudly."], "Say goodbye."]));
    await loop.bringUp("app.plain");
    await loop.drain();
    expect(ran.at(-1)).toMatchObject({ add: [], patch: ["say-hello"] });
  });

  it("stops the running job once the spec no longer wants what it builds, rolls it back, and builds the spec as it now is", async () => {
    writePlain(dir, "app.plain", app(["Say hello."]));
    const { ran, gate, holdNext, run } = runner();
    const registry = createJobRegistry();
    const loop = createWorkLoop({ registry, cwd: dir, planner: false, run });
    holdNext();
    await loop.bringUp("app.plain");
    const first = loop.status()[0]!.running!.jobId;
    // The functional spec it is building is replaced by another while it runs - no steer: a spec taken out, one put in.
    writePlain(dir, "app.plain", app(["Count the stars in the night sky."]));
    await loop.bringUp("app.plain");
    // Stopped, its agent is aborted and it lands nothing.
    gate.land = false;
    gate.release!();
    const stopped = await registry.wait(first);
    expect(stopped.status).toBe("stopped");
    gate.land = true;
    await loop.drain();
    expect(ran).toHaveLength(2);
    expect(JSON.stringify(readRecord(codeDir()))).toContain("Count the stars in the night sky.");
  });

  it("says it was turri that stopped the job, and what changed under it", async () => {
    writePlain(dir, "app.plain", app(["Say hello."]));
    const { gate, holdNext, run } = runner();
    const registry = createJobRegistry();
    const loop = createWorkLoop({ registry, cwd: dir, planner: false, run });
    holdNext();
    await loop.bringUp("app.plain");
    const first = loop.status()[0]!.running!.jobId;
    writePlain(dir, "app.plain", app(["Count the stars in the night sky."]));
    await loop.bringUp("app.plain");
    gate.land = false;
    gate.release!();
    const stopped = await registry.wait(first);
    expect(stopped.error).toContain("Stopped by turri, not by you: functional specs 1 reads otherwise now");
    expect(stopped.error).toContain("allow-to-stop-jobs: false");
    gate.land = true;
    await loop.drain();
  });

  describe("steering the running job", () => {
    /** A module whose one job is running, held, and the loop over it. */
    async function running(specs: Spec[]) {
      writePlain(dir, "app.plain", app(specs));
      const stub = runner();
      const registry = createJobRegistry();
      const loop = createWorkLoop({ registry, cwd: dir, planner: false, run: stub.run });
      stub.holdNext();
      await loop.bringUp("app.plain");
      return { ...stub, registry, loop, first: loop.status()[0]!.running!.jobId };
    }

    it("steers it when a functional spec it regenerates is reworded or gains a sub-bullet - not stopped, and it lands the spec as it is now", async () => {
      const { ran, gate, registry, loop, first } = await running(["Say hello."]);
      writePlain(dir, "app.plain", app(["Say hello.\n  - In French."]));
      await loop.bringUp("app.plain");
      expect(loop.status()[0]!.running).toMatchObject({ jobId: first, steered: [expect.stringContaining("functional specs 1")] });
      expect(describeModules(loop.status())).toContain("⇢ steered");
      gate.release!();
      expect((await registry.wait(first)).status).toBe("succeeded");
      await loop.drain();
      // One job: the steer was it, no second one for the change.
      expect(ran).toHaveLength(1);
      expect(JSON.stringify(readRecord(codeDir()))).toContain("In French.");
    });

    it("steers it when a file one of its specs links is edited", async () => {
      mkdirSync(join(dir, "resources"));
      writeFileSync(join(dir, "resources", "api.yaml"), "openapi: 3.0.0\n");
      const { ran, gate, registry, loop, first } = await running(["Say hello as [the API](resources/api.yaml) says."]);
      writeFileSync(join(dir, "resources", "api.yaml"), "openapi: 3.1.0\n");
      await loop.bringUp("app.plain");
      expect(loop.status()[0]!.running!.steered).toEqual([expect.stringContaining("resources/api.yaml holds something else now")]);
      gate.release!();
      expect((await registry.wait(first)).status).toBe("succeeded");
      await loop.drain();
      expect(ran).toHaveLength(1);
    });

    it("leaves a new item to the next job - the running one goes on, unsteered", async () => {
      const { ran, gate, registry, loop, first } = await running(["Say hello."]);
      writePlain(dir, "app.plain", app(["Say hello.", "Say goodbye."]));
      await loop.bringUp("app.plain");
      expect(loop.status()[0]!.running!.steered).toBeUndefined();
      gate.release!();
      expect((await registry.wait(first)).status).toBe("succeeded");
      await loop.drain();
      expect(ran.map((job) => job.add)).toEqual([["say-hello"], ["say-goodbye"]]);
    });

    it("steers it twice at most: a third change stops it, as allow-to-stop-jobs says", async () => {
      const { gate, registry, loop, first } = await running(["Say hello."]);
      for (const version of ["Say hello.\n  - In French.", "Say hello.\n  - In German."]) {
        writePlain(dir, "app.plain", app([version]));
        await loop.bringUp("app.plain");
      }
      expect(loop.status()[0]!.running!.steered).toHaveLength(2);
      writePlain(dir, "app.plain", app(["Say hello.\n  - In Italian."]));
      await loop.bringUp("app.plain");
      gate.land = false;
      gate.release!();
      expect((await registry.wait(first)).status).toBe("stopped");
      gate.land = true;
      await loop.drain();
      expect(JSON.stringify(readRecord(codeDir()))).toContain("In Italian.");
    });
  });

  it("lets the running job land under allow-to-stop-jobs: false, and regenerates what changed since on top of it", async () => {
    writeFileSync(join(dir, "config.yaml"), "allow-to-stop-jobs: false\n");
    writePlain(dir, "app.plain", app(["Say hello."]));
    const { ran, gate, holdNext, run } = runner();
    const registry = createJobRegistry();
    const loop = createWorkLoop({ registry, cwd: dir, planner: false, run });
    holdNext();
    await loop.bringUp("app.plain");
    const first = loop.status()[0]!.running!.jobId;
    // Not a steer - the spec replaced by another - and not stopped either.
    writePlain(dir, "app.plain", app(["Count the stars in the night sky."]));
    await loop.bringUp("app.plain");
    gate.release!();
    // Not stopped: it lands what it was regenerating.
    expect((await registry.wait(first)).status).toBe("succeeded");
    await loop.drain();
    // Then the change - the spec taken out, another put in - in jobs of its own on top of what it landed.
    expect(ran[0]).toMatchObject({ add: ["say-hello"] });
    expect(ran.length).toBeGreaterThan(1);
    expect(JSON.stringify(readRecord(codeDir()))).toContain("Count the stars in the night sky.");
  });

  it("plans what comes after the running job as soon as the spec changes - from what it will land - and lists it as jobs queued behind it", async () => {
    writePlain(dir, "app.plain", app(["Say hello."]));
    const { ran, gate, holdNext, run } = runner();
    const registry = createJobRegistry();
    const loop = createWorkLoop({ registry, cwd: dir, planner: false, run });
    holdNext();
    await loop.bringUp("app.plain");
    const first = loop.status()[0]!.running!.jobId;
    writePlain(dir, "app.plain", app(["Say hello.", "Say goodbye.", "Count to ten."]));
    await loop.bringUp("app.plain");
    expect(loop.status()[0]!.planned.map((job) => job.cases.add.map((spec) => spec.funcId))).toEqual([["say-goodbye"], ["count-to-ten"]]);
    const planned = loop.planned();
    expect(planned.map((job) => [job.status, job.summary, job.waitingOn])).toEqual([
      ["queued", "app.plain Say goodbye.", [first]],
      ["queued", "app.plain Count to ten.", [planned[0]!.id]],
    ]);
    gate.release!();
    await loop.drain();
    expect(ran.map((job) => job.add)).toEqual([["say-hello"], ["say-goodbye"], ["count-to-ten"]]);
    expect(loop.planned()).toEqual([]);
  });

  it("lets the running job finish when the change comes on top of what it builds", async () => {
    writePlain(dir, "app.plain", app(["Say hello."]));
    const { ran, gate, holdNext, run } = runner();
    const registry = createJobRegistry();
    const loop = createWorkLoop({ registry, cwd: dir, planner: false, run });
    holdNext();
    await loop.bringUp("app.plain");
    const first = loop.status()[0]!.running!.jobId;
    writePlain(dir, "app.plain", app(["Say hello.", "Say goodbye."]));
    await loop.bringUp("app.plain");
    expect(registry.get(first)!.status).toBe("running");
    gate.release!();
    await loop.drain();
    expect(ran.map((job) => job.add)).toEqual([["say-hello"], ["say-goodbye"]]);
  });

  it("halts a module whose job did not land, until the spec changes or it is asked for again", async () => {
    writePlain(dir, "app.plain", app(["Say hello."]));
    const { ran, gate, run } = runner();
    const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, run });
    gate.land = false;
    await loop.bringUp("app.plain");
    await loop.drain();
    expect(ran).toHaveLength(1);
    expect(loop.status()[0]!.why).toMatch(/did not land/);
    gate.land = true;
    await loop.bringUp("app.plain");
    await loop.drain();
    expect(ran).toHaveLength(2);
    expect(readRecord(codeDir())).not.toBeNull();
  });

  it("builds a module built on another only once that one is built, from what it inherits", async () => {
    writePlain(dir, "base.plain", "***implementation reqs***\n\n- :Implementation: is Python.\n\n***functional specs***\n\n# register\nUsers register.\n");
    writePlain(dir, "top.plain", "---\nrequires:\n  - base\n---\n\n***implementation reqs***\n\n- :Implementation: is Python.\n\n***functional specs***\n\n# home-page\nThe home page says hello.\n");
    const { ran, holdNext, gate, run } = runner();
    const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, run });
    holdNext();
    await loop.bringUp("top.plain");
    expect(loop.status().map((module) => [module.module, module.running !== undefined, module.why])).toEqual([
      ["base", true, undefined],
      ["top", false, "waiting for base: the code it is built on is not built yet"],
    ]);
    // Not planned yet, it is in the queue all the same: behind the job of the module it waits for.
    const running = loop.status()[0]!.running!.jobId;
    expect(loop.planned().map((job) => [job.summary, job.status, job.waitingOn])).toEqual([["top.plain - waits for base", "queued", [running]]]);
    gate.release!();
    await loop.drain();
    expect(loop.planned()).toEqual([]);
    expect(ran.map((job) => [job.module, job.add])).toEqual([
      ["base", ["register"]],
      ["top", ["home-page"]],
    ]);
    // Built on base, it is not fresh: it starts from base's code.
    expect(ran[1]!.fresh).toBe(false);
    expect(JSON.stringify(readRecord(codeDir("top")))).toContain("Users register.");
  });

  it("builds two modules that share nothing side by side - neither waits for the other", async () => {
    writePlain(dir, "frontend.plain", app(["Show the home page."]));
    writePlain(dir, "backend.plain", app(["Serve the users."]));
    const { ran, gate, holdNext, run } = runner();
    const registry = createJobRegistry();
    const loop = createWorkLoop({ registry, cwd: dir, planner: false, run });
    holdNext();
    await loop.bringUp("frontend.plain");
    await loop.bringUp("backend.plain");
    // The frontend's job is held, and the backend's lands all the same.
    await vi.waitFor(() => expect(readRecord(codeDir("backend"))).not.toBeNull());
    expect(ran.map((job) => job.module).sort()).toEqual(["backend", "frontend"]);
    expect(loop.status().find((module) => module.module === "frontend")!.running).toBeDefined();
    expect(readRecord(codeDir("frontend"))).toBeNull();
    gate.release!();
    await loop.drain();
    expect(readRecord(codeDir("frontend"))).not.toBeNull();
  });

  describe("in a requires chain", () => {
    const base = (definition = "a person with an account") =>
      `***definitions***\n\n- :User: is ${definition}.\n\n***implementation reqs***\n\n- :Implementation: is Python.\n\n***functional specs***\n\n# register\nA :User: registers.\n`;
    const on = (module: string, spec: string) => `---\nrequires:\n  - base\n---\n\n***implementation reqs***\n\n- :Implementation: is Python.\n\n***functional specs***\n\n# ${slug(spec)}\n${spec}\n`;

    async function builtChain() {
      writePlain(dir, "base.plain", base());
      writePlain(dir, "app.plain", on("app", "The home page says hello."));
      const r = runner();
      const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, run: r.run });
      await loop.bringUp("app.plain");
      await loop.drain();
      return { ...r, loop };
    }

    it("records in the codebase at the tip the whole chain it holds - the definitions of the module below tagged with it, and what both say once", async () => {
      await builtChain();
      const record = readRecord(codeDir("app"))!;
      expect(record.definitions).toEqual([{ markdown: "- :User: is a person with an account.", module: "base" }]);
      // Both say it: the code below implements it already, so it is base's.
      expect(record["implementation reqs"]).toEqual([{ markdown: "- :Implementation: is Python.", module: "base" }]);
      expect(JSON.stringify(record["required functional specs"])).toContain("A :User: registers.");
    });

    it("makes a change to the module below in the codebase at the tip, and leaves the one below as it was", async () => {
      const { ran, run } = await builtChain();
      const baseRecord = JSON.stringify(readRecord(codeDir("base")));
      writePlain(dir, "base.plain", base("a person with a verified email"));
      const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, run });
      await loop.bringUp("base.plain");
      await loop.drain();
      expect(ran.map((job) => job.module)).toEqual(["base", "app", "app"]);
      expect(JSON.stringify(readRecord(codeDir("app")))).toContain("a verified email");
      expect(JSON.stringify(readRecord(codeDir("base")))).toBe(baseRecord);
    });

    it("brings a codebase left behind up to its spec first, when a new module is to start from it", async () => {
      const { ran, run } = await builtChain();
      writePlain(dir, "base.plain", base("a person with a verified email"));
      writePlain(dir, "admin.plain", on("admin", "The admin page lists every user."));
      const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, run });
      await loop.bringUp("admin.plain");
      await loop.drain();
      expect(ran.slice(2).map((job) => job.module)).toEqual(["base", "admin"]);
      expect(JSON.stringify(readRecord(codeDir("base")))).toContain("a verified email");
      expect(JSON.stringify(readRecord(codeDir("admin")))).toContain("a verified email");
    });
  });

  describe("the conformance tests", () => {
    const testsDir = (module = "app") => join(dir, "plain_modules", module, "tests");

    /** A conformance job that records what it wrote the tests for, as the real one does - or does not pass. */
    function conformanceRunner() {
      const ran: Array<{ add: string[]; patch: string[]; delete: string[] }> = [];
      const gate = { pass: true };
      const runConformance: JobRunner = async (job) => {
        ran.push({ add: job.planned.cases.add.map((spec) => spec.funcId), patch: job.planned.cases.patch.map((spec) => spec.funcId), delete: job.planned.cases.delete.map((spec) => spec.funcId) });
        if (!gate.pass) return { landed: false, report: "the tests do not pass" };
        mkdirSync(testsDir(job.moduleName), { recursive: true });
        writeFileSync(join(testsDir(job.moduleName), "test_app.py"), "# conformance\n", { flag: "a" });
        writeTestsRecord(testsDir(job.moduleName), job.planned.step.tree);
        recordHistory(job.buildDir, `conformance: ${job.planned.title}`);
        return { landed: true, report: "passed" };
      };
      return { ran, gate, runConformance };
    }

    it("are not planned out for a functional spec edited while its tests are being written - they are written again for its new text", async () => {
      // The running pulse is let finish: what comes after it is planned ahead, from what it will land.
      writeFileSync(join(dir, "config.yaml"), "allow-to-stop-jobs: false\n");
      writePlain(dir, "app.plain", app(["Say hello.", "Say goodbye."]));
      scenariosIn("say-hello");
      scenariosIn("say-goodbye");
      const code = runner();
      const tests = conformanceRunner();
      // The conformance pulse is held while it writes, so the spec can change under it.
      let release!: () => void;
      let hold: Promise<void> | undefined = new Promise((resolve) => (release = resolve));
      let started!: () => void;
      const writing = new Promise<void>((resolve) => (started = resolve));
      /** The functional specs a conformance pulse took the tests of out. */
      const deleted: string[] = [];
      const loop = createWorkLoop({
        registry: createJobRegistry(),
        cwd: dir,
        planner: false,
        run: code.run,
        runConformance: async (job, onDelta) => {
          deleted.push(...job.planned.cases.delete.map((spec) => spec.funcId));
          const held = hold;
          hold = undefined;
          if (held !== undefined) {
            started();
            await held;
          }
          return tests.runConformance(job, onDelta);
        },
      });
      await loop.bringUp("app.plain");
      await writing;
      // While it writes say-goodbye's tests for "Say goodbye.", say-goodbye is edited: its code is behind the spec now.
      writePlain(dir, "app.plain", app(["Say hello.", ["say-goodbye", "Say goodbye, loudly."]]));
      await loop.bringUp("app.plain");
      release();
      await loop.drain();
      // What ran after: say-goodbye's code regenerated again, and its tests written again for the new text - never taken
      // out first, to be written again a pulse later.
      expect(deleted).toEqual([]);
      const after = tests.ran.slice(1);
      expect(after.length).toBeGreaterThan(0);
      expect(after.some((run) => run.patch.includes("say-goodbye") || run.add.includes("say-goodbye"))).toBe(true);
      const tested = JSON.stringify(readRecord(testsDir()));
      expect(tested).toContain("Say goodbye, loudly.");
      expect(tested).not.toContain('"Say goodbye."');
    });

    it("are written once the module's code is built - every code job of it landed - in one job for the functional specs with scenarios", async () => {
      writePlain(dir, "app.plain", app(["Say hello.", "Say goodbye."]));
      scenariosIn("say-hello");
      scenariosIn("say-goodbye");
      const code = runner();
      const tests = conformanceRunner();
      const order: string[] = [];
      const loop = createWorkLoop({
        registry: createJobRegistry(),
        cwd: dir,
        planner: false,
        run: async (job, onDelta) => (order.push(`code ${job.planned.cases.add.map((spec) => spec.funcId).join(",")}`), code.run(job, onDelta)),
        runConformance: async (job, onDelta) => (order.push(`tests ${job.planned.cases.add.map((spec) => spec.funcId).join(",")}`), tests.runConformance(job, onDelta)),
      });
      await loop.bringUp("app.plain");
      await loop.drain();
      expect(order.map((entry) => entry.split(" ")[0])).toEqual(["code", "code", "tests"]);
      expect(tests.ran.map((job) => job.add)).toEqual([["say-hello", "say-goodbye"]]);
      const tested = readRecord(testsDir())!;
      expect(JSON.stringify(tested)).toContain("Say goodbye.");
      expect(JSON.stringify(tested)).toContain("use pytest.");
      // What they are written for carries the scenarios: a scenario changed is conformance work.
      expect(JSON.stringify(tested)).toContain("It works.");
    });

    it("are written for a functional spec with scenarios and none for one with no test plain file", async () => {
      writePlain(dir, "app.plain", app(["Say hello.", "Say goodbye."]));
      scenariosIn("say-goodbye");
      const code = runner();
      const tests = conformanceRunner();
      const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, run: code.run, runConformance: tests.runConformance });
      await loop.bringUp("app.plain");
      await loop.drain();
      expect(tests.ran.map((job) => job.add)).toEqual([["say-goodbye"]]);
      expect(JSON.stringify(readRecord(testsDir()))).not.toContain("Say hello.");
      // Asked again, there is nothing to write: it says so, and starts nothing.
      const [status] = await loop.conformance("app.plain", { funcIds: ["app:say-goodbye"] });
      await loop.drain();
      expect(tests.ran).toHaveLength(1);
      expect(status!.conformanceNote).toBe("the conformance tests of app:say-goodbye are written for it as built: there is nothing to write");
    });

    it("are written for the functional specs conform names alone - the others left behind, as drift says, until the module is asked for again", async () => {
      writePlain(dir, "app.plain", app(["Say hello.", "Say goodbye.", "Say thanks."]));
      const code = runner();
      const tests = conformanceRunner();
      const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, run: code.run, runConformance: tests.runConformance });
      await loop.bringUp("app.plain");
      await loop.drain();
      // Built with no scenarios; then every functional spec is given some, and one is asked for.
      for (const funcId of ["say-hello", "say-goodbye", "say-thanks"]) scenariosIn(funcId);
      await loop.conformance("app.plain", { funcIds: ["app:say-hello"] });
      await loop.drain();
      expect(tests.ran.map((job) => job.add)).toEqual([["say-hello"]]);
      const drift = describeDrift(loop.drift("app.plain"));
      expect(drift).toContain("conform asked for app:say-hello alone: the others wait for conform with no names, or the module asked for again");
      expect(drift).toContain("app:say-goodbye");
      // A change to the scenarios of one not named: work again, and it joins them - the other still waits.
      scenariosIn("say-thanks", "app", "# works\nIt works, and says thanks.");
      await loop.bringUp("app.plain", { specChange: true });
      await loop.drain();
      expect(tests.ran.map((job) => job.add)).toEqual([["say-hello"], ["say-thanks"]]);
      // Asked for with no names: the rest.
      await loop.conformance("app.plain");
      await loop.drain();
      expect(tests.ran.map((job) => job.add)).toEqual([["say-hello"], ["say-thanks"], ["say-goodbye"]]);
      expect(describeDrift(loop.drift("app.plain"))).toContain("conformance tests: written for what is built - no drift");
    });

    it("write none in a module whose functional specs have no scenarios", async () => {
      writePlain(dir, "app.plain", app(["Say hello.", "Say goodbye."]));
      const code = runner();
      const tests = conformanceRunner();
      const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, run: code.run, runConformance: tests.runConformance });
      await loop.bringUp("app.plain");
      await loop.drain();
      expect(code.ran).toHaveLength(2);
      expect(tests.ran).toEqual([]);
      expect(existsSync(join(testsDir(), ".turri.json"))).toBe(false);
    });

    describe("with a step of adding tests skipped", () => {
      /** app with no test reqs. */
      const noTestReqs = (specs: Spec[]) => app(specs).replace("***test reqs***\n\n- :ConformanceTests: use pytest.\n\n", "");
      const NO_TEST_REQS =
        "app has scenarios to test - app:say-hello - but no ***test reqs***, so its conformance tests cannot be written - the test reqs are the first step of adding tests. " +
        "Next step: write the module's own ***test reqs***, with change_plain.";
      const NO_SCRIPT =
        "app has scenarios to test - app:say-hello - and ***test reqs*** but no conformance testing script, so nothing can run its conformance tests - the script is the second step of adding tests. " +
        "Next step: write the conformance testing script with the implement-conformance-testing-script skill.";
      const noScript = () => rmSync(join(dir, "test_scripts", "run_conformance_tests_python.sh"));

      it("are refused for a module with scenarios but no test reqs - its code built, the step named, waiting on it until the ***plain has them", async () => {
        writePlain(dir, "app.plain", noTestReqs(["Say hello."]));
        scenariosIn("say-hello");
        const code = runner();
        const tests = conformanceRunner();
        const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, run: code.run, runConformance: tests.runConformance });
        const [planned] = await loop.bringUp("app.plain");
        // Not listed as planned once the code is built: it is not, until the step is taken.
        expect(planned!.planned.some((job) => job.track === "conformance")).toBe(false);
        await loop.drain();
        expect(code.ran).toHaveLength(1);
        expect(tests.ran).toEqual([]);
        expect(loop.status()[0]!.why).toBe(`waiting for its test reqs: ${NO_TEST_REQS}`);
        expect(describeDrift(loop.drift("app.plain"))).toContain(`  waiting for its test reqs: ${NO_TEST_REQS}`);
        // Asked again, nothing changed: refused again, nothing started - it neither loops nor retries.
        await loop.bringUp("app.plain");
        await loop.drain();
        expect(tests.ran).toEqual([]);
        // The ***plain has them now: the conformance pulse starts.
        writePlain(dir, "app.plain", app(["Say hello."]));
        await loop.bringUp("app.plain", { specChange: true });
        await loop.drain();
        expect(tests.ran.map((job) => job.add)).toEqual([["say-hello"]]);
        expect(loop.status()[0]!.why).toBe(UP_TO_DATE);
      });

      it("are refused for a module with scenarios but no conformance testing script for its stack - waiting on it until there is one", async () => {
        noScript();
        writePlain(dir, "app.plain", app(["Say hello."]));
        scenariosIn("say-hello");
        const code = runner();
        const tests = conformanceRunner();
        const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, run: code.run, runConformance: tests.runConformance });
        await loop.bringUp("app.plain");
        await loop.drain();
        expect(code.ran).toHaveLength(1);
        expect(tests.ran).toEqual([]);
        expect(loop.status()[0]!.why).toBe(`waiting for its conformance testing script: ${NO_SCRIPT}`);
        // Its code is not halted: nothing failed.
        writeFileSync(join(dir, "test_scripts", "run_conformance_tests_python.sh"), "#!/bin/sh\nexit 0\n");
        await loop.bringUp("app.plain");
        await loop.drain();
        expect(tests.ran.map((job) => job.add)).toEqual([["say-hello"]]);
      });

      it("are refused by conform, naming the step - the test reqs first, then the script - and nothing is started", async () => {
        noScript();
        writePlain(dir, "app.plain", noTestReqs(["Say hello."]));
        scenariosIn("say-hello");
        const code = runner();
        const tests = conformanceRunner();
        const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, run: code.run, runConformance: tests.runConformance });
        await expect(loop.conformance("app.plain")).rejects.toThrow(
          `${NO_TEST_REQS.replace(/\.$/, "")}; then write the conformance testing script with the implement-conformance-testing-script skill. Nothing was started.`,
        );
        writePlain(dir, "app.plain", app(["Say hello."]));
        await expect(loop.conformance("app.plain", { funcIds: ["app:say-hello"] })).rejects.toThrow(`${NO_SCRIPT} Nothing was started.`);
        expect(code.ran).toEqual([]);
        expect(tests.ran).toEqual([]);
      });

      it("are neither refused nor waited on in a module with no scenarios, test reqs and script or not", async () => {
        noScript();
        writePlain(dir, "app.plain", noTestReqs(["Say hello."]));
        const code = runner();
        const tests = conformanceRunner();
        const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, run: code.run, runConformance: tests.runConformance });
        await loop.bringUp("app.plain");
        await loop.drain();
        expect(code.ran).toHaveLength(1);
        expect(tests.ran).toEqual([]);
        expect(loop.status()[0]!.why).toBe(UP_TO_DATE);
        expect(describeDrift(loop.drift("app.plain"))).toContain("Fully regenerated");
      });
    });

    it("rewrite a functional spec's tests once its changed code lands, and write none for what only changed its test reqs in the code", async () => {
      writePlain(dir, "app.plain", app(["Say hello."]));
      scenariosIn("say-hello");
      const code = runner();
      const tests = conformanceRunner();
      const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, run: code.run, runConformance: tests.runConformance });
      await loop.bringUp("app.plain");
      await loop.drain();
      writePlain(dir, "app.plain", app([["say-hello", "Say hello loudly."]]));
      await loop.bringUp("app.plain");
      await loop.drain();
      expect(tests.ran.at(-1)).toMatchObject({ patch: ["say-hello"] });
      // Only the test reqs: no code job, a conformance job with nothing but them - mechanical.
      const codeJobs = code.ran.length;
      writePlain(dir, "app.plain", app([["say-hello", "Say hello loudly."]]).replace("use pytest.", "use pytest, one file each."));
      await loop.bringUp("app.plain");
      await loop.drain();
      expect(code.ran).toHaveLength(codeJobs);
      expect(tests.ran.at(-1)).toMatchObject({ add: [], patch: [] });
    });

    it("are written again for a scenario changed alone - a conformance pulse, and no code pulse", async () => {
      writePlain(dir, "app.plain", app(["Say hello.", "Say goodbye."]));
      scenariosIn("say-hello");
      scenariosIn("say-goodbye");
      const code = runner();
      const tests = conformanceRunner();
      const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, run: code.run, runConformance: tests.runConformance });
      await loop.bringUp("app.plain");
      await loop.drain();
      const codeJobs = code.ran.length;
      scenariosIn("say-hello", "app", "# loud\nIt says hello loudly.");
      await loop.bringUp("app.plain", { specChange: true });
      await loop.drain();
      expect(code.ran).toHaveLength(codeJobs);
      expect(tests.ran.slice(1)).toEqual([{ add: [], patch: ["say-hello"], delete: [] }]);
      expect(JSON.stringify(readRecord(testsDir()))).toContain("It says hello loudly.");
    });

    it("are taken out for a functional spec whose scenarios are all taken out - its code left as it is", async () => {
      writePlain(dir, "app.plain", app(["Say hello.", "Say goodbye."]));
      scenariosIn("say-hello");
      scenariosIn("say-goodbye");
      const code = runner();
      const tests = conformanceRunner();
      const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, run: code.run, runConformance: tests.runConformance });
      await loop.bringUp("app.plain");
      await loop.drain();
      const codeJobs = code.ran.length;
      // Its scenarios all taken out: its test plain file is deleted - an empty one is a syntax error.
      rmSync(join(dir, "tests", "app", "say-goodbye.plain"));
      await loop.bringUp("app.plain", { specChange: true });
      await loop.drain();
      expect(code.ran).toHaveLength(codeJobs);
      expect(tests.ran.slice(1)).toEqual([{ add: [], patch: [], delete: ["say-goodbye"] }]);
      expect(JSON.stringify(readRecord(testsDir()))).not.toContain("Say goodbye.");
    });

    it("bring one edit that adds, changes and removes scenarios across functional specs into one pulse, with every case", async () => {
      writePlain(dir, "app.plain", app(["Say hello.", "Say goodbye."]));
      const scenarios = (funcId: string, ...acceptance: string[]) => writeFileSync(join(dir, "tests", "app", `${funcId}.plain`), testPlainFile("app", funcId, { acceptance }));
      mkdirSync(join(dir, "tests", "app"), { recursive: true });
      scenarios("say-hello", "# works\nIt works.");
      scenarios("say-goodbye", "# works\nIt works.", "# waves\nIt waves.");
      const code = runner();
      const tests = conformanceRunner();
      const pulses: string[][] = [];
      const loop = createWorkLoop({
        registry: createJobRegistry(),
        cwd: dir,
        planner: false,
        run: code.run,
        runConformance: async (job, onDelta) => {
          pulses.push(
            (job.planned.cases.scenarios ?? []).map(
              (spec) => `${spec.funcId}: +${spec.added.map((entry) => entry.id)} ~${spec.changed.map((entry) => entry.id)} -${spec.removed.map((entry) => entry.id)} =${spec.unchanged.map((entry) => entry.id)}`,
            ),
          );
          return tests.runConformance(job, onDelta);
        },
      });
      await loop.bringUp("app.plain");
      await loop.drain();
      expect(pulses).toEqual([["say-hello: +works ~ - =", "say-goodbye: +works,waves ~ - ="]]);
      const built = code.ran.length;
      scenarios("say-hello", "# works\nIt works well.", "# loud\nIt says hello loudly.");
      scenarios("say-goodbye", "# works\nIt works.");
      await loop.bringUp("app.plain", { specChange: true });
      await loop.drain();
      expect(pulses.slice(1)).toEqual([["say-hello: +loud ~works - =", "say-goodbye: + ~ -waves =works"]]);
      // Scenarios are the conformance tests' alone: no code pulse for them.
      expect(code.ran).toHaveLength(built);
    });

    describe("of a func-id or a scenario-id renamed", () => {
      /** app built with a test of each scenario, labelled: the code, the tests and their records committed. */
      async function built() {
        writePlain(dir, "app.plain", app(["Say hello.", "Say goodbye."]));
        scenariosIn("say-hello");
        scenariosIn("say-goodbye");
        const code = runner();
        const tests = conformanceRunner();
        const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, run: code.run, runConformance: tests.runConformance });
        await loop.bringUp("app.plain");
        await loop.drain();
        writeFileSync(
          join(testsDir(), "test_say.py"),
          "# conformance tests of app:say-hello\n# acceptance scenario works of app:say-hello\n# conformance tests of app:say-hello-loudly\n" +
            "# conformance tests of app:say-goodbye\n# acceptance scenario works of app:say-goodbye\n",
        );
        recordHistory(codeDir(), "the tests labelled");
        return { loop, code, tests, pulses: () => code.ran.length + tests.ran.length };
      }
      const renamedTo = (from: string, to: string, text?: string) => {
        rmSync(join(dir, "tests", "app", `${from}.plain`));
        scenariosIn(to);
        writePlain(dir, "app.plain", app([[to, text ?? "Say hello."], "Say goodbye."]));
      };
      const ids = (tree: Record<string, unknown> | null) => ((tree?.["functional specs"] as Array<{ id: string }> | undefined) ?? []).map((item) => item.id);

      it("renames the records and relabels the tests itself - the code untouched, no pulse started", async () => {
        const { loop, pulses } = await built();
        const before = pulses();
        const codeFile = readFileSync(join(codeDir(), "app.py"), "utf8");
        renamedTo("say-hello", "greet");
        expect(describeDrift(loop.drift("app.plain"))).toContain("  renames app:say-hello to app:greet - the records and the tests' labels only, nothing regenerated");
        await loop.bringUp("app.plain", { specChange: true });
        await loop.drain();
        expect(pulses()).toBe(before);
        expect(readFileSync(join(codeDir(), "app.py"), "utf8")).toBe(codeFile);
        expect(ids(readRecord(codeDir()))).toEqual(["greet", "say-goodbye"]);
        expect(ids(readRecord(testsDir()))).toEqual(["greet", "say-goodbye"]);
        // On the whole key: say-hello-loudly is another functional spec's label, left as it is.
        expect(readFileSync(join(testsDir(), "test_say.py"), "utf8")).toBe(
          "# conformance tests of app:greet\n# acceptance scenario works of app:greet\n# conformance tests of app:say-hello-loudly\n" +
            "# conformance tests of app:say-goodbye\n# acceptance scenario works of app:say-goodbye\n",
        );
        expect(execFileSync("git", ["--git-dir", join(dir, "plain_modules", "app", ".plaingit"), "log", "-1", "--format=%s"], { encoding: "utf8" })).toContain("renamed app:say-hello to app:greet");
        expect(describeDrift(loop.drift("app.plain"))).toContain("Fully regenerated");
      });

      it("rebuilds a functional spec renamed and changed at once - a delete and an add", async () => {
        const { loop, code } = await built();
        const before = code.ran.length;
        renamedTo("say-hello", "greet", "Say hello warmly.");
        await loop.bringUp("app.plain", { specChange: true });
        await loop.drain();
        expect(code.ran.slice(before).map((job) => job.add)).toEqual([["greet"]]);
      });

      it("relabels the tests of a scenario-id renamed, and rewrites none", async () => {
        const { loop, pulses } = await built();
        const before = pulses();
        scenariosIn("say-goodbye", "app", "# still-works\nIt works.");
        await loop.bringUp("app.plain", { specChange: true });
        await loop.drain();
        expect(pulses()).toBe(before);
        expect(readFileSync(join(testsDir(), "test_say.py"), "utf8")).toContain("# acceptance scenario still-works of app:say-goodbye\n");
        expect(readFileSync(join(testsDir(), "test_say.py"), "utf8")).toContain("# acceptance scenario works of app:say-hello\n");
        expect(JSON.stringify(readRecord(testsDir()))).toContain('"id":"still-works"');
      });

      it("rolls a rename that fails midway back whole, and halts rather than rebuild it", async () => {
        const { loop, pulses } = await built();
        const before = pulses();
        const recordBefore = JSON.stringify(readRecord(codeDir()));
        // The tests cannot be relabelled: the records are rewritten first, and put back with the rest.
        execFileSync("chmod", ["444", join(testsDir(), "test_say.py")]);
        renamedTo("say-hello", "greet");
        await loop.bringUp("app.plain", { specChange: true });
        await loop.drain();
        expect(pulses()).toBe(before);
        expect(JSON.stringify(readRecord(codeDir(), { onDisk: true }))).toBe(recordBefore);
        expect(ids(readRecord(testsDir(), { onDisk: true }))).toEqual(["say-hello", "say-goodbye"]);
        expect(readFileSync(join(testsDir(), "test_say.py"), "utf8")).toContain("of app:say-hello\n");
        expect(loop.status()[0]!.why).toMatch(/^renaming app:say-hello to app:greet failed, and was rolled back/);
      });
    });

    it("say in the drift what is to write or change, a line a functional spec with its scenarios counted by case", async () => {
      writePlain(dir, "app.plain", app(["Say hello.", "Say goodbye."]));
      scenariosIn("say-hello");
      scenariosIn("say-goodbye");
      const code = runner();
      const tests = conformanceRunner();
      const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, run: code.run, runConformance: tests.runConformance });
      await loop.bringUp("app.plain");
      await loop.drain();
      expect(describeDrift(loop.drift("app.plain"))).toContain("conformance tests: written for what is built - no drift");
      writeFileSync(join(dir, "tests", "app", "say-hello.plain"), testPlainFile("app", "say-hello", { acceptance: ["# works\nIt works, and says so.", "# loud\nIt says hello loudly."] }));
      // Its scenarios all taken out: its test plain file is deleted - an empty one is a syntax error.
      rmSync(join(dir, "tests", "app", "say-goodbye.plain"));
      const text = describeDrift(loop.drift("app.plain"));
      expect(text).toContain("conformance tests: to write or change - written once the code is built, or now with conform\n");
      expect(text).toContain("    app:say-hello     1 added, 1 changed\n");
      expect(text).toContain("    app:say-goodbye   taken out - its tests go (1 removed)");
    });

    const base = (spec: string) => `***implementation reqs***\n\n- :Implementation: is Python.\n\n***test reqs***\n\n- :ConformanceTests: use pytest.\n\n***functional specs***\n\n# ${slug(spec)}\n${spec}\n`;
    const top = (spec: string) => `---\nrequires:\n  - base\n---\n\n${base(spec)}`;

    it("are written and pass for a module before one built on it starts - which starts from its code and its conformance tests", async () => {
      writePlain(dir, "base.plain", base("Users register."));
      writePlain(dir, "top.plain", top("The home page says hello."));
      scenariosIn("users-register", "base");
      scenariosIn("the-home-page-says-hello", "top");
      const order: string[] = [];
      const code = runner();
      const tests = conformanceRunner();
      const loop = createWorkLoop({
        registry: createJobRegistry(),
        cwd: dir,
        planner: false,
        run: async (job, onDelta) => (order.push(`code ${job.moduleName}`), code.run(job, onDelta)),
        runConformance: async (job, onDelta) => {
          order.push(`tests ${job.moduleName}`);
          return tests.runConformance(job, onDelta);
        },
      });
      await loop.bringUp("top.plain");
      await loop.drain();
      expect(order).toEqual(["code base", "tests base", "code top", "tests top"]);
      // The module above started from the conformance tests below it - base's, then its own added.
      expect(readFileSync(join(testsDir("top"), "test_app.py"), "utf8")).toBe("# conformance\n# conformance\n");
      expect(readFileSync(join(codeDir("top"), "base.py"), "utf8")).toContain("Users register.");
    });

    it("that do not pass halt their module - no more of its code - and every module built on it", async () => {
      writePlain(dir, "base.plain", base("Users register."));
      writePlain(dir, "top.plain", top("The home page says hello."));
      scenariosIn("users-register", "base");
      const code = runner();
      const tests = conformanceRunner();
      tests.gate.pass = false;
      const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, run: code.run, runConformance: tests.runConformance });
      await loop.bringUp("top.plain");
      await loop.drain();
      expect(code.ran.map((job) => job.module)).toEqual(["base"]);
      const [below, above] = loop.status();
      expect(below!.why).toMatch(/did not pass/);
      expect(above!.why).toMatch(/^waiting for base: its conformance tests did not pass/);
    });

    it("refuse a functional spec with no scenarios, one the spec does not have, and a module none of whose has scenarios - and start nothing", async () => {
      writePlain(dir, "app.plain", app(["Say hello.", "Say goodbye."]));
      const code = runner();
      const tests = conformanceRunner();
      const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, run: code.run, runConformance: tests.runConformance });
      await expect(loop.conformance("app.plain")).rejects.toThrow(/^No functional spec of app has scenarios - none has a test plain file - so there is nothing to test: write the conformance or acceptance scenarios first/);
      scenariosIn("say-hello");
      await expect(loop.conformance("app.plain", { funcIds: ["app:say-goodbye"] })).rejects.toThrow(/^app:say-goodbye has no scenarios - no test plain file - so there is nothing to test: write the conformance or acceptance scenarios first, with change_plain.*Nothing was started\.$/);
      await expect(loop.conformance("app.plain", { funcIds: ["app:say-hello", "app:say-thanks"] })).rejects.toThrow("app has no functional spec app:say-thanks. Nothing was started.");
      expect(code.ran).toEqual([]);
      expect(tests.ran).toEqual([]);
    });

    it("of functional specs with scenarios are listed last as planned once the code is built - and conform with nothing to write says so", async () => {
      writePlain(dir, "app.plain", app(["Say hello.", "Say goodbye.", "Say thanks."]));
      for (const funcId of ["say-hello", "say-goodbye", "say-thanks"]) scenariosIn(funcId);
      const code = runner();
      const tests = conformanceRunner();
      const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, run: code.run, runConformance: tests.runConformance });
      code.holdNext();
      const [status] = await loop.bringUp("app.plain");
      expect(status!.planned.map((job) => `${job.track} ${job.title}`)).toEqual(["code Say goodbye.", "code Say thanks.", "conformance conformance tests"]);
      expect(describeModules([status!])).toContain("  3. conformance tests of app:say-hello, app:say-goodbye, app:say-thanks - planned once the code is built");
      // The regeneration numbers them among the code's pulses, by the functional specs they are for.
      expect(loop.mapPlan().codebases[0]!.pulses.map((pulse) => [pulse.number, pulse.track, pulse.specs])).toEqual([
        [1, "code", undefined],
        [2, "code", undefined],
        [3, "code", undefined],
        [4, "conformance", ["app:say-hello", "app:say-goodbye", "app:say-thanks"]],
      ]);
      code.gate.release!();
      await loop.drain();
      expect(tests.ran.map((job) => job.add)).toEqual([["say-hello", "say-goodbye", "say-thanks"]]);
      expect(loop.status()[0]!.planned).toEqual([]);
      const [again] = await loop.conformance("app.plain");
      expect(again!.conformanceNote).toBe("the conformance tests of app are written for every functional spec with scenarios, as built: there is nothing to write");
    });

    it("are written for every functional spec in one job - or one a functional spec when the person asked for that", async () => {
      writePlain(dir, "app.plain", app(["Say hello.", "Say goodbye.", "Say thanks."]));
      for (const funcId of ["say-hello", "say-goodbye", "say-thanks"]) scenariosIn(funcId);
      const code = runner();
      const tests = conformanceRunner();
      const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, run: code.run, runConformance: tests.runConformance });
      await loop.bringUp("app.plain");
      await loop.drain();
      expect(tests.ran.map((job) => job.add)).toEqual([["say-hello", "say-goodbye", "say-thanks"]]);

      writePlain(dir, "app.plain", app([["say-hello", "Say hello loudly."], ["say-goodbye", "Say goodbye loudly."], ["say-thanks", "Say thanks loudly."]]));
      await loop.bringUp("app.plain");
      await loop.conformance("app.plain", { separately: true });
      await loop.drain();
      expect(tests.ran.slice(1).map((job) => job.patch)).toEqual([["say-hello"], ["say-goodbye"], ["say-thanks"]]);
    });

    it("are planned with no agent asked - the code's work still is", async () => {
      writePlain(dir, "app.plain", app(["Say hello.", "Say goodbye.", "Say thanks."]));
      scenariosIn("say-hello");
      scenariosIn("say-goodbye");
      const code = runner();
      const tests = conformanceRunner();
      const asked: number[][] = [];
      const planner = { group: async (specs: Array<{ number: number }>) => (asked.push(specs.map((spec) => spec.number)), undefined), place: async () => undefined };
      const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner, run: code.run, runConformance: tests.runConformance });
      await loop.bringUp("app.plain");
      await loop.drain();
      expect(tests.ran.map((job) => job.add)).toEqual([["say-hello", "say-goodbye"]]);
      // Asked once, for the code's three new functional specs - never for the conformance tests.
      expect(asked).toEqual([[1, 2, 3]]);
    });

    it("show the work as being planned while the planner works - never nothing while nothing runs", async () => {
      writePlain(dir, "app.plain", app(["Say hello.", "Say goodbye."]));
      const code = runner();
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      const planner = { group: async () => (await held, undefined), place: async () => undefined };
      const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner, run: code.run });
      const brought = loop.bringUp("app.plain");
      await vi.waitFor(() => expect(loop.status()[0]?.planned[0]).toMatchObject({ planning: true, track: "code", title: "the work" }));
      expect(loop.planned()[0]!.note).toMatch(/^Being planned into pulses now/);
      release();
      await brought;
      await loop.drain();
      expect(loop.status()[0]!.planned).toEqual([]);
    });

    describe("kept up to date as the code changes", () => {
      /** Each conformance pulse, by what it does to each functional spec. */
      const pulses: Array<{ add: string[]; patch: string[]; again: string[]; delete: string[] }> = [];
      const funcIds = (specs: Array<{ funcId: string }>) => specs.map((spec) => spec.funcId);
      /** When set, a conformance pulse passes on the tests as they are: it records them, and writes no test file. */
      let asTheyAre = false;

      /** The module built from `specs`, with scenarios - and so conformance tests - for `tested` alone, and its loop. */
      async function builtWithTests(specs: Spec[], tested: string[]) {
        pulses.length = 0;
        asTheyAre = false;
        writePlain(dir, "app.plain", app(specs));
        for (const funcId of tested) scenariosIn(funcId);
        const code = runner();
        const tests = conformanceRunner();
        const loop = createWorkLoop({
          registry: createJobRegistry(),
          cwd: dir,
          planner: false,
          run: code.run,
          runConformance: async (job, onDelta) => {
            const cases = job.planned.cases;
            pulses.push({ add: funcIds(cases.add), patch: funcIds(cases.patch), again: funcIds(cases.again), delete: funcIds(cases.delete) });
            if (!asTheyAre) return tests.runConformance(job, onDelta);
            writeTestsRecord(testsDir(), job.planned.step.tree);
            recordHistory(job.buildDir, `conformance: ${job.planned.title}`);
            return { landed: true, report: "passed" };
          },
        });
        await loop.bringUp("app.plain");
        await loop.drain();
        // Building it wrote the tests of those with scenarios, in one pulse - none at all for a module with none.
        expect(pulses).toEqual(tested.length > 0 ? [{ add: tested, patch: [], again: [], delete: [] }] : []);
        pulses.length = 0;
        return { loop, code, tests };
      }
      const testedIds = () => ((readRecord(testsDir())?.["functional specs"] as Array<{ id: string }> | undefined) ?? []).map((item) => item.id);
      const marked = () => JSON.stringify(readRecord(testsDir()) ?? {}).includes("regenerate_again");

      it("keeps the tests of a functional spec regenerated again up to date - a conformance pulse for it alone", async () => {
        const { loop } = await builtWithTests(["Say hello.", "Say goodbye."], ["say-hello", "say-goodbye"]);
        await loop.regenerateAgain("app.plain", ["app:say-hello"]);
        expect(marked()).toBe(true);
        await loop.drain();
        expect(pulses).toEqual([{ add: [], patch: [], again: ["say-hello"], delete: [] }]);
        expect(marked()).toBe(false);
      });

      it("keeps the tests of a functional spec whose text changed up to date - a conformance pulse for it alone", async () => {
        const { loop } = await builtWithTests(["Say hello.", "Say goodbye."], ["say-hello", "say-goodbye"]);
        writePlain(dir, "app.plain", app([["say-hello", "Say hello loudly."], "Say goodbye."]));
        await loop.bringUp("app.plain", { specChange: true });
        await loop.drain();
        expect(pulses).toEqual([{ add: [], patch: ["say-hello"], again: [], delete: [] }]);
        expect(JSON.stringify(readRecord(testsDir()))).toContain("Say hello loudly.");
      });

      it("writes no tests for a functional spec that has no scenarios, though another of the module has", async () => {
        const { loop } = await builtWithTests(["Say hello.", "Say goodbye."], ["say-goodbye"]);
        await loop.regenerateAgain("app.plain", ["app:say-hello"]);
        await loop.drain();
        expect(pulses).toEqual([]);
        expect(testedIds()).toEqual(["say-goodbye"]);
        expect(describeDrift(await loop.drift("app.plain"))).not.toContain("to write or change");
      });

      it("brings a conformance pulse for the tested functional spec of a code pulse alone - none for the untested one beside it", async () => {
        const { loop } = await builtWithTests(["Say hello.", "Say goodbye.", "Say thanks."], ["say-hello"]);
        writePlain(dir, "app.plain", app([["say-hello", "Say hello loudly."], "Say goodbye.", ["say-thanks", "Say thanks warmly."]]));
        await loop.bringUp("app.plain", { specChange: true });
        await loop.drain();
        expect(pulses).toEqual([{ add: [], patch: ["say-hello"], again: [], delete: [] }]);
        expect(testedIds()).toEqual(["say-hello"]);
      });

      it("starts no conformance pulse in a module with no scenarios", async () => {
        const { loop } = await builtWithTests(["Say hello.", "Say goodbye."], []);
        await loop.regenerateAgain("app.plain", ["app:say-hello"]);
        writePlain(dir, "app.plain", app([["say-hello", "Say hello loudly."], "Say goodbye."]));
        await loop.bringUp("app.plain", { specChange: true });
        await loop.drain();
        expect(pulses).toEqual([]);
        expect(existsSync(join(testsDir(), ".turri.json"))).toBe(false);
      });

      it("clears the mark of a functional spec regenerated again once its tests pass on the new code, no test file changed", async () => {
        const { loop } = await builtWithTests(["Say hello.", "Say goodbye."], ["say-hello"]);
        writeFileSync(join(testsDir(), "test_app.py"), "# conformance tests of app:say-hello\n");
        asTheyAre = true;
        await loop.regenerateAgain("app.plain", ["app:say-hello"]);
        await loop.drain();
        expect(pulses).toEqual([{ add: [], patch: [], again: ["say-hello"], delete: [] }]);
        expect(marked()).toBe(false);
        expect(readFileSync(join(testsDir(), "test_app.py"), "utf8")).toBe("# conformance tests of app:say-hello\n");
      });

      it("keeps the mark of a functional spec regenerated again while its tests fail on the new code - the pulse does not land", async () => {
        const { loop, tests } = await builtWithTests(["Say hello.", "Say goodbye."], ["say-hello"]);
        tests.gate.pass = false;
        await loop.regenerateAgain("app.plain", ["app:say-hello"]);
        await loop.drain();
        expect(pulses).toEqual([{ add: [], patch: [], again: ["say-hello"], delete: [] }]);
        expect(marked()).toBe(true);
        expect(describeDrift(await loop.drift("app.plain"))).toContain("conformance tests: to write or change");
      });
    });

    it("of a functional spec regenerated again by name are kept while it regenerates, then written again for the new code", async () => {
      writePlain(dir, "app.plain", app(["Say hello.", "Say goodbye."]));
      scenariosIn("say-hello");
      scenariosIn("say-goodbye");
      const code = runner();
      const tests = conformanceRunner();
      const order: string[] = [];
      const registry = createJobRegistry();
      const loop = createWorkLoop({
        registry,
        cwd: dir,
        planner: false,
        run: async (job, onDelta) => (order.push(`code ${job.planned.cases.again.map((spec) => spec.funcId).join(",")}`), code.run(job, onDelta)),
        runConformance: async (job, onDelta) => (
          order.push(`tests -${job.planned.cases.delete.map((spec) => spec.funcId).join(",")} again ${job.planned.cases.again.map((spec) => spec.funcId).join(",")}`),
          tests.runConformance(job, onDelta)
        ),
      });
      await loop.bringUp("app.plain");
      await loop.drain();
      order.length = 0;
      // Its spec did not change: named, it is regenerated again - its tests untouched while it does, and none taken out.
      // They were written against the code it replaced: marked with it, and written again once the new code lands.
      await loop.regenerateAgain("app.plain", ["app:say-hello"]);
      expect(JSON.stringify(readRecord(testsDir()))).toContain("regenerate_again");
      await loop.drain();
      expect(order).toEqual(["code say-hello", "tests - again say-hello"]);
      // A host is told which functional specs each pulse covers, and how: both pulses regenerate say-hello again.
      const pulses = registry.list().filter((job) => job.cases?.again.length).sort((a, b) => a.sequence - b.sequence);
      expect(pulses.map((job) => [job.kind, job.cases])).toEqual([
        ["regenerate", { add: [], patch: [], again: [{ module: "app", funcId: "say-hello" }], delete: [] }],
        ["conformance", { add: [], patch: [], again: [{ module: "app", funcId: "say-hello" }], delete: [] }],
      ]);
      expect(JSON.stringify(readRecord(testsDir()))).toContain("Say hello.");
      // Regenerated again, it is built and tested as the spec says it: the mark is gone from both records.
      expect(JSON.stringify(readRecord(codeDir()))).not.toContain("regenerate_again");
      expect(JSON.stringify(readRecord(testsDir()))).not.toContain("regenerate_again");
    });

    it("do not start when the code record does not have a functional spec they test, as they test it - checked as the job starts", async () => {
      writePlain(dir, "app.plain", app(["Say hello."]));
      const code = runner();
      const tests = conformanceRunner();
      const registry = createJobRegistry();
      const loop = createWorkLoop({ registry, cwd: dir, planner: false, run: code.run, runConformance: tests.runConformance });
      await loop.bringUp("app.plain");
      await loop.drain();
      // Something else holds the module's lanes, so the conformance job is planned now and starts later - by when the record says otherwise.
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      registry.start({ kind: "other", summary: "holds the module", lanes: moduleLanes(join(dir, "app.plain")), run: async () => (await held, { report: "" }) });
      // Its scenarios are written now: its tests are planned.
      scenariosIn("say-hello");
      await loop.conformance("app.plain", { funcIds: ["app:say-hello"] });
      // Built from other text since - committed, as a regenerate leaves it - and the code job that would catch it up does not land.
      const record = readRecord(codeDir())!;
      writeCodeRecord(codeDir(), { ...record, "functional specs": [{ id: "say-hello", markdown: "Say hi." }] } as typeof record);
      recordHistory(codeDir(), "built from other text");
      code.gate.land = false;
      release();
      await loop.drain();
      expect(tests.ran).toEqual([]);
      const refused = registry.list().find((job) => job.kind === "conformance")!;
      expect(refused.report).toMatch(/Not started: .*app:say-hello is not built - plain_modules\/app\/code\/\.turri\.json does not have it/);
    });

    it("halt on their own when they do not pass - the code goes on being built - until the spec or the code changes", async () => {
      writePlain(dir, "app.plain", app(["Say hello."]));
      scenariosIn("say-hello");
      const code = runner();
      const tests = conformanceRunner();
      tests.gate.pass = false;
      const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, run: code.run, runConformance: tests.runConformance });
      await loop.bringUp("app.plain");
      await loop.drain();
      expect(tests.ran).toHaveLength(1);
      expect(loop.status()[0]!.why).toMatch(/did not pass/);
      // The code goes on: a new functional spec is built, and - the code changed - its tests are tried again.
      tests.gate.pass = true;
      writePlain(dir, "app.plain", app(["Say hello.", "Say goodbye."]));
      scenariosIn("say-goodbye");
      await loop.bringUp("app.plain");
      await loop.drain();
      expect(code.ran).toHaveLength(2);
      expect(tests.ran.length).toBeGreaterThan(1);
      expect(JSON.stringify(readRecord(testsDir()))).toContain("Say goodbye.");
    });

    describe("of the functional specs of a module below, in the tip", () => {
      const tip = "---\nrequires:\n  - base\n---\n\n***implementation reqs***\n\n- :Implementation: is Python.\n\n***test reqs***\n\n- :ConformanceTests: use pytest.\n\n***functional specs***\n\n# home-page\nThe home page says hello.\n";

      it("are written and kept up to date in the tip's suite: a scenario of one changed, or one regenerated again, is a conformance pulse there", async () => {
        writePlain(dir, "base.plain", app(["Say hello."]));
        writePlain(dir, "top.plain", tip);
        scenariosIn("say-hello", "base");
        const code = runner();
        const tests = conformanceRunner();
        const pulses: Array<{ module: string; patch: string[]; again: string[] }> = [];
        const named = (specs: Array<{ module?: string; funcId: string }>) => specs.map((spec) => `${spec.module ?? "?"}:${spec.funcId}`);
        const loop = createWorkLoop({
          registry: createJobRegistry(),
          cwd: dir,
          planner: false,
          run: code.run,
          runConformance: async (job, onDelta) => {
            pulses.push({ module: job.moduleName, patch: named(job.planned.cases.patch), again: named(job.planned.cases.again) });
            return tests.runConformance(job, onDelta);
          },
        });
        await loop.bringUp("top.plain");
        await loop.drain();
        // base's tests written in base, then carried up with its code - and what they are written for with them.
        expect(pulses.map((pulse) => pulse.module)).toEqual(["base"]);
        const inherited = () => JSON.stringify(readRecord(testsDir("top"))?.["required functional specs"] ?? []);
        expect(inherited()).toContain("It works.");

        scenariosIn("say-hello", "base", "# works\nIt works, and says so.");
        await loop.bringUp("top.plain", { specChange: true });
        await loop.drain();
        expect(pulses.slice(1)).toEqual([{ module: "top", patch: ["base:say-hello"], again: [] }]);
        expect(inherited()).toContain("It works, and says so.");
        // base's own codebase, left behind, is not touched.
        expect(JSON.stringify(readRecord(testsDir("base")))).not.toContain("says so");

        await loop.regenerateAgain("base.plain", ["base:say-hello"]);
        expect(inherited()).toContain("regenerate_again");
        await loop.drain();
        expect(pulses.slice(2)).toEqual([{ module: "top", patch: [], again: ["base:say-hello"] }]);
        expect(inherited()).not.toContain("regenerate_again");
      });
    });

    describe("of a module another is built on", () => {
      const top = "---\nrequires:\n  - app\n---\n\n***implementation reqs***\n\n- :Implementation: is Python.\n\n***functional specs***\n\n# home-page\nThe home page says hello.\n";

      /** app built with no scenarios, and so no conformance tests - written later, once scenarios are. */
      async function builtBelow() {
        writePlain(dir, "app.plain", app(["Say hello.", "Say goodbye.", "Say thanks."]));
        writePlain(dir, "top.plain", top);
        const code = runner();
        const tests = conformanceRunner();
        const loop = () =>
          createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, run: code.run, runConformance: tests.runConformance });
        const first = loop();
        await first.bringUp("app.plain");
        await first.drain();
        return { code, tests, loop };
      }

      it("are written in its own codebase when the one built on it has only been started from its code - that one starts again from it once they pass", async () => {
        const { code, tests, loop } = await builtBelow();
        const before = code.ran.length;
        // A pulse of top's was started - its codebase seeded with app's code - and stopped: nothing of its own built.
        copyRequiredCode(codeDir("app"), codeDir("top"), "top", "app");
        scenariosIn("say-goodbye");
        scenariosIn("say-thanks");
        const work = loop();
        const statuses = await work.conformance("app.plain", { funcIds: ["app:say-goodbye", "app:say-thanks"] });
        expect(statuses.map((status) => status.module)).toEqual(["app"]);
        expect(readRecord(codeDir("top"))).toBeNull();
        await work.bringUp("top.plain");
        await work.drain();
        expect(tests.ran.map((job) => job.add)).toEqual([["say-goodbye", "say-thanks"]]);
        expect(JSON.stringify(readRecord(testsDir("app")))).toContain("Say thanks.");
        // Built on app once its tests passed, from app's code.
        expect(code.ran.slice(before).map((job) => job.module)).toEqual(["top"]);
        expect(JSON.stringify(readRecord(codeDir("top")))).toContain("The home page says hello.");
        expect(readFileSync(join(testsDir("top"), "test_app.py"), "utf8")).toContain("# conformance");
      });

      it("delete the codebase built on it when the one above has built code of its own - disposable, no history kept - and regenerate it after they pass", async () => {
        const { code, tests, loop } = await builtBelow();
        const work = loop();
        await work.bringUp("top.plain");
        await work.drain();
        const before = code.ran.length;
        scenariosIn("say-goodbye");
        scenariosIn("say-thanks");
        const statuses = await work.conformance("app.plain", { funcIds: ["app:say-goodbye", "app:say-thanks"] });
        expect(statuses.map((status) => status.module)).toEqual(["app"]);
        // Gone whole, its history with it.
        expect(existsSync(join(dir, "plain_modules", "top"))).toBe(false);
        await work.drain();
        expect(tests.ran.map((job) => job.add)).toEqual([["say-goodbye", "say-thanks"]]);
        expect(code.ran.slice(before).map((job) => job.module)).toEqual(["top"]);
        expect(JSON.stringify(readRecord(codeDir("top")))).toContain("The home page says hello.");
      });

      it("touch nothing built on it when they are written already", async () => {
        const { loop } = await builtBelow();
        scenariosIn("say-goodbye");
        const work = loop();
        await work.conformance("app.plain", { funcIds: ["app:say-goodbye"] });
        await work.drain();
        await work.bringUp("top.plain");
        await work.drain();
        await expect(work.conformance("app.plain", { funcIds: ["app:say-goodbye"] })).rejects.toThrow("app's conformance tests for app:say-goodbye are written already. Nothing was started.");
        expect(JSON.stringify(readRecord(codeDir("top")))).toContain("The home page says hello.");
      });

      it("of a module above the one being regenerated, are written once its code is built - the module below left as it is", async () => {
        writePlain(dir, "app.plain", app(["Say hello."]));
        writePlain(dir, "top.plain", top.replace("***functional specs***", "***test reqs***\n\n- :ConformanceTests: use pytest.\n\n***functional specs***"));
        scenariosIn("home-page", "top");
        const code = runner();
        const tests = conformanceRunner();
        const order: string[] = [];
        const work = createWorkLoop({
          registry: createJobRegistry(),
          cwd: dir,
          planner: false,
          run: async (job, onDelta) => (order.push(`code ${job.moduleName}`), code.run(job, onDelta)),
          runConformance: async (job, onDelta) => (order.push(`tests ${job.moduleName}`), tests.runConformance(job, onDelta)),
        });
        code.holdNext();
        await work.bringUp("top.plain");
        // app is being regenerated; top's tests are asked for now.
        const statuses = await work.conformance("top.plain", { funcIds: ["top:home-page"] });
        expect(statuses.map((status) => status.module)).toEqual(["app", "top"]);
        code.gate.release!();
        await work.drain();
        expect(order).toEqual(["code app", "code top", "tests top"]);
      });

      it("stop a pulse building the first code of the one above on it - that one starts again from it once they pass", async () => {
        const { code, tests, loop } = await builtBelow();
        const before = code.ran.length;
        const work = loop();
        // top's first pulse is running - its codebase seeded with app's code - when app's tests are asked for.
        code.holdNext();
        await work.bringUp("top.plain");
        await vi.waitFor(() => expect(work.status().find((module) => module.module === "top")?.running).toBeDefined());
        scenariosIn("say-goodbye");
        scenariosIn("say-thanks");
        const statuses = await work.conformance("app.plain", { funcIds: ["app:say-goodbye", "app:say-thanks"] });
        expect(statuses.map((status) => status.module)).toEqual(["app"]);
        code.gate.release!();
        await work.drain();
        // The stopped pulse landed nothing; app's tests were written; top was built again, from app's code and tests.
        expect(tests.ran.map((job) => job.add)).toEqual([["say-goodbye", "say-thanks"]]);
        expect(code.ran.slice(before).map((job) => job.module)).toEqual(["top", "top"]);
        expect(JSON.stringify(readRecord(codeDir("top")))).toContain("The home page says hello.");
        expect(readFileSync(join(testsDir("top"), "test_app.py"), "utf8")).toContain("# conformance");
      });

      it("stop a pulse building on it even under allow-to-stop-jobs: false - the person asked", async () => {
        writeFileSync(join(dir, "config.yaml"), "allow-to-stop-jobs: false\n");
        const { code, tests, loop } = await builtBelow();
        const work = loop();
        code.holdNext();
        await work.bringUp("top.plain");
        await vi.waitFor(() => expect(work.status().find((module) => module.module === "top")?.running).toBeDefined());
        scenariosIn("say-goodbye");
        await work.conformance("app.plain", { funcIds: ["app:say-goodbye"] });
        code.gate.release!();
        await work.drain();
        expect(tests.ran.map((job) => job.add)).toEqual([["say-goodbye"]]);
        expect(JSON.stringify(readRecord(codeDir("top")))).toContain("The home page says hello.");
      });
    });
  });
});

describe("a codebase built without a module it now requires", () => {
  it("is left as it is until starting it over is asked for - then its code goes, kept in its history, and the chain is built from the bottom", async () => {
    const { describeModules } = await import("../../src/regenerate/loop.ts");
    const { historyLog } = await import("../../src/regenerate/lineage.ts");
    const { existsSync } = await import("node:fs");
    writePlain(dir, "app.plain", app(["Say hello."]));
    const { ran, run } = runner();
    const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, run });
    await loop.bringUp("app.plain");
    await loop.drain();
    // Its spec is split: saying hello moves into a module app now requires.
    writePlain(dir, "greeting.plain", app(["Say hello."]));
    writePlain(dir, "app.plain", `---\nrequires:\n  - greeting\n---\n\n${app(["Say goodbye."])}`);

    const [status] = await loop.bringUp("app.plain");
    await loop.drain();
    expect(status).toMatchObject({ module: "app", startOver: { requires: ["greeting"], codebases: ["app"] } });
    expect(ran).toHaveLength(1);
    expect(existsSync(join(codeDir(), "app.py"))).toBe(true);
    // The chat is told to ask, and why; the command line, how.
    expect(describeModules([status!])).toContain("Ask the user whether to start app over, and say why: app was built without greeting");
    expect(describeModules([status!], { for: "command line" })).toContain("turri regenerate app.plain --start-over");

    await loop.startOver("app.plain");
    await loop.drain();
    expect(ran.slice(1).map((job) => job.module)).toEqual(["greeting", "app"]);
    expect(historyLog(codeDir())).toContain("start from scratch: it now requires greeting");
    expect(loop.status().find((entry) => entry.module === "app")).toMatchObject({ planned: [], why: "built from the ***plain as it is" });
  });

  it("is not started over when nothing has to be", async () => {
    writePlain(dir, "app.plain", app(["Say hello."]));
    const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, run: runner().run });
    await expect(loop.startOver("app.plain")).rejects.toThrow("Nothing of app has to be started over");
  });
});

describe("a module being planned", () => {
  it("is shown at once - the registry told as the plan begins and once it is made, the row saying since when", async () => {
    writePlain(dir, "app.plain", app(["Say hello."]));
    const registry = createJobRegistry();
    const seen: Array<Array<{ id: string; since?: number }>> = [];
    let loop: ReturnType<typeof createWorkLoop> | undefined;
    registry.notify = () => seen.push(loop!.planned().map((job) => ({ id: job.id, ...(job.planning !== undefined ? { since: job.planning.since } : {}) })));
    loop = createWorkLoop({ registry, cwd: dir, planner: false, run: runner().run });
    await loop.bringUp("app.plain");
    await loop.drain();
    // Asked for, it shows at once - before what is left is worked out - then as the planner plans it, then planned.
    expect(seen[0]).toEqual([{ id: "planned-app-preparing", since: expect.any(Number) }]);
    expect(seen).toContainEqual([{ id: "planned-app-1", since: expect.any(Number) }]);
    expect(seen.at(-1)!.some((row) => row.since !== undefined)).toBe(false);
  });

  it("is shown from the moment it is asked for from scratch, before its code is deleted, a frame given to draw it", async () => {
    const { existsSync } = await import("node:fs");
    writePlain(dir, "app.plain", app(["Say hello."]));
    const registry = createJobRegistry();
    const loop = createWorkLoop({ registry, cwd: dir, planner: false, run: runner().run });
    await loop.bringUp("app.plain");
    await loop.drain();
    const seen: Array<{ rows: string[]; built: boolean }> = [];
    registry.notify = () => seen.push({ rows: loop.planned().map((job) => job.id), built: existsSync(join(codeDir(), "app.py")) });
    const asked = loop.fromScratch("app.plain");
    // Told before anything is deleted - and the deletion waits a frame, the event loop free to draw it.
    expect(seen).toEqual([{ rows: ["planned-app-1"], built: true }]);
    expect(loop.planned()[0]!.planning).toEqual({ since: expect.any(Number) });
    // A host draws the plan from status(): its code being planned, the same from the moment it was asked for.
    expect(loop.status()).toEqual([expect.objectContaining({ module: "app", planned: [expect.objectContaining({ title: "the work", track: "code", planning: true })] })]);
    expect(existsSync(join(codeDir(), "app.py"))).toBe(true);
    await asked;
    await loop.drain();
    expect(loop.status()[0]!.planned.some((entry) => entry.planning === true)).toBe(false);
  });

  it("is in status() from the moment it is asked for though the loop holds nothing of it yet - turri just opened", async () => {
    writePlain(dir, "app.plain", app(["Say hello."]));
    const registry = createJobRegistry();
    const loop = createWorkLoop({ registry, cwd: dir, planner: false, run: runner().run });
    const statuses: unknown[] = [];
    registry.notify = () => statuses.push(loop.status());
    const asked = loop.bringUp("app.plain");
    expect(statuses[0]).toEqual([{ module: "app", plainFile: join(dir, "app.plain"), planned: [{ title: "the work", cases: expect.any(Object), track: "code", planning: true }] }]);
    expect(loop.planned().map((job) => job.id)).toEqual(["planned-app-preparing"]);
    await asked;
    await loop.drain();
    expect(loop.status().filter((status) => status.module === "app")).toHaveLength(1);
  });

  it("is looked at quietly when only its spec changed - no row before the plan", async () => {
    writePlain(dir, "app.plain", app(["Say hello."]));
    const registry = createJobRegistry();
    const seen: string[][] = [];
    const loop = createWorkLoop({ registry, cwd: dir, planner: false, run: runner().run });
    registry.notify = () => seen.push(loop.planned().map((job) => job.id));
    await loop.bringUp("app.plain", { specChange: true });
    await loop.drain();
    expect(seen.flat()).not.toContain("planned-app-preparing");
  });
});

describe("a module regenerated from scratch", () => {
  it("has its code taken out, kept in its history, and all of it regenerated from its spec - built though nothing changed", async () => {
    const { historyLog } = await import("../../src/regenerate/lineage.ts");
    const { existsSync } = await import("node:fs");
    writePlain(dir, "app.plain", app(["Say hello.", "Say goodbye."]));
    const { ran, run } = runner();
    const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, run });
    await loop.bringUp("app.plain");
    await loop.drain();
    expect(ran).toHaveLength(2);
    // Built from the spec as it is: asked again, nothing regenerates.
    await loop.bringUp("app.plain");
    await loop.drain();
    expect(ran).toHaveLength(2);

    await loop.fromScratch("app.plain");
    await loop.drain();
    expect(ran).toHaveLength(4);
    expect(historyLog(codeDir())).toContain("start from scratch: asked to be regenerated from scratch");
    expect(existsSync(join(codeDir(), "app.py"))).toBe(true);
    expect(loop.status().find((entry) => entry.module === "app")).toMatchObject({ planned: [], why: "built from the ***plain as it is" });
  });

  it("leaves the modules below it as they are - the module starts again from a copy of the code below it", async () => {
    writePlain(dir, "greeting.plain", app(["Say hello."]));
    writePlain(dir, "app.plain", `---\nrequires:\n  - greeting\n---\n\n${app(["Say goodbye."])}`);
    const { ran, run } = runner();
    const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, run });
    await loop.bringUp("app.plain");
    await loop.drain();
    expect(ran.map((job) => job.module)).toEqual(["greeting", "app"]);

    await loop.fromScratch("app.plain");
    await loop.drain();
    expect(ran.slice(2).map((job) => job.module)).toEqual(["app"]);
  });

  it("with its whole chain, takes every codebase of the chain back to nothing and builds all of it again from the bottom", async () => {
    const { historyLog } = await import("../../src/regenerate/lineage.ts");
    writePlain(dir, "greeting.plain", app(["Say hello."]));
    writePlain(dir, "app.plain", `---\nrequires:\n  - greeting\n---\n\n${app(["Say goodbye."])}`);
    const { ran, run } = runner();
    const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, run });
    await loop.bringUp("app.plain");
    await loop.drain();

    await loop.fromScratch("app.plain", { chain: true });
    await loop.drain();
    expect(ran.slice(2).map((job) => job.module)).toEqual(["greeting", "app"]);
    for (const module of ["greeting", "app"]) expect(historyLog(codeDir(module))).toContain("start from scratch: asked to be regenerated from scratch, with its whole chain");
    expect(loop.status().find((entry) => entry.module === "app")).toMatchObject({ planned: [], why: "built from the ***plain as it is" });
  });

  it("builds a module never built, as regenerate does", async () => {
    writePlain(dir, "app.plain", app(["Say hello."]));
    const { ran, run } = runner();
    const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, run });
    await loop.fromScratch("app.plain");
    await loop.drain();
    expect(ran).toHaveLength(1);
  });
});

describe("a preview of the next job", () => {
  it("plans on a loop of its own and starts nothing - the job each codebase would start, with its coding agent's prompt - and copies nothing up", async () => {
    const { previewJobs } = await import("../../src/regenerate/loop.ts");
    const { existsSync } = await import("node:fs");
    const { writeTestScripts } = await import("../test-scripts.ts");
    writeTestScripts(dir);
    writePlain(dir, "app.plain", app(["Say hello."]));
    const { run } = runner();
    const real = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, run });
    await real.bringUp("app.plain");
    await real.drain();
    // A module on top of it, not started: a dry run reads what it would start from, and writes nothing.
    writePlain(dir, "greet.plain", `---\nrequires:\n  - app\n---\n\n${app(["Say goodbye."])}`);

    const { previews, busy } = await previewJobs({ plainFile: join(dir, "greet.plain"), cwd: dir, plannerModel: undefined });
    expect(busy).toEqual([]);
    expect(previews).toHaveLength(1);
    expect(previews[0]).toMatchObject({ module: "greet", track: "code" });
    expect(previews[0]!.task).toContain("Say goodbye.");
    // What it starts from is app's code, as it would be copied up.
    expect(previews[0]!.task).toContain('<functionality module="app" id="say-hello" status="implemented">');
    expect(existsSync(join(dir, "plain_modules", "greet"))).toBe(false);
  });

  it("leaves out a codebase with a job running: its next job depends on what that one lands", async () => {
    const { previewJobs } = await import("../../src/regenerate/loop.ts");
    const { writeTestScripts } = await import("../test-scripts.ts");
    writeTestScripts(dir);
    writePlain(dir, "app.plain", app(["Say hello."]));
    const { previews, busy } = await previewJobs({ plainFile: join(dir, "app.plain"), cwd: dir, busy: (module) => module === "app" });
    expect(previews).toEqual([]);
    expect(busy).toEqual(["app"]);
  });
});

describe("a linked resource", () => {
  const spec = () =>
    "***definitions***\n\n- :Api: is the API the app calls, defined by [api.yaml](api.yaml).\n\n" +
    "***implementation reqs***\n\n- :Implementation: is Python.\n\n***functional specs***\n\n# call-api\nCall :Api: for the users.\n\n# say-hello\nSay hello.\n";

  it("is hashed in the record, on its own: a change to what it holds patches the functional specs using what links it - the job's diff and the agent's change say so", async () => {
    writeFileSync(join(dir, "api.yaml"), "paths:\n  /users: {}\n");
    writePlain(dir, "app.plain", spec());
    const code = runner();
    const jobs: Array<{ textDiff: string; changes: string }> = [];
    const { describeSpecChange } = await import("../../src/regenerate/prompt.ts");
    const loop = createWorkLoop({
      registry: createJobRegistry(),
      cwd: dir,
      planner: false,
      run: async (job, onDelta) => (jobs.push({ textDiff: job.planned.step.textDiff, changes: describeSpecChange(job.planned.step.changes) }), code.run(job, onDelta)),
    });
    await loop.bringUp("app.plain");
    await loop.drain();
    expect(JSON.stringify(readRecord(codeDir()))).toMatch(/"target":"api.yaml","digest":"[0-9a-f]{64}"|"digest":"[0-9a-f]{64}"[^}]*"target":"api.yaml"/);
    const built = code.ran.length;

    // Nothing in the .plain file changes: only what the file it links holds.
    writeFileSync(join(dir, "api.yaml"), "paths:\n  /v2/users: {}\n");
    await loop.bringUp("app.plain");
    await loop.drain();
    expect(code.ran.slice(built)).toEqual([expect.objectContaining({ add: [], patch: ["call-api"] })]);
    const job = jobs.at(-1)!;
    expect(job.textDiff).toContain("diff --git a/api.yaml b/api.yaml");
    expect(job.textDiff).toMatch(/\+api\.yaml, linked by :Api: in app\.plain: its content changed, sha256 [0-9a-f]{64}/);
    expect(job.changes).toContain("its text is as it was:");
    expect(job.changes).toContain("what api.yaml holds changed - it is in <linked resources> as it is now");
  });

  it("in a record written before resources were hashed, is taken as its file is now - hashed and committed, nothing built again", async () => {
    writeFileSync(join(dir, "api.yaml"), "paths:\n  /users: {}\n");
    writePlain(dir, "app.plain", spec());
    const code = runner();
    const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, run: code.run });
    await loop.bringUp("app.plain");
    await loop.drain();
    // As an earlier turri wrote it: the links without their hashes.
    const record = readRecord(codeDir())!;
    writeCodeRecord(codeDir(), JSON.parse(JSON.stringify(record), (key, value) => (key === "digest" ? undefined : value)));
    recordHistory(codeDir(), "an older record");
    expect(JSON.stringify(readRecord(codeDir()))).not.toContain("digest");
    const built = code.ran.length;
    await loop.bringUp("app.plain");
    await loop.drain();
    expect(code.ran).toHaveLength(built);
    expect(JSON.stringify(readRecord(codeDir()))).toContain("digest");
  });
});

describe("drift", () => {
  it("says what is left to regenerate - in the code and its conformance tests - planning and starting nothing", async () => {
    writePlain(dir, "app.plain", app(["Say hello.", "Say goodbye."]));
    const code = runner();
    const registry = createJobRegistry();
    const loop = createWorkLoop({ registry, cwd: dir, planner: false, run: code.run });
    const { describeDrift } = await import("../../src/regenerate/loop.ts");
    // Nothing regenerated: all of it.
    const fresh = loop.drift("app.plain");
    expect(fresh[0]!.code).toMatchObject({ add: [{ funcId: "say-hello" }, { funcId: "say-goodbye" }] });
    expect(describeDrift(fresh)).toMatch(/code: drifted from the spec - to regenerate: sets the project up, adds app:say-hello, app:say-goodbye/);
    expect(registry.list()).toEqual([]);
    expect(code.ran).toEqual([]);
    await loop.bringUp("app.plain");
    await loop.drain();
    expect(describeDrift(loop.drift("app.plain"))).toContain("code: regenerated from the spec as it is - no drift");
    // The spec changes: the drift is the change, and nothing starts until regenerate.
    writePlain(dir, "app.plain", app([["say-hello", "Say hello loudly."], "Say goodbye."]));
    const ran = code.ran.length;
    expect(describeDrift(loop.drift("app.plain"))).toContain("to regenerate: changes app:say-hello");
    expect(code.ran).toHaveLength(ran);
  });
});

const base = "***implementation reqs***\n\n- :Implementation: is Python.\n\n***functional specs***\n\n# register\nUsers register.\n";
const top = "---\nrequires:\n  - base\n---\n\n***implementation reqs***\n\n- :Implementation: is Python.\n\n***functional specs***\n\n# home-page\nThe home page says hello.\n";

describe("modules no longer brought up", () => {
  it("forgets a module whose .plain file is gone while it waits, rather than showing it waiting for good", async () => {
    writePlain(dir, "base.plain", base);
    writePlain(dir, "top.plain", top);
    const { ran, holdNext, gate, run } = runner();
    const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, run });
    holdNext();
    await loop.bringUp("top.plain");
    expect(loop.planned().map((job) => job.summary)).toEqual(["top.plain - waits for base"]);
    rmSync(join(dir, "top.plain"));
    gate.release!();
    await loop.drain();
    expect(loop.planned()).toEqual([]);
    expect(loop.status().map((module) => module.module)).toEqual(["base"]);
    expect(loop.mapPlan().codebases.map((codebase) => codebase.module)).toEqual(["base"]);
    expect(ran.map((job) => job.module)).toEqual(["base"]);
  });

  it("drops the plan of a codebase left behind once a module is built on it, rather than listing its pulses for good", async () => {
    writePlain(dir, "base.plain", base.replace("Users register.\n", "Users register.\n\n# log-in\nUsers log in.\n"));
    const { ran, holdNext, gate, run } = runner();
    const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, run });
    holdNext();
    await loop.bringUp("base.plain");
    expect(loop.planned().map((job) => job.id)).toEqual(["planned-base-1"]);
    // Meanwhile a module is built on it: base's code is regenerated there from now on.
    writePlain(dir, "top.plain", top);
    mkdirSync(codeDir("top"), { recursive: true });
    writeFileSync(join(codeDir("top"), "top.py"), "# started\n");
    gate.release!();
    await loop.drain();
    // base's second functional spec is built in top, where base's code is regenerated now - not in base: added there, as
    // top's own is.
    expect(ran.map((job) => [job.module, job.add])).toEqual([
      ["base", ["register"]],
      ["top", ["log-in", "home-page"]],
    ]);
    expect(loop.planned()).toEqual([]);
    expect(loop.status().find((module) => module.module === "base")!.why).toMatch(/^left behind/);
  });

  it("shows nothing planned for a module whose spec stopped parsing, nor what it waited for", async () => {
    writePlain(dir, "base.plain", base);
    writePlain(dir, "top.plain", top);
    const { holdNext, gate, run } = runner();
    const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, run });
    holdNext();
    await loop.bringUp("top.plain");
    writePlain(dir, "top.plain", top.replace("  - base", "  - missing"));
    gate.release!();
    await loop.drain();
    expect(loop.planned()).toEqual([]);
  });
});

describe("halting a module's planned work", () => {
  it("halts the whole module by a planned row: its running pulse is stopped, none of its planned pulses start", async () => {
    writePlain(dir, "app.plain", app(["Say hello.", "Say goodbye.", "Count to ten."]));
    const { ran, holdNext, gate, run } = runner();
    const registry = createJobRegistry();
    const loop = createWorkLoop({ registry, cwd: dir, planner: false, run });
    holdNext();
    await loop.bringUp("app.plain");
    const running = loop.status()[0]!.running!.jobId;
    expect(loop.planned().map((job) => job.id)).toEqual(["planned-app-1", "planned-app-2"]);
    const said = loop.halt("planned-app-2", "the goodbye is being rethought");
    expect(said).toContain("Halted app (the goodbye is being rethought)");
    expect(said).toContain(`its running pulse ${running} is being stopped`);
    expect(said).toContain("its 2 planned pulses will not start");
    // Its agent stops once it is told to.
    gate.release!();
    await loop.drain();
    expect(ran).toHaveLength(1);
    expect(registry.get(running)!.status).toBe("stopped");
    expect(loop.planned()).toEqual([]);
    expect(loop.status()[0]!.why).toBe("you halted it (the goodbye is being rethought) - nothing runs here until it is asked for again");
  });

  it("keeps a module the person halted halted through a spec change, and runs it again once it is asked for", async () => {
    writePlain(dir, "app.plain", app(["Say hello."]));
    const { ran, run } = runner();
    const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, run });
    expect(loop.halt("app")).toBeUndefined();
    await loop.bringUp("app.plain");
    await loop.drain();
    writePlain(dir, "app.plain", app(["Say hello.", "Say goodbye."]));
    loop.halt("app");
    await loop.bringUp("app.plain", { specChange: true });
    await loop.drain();
    expect(ran).toHaveLength(1);
    expect(loop.status()[0]!.why).toMatch(/^you halted it/);
    await loop.bringUp("app.plain");
    await loop.drain();
    expect(ran.map((job) => job.add)).toEqual([["say-hello"], ["say-goodbye"]]);
  });

  it("has the modules built on a halted module wait for it, and says which", async () => {
    writePlain(dir, "base.plain", base);
    writePlain(dir, "top.plain", top);
    const { ran, holdNext, gate, run } = runner();
    const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, run });
    holdNext();
    await loop.bringUp("top.plain");
    expect(loop.halt("base")).toContain("top waits for it");
    gate.release!();
    await loop.drain();
    expect(ran.map((job) => job.module)).toEqual(["base"]);
    expect(loop.status().map((module) => [module.module, module.why])).toEqual([
      ["base", "you halted it - nothing runs here until it is asked for again"],
      ["top", "waiting for base: you halted it - nothing is built on it until it is asked for again"],
    ]);
  });

  it("drops a module whose .plain file is gone when its waiting row is halted", async () => {
    writePlain(dir, "base.plain", base);
    writePlain(dir, "top.plain", top);
    const { holdNext, gate, run } = runner();
    const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, run });
    holdNext();
    await loop.bringUp("top.plain");
    rmSync(join(dir, "top.plain"));
    expect(loop.halt("planned-top-waiting")).toBe("top is no longer in the project - top.plain is gone - so nothing was to be built there: it is dropped from the regeneration.");
    expect(loop.planned()).toEqual([]);
    gate.release!();
    await loop.drain();
  });
});

describe("the review of a pulse", () => {
  const spec = (funcId: string) => ({ funcId, text: `Spec ${funcId}.` });
  const cases = (over: Partial<JobCases>): JobCases => ({ fresh: false, add: [], patch: [], again: [], delete: [], mechanical: false, ...over });

  it("is skipped for a module's first pulse that builds one functional spec - the project set up and the smallest thing that runs", () => {
    expect(skipsReview(cases({ fresh: true, add: [spec("say-hello")] }))).toBe(true);
  });

  it("is kept for a first pulse that builds more than one, and for every pulse after the first", () => {
    expect(skipsReview(cases({ fresh: true, add: [spec("say-hello"), spec("say-goodbye")] }))).toBe(false);
    expect(skipsReview(cases({ add: [spec("say-goodbye")] }))).toBe(false);
    expect(skipsReview(cases({ patch: [spec("say-hello")] }))).toBe(false);
  });
});
