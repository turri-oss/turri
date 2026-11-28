import { createInterface } from "node:readline/promises";
import { createTurri, pulseName, type Job, type SessionOverrides, type StartOverQuestion, type Turri, type TurriEvent, type WorkResult } from "@turri-dev/core";
import { describeModules } from "@turri-dev/core/project";
import { clientInfo } from "./cli-root.ts";
import { c } from "./module-report.ts";
import { tryItCommand } from "./regenerate/delivery.ts";
import { configKeyOptions, optionValue } from "./cli-options.ts";

/**
 * A headless run - `turri regenerate`, `turri conform` - on a session with no front end: unattended, with no chats, no
 * sentinel and nobody asked by the core. It runs what the chat's regenerate and conform tools run, prints each pulse as
 * it starts and ends, and exits with how it ended: 0 only when every codebase is complete - or for a look ahead.
 */

/** What is asked of the work loop. */
export type LoopWork =
  /** Plan as regenerate would, and print each codebase's next pulse: nothing started (`--dry-run`). */
  | { work: "preview" }
  | { work: "regenerate"; funcIds?: string[]; fromScratch?: "module" | "chain" }
  | { work: "conform"; funcIds?: string[]; separately?: boolean; fromScratch?: "module" | "chain" };

export type LoopRun = LoopWork & {
  plainFile: string;
  /** The config's keys given on the command line: this session's overrides. */
  overrides: SessionOverrides;
  /** Where the code is exported as the run ends (`--build-dir`). */
  buildDir?: string;
  report?: string;
  command: string[];
  /** Start over, unasked, a codebase that has to be (`--start-over`). */
  startOver: boolean;
};

export async function runLoop(run: LoopRun): Promise<never> {
  const turri = await createTurri({ client: clientInfo(run.command[0] ?? "regenerate"), overrides: run.overrides, onEvent: printEvent() });
  // ctrl+c stops the run - its running pulses rolled back, nothing more started - and it ends as it would; a second
  // one leaves at once. What its agents left running goes either way (the core stops its process groups on exit).
  const stopping = new AbortController();
  process.on("SIGINT", () => {
    if (stopping.signal.aborted) process.exit(130);
    console.error(c.warning("\nstopping - ctrl+c again to leave at once"));
    stopping.abort();
  });
  let code: number;
  try {
    code = await runOn(turri, run, stopping.signal);
  } finally {
    await turri.dispose();
  }
  process.exit(code);
}

/** What the session says as it runs, printed: each pulse as it starts, moves on and ends, what turri says, a provider's trouble. */
function printEvent(): (event: TurriEvent) => void {
  const seen = new Map<string, string>();
  return (event) => {
    if (event.type === "job") {
      const { job, final } = event;
      const line = job.status === "running" ? `${job.stage ?? "started"}` : job.status;
      if (seen.get(job.id) === line) return;
      seen.set(job.id, line);
      if (job.status === "running") pulseRunning(job);
      else if (job.status !== "queued") pulseFinished(job, final);
    } else if (event.type === "orphansStopped") {
      console.log(`Stopped ${event.count} process group${event.count === 1 ? "" : "s"} a turri that was killed left running.`);
    } else if (event.type === "incident") {
      console.log(c.warning(`  ${event.event.job !== undefined ? `${event.event.job}: ` : ""}${event.text}`));
    } else if (event.type === "notification") {
      // What turri says outside a pulse: a ledger it cannot write, say.
      if (event.level === "info") console.log(event.text);
      else console.error(event.level === "error" ? c.error(event.text) : c.warning(event.text));
    }
  };
}

function pulseRunning(job: Job): void {
  console.log(`${c.accent(`▶ ${job.id}`)} ${pulseName(job)}${job.stage !== undefined ? c.dim(` - ${job.stage}`) : ""}`);
}

function pulseFinished(job: Job, final: boolean): void {
  const mark = job.status === "succeeded" ? c.success("✓") : job.status === "stopped" ? c.dim("■") : c.error("✗");
  const again = !final && job.replacedBy !== undefined ? c.dim(` - run again as ${job.replacedBy}`) : "";
  console.log(`${mark} ${job.id} ${pulseName(job)} - ${job.status}${again}`);
  if (job.status !== "succeeded") console.log(c.dim((job.announce ?? job.report ?? job.error ?? "").trim()));
  // Its report is not printed when it succeeds, and nobody is asked here: the spec gaps its agents met are said.
  else for (const gap of job.details?.specGaps ?? []) console.log(c.warning(`  spec gap: ${gap.question}`), c.dim(`Meanwhile: ${gap.assumption}`));
}

async function runOn(turri: Turri, run: LoopRun, signal: AbortSignal): Promise<number> {
  if (run.work === "preview") return lookAhead(turri, run.plainFile);
  // A codebase built without a module it now requires is started over only when the person says so: `--start-over`, or
  // asked at the terminal. Said no, the rest of the chain is regenerated and the run ends incomplete; with no terminal,
  // nobody is asked and the run ends there.
  let unasked: StartOverQuestion | undefined;
  const startOver = run.startOver
    ? true
    : async (question: StartOverQuestion): Promise<boolean | undefined> => {
        if (process.stdin.isTTY !== true) {
          unasked = question;
          return undefined;
        }
        return askAtTerminal(question.title, question.body);
      };
  const { planned, done } = await turri.work[run.work]({
    plainFile: run.plainFile,
    ...(run.funcIds !== undefined && run.funcIds.length > 0 ? { funcIds: run.funcIds } : {}),
    ...(run.fromScratch !== undefined ? { fromScratch: run.fromScratch } : {}),
    ...(run.work === "conform" && run.separately === true ? { separately: true } : {}),
    ...(run.buildDir !== undefined ? { exportTo: run.buildDir } : {}),
    ...(run.report !== undefined ? { report: run.report } : {}),
    command: run.command,
    startOver,
    signal,
  });
  console.log(describeModules(planned, { for: "command line" }));
  const result = await done;
  if (unasked !== undefined) console.error(c.error(`${unasked.body}\nThere is no terminal to ask whether to start over: run it again with --start-over to start over without asking.`));
  // Drained: how each codebase stands now.
  else console.log(`\n${describeModules(turri.work.status().modules, { for: "command line" })}`);
  printEnd(result);
  return result.status === "completed" ? 0 : result.status === "stopped" ? 130 : 1;
}

/** `--dry-run`: the work planned as regenerate would plan it, and each codebase's next pulse - nothing started. */
async function lookAhead(turri: Turri, plainFile: string): Promise<number> {
  const { statuses, next } = await turri.work.lookAhead(plainFile);
  console.log(describeModules(statuses, { for: "command line" }));
  for (const pulse of next) {
    console.log(`\n${c.bold(`${pulse.module}: ${pulse.title}`)}${pulse.track === "conformance" ? c.dim(" (conformance)") : ""}`);
    console.log(pulse.task ?? c.dim(pulse.why ?? "(no task)"));
  }
  return 0;
}

/** How the run ended: the verdict, every pulse, where to try what landed, and the code exported. */
function printEnd({ plainFile, status, jobs, failed, unfinished, exported }: WorkResult): void {
  const verdict =
    status === "stopped"
      ? c.warning(c.bold("stopped"))
      : failed.length > 0
        ? c.error(c.bold(`${failed.length} job${failed.length === 1 ? "" : "s"} failed`))
        : unfinished.length > 0
          ? c.error(c.bold(`not complete: ${unfinished.map((module) => `${module.module}${module.why !== undefined ? ` - ${module.why}` : ""}`).join("; ")}`))
          : c.success(c.bold("all jobs done"));
  console.log(`\n${verdict}`);
  for (const job of [...jobs].reverse()) console.log(`  ${job.id} ${pulseName(job)}: ${job.status}`);
  if (jobs.some((job) => job.status === "succeeded")) console.log(`\n${tryItCommand(plainFile)}`);
  if (exported !== undefined) {
    console.error(exported.exported ? `The code is in ${exported.dir} (${exported.module} at ${exported.commit}).` : `Nothing exported to ${exported.dir}: ${exported.why}`);
  }
}

/**
 * The options every command that regenerates takes for a headless run: `--report` and `--build-dir`, and the config's
 * own keys (configKeyOptions) - `--harness-model`, `--coding-model` (`--model`), `--judge-model`, `--review` and
 * `--mutation-testing` - as the session's overrides. Exits on a value it cannot read.
 */
export function headlessOptions(options: Record<string, string | undefined>): { report?: string; buildDir?: string; overrides: SessionOverrides } {
  const overrides = configKeyOptions(options, { review: true });
  const report = optionValue(options, "report");
  const buildDir = optionValue(options, "build-dir");
  return { overrides, ...(report !== undefined ? { report } : {}), ...(buildDir !== undefined ? { buildDir } : {}) };
}

/** Yes or no at the terminal - false when there is none, and so no one to ask. */
async function askAtTerminal(title: string, body: string): Promise<boolean> {
  if (process.stdin.isTTY !== true) return false;
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question(`\n${c.bold(title)}\n${body}\n\n${c.bold("Go ahead? [y/N] ")}`);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    prompt.close();
  }
}
