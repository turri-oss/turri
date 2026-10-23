import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Which chats a turri session has open, so `turri --continue` opens them all again, in their order: `.turri/chats.json`
 * in the project, a run a turri process. A chat is pi's session file - its conversation - with the title turri shows
 * it by; one with nothing said in it has no file, and is not recorded.
 *
 * Nothing piles up: a chat closed is gone from it, its session file deleted; a run's chats are kept until five newer
 * runs have been recorded, then deleted with it. In debug mode nothing is deleted.
 */

export interface ChatRecord {
  id: string;
  title: string;
  /** pi's session file: the chat's conversation. */
  sessionFile: string;
  /** `sentinel` for the session's sentinel. */
  role?: "sentinel";
}

export interface RunRecord {
  run: string;
  /** The turri process: a run whose process still runs is that turri's, and is never reopened by another. */
  pid: number;
  started: string;
  chats: ChatRecord[];
}

interface ChatsFile {
  runs: RunRecord[];
}

/** How many runs' chats are kept: the most recent, the one `--continue` reopens, among them. */
export const RUNS_KEPT = 5;

export function chatsFile(project: string): string {
  return join(project, ".turri", "chats.json");
}

function read(project: string): ChatsFile {
  try {
    const parsed = JSON.parse(readFileSync(chatsFile(project), "utf8")) as Partial<ChatsFile>;
    return { runs: Array.isArray(parsed.runs) ? parsed.runs.filter((run) => typeof run?.run === "string" && Array.isArray(run.chats)) : [] };
  } catch {
    return { runs: [] };
  }
}

function write(project: string, file: ChatsFile): void {
  const path = chatsFile(project);
  try {
    if (file.runs.length === 0) {
      rmSync(path, { force: true });
      return;
    }
    mkdirSync(dirname(path), { recursive: true });
    // Whole or not at all: two turris may write it.
    const partial = `${path}.${process.pid}.tmp`;
    writeFileSync(partial, `${JSON.stringify(file, null, 2)}\n`);
    renameSync(partial, path);
  } catch {
    // A chat not recorded is not reopened; nothing else is lost.
  }
}

function deleteSession(file: string): void {
  try {
    rmSync(file, { force: true });
  } catch {
    /* gone already, or not ours to delete */
  }
}

function alive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The runs recorded here, the most recent first. */
export function recordedRuns(project: string): RunRecord[] {
  return [...read(project).runs].sort((a, b) => b.started.localeCompare(a.started));
}

/**
 * The run `--continue` reopens: the most recent whose turri has ended and that has a chat whose conversation is still
 * there. Its chats, in their order, those still there alone.
 */
export function lastRun(project: string): RunRecord | undefined {
  for (const run of recordedRuns(project)) {
    if (alive(run.pid)) continue;
    const chats = run.chats.filter((chat) => existsSync(chat.sessionFile));
    if (chats.length > 0) return { ...run, chats };
  }
  return undefined;
}

/**
 * This run's record: its chats written as they are now, in their order, and the runs past the newest RUNS_KEPT dropped
 * with their conversations - unless `keep`, in debug mode.
 */
export function recordRun(project: string, run: RunRecord, options: { keep?: boolean } = {}): void {
  const file = read(project);
  const others = file.runs.filter((other) => other.run !== run.run).sort((a, b) => b.started.localeCompare(a.started));
  const runs = [run, ...others].filter((other) => other.chats.length > 0);
  const kept = options.keep === true ? runs : runs.filter((other, index) => index < RUNS_KEPT || alive(other.pid));
  if (options.keep !== true) {
    for (const dropped of runs.filter((other) => !kept.includes(other))) for (const chat of dropped.chats) deleteSession(chat.sessionFile);
  }
  write(project, { runs: kept });
}

/** A run's record taken over by this one: its chats are this run's now, and it is gone. */
export function adoptRun(project: string, adopted: string): void {
  const file = read(project);
  write(project, { runs: file.runs.filter((run) => run.run !== adopted) });
}

/** A chat closed: out of its run's record, and its conversation deleted - unless `keep`, in debug mode. */
export function forgetChat(project: string, run: string, chat: ChatRecord | undefined, options: { keep?: boolean } = {}): void {
  if (chat === undefined) return;
  const file = read(project);
  write(project, {
    runs: file.runs.map((other) => (other.run === run ? { ...other, chats: other.chats.filter((kept) => kept.id !== chat.id) } : other)).filter((other) => other.chats.length > 0),
  });
  if (options.keep !== true) deleteSession(chat.sessionFile);
}
