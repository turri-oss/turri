import { readFileSync, rmSync, writeFileSync } from "node:fs";

/**
 * turri opened again in another folder, in the same terminal, once its chat has quit: a chat works on the project of
 * the folder it was opened in, and after a capture the work is in another - `plain/`, a project of its own. `turri`
 * (cli.ts) starts the chat as a process of its own, with turri's theme, its screen and the folder's models, and names
 * it a file to write in: a chat that is to open again elsewhere writes where, with what, and quits; `turri` reads it and
 * starts the chat there as it started the first - the theme, the screen and that folder's models worked out the same.
 * A chat `turri` did not start - a host's, a desktop app's - has no file, and is never offered it.
 */

/** The file the chat `turri` started writes where it is to open again. */
export const REOPEN_FILE_ENV = "TURRI_REOPEN_FILE";

/** Said to the chat opened again, at its start: the capture whose report it tells - what the capture said of itself. */
export const REOPENED_AFTER_CAPTURE = "TURRI_REOPENED_AFTER_CAPTURE";

export interface Reopening {
  /** The folder the chat opens in. */
  dir: string;
  /** Its arguments, as `turri` takes them. */
  args: string[];
  /** What it is told at its start, in its environment. */
  env: Record<string, string>;
}

/** Whether this chat can open again in another folder: `turri` started it. */
export function canReopen(): boolean {
  return (process.env[REOPEN_FILE_ENV] ?? "") !== "";
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
