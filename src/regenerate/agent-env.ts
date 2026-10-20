import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { DEFAULT_CACHE_KEEP_MB, readProjectConfig, stackOf } from "../config.ts";
import { registerSecrets } from "./masking.ts";
import { projectRootOf, modulesScratchDir } from "./paths.ts";

/**
 * The environment every agent command gets, on this machine.
 *
 * Not the host's: the shell turri was started in holds the providers' API keys, cloud credentials, tokens and an SSH
 * agent, and an agent's command - or the code it runs - could read any of them. So only an allow-list passes: the path,
 * the locale, the terminal, the user, and the variables that locate the host's toolchains. Then turri's own: a HOME of
 * the module's own, kept between pulses, so a tool's settings and an agent's dotfiles never land in the person's; a
 * TMPDIR; the package caches in the project, so a dependency downloads once - held to `cache-keep:`; and git stopped
 * at the module, so a project that is itself a repository is not found from the code. Last, what the project passes on
 * purpose - `agent-env:` in its config - which never replaces turri's own.
 */

/** Passed from the host as they are. */
const ALLOWED = ["PATH", "LANG", "TERM", "TZ", "USER", "LOGNAME", "COLORTERM"];
const ALLOWED_PREFIXES = ["LC_"];

/**
 * The variables that locate a toolchain, each with where it is in the person's home when the host sets none - a fake
 * HOME would otherwise hide it. Without a default, only the host's.
 */
const TOOLCHAIN_LOCATORS: Record<string, string | undefined> = {
  JAVA_HOME: undefined,
  GOROOT: undefined,
  GOPATH: undefined,
  DOTNET_ROOT: undefined,
  ANDROID_HOME: undefined,
  ANDROID_SDK_ROOT: undefined,
  FLUTTER_ROOT: undefined,
  M2_HOME: undefined,
  MAVEN_HOME: undefined,
  GRADLE_HOME: undefined,
  RUSTUP_HOME: ".rustup",
  NVM_DIR: ".nvm",
  PYENV_ROOT: ".pyenv",
  SDKMAN_DIR: ".sdkman",
  VOLTA_HOME: ".volta",
  ASDF_DATA_DIR: ".asdf",
  // mise and fnm keep their installs under ~/.local/share; uv the Pythons it fetches.
  MISE_DATA_DIR: ".local/share/mise",
  FNM_DIR: ".local/share/fnm",
  RBENV_ROOT: ".rbenv",
  UV_PYTHON_INSTALL_DIR: ".local/share/uv/python",
  BUN_INSTALL: ".bun",
  PNPM_HOME: undefined,
};

/** The variables that locate a toolchain - their folders are what the OS sandbox lets a command read of the person's. */
export const TOOLCHAIN_VARIABLES: string[] = Object.keys(TOOLCHAIN_LOCATORS);

/** Where package managers keep their caches: in the project's scratch area, so a dependency downloads once. */
export function packageCacheDir(dir: string): string {
  return join(modulesScratchDir(dir), "cache");
}

/** Every package manager's cache, pointed into `cache`. */
export function cacheEnv(cache: string): Record<string, string> {
  return {
    XDG_CACHE_HOME: cache,
    MAVEN_OPTS: `-Dmaven.repo.local=${join(cache, "m2")}`,
    GRADLE_USER_HOME: join(cache, "gradle"),
    CARGO_HOME: join(cache, "cargo"),
    npm_config_cache: join(cache, "npm"),
    // node-gyp's headers, which it keeps in the home folder - a copy each module's - once for the project.
    npm_config_devdir: join(cache, "node-gyp"),
    YARN_CACHE_FOLDER: join(cache, "yarn"),
    PIP_CACHE_DIR: join(cache, "pip"),
    UV_CACHE_DIR: join(cache, "uv"),
    GOCACHE: join(cache, "go-build"),
    GOMODCACHE: join(cache, "go-mod"),
    // The browsers the end-to-end test tools download - hundreds of megabytes each, kept in the home folder: once for
    // the project, not once a module.
    PLAYWRIGHT_BROWSERS_PATH: join(cache, "ms-playwright"),
    PUPPETEER_CACHE_DIR: join(cache, "puppeteer"),
    CYPRESS_CACHE_FOLDER: join(cache, "Cypress"),
  };
}

/** The git identity an agent's commits in a scratch repository get - never the person's. */
const GITCONFIG = "[user]\n\tname = turri\n\temail = turri@localhost\n[init]\n\tdefaultBranch = main\n";

/** A credential `agent-env:` names that is not there. */
export interface MissingCredential {
  /** The file or the variable. */
  name: string;
  why: string;
}

export interface AgentEnvironment {
  /** The whole environment of an agent's command. */
  env: Record<string, string>;
  /** The names of what `agent-env:` passed, sorted - for the prompt, never the values. */
  passed: string[];
  /** The values `agent-env:` passed, by name - what is masked wherever turri shows or writes output. */
  values: Record<string, string>;
  /** What `agent-env:` names that is not there. */
  missing: MissingCredential[];
}

/**
 * The environment of a command an agent runs in `moduleDir` - `plain_modules/<module>`. `hostEnv`: the environment
 * turri was started in; `home`: the person's home folder.
 */
export function agentEnvironment(moduleDir: string, options: { hostEnv?: NodeJS.ProcessEnv; home?: string } = {}): AgentEnvironment {
  const hostEnv = options.hostEnv ?? process.env;
  const home = options.home ?? homedir();
  const module = resolve(moduleDir);
  const name = basename(module);

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(hostEnv)) {
    if (value === undefined) continue;
    if (ALLOWED.includes(key) || ALLOWED_PREFIXES.some((prefix) => key.startsWith(prefix))) env[key] = value;
  }
  for (const [key, inHome] of Object.entries(TOOLCHAIN_LOCATORS)) {
    const given = hostEnv[key];
    if (given !== undefined && given !== "") env[key] = given;
    else if (inHome !== undefined && existsSync(join(home, inHome))) env[key] = join(home, inHome);
  }

  const { values, missing } = passedCredentials(module, hostEnv);
  // From now on their values are masked in everything an agent is shown and turri writes.
  registerSecrets(values);
  Object.assign(env, values);
  Object.assign(env, turrisOwn(module, name));
  return { env, passed: Object.keys(values).sort(), values, missing };
}

/** The scratch areas whose caches this process has held to `cache-keep:`: once a run, before its first command. */
const tidied = new Set<string>();

/** Where in an agent's home folder its tools keep caches of their own. */
const HOME_CACHES = [join("Library", "Caches"), ".cache"];

/**
 * Hold the package caches of a scratch area to `keepMb` megabytes: past it, the caches least recently written go whole -
 * a package manager's folder in `cache`, or a tool's in an agent's home - until it is under. A cache is as recent as the
 * newest thing written anywhere in it: a package manager writes deep inside its folder, never beside it. What goes is
 * downloaded again when it is wanted. Never a reason for the work to fail.
 */
export function tidyCaches(scratch: string, keepMb: number): void {
  const caches: Array<{ path: string; bytes: number; written: number }> = [];
  const folders = [join(scratch, "cache")];
  for (const home of entries(join(scratch, "home"))) for (const inHome of HOME_CACHES) folders.push(join(scratch, "home", home, inHome));
  for (const folder of folders) {
    for (const name of entries(folder)) {
      const path = join(folder, name);
      try {
        caches.push({ path, ...measure(path) });
      } catch {
        /* gone meanwhile */
      }
    }
  }
  let total = caches.reduce((sum, cache) => sum + cache.bytes, 0);
  for (const cache of caches.sort((a, b) => a.written - b.written)) {
    if (total <= keepMb * 1024 * 1024) break;
    total -= cache.bytes;
    // What could not be removed still counts: a cache half gone is not the room it took.
    if (existsSync(cache.path)) total += remove(cache.path);
  }
}

function entries(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** A file's or folder's bytes and when anything in it was last written, its links not followed. */
function measure(path: string): { bytes: number; written: number } {
  const stat = lstatSync(path);
  if (!stat.isDirectory()) return { bytes: stat.size, written: stat.mtimeMs };
  let bytes = 0;
  let written = stat.mtimeMs;
  for (const name of entries(path)) {
    try {
      const inside = measure(join(path, name));
      bytes += inside.bytes;
      written = Math.max(written, inside.written);
    } catch {
      /* gone meanwhile */
    }
  }
  return { bytes, written };
}

/**
 * Remove a cache whole, and say how many of its bytes are left. Some tools make what they cache read-only - Go's module
 * cache, so it is never edited in place - and a folder that cannot be written cannot be emptied: each is made writable
 * first, as `go clean -modcache` does.
 */
function remove(path: string): number {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    writable(path);
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      /* what cannot be removed stays */
    }
  }
  try {
    return existsSync(path) ? measure(path).bytes : 0;
  } catch {
    return 0;
  }
}

/** Every folder under `path` made writable by its owner, links not followed. */
function writable(path: string): void {
  try {
    const stat = lstatSync(path);
    if (!stat.isDirectory()) return;
    chmodSync(path, stat.mode | 0o700);
  } catch {
    return;
  }
  for (const name of entries(path)) writable(join(path, name));
}

/** HOME, TMPDIR, the caches and git's ceiling: what no setting of the project's replaces. */
function turrisOwn(module: string, name: string): Record<string, string> {
  const scratch = modulesScratchDir(module);
  if (!tidied.has(scratch)) {
    tidied.add(scratch);
    let keep: number = DEFAULT_CACHE_KEEP_MB;
    try {
      keep = readProjectConfig(projectRootOf(module)).cacheKeep ?? DEFAULT_CACHE_KEEP_MB;
    } catch {
      /* a config that does not parse is said elsewhere: the default holds */
    }
    tidyCaches(scratch, keep);
  }
  const fakeHome = join(scratch, "home", name);
  mkdirSync(fakeHome, { recursive: true });
  const gitconfig = join(fakeHome, ".gitconfig");
  if (!existsSync(gitconfig)) writeFileSync(gitconfig, GITCONFIG);
  const tmp = join(scratch, "tmp", name);
  mkdirSync(tmp, { recursive: true });
  // There before the first command: bubblewrap binds every writable folder, and refuses one that is not.
  mkdirSync(packageCacheDir(module), { recursive: true });
  // Java takes its temporary folder and its home from the system, not from TMPDIR and HOME - on macOS a per-user folder
  // and the person's home, both outside the sandbox. Every JVM reads JAVA_TOOL_OPTIONS, a test JVM Surefire or Gradle
  // forks too, and an agent's own MAVEN_OPTS does not replace it: Maven without its repository setting falls back to the
  // module's home, not the person's ~/.m2. (Each JVM says on stderr that it picked them up.)
  return {
    ...cacheEnv(packageCacheDir(module)),
    JAVA_TOOL_OPTIONS: `-Djava.io.tmpdir=${tmp} -Duser.home=${fakeHome}`,
    HOME: fakeHome,
    TMPDIR: tmp,
    GIT_CEILING_DIRECTORIES: module,
    ...(process.platform === "darwin" ? { [DARWIN_TEMP_SUFFIX]: darwinTempSuffix(module, name) } : {}),
  };
}

/**
 * On macOS, what a program asks the system for as the per-user temporary folder - not TMPDIR - is that folder with this
 * suffix added: a folder of the module's own inside it. The JVM keeps its attach sockets there (`.java_pid<pid>`), which
 * Mockito's inline mocks, jcmd and jstack attach through; the sandbox reaches this folder alone, never the person's
 * JVMs' sockets beside it.
 */
export const DARWIN_TEMP_SUFFIX = "DIRHELPER_USER_DIR_SUFFIX";

/** The module's own folder in macOS's per-user temporary folder: named for it, and for where it is. */
function darwinTempSuffix(module: string, name: string): string {
  return `turri-${name.replace(/[^\w.-]/g, "_")}-${createHash("sha256").update(resolve(module)).digest("hex").slice(0, 8)}`;
}

/** What `agent-env:` - the project's, with the chosen stack's added - passes, and what of it is not there. Reads only. */
export function passedCredentials(module: string, hostEnv: NodeJS.ProcessEnv): { values: Record<string, string>; missing: MissingCredential[] } {
  const root = projectRootOf(module);
  const setting = readProjectConfig(root, stackOf(root)).agentEnv;
  const values: Record<string, string> = {};
  const missing: MissingCredential[] = [];
  if (setting === undefined) return { values, missing };
  for (const file of setting.files) {
    const path = resolve(root, file);
    if (!existsSync(path)) {
      missing.push({ name: file, why: `no such file: ${path}` });
      continue;
    }
    Object.assign(values, parseDotenv(readFileSync(path, "utf8")));
  }
  for (const name of setting.vars) {
    const value = hostEnv[name];
    if (value === undefined) missing.push({ name, why: "not set in the environment turri was started in" });
    else if (value === "") missing.push({ name, why: "set, but empty, in the environment turri was started in" });
    else values[name] = value;
  }
  return { values, missing };
}

/** A dotenv file's variables: `KEY=value`, `export KEY=value`, quoted or not; comments and blank lines skipped. */
export function parseDotenv(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match === null) continue;
    let value = match[2]!;
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.lastIndexOf(quote) > 0) {
      value = value.slice(1, value.lastIndexOf(quote));
      if (quote === '"') value = value.replace(/\\n/g, "\n").replace(/\\"/g, '"');
    } else {
      value = value.replace(/\s+#.*$/, "");
    }
    values[match[1]!] = value;
  }
  return values;
}
