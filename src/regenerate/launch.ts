import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join, relative } from "node:path";
import { HISTORY_DIR } from "./lineage.ts";
import { NOTES_FILE } from "./notes.ts";
import { distDirFor, ensureInScratch, projectDirOf } from "./paths.ts";
import { findCodebaseTip, type ChainEntry } from "./requires.ts";
import { RECORD_FILE } from "./paths.ts";

/**
 * Launch: a codebase's code, as one of its commits has it, put out in `dist/<module>` for the person and the sentinel
 * to try - the commit a pulse landed, or the codebase's last.
 *
 * A pulse works in `plain_modules/<module>/code` while a launch runs, so what is there is half-written. A commit is not:
 * every unit of work starts from one and ends with one, and both are runnable. So the commit is exported from the
 * module's history - git's own list of what it tracks, and nothing else - without a list of what each stack leaves lying
 * around (`node_modules`, `.venv`, `target`). The working tree is never read, reset or touched: the next pulse may be
 * writing in it.
 *
 * What starts it runs here, on the person's machine, unfenced: a server the person opens in their browser, with their
 * toolchains. The launch agent installs and runs what it needs itself, as any agent with a shell would - nothing is put to
 * the person - and everything started is the harness's to stop: on the next launch, on /halt, and when turri exits.
 */

/** A codebase's code at a commit, exported - what a launch takes on from. */
export interface ExportedCode {
  /** The codebase: the module whose `plain_modules/<module>` holds the code. */
  moduleName: string;
  plainFile: string;
  /** `dist/<module>`, in the project: the commit's code. */
  dir: string;
  /** Where the module's code is built: `plain_modules/<module>/code`. */
  buildDir: string;
  /** The commit, whole. */
  commit: string;
  /** The commit, short - as the person and the agents are told it. */
  short: string;
  /** The commit's subject: what the unit of work that landed it did. */
  subject: string;
  /** When, as git says it: "3 minutes ago". */
  when: string;
  /** Work under way in the module - changes nobody committed yet - left out. */
  unfinished: boolean;
  /** The module the spec's code lives in had nothing committed yet: the nearest one below it that had, instead. */
  instead?: string;
}

function git(moduleDir: string, args: string[]) {
  return spawnSync("git", ["--git-dir", join(moduleDir, HISTORY_DIR), "--work-tree", moduleDir, ...args], { cwd: moduleDir, encoding: "utf8" });
}

/** A commit of the module's history, whole - `HEAD` its last - when it has one with code in it. */
function committedCode(moduleDir: string, commit = "HEAD"): string | undefined {
  if (!existsSync(join(moduleDir, HISTORY_DIR))) return undefined;
  const found = git(moduleDir, ["rev-parse", "--verify", "--quiet", `${commit}^{commit}`]);
  if (found.status !== 0) return undefined;
  const whole = found.stdout.trim();
  // A commit with no code folder in it has nothing to run.
  if (git(moduleDir, ["rev-parse", "--verify", "--quiet", `${whole}:code`]).status !== 0) return undefined;
  return whole;
}

/** The tree of a commit's code: two commits with the same one hold the same code - one landed only tests, say. */
export function codeTreeOf(moduleDir: string, commit: string): string | undefined {
  const tree = git(moduleDir, ["rev-parse", "--verify", "--quiet", `${commit}:code`]);
  return tree.status === 0 ? tree.stdout.trim() : undefined;
}

/** Whether `commit` holds `ancestor`: the same commit, or one built on it. */
export function holdsCommit(moduleDir: string, ancestor: string, commit: string): boolean {
  return git(moduleDir, ["merge-base", "--is-ancestor", ancestor, commit]).status === 0;
}

/**
 * Which codebase to launch for a spec, and at which commit: the tip of its codebase - code accumulates up a requires
 * chain, so the top module holds everything below it - at `commit`, or its last. Before the tip has anything committed,
 * the nearest module below it that has.
 */
export function launchTarget(plainFile: string, options: { inModule?: string; commit?: string } = {}): { entry: ChainEntry; commit: string; instead?: string } {
  const { tip, chain } = findCodebaseTip(plainFile, { allowNoFunctionalities: true, ...(options.inModule !== undefined ? { inModule: options.inModule } : {}) });
  if (options.commit !== undefined) {
    const commit = committedCode(dirname(tip.buildDir), options.commit);
    if (commit === undefined) throw new Error(`${tip.moduleName} has no commit ${options.commit} with code in it: nothing to launch.`);
    return { entry: tip, commit };
  }
  const candidates = [tip, ...[...chain].reverse().filter((entry) => entry.moduleName !== tip.moduleName)];
  for (const entry of candidates) {
    const commit = committedCode(dirname(entry.buildDir));
    if (commit !== undefined) return { entry, commit, ...(entry.moduleName !== tip.moduleName ? { instead: tip.moduleName } : {}) };
  }
  throw new Error(`Nothing is built yet for ${tip.moduleName}${candidates.length > 1 ? " or the modules it requires" : ""}: there is no code to launch. Regenerate it first.`);
}

/**
 * Export a codebase's code at a commit - its last, unless `commit` names one - into `dist/<module>`, or `into`
 * (`turri regenerate --build-dir`), replacing whatever was there, the harness's own files (what the code is built from,
 * the agents' notes) left out.
 */
export function exportModule(plainFile: string, options: { inModule?: string; into?: string; commit?: string } = {}): ExportedCode {
  const { entry, commit, instead } = launchTarget(plainFile, options);
  const moduleDir = dirname(entry.buildDir);
  const dir = options.into ?? distDirFor(projectDirOf(entry.plainFile), entry.moduleName);
  // Emptied, not removed: the folder may be a mount point - a container's volume - that cannot be removed.
  mkdirSync(dir, { recursive: true });
  for (const entry of readdirSync(dir)) rmSync(join(dir, entry), { recursive: true, force: true });
  const exported = spawnSync(
    "bash",
    ["-o", "pipefail", "-c", 'git --git-dir "$1" archive --format=tar "$2" | tar -x -f - -C "$3"', "export", join(moduleDir, HISTORY_DIR), `${commit}:code`, dir],
    { encoding: "utf8" },
  );
  if (exported.status !== 0) throw new Error(`Could not export ${entry.moduleName}'s code at ${commit.slice(0, 8)}: ${(exported.stderr ?? "").trim()}`);
  for (const file of [RECORD_FILE, NOTES_FILE]) rmSync(join(dir, file), { force: true });

  const [short, subject, when] = git(moduleDir, ["log", "-1", "--format=%h%x1f%s%x1f%cr", commit]).stdout.trim().split("\x1f");
  const unfinished = git(moduleDir, ["status", "--porcelain", "--untracked-files=all", "--", "code"]).stdout.trim() !== "";
  return {
    moduleName: entry.moduleName,
    plainFile: entry.plainFile,
    dir,
    buildDir: entry.buildDir,
    commit,
    short: short ?? commit.slice(0, 8),
    subject: subject ?? "",
    when: when ?? "",
    unfinished,
    ...(instead !== undefined ? { instead } : {}),
  };
}

/**
 * The host codebase a launch with guidance works in: the git repository the project is in - an embedded project's host -
 * or else `fallback`, where turri runs.
 */
export function hostDirOf(plainFile: string, fallback: string): string {
  const top = spawnSync("git", ["-C", projectDirOf(plainFile), "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  return top.status === 0 && top.stdout.trim() !== "" ? top.stdout.trim() : fallback;
}

/** Where a path is, said from the current directory when it is below it. */
export function shortPath(path: string): string {
  const fromHere = relative(process.cwd(), path);
  return fromHere === "" || fromHere.startsWith("..") ? path : fromHere;
}

/** What was exported, in a line or three. */
export function describeExport(code: ExportedCode): string {
  return [
    `${code.moduleName}'s code at commit ${code.short} (${code.when}: ${code.subject}) is in ${shortPath(code.dir)}.`,
    ...(code.instead !== undefined ? [`${code.instead}, the module on top, has nothing built yet - this is ${code.moduleName}, the module below it.`] : []),
    ...(code.unfinished
      ? [`A pulse is at work on the module right now: what it has written so far is not finished, and is left out of ${shortPath(code.dir)} - ${shortPath(code.buildDir)} holds it, so take the code from ${shortPath(code.dir)}, never from there.`]
      : []),
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------
// What runs on this machine.

export interface LaunchedProcess {
  name: string;
  moduleName: string;
  command: string;
  /** Where it runs. */
  dir: string;
  url?: string;
  /** Its output, both streams. */
  log: string;
  pid: number;
  startedAt: number;
  /** Set once it has ended. */
  exited?: { code: number | null; signal: string | null };
}

const processes = new Map<string, { info: LaunchedProcess; child: ChildProcess }>();

/** Everything a launch started, running or ended, oldest first. */
export function listLaunched(): LaunchedProcess[] {
  return [...processes.values()].map((entry) => entry.info);
}

/** The ones still running. */
export function runningLaunched(moduleName?: string): LaunchedProcess[] {
  return listLaunched().filter((info) => info.exited === undefined && (moduleName === undefined || info.moduleName === moduleName));
}

/** Where what a project's launches started write their output: its scratch, not the code in dist. */
export function launchLogDir(projectDir: string): string {
  const scratch = join(projectDir, ".turri");
  return ensureInScratch(scratch, join(scratch, "launch"));
}

/** The end of a log, for when something did not come up. */
export function logTail(log: string, lines = 40, chars = 4000): string {
  try {
    const text = readFileSync(log, "utf8").split("\n").slice(-lines).join("\n");
    return text.length > chars ? text.slice(-chars) : text;
  } catch {
    return "";
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    // Its own process group: the server and whatever it started.
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
}

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/** Stop one launched process, or every one of a module, or every one: politely, then not. Returns the names stopped. */
export async function stopLaunched(which: { name?: string; moduleName?: string } = {}): Promise<string[]> {
  const targets = [...processes.values()].filter(
    ({ info }) => info.exited === undefined && (which.name === undefined || info.name === which.name) && (which.moduleName === undefined || info.moduleName === which.moduleName),
  );
  for (const { info } of targets) signalGroup(info.pid, "SIGTERM");
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && targets.some(({ info }) => info.exited === undefined)) await sleep(100);
  for (const { info } of targets) if (info.exited === undefined) signalGroup(info.pid, "SIGKILL");
  return targets.map(({ info }) => info.name);
}

/** Stop everything at once, without waiting: for when turri itself is going. */
export function stopAllLaunchedNow(): void {
  for (const { info } of processes.values()) if (info.exited === undefined) signalGroup(info.pid, "SIGTERM");
}

let exitHooked = false;
function stopOnExit(): void {
  if (exitHooked) return;
  exitHooked = true;
  process.on("exit", stopAllLaunchedNow);
}

function portOf(url: URL): number {
  if (url.port !== "") return Number(url.port);
  return url.protocol === "https:" ? 443 : 80;
}

/** Whether something already answers on the port. */
function portTaken(host: string, port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect({ host: host === "0.0.0.0" ? "127.0.0.1" : host.replace(/^\[|\]$/g, ""), port });
    const finish = (taken: boolean) => {
      socket.destroy();
      done(taken);
    };
    socket.setTimeout(700, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

/** What holds a port, as lsof says it - or nothing when it cannot say. */
function holderOf(port: number): string {
  const found = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" });
  return found.status === 0 ? found.stdout.trim().split("\n").slice(0, 4).join("\n") : "";
}

async function answers(url: string): Promise<boolean> {
  try {
    await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(2000) });
    return true;
  } catch {
    return false;
  }
}

/** How long a server is given to answer at its URL, and to stay up when it has none. */
export const READY_TIMEOUT_MS = Number(process.env.TURRI_LAUNCH_READY_TIMEOUT ?? 60) * 1000;
const ALIVE_AFTER_MS = 4000;

export interface StartResult {
  ok: boolean;
  /** What happened, for the agent and the person. */
  text: string;
  process?: LaunchedProcess;
}

/**
 * Start something that keeps running - a server, a frontend's dev server - in `dir`, on this machine,
 * in its own process group, its output to a log. One already running under the name is stopped first.
 *
 * With a URL, it is ready once something answers there - any answer - and not when it exits first or
 * nothing answers in time. A port something else holds already is said, with what holds it, and
 * nothing is started: an app moved to a port of the harness's choosing would not be the one the
 * person was told about. With no URL, it only has to still be running a few seconds on.
 */
/** A folder's entries as a listing says them - folders with a slash - or that it is empty. */
function listing(dir: string): string {
  try {
    const entries = readdirSync(dir, { withFileTypes: true }).map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name)).sort();
    if (entries.length === 0) return "nothing";
    return entries.length > 40 ? `${entries.slice(0, 40).join(", ")} and ${entries.length - 40} more` : entries.join(", ");
  } catch {
    return "nothing turri can read";
  }
}

/**
 * Start what keeps running, in `dir` - the folder `root` it is named from, or one inside it. A folder that is not there
 * starts nothing: said, with what `root` holds, so the agent can name the right one.
 */
export async function startLaunched(input: { name: string; command: string; dir: string; moduleName: string; logDir: string; url?: string; root?: string }): Promise<StartResult> {
  let isFolder = false;
  try {
    isFolder = statSync(input.dir).isDirectory();
  } catch {
    /* not there */
  }
  if (!isFolder) {
    const why = existsSync(input.dir) ? "is not a folder" : "does not exist";
    return {
      ok: false,
      text:
        input.root !== undefined
          ? `${input.name} was not started: ${shortPath(input.dir)} ${why}. \`dir\` is relative to ${shortPath(input.root)} - a folder inside it, e.g. frontend, or none for the folder itself; never the project's path to it. ${shortPath(input.root)} holds: ${listing(input.root)}.`
          : `${input.name} was not started: ${shortPath(input.dir)} ${why}.`,
    };
  }
  await stopLaunched({ name: input.name });
  let url: URL | undefined;
  if (input.url !== undefined) {
    try {
      url = new URL(input.url);
    } catch {
      return { ok: false, text: `'${input.url}' is not a URL. Give the one it serves at, e.g. http://localhost:5173.` };
    }
    const port = portOf(url);
    if (await portTaken(url.hostname, port)) {
      const holder = holderOf(port);
      return {
        ok: false,
        text: `Port ${port} is in use already - by something turri did not start - so ${input.name} was not started.${holder !== "" ? `\n${holder}` : ""}\nTell the person which port and what holds it; do not move the app to another port.`,
      };
    }
  }

  mkdirSync(input.logDir, { recursive: true });
  const log = join(input.logDir, `${input.moduleName}-${input.name.replace(/[^\w.-]+/g, "-")}.log`);
  const fd = openSync(log, "w");
  const child = spawn("bash", ["-c", input.command], { cwd: input.dir, detached: true, stdio: ["ignore", fd, fd], env: process.env });
  // Listened to at once: a child's 'error' with no listener is thrown, and takes the whole process down with it.
  let info: LaunchedProcess | undefined;
  let spawnError: Error | undefined;
  const spawned = new Promise<void>((done) => {
    child.once("spawn", () => done());
    child.once("error", () => done());
  });
  child.on("error", (error) => {
    spawnError ??= error;
    if (info !== undefined) info.exited ??= { code: null, signal: null };
  });
  closeSync(fd);
  if (child.pid === undefined) {
    await spawned;
    return { ok: false, text: `${input.name} could not be started in ${shortPath(input.dir)}: ${spawnError?.message ?? "no process was made"}.` };
  }
  const started: LaunchedProcess = { name: input.name, moduleName: input.moduleName, command: input.command, dir: input.dir, log, pid: child.pid, startedAt: Date.now(), ...(input.url !== undefined ? { url: input.url } : {}) };
  info = started;
  child.on("exit", (code, signal) => {
    started.exited = { code, signal };
  });
  processes.set(input.name, { info: started, child });
  stopOnExit();

  const failed = (why: string): StartResult => {
    const tail = logTail(log);
    return { ok: false, text: `${input.name} ${why}.${tail !== "" ? `\nThe end of its output (${shortPath(log)}):\n${tail}` : ""}`, process: started };
  };
  const ended = () => `exited${started.exited?.code !== null && started.exited?.code !== undefined ? ` with ${started.exited.code}` : ""} before it was ready`;

  if (url === undefined) {
    await sleep(ALIVE_AFTER_MS);
    if (started.exited !== undefined) return failed(ended());
    return { ok: true, text: `${input.name} is running (pid ${started.pid}); its output is in ${shortPath(log)}.`, process: started };
  }
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (started.exited !== undefined) return failed(ended());
    if (await answers(url.href)) return { ok: true, text: `${input.name} is up at ${url.href} (pid ${started.pid}); its output is in ${shortPath(log)}.`, process: started };
    await sleep(1000);
  }
  return failed(`is running, but nothing answered at ${url.href} in ${Math.round(READY_TIMEOUT_MS / 1000)}s`);
}
