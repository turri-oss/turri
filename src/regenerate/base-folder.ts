import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { CONFIG_KEYS, configForSpec } from "../config.ts";
import { recordHistory } from "./lineage.ts";
import { BASE_RECORD_FILE, projectDirOf } from "./paths.ts";

export { BASE_RECORD_FILE };

/**
 * A base folder (`base-folder:` in config.turri.yaml, a stack's own in its file): what a codebase that requires no other
 * module starts from instead of nothing - an existing codebase to build on, files to use (images, animations, fonts), or
 * both. It is copied in once, before the codebase's first pulse, and never written to; what was copied is recorded beside
 * the code record, and goes up the chain with the code, so every coding agent of the chain is told where its codebase
 * started (prompt.ts). It is not kept in step: a change to it is said (`baseFolderDrift`), and a codebase regenerated from
 * scratch starts from it again. The ***plain is untouched by it: it may refer to the folder in prose, and link into it.
 */

export interface BaseRecord {
  /** The folder as `base-folder:` named it. */
  folder: string;
  /** The content of what was copied: its files' paths and bytes. */
  hash: string;
  /** The files copied, by path in the codebase. */
  files: string[];
}

/** Raised before a pulse starts when the base folder its codebase is to start from is not there. */
export class MissingBaseFolderError extends Error {
  readonly moduleName: string;

  constructor(moduleName: string, named: string, path: string) {
    super(
      [
        `Stopped before building ${moduleName}: its codebase is to start from the base folder ${named} (${CONFIG_KEYS.baseFolder}: in config.turri.yaml), ` +
          `and ${existsSync(path) ? "that is not a folder" : "there is no such folder"} - ${path}.`,
        "",
        `Make the folder, or name the right one in ${CONFIG_KEYS.baseFolder}:, by path from the project's folder - or take the key out to start from nothing. Then build again.`,
      ].join("\n"),
    );
    this.name = "MissingBaseFolderError";
    this.moduleName = moduleName;
  }
}

/** The base folder a module's codebase starts from - its stack's over the project's - as named and as a path; none when the config names none. */
export function baseFolderOf(plainFile: string): { named: string; path: string } | undefined {
  const named = configForSpec(plainFile).baseFolder;
  if (named === undefined) return undefined;
  return { named, path: resolve(projectDirOf(resolve(plainFile)), named) };
}

/** Folders never copied from a base folder that git does not keep: its history, installed dependencies, caches. */
const NOT_COPIED = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".turri", "plain_modules"]);

/**
 * The files of a base folder, by path in it, sorted: in a git work tree what git sees - tracked, and untracked that it
 * does not ignore - so no dependencies or build output; otherwise every file but those of the folders never copied.
 */
export function baseFiles(folder: string): string[] {
  const inGit = spawnSync("git", ["-C", folder, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8" });
  if (inGit.status === 0 && inGit.stdout.trim() === "true") {
    const listed = spawnSync("git", ["-C", folder, "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "."], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    if (listed.status === 0) {
      // A tracked file deleted in the work tree is listed, and not there to copy.
      return [...new Set(listed.stdout.split("\0").filter((path) => path !== ""))].filter((path) => isFile(join(folder, path))).sort();
    }
  }
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (NOT_COPIED.has(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else found.push(relative(folder, full).split(sep).join("/"));
    }
  };
  walk(folder);
  return found.sort();
}

const isFile = (path: string) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/** What a base folder holds now, as one hash: each file's path and bytes. */
export function hashBase(folder: string, files: string[] = baseFiles(folder)): string {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file).update("\0");
    hash.update(readFileSync(join(folder, file))).update("\0");
  }
  return hash.digest("hex");
}

/** What a codebase started from, when it started from a base folder. */
export function readBaseRecord(buildDir: string): BaseRecord | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(buildDir, BASE_RECORD_FILE), "utf8")) as BaseRecord;
    return typeof parsed.folder === "string" && typeof parsed.hash === "string" && Array.isArray(parsed.files) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Carry what a codebase started from up to one built on it, with its code (requires.ts copyRequiredCode). */
export function carryBaseRecord(from: string, to: string): void {
  if (existsSync(join(from, BASE_RECORD_FILE)) && !existsSync(join(to, BASE_RECORD_FILE))) copyFileSync(join(from, BASE_RECORD_FILE), join(to, BASE_RECORD_FILE));
}

/**
 * Start an empty codebase that requires no other module from its base folder, when the config names one: the folder's
 * files copied in, what was copied recorded, and committed. Nothing when the config names none. A base folder that is not
 * there stops the pulse before it starts.
 */
export function seedFromBaseFolder(buildDir: string, plainFile: string, moduleName: string): BaseRecord | undefined {
  const base = baseFolderOf(plainFile);
  if (base === undefined) return undefined;
  if (!existsSync(base.path) || !statSync(base.path).isDirectory()) throw new MissingBaseFolderError(moduleName, base.named, base.path);
  const files = baseFiles(base.path);
  mkdirSync(buildDir, { recursive: true });
  for (const file of files) {
    const target = join(buildDir, file);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(base.path, file), target);
  }
  const record: BaseRecord = { folder: base.named, hash: hashBase(base.path, files), files };
  writeFileSync(join(buildDir, BASE_RECORD_FILE), `${JSON.stringify(record, null, 2)}\n`);
  recordHistory(buildDir, `start from the base folder ${base.named}`, `${files.length} file${files.length === 1 ? "" : "s"} copied in`);
  return record;
}

/**
 * How a codebase's base folder stands against what it started from: undefined when they agree, or it started from none
 * and the config names none; otherwise a line saying what moved - the folder named now another, its files changed, or
 * it gone - and that regenerating from scratch starts again from it.
 */
export function baseFolderDrift(buildDir: string, plainFile: string): string | undefined {
  const record = readBaseRecord(buildDir);
  const base = baseFolderOf(plainFile);
  const again = "regenerate it from scratch to start again from it";
  if (record === undefined) {
    if (base === undefined) return undefined;
    if (existsSync(buildDir) && readdirSync(buildDir).length > 0) return `its base folder is ${base.named}, but its codebase did not start from one - ${again}`;
    return existsSync(base.path) && statSync(base.path).isDirectory() ? undefined : `its base folder ${base.named} is not there - its first pulse stops until it is`;
  }
  if (base === undefined) return `its codebase started from the base folder ${record.folder}, which ${CONFIG_KEYS.baseFolder}: no longer names - it is built on what was copied`;
  if (base.named !== record.folder) return `its base folder is now ${base.named}, but its codebase started from ${record.folder} - ${again}`;
  if (!existsSync(base.path) || !statSync(base.path).isDirectory()) return `its base folder ${base.named} is gone - its codebase is built on what was copied from it`;
  return hashBase(base.path) !== record.hash ? `its base folder ${base.named} changed since its codebase started from it - ${again}` : undefined;
}

/**
 * What a codebase started from, as its coding agents are told: the base folder as named, and the files that came from
 * it that are in the codebase still - a module built on another is told those of its own. None when it started from
 * no base folder.
 */
export function baseOfCodebase(buildDir: string): { folder: string; files: string[] } | undefined {
  const record = readBaseRecord(buildDir);
  if (record === undefined) return undefined;
  return { folder: record.folder, files: record.files.filter((file) => isFile(join(buildDir, file))) };
}

/**
 * Where a file the ***plain links is in the codebase, when it is one the base folder held and the codebase has still:
 * its path there - the agent uses it from there, and never copies it. The base folder is the one the codebase started
 * from, by its record, from the project's folder.
 */
export function inCodebaseOf(file: string, buildDir: string, plainFile: string): string | undefined {
  const base = baseOfCodebase(buildDir);
  if (base === undefined) return undefined;
  const at = relative(resolve(projectDirOf(resolve(plainFile)), base.folder), resolve(file)).split(sep).join("/");
  return !at.startsWith("../") && at !== ".." && base.files.includes(at) ? at : undefined;
}

/** A base folder named for a module and not there: what `validate` and `doctor` say of it. None when it is there, or none is named. */
export function missingBaseFolder(plainFile: string): string | undefined {
  const base = baseFolderOf(plainFile);
  if (base === undefined || (existsSync(base.path) && statSync(base.path).isDirectory())) return undefined;
  return `its base folder ${base.named} (${CONFIG_KEYS.baseFolder}:) is ${existsSync(base.path) ? "not a folder" : "not there"} - its codebase's first pulse stops until it is`;
}
