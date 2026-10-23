import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ledgerTool } from "../src/ledger-tools.ts";
import { reportStage } from "../src/regenerate/activity.ts";
import { createJobRegistry } from "../src/regenerate/jobs.ts";
import { healing, record, startLedger, stopLedger } from "../src/regenerate/ledger.ts";
import { sinceOf } from "../src/regenerate/ledger-view.ts";

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

const ask = async (params: Record<string, unknown>, cwd = project) => {
  const result = await ledgerTool({ cwd }).execute("call", params as never, undefined, undefined, undefined as never);
  return (result.content[0] as { text: string }).text;
};

beforeEach(async () => {
  project = realpathSync(mkdtempSync(join(tmpdir(), "turri-ledger-tool-")));
  pulse = await aRun();
});
afterEach(() => {
  stopLedger();
  rmSync(project, { recursive: true, force: true });
});

describe("the ledger tool", () => {
  it("tells a pulse as facts, by the start of its id - rounds, test runs, the healer that failed, what turri refused", async () => {
    const text = await ask({ pulse: pulse.slice(0, 4) });
    expect(text).toContain(`${pulse} · backend · regenerate pulse 1 - messages`);
    expect(text).toContain("succeeded, landed");
    expect(text).toContain("rounds: unit tests 2 of 20");
    expect(text).toContain("test runs: 2, 2 failing - 2 of them the same way");
    expect(text).toContain("the debugger FAILED: No API key for provider: anthropic");
    expect(text).toContain("turri refused calls: repeat 1x");
  });

  it("says when it has no such pulse", async () => {
    expect(await ask({ pulse: "zzzz" })).toBe("The ledger has no pulse zzzz.");
  });

  it("counts the events of a kind, or of a whole group, and lists the most recent", async () => {
    await aRun();
    const failed = await ask({ kinds: ["healer.failed"] });
    expect(failed).toMatch(/^2 events, in 2 runs and 2 pulses: healer\.failed 2/);
    expect(failed).toContain('healer.failed · healer="debugger"');
    const group = await ask({ kinds: ["healer"], limit: 1 });
    expect(group).toMatch(/^4 events, in 2 runs and 2 pulses: /);
    expect(group).toContain("healer.started 2");
    expect(group).toContain("The last 1, newest first:");
    expect(failed).toContain("Each, newest first:");
  });

  it("narrows the events to a module and a time, and says what the ledger has when nothing matches", async () => {
    expect(await ask({ kinds: ["script.run"], module: "frontend" })).toMatch(/^No script\.run events in frontend in the ledger\.$/);
    expect(await ask({ kinds: ["history.failed"] })).toMatch(/^No history\.failed events in the ledger\. It has: .*healer\.failed.*script\.run/);
    expect(await ask({ kinds: ["script.run"], since: "1d" })).toMatch(/^2 events since /);
    expect(await ask({ kinds: ["script.run"], since: "whenever" })).toContain("since takes 24h, 7d, 30m or a date and time");
  });

  it("lists the last runs a line a pulse when asked for neither, and how many more there are", async () => {
    await aRun();
    const text = await ask({ runs: 1 });
    expect(text).toMatch(/^run \w+ · chat · /);
    expect(text).toContain("backend · regenerate pulse 1");
    expect(text).toContain("1 earlier run beyond these: ask with runs for more.");
  });

  it("says so where nothing has run", async () => {
    const empty = realpathSync(mkdtempSync(join(tmpdir(), "turri-no-ledger-")));
    try {
      expect(await ask({}, empty)).toMatch(/^The ledger is empty here/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("since", () => {
  it("reads minutes, hours and days back from now, or a date", () => {
    const now = Date.parse("2026-10-20T12:00:00Z");
    expect(sinceOf("30m", now)?.toISOString()).toBe("2026-10-20T11:30:00.000Z");
    expect(sinceOf("24h", now)?.toISOString()).toBe("2026-10-19T12:00:00.000Z");
    expect(sinceOf("7d", now)?.toISOString()).toBe("2026-10-13T12:00:00.000Z");
    expect(sinceOf("2026-10-01")?.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(sinceOf("soon")).toBeUndefined();
  });
});
