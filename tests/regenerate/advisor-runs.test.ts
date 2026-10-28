import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { currentStopSignal, JobStoppedError } from "../../src/regenerate/activity.ts";
import { advisorEntry, putAdvisorEntry, readAdvisor, textHash } from "../../src/regenerate/advisor-records.ts";
import { createTestAdvisor } from "../../src/regenerate/advisor-runs.ts";
import { createJobRegistry } from "../../src/regenerate/jobs.ts";
import { onLedgerEvent, startLedger, stopLedger, type LedgerEntry } from "../../src/regenerate/ledger.ts";
import { chainSpec, createWorkLoop, type JobRunner, type SeenSpec } from "../../src/regenerate/loop.ts";
import { writeCodeRecord } from "../../src/regenerate/records.ts";
import { recordHistory } from "../../src/regenerate/lineage.ts";
import { resolveRequiresChain } from "../../src/regenerate/requires.ts";
import type { AdvisorSubject } from "../../src/regenerate/test-advisor.ts";
import { testPlainFile } from "../test-plain.ts";

let dir: string;
let cwd: string;
let events: LedgerEntry[];
let unlisten: () => void;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "turri-advisor-runs-")));
  cwd = process.cwd();
  process.chdir(dir);
  writeFileSync(join(dir, "config.turri.yaml"), "");
  events = [];
  startLedger({ mode: "test", project: dir });
  unlisten = onLedgerEvent((entry) => {
    if (entry.kind.startsWith("advisor.")) events.push(entry);
  });
});
afterEach(() => {
  unlisten();
  stopLedger();
  process.chdir(cwd);
  rmSync(dir, { recursive: true, force: true });
});

const module = (specs: Array<[string, string]>) =>
  `***implementation reqs***\n\n- :Implementation: is Python.\n\n***functional specs***\n\n${specs.map(([id, text]) => `# ${id}\n${text}`).join("\n\n")}\n`;

/** The codebase of a module as the loop looks at it: its chain, its spec now, and nothing built. */
function lookAt(file: string, built = {}): SeenSpec {
  const chain = resolveRequiresChain(join(dir, file), [], undefined, { allowNoFunctionalities: true });
  return { chain, tree: chainSpec(chain).tree, built };
}

/** An advise that says no at once, recording what it was asked. */
function saysNo() {
  const asked: AdvisorSubject[] = [];
  return { asked, advise: async (subject: AdvisorSubject) => (asked.push(subject), { verdict: "no" as const, questions: [], inputs: [] }) };
}

/** An advise held until released - or stopped, as a model call is, by the work's stop signal. */
function held() {
  const asked: AdvisorSubject[] = [];
  const releases: Array<() => void> = [];
  let running = 0;
  let most = 0;
  const advise = async (subject: AdvisorSubject) => {
    asked.push(subject);
    running += 1;
    most = Math.max(most, running);
    try {
      await new Promise<void>((resolve, reject) => {
        releases.push(resolve);
        currentStopSignal()?.addEventListener("abort", () => reject(new JobStoppedError()), { once: true });
      });
    } finally {
      running -= 1;
    }
    return { verdict: "no" as const, questions: [], inputs: [] };
  };
  return { asked, releases, advise, most: () => most };
}

/** A runner that lands what it is given, as a render does. */
const lands: JobRunner = async (job) => {
  mkdirSync(job.buildDir, { recursive: true });
  writeFileSync(join(job.buildDir, "app.py"), "# built\n");
  writeCodeRecord(job.buildDir, job.spec.tree);
  recordHistory(job.buildDir, job.planned.title);
  return { landed: true, report: "landed" };
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("which functional specs the test advisor takes", () => {
  it("classifies a new functional spec as the loop sees it, and not one built as it is", async () => {
    writeFileSync(join(dir, "app.plain"), module([["say-hello", "Say hello."]]));
    const { asked, advise } = saysNo();
    const advisor = createTestAdvisor({ advise });
    const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, run: lands, onSpec: (seen) => advisor.seen(seen) });
    await loop.bringUp("app.plain");
    await loop.drain();
    await advisor.idle();
    expect(asked.map((subject) => `${subject.module}:${subject.funcId}`)).toEqual(["app:say-hello"]);
    expect(asked[0]!.text).toBe("Say hello.");
    expect(advisorEntry(dir, "app", "say-hello")).toMatchObject({ state: "no", tip: "app.plain" });
    expect(events.map((event) => event.kind)).toEqual(["advisor.classified"]);
    expect(events[0]).toMatchObject({ spec: "app:say-hello", verdict: "no", questions: [], module: "app" });

    // A project built before, with no advisor file: what is built as it is now is not looked at - no backlog.
    rmSync(join(dir, ".turri", "advisor"), { recursive: true, force: true });
    asked.length = 0;
    const fresh = createTestAdvisor({ advise });
    const again = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, run: lands, onSpec: (seen) => fresh.seen(seen) });
    writeFileSync(join(dir, "app.plain"), module([["say-hello", "Say hello."], ["say-bye", "Say goodbye."]]));
    await again.bringUp("app.plain");
    await again.drain();
    await fresh.idle();
    expect(asked.map((subject) => subject.funcId)).toEqual(["say-bye"]);
    expect(readAdvisor(dir, "app")!.entries["say-hello"]).toBeUndefined();
  });

  it("classifies a changed text again, and the same text never twice", async () => {
    writeFileSync(join(dir, "app.plain"), module([["say-hello", "Say hello."]]));
    const { asked, advise } = saysNo();
    const advisor = createTestAdvisor({ advise });
    advisor.seen(lookAt("app.plain"));
    await advisor.idle();
    advisor.seen(lookAt("app.plain"));
    await advisor.idle();
    expect(asked).toHaveLength(1);
    writeFileSync(join(dir, "app.plain"), module([["say-hello", "Say hello, loudly."]]));
    advisor.seen(lookAt("app.plain"));
    await advisor.idle();
    expect(asked.map((subject) => subject.text)).toEqual(["Say hello.", "Say hello, loudly."]);
  });

  it("leaves alone a functional spec with the person's scenarios", async () => {
    writeFileSync(join(dir, "app.plain"), module([["say-hello", "Say hello."], ["say-bye", "Say goodbye."]]));
    mkdirSync(join(dir, "tests", "app"), { recursive: true });
    writeFileSync(join(dir, "tests", "app", "say-hello.plain"), testPlainFile("app", "say-hello", { conformance: ["# greets\nIt prints hello."] }));
    const { asked, advise } = saysNo();
    const advisor = createTestAdvisor({ advise });
    advisor.seen(lookAt("app.plain"));
    await advisor.idle();
    expect(asked.map((subject) => subject.funcId)).toEqual(["say-bye"]);
  });

  it("takes again a functional spec whose scenarios are turri's or kept in step with its text, and leaves it once the person edited one on its own", async () => {
    const scenario = "Running it prints hello.";
    const writeScenario = (text: string) => {
      mkdirSync(join(dir, "tests", "app"), { recursive: true });
      writeFileSync(join(dir, "tests", "app", "say-hello.plain"), testPlainFile("app", "say-hello", { conformance: [`# greets\n${text}`] }));
    };
    writeFileSync(join(dir, "app.plain"), module([["say-hello", "Say hello."]]));
    writeScenario(scenario);
    putAdvisorEntry(dir, "app", "app.plain", { funcId: "say-hello", hash: textHash("Say hello."), state: "yes", tip: "app.plain", scenarios: [{ kind: "conformance", id: "greets", hash: textHash(scenario) }] });
    const previous: unknown[] = [];
    const yes = { verdict: "yes" as const, questions: [{ question: "cost" as const, evidence: "Lost greetings." }], inputs: [] };
    const advisor = createTestAdvisor({
      advise: async () => yes,
      write: async (work) => {
        previous.push(...work.previous);
        return { scenarios: work.previous, testReqs: false, script: false };
      },
    });
    // Its text changed, its scenarios all turri's: taken again, turri's scenarios its writer's to replace.
    writeFileSync(join(dir, "app.plain"), module([["say-hello", "Say hello, twice."]]));
    advisor.seen(lookAt("app.plain"));
    await advisor.idle();
    expect(previous).toEqual([{ kind: "conformance", id: "greets", hash: textHash(scenario) }]);
    expect(events.map((event) => event.kind)).toEqual(["advisor.classified", "advisor.wrote"]);

    // Its scenario kept in step in the same change as its text, as the chat keeps it: still turri's, taken again.
    previous.length = 0;
    writeScenario("Running it prints hello three times.");
    writeFileSync(join(dir, "app.plain"), module([["say-hello", "Say hello, three times."]]));
    advisor.seen(lookAt("app.plain"));
    await advisor.idle();
    expect(previous).toEqual([{ kind: "conformance", id: "greets", hash: textHash("Running it prints hello three times.") }]);
    expect(events.map((event) => event.kind)).toEqual(["advisor.classified", "advisor.wrote", "advisor.classified", "advisor.wrote"]);

    // The person edits turri's scenario on its own, the text as it was: it is theirs now, and a later change to the
    // text is left to today's review - it cannot pass for keeping the scenario in step.
    writeScenario("Running it prints hello three times, and exits 0.");
    advisor.seen(lookAt("app.plain"));
    await advisor.idle();
    writeScenario("Running it prints hello four times, and exits 0.");
    writeFileSync(join(dir, "app.plain"), module([["say-hello", "Say hello, four times."]]));
    advisor.seen(lookAt("app.plain"));
    await advisor.idle();
    expect(events).toHaveLength(4);
    expect(advisorEntry(dir, "app", "say-hello")?.hash).toBe(textHash("Say hello, three times."));
  });

  it("says which functional specs it is taking, while it takes them", async () => {
    writeFileSync(join(dir, "app.plain"), module([["say-hello", "Say hello."], ["say-bye", "Say goodbye."]]));
    const { releases, advise } = held();
    const advisor = createTestAdvisor({ advise });
    advisor.seen(lookAt("app.plain"));
    expect(advisor.taking(dir).sort()).toEqual(["app:say-bye", "app:say-hello"]);
    expect(advisor.taking(join(dir, "elsewhere"))).toEqual([]);
    while (releases.length > 0) releases.shift()!();
    await settle();
    while (releases.length > 0) releases.shift()!();
    await advisor.idle();
    expect(advisor.taking(dir)).toEqual([]);
  });

  it("says nothing for a no: no writer, no landing", async () => {
    writeFileSync(join(dir, "app.plain"), module([["say-hello", "Say hello."]]));
    const landed: unknown[] = [];
    let wrote = 0;
    const advisor = createTestAdvisor({
      advise: saysNo().advise,
      write: async () => ((wrote += 1), { scenarios: [], testReqs: false, script: false }),
      onLanded: (landing) => landed.push(landing),
    });
    advisor.seen(lookAt("app.plain"));
    await advisor.idle();
    expect(wrote).toBe(0);
    expect(landed).toEqual([]);
    expect(advisorEntry(dir, "app", "say-hello")?.state).toBe("no");
  });

  it("says a landing's functional spec is built only when its code is built from the text the scenarios are for", async () => {
    writeFileSync(join(dir, "app.plain"), module([["say-hello", "Say hello."]]));
    const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, run: lands });
    await loop.bringUp("app.plain");
    await loop.drain();
    const landed: Array<{ funcId: string; built: boolean }> = [];
    const advisor = createTestAdvisor({
      advise: async () => ({ verdict: "yes" as const, questions: [{ question: "silent-failure" as const, evidence: "It prints hullo." }], inputs: [] }),
      write: async () => ({ scenarios: [{ kind: "conformance" as const, id: "greets", hash: textHash("x") }], testReqs: false, script: false }),
      onLanded: (landing) => landed.push(landing),
    });
    // The tip is built with say-hello as it reads, but not with say-bye: its scenarios are tested once it is.
    writeFileSync(join(dir, "app.plain"), module([["say-hello", "Say hello."], ["say-bye", "Say goodbye."]]));
    advisor.seen(lookAt("app.plain"));
    await advisor.idle();
    expect(landed.map(({ funcId, built }) => ({ funcId, built })).sort((a, b) => a.funcId.localeCompare(b.funcId))).toEqual([
      { funcId: "say-bye", built: false },
      { funcId: "say-hello", built: true },
    ]);
  });

  it("does nothing with test-advisor: false", async () => {
    writeFileSync(join(dir, "config.turri.yaml"), "test-advisor: false\n");
    writeFileSync(join(dir, "app.plain"), module([["say-hello", "Say hello."]]));
    const { asked, advise } = saysNo();
    const advisor = createTestAdvisor({ advise });
    advisor.seen(lookAt("app.plain"));
    advisor.resume(dir);
    await advisor.idle();
    expect(asked).toHaveLength(0);
    expect(readAdvisor(dir, "app")).toBeUndefined();
  });
});

describe("how the test advisor works", () => {
  it("throws away the work on a text that changes while it runs, and starts again on the new one", async () => {
    writeFileSync(join(dir, "app.plain"), module([["say-hello", "Say hello."]]));
    const { asked, releases, advise } = held();
    const advisor = createTestAdvisor({ advise });
    advisor.seen(lookAt("app.plain"));
    await settle();
    expect(advisorEntry(dir, "app", "say-hello")?.state).toBe("pending");
    writeFileSync(join(dir, "app.plain"), module([["say-hello", "Say hello twice."]]));
    advisor.seen(lookAt("app.plain"));
    await settle();
    expect(asked.map((subject) => subject.text)).toEqual(["Say hello.", "Say hello twice."]);
    releases.at(-1)!();
    await advisor.idle();
    expect(events.map((event) => event.kind)).toEqual(["advisor.dropped", "advisor.classified"]);
    expect(advisorEntry(dir, "app", "say-hello")).toMatchObject({ state: "no" });
  });

  it("keeps a functional spec pending across a restart, and picks it up at the next start", async () => {
    writeFileSync(join(dir, "app.plain"), module([["say-hello", "Say hello."]]));
    const first = held();
    const before = createTestAdvisor({ advise: first.advise });
    before.seen(lookAt("app.plain"));
    await settle();
    // turri quits mid-way.
    before.stop();
    await settle();
    expect(advisorEntry(dir, "app", "say-hello")?.state).toBe("pending");
    expect(events).toEqual([]);

    const { asked, advise } = saysNo();
    const after = createTestAdvisor({ advise });
    after.resume(dir);
    await after.idle();
    expect(asked.map((subject) => subject.funcId)).toEqual(["say-hello"]);
    expect(advisorEntry(dir, "app", "say-hello")?.state).toBe("no");
  });

  it("works on two functional specs at a time at most", async () => {
    writeFileSync(join(dir, "app.plain"), module([["one", "Do one."], ["two", "Do two."], ["three", "Do three."]]));
    const { asked, releases, advise, most } = held();
    const advisor = createTestAdvisor({ advise });
    advisor.seen(lookAt("app.plain"));
    await settle();
    expect(asked).toHaveLength(2);
    // Each one finished lets the next start.
    releases[0]!();
    await settle();
    expect(asked).toHaveLength(3);
    releases[1]!();
    releases[2]!();
    await advisor.idle();
    expect(most()).toBe(2);
    expect(Object.values(readAdvisor(dir, "app")!.entries).map((entry) => entry.state)).toEqual(["no", "no", "no"]);
  });

  it("records a failure, and does not try the same text again", async () => {
    writeFileSync(join(dir, "app.plain"), module([["say-hello", "Say hello."]]));
    let calls = 0;
    const advisor = createTestAdvisor({
      advise: async () => {
        calls += 1;
        throw new Error("the provider is down");
      },
    });
    advisor.seen(lookAt("app.plain"));
    await advisor.idle();
    advisor.seen(lookAt("app.plain"));
    await advisor.idle();
    expect(calls).toBe(1);
    expect(advisorEntry(dir, "app", "say-hello")).toMatchObject({ state: "failed", reason: "the provider is down" });
    expect(events.map((event) => event.kind)).toEqual(["advisor.failed"]);
  });
});
