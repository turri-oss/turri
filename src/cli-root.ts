import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ClientInfo } from "@turri-dev/core";

/**
 * This turri: the package the person runs - its version and clone, its themes and art, a global pi extension file that
 * names it. The core is told who runs it (`client`) as the session opens; everything else here is the CLI's own.
 *
 * Kept free of pi - every core entry but /plain loads it - so the CLI can ask it before pi loads.
 */

/** The CLI's package: its themes, art and docs are read from here. */
export const CLI_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** pi's own folder, where an older turri wrote its global extension and themes. */
export const AGENT_DIR = join(homedir(), ".pi", "agent");

/** turri's version, and the commit when it runs from a clone. */
export function turriIdentity(): { version: string | null; git_commit: string | null; git_dirty: boolean | null } {
  let version: string | null = null;
  try {
    version = (JSON.parse(readFileSync(join(CLI_ROOT, "package.json"), "utf8")) as { version?: string }).version ?? null;
  } catch {
    /* no package.json: left out */
  }
  if (!existsSync(join(CLI_ROOT, ".git"))) return { version, git_commit: null, git_dirty: null };
  const commit = spawnSync("git", ["-C", CLI_ROOT, "rev-parse", "HEAD"], { encoding: "utf8" });
  const status = spawnSync("git", ["-C", CLI_ROOT, "status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" });
  return {
    version,
    git_commit: commit.status === 0 ? commit.stdout.trim() : null,
    git_dirty: status.status === 0 ? status.stdout.trim() !== "" : null,
  };
}

/** Who runs turri, as the core is told it: the banner shows it, the ledger and run reports record it. */
export function clientInfo(identity: ReturnType<typeof turriIdentity> = turriIdentity()): ClientInfo {
  return {
    name: "turri",
    version: identity.version ?? "0.0.0",
    ...(identity.git_commit !== null ? { commit: identity.git_commit } : {}),
    ...(identity.git_dirty !== null ? { changed: identity.git_dirty } : {}),
  };
}

/**
 * What `turri --version` prints: turri's version - from a clone, its commit too, as the banner says it - and the core's
 * and pi's beside it. pi's own `--version` says only pi's, which read as turri's.
 */
export function versionLine(core: CoreVersion, identity: ReturnType<typeof turriIdentity> = turriIdentity()): string {
  const clone = (commit: string | null, changed: boolean | null) => (commit !== null ? `, from a clone, ${commit.slice(0, 7)}${changed === true ? " with changes" : ""}` : "");
  const under = [
    ...(core.version !== null ? [`core ${core.version}${clone(core.commit, core.changed)}`] : []),
    ...(core.pi !== null ? [`pi ${core.pi}`] : []),
  ];
  return `turri ${identity.version ?? "0.0.0"}${clone(identity.git_commit, identity.git_dirty)}${under.length > 0 ? ` (${under.join("; ")})` : ""}`;
}

/** The core's version as `/system`'s coreVersion gives it - and the pi under it. */
export interface CoreVersion {
  version: string | null;
  commit: string | null;
  changed: boolean | null;
  pi: string | null;
}

/** The global pi extension file that loads turri into every `pi`, if there is one - an older `turri setup` wrote it. */
export function globalExtensionFile(): string | undefined {
  const dir = join(AGENT_DIR, "extensions");
  try {
    for (const entry of readdirSync(dir)) {
      try {
        if (readFileSync(join(dir, entry), "utf8").includes(CLI_ROOT)) return join(dir, entry);
      } catch {
        // Not a file we can read; not ours.
      }
    }
  } catch {
    // No extensions directory yet.
  }
  return undefined;
}

export function extensionInstalledGlobally(): boolean {
  return globalExtensionFile() !== undefined;
}

/** turri's themes, by file name. */
export function themeFiles(): string[] {
  try {
    return readdirSync(join(CLI_ROOT, ".pi", "themes")).filter((entry) => entry.endsWith(".json"));
  } catch {
    return [];
  }
}

/**
 * Are turri's themes already installed globally? Passing --theme as well would make pi load each of them twice and
 * report a collision on startup - the global copy wins and turri's is skipped, which is noise about a duplicate turri
 * made itself.
 */
export function themesInstalledGlobally(): boolean {
  const names = themeFiles();
  return names.length > 0 && names.every((name) => existsSync(join(AGENT_DIR, "themes", name)));
}
