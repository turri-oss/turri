import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
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
 * Where a codebase's history started: the module below it whose code it started from, and that module's commit - what
 * its first commit says (`start from <module> at <commit>`, copyRequiredCode). None for a codebase that started from
 * nothing.
 */
export function startedFrom(moduleDir: string): { module: string; commit: string } | undefined {
  const roots = git(moduleDir, ["log", "--max-parents=0", "--format=%s", "HEAD"]);
  if (roots.status !== 0) return undefined;
  for (const subject of roots.stdout.trim().split("\n")) {
    const match = /^start from (\S+) at (\w+)$/.exec(subject.trim());
    if (match !== null) return { module: match[1]!, commit: match[2]! };
  }
  return undefined;
}

/**
 * Whether a codebase's code holds a commit of another module - one below it in its requires chain, whose code it started
 * from: the commit is that module's, or held by the one it started from - down the chain, as far as it goes.
 */
export function heldUpChain(moduleDir: string, module: string, commit: string): boolean {
  let dir = moduleDir;
  const seen = new Set<string>();
  while (!seen.has(dir)) {
    seen.add(dir);
    const from = startedFrom(dir);
    if (from === undefined) return false;
    const fromDir = join(dirname(dir), from.module);
    if (from.module === module) return holdsCommit(fromDir, commit, from.commit);
    dir = fromDir;
  }
  return false;
}

/**
 * Whether `to` - a codebase at a commit - holds `from`'s commit: the same codebase, the commit or one built on it; a
 * codebase above `from`'s in its requires chain, built from code that held it.
 */
export function holdsAcross(from: { codebase: string; commit: string }, to: { codebase: string; moduleDir: string; commit: string }): boolean {
  if (from.codebase === to.codebase) return holdsCommit(to.moduleDir, from.commit, to.commit);
  return heldUpChain(to.moduleDir, from.codebase, from.commit);
}

/**
 * Which codebase to launch for a spec, and at which commit: the tip of its codebase - code accumulates up a requires
 * chain, so the top module holds everything below it - at `commit`, or its last. Before the tip has anything committed,
 * the nearest module below it that has.
 */
export function launchTarget(plainFile: string, options: { inModule?: string; commit?: string } = {}): { entry: ChainEntry; commit: string; instead?: string; below: string[] } {
  const { tip, chain } = findCodebaseTip(plainFile, { allowNoFunctionalities: true, ...(options.inModule !== undefined ? { inModule: options.inModule } : {}) });
  // The modules below the one launched, in its requires chain: their code is in it.
  const belowOf = (entry: ChainEntry) => {
    const at = chain.findIndex((each) => each.moduleName === entry.moduleName);
    return (at === -1 ? chain : chain.slice(0, at)).map((each) => each.moduleName).filter((name) => name !== entry.moduleName);
  };
  if (options.commit !== undefined) {
    const commit = committedCode(dirname(tip.buildDir), options.commit);
    if (commit === undefined) throw new Error(`${tip.moduleName} has no commit ${options.commit} with code in it: nothing to launch.`);
    return { entry: tip, commit, below: belowOf(tip) };
  }
  const candidates = [tip, ...[...chain].reverse().filter((entry) => entry.moduleName !== tip.moduleName)];
  for (const entry of candidates) {
    const commit = committedCode(dirname(entry.buildDir));
    if (commit !== undefined) return { entry, commit, below: belowOf(entry), ...(entry.moduleName !== tip.moduleName ? { instead: tip.moduleName } : {}) };
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
  /** The launch that started it, and that launch's commit, short: whose it is, as the person is told. */
  launch?: string;
  commit?: string;
  /** Set once it has ended. */
  exited?: { code: number | null; signal: string | null };
}

/** What this turri's launches started, by module and name: two modules' servers may have the same name. */
const processes = new Map<string, { info: LaunchedProcess; child: ChildProcess; record?: string }>();
const keyOf = (moduleName: string, name: string) => `${moduleName}\u0000${name}`;

/**
 * What a launch started, written down as it starts - `.turri/launch/running/<pid>.json` - and taken out as it ends: a turri
 * that dies without stopping what it started leaves it findable, for the next session to stop (`stopLeftBehind`).
 */
export interface LaunchRecord {
  pid: number;
  /** Its process group: the pid, as it was started as the leader of a group of its own. */
  pgid: number;
  name: string;
  moduleName: string;
  command: string;
  dir: string;
  url?: string;
  startedAt: number;
  /** The launch that started it, and that launch's commit, short. */
  launch?: string;
  commit?: string;
  /** The turri process that started it. */
  turri: number;
}

const RUNNING_DIR = "running";

function writeRecord(logDir: string, record: LaunchRecord): string | undefined {
  try {
    const dir = join(logDir, RUNNING_DIR);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${record.pid}.json`);
    writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
    return file;
  } catch {
    // Unrecorded, it is still stopped by this turri - only a turri that dies leaves it.
    return undefined;
  }
}

function dropRecord(file: string | undefined): boolean {
  if (file === undefined) return false;
  try {
    unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Alive, but another user's: it is not one turri started.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * The processes of the group a launch started, as `ps` says them now - none when it has none left, or ps cannot say
 * (Windows): what cannot be told to be turri's is never stopped. Theirs only when the group is the one the record names:
 * its leader started when the record says, or - the leader gone - every one of them started after it. A pid is not given
 * again while a group of that id has a process left.
 */
function groupOf(record: LaunchRecord): number[] {
  const listed = spawnSync("ps", ["-A", "-o", "pid=,pgid=,lstart="], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } });
  if (listed.status !== 0) return [];
  const members: Array<{ pid: number; started: number }> = [];
  for (const line of listed.stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (match === null || Number(match[2]) !== record.pgid) continue;
    members.push({ pid: Number(match[1]), started: Date.parse(match[3]!) });
  }
  if (members.length === 0) return [];
  const slack = 5000;
  const leader = members.find((member) => member.pid === record.pgid);
  const theirs =
    leader !== undefined
      ? Number.isFinite(leader.started) && Math.abs(leader.started - record.startedAt) <= slack
      : members.every((member) => Number.isFinite(member.started) && member.started >= record.startedAt - slack);
  return theirs ? members.map((member) => member.pid) : [];
}

const groupAlive = (pgid: number): boolean => {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * Stop what launches of an earlier turri left running in the project - the codebase's, or every one's - as stopLaunched
 * stops this session's: its process group, politely, then not. Only what turri's own records name, whose turri has ended
 * (another turri still running keeps its own), and only when the process is still the one recorded: a process turri did
 * not start is never stopped. Records of what has ended are taken out. Returns what was stopped.
 */
export async function stopLeftBehind(projectDir: string, codebase?: string | string[]): Promise<LaunchRecord[]> {
  const codebases = codebase === undefined ? undefined : typeof codebase === "string" ? [codebase] : codebase;
  const dir = join(projectDir, ".turri", "launch", RUNNING_DIR);
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  const stopping: LaunchRecord[] = [];
  for (const name of names) {
    const file = join(dir, name);
    let record: LaunchRecord;
    try {
      record = JSON.parse(readFileSync(file, "utf8")) as LaunchRecord;
    } catch {
      continue;
    }
    if (codebases !== undefined && !codebases.includes(record.moduleName)) continue;
    // This turri's own are stopLaunched's; another turri still running keeps its own.
    if (record.turri === process.pid || alive(record.turri)) continue;
    const group = groupOf(record);
    // Taken by whoever takes the record out first: a sweep at the session's start and one before a launch never both stop it.
    if (!dropRecord(file) || group.length === 0) continue;
    signalGroup(record.pgid, "SIGTERM");
    stopping.push(record);
  }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && stopping.some((record) => groupAlive(record.pgid))) await sleep(100);
  for (const record of stopping) if (groupAlive(record.pgid)) signalGroup(record.pgid, "SIGKILL");
  return stopping;
}

/** What was stopped of an earlier session's, in a line - for a launch's summary. */
export function describeLeftBehind(stopped: Array<Pick<LaunchRecord, "name" | "pid" | "url" | "moduleName">>): string {
  const each = stopped.map((record) => `${record.name} (pid ${record.pid}${record.url !== undefined ? `, ${record.url}` : ""})`);
  return `Stopped what an earlier turri session left running of ${[...new Set(stopped.map((record) => record.moduleName))].join(", ")}: ${each.join(", ")}.`;
}

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

/** Which of this turri's launched processes: by name, by module (or modules), by process group. Each given must match. */
export interface LaunchedFilter {
  name?: string;
  moduleName?: string;
  modules?: string[];
  pid?: number;
}

/** Stop launched processes - those the filter names, or every one: politely, then not. Returns what was stopped. */
export async function stopLaunchedProcesses(which: LaunchedFilter = {}): Promise<LaunchedProcess[]> {
  const targets = [...processes.values()].filter(
    ({ info }) =>
      info.exited === undefined &&
      (which.name === undefined || info.name === which.name) &&
      (which.moduleName === undefined || info.moduleName === which.moduleName) &&
      (which.modules === undefined || which.modules.includes(info.moduleName)) &&
      (which.pid === undefined || info.pid === which.pid),
  );
  for (const { info } of targets) signalGroup(info.pid, "SIGTERM");
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && targets.some(({ info }) => info.exited === undefined)) await sleep(100);
  for (const { info } of targets) if (info.exited === undefined) signalGroup(info.pid, "SIGKILL");
  return targets.map(({ info }) => info);
}

/** Stop one launched process, or every one of a module, or every one: politely, then not. Returns the names stopped. */
export async function stopLaunched(which: LaunchedFilter = {}): Promise<string[]> {
  return (await stopLaunchedProcesses(which)).map((info) => info.name);
}

// ---------------------------------------------------------------------------------------------
// Whose a process is: what holds something a launch needs - a port, a socket, a lock or pid file, a container name.

/**
 * A process, as turri's records say it: started by this turri's launches; by an earlier turri's, which has ended - left
 * behind; by another turri still running, which keeps it; or by nothing turri's records of the project name.
 */
export type Holder =
  | { kind: "this"; pid: number; process: LaunchedProcess }
  | { kind: "left"; pid: number; record: LaunchRecord; file: string }
  | { kind: "turri"; pid: number; record: LaunchRecord }
  | { kind: "unknown"; pid: number; command: string };

/** What a launch of this turri stopped to take what it held, said where the launch's summary says it. */
export interface Freed {
  name: string;
  moduleName: string;
  pid: number;
  url?: string;
  launch?: string;
  commit?: string;
  /** An earlier turri, ended, started it - not this one. */
  earlier?: true;
  /** What it held that this launch needs, as it is said: "port 5173". */
  held: string;
}

function psField(pid: number, field: string): string | undefined {
  const found = spawnSync("ps", ["-o", `${field}=`, "-p", String(pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } });
  if (found.status !== 0) return undefined;
  const value = found.stdout.trim();
  return value === "" ? undefined : value;
}

function readRecords(logDir: string): Array<{ record: LaunchRecord; file: string }> {
  const dir = join(logDir, RUNNING_DIR);
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  const records: Array<{ record: LaunchRecord; file: string }> = [];
  for (const name of names) {
    const file = join(dir, name);
    try {
      records.push({ record: JSON.parse(readFileSync(file, "utf8")) as LaunchRecord, file });
    } catch {
      /* half-written, or not one */
    }
  }
  return records;
}

/**
 * Whose a process is - any process of the group a launch started: what this turri started, what turri's records of the
 * project (`logDir`, its `.turri/launch`) name, or neither. Only a record whose group is still the one it names counts:
 * a pid given to another process since is not turri's.
 */
export function whoHolds(pid: number, logDir: string): Holder {
  const group = Number(psField(pid, "pgid") ?? Number.NaN);
  if (Number.isFinite(group)) {
    const own = [...processes.values()].find(({ info }) => info.exited === undefined && info.pid === group);
    if (own !== undefined) return { kind: "this", pid, process: own.info };
    for (const { record, file } of readRecords(logDir)) {
      if (record.pgid !== group || !groupOf(record).includes(pid)) continue;
      if (record.turri !== process.pid && alive(record.turri)) return { kind: "turri", pid, record };
      return { kind: "left", pid, record, file };
    }
  }
  return { kind: "unknown", pid, command: psField(pid, "command") ?? "a process ps cannot name" };
}

/** The processes listening on a TCP port, as lsof says them - undefined when it cannot say (no lsof). */
export function listenersOf(port: number): number[] | undefined {
  const found = spawnSync("lsof", ["-t", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" });
  if (found.error !== undefined) return undefined;
  return [...new Set(found.stdout.split("\n").map((line) => Number(line.trim())).filter((pid) => Number.isInteger(pid) && pid > 0))];
}

/** A holder in a line: what it is, and whose - the launch and module a turri started it for. */
export function describeHolder(holder: Holder): string {
  const at = (commit: string | undefined) => (commit !== undefined ? ` at ${commit}` : "");
  switch (holder.kind) {
    case "this": {
      const item = holder.process;
      return `${item.name} (pid ${item.pid}${item.url !== undefined ? `, ${item.url}` : ""}), which this turri started for ${item.moduleName}'s launch${item.launch !== undefined ? ` ${item.launch}` : ""}${at(item.commit)}, from ${shortPath(item.dir)}`;
    }
    case "left": {
      const record = holder.record;
      return `${record.name} (pid ${record.pid}${record.url !== undefined ? `, ${record.url}` : ""}), which an earlier turri session (pid ${record.turri}, ended) started for a launch of ${record.moduleName}${at(record.commit)}, from ${shortPath(record.dir)}`;
    }
    case "turri": {
      const record = holder.record;
      return `${record.name} (pid ${record.pid}${record.url !== undefined ? `, ${record.url}` : ""}), which another turri still running (pid ${record.turri}) started for its launch of ${record.moduleName}${at(record.commit)}, from ${shortPath(record.dir)}`;
    }
    case "unknown":
      return `pid ${holder.pid} (${holder.command}), which turri did not start - none of its records of this project names it`;
  }
}

/** How the person frees what a holder holds, from the chat - or that turri frees it itself. */
export function howToFree(holder: Holder): string {
  switch (holder.kind) {
    case "this":
      return `It is this turri's: \`/halt launched ${holder.process.moduleName}\` in the chat stops it, then ask for the launch again.`;
    case "left":
      return `Its turri has ended: turri stops it before the next launch of ${holder.record.moduleName}, or ask the chat to launch again.`;
    case "turri":
      return `It is that turri's, and this one never stops it: \`/halt launched ${holder.record.moduleName}\` in that turri's chat stops it, or quit that turri - then ask the chat here to launch again.`;
    case "unknown":
      return `turri never stops a process it did not start: if it is the person's to stop, they can stop it or ask the chat to (\`kill ${holder.pid}\`) - then ask the chat to launch again.`;
  }
}

/** Whether turri frees what a holder holds for a launch itself: what its own launches started, this session's or a dead turri's. */
export const turriFrees = (holder: Holder): holder is Extract<Holder, { kind: "this" | "left" }> => holder.kind === "this" || holder.kind === "left";

/**
 * Stop what turri's own launches started - this session's, or an ended turri's - for a launch that needs what it holds
 * (`held`, "port 5173"). Returns what was stopped; the rest is never touched.
 */
export async function freeHeld(holders: Holder[], held: string): Promise<Freed[]> {
  const freed: Freed[] = [];
  const seen = new Set<number>();
  for (const holder of holders) {
    if (holder.kind === "this") {
      if (seen.has(holder.process.pid)) continue;
      seen.add(holder.process.pid);
      const stopped = await stopLaunchedProcesses({ moduleName: holder.process.moduleName, name: holder.process.name, pid: holder.process.pid });
      for (const item of stopped) {
        freed.push({ name: item.name, moduleName: item.moduleName, pid: item.pid, held, ...(item.url !== undefined ? { url: item.url } : {}), ...(item.launch !== undefined ? { launch: item.launch } : {}), ...(item.commit !== undefined ? { commit: item.commit } : {}) });
      }
    } else if (holder.kind === "left") {
      const record = holder.record;
      if (seen.has(record.pgid)) continue;
      seen.add(record.pgid);
      // Taken by whoever takes the record out first, as stopLeftBehind does.
      if (!dropRecord(holder.file)) continue;
      signalGroup(record.pgid, "SIGTERM");
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && groupAlive(record.pgid)) await sleep(100);
      if (groupAlive(record.pgid)) signalGroup(record.pgid, "SIGKILL");
      freed.push({ name: record.name, moduleName: record.moduleName, pid: record.pid, held, earlier: true, ...(record.url !== undefined ? { url: record.url } : {}), ...(record.commit !== undefined ? { commit: record.commit } : {}) });
    }
  }
  return freed;
}

/** What was freed for a launch, in a line - for its summary. */
export function describeFreed(freed: Freed, forName: string): string {
  const whose = freed.earlier === true ? `an earlier turri session's launch of ${freed.moduleName}` : `${freed.moduleName}'s launch${freed.launch !== undefined ? ` ${freed.launch}` : ""}`;
  return `Stopped ${freed.name} (pid ${freed.pid}${freed.url !== undefined ? `, ${freed.url}` : ""}), from ${whose}${freed.commit !== undefined ? ` at ${freed.commit}` : ""}: it held ${freed.held}, which ${forName} needs.`;
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
/**
 * A port the server needs is held: by what turri's own launches started - this session's for another module, a dead
 * turri's - it is stopped, said, and the port taken; by anything else - another turri still running, a program turri did
 * not start - nothing is stopped and nothing started, and what holds it is said, whose it is, and how the person frees it.
 */
async function takePort(port: number, host: string, input: { name: string; moduleName: string; logDir: string; launch?: { id: string; commit: string }; freed?: (freed: Freed[]) => void }): Promise<{ ok: boolean; text: string }> {
  const notStarted = `so ${input.name} was not started. Do not move the app to another port: tell the person what holds it, whose it is and how to free it, as said here.`;
  const pids = listenersOf(port);
  if (pids === undefined || pids.length === 0) {
    return { ok: false, text: `Port ${port} is in use already, and turri cannot tell what holds it here${pids === undefined ? " (there is no lsof)" : ""} - ${notStarted}` };
  }
  const holders = pids.map((pid) => whoHolds(pid, input.logDir));
  // This launch's own: two of its servers on one port is the agent's to sort out, not turri's to stop.
  const own = holders.filter((holder) => holder.kind === "this" && holder.process.launch !== undefined && holder.process.launch === input.launch?.id);
  const others = holders.filter((holder) => !own.includes(holder) && !turriFrees(holder));
  if (own.length > 0 || others.length > 0) {
    const lines = [...own, ...others].map((holder) => `- ${describeHolder(holder)}.${own.includes(holder) ? " This launch started it itself: activate it again under the same name to restart it." : ` ${howToFree(holder)}`}`);
    return { ok: false, text: [`Port ${port} is held by:`, ...lines, notStarted].join("\n") };
  }
  const freed = await freeHeld(holders, `port ${port}`);
  input.freed?.(freed);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && (await portTaken(host, port))) await sleep(200);
  if (await portTaken(host, port)) {
    const still = (listenersOf(port) ?? []).map((pid) => whoHolds(pid, input.logDir));
    return {
      ok: false,
      text: [`Port ${port} is still held, after turri stopped what its own launches had there:`, ...still.map((holder) => `- ${describeHolder(holder)}. ${howToFree(holder)}`), notStarted].join("\n"),
    };
  }
  return { ok: true, text: freed.map((each) => describeFreed(each, input.name)).join("\n") };
}

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
export async function startLaunched(input: {
  name: string;
  command: string;
  dir: string;
  moduleName: string;
  logDir: string;
  url?: string;
  root?: string;
  /** The launch it is started for, and its commit, short: recorded, to say whose it is. */
  launch?: { id: string; commit: string };
  /** What turri's own launches started and this one stopped, to take what it held - told to the launch track. */
  freed?: (freed: Freed[]) => void;
}): Promise<StartResult> {
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
  // One already running under the name - of this module - is restarted.
  await stopLaunched({ name: input.name, moduleName: input.moduleName });
  let url: URL | undefined;
  let before = "";
  if (input.url !== undefined) {
    try {
      url = new URL(input.url);
    } catch {
      return { ok: false, text: `'${input.url}' is not a URL. Give the one it serves at, e.g. http://localhost:5173.` };
    }
    const port = portOf(url);
    if (await portTaken(url.hostname, port)) {
      const taken = await takePort(port, url.hostname, input);
      if (!taken.ok) return { ok: false, text: taken.text };
      before = taken.text;
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
  const started: LaunchedProcess = {
    name: input.name,
    moduleName: input.moduleName,
    command: input.command,
    dir: input.dir,
    log,
    pid: child.pid,
    startedAt: Date.now(),
    ...(input.url !== undefined ? { url: input.url } : {}),
    ...(input.launch !== undefined ? { launch: input.launch.id, commit: input.launch.commit } : {}),
  };
  info = started;
  const record = writeRecord(input.logDir, {
    pid: child.pid,
    pgid: child.pid,
    name: input.name,
    moduleName: input.moduleName,
    command: input.command,
    dir: input.dir,
    ...(input.url !== undefined ? { url: input.url } : {}),
    startedAt: started.startedAt,
    ...(input.launch !== undefined ? { launch: input.launch.id, commit: input.launch.commit } : {}),
    turri: process.pid,
  });
  child.on("exit", (code, signal) => {
    started.exited = { code, signal };
    dropRecord(record);
  });
  processes.set(keyOf(input.moduleName, input.name), { info: started, child, ...(record !== undefined ? { record } : {}) });
  stopOnExit();

  // The log's path is said whole: the agent works from dist/<module> or the host codebase, and a path relative to the
  // project read from there points nowhere.
  const said = (text: string) => (before !== "" ? `${before}\n${text}` : text);
  const failed = (why: string): StartResult => {
    const tail = logTail(log);
    return { ok: false, text: said(`${input.name} ${why}.${tail !== "" ? `\nThe end of its output (${log}):\n${tail}` : ""}`), process: started };
  };
  const ended = () => `exited${started.exited?.code !== null && started.exited?.code !== undefined ? ` with ${started.exited.code}` : ""} before it was ready`;

  if (url === undefined) {
    await sleep(ALIVE_AFTER_MS);
    if (started.exited !== undefined) return failed(ended());
    return { ok: true, text: said(`${input.name} is running (pid ${started.pid}); its output is in ${log}.`), process: started };
  }
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (started.exited !== undefined) return failed(ended());
    if (await answers(url.href)) return { ok: true, text: said(`${input.name} is up at ${url.href} (pid ${started.pid}); its output is in ${log}.`), process: started };
    await sleep(1000);
  }
  return failed(`is running, but nothing answered at ${url.href} in ${Math.round(READY_TIMEOUT_MS / 1000)}s`);
}
