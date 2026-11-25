import { describe, expect, it } from "vitest";
import { clearOfStop, currentStopSignal, describeToolCall, describeToolResult, reportActivity, reportNow, reportStage, withStopSignal } from "../../src/regenerate/activity.ts";
import { createJobRegistry } from "../../src/regenerate/jobs.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("what a background job is doing", () => {
  it("lands on the job it was reported from, even with two running at once", async () => {
    const jobs = createJobRegistry();
    const run = (name: string) => async () => {
      reportStage(`${name}: writing code`);
      await tick();
      reportActivity(`✎ write ${name}.py`);
      await tick();
      return { report: "done" };
    };
    const a = jobs.start({ kind: "render", summary: "a", run: run("a") });
    const b = jobs.start({ kind: "render", summary: "b", run: run("b") });
    await Promise.all([jobs.wait(a.id), jobs.wait(b.id)]);

    expect(a.stage).toBe("a: writing code");
    expect(a.activity).toEqual(["✎ write a.py"]);
    expect(b.activity).toEqual(["✎ write b.py"]);
  });

  it("keeps only the most recent activity", async () => {
    const jobs = createJobRegistry();
    const job = jobs.start({
      kind: "render",
      summary: "x",
      run: async () => {
        for (let i = 0; i < 20; i += 1) reportActivity(`line ${i}`);
        return { report: "" };
      },
    });
    await jobs.wait(job.id);
    expect(job.activity).toHaveLength(10);
    expect(job.activity.at(-1)).toBe("line 19");
  });

  it("tells the listener every time something changes", async () => {
    let changes = 0;
    const jobs = createJobRegistry({ onChange: () => (changes += 1) });
    const job = jobs.start({
      kind: "render",
      summary: "x",
      run: async () => {
        reportStage("one");
        reportActivity("two");
        return { report: "" };
      },
    });
    await jobs.wait(job.id);
    expect(changes).toBe(3); // started, stage, activity
  });

  it("is a no-op outside a job", () => {
    expect(() => reportActivity("nobody listening")).not.toThrow();
  });

  it("keeps the clock when only the words change", async () => {
    const jobs = createJobRegistry();
    const job = jobs.start({
      kind: "render",
      summary: "x",
      run: async () => {
        reportNow("preparing a tool call");
        const first = job.now!.since;
        await tick();
        reportNow("writing write call · 4.2k chars", { keepSince: true });
        expect(job.now!.since).toBe(first);
        reportNow(undefined);
        return { report: "" };
      },
    });
    await jobs.wait(job.id);
    expect(job.now).toBeUndefined();
  });
});

describe("work stopped outside a job", () => {
  it("is stopped by the signal it runs under, and a job started from it by its own", async () => {
    const stop = new AbortController();
    const jobs = createJobRegistry();
    let inJob: AbortSignal | undefined;
    await withStopSignal(stop.signal, async () => {
      expect(currentStopSignal()).toBe(stop.signal);
      const job = jobs.start({
        kind: "render",
        summary: "a",
        run: async () => {
          inJob = currentStopSignal();
          return { report: "done" };
        },
      });
      await jobs.wait(job.id);
    });
    expect(inJob).toBeDefined();
    expect(inJob).not.toBe(stop.signal);
    expect(currentStopSignal()).toBeUndefined();
  });

  it("hands on what it is given clear of its signal", async () => {
    const stop = new AbortController();
    const loop = { seen: undefined as AbortSignal | undefined, bringUp() { this.seen = currentStopSignal(); } };
    await withStopSignal(stop.signal, async () => clearOfStop(loop).bringUp());
    expect(loop.seen).toBeUndefined();
  });
});

describe("tool calls as one line", () => {
  it("names files written and commands run", () => {
    expect(describeToolCall("write", { path: "src/greeter.py" })).toBe("✎ write src/greeter.py");
    expect(describeToolCall("run_unit_tests", {})).toBe("▶ unit tests: the project's script");
    expect(describeToolCall("something_new", {})).toBe("• something_new");
    // turri's own tools have theirs.
    expect(describeToolCall("update_notes", {})).toBe("✐ update_notes");
    expect(describeToolCall("my_diff", {})).toBe("± my_diff");
    expect(describeToolCall("submit_work", {})).toBe("✓ submit_work");
    expect(describeToolCall("submit_review", {})).toBe("✓ submit_review");
    // Reading, searching and the web have their marks too: no line without one.
    expect(describeToolCall("grep", { pattern: "create_app" })).toBe("⌕ grep create_app");
    expect(describeToolCall("web_search", { query: "sqlite in-memory no such table" })).toBe("⇢ web_search sqlite in-memory no such table");
  });

  it("gives paths as they are inside plain_modules, wherever they appear", () => {
    const root = "/Users/someone/Work/shop/plain_modules";
    expect(describeToolCall("write", { path: `${root}/version/code/src/version.py` })).toBe("✎ write version/code/src/version.py");
    expect(describeToolCall("bash", { command: `cd ${root}/version/code && pytest -q` })).toBe("$ cd version/code && pytest -q");
    expect(describeToolCall("read", { path: `${root}/version/tests/test_version.py` })).toBe("○ read version/tests/test_version.py");
    expect(describeToolCall("edit", { path: "plain_modules/app/code/main.py" })).toBe("✎ edit app/code/main.py");
    // Anything else is left as it is.
    expect(describeToolCall("bash", { command: "ls /tmp/other && cat my_plain_modules/x" })).toBe("$ ls /tmp/other && cat my_plain_modules/x");
  });

  it("reports whether a test run passed", () => {
    expect(describeToolResult("run_unit_tests", { details: { exitCode: 0 } }, false)).toBe("  ✓ passing");
    expect(describeToolResult("run_unit_tests", { details: { exitCode: 1 } }, false)).toBe("  ✗ failing (exit 1)");
    expect(describeToolResult("write", {}, false)).toBeUndefined();
  });
});
