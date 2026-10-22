import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { adoptRun, chatsFile, forgetChat, lastRun, recordRun, RUNS_KEPT, type RunRecord } from "../src/chat-records.ts";

/** A pid no process has: a run whose turri has ended. */
const ENDED = 2 ** 22 + 12345;

function project() {
  return mkdtempSync(join(tmpdir(), "turri-chats-"));
}

/** A run with a chat a saved conversation each, its files written. */
function run(dir: string, name: string, started: string, chats = 1, pid = ENDED): RunRecord {
  return {
    run: name,
    pid,
    started,
    chats: Array.from({ length: chats }, (_, index) => {
      const sessionFile = join(dir, `${name}-${index}.jsonl`);
      writeFileSync(sessionFile, "{}\n");
      return { id: `${name}${index}`, title: `chat ${index + 1}`, sessionFile };
    }),
  };
}

describe("the record of a session's chats", () => {
  it("reopens the most recent run that has ended, its chats in their order", () => {
    const dir = project();
    recordRun(dir, run(dir, "old", "2026-10-01T00:00:00Z"));
    recordRun(dir, run(dir, "new", "2026-10-02T00:00:00Z", 3));
    expect(lastRun(dir)?.run).toBe("new");
    expect(lastRun(dir)?.chats.map((chat) => chat.id)).toEqual(["new0", "new1", "new2"]);
  });

  it("never reopens a run whose turri still runs", () => {
    const dir = project();
    recordRun(dir, run(dir, "ended", "2026-10-01T00:00:00Z"));
    recordRun(dir, run(dir, "running", "2026-10-02T00:00:00Z", 1, process.pid));
    expect(lastRun(dir)?.run).toBe("ended");
  });

  it("leaves out a chat whose conversation is gone, and a run with none left", () => {
    const dir = project();
    const gone = run(dir, "gone", "2026-10-02T00:00:00Z");
    recordRun(dir, run(dir, "kept", "2026-10-01T00:00:00Z"));
    recordRun(dir, { ...gone, chats: gone.chats.map((chat) => ({ ...chat, sessionFile: join(dir, "nowhere.jsonl") })) });
    expect(lastRun(dir)?.run).toBe("kept");
  });

  it(`keeps the newest ${RUNS_KEPT} runs, deleting the conversations of those beyond`, () => {
    const dir = project();
    const runs = Array.from({ length: RUNS_KEPT + 2 }, (_, index) => run(dir, `r${index}`, `2026-10-0${index + 1}T00:00:00Z`));
    for (const each of runs) recordRun(dir, each);
    const kept = (JSON.parse(readFileSync(chatsFile(dir), "utf8")) as { runs: RunRecord[] }).runs.map((each) => each.run);
    expect(kept).toHaveLength(RUNS_KEPT);
    expect(kept).not.toContain("r0");
    expect(existsSync(runs[0]!.chats[0]!.sessionFile)).toBe(false);
    expect(existsSync(runs[RUNS_KEPT + 1]!.chats[0]!.sessionFile)).toBe(true);
  });

  it("deletes nothing in debug mode", () => {
    const dir = project();
    const runs = Array.from({ length: RUNS_KEPT + 1 }, (_, index) => run(dir, `r${index}`, `2026-10-0${index + 1}T00:00:00Z`));
    for (const each of runs) recordRun(dir, each, { keep: true });
    expect(existsSync(runs[0]!.chats[0]!.sessionFile)).toBe(true);
  });

  it("forgets a chat closed, deleting its conversation, and the file with the last chat", () => {
    const dir = project();
    const only = run(dir, "only", "2026-10-01T00:00:00Z", 2);
    recordRun(dir, only);
    forgetChat(dir, "only", only.chats[0]);
    expect(existsSync(only.chats[0]!.sessionFile)).toBe(false);
    expect(lastRun(dir)?.chats.map((chat) => chat.id)).toEqual(["only1"]);
    forgetChat(dir, "only", only.chats[1]);
    expect(existsSync(chatsFile(dir))).toBe(false);
  });

  it("drops a run another took over, leaving its conversations for the run that reopened them", () => {
    const dir = project();
    const saved = run(dir, "saved", "2026-10-01T00:00:00Z");
    recordRun(dir, saved);
    adoptRun(dir, "saved");
    expect(lastRun(dir)).toBeUndefined();
    expect(existsSync(saved.chats[0]!.sessionFile)).toBe(true);
  });
});
