import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { ParseError, TokenizationError } from "liquidjs";
import { PlainSyntaxError } from "./errors.ts";
import { createEnvironment } from "./liquid.ts";

/** Ports of the Python reference implementation's file helpers this parser needs. */

export function openFrom(dirs: string[], fileName: string): string | null {
  const path = findIn(dirs, fileName);
  if (path === null) return null;
  const text = readFileSync(path, "utf8");
  noted?.set(resolve(path), text);
  return text;
}

/** The file `openFrom` reads: the first of the folders that has it. */
export function findIn(dirs: string[], fileName: string): string | null {
  for (const dir of dirs) {
    const fullPath = join(dir, fileName);
    if (isFile(fullPath)) return fullPath;
  }
  return null;
}

/** Whether there is a file at `path` - looked for as `findIn` looks, and noted as it is. */
export function isFile(path: string): boolean {
  let found: boolean;
  try {
    found = statSync(path).isFile();
  } catch {
    found = false;
  }
  const at = resolve(path);
  if (noted !== undefined && !noted.has(at)) noted.set(at, found ? FOUND : MISSING);
  return found;
}

const FOUND = Symbol("found");
const MISSING = Symbol("missing");

/** What a parse read, while `noteReads` runs: each file it looked for - its text, there, or not there. */
export type Reads = Map<string, string | typeof FOUND | typeof MISSING>;
let noted: Reads | undefined;

/** `run`, with every file it looked for and read through these helpers noted - an inner run's in the outer's too. */
export function noteReads<T>(run: () => T): { value: T; reads: Reads } {
  const outer = noted;
  const mine: Reads = new Map();
  noted = mine;
  try {
    return { value: run(), reads: mine };
  } finally {
    noted = outer;
    if (outer !== undefined) addReads(outer, mine);
  }
}

/** Reads made before - a kept result's - counted in the run noting now, as if made again. */
export function addReads(into: Reads | undefined = noted, reads: Reads): void {
  if (into === undefined) return;
  for (const [path, what] of reads) if (!into.has(path) || typeof what === "string") into.set(path, what);
}

/** Whether each file noted is still as it was: the same text, still there, still not there. */
export function readsHold(reads: Reads): boolean {
  for (const [path, was] of reads) {
    if (typeof was === "string") {
      try {
        if (readFileSync(path, "utf8") !== was) return false;
      } catch {
        return false;
      }
      continue;
    }
    let there: boolean;
    try {
      there = statSync(path).isFile();
    } catch {
      there = false;
    }
    if (there !== (was === FOUND)) return false;
  }
  return true;
}

/**
 * Port of loaders.relative_resource_path: the path of `target` in `resourceDir`, relative to `baseDir`, with `/` as
 * separator. The folder part is computed lexically and the target is appended as written (`..` kept), so joining
 * the result onto `baseDir` names the same file as joining `target` onto `resourceDir`.
 */
export function relativeResourcePath(baseDir: string, resourceDir: string, target: string): string {
  const relativeDir = relative(resolve(baseDir), resolve(resourceDir));
  if (relativeDir === "") return target;
  if (isAbsolute(relativeDir)) return join(resourceDir, target).split(sep).join("/");
  return `${relativeDir.split(sep).join("/")}/${target}`;
}

const MAX_BASE64_BLOB_LENGTH = 8192;
const BASE64_BLOB_PATTERN = new RegExp(
  `(?:data:[\\w.+-]+/[\\w.+-]+;base64,)?[A-Za-z0-9+/_-]{${MAX_BASE64_BLOB_LENGTH},}={0,2}`,
);

/** First contiguous base64 blob at or above the threshold, or null. */
export function findLargeBase64Blob(text: string): string | null {
  const match = BASE64_BLOB_PATTERN.exec(text);
  return match ? match[0] : null;
}

/**
 * Render once against the filesystem to discover which templates the source pulls in.
 *
 * The rendered text is discarded by the caller; what matters is the map of template
 * name to raw source, which is what the second (real) render is given so that it does
 * not touch the filesystem again.
 */
export function getLoadedTemplates(
  templateDirs: string[],
  plainSource: string,
  templateName?: string,
): [string, Record<string, string>] {
  const loadedTemplates: Record<string, string> = {};

  const engine = createEnvironment({
    strictVariables: true,
    loadTemplateSource: (name) => {
      const source = openFrom(templateDirs, name);
      if (source === null) return null;
      loadedTemplates[name] = source;
      return source;
    },
  });

  let rendered: string;
  try {
    rendered = engine.parseAndRenderSync(plainSource, {});
  } catch (error) {
    if (error instanceof TokenizationError || error instanceof ParseError) {
      throw new PlainSyntaxError(liquidErrorMessage(error, templateName));
    }
    const message = error instanceof Error ? error.message : String(error);
    if (/undefined variable/i.test(message)) {
      throw new Error(`Undefined liquid variable: ${message}`);
    }
    throw error;
  }

  return [rendered, loadedTemplates];
}

/**
 * Port of loaders.liquid_error_message: a Liquid syntax error as a ***plain one, naming the template, and the line
 * and the column (counted from 0) of the token it is at. The message after it is liquidjs's, without the position
 * liquidjs appends - it phrases its errors differently from liquid2, and places some of them elsewhere.
 */
export function liquidErrorMessage(error: Error & { token?: { begin?: number; input?: string } }, templateName?: string): string {
  const message = error.message.replace(/, line:\d+, col:\d+$/, "");
  const token = error.token;
  let where: string;
  if (token?.input === undefined || token.begin === undefined || token.begin < 0) {
    where = templateName ? ` in ${templateName}` : "";
  } else {
    const line = (token.input.slice(0, token.begin).match(/\n/g) ?? []).length + 1;
    const column = token.begin - (token.input.lastIndexOf("\n", token.begin - 1) + 1);
    where = templateName ? ` at ${templateName}:${line}:${column}` : ` at ${line}:${column}`;
  }
  return `Plain syntax error: Invalid Liquid${where}: ${message}`;
}
