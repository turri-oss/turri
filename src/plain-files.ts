import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createEditToolDefinition, createWriteToolDefinition, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { readProjectConfig, stacksOf } from "./config.ts";
import { parseMarkdown } from "./plain/markdown.ts";
import { hasScheme, linksIn } from "./plain/parser.ts";
import { insideAny } from "./regenerate/confine.ts";
import { credentialRefusal, isCredentialFile } from "./regenerate/credentials.ts";
import { DIST_DIR, MODULES_DIR } from "./regenerate/paths.ts";
import { PREPARE_NAME, SCRIPTS_DIR, scriptKind } from "./regenerate/test-scripts.ts";

/** A config.turri.yaml, a stack's config.turri.<stack>.yaml - what the project's testing scripts are named in. */
const TURRI_CONFIG_NAME = /^config\.turri(\.[^/]+)?\.yaml$/;

/** Folders that hold what is built, installed or turri's own - never the project's ***plain. */
function outsidePlain(path: string): boolean {
  const parts = path.split(sep);
  return parts[0] === DIST_DIR || parts.some((part) => part.startsWith(".") || part === MODULES_DIR || part === "node_modules" || part === "__pycache__");
}

/**
 * The project's ***plain and what it is built with, and a digest of each: its .plain files, the resources they link,
 * its testing scripts and its config.turri*.yaml. Nothing else is a skill's to change - not the built code, a release,
 * what a running app writes. `also`: paths that were among them before, digested while they are there, so one a skill
 * stopped linking or naming is still seen if it changed it.
 */
export function projectFiles(root: string, also: Iterable<string> = []): Map<string, string> {
  const all: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 8) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === MODULES_DIR || entry.name === "node_modules" || entry.name === "__pycache__") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path, depth + 1);
      else if (entry.isFile()) all.push(relative(root, path));
    }
  };
  walk(root, 0);

  const wanted = new Set<string>(also);
  const named = (path: string | undefined) => {
    if (path !== undefined && path.trim() !== "") wanted.add(relative(root, resolve(root, path.trim())));
  };
  for (const path of all) {
    const name = basename(path);
    if (path.split(sep)[0] === SCRIPTS_DIR || scriptKind(name) !== undefined || PREPARE_NAME.test(name) || TURRI_CONFIG_NAME.test(name)) wanted.add(path);
    if (!path.endsWith(".plain")) continue;
    wanted.add(path);
    // The resources it links, as the parser reads its links: from the project's folder.
    try {
      for (const { target } of linksIn(parseMarkdown(readFileSync(join(root, path), "utf8")))) {
        if (target !== "" && !hasScheme(target) && !isAbsolute(target)) named(target);
      }
    } catch {
      // A file that cannot be read links nothing.
    }
  }
  // Scripts config.turri*.yaml names, whatever they are called.
  for (const stack of [undefined, ...stacksOf(root)]) {
    const config = readProjectConfig(root, stack);
    named(config.unittestsScript);
    named(config.conformanceTestsScript);
    named(config.prepareEnvironmentScript);
  }

  const files = new Map<string, string>();
  for (const path of wanted) {
    if (path.startsWith("..") || isAbsolute(path) || path.split(sep).includes(MODULES_DIR)) continue;
    try {
      files.set(path, createHash("sha1").update(readFileSync(join(root, path))).digest("hex"));
    } catch {
      // A file that cannot be read, or is not there, is left out.
    }
  }
  return files;
}

/** The files added, changed or removed between two digests of the project. */
export function changedFiles(before: Map<string, string>, after: Map<string, string>): string[] {
  const changed = [...after].filter(([path, digest]) => before.get(path) !== digest).map(([path]) => path);
  const removed = [...before.keys()].filter((path) => !after.has(path)).map((path) => `${path} (removed)`);
  return [...changed, ...removed].sort();
}

/**
 * Why a skill's agent may not write a path, or nothing when it may. It writes the project's ***plain: a file of it
 * (`projectFiles`), or a new one - a resource it is about to link, a testing script - anywhere in the project but where
 * what is built, released or installed lives. Never an existing file that is not the ***plain's: the code, a release,
 * what an app it started writes.
 */
export function plainWriteRefusal(root: string, path: string): string | undefined {
  const absolute = resolve(root, path);
  if (!insideAny(absolute, [root])) return `${absolute} is outside the project. A skill writes the project's ***plain, and nothing else.`;
  if (isCredentialFile(absolute)) return credentialRefusal(absolute);
  const inProject = relative(resolve(root), absolute);
  if (outsidePlain(inProject)) {
    return (
      `${inProject} is not the project's ***plain - ${MODULES_DIR}/, ${DIST_DIR}/ and the hidden folders hold what is ` +
      "built, released and installed, and turri's own. A skill writes .plain files, the resources they link and the testing scripts."
    );
  }
  if (existsSync(absolute) && !projectFiles(root).has(inProject)) {
    return (
      `${inProject} is not the project's ***plain: no .plain file links it, and it is not a testing script or a ` +
      "config.turri*.yaml. A skill changes only those - link a resource from the ***plain before changing it."
    );
  }
  return undefined;
}

type AnyTool = ToolDefinition<any, any, any>;

/** pi's write and edit for a skill's agent: each path checked by `plainWriteRefusal` - as given, and as the tool resolved it. */
export function plainWriteTools(root: string): AnyTool[] {
  const check = (path: string | undefined) => {
    if (path === undefined) return;
    const refusal = plainWriteRefusal(root, path.trim().replace(/^@/, ""));
    if (refusal !== undefined) throw new Error(refusal);
  };
  const guard = (def: AnyTool): AnyTool => ({
    ...def,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      check((params as { path?: string }).path);
      return def.execute(toolCallId, params, signal, onUpdate, ctx);
    },
  });
  return [
    guard(
      createWriteToolDefinition(root, {
        operations: {
          writeFile: async (path, content) => (check(path), writeFileSync(path, content)),
          // A folder that is there already is not written: only where it would be made is checked.
          mkdir: async (dir) => {
            if (!existsSync(dir)) check(dir);
            mkdirSync(dir, { recursive: true });
          },
        },
      }),
    ),
    guard(
      createEditToolDefinition(root, {
        operations: {
          readFile: async (path) => (check(path), readFileSync(path)),
          writeFile: async (path, content) => (check(path), writeFileSync(path, content)),
          access: async (path) => check(path),
        },
      }),
    ),
  ];
}
