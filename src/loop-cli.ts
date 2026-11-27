import { createInterface } from "node:readline/promises";
import { describeModules, runHeadless, type HeadlessRun, type HeadlessView } from "@turri-dev/core/commands";
import { pulseName, type SpecGap } from "@turri-dev/core/terminal";
import { c } from "./module-report.ts";
import { tryItCommand } from "./regenerate/delivery.ts";
import { configKeyOptions, optionValue } from "./cli-options.ts";

const consoleView: HeadlessView = {
  orphansStopped(count) { console.log(`Stopped ${count} process group${count === 1 ? "" : "s"} a turri that was killed left running.`); },
  warn(message) { console.error(message); },
  exported(exported, buildDir) {
    console.error(exported.exported === true ? `The code is in ${buildDir} (${String(exported.module)} at ${String(exported.commit)}).` : `Nothing exported to ${buildDir}: ${String(exported.why)}`);
  },
  pulseRunning(job) { console.log(`${c.accent(`▶ ${job.id}`)} ${pulseName(job)}${job.stage !== undefined ? c.dim(` - ${job.stage}`) : ""}`); },
  pulseFinished(job) {
    const mark = job.status === "succeeded" ? c.success("✓") : job.status === "stopped" ? c.dim("■") : c.error("✗");
    console.log(`${mark} ${job.id} ${pulseName(job)} - ${job.status}`);
    if (job.status !== "succeeded") console.log(c.dim((job.announce ?? job.report ?? job.error ?? "").trim()));
    // Its report is not printed when it succeeds, and nobody is asked here: the spec gaps its agents met are said.
    else for (const gap of (job.details as { specGaps?: SpecGap[] } | undefined)?.specGaps ?? []) console.log(c.warning(`  spec gap: ${gap.question}`), c.dim(`Meanwhile: ${gap.assumption}`));
  },
  turnIncident(event, line) { console.log(c.warning(`  ${event.job !== undefined ? `${event.job}: ` : ""}${line}`)); },
  planned(statuses) { console.log(describeModules(statuses, { for: "command line" })); },
  canAsk: () => process.stdin.isTTY === true,
  ask: askAtTerminal,
  startOverRefused(message) { console.error(c.error(message)); },
  nextPulse(next) {
    console.log(`\n${c.bold(`${next.module}: ${next.title}`)}${next.track === "conformance" ? c.dim(" (conformance)") : ""}`);
    console.log(next.task ?? c.dim(next.why ?? "(no task)"));
  },
  drained(statuses) { console.log(`\n${describeModules(statuses, { for: "command line" })}`); },
  ended({ plainFile, jobs: ended, failed, unfinished }) {
    const verdict =
      failed.length > 0
        ? c.error(c.bold(`${failed.length} job${failed.length === 1 ? "" : "s"} failed`))
        : unfinished.length > 0
          ? c.error(c.bold(`not complete: ${unfinished.map((module) => `${module.module}${module.why !== undefined ? ` - ${module.why}` : ""}`).join("; ")}`))
          : c.success(c.bold("all jobs done"));
    console.log(`\n${verdict}`);
    for (const job of [...ended].reverse()) console.log(`  ${job.id} ${pulseName(job)}: ${job.status}`);
    if (ended.some((job) => job.status === "succeeded")) console.log(`\n${tryItCommand(plainFile)}`);
  },
};

export async function runLoop(request: HeadlessRun): Promise<never> {
  process.exit((await runHeadless(request, consoleView)).exitCode);
}

/**
 * The options every command that regenerates takes for a headless run: `--report` and `--build-dir`, and the config's
 * own keys (configKeyOptions) - `--harness-model`, `--coding-model` (`--model`), `--judge-model`, `--review` and
 * `--mutation-testing` - read as if config.turri.yaml had them. Exits on a value it cannot read.
 */
export function headlessOptions(options: Record<string, string | undefined>): { report?: string; buildDir?: string } {
  configKeyOptions(options, { review: true });
  const report = optionValue(options, "report");
  const buildDir = optionValue(options, "build-dir");
  return { ...(report !== undefined ? { report } : {}), ...(buildDir !== undefined ? { buildDir } : {}) };
}

/** Yes or no at the terminal - or undefined when there is none, and so no one to ask. */
async function askAtTerminal(title: string, body: string): Promise<boolean | undefined> {
  if (process.stdin.isTTY !== true) return undefined;
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question(`\n${c.bold(title)}\n${body}\n\n${c.bold("Go ahead? [y/N] ")}`);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    prompt.close();
  }
}
