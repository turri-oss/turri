import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reportStage } from "../src/regenerate/activity.ts";
import { createJobRegistry } from "../src/regenerate/jobs.ts";
import { healing, record, startLedger, stopLedger } from "../src/regenerate/ledger.ts";
import { describePastPulse, describeRuns, earlierPulses, ledgerProjects } from "../src/regenerate/ledger-view.ts";
import { reportsDir } from "../src/regenerate/failure-reports.ts";
import { forgetSecretsForTests, registerSecrets } from "../src/regenerate/masking.ts";

let project: string;
let pulse: string;

/** One pulse of backend, in a run of its own: two test runs failing the same way, a debugger with no key, a refusal. */
async function aRun() {
  startLedger({ mode: "chat", project });
  const registry = createJobRegistry();
  const job = registry.start({
    kind: "regenerate",
    summary: "backend.plain",
    module: "backend",
    pulse: 1,
    title: "messages",
    lanes: [join(project, "plain_modules", "backend", "code")],
    run: async () => {
      reportStage("writing code and unit tests");
      for (const round of [1, 2]) {
        record({ kind: "script.run", script: "run_unittests.sh", exit: 1, ms: 900, timedOut: false, inPlace: true, signature: "same" });
        record({ kind: "gate.round", gate: "unit tests", round, of: 20 });
      }
      await healing("debugger", async () => {
        throw new Error("No API key for provider: anthropic");
      });
      record({ kind: "guard.refused", rule: "repeat", tool: "read", times: 4 });
      return { report: "landed", details: { passed: true, landed: true } };
    },
  });
  await registry.wait(job.id);
  stopLedger();
  return job.id;
}

beforeEach(async () => {
  project = realpathSync(mkdtempSync(join(tmpdir(), "turri-ledger-tool-")));
  pulse = await aRun();
});
afterEach(() => {
  stopLedger();
  rmSync(project, { recursive: true, force: true });
});

describe("a pulse as the ledger tells it - pulses' answer for one of an earlier session", () => {
  it("is told as facts, by the start of its id - rounds, test runs, the healer that failed, what turri refused", () => {
    const text = describePastPulse(ledgerProjects(project), pulse.slice(0, 4))!;
    expect(text).toContain(`${pulse} · backend · regenerate pulse 1 - messages`);
    expect(text).toContain("succeeded, landed");
    expect(text).toContain("rounds: unit tests 2 of 20");
    expect(text).toContain("test runs: 2, 2 failing - 2 of them the same way");
    expect(text).toContain("the debugger FAILED: No API key for provider: anthropic");
    expect(text).toContain("turri refused calls: repeat 1x");
  });

  it("is nothing when the ledger has no such pulse", () => {
    expect(describePastPulse(ledgerProjects(project), "zzzz")).toBeUndefined();
  });
});

describe("earlier runs, as pulses lists them", () => {
  it("are the last runs asked for, a line a pulse, and how many more the ledger has", async () => {
    await aRun();
    const found = earlierPulses(ledgerProjects(project), new Set(), 1);
    expect(found.runs).toHaveLength(1);
    expect(found.more).toBe(1);
    const text = describeRuns(found.runs);
    expect(text).toMatch(/^run \w+ · chat · /);
    expect(text).toContain("backend · regenerate pulse 1");
  });

  it("are none where nothing has run", () => {
    const empty = realpathSync(mkdtempSync(join(tmpdir(), "turri-no-ledger-")));
    try {
      expect(earlierPulses(ledgerProjects(empty), new Set()).runs).toEqual([]);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("why a pulse did not land, kept past its session", () => {
  /** One pulse of backend that fails, its unit tests failing on a stack trace, in a run of its own. */
  async function aFailingRun(error = "unit tests still failing after 20 rounds") {
    startLedger({ mode: "chat", project });
    const registry = createJobRegistry();
    const job = registry.start({
      kind: "regenerate",
      summary: "backend.plain",
      module: "backend",
      pulse: 2,
      title: "invoices",
      lanes: [join(project, "plain_modules", "backend", "code")],
      run: async () => {
        reportStage("unit tests failing: TypeError: cannot read 'total' of undefined");
        throw new Error(error);
      },
    });
    await registry.wait(job.id);
    stopLedger();
    return job.id;
  }

  it("is written as it ends, outside debug mode, and told with the pulse in a later session", async () => {
    const failed = await aFailingRun();
    const report = readFileSync(join(reportsDir(project), `${failed}.md`), "utf8");
    expect(report).toContain("unit tests still failing after 20 rounds");
    expect(report).toContain("TypeError: cannot read 'total' of undefined");
    const told = describePastPulse(ledgerProjects(project), failed)!;
    expect(told).toContain("Why it did not land, as kept when it ended:");
    expect(told).toContain("TypeError: cannot read 'total' of undefined");
  });

  it("is not written for a pulse that landed", () => {
    expect(existsSync(join(reportsDir(project), `${pulse}.md`))).toBe(false);
    expect(describePastPulse(ledgerProjects(project), pulse)).not.toContain("Why it did not land");
  });

  it("is not written for a pulse that was stopped - halted, or its ***plain moved on", async () => {
    startLedger({ mode: "chat", project });
    const registry = createJobRegistry();
    const job = registry.start({ kind: "regenerate", summary: "backend.plain", module: "backend", pulse: 3, lanes: [join(project, "plain_modules", "backend", "code")], run: async () => ({ report: "", details: { landed: false } }) });
    registry.stop(job.id);
    await registry.wait(job.id);
    stopLedger();
    expect(registry.get(job.id)!.status).toBe("stopped");
    expect(existsSync(join(reportsDir(project), `${job.id}.md`))).toBe(false);
  });

  it("is not written where the project keeps no ledger", async () => {
    writeFileSync(join(project, "config.turri.yaml"), "ledger-keep: 0\n");
    const failed = await aFailingRun();
    expect(existsSync(join(reportsDir(project), `${failed}.md`))).toBe(false);
  });

  it("masks a credential the project passes its agents, as the logs do", async () => {
    registerSecrets({ D365_CLIENT_SECRET: "s3cr3t-value-123" });
    try {
      const failed = await aFailingRun("auth failed with s3cr3t-value-123");
      const report = readFileSync(join(reportsDir(project), `${failed}.md`), "utf8");
      expect(report).not.toContain("s3cr3t-value-123");
      expect(report).toContain("auth failed with [D365_CLIENT_SECRET]");
    } finally {
      forgetSecretsForTests();
    }
  });
});
