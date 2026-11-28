import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { relative } from "node:path";

/**
 * turri opened again in another folder, in the same terminal, once its chat has quit: a chat works on the project of
 * the folder it was opened in, and after a capture the work is in another - `plain/`, a project of its own. `turri`
 * (cli.ts) starts the chat as a process of its own, with turri's theme, its screen and the folder's models, and names
 * it a file to write in: a chat that is to open again elsewhere writes where, with what, and quits; `turri` reads it and
 * starts the chat there as it started the first. The session's `openProject` asks for it (terminal-view.ts); the chat
 * opened again tells the capture's report (`createTurri({ captured })`). The handoff is the CLI's own, between its two
 * processes: the core knows nothing of it.
 */

/** The file the chat `turri` started writes where it is to open again. */
export const REOPEN_FILE_ENV = "TURRI_CLI_REOPEN_FILE";

/** Said to the chat opened again after a capture, at its start: what the capture said of itself. */
export const CAPTURED_ENV = "TURRI_CLI_CAPTURED";

export interface Reopening {
  /** The folder the chat opens in. */
  dir: string;
  /** Its arguments, as `turri` takes them. */
  args: string[];
  /** What it is told at its start, in its environment. */
  env: Record<string, string>;
}

/** Whether this chat can open again in another folder: `turri` started it. */
export function canReopen(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env[REOPEN_FILE_ENV] ?? "") !== "";
}

/** Ask `turri` to open the chat again in `dir` once it has quit - the caller quits it. False when it cannot (`canReopen`). */
export function reopenIn(dir: string, options: { args?: string[]; env?: Record<string, string> } = {}): boolean {
  const file = process.env[REOPEN_FILE_ENV];
  if (file === undefined || file === "") return false;
  const reopening: Reopening = { dir, args: options.args ?? [], env: options.env ?? {} };
  writeFileSync(file, JSON.stringify(reopening));
  return true;
}

/** What the chat that quit asked for, taken - its file removed - or undefined when it asked for nothing. */
export function takeReopening(file: string): Reopening | undefined {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  rmSync(file, { force: true });
  try {
    const parsed = JSON.parse(text) as Partial<Reopening>;
    if (typeof parsed.dir !== "string" || !Array.isArray(parsed.args) || parsed.args.some((arg) => typeof arg !== "string")) return undefined;
    const env = Object.fromEntries(Object.entries(parsed.env ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    return { dir: parsed.dir, args: parsed.args as string[], env };
  } catch {
    return undefined;
  }
}

/** What the chat opened again after a capture is told at its start, in its environment. */
export function capturedEnv(summary: string): Record<string, string> {
  return { [CAPTURED_ENV]: JSON.stringify({ summary }) };
}

/** The capture a chat opened again after it tells - taken from its environment, once - or undefined when it is not that chat. */
export function takeCaptured(env: NodeJS.ProcessEnv = process.env): { summary: string } | undefined {
  const told = env[CAPTURED_ENV];
  delete env[CAPTURED_ENV];
  if (told === undefined) return undefined;
  try {
    const parsed = JSON.parse(told) as { summary?: unknown };
    return typeof parsed.summary === "string" ? { summary: parsed.summary } : undefined;
  } catch {
    return undefined;
  }
}

/** What the person is asked once a capture in the chat ends: to open turri again in the captured project. */
export function captureOpenQuestion(cwd: string, dir: string, summary: string): { title: string; message: string } {
  const folder = `${relative(cwd, dir) || dir}/`;
  return {
    title: `Open the captured ***plain in ${folder}?`,
    message: [
      summary,
      "",
      `turri closes here and opens again in ${folder} - the captured project - where ctrl+h shows its ***plain and /regenerate builds it. Its report is told there.`,
      `Not now: it stays here, and \`cd ${folder.slice(0, -1)} && turri\` opens it later.`,
    ].join("\n"),
  };
}
