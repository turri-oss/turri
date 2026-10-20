import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reportStage } from "../../src/regenerate/activity.ts";
import { createJobRegistry } from "../../src/regenerate/jobs.ts";
import { healing, ledgerDir, onLedgerEvent, readLedger, record, startLedger, stopLedger, tidy, type LedgerEntry } from "../../src/regenerate/ledger.ts";
import { describePulseView, earlierPulses, pulseView, runViews } from "../../src/regenerate/ledger-view.ts";
import { landWork, startWork } from "../../src/regenerate/lineage.ts";
import { forgetSecretsForTests, registerSecrets } from "../../src/regenerate/masking.ts";

let project: string;

beforeEach(() => {
  project = realpathSync(mkdtempSync(join(tmpdir(), "turri-ledger-")));
});
afterEach(() => {
  stopLedger();
  forgetSecretsForTests();
  rmSync(project, { recursive: true, force: true });
});

const kinds = (entries: LedgerEntry[]) => entries.map((entry) => entry.kind);

describe("the ledger", () => {
  it("writes each event a line, in order, opened by the run that wrote it and closed when it ends", () => {
    startLedger({ mode: "test", project });
    record({ kind: "job.stage", label: "writing code" });
    record({ kind: "script.run", script: "run_unittests.sh", exit: 1, ms: 1200, timedOut: false, inPlace: true, signature: "abc" });
    stopLedger();

    const entries = readLedger(project);
    expect(kinds(entries)).toEqual(["run.started", "job.stage", "script.run", "run.ended"]);
    expect(new Set(entries.map((entry) => entry.run)).size).toBe(1);
    expect(entries.map((entry) => entry.seq)).toEqual([...entries.map((entry) => entry.seq)].sort((a, b) => a - b));
    // A whole date, not the time of day alone.
    expect(entries[0]!.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(entries[0]).toMatchObject({ kind: "run.started", mode: "test", pid: process.pid });
  });

  it("writes nothing while it is off", () => {
    record({ kind: "job.stage", label: "unseen" });
    expect(existsSync(ledgerDir(project))).toBe(false);
  });

  it("writes nothing for a project that keeps none, and prunes what it kept", () => {
    mkdirSync(ledgerDir(project), { recursive: true });
    writeFileSync(join(ledgerDir(project), "2026-01-01T00-00-00-000Z-old-p999999.jsonl.gz"), gzipSync("{}\n"));
    writeFileSync(join(project, "config.turri.yaml"), "ledger-keep: 0\n");
    startLedger({ mode: "test", project });
    record({ kind: "job.stage", label: "unseen" });
    expect(readdirSync(ledgerDir(project))).toEqual([]);
  });

  it("records what a pulse does in its project, under its id and module, from queued to finished", async () => {
    startLedger({ mode: "test" });
    const registry = createJobRegistry();
    const job = registry.start({
      kind: "regenerate",
      summary: "app.plain",
      module: "app",
      pulse: 1,
      lanes: [join(project, "plain_modules", "app", "code")],
      run: async () => {
        reportStage("writing code and unit tests");
        record({ kind: "script.run", script: "run_unittests.sh", exit: 0, ms: 900, timedOut: false, inPlace: true });
        return { report: "done", details: { passed: true, landed: true } };
      },
    });
    await registry.wait(job.id);

    const own = readLedger(project, { job: job.id });
    expect(kinds(own)).toEqual(["job.queued", "job.started", "job.stage", "script.run", "job.finished"]);
    expect(own.every((entry) => entry.module === "app")).toBe(true);
    expect(own.at(-1)).toMatchObject({ kind: "job.finished", status: "succeeded", landed: true });
  });

  it("records a healer that fails, instead of letting it go unsaid", async () => {
    startLedger({ mode: "test", project });
    const found = await healing("debugger", async () => {
      throw new Error("No API key for provider: amazon-bedrock");
    });
    expect(found).toBeUndefined();
    expect(readLedger(project, { kinds: ["healer.started", "healer.failed"] })).toMatchObject([
      { kind: "healer.started", healer: "debugger" },
      { kind: "healer.failed", healer: "debugger", error: "No API key for provider: amazon-bedrock" },
    ]);
  });

  it("records a commit of landed work that fails - the loss it would have been says itself", () => {
    startLedger({ mode: "test" });
    const code = join(project, "plain_modules", "app", "code");
    mkdirSync(code, { recursive: true });
    writeFileSync(join(code, "app.py"), "print('before')\n");
    startWork([code], "app");
    writeFileSync(join(code, "app.py"), "print('landed')\n");
    writeFileSync(join(project, "plain_modules", "app", ".plaingit", "index.lock"), "");
    expect(() => landWork(code, "spec diff: landed")).toThrow();
    expect(readLedger(project, { kinds: ["history.failed"] })).toMatchObject([{ module: "app", landing: true, said: expect.stringContaining("index.lock") }]);
  });

  it("masks the values the agents are given, wherever an event carries them", () => {
    registerSecrets({ SERVICE_TOKEN: "s3cr3t-value-123" });
    startLedger({ mode: "test", project });
    record({ kind: "provider.error", error: "401 for token s3cr3t-value-123", transient: false });
    const text = readdirSync(ledgerDir(project)).map((name) => readFileSync(join(ledgerDir(project), name), "utf8")).join("");
    expect(text).not.toContain("s3cr3t-value-123");
    expect(text).toContain("[SERVICE_TOKEN]");
  });

  it("stops writing when it cannot, says so once, and never fails the work", () => {
    // Where its folder should be, a file: nothing can be made there.
    mkdirSync(join(project, ".turri"));
    writeFileSync(join(project, ".turri", "ledger"), "");
    const warnings: string[] = [];
    startLedger({ mode: "test", project, warn: (message) => warnings.push(message) });
    expect(() => {
      record({ kind: "job.stage", label: "one" });
      record({ kind: "job.stage", label: "two" });
    }).not.toThrow();
    expect(warnings).toHaveLength(1);
  });

  it("tells a listener each event as it is recorded, with its project - as it is written", () => {
    const heard: Array<{ kind: string; project: string }> = [];
    const stop = onLedgerEvent((entry, where) => heard.push({ kind: entry.kind, project: where }));
    startLedger({ mode: "test", project });
    record({ kind: "job.stage", label: "writing code" });
    stop();
    record({ kind: "job.stage", label: "not heard" });
    expect(heard).toEqual([{ kind: "run.started", project }, { kind: "job.stage", project }]);
    expect(kinds(readLedger(project))).toEqual(["run.started", "job.stage", "job.stage"]);
  });

  it("tells a listener what a project that keeps no ledger does, writing none of it", () => {
    writeFileSync(join(project, "config.turri.yaml"), "ledger-keep: 0\n");
    const heard: string[] = [];
    const stop = onLedgerEvent((entry) => heard.push(entry.kind));
    startLedger({ mode: "test", project });
    record({ kind: "job.stage", label: "heard, not written" });
    stop();
    expect(heard).toEqual(["run.started", "job.stage"]);
    expect(existsSync(ledgerDir(project))).toBe(false);
  });

  it("goes on past a listener that throws", () => {
    const stop = onLedgerEvent(() => {
      throw new Error("a window that went away");
    });
    startLedger({ mode: "test", project });
    expect(() => record({ kind: "job.stage", label: "still written" })).not.toThrow();
    stop();
    expect(kinds(readLedger(project))).toEqual(["run.started", "job.stage"]);
  });

  it("reads back gzipped runs and skips what it cannot read", () => {
    mkdirSync(ledgerDir(project), { recursive: true });
    const line = (entry: object) => `${JSON.stringify({ v: 1, ts: "2026-10-01T00:00:00.000Z", seq: 1, run: "old", ...entry })}\n`;
    writeFileSync(join(ledgerDir(project), "2026-10-01T00-00-00-000Z-old-p999999.jsonl.gz"), gzipSync(line({ kind: "job.stage", label: "earlier" }) + "not json\n" + line({ v: 9, kind: "future.kind" })));
    expect(readLedger(project)).toMatchObject([{ kind: "job.stage", label: "earlier", run: "old" }]);
  });
});

describe("keeping the ledger within its size", () => {
  const dir = () => ledgerDir(project);
  const file = (name: string, bytes: number) => writeFileSync(join(dir(), name), "x".repeat(bytes));

  it("gzips the runs that ended, and prunes the oldest past the cap - never a run still going", () => {
    mkdirSync(dir(), { recursive: true });
    file("2026-01-01T00-00-00-000Z-aaaa-p999999.jsonl.gz", 600);
    file("2026-01-02T00-00-00-000Z-bbbb-p999998.jsonl", 600);
    file(`2026-01-03T00-00-00-000Z-cccc-p${process.pid}.jsonl`, 600);

    tidy(dir(), 1000);

    const names = readdirSync(dir()).sort();
    // The oldest went; the one that ended is gzipped; this process's own is as it was.
    expect(names).toEqual(["2026-01-02T00-00-00-000Z-bbbb-p999998.jsonl.gz", `2026-01-03T00-00-00-000Z-cccc-p${process.pid}.jsonl`]);
    expect(statSync(join(dir(), names[0]!)).size).toBeLessThan(600);
  });
});

describe("a pulse read back from the ledger", () => {
  it("says how it ended, its rounds, its runs, its healers and what turri refused", () => {
    const at = (seq: number, entry: object) => ({ v: 1, ts: "2026-10-19T22:00:00.000Z", seq, run: "r1", job: "a1b2c3d4", module: "backend", ...entry }) as LedgerEntry;
    const entries: LedgerEntry[] = [
      { v: 1, ts: "2026-10-19T22:00:00.000Z", seq: 0, run: "r1", kind: "run.started", mode: "regenerate", version: "0.1.1", commit: null, dirty: null, pid: 1, platform: "darwin", node: "22" },
      at(1, { kind: "job.queued", jobKind: "regenerate", summary: "backend.plain", pulse: 4, waitingOn: [] }),
      at(2, { kind: "job.started", waitedMs: 0, logFile: "/p/.turri/jobs/x.log" }),
      at(3, { kind: "script.run", script: "run_unittests.sh", exit: 1, ms: 1000, timedOut: false, inPlace: true, signature: "s1" }),
      at(4, { kind: "script.run", script: "run_unittests.sh", exit: 1, ms: 1000, timedOut: false, inPlace: true, signature: "s1" }),
      at(5, { kind: "gate.round", gate: "unit tests", round: 2, of: 20 }),
      at(6, { kind: "healer.failed", healer: "debugger", ms: 10, error: "No API key" }),
      at(7, { kind: "guard.refused", rule: "repeat", tool: "read", times: 4 }),
      at(8, { kind: "provider.error", error: "ExpiredTokenException", transient: false }),
      at(9, { kind: "job.finished", status: "failed", ms: 65_000, usage: { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, cost: 0.12 }, failedForGood: true, error: "Failed 2 times", logFile: "/p/.turri/jobs/x.log" }),
    ];
    const view = pulseView("a1b2", entries)!;
    const text = describePulseView(view);
    expect(text).toContain("a1b2c3d4 · backend · regenerate pulse 4");
    expect(text).toContain("failed, after 1m 5s");
    expect(text).toContain("rounds: unit tests 2 of 20");
    expect(text).toContain("test runs: 2, 2 failing - 2 of them the same way");
    expect(text).toContain("the debugger FAILED: No API key");
    expect(text).toContain("turri refused calls: repeat 1x");
    expect(text).toContain("ExpiredTokenException");
    expect(text).toContain("log: /p/.turri/jobs/x.log");
  });

  it("lists the project's runs the most recent first, each with its pulses", async () => {
    startLedger({ mode: "test", project });
    const registry = createJobRegistry();
    const job = registry.start({ kind: "regenerate", summary: "app.plain", module: "app", pulse: 1, lanes: [join(project, "plain_modules", "app", "code")], run: async () => ({ report: "done" }) });
    await registry.wait(job.id);
    stopLedger();
    startLedger({ mode: "test", project });
    record({ kind: "job.stage", label: "a run with no pulse" });
    stopLedger();

    const runs = runViews(project);
    expect(runs).toHaveLength(2);
    expect(runs[0]!.pulses).toEqual([]);
    expect(runs[1]!.pulses.map((pulse) => pulse.id)).toEqual([job.id]);
  });

  it("gives earlier sessions' pulses as jobs - not this run's, not one this session knows - the last runs, and how many more", async () => {
    const pulseIn = async (summary: string) => {
      const registry = createJobRegistry();
      const job = registry.start({ kind: "regenerate", summary, module: "app", pulse: 1, lanes: [join(project, "plain_modules", "app", "code")], run: async () => ({ report: "done", details: { passed: true, landed: true } }) });
      await registry.wait(job.id);
      return job.id;
    };
    const ids: string[] = [];
    for (const summary of ["first", "second", "third"]) {
      startLedger({ mode: "chat", project });
      ids.push(await pulseIn(summary));
      stopLedger();
    }
    // This session: one pulse of its own, and the third run's pulse known to it as if it had run it.
    startLedger({ mode: "chat", project });
    const own = await pulseIn("now");

    const found = earlierPulses([project], new Set([ids[2]!]), 1);
    expect(found.jobs.map((job) => job.id)).toEqual([ids[1]]);
    expect(found.more).toBe(1);
    expect(found.jobs.map((job) => job.id)).not.toContain(own);
    expect(found.jobs[0]).toMatchObject({ status: "succeeded", details: { landed: true }, module: "app", earlier: { lines: expect.any(Array) } });
  });
});
