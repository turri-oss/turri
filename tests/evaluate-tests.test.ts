import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { evaluateTestsTool } from "../src/advisor-chat.ts";
import { currentStopSignal, JobStoppedError } from "../src/regenerate/activity.ts";
import { advisorEntry, putAdvisorEntry, textHash } from "../src/regenerate/advisor-records.ts";
import { createTestAdvisor, type AdvisorVerdict } from "../src/regenerate/advisor-runs.ts";
import { onLedgerEvent, startLedger, stopLedger, type LedgerEntry } from "../src/regenerate/ledger.ts";
import type { AdvisorSubject } from "../src/regenerate/test-advisor.ts";
import { testPlainFile } from "./test-plain.ts";

let dir: string;
let events: LedgerEntry[];
let unlisten: () => void;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "turri-evaluate-tests-")));
  writeFileSync(join(dir, "config.turri.yaml"), "conformance-tests: true\nmodule: core.plain\n");
  writeFileSync(
    join(dir, "core.plain"),
    "***implementation reqs***\n\n- :Implementation: is Python.\n\n***functional specs***\n\n# add-task\nAdd a task to the list.\n\n# clear-tasks\nRemove every task.\n",
  );
  events = [];
  startLedger({ mode: "test", project: dir });
  unlisten = onLedgerEvent((entry) => {
    if (entry.kind.startsWith("advisor.")) events.push(entry);
  });
});
afterEach(() => {
  unlisten();
  stopLedger();
  rmSync(dir, { recursive: true, force: true });
});

const yes = { verdict: "yes" as const, questions: [{ question: "silent-failure" as const, evidence: "Clearing leaves one task." }], inputs: [] };

/** An advise held until released, as a model call that takes its time - stopped by the work's signal. */
function held() {
  const asked: AdvisorSubject[] = [];
  const releases: Array<() => void> = [];
  const advise = async (subject: AdvisorSubject) => {
    asked.push(subject);
    await new Promise<void>((resolve, reject) => {
      releases.push(resolve);
      currentStopSignal()?.addEventListener("abort", () => reject(new JobStoppedError()), { once: true });
    });
    return yes;
  };
  return { asked, releases, advise };
}

/** What the tool says back. */
async function call(tool: ReturnType<typeof evaluateTestsTool>, params: Record<string, unknown>): Promise<string> {
  const result = (await tool.execute("id", params as never, undefined, undefined, undefined as never)) as { content: Array<{ text: string }> };
  return result.content.map((part) => part.text).join("\n");
}

describe("evaluate_tests", () => {
  it("returns at once, and the verdict comes back as any verdict does", async () => {
    const { asked, releases, advise } = held();
    const verdicts: AdvisorVerdict[] = [];
    const advisor = createTestAdvisor({ advise, onVerdict: (verdict) => verdicts.push(verdict) });
    const tool = evaluateTestsTool({ cwd: dir, advisor: () => advisor });
    const said = await call(tool, { funcIds: ["core:clear-tasks"] });
    expect(said).toContain("Testing scenarios for core:clear-tasks are being evaluated in the background; the verdict comes back to this chat.");
    // Still being judged as the tool answered: asked again, it is not started twice.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(asked.map((subject) => subject.funcId)).toEqual(["clear-tasks"]);
    expect(advisorEntry(dir, "core", "clear-tasks")?.state).toBe("pending");
    expect(await call(tool, { funcIds: ["clear-tasks"] })).toContain("core:clear-tasks is being evaluated already");
    releases[0]!();
    await advisor.idle();
    expect(verdicts.map((verdict) => `${verdict.module}:${verdict.funcId} ${verdict.report.verdict}`)).toEqual(["core:clear-tasks yes"]);
    expect(events.map((event) => [event.kind, (event as { asked?: boolean }).asked])).toEqual([["advisor.classified", true]]);
  });

  it("evaluates a functional spec of a module below in the tip that requires it, as the loop would", async () => {
    writeFileSync(join(dir, "todo.plain"), "---\nrequires:\n  - core\n---\n\n***functional specs***\n\n# remove-task\nRemove one task.\n");
    const subjects: AdvisorSubject[] = [];
    const verdicts: AdvisorVerdict[] = [];
    const advisor = createTestAdvisor({ advise: async (subject) => (subjects.push(subject), yes), onVerdict: (verdict) => verdicts.push(verdict) });
    await call(evaluateTestsTool({ cwd: dir, advisor: () => advisor }), { funcIds: ["core:clear-tasks"] });
    await advisor.idle();
    expect(subjects[0]!.testedIn?.module).toBe("todo");
    expect(verdicts[0]!.tip).toBe(join(dir, "todo.plain"));
    expect(advisorEntry(dir, "core", "clear-tasks")?.tip).toBe("todo.plain");
  });

  it("evaluates a text the advisor already judged", async () => {
    putAdvisorEntry(dir, "core", "core.plain", { funcId: "add-task", hash: textHash("Add a task to the list."), state: "no", tip: "core.plain" });
    let calls = 0;
    const advisor = createTestAdvisor({ advise: async () => ((calls += 1), yes) });
    await call(evaluateTestsTool({ cwd: dir, advisor: () => advisor }), { funcIds: ["core:add-task"] });
    await advisor.idle();
    expect(calls).toBe(1);
    expect(advisorEntry(dir, "core", "add-task")?.state).toBe("yes");
  });

  it("answers at once that a functional spec with scenarios is not evaluated", async () => {
    mkdirSync(join(dir, "tests", "core"), { recursive: true });
    writeFileSync(join(dir, "tests", "core", "add-task.plain"), testPlainFile("core", "add-task", { conformance: ["# adds-one\nAdding Milk lists Milk."] }));
    let calls = 0;
    const advisor = createTestAdvisor({ advise: async () => ((calls += 1), yes) });
    const said = await call(evaluateTestsTool({ cwd: dir, advisor: () => advisor }), { funcIds: ["core:add-task", "core:no-such-thing"] });
    await advisor.idle();
    expect(said).toContain("core:add-task has scenarios already, so it is not evaluated");
    expect(said).toContain("core:no-such-thing: its module has no such functional spec");
    expect(calls).toBe(0);
  });

  it("works with test-advisor: false, which turns off only what a change starts", async () => {
    writeFileSync(join(dir, "config.turri.yaml"), "conformance-tests: true\nmodule: core.plain\ntest-advisor: false\n");
    let calls = 0;
    const advisor = createTestAdvisor({ advise: async () => ((calls += 1), yes) });
    await call(evaluateTestsTool({ cwd: dir, advisor: () => advisor }), { funcIds: ["core:clear-tasks"] });
    await advisor.idle();
    expect(calls).toBe(1);
    expect(advisorEntry(dir, "core", "clear-tasks")?.state).toBe("yes");
  });

  it("gives the classifier the chat's reason, and picks up what it asked for at the next start whatever the setting", async () => {
    const first = held();
    const before = createTestAdvisor({ advise: first.advise });
    await call(evaluateTestsTool({ cwd: dir, advisor: () => before }), { funcIds: ["core:clear-tasks"], reason: "the coding agent failed three times to implement it" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(first.asked[0]!.reason).toBe("the coding agent failed three times to implement it");
    // turri quits mid-way, and starts again with the setting off: what the chat asked for is still picked up, its reason with it.
    before.stop();
    writeFileSync(join(dir, "config.turri.yaml"), "conformance-tests: true\nmodule: core.plain\ntest-advisor: false\n");
    const asked: AdvisorSubject[] = [];
    const after = createTestAdvisor({ advise: async (subject) => (asked.push(subject), yes) });
    after.resume(dir);
    await after.idle();
    expect(asked.map((subject) => [subject.funcId, subject.reason])).toEqual([["clear-tasks", "the coding agent failed three times to implement it"]]);
  });
});
