import { join, sep } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { activityLine, captureStatusLines, CaptureTracker, duration, workOf, workStrip, type CaptureStatus } from "../../src/capture/progress.ts";
import { newState } from "../../src/capture/state.ts";

const ROOT = join(sep, "home", "node", "shorty");

function status(over: Partial<CaptureStatus> = {}): CaptureStatus {
  return { root: ROOT, started: 0, stage: "capturing", features: { outlined: 8, done: 3 }, outlining: 0, work: { done: 0, total: 0 }, agents: [], cost: 0, ...over };
}

/** Each colour as a mark around what it paints, so a test can tell done from at work from waiting. */
const MARKED = { heading: (t: string) => t, done: (t: string) => `<done:${t}>`, now: (t: string) => `<now:${t}>`, muted: (t: string) => t };

describe("a capture's status", () => {
  it("leads with its phases - those done ticked, the one it is in spinning, those to come - and how far through them it is", () => {
    const [phases] = captureStatusLines(status(), { frame: "⠋", now: 0, width: 160 });
    expect(phases).toMatch(/^capture shorty +✓ survey ━+ ✓ outline ━+ ⠋ features ─+ ○ concepts ─+ ○ readability ─+ ○ interface ─+ ○ trial ─+ ○ scripts +phase 3 of 8$/);
    const [compact] = captureStatusLines(status({ pipeline: "compact", stage: "compact-writing" }), { frame: "⠋", now: 0, width: 160 });
    expect(compact).toMatch(/✓ survey ━+ ⠋ features ─+ ○ interface ─+ ○ trial ─+ ○ scripts +phase 2 of 5$/);
    const [checking] = captureStatusLines(status({ stage: "checking" }), { frame: "⠙", now: 0, width: 160 });
    expect(checking).toMatch(/⠙ survey ─+ ○ outline .* phase 1 of 8$/);
    const [dividing] = captureStatusLines(status({ stage: "dividing" }), { frame: "⠙", now: 0, width: 160 });
    expect(dividing).toMatch(/✓ survey ━+ ⠙ outline ─+ ○ features .* phase 2 of 8$/);
    const [gathering] = captureStatusLines(status({ stage: "gathering" }), { frame: "⠙", now: 0, width: 160 });
    expect(gathering).toMatch(/✓ outline ━+ ⠙ features ─+ ○ concepts .* phase 3 of 8$/);
    const [verifying] = captureStatusLines(status({ stage: "verifying" }), { frame: "⠙", now: 0, width: 160 });
    expect(verifying).toMatch(/✓ readability ━+ ⠙ interface ─+ ○ trial ─+ ○ scripts +phase 6 of 8$/);
    const [trying] = captureStatusLines(status({ stage: "trying" }), { frame: "⠙", now: 0, width: 160 });
    expect(trying).toMatch(/✓ interface ━+ ⠙ trial ─+ ○ scripts +phase 7 of 8$/);
    const [scripts] = captureStatusLines(status({ stage: "scripts" }), { frame: "⠙", now: 0, width: 160 });
    expect(scripts).toMatch(/✓ trial ━+ ⠙ scripts +phase 8 of 8$/);
  });

  it("strips the phase's work under it - done, at work, waiting - with what it is in words, how long and what it cost", () => {
    const agents = [{ label: "feature shorty#a", since: 0 }, { label: "feature shorty#b", since: 0 }];
    const [, phase] = captureStatusLines(status({ cost: 0.844, agents }), { frame: "⠋", now: 130_000, width: 200 });
    expect(phase).toBe(`  ${"█".repeat(15)}${"▓".repeat(9)}  3 of 8 features captured, 2 at work · 2m 10s · $0.84`);
    expect(captureStatusLines(status({ stage: "surveying" }), { frame: "⠙", now: 5_000, width: 200 })[1]).toBe("  ⠙ surveying the codebase · 5s");
    expect(captureStatusLines(status({ stage: "outlining", features: { outlined: 0, done: 0 } }), { frame: "⠙", now: 0, width: 200 })[1]).toContain("outlining the features");
    expect(captureStatusLines(status({ stage: "outlining", outlining: 2 }), { frame: "⠙", now: 0, width: 200 })[1]).toContain("⠙ 8 features outlined, 2 areas still being outlined");
    expect(captureStatusLines(status({ stage: "dividing", work: { done: 0, total: 1 } }), { frame: "⠙", now: 0, width: 200 })[1]).toContain("giving each behaviour to one feature");
    expect(captureStatusLines(status({ stage: "checking", work: { done: 0, total: 1 } }), { frame: "⠙", now: 0, width: 200 })[1]).toContain("checking the conventions against the code");
    expect(captureStatusLines(status({ stage: "filling", work: { done: 1, total: 2 } }), { frame: "⠙", now: 0, width: 200 })[1]).toContain("capturing the interface no feature named: 1 of 2 writers done");
    expect(captureStatusLines(status({ stage: "verifying", work: { done: 2, total: 6 } }), { frame: "⠙", now: 0, width: 200 })[1]).toContain("2 of 6 modules checked against the code");
    expect(captureStatusLines(status({ stage: "scripts", work: { done: 1, total: 2 } }), { frame: "⠙", now: 0, width: 200 })[1]).toContain("1 of 2 testing scripts written");
    expect(captureStatusLines(status({ stage: "reading", work: { done: 0, total: 3 } }), { frame: "⠙", now: 0, width: 200 })[1]).toContain("0 of 3 modules read for readability");
    expect(captureStatusLines(status({ stage: "gathering", work: { done: 0, total: 1 } }), { frame: "⠙", now: 0, width: 200 })[1]).toContain("gathering the features into modules by concern, in the order they are built");
    expect(captureStatusLines(status({ stage: "trying", work: { done: 2, total: 5 } }), { frame: "⠙", now: 0, width: 200 })[1]).toContain("trying the scenarios on the original: 2 of 5 agents done");
  });

  it("paints the strip's work done, at work and waiting apart, in the regen panel's glyphs", () => {
    expect(workStrip({ total: 4, done: 1, running: 2 }, MARKED, 8)).toBe("<done:██><now:████>▓▓");
    expect(workStrip({ total: 3, done: 0, running: 0 }, MARKED, 6)).toBe("▓▓▓▓▓▓");
    expect(workOf(status({ agents: [{ label: "outline shorty", since: 0 }] }))).toEqual({ total: 8, done: 3, running: 0 });
    expect(workOf(status({ stage: "surveying" }))).toBeUndefined();
  });

  it("gives each agent at work a line: what it does, for how long, what it did last and what it is at", () => {
    const lines = captureStatusLines(
      status({
        agents: [
          { label: "feature short-links#create-link", since: 90_000, did: "○ read app/api/links.py", now: "thinking" },
          { label: "outline service", since: 125_000 },
        ],
        last: "captured short-links#link-clicks: 1 functional spec",
      }),
      { frame: "⠋", now: 130_000, width: 200 },
    );
    expect(lines.slice(2)).toEqual([
      "    feature short-links#create-link     40s  ○ read app/api/links.py · thinking",
      "    outline service                      5s  starting",
      "  captured short-links#link-clicks: 1 functional spec",
    ]);
  });

  it("counts the agents past six on one line, and cuts every line to the width", () => {
    const agents = Array.from({ length: 8 }, (_, at) => ({ label: `feature f${at}`, since: 0, did: `○ read ${"deep/".repeat(30)}file.py` }));
    const lines = captureStatusLines(status({ agents }), { frame: "⠋", now: 0, width: 60 });
    expect(lines).toHaveLength(9);
    expect(lines[8]).toContain("and 2 more agents");
    expect(lines.every((line) => visibleWidth(line) <= 60)).toBe(true);
  });

  it("says a tool call without the agent's role, the model's time or the codebase's own folder", () => {
    expect(activityLine(`(capture) ○ read ${join(ROOT, "app", "main.py")}   (model 3.2s)`, ROOT)).toBe(`○ read ${join("app", "main.py")}`);
    expect(activityLine("  ✗ read failed", ROOT)).toBe("✗ read failed");
  });

  it("says a duration in seconds, minutes or hours", () => {
    expect([duration(9_400), duration(130_000), duration(3_900_000)]).toEqual(["9s", "2m 10s", "1h 05m"]);
  });

  it("follows each agent from its start to its end, and counts the features from the state", () => {
    const changes: string[] = [];
    const tracker = new CaptureTracker(ROOT, undefined, (now) => changes.push(`${now.stage} ${now.agents.map((agent) => `${agent.label}:${agent.did ?? ""}`).join(",")}`));
    const agent = tracker.agent("survey", "Survey the codebase");
    agent.did("(capture) ○ read pyproject.toml");
    agent.started();
    agent.did("(capture) ○ read pyproject.toml");
    agent.spent(0.5);
    expect(tracker.status.agents).toMatchObject([{ label: "survey", did: "○ read pyproject.toml" }]);
    agent.ended();
    expect(tracker.status.agents).toEqual([]);
    expect(tracker.status.cost).toBe(0.5);
    // What an agent says before it starts, or after it ends, is not shown.
    expect(changes).toEqual(["mapping ", "mapping survey:", "mapping survey:", "mapping survey:○ read pyproject.toml", "mapping survey:○ read pyproject.toml", "mapping "]);

    const state = newState(ROOT);
    state.areas.api = { id: "api", name: "api", about: "", paths: ["."], part: "api", features: [{ name: "a", title: "", about: "", paths: [] }, { name: "b", title: "", about: "", paths: [] }] };
    state.features["api#a"] = { key: "api#a", failed: "never held" };
    state.areas.web = { id: "web", name: "web", about: "", paths: ["web"], part: "web" };
    tracker.counted(state);
    expect(tracker.status.features).toEqual({ outlined: 2, done: 1 });
    expect(tracker.status.outlining).toBe(1);
    // A feature merged into another is never written: no longer among those to capture.
    state.divided = { api: { owns: { "api#a": "all of it" }, merged: { "api#b": { into: ["api#a"], why: "a slice of a" } } } };
    tracker.counted(state);
    expect(tracker.status.features).toEqual({ outlined: 1, done: 1 });

    tracker.stage("scripts", 2);
    tracker.worked();
    expect(tracker.status.work).toEqual({ done: 1, total: 2 });
    tracker.stage("writing");
    expect(tracker.status.work).toEqual({ done: 0, total: 0 });
  });
});
