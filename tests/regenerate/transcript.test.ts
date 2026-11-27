import { describe, expect, it } from "vitest";
import type { Job, JobDetails } from "@turri-dev/core";

/** A pulse as the session tells it (`work.jobs()`, `job` events): finished, unless `status` says otherwise. */
let sequence = 0;
function job(fields: Partial<Job> & Pick<Job, "kind" | "summary">): Job {
  sequence += 1;
  const now = Date.now();
  return {
    id: `job${sequence}`, status: "succeeded", sequence, queuedAt: now, startedAt: now, finishedAt: now, waitingOn: [], tail: "", activity: [], agents: [], transcript: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, report: "",
    ...fields,
  } as Job;
}
/** Open the finished section and the first job in it, with the keys: it starts collapsed. */
function openFinished(panel: { render(width: number): string[]; handleInput(data: string): void }, width = 100): void {
  const down = "\x1b[B";
  for (const key of [down, down, "\r", down, "\r"]) {
    panel.render(width);
    panel.handleInput(key);
  }
}

describe("the side panel", () => {
  const PLAIN = { heading: (t: string) => t, muted: (t: string) => t, accent: (t: string) => t, error: (t: string) => t, added: (t: string) => t, removed: (t: string) => t };
  const judge = { label: "app 1 judge", model: "bedrock/sonnet-5:medium" };
  const coder = { label: "app 1 coding agent", model: "bedrock/sonnet-5:low" };

  it("shows the queue alone - not the agents' traces, which are in each pulse's log", async () => {
    const { createSidePanel } = await import("../../src/regenerate/side-panel.ts");
    const pulse = job({
      kind: "regenerate",
      summary: "app.plain fs 1",
      building: { spec: { module: "app", funcId: "print-hello" }, label: "app 1 of 1", text: "The app prints hello.\n\nMore of it." },
      transcript: [{ kind: "text", text: "The code drops the /api/v2 prefix.", agent: judge }, { kind: "tool", text: "edit StorageServiceClient.java", agent: coder }],
    });
    let back = 0;
    let closed = false;
    const panel = createSidePanel({ jobs: () => [pulse], rows: () => 40, style: PLAIN, key: "alt+o", back: () => (back += 1), close: () => (closed = true) });
    const text = () => panel.render(100).join("\n");

    // Jobs first: the queue, with what finished - and, opened, what each was about.
    expect(text()).toMatch(/^pulses/);
    expect(text()).toContain("▸ finished (1)");
    openFinished(panel);
    expect(text()).toContain("▾ finished (1)");
    // Everything is shown already: no ctrl+o to expand it, no pointer to the panel it is in.
    expect(text()).not.toContain("ctrl+o");
    expect(text()).not.toContain("in the side panel:");
    expect(text()).toContain("app.plain fs 1");
    // The functional spec it built, whole.
    expect(text()).toContain("app 1 of 1:");
    expect(text()).toContain("The app prints hello.");
    expect(text()).toContain("More of it.");

    // What the agents said and did is in the pulse's log, not here: there is no trace to switch to.
    panel.handleInput("\t");
    expect(text()).not.toContain("Trace");
    expect(text()).not.toContain("The code drops the /api/v2 prefix.");
    expect(text()).not.toContain("edit StorageServiceClient.java");

    // Scrolled by keys and by the wheel.
    panel.handleMouse({ type: "wheel", button: "none", x: 0, y: 0, screenX: 0, screenY: 0, width: 100, height: 40, shift: false, alt: false, ctrl: false, wheelDelta: -1 });

    panel.handleInput("\x1b");
    expect(back).toBe(1);
    expect(closed).toBe(false);
  });

  it("says on its top line when the chat is waiting for an answer, and sends esc back to the chat", async () => {
    const { createSidePanel } = await import("../../src/regenerate/side-panel.ts");
    let waiting = false;
    let back = 0;
    const panel = createSidePanel({ jobs: () => [], rows: () => 20, style: PLAIN, key: "ctrl+h", back: () => (back += 1), close: () => {}, waiting: () => waiting });
    expect(panel.render(120)[0]).not.toContain("waiting");
    waiting = true;
    expect(panel.render(120)[0]).toContain("your question is waiting - ctrl+h or esc to answer it, as you left it");
    expect(panel.render(120)[2]).toContain("esc or ctrl+h back to the chat");
    panel.handleInput("\x1b");
    expect(back).toBe(1);
  });

  it("shows under each finished spec diff the whole change, and says which render a conformance job was the conformance of", async () => {
    const { createSidePanel } = await import("../../src/regenerate/side-panel.ts");
    const diff = "--- a/backend.plain\n+++ b/backend.plain\n@@ -1 +1,2 @@\n+- :OrderController: takes the :AuthData: from the request.\n";
    const render = job({ kind: "regenerate", summary: "backend.plain render spec diff", diff });
    const conformance = job({ kind: "conformance", summary: "backend.plain spec diff conformance", diff, follows: render.id });
    const panel = createSidePanel({ jobs: () => [render, conformance], rows: () => 30, style: PLAIN, key: "ctrl+h", back: () => {}, close: () => {} });
    // Newest first: the conformance job, then the spec diff - each opened, past the row of the conformance job's file.
    const down = "\x1b[B";
    for (const key of [down, down, "\r", down, "\r", down, down, "\r"]) {
      panel.render(120);
      panel.handleInput(key);
    }
    const lines = panel.render(120).join("\n");
    expect(lines).toContain("backend.plain render spec diff");
    expect(lines).toContain("+ - :OrderController: takes the :AuthData: from the request.");
    expect(lines).not.toContain("+++ b/backend.plain");
    expect(lines).toContain(`the conformance of backend.plain render spec diff (pulse ${render.id}, succeeded)`);
  });

  it("says what a module's render planned - the spec diffs it queued - and, under each, which job planned it", async () => {
    const { createSidePanel } = await import("../../src/regenerate/side-panel.ts");
    const diff = "--- a/backend.plain\n+++ b/backend.plain\n@@ -1 +1,2 @@\n+- Comments on study sessions.\n";
    const step = job({ kind: "regenerate", summary: "backend.plain render spec diff", diff });
    const planner = job({
      kind: "regenerate",
      summary: "backend.plain module",
      details: { passed: true, planned: [{ title: "Implement comments on study sessions", jobId: step.id }] } as JobDetails,
    });
    const panel = createSidePanel({ jobs: () => [step, planner], rows: () => 40, style: PLAIN, key: "ctrl+h", back: () => {}, close: () => {} });
    const down = "\x1b[B";
    for (const key of [down, down, "\r", down, "o"]) {
      panel.render(140);
      panel.handleInput(key);
    }
    const lines = panel.render(140).join("\n");
    expect(lines).toContain("planned 1 spec diff:");
    expect(lines).toContain(`1. Implement comments on study sessions → backend.plain render spec diff (pulse ${step.id}, succeeded)`);
    expect(lines).toContain(`planned by backend.plain module (pulse ${planner.id}, succeeded)`);
  });
});
