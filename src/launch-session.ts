import { configForSpec, readProjectConfig } from "./config.ts";
import type { SentinelLaunches } from "./chats.ts";
import { createLaunchTrack, type Launch, type LaunchTrack } from "./launch-track.ts";
import { runLaunchAgent } from "./launch-agent.ts";
import { holdsCommit, runningLaunched, type LaunchedProcess } from "./regenerate/launch.ts";
import { distDirFor, projectDirOf } from "./regenerate/paths.ts";
import { pulseName, type Job, type JobRegistry, type PulseSpec } from "./regenerate/jobs.ts";
import type { SentinelCheck } from "./notice.ts";

/**
 * A session's launches (docs/launch.md): its launch track, what each pulse that landed ended on, and what the sentinel
 * waits on of them - a pulse is tested only in a launch whose commit holds the pulse's.
 */

/** What a pulse that landed ended on, and whether its launch was asked for. */
interface Landed {
  commit: string;
  plainFile: string;
  codebase: string;
  /** The launch asked for it, under launch-after-pulse - or why it could not be. */
  launch?: string;
  notAsked?: string;
}

/** What runs for a pulse, as the sentinel is told it. */
export interface PulseLaunch {
  /** The commit the pulse landed - none when it did not land. */
  commit?: string;
  /** launch-after-pulse was off as it landed: nothing launched for it. */
  off?: boolean;
  /** Its launch could not be asked for, and why. */
  notAsked?: string;
  /** The launch whose commit holds it - what runs. */
  launch?: Launch;
  /** The person stopped the launch: nothing runs to test. */
  stopped?: boolean;
  /** The pulses that landed after it which the launch holds too, oldest first. */
  later: Job[];
  /** Its functional specs a later pulse in the launch changed too: those pulses' checks test them. */
  laterSpecs: PulseSpec[];
  running: LaunchedProcess[];
}

export interface SessionLaunches extends SentinelLaunches {
  track: LaunchTrack;
  /** A pulse landed, its commit final: kept - and, under launch-after-pulse, its launch asked for. */
  landed(input: { job: Job; plainFile: string; moduleName: string; commit: string; title: string }): void;
  /** What runs for a pulse, once `readyFor` resolved. */
  forPulse(job: Job): PulseLaunch;
  /** What the sentinel is told to carry on with a paused check: throws when what runs no longer holds it. */
  resumeText(work: { job: Job } | { check: SentinelCheck }): string;
}

/** How long a pulse that landed is waited for to say its commit: the loop says it as the pulse settles. */
const COMMIT_WAIT_MS = 10_000;

export function createSessionLaunches(options: {
  cwd: string;
  jobs: JobRegistry;
  /** The launch agent's model: the coding model of the codebase. */
  model: (plainFile: string) => string | undefined;
  onChange: (launch: Launch) => void;
}): SessionLaunches {
  const landedPulses = new Map<string, Landed>();
  const waiters = new Map<string, Array<() => void>>();
  const track = createLaunchTrack({
    cwd: options.cwd,
    run: (launch, code, signal) => {
      const model = options.model(launch.plainFile);
      return runLaunchAgent({ launch, code, cwd: options.cwd, signal, ...(model !== undefined ? { model } : {}) });
    },
    onChange: options.onChange,
  });
  // What an earlier session's launches left running holds the ports this one's need: stopped as the session starts.
  void track.sweep().catch(() => undefined);

  /** Whether the pulse's module launches what lands: its config as the pulse was queued with it. */
  const launchesAfter = (job: Job) => {
    try {
      return readProjectConfig(options.cwd, job.configModule).launchAfterPulse === true;
    } catch {
      return false;
    }
  };
  const landedJob = (job: Job) => job.status === "succeeded" && (job.details as { landed?: unknown } | undefined)?.landed === true && job.module !== undefined;

  /** The pulse's landing, once the loop has said its commit - none for one that did not land, or never said. */
  const landingOf = async (job: Job): Promise<Landed | undefined> => {
    if (!landedJob(job)) return undefined;
    const known = landedPulses.get(job.id);
    if (known !== undefined) return known;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, COMMIT_WAIT_MS);
      const list = waiters.get(job.id) ?? [];
      list.push(() => (clearTimeout(timer), resolve()));
      waiters.set(job.id, list);
    });
    return landedPulses.get(job.id);
  };

  const short = (commit: string) => commit.slice(0, 7);

  /** The person stopped the codebase's last launch: nothing of it runs. */
  const stoppedLast = (codebase: string) => {
    const last = [...track.list()].reverse().find((launch) => launch.codebase === codebase && launch.status !== "superseded");
    return last?.status === "stopped";
  };

  /** Throws when what runs of the codebase does not hold the pulse's commit. */
  const mustHold = (job: Job, landing: Landed) => {
    const current = track.current(landing.codebase);
    if (current === undefined) {
      throw new Error(`nothing of ${landing.codebase} runs - no launch holds pulse ${job.id}'s commit ${short(landing.commit)}, and none that would is waiting.`);
    }
    if (!track.holds(landing.codebase, landing.commit)) {
      throw new Error(`what runs of ${landing.codebase} is its commit ${current.short}, which does not hold pulse ${job.id}'s commit ${short(landing.commit)} - and no launch that would is waiting.`);
    }
    return current;
  };

  return {
    track,
    landed({ job, plainFile, moduleName, commit, title }) {
      const landing: Landed = { commit, plainFile, codebase: moduleName };
      if (configForSpec(plainFile).launchAfterPulse === true) {
        try {
          const { launch } = track.request({ plainFile, commit, cause: { pulse: job.id, title } });
          landing.codebase = launch.codebase;
          landing.launch = launch.id;
        } catch (error) {
          landing.notAsked = error instanceof Error ? error.message : String(error);
        }
      }
      landedPulses.set(job.id, landing);
      for (const resolve of waiters.get(job.id) ?? []) resolve();
      waiters.delete(job.id);
    },
    async readyFor(job) {
      // Nothing is launched for it: there is nothing to wait for.
      if (!launchesAfter(job)) return;
      const landing = await landingOf(job);
      if (landing === undefined || landing.launch === undefined) return;
      await track.settled(landing.codebase);
      if (stoppedLast(landing.codebase)) return;
      mustHold(job, landing);
    },
    async readyForCheck(check) {
      await track.settled(check.module);
      if (track.current(check.module) === undefined && runningLaunched(check.module).length === 0) {
        throw new Error(`nothing of ${check.module} is launched to test it in - ask the chat to try it first, which launches it.`);
      }
    },
    settled: (codebase) => track.settled(codebase),
    forPulse(job) {
      const landing = landedPulses.get(job.id);
      if (landing === undefined) return { later: [], laterSpecs: [], running: [], ...(landedJob(job) && !launchesAfter(job) ? { off: true } : {}) };
      const base = { commit: landing.commit, running: runningLaunched(landing.codebase), later: [] as Job[], laterSpecs: [] as PulseSpec[] };
      if (landing.notAsked !== undefined) return { ...base, notAsked: landing.notAsked };
      if (landing.launch === undefined) return { ...base, off: true };
      const launch = track.current(landing.codebase);
      if (launch === undefined || !track.holds(landing.codebase, landing.commit)) return { ...base, stopped: true };
      // The pulses that landed after it, which what runs holds too: what they changed is theirs to test.
      const later = options.jobs
        .list()
        .filter((other) => {
          const theirs = landedPulses.get(other.id);
          return (
            other.id !== job.id &&
            theirs !== undefined &&
            theirs.codebase === landing.codebase &&
            theirs.commit !== landing.commit &&
            holdsCommit(launch.moduleDir, landing.commit, theirs.commit) &&
            holdsCommit(launch.moduleDir, theirs.commit, launch.commit)
          );
        })
        .sort((a, b) => a.sequence - b.sequence);
      const key = (spec: PulseSpec) => `${spec.module}:${spec.funcId}`;
      const theirs = new Set(later.flatMap((other) => specsOf(other).map(key)));
      return { ...base, launch, later, laterSpecs: specsOf(job).filter((spec) => theirs.has(key(spec))) };
    },
    resumeText(work) {
      if ("job" in work) {
        const landing = landedPulses.get(work.job.id);
        if (landing === undefined) throw new Error(`turri has no commit for pulse ${work.job.id}.`);
        const launch = mustHold(work.job, landing);
        return [
          `What you were testing was launched again: ${launch.codebase} at ${launch.short} (${launch.id}${launch.status === "failed" ? ", which did not come up" : ""}). It still holds pulse ${work.job.id}'s commit, ${short(landing.commit)}.`,
          launch.status === "failed" ? `It did not come up: ${launch.summary ?? "the launch agent did not say why"}. That is what you find out about now.` : "What runs now:",
          ...(launch.status === "failed" ? [] : whatRuns(runningLaunched(launch.codebase), launchedDir(launch))),
          "",
          LAUNCHED_ONLY,
          "Carry on the check where you were. Do again what you were doing as it restarted: what failed then may have failed for that alone.",
        ].join("\n");
      }
      const running = runningLaunched(work.check.module);
      if (track.current(work.check.module) === undefined && running.length === 0) throw new Error(`nothing of ${work.check.module} runs any more to test check ${work.check.id} in.`);
      return [
        `What you were testing was launched again: ${work.check.module}${track.current(work.check.module) !== undefined ? ` at ${track.current(work.check.module)!.short}` : ""}. What runs now:`,
        ...whatRuns(running, track.current(work.check.module) !== undefined ? launchedDir(track.current(work.check.module)!) : undefined),
        "",
        LAUNCHED_ONLY,
        "Carry on the check where you were. Do again what you were doing as it restarted: what failed then may have failed for that alone.",
      ].join("\n");
    },
  };
}

/** A pulse's functional specs, every case. */
function specsOf(job: Job): PulseSpec[] {
  const cases = job.cases;
  return cases === undefined ? [] : [...cases.add, ...cases.patch, ...cases.again, ...cases.delete];
}

/**
 * What the sentinel tests in, whatever is launched: what turri launched, and nothing it starts itself. Said in every
 * brief - a server it starts from plain_modules would pass on code nobody launched.
 */
export const LAUNCHED_ONLY =
  "Never run the code in plain_modules, where a pulse may be writing, nor start a server of your own - not in your shell, not with a host's terminal: what would pass there is not what the person tries. A server that should run and does not is your finding.";

/** The folder a launch's code is in: dist/<module>, where it is tried from. */
export function launchedDir(launch: Pick<Launch, "code" | "plainFile" | "codebase">): string {
  return launch.code?.dir ?? distDirFor(projectDirOf(launch.plainFile), launch.codebase);
}

/**
 * What runs of a launch, a line each: where, from where, its output - or that nothing was left running, and the folder it
 * is tried from.
 */
export function whatRuns(running: LaunchedProcess[], from?: string): string[] {
  if (running.length === 0) {
    return [
      from !== undefined
        ? `  nothing is left running. It is in place in ${from}: try it from there - a CLI or a library as its README and entry points say. Something there that should serve and does not is what you find out about.`
        : "  nothing is left running.",
    ];
  }
  return running.map((item) => `  ${item.name}: ${item.url ?? item.command} - in ${item.dir}, its output in ${item.log}`);
}

/** Why a launch was asked for, as the chat is told it: after which pulse landed - nothing for one a chat asked for. */
const afterPulse = (launch: Launch, job?: Job) => ("pulse" in launch.cause ? ` after ${job !== undefined ? pulseName(job) : `pulse ${launch.cause.pulse}`} landed` : "");

/**
 * What the chat that asked for a launch is told when a newer one takes its place - superseded as it waited, or ended with
 * the newer one waiting, which stops what it started: it is told the newer one's end instead.
 */
export function replacedNote(launch: Launch, next: Launch, job?: Job): string {
  const how = launch.status === "superseded" ? "never started" : launch.status === "launched" ? "came up, but not for long" : "ended";
  return [
    `The launch of ${launch.codebase} at ${launch.short} you asked for (${launch.id}) ${how}: a newer launch of it, ${next.id} at ${next.short}${afterPulse(next, job)}, takes its place${launch.status === "superseded" ? "" : " and stops what it started"}.`,
    "You are told where that one runs, or why it did not come up, once it ends. Say so in a line, if the person is waiting for it; open nothing and start nothing for it now.",
  ].join("\n");
}

/** What a chat is told of a launch that ended - one it asked for, or one after a pulse with the sentinel off. */
export function launchedNote(launch: Launch, job?: Job): string {
  const after = afterPulse(launch, job);
  if (launch.status === "stopped") return `The launch of ${launch.codebase} at ${launch.short}${after} was stopped on request: nothing of it runs. Say so in a line.`;
  const head =
    launch.status === "launched"
      ? `${launch.codebase} at ${launch.short} is launched${after}${launch.already === true ? " - out already" : ""}.`
      : `The launch of ${launch.codebase} at ${launch.short}${after} did not come up.`;
  return [
    head,
    "",
    (launch.summary ?? "").trim(),
    "",
    launch.status === "launched"
      ? "Tell the person in a line or two where it runs - what the summary says to open or run - then do what you were told to do once something is launched (opening it where the person can watch it, saying what to test), if anything. Start no other work."
      : "Tell the person in a line or two why it did not come up and what they can do - what the machine lacks they install themselves. Do not launch it again unless they ask.",
  ].join("\n");
}
