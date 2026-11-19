import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writePlain } from "./test-plain.ts";
import { lastCommit, recordHistory } from "../src/regenerate/lineage.ts";
import type { Job, JobRegistry, PulseCases } from "../src/regenerate/jobs.ts";

/** The launches the agent was given, held until the test lets each go. */
const held: Array<() => void> = [];
vi.mock("../src/launch-agent.ts", () => ({
  runLaunchAgent: () => new Promise((resolve) => held.push(() => resolve({ launched: true, summary: "runs" }))),
}));

const { createSessionLaunches } = await import("../src/launch-session.ts");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "turri-launch-session-"));
  writeFileSync(join(dir, "config.turri.yaml"), "module: app.plain\nlaunch-after-pulse: true\n");
  writePlain(dir, "app.plain", "***implementation reqs***\n\n- Python.\n\n***functional specs***\n\n# greet\napp greets.\n");
  held.length = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const code = () => join(dir, "plain_modules", "app", "code");
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

/** A pulse that landed: a commit of its own, its functional specs by case. */
function landed(id: string, sequence: number, patch: string[]): { job: Job; commit: string } {
  mkdirSync(code(), { recursive: true });
  writeFileSync(join(code(), "app.py"), `# ${id}\n`, { flag: "a" });
  recordHistory(code(), id);
  const cases: PulseCases = { add: [], patch: patch.map((funcId) => ({ module: "app", funcId })), again: [], delete: [] };
  const job = { id, sequence, status: "succeeded", module: "app", details: { landed: true }, cases } as unknown as Job;
  return { job, commit: lastCommit(code())! };
}

describe("what the sentinel is told runs for a pulse", () => {
  it("names the launch that holds it, the pulses after it that launch holds too, and what of its own they changed again", async () => {
    const jobs: Job[] = [];
    const launches = createSessionLaunches({ cwd: dir, jobs: { list: () => jobs } as unknown as JobRegistry, model: () => undefined, onChange: () => {} });
    const tell = (pulse: { job: Job; commit: string }) => {
      jobs.push(pulse.job);
      launches.landed({ job: pulse.job, plainFile: join(dir, "app.plain"), moduleName: "app", commit: pulse.commit, title: pulse.job.id });
    };
    const first = landed("p1", 1, ["greet", "wave"]);
    tell(first);
    const second = landed("p2", 2, ["greet"]);
    tell(second);
    const third = landed("p3", 3, ["bow"]);
    tell(third);
    // p1's launch runs; p2's waited, and p3's took its place.
    let ready = false;
    void launches.readyFor(first.job).then(() => (ready = true));
    await settle();
    held.shift()!();
    await settle();
    expect(ready).toBe(false);
    held.shift()!();
    await settle();
    expect(ready).toBe(true);
    expect(held).toHaveLength(0);

    const told = launches.forPulse(first.job);
    expect(told.launch?.commit).toBe(third.commit);
    expect(told.later.map((job) => job.id)).toEqual(["p2", "p3"]);
    expect(told.laterSpecs).toEqual([{ module: "app", funcId: "greet" }]);
    expect(launches.forPulse(third.job).later).toEqual([]);
    // What runs holds the first pulse's commit: carried on after a pause, it is told so.
    expect(launches.resumeText({ job: first.job })).toContain(`It still holds pulse p1's commit, ${first.commit.slice(0, 7)}.`);
  });

  it("says launch-after-pulse was off, and waits for nothing, for a pulse of a project that does not launch", async () => {
    writeFileSync(join(dir, "config.turri.yaml"), "module: app.plain\n");
    const launches = createSessionLaunches({ cwd: dir, jobs: { list: () => [] } as unknown as JobRegistry, model: () => undefined, onChange: () => {} });
    const pulse = landed("p1", 1, ["greet"]);
    launches.landed({ job: pulse.job, plainFile: join(dir, "app.plain"), moduleName: "app", commit: pulse.commit, title: "p1" });
    await launches.readyFor(pulse.job);
    expect(held).toHaveLength(0);
    expect(launches.forPulse(pulse.job)).toMatchObject({ off: true, commit: pulse.commit });
  });
});

describe("what a host's check is tested in", () => {
  it("refuses a check once what the module's launch started was halted - nothing launched to test it in - and launches the module anew after", async () => {
    const launches = createSessionLaunches({ cwd: dir, jobs: { list: () => [] } as unknown as JobRegistry, model: () => undefined, onChange: () => {} });
    const pulse = landed("p1", 1, ["greet"]);
    launches.landed({ job: pulse.job, plainFile: join(dir, "app.plain"), moduleName: "app", commit: pulse.commit, title: "p1" });
    await settle();
    held.shift()!();
    await launches.settled("app");
    const check = { id: "c1", module: "app", funcIds: ["app:greet"] } as never;
    await expect(launches.readyForCheck(check)).resolves.toBeUndefined();

    // As /halt launched does once the servers are stopped: nothing of the launch runs.
    expect(launches.track.halted("app")).toEqual(["launch-1"]);

    await expect(launches.readyForCheck(check)).rejects.toThrow("nothing of app is launched to test it in - ask the chat to try it first, which launches it.");
    expect(launches.track.request({ plainFile: join(dir, "app.plain"), cause: {} }).already).toBe(false);
  });
});

describe("the chat's launch tool", () => {
  it("tells the chat that asked when a newer launch takes its place, and the newer one's end - never that its own is up", async () => {
    const { launchTool } = await import("../src/launch-tools.ts");
    const launches = createSessionLaunches({ cwd: dir, jobs: { list: () => [] } as unknown as JobRegistry, model: () => undefined, onChange: () => {} });
    landed("p0", 0, ["greet"]);
    const heard: string[] = [];
    const tool = launchTool({
      cwd: dir,
      track: launches.track,
      defaultPlainFile: () => "app.plain",
      chat: () => "c1",
      ended: (launch) => heard.push(`ended ${launch.id} ${launch.status}`),
      replaced: (launch, next) => heard.push(`replaced ${launch.id} by ${next.id}`),
    });
    await tool.execute("call-1", {}, undefined, undefined, undefined as never);
    // A pulse lands while the chat's launch runs: its launch waits.
    const pulse = landed("p1", 1, ["greet"]);
    launches.landed({ job: pulse.job, plainFile: join(dir, "app.plain"), moduleName: "app", commit: pulse.commit, title: "p1" });
    await settle();
    held.shift()!();
    await settle();
    expect(heard).toEqual(["replaced launch-1 by launch-2"]);
    held.shift()!();
    await launches.settled("app");
    await settle();
    expect(heard).toEqual(["replaced launch-1 by launch-2", "ended launch-2 launched"]);
  });
});
