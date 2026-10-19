import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * What turri needs from the machine it runs on, found out without changing anything.
 *
 * Kept free of heavy imports so the CLI can ask these questions before it has loaded pi - and so `turri doctor` can report a missing piece instead of crashing on it.
 */

export const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const AGENT_DIR = join(homedir(), ".pi", "agent");

/** The oldest Node that runs .ts files by itself, which is how turri runs. */
export const MIN_NODE = [22, 19] as const;

export function nodeVersionOk(version: string = process.versions.node): boolean {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  return major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
}

/** Whether a command runs at all. */
export function runs(command: string, args: string[] = ["--version"]): boolean {
  const result = spawnSync(command, args, { stdio: "ignore", timeout: 15_000 });
  return result.status === 0;
}

/** The global pi extension file that loads turri into every `pi`, if there is one. */
export function globalExtensionFile(): string | undefined {
  const dir = join(AGENT_DIR, "extensions");
  try {
    for (const entry of readdirSync(dir)) {
      try {
        if (readFileSync(join(dir, entry), "utf8").includes(PACKAGE_ROOT)) return join(dir, entry);
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

export function themeFiles(): string[] {
  try {
    return readdirSync(join(PACKAGE_ROOT, ".pi", "themes")).filter((entry) => entry.endsWith(".json"));
  } catch {
    return [];
  }
}

/**
 * Are this project's themes already installed globally?
 *
 * Passing --theme as well would make pi load each of them twice and report a collision
 * on startup - the global copy wins and the project copy is skipped, which is noise
 * about a duplicate we created ourselves.
 */
export function themesInstalledGlobally(): boolean {
  const names = themeFiles();
  return names.length > 0 && names.every((name) => existsSync(join(AGENT_DIR, "themes", name)));
}

/** Where `turri` on the PATH points, if it is on the PATH at all. */
export function turriOnPath(): string | undefined {
  const which = spawnSync(process.platform === "win32" ? "where" : "which", ["turri"], { encoding: "utf8" });
  const found = which.status === 0 ? which.stdout.trim().split("\n")[0] : undefined;
  return found === "" ? undefined : found;
}

/** The version of the pi turri runs on, as Node finds it - undefined when it is not installed. */
export function piVersion(): string | undefined {
  try {
    // Its entry point, then up to the package.json that names it.
    for (let dir = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))); dirname(dir) !== dir; dir = dirname(dir)) {
      const file = join(dir, "package.json");
      if (!existsSync(file)) continue;
      const pkg = JSON.parse(readFileSync(file, "utf8")) as { name?: string; version?: string };
      if (pkg.name === "@earendil-works/pi-coding-agent") return pkg.version;
    }
  } catch {
    /* not installed: left out */
  }
  return undefined;
}

/**
 * What `turri --version` prints: turri's version - from a clone, its commit too, as the banner says it - and pi's
 * beside it. pi's own `--version` says only pi's, which read as turri's.
 */
export function versionLine(identity: ReturnType<typeof turriIdentity> = turriIdentity(), pi: string | null = piVersion() ?? null): string {
  const clone = identity.git_commit !== null ? `, from a clone, ${identity.git_commit.slice(0, 7)}${identity.git_dirty === true ? " with changes" : ""}` : "";
  return `turri ${identity.version ?? "0.0.0"}${clone}${pi !== null ? ` (pi ${pi})` : ""}`;
}

/** turri's version, and the commit when it runs from a clone. */
export function turriIdentity(): { version: string | null; git_commit: string | null; git_dirty: boolean | null } {
  let version: string | null = null;
  try {
    version = (JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as { version?: string }).version ?? null;
  } catch {
    /* no package.json: left out */
  }
  if (!existsSync(join(PACKAGE_ROOT, ".git"))) return { version, git_commit: null, git_dirty: null };
  const commit = spawnSync("git", ["-C", PACKAGE_ROOT, "rev-parse", "HEAD"], { encoding: "utf8" });
  const status = spawnSync("git", ["-C", PACKAGE_ROOT, "status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" });
  return {
    version,
    git_commit: commit.status === 0 ? commit.stdout.trim() : null,
    git_dirty: status.status === 0 ? status.stdout.trim() !== "" : null,
  };
}
