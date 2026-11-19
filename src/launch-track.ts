import { dirname } from "node:path";
import { codeTreeOf, exportModule, holdsCommit, hostDirOf, launchTarget, listLaunched, runningLaunched, stopLaunched, type ExportedCode, type LaunchedProcess } from "./regenerate/launch.ts";
import { record } from "./regenerate/ledger.ts";

/**
 * The launch track (docs/launch.md): each codebase's launches, one at a time, the newest commit winning. A pulse that lands
 * under `launch-after-pulse` asks for one with the commit it landed, and so does the chat's launch tool with the codebase's
 * last: neither waits for it, and no pulse waits on it. While one runs, a newer commit asked for waits as the next, and
 * replaces any older one waiting - a commit nobody will try is never launched, and the one after it holds its code.
 *
 * What is launched is recorded - the codebase, the commit, what it started, whether it came up - and the sentinel tests a
 * pulse only in a launch whose commit holds the pulse's (`holds`).
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
  /** What the agent said it did - where it runs - or why it did not come up. */
  summary?: string;
  /** Its code, once exported. */
  code?: ExportedCode;
  /** When what runs for it was started: a launch that found its code out already keeps the one before it's. */
  serversSince?: number;
  /** It found the commit's code out already: nothing exported, stopped or started. */
  already?: true;
  /** Superseded while it waited: the launch that took its place. */
  supersededBy?: string;
  /**
   * It ended with a newer launch of its codebase waiting, which starts at once and stops what it started: the launch
   * that takes its place. Its own status stays what it was - launched, say - for as long as that runs.
   */
  replacedBy?: string;
  /** Asked for even were its code out already. */
  again?: true;
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
  /** A launch of the codebase running, or waiting. */
  pending(codebase: string): Launch | undefined;
  /** Resolves once nothing of the codebase's is running or waiting. */
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
  /** Whether what runs for the codebase holds `commit`: its last launch's commit is it, or one built on it. */
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
  /** What the codebase's last launch started, still running. */
  running(codebase: string): LaunchedProcess[];
}

interface CodebaseState {
  moduleDir: string;
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
  /** The agent that takes exported code on and starts it. */
  run: (launch: Launch, code: ExportedCode, signal: AbortSignal) => Promise<LaunchOutcome>;
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
      state = { moduleDir, settledWaiters: [] };
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
      // What the last launch started runs from what is about to be replaced.
      await stopLaunched({ moduleName: launch.codebase });
      const code = exportModule(launch.plainFile, { ...(launch.inModule !== undefined ? { inModule: launch.inModule } : {}), commit: launch.commit });
      launch.code = code;
      launch.serversSince = Date.now();
      changed(launch);
      if (abort.signal.aborted) throw new Error("stopped");
      const outcome = await Promise.race([options.run(launch, code, abort.signal), halted]);
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
    const replaces = next !== undefined && launch.status !== "stopped" && (next.again === true || isOut(state, next.commit) === undefined);
    if (replaces) launch.replacedBy = next.id;
    finished(launch);
    changed(launch);
    if (replaces) handOn(launch, next);
    else ended(launch);
    if (next !== undefined) start(state, next);
    else settle(state);
  };

  const track: LaunchTrack = {
    request(input) {
      const target = launchTarget(input.plainFile, { ...(input.inModule !== undefined ? { inModule: input.inModule } : {}), ...(input.commit !== undefined ? { commit: input.commit } : {}) });
      const codebase = target.entry.moduleName;
      const state = stateOf(codebase, dirname(target.entry.buildDir));
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
      let resolveTaken!: (launch: Launch) => void;
      const taken = new Promise<Launch>((done) => (resolveTaken = done));
      takenOver.set(launch.id, { promise: taken, resolve: resolveTaken });
      // Nothing under way, and its code out already: nothing to do - but it ends as any launch does, told to the host
      // (onChange) with its own cause and the commit asked for, and what runs is its own when that commit is newer.
      if (input.again !== true && state.running === undefined && state.waiting === undefined) {
        const out = isOut(state, launch.commit);
        if (out !== undefined) {
          keep(launch);
          outAlready(state, launch, out);
          return { launch, already: true };
        }
      }
      keep(launch);
      if (state.running === undefined) start(state, launch);
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
    pending(codebase) {
      const state = codebases.get(codebase);
      return state?.running?.launch ?? state?.waiting;
    },
    settled(codebase) {
      const state = codebases.get(codebase);
      if (state === undefined || (state.running === undefined && state.waiting === undefined)) return Promise.resolve();
      return new Promise((resolve) => state.settledWaiters.push(resolve));
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
      const state = codebases.get(codebase);
      const current = state?.current;
      if (state === undefined || current === undefined) return false;
      return holdsCommit(state.moduleDir, commit, current.commit);
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
    running: (codebase) => runningLaunched(codebase),
  };
  return track;
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
