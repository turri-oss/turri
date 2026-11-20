import { dirname, join } from "node:path";
import {
  codeTreeOf,
  describeFreed,
  describeLeftBehind,
  exportModule,
  holdsAcross,
  holdsCommit,
  hostDirOf,
  launchTarget,
  listLaunched,
  runningLaunched,
  stopLaunched,
  stopLaunchedProcesses,
  stopLeftBehind,
  type ExportedCode,
  type Freed,
  type LaunchedProcess,
  type LaunchRecord,
} from "./regenerate/launch.ts";
import { projectDirOf } from "./regenerate/paths.ts";
import { record } from "./regenerate/ledger.ts";

/**
 * The launch track (docs/launch.md): each codebase's launches, one at a time, the newest commit winning. A pulse that lands
 * under `launch-after-pulse` asks for one with the commit it landed, and so does the chat's launch tool with the codebase's
 * last: neither waits for it, and no pulse waits on it. While one runs, a newer commit asked for waits as the next, and
 * replaces any older one waiting - a commit nobody will try is never launched, and the one after it holds its code.
 *
 * What is launched is recorded - the codebase, the commit, what it started, whether it came up - and the sentinel tests a
 * pulse only in a launch whose commit holds the pulse's (`holds`).
 *
 * Across a project: a launch replaces what launches of the modules below it in its requires chain started - their code
 * is in it - and waits for one of them under way to end first. What turri's own launches of any other module started is
 * left running, unless it holds what this launch needs - a port, which activate takes, or anything else, which the agent
 * frees with stop_launched (`freed`). Either way, the launch that started it is replaced (`replacedBy`), told to the
 * host, and the new launch's `stopped` says what was stopped.
 */

export type LaunchStatus = "waiting" | "running" | "launched" | "failed" | "stopped" | "superseded";

/** Why a launch was asked for: a pulse landed, under launch-after-pulse - or a chat, or `turri launch`, asked. */
export type LaunchCause = { pulse: string; title: string } | { chat?: string };

export interface Launch {
  id: string;
  /** The codebase: the module whose `plain_modules/<module>` holds the code. */
  codebase: string;
  /** `plain_modules/<module>`: its history is there. */
  moduleDir: string;
  plainFile: string;
  inModule?: string;
  /** The commit it launches, whole. */
  commit: string;
  short: string;
  /** The host codebase a launch with guidance works in: the git repository the project is in, else where turri runs. */
  hostDir: string;
  /** How this project launches it, as the person or the chat said it. */
  guidance?: string;
  cause: LaunchCause;
  status: LaunchStatus;
  queuedAt: number;
  startedAt?: number;
  finishedAt?: number;
  /**
   * What the agent said it did - where it runs - or why it did not come up; for one that never reached the agent, turri's
   * own line (stopped on request, out already, an error). What turri stopped for it is in `stopped`, never here:
   * `launchText` puts the two together as the person reads them.
   */
  summary?: string;
  /** What turri stopped for this launch, a process each, as it stopped them - before it started, or as it ran. */
  stopped?: LaunchStopped[];
  /** Its code, once exported. */
  code?: ExportedCode;
  /** When what runs for it was started: a launch that found its code out already keeps the one before it's. */
  serversSince?: number;
  /** It found the commit's code out already: nothing exported, stopped or started. */
  already?: true;
  /** Superseded while it waited: the launch that took its place. */
  supersededBy?: string;
  /**
   * A newer launch stops what it started, and takes its place: one of its codebase, or of a module built on it, waiting as
   * it ended - which starts at once - or one that needed what it held. Its own status stays what it was - launched, say.
   */
  replacedBy?: string;
  /** Asked for even were its code out already. */
  again?: true;
}

/**
 * A process turri stopped for a launch, and why: a launch of a module below it in its requires chain (`below`) - its code
 * is in this one; a server of another module's launch that held what this one needs (`held`, with what: "port 5173");
 * one an earlier turri session left running (`left-behind`), stopped before this launch of its codebase.
 */
export interface LaunchStopped {
  why: "below" | "held" | "left-behind";
  /** The module whose launch started it. */
  module: string;
  /** The launch of this session that started it - none for an earlier session's. */
  launch?: string;
  /** That launch's commit, short, when known. */
  commit?: string;
  /** Its name, as the launch agent started it with activate. */
  name: string;
  pid: number;
  url?: string;
  /** What it held that this launch needs - "port 5173", "the lock on data/app.db" - for `held`. */
  held?: string;
  /** For `held`: an earlier turri session, ended, started it - not this one. */
  earlier?: true;
}

export interface LaunchOutcome {
  launched: boolean;
  summary: string;
}

export interface LaunchRequest {
  /** A .plain file of the codebase - its tip, or a module whose codebase it is. */
  plainFile: string;
  /** The codebase to take, when modules built on this one branch. */
  inModule?: string;
  /** The commit to launch - the one a pulse landed. Default: the codebase's last. */
  commit?: string;
  /** How this project launches it - kept for the codebase's launches after it. */
  guidance?: string;
  /** Launch even when its code is out already. */
  again?: boolean;
  cause: LaunchCause;
}

export interface LaunchTrack {
  /**
   * Ask for a launch: queued, never waited for. `already` when nothing is under way for the codebase and its code is out
   * already - the same code, nothing it started ended: then nothing is done, and what runs is left.
   */
  request(input: LaunchRequest): { launch: Launch; already: boolean };
  /** The codebase's last launch that ended - launched or failed - what runs being its. */
  current(codebase: string): Launch | undefined;
  /**
   * The launch whose code holds the codebase's now: its own last that ended, or - replaced by a launch of a module built
   * on it - that module's, up the chain.
   */
  runs(codebase: string): Launch | undefined;
  /** The codebases whose launches this one replaces: its own, and the modules below it in its requires chain. */
  replacing(launch: Launch): string[];
  /** A launch of the codebase running, or waiting. */
  pending(codebase: string): Launch | undefined;
  /** Resolves once nothing of the codebase's is running or waiting - nor of a module built on it, that took its launches over. */
  settled(codebase: string): Promise<void>;
  /**
   * Resolves with the launch once it ends - or, superseded as it waited or replaced as it ended, with the one that took
   * its place once that ends.
   */
  done(id: string): Promise<Launch>;
  /**
   * Resolves with the launch that takes this one's place - superseded as it waited, or ended with a newer one waiting,
   * which stops what it started - as soon as it does. Never resolves for a launch nothing takes the place of.
   */
  replaced(id: string): Promise<Launch>;
  /** Whether what runs for the codebase (`runs`) holds `commit`: its commit is it, or one built on it - up the chain too. */
  holds(codebase: string, commit: string): boolean;
  /** Stop the codebase's launch under way and the one waiting - every codebase's, none named. Returns what was stopped. */
  stop(codebase?: string): Promise<string[]>;
  /**
   * What launches started was stopped on request (`/halt launched`): the codebase's last launch - every codebase's, none
   * named - that has nothing left running is stopped, nothing of it runs, and the next launch of it launches anew. Told
   * as any launch's end is. Returns the launches stopped.
   */
  halted(codebase?: string): string[];
  list(): Launch[];
  /**
   * Stop what launches of an earlier turri left running in the project - as a session starts. Said in the ledger, and in
   * the summary of the next launch of each codebase it stopped something of. A launch does it for its codebase too.
   */
  sweep(): Promise<LaunchRecord[]>;
  /** What the codebase's last launch started, still running. */
  running(codebase: string): LaunchedProcess[];
}

interface CodebaseState {
  moduleDir: string;
  /** The modules below it in its requires chain, as its last launch was asked for. */
  below: string[];
  /** A launch of this module, built on it, took its launches over: what runs of its code is that module's. */
  movedTo?: string;
  current?: Launch;
  running?: { launch: Launch; abort: AbortController };
  waiting?: Launch;
  guidance?: string;
  settledWaiters: Array<() => void>;
}

/** How many ended launches are kept to list. */
const KEPT = 50;

export function createLaunchTrack(options: {
  cwd: string;
  /**
   * The agent that takes exported code on and starts it - telling `freed` what of turri's own launches it stopped to take
   * what they held.
   */
  run: (launch: Launch, code: ExportedCode, signal: AbortSignal, freed: (freed: Freed[]) => void) => Promise<LaunchOutcome>;
  onChange?: (launch: Launch) => void;
}): LaunchTrack {
  const codebases = new Map<string, CodebaseState>();
  const launches: Launch[] = [];
  const ends = new Map<string, { promise: Promise<Launch>; resolve: (launch: Launch) => void }>();
  const takenOver = new Map<string, { promise: Promise<Launch>; resolve: (launch: Launch) => void }>();
  let count = 0;

  const stateOf = (codebase: string, moduleDir: string): CodebaseState => {
    let state = codebases.get(codebase);
    if (state === undefined) {
      state = { moduleDir, below: [], settledWaiters: [] };
      codebases.set(codebase, state);
    }
    state.moduleDir = moduleDir;
    return state;
  };
  const changed = (launch: Launch) => {
    try {
      options.onChange?.(launch);
    } catch {
      /* one that listens and fails is left out of this change */
    }
  };
  const ended = (launch: Launch) => ends.get(launch.id)?.resolve(launch);
  /** `next` takes `launch`'s place: whoever waits on `launch` hears `next`'s end, and that it took over, now. */
  const handOn = (launch: Launch, next: Launch) => {
    takenOver.get(launch.id)?.resolve(next);
    void track.done(next.id).then((last) => ends.get(launch.id)?.resolve(last));
  };
  const finished = (launch: Launch) =>
    record(
      { kind: "launch.finished", launch: launch.id, commit: launch.short, status: launch.status, ms: (launch.finishedAt ?? Date.now()) - (launch.startedAt ?? launch.queuedAt) },
      place(launch),
    );
  const place = (launch: Launch) => ({ project: options.cwd, module: launch.codebase });
  /** The module on top a launch was asked for, with nothing built yet - it took the one below - by launch. */
  const insteadOf = new Map<string, string>();
  /** What turri stopped for a launch, kept on it as it happens - and the host told. */
  const stoppedFor = (launch: Launch, stopped: LaunchStopped[]) => {
    if (stopped.length === 0) return;
    launch.stopped = [...(launch.stopped ?? []), ...stopped];
    changed(launch);
  };
  /**
   * What a launch of another module started was stopped for `by`: once nothing of it runs, its launch is replaced - not
   * what runs any more - and told to the host. Whoever asked for it heard its end already: the new launch's `stopped` says it.
   */
  const replacedAcross = (codebase: string, by: Launch) => {
    const state = codebases.get(codebase);
    const current = state?.current;
    if (state === undefined || current === undefined || current === by || runningLaunched(codebase).length > 0) return;
    state.current = undefined;
    if (current.replacedBy !== undefined) return;
    current.replacedBy = by.id;
    record({ kind: "launch.replaced", launch: current.id, by: by.id, byModule: by.codebase }, place(current));
    changed(current);
  };
  /** What `launch` stopped of turri's own launches to take what they held: kept in its `stopped`, their launches replaced. */
  const freedFor = (launch: Launch) => (freed: Freed[]) => {
    if (freed.length === 0) return;
    record({ kind: "launch.freed", launch: launch.id, held: freed[0]!.held, stopped: freed.map(ledgerOf) }, place(launch));
    stoppedFor(
      launch,
      freed.map((each) => ({
        why: "held" as const,
        module: each.moduleName,
        name: each.name,
        pid: each.pid,
        held: each.held,
        ...(each.launch !== undefined ? { launch: each.launch } : {}),
        ...(each.commit !== undefined ? { commit: each.commit } : {}),
        ...(each.url !== undefined ? { url: each.url } : {}),
        ...(each.earlier === true ? { earlier: true as const } : {}),
      })),
    );
    for (const each of freed) if (each.earlier !== true && each.moduleName !== launch.codebase) replacedAcross(each.moduleName, launch);
  };
  const ledgerOf = (each: { name: string; pid: number; moduleName: string; url?: string; launch?: string }) => ({
    name: each.name,
    pid: each.pid,
    module: each.moduleName,
    ...(each.url !== undefined ? { url: each.url } : {}),
    ...(each.launch !== undefined ? { launch: each.launch } : {}),
  });
  /** Whether a launch of a module below `state`'s in its chain is under way: it waits for that one to end. */
  const belowBusy = (state: CodebaseState) => state.below.some((module) => codebases.get(module)?.running !== undefined);
  /** A launch waiting, of a module built on `codebase`: it stops what `codebase`'s launch started as it starts. */
  const aboveWaiting = (codebase: string): Launch | undefined => [...codebases.values()].find((state) => state.waiting !== undefined && state.below.includes(codebase))?.waiting;
  /** The launches of modules built on `codebase` that waited for its launch to end, and can start now. */
  const startAbove = (codebase: string) => {
    for (const state of codebases.values()) {
      if (state.waiting === undefined || state.running !== undefined || !state.below.includes(codebase) || belowBusy(state)) continue;
      const next = state.waiting;
      state.waiting = undefined;
      start(state, next);
    }
  };

  /** What an earlier session left running and was stopped, by codebase, not yet said in a launch's summary. */
  const leftBehind = new Map<string, LaunchRecord[]>();
  const noteLeftBehind = (stopped: LaunchRecord[]) => {
    if (stopped.length === 0) return;
    record({ kind: "launch.left-behind", stopped: stopped.map((each) => ({ name: each.name, pid: each.pid, module: each.moduleName, ...(each.url !== undefined ? { url: each.url } : {}) })) }, { project: options.cwd });
    for (const each of stopped) leftBehind.set(each.moduleName, [...(leftBehind.get(each.moduleName) ?? []), each]);
  };

  /**
   * What runs for the codebase is the commit's code: the same code, nothing it started has ended. Guidance is not
   * compared: the agent finds the project's itself, and the chat passing it on says nothing new - `again` launches anew.
   */
  const isOut = (state: CodebaseState, commit: string): Launch | undefined => {
    const current = state.current;
    if (current === undefined || current.status !== "launched") return undefined;
    if (!holdsCommit(state.moduleDir, current.commit, commit) && !holdsCommit(state.moduleDir, commit, current.commit)) return undefined;
    const tree = codeTreeOf(state.moduleDir, commit);
    if (tree === undefined || tree !== codeTreeOf(state.moduleDir, current.commit)) return undefined;
    const since = current.serversSince ?? current.startedAt ?? 0;
    const started = listLaunched().filter((item) => item.moduleName === current.codebase && item.startedAt >= since);
    return started.some((item) => item.exited !== undefined) ? undefined : current;
  };

  const settle = (state: CodebaseState) => {
    if (state.running !== undefined || state.waiting !== undefined) return;
    for (const resolve of state.settledWaiters.splice(0)) resolve();
  };

  const keep = (launch: Launch) => {
    launches.push(launch);
    while (launches.length > KEPT) {
      const first = launches.findIndex((each) => each.status !== "waiting" && each.status !== "running");
      if (first === -1) break;
      launches.splice(first, 1);
    }
  };

  /**
   * A launch whose commit's code is what runs already - a pulse that landed only tests, say, or the chat asking for what
   * runs: ended as launched at once, `already`, nothing stopped or started - nor anyone told it is launching. What runs
   * is its own from then on, when its commit is built on what ran: it holds both. Told as any launch's end is.
   */
  const outAlready = (state: CodebaseState, launch: Launch, out: Launch) => {
    launch.status = "launched";
    launch.already = true;
    launch.startedAt = Date.now();
    launch.serversSince = out.serversSince ?? out.startedAt ?? 0;
    launch.summary = out.summary ?? `${launch.codebase} at ${out.short} runs already.`;
    launch.finishedAt = Date.now();
    if (holdsCommit(state.moduleDir, out.commit, launch.commit)) state.current = launch;
    finish(state, launch);
  };

  const start = (state: CodebaseState, launch: Launch) => {
    // Found out already as it waited.
    const out = launch.again === true ? undefined : isOut(state, launch.commit);
    if (out !== undefined) {
      outAlready(state, launch, out);
      return;
    }
    // What runs of the modules below it is this one's from now: their code is in it.
    state.movedTo = undefined;
    for (const module of state.below) stateOf(module, join(dirname(state.moduleDir), module)).movedTo = launch.codebase;
    const abort = new AbortController();
    state.running = { launch, abort };
    launch.status = "running";
    launch.startedAt = Date.now();
    changed(launch);
    record({ kind: "launch.started", launch: launch.id, commit: launch.short, ...("pulse" in launch.cause ? { pulse: launch.cause.pulse } : {}) }, place(launch));
    void runIt(state, launch, abort);
  };

  const runIt = async (state: CodebaseState, launch: Launch, abort: AbortController): Promise<void> => {
    // Halted, it is let go at once: what the agent does after is nobody's.
    const halted = new Promise<never>((_, reject) => abort.signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true }));
    halted.catch(() => undefined);
    try {
      // What the last launch started runs from what is about to be replaced - and what an earlier session's left, which
      // would hold its ports. So does what launches of the modules below it started: an older build of the same code.
      noteLeftBehind(await stopLeftBehind(projectDirOf(launch.plainFile), [launch.codebase, ...state.below]));
      // What an earlier session left of these codebases - stopped now, or as the session started - is this launch's to say.
      stoppedFor(
        launch,
        [launch.codebase, ...state.below].flatMap((module) => {
          const records = leftBehind.get(module) ?? [];
          leftBehind.delete(module);
          return records.map((record) => ({
            why: "left-behind" as const,
            module: record.moduleName,
            name: record.name,
            pid: record.pid,
            ...(record.commit !== undefined ? { commit: record.commit } : {}),
            ...(record.url !== undefined ? { url: record.url } : {}),
          }));
        }),
      );
      await stopLaunched({ moduleName: launch.codebase });
      const older = state.below.length > 0 ? await stopLaunchedProcesses({ modules: state.below }) : [];
      replacedBelow(launch, older);
      // The codebase it was asked for, whatever has been built on it since.
      const exported = exportModule(launch.plainFile, { inModule: launch.codebase, commit: launch.commit });
      const instead = insteadOf.get(launch.id);
      const code = instead !== undefined ? { ...exported, instead } : exported;
      launch.code = code;
      launch.serversSince = Date.now();
      changed(launch);
      if (abort.signal.aborted) throw new Error("stopped");
      const outcome = await Promise.race([options.run(launch, code, abort.signal, freedFor(launch)), halted]);
      if (abort.signal.aborted) throw new Error("stopped");
      launch.status = outcome.launched ? "launched" : "failed";
      launch.summary = outcome.summary.trim();
    } catch (error) {
      launch.status = abort.signal.aborted ? "stopped" : "failed";
      launch.summary = abort.signal.aborted ? "Stopped on request." : error instanceof Error ? error.message : String(error);
    }
    launch.finishedAt = Date.now();
    // What runs is this launch's - or, stopped, nothing of it.
    state.current = launch.status === "stopped" ? undefined : launch;
    finish(state, launch);
  };

  /**
   * A launch ended: the track free for the next - before anyone hears it ended - then it is told, and the next started.
   * With a newer one waiting that will stop what it started - not out already - it is replaced: whoever asked for it
   * hears the newer one's end instead, never that it is up only for it to be stopped the next moment.
   */
  const finish = (state: CodebaseState, launch: Launch) => {
    if (state.running?.launch === launch) state.running = undefined;
    const next = state.waiting;
    state.waiting = undefined;
    // A launch of a module built on this one, waiting for it to end, stops what it started as it starts.
    const above = next === undefined && launch.status !== "stopped" ? aboveWaiting(launch.codebase) : undefined;
    const by = next !== undefined && launch.status !== "stopped" && (next.again === true || isOut(state, next.commit) === undefined) ? next : above;
    if (by !== undefined) launch.replacedBy = by.id;
    finished(launch);
    changed(launch);
    if (by !== undefined) handOn(launch, by);
    else ended(launch);
    if (next !== undefined) start(state, next);
    else settle(state);
    startAbove(launch.codebase);
  };

  /** What `launch` stopped of the launches of the modules below it: kept in its `stopped`, and theirs replaced. */
  const replacedBelow = (launch: Launch, stopped: LaunchedProcess[]) => {
    if (stopped.length > 0) record({ kind: "launch.freed", launch: launch.id, held: "below", stopped: stopped.map(ledgerOf) }, place(launch));
    stoppedFor(
      launch,
      stopped.map((item) => ({
        why: "below" as const,
        module: item.moduleName,
        name: item.name,
        pid: item.pid,
        ...(item.launch !== undefined ? { launch: item.launch } : {}),
        ...(item.commit !== undefined ? { commit: item.commit } : {}),
        ...(item.url !== undefined ? { url: item.url } : {}),
      })),
    );
    // Theirs - with something stopped or nothing left running - is not what runs any more: this one holds their code.
    for (const module of codebases.get(launch.codebase)?.below ?? []) replacedAcross(module, launch);
  };

  const track: LaunchTrack = {
    request(input) {
      const target = launchTarget(input.plainFile, { ...(input.inModule !== undefined ? { inModule: input.inModule } : {}), ...(input.commit !== undefined ? { commit: input.commit } : {}) });
      const codebase = target.entry.moduleName;
      const state = stateOf(codebase, dirname(target.entry.buildDir));
      state.below = target.below;
      const instead = target.instead;
      const said = input.guidance?.trim();
      if (said !== undefined && said !== "") state.guidance = said;
      const guidance = state.guidance;
      const launch: Launch = {
        id: `launch-${++count}`,
        codebase,
        moduleDir: state.moduleDir,
        plainFile: target.entry.plainFile,
        ...(input.inModule !== undefined ? { inModule: input.inModule } : {}),
        commit: target.commit,
        short: target.commit.slice(0, 7),
        hostDir: hostDirOf(target.entry.plainFile, options.cwd),
        ...(guidance !== undefined ? { guidance } : {}),
        cause: input.cause,
        status: "waiting",
        queuedAt: Date.now(),
        ...(input.again === true ? { again: true as const } : {}),
      };
      let resolve!: (launch: Launch) => void;
      const promise = new Promise<Launch>((done) => (resolve = done));
      ends.set(launch.id, { promise, resolve });
      if (instead !== undefined) insteadOf.set(launch.id, instead);
      let resolveTaken!: (launch: Launch) => void;
      const taken = new Promise<Launch>((done) => (resolveTaken = done));
      takenOver.set(launch.id, { promise: taken, resolve: resolveTaken });
      // A launch of a module below it waiting is never launched: this one holds its code.
      for (const module of state.below) {
        const below = codebases.get(module);
        const older = below?.waiting;
        if (below === undefined || older === undefined) continue;
        below.waiting = undefined;
        older.status = "superseded";
        older.supersededBy = launch.id;
        older.finishedAt = Date.now();
        changed(older);
        handOn(older, launch);
        settle(below);
      }
      // Nothing under way, and its code out already: nothing to do - but it ends as any launch does, told to the host
      // (onChange) with its own cause and the commit asked for, and what runs is its own when that commit is newer.
      if (input.again !== true && state.running === undefined && state.waiting === undefined && !belowBusy(state)) {
        const out = isOut(state, launch.commit);
        if (out !== undefined) {
          keep(launch);
          outAlready(state, launch, out);
          return { launch, already: true };
        }
      }
      keep(launch);
      // A launch of a module below it under way ends first: this one stops what it started.
      if (state.running === undefined && !belowBusy(state)) start(state, launch);
      else {
        // The newest wins: what waited is never launched - this one holds its code.
        const older = state.waiting;
        if (older !== undefined) {
          older.status = "superseded";
          older.supersededBy = launch.id;
          older.finishedAt = Date.now();
          changed(older);
          handOn(older, launch);
        }
        state.waiting = launch;
        changed(launch);
      }
      return { launch, already: false };
    },
    current: (codebase) => codebases.get(codebase)?.current,
    runs(codebase) {
      const seen = new Set<string>();
      let name: string | undefined = codebase;
      while (name !== undefined && !seen.has(name)) {
        seen.add(name);
        const state = codebases.get(name);
        if (state?.current !== undefined) return state.current;
        name = state?.movedTo;
      }
      return undefined;
    },
    replacing: (launch) => [launch.codebase, ...(codebases.get(launch.codebase)?.below ?? [])],
    pending(codebase) {
      const state = codebases.get(codebase);
      return state?.running?.launch ?? state?.waiting;
    },
    async settled(codebase) {
      const seen = new Set<string>();
      let name: string | undefined = codebase;
      while (name !== undefined && !seen.has(name)) {
        seen.add(name);
        const state = codebases.get(name);
        if (state === undefined) return;
        if (state.running !== undefined || state.waiting !== undefined) await new Promise<void>((resolve) => state.settledWaiters.push(resolve));
        name = state.movedTo;
      }
    },
    done(id) {
      const end = ends.get(id);
      if (end !== undefined) return end.promise;
      const known = launches.find((launch) => launch.id === id);
      return known !== undefined ? Promise.resolve(known) : Promise.reject(new Error(`No launch ${id}.`));
    },
    replaced(id) {
      const taken = takenOver.get(id);
      return taken !== undefined ? taken.promise : Promise.reject(new Error(`No launch ${id}.`));
    },
    holds(codebase, commit) {
      const runs = track.runs(codebase);
      if (runs === undefined) return false;
      return holdsAcross({ codebase, commit }, { codebase: runs.codebase, moduleDir: runs.moduleDir, commit: runs.commit });
    },
    async stop(codebase) {
      const stopped: string[] = [];
      for (const [name, state] of codebases) {
        if (codebase !== undefined && name !== codebase) continue;
        const waiting = state.waiting;
        if (waiting !== undefined) {
          state.waiting = undefined;
          waiting.status = "stopped";
          waiting.summary = "Stopped on request, before it started.";
          waiting.finishedAt = Date.now();
          changed(waiting);
          ended(waiting);
          stopped.push(`${waiting.id} (${name})`);
        }
        if (state.running !== undefined) {
          state.running.abort.abort();
          stopped.push(`${state.running.launch.id} (${name})`);
        }
        settle(state);
      }
      return stopped;
    },
    halted(codebase) {
      const stopped: string[] = [];
      for (const [name, state] of codebases) {
        if (codebase !== undefined && name !== codebase) continue;
        const current = state.current;
        if (current === undefined || current.status !== "launched" || runningLaunched(name).length > 0) continue;
        current.status = "stopped";
        current.summary = "Stopped on request.";
        current.finishedAt = Date.now();
        state.current = undefined;
        finished(current);
        changed(current);
        stopped.push(current.id);
      }
      return stopped;
    },
    list: () => [...launches],
    async sweep() {
      const stopped = await stopLeftBehind(projectDirOf(join(options.cwd, "turri.plain")));
      noteLeftBehind(stopped);
      return stopped;
    },
    running: (codebase) => runningLaunched(codebase),
  };
  return track;
}

/**
 * A launch as the person reads it: what turri stopped for it - what an earlier session left running, then what launches
 * of the modules below it started, then what held what it needed - a line each, then what the launch agent said. The
 * chat, the terminal and the sentinel read this; a host gets the two apart, `stopped` and `summary`.
 */
export function launchText(launch: Pick<Launch, "codebase" | "summary" | "stopped">): string {
  const stopped = launch.stopped ?? [];
  const left = stopped.filter((each) => each.why === "left-behind");
  const lines: string[] = [];
  if (left.length > 0) lines.push(describeLeftBehind(left.map((each) => ({ name: each.name, pid: each.pid, moduleName: each.module, ...(each.url !== undefined ? { url: each.url } : {}) }))));
  const below = new Map<string, LaunchStopped[]>();
  for (const each of stopped.filter((item) => item.why === "below")) {
    const key = `${each.module}\u0000${each.launch ?? ""}`;
    below.set(key, [...(below.get(key) ?? []), each]);
  }
  for (const items of below.values()) {
    const first = items[0]!;
    const which = first.launch !== undefined ? `${first.module}'s launch ${first.launch}${first.commit !== undefined ? ` at ${first.commit}` : ""}` : `${first.module}'s launch`;
    const what = items.map((item) => `${item.name} (pid ${item.pid}${item.url !== undefined ? `, ${item.url}` : ""})`).join(", ");
    lines.push(`Stopped what ${which} started - ${what}: ${launch.codebase} is built on ${first.module} and holds its code, so this launch takes its place.`);
  }
  for (const each of stopped.filter((item) => item.why === "held")) {
    lines.push(
      describeFreed(
        {
          name: each.name,
          moduleName: each.module,
          pid: each.pid,
          held: each.held ?? "what this launch needs",
          ...(each.url !== undefined ? { url: each.url } : {}),
          ...(each.launch !== undefined ? { launch: each.launch } : {}),
          ...(each.commit !== undefined ? { commit: each.commit } : {}),
          ...(each.earlier === true ? { earlier: true as const } : {}),
        },
        launch.codebase,
      ),
    );
  }
  return [...lines, ...(launch.summary !== undefined && launch.summary.trim() !== "" ? [launch.summary.trim()] : [])].join("\n");
}

/** A launch in a line: its codebase, commit, how it stands - for /halt, pulses and the panel. */
export function describeLaunchLine(launch: Launch): string {
  const why = "pulse" in launch.cause ? ` after pulse ${launch.cause.pulse}` : "";
  const how =
    launch.status === "waiting"
      ? "waiting"
      : launch.status === "running"
        ? "launching"
        : launch.status === "launched"
          ? launch.already === true
            ? "out already"
            : "launched"
          : launch.status;
  return `${launch.id}  ${how}  ${launch.codebase} at ${launch.short}${why}`;
}
