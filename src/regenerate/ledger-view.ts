import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describeUsage, type UsageReport } from "./activity.ts";
import { formatElapsed, type Job, type JobStatus } from "./jobs.ts";
import { LEDGER_DIR, ledgerRun, readLedger, type LedgerEntry } from "./ledger.ts";

/**
 * What the ledger says of pulses, read back: one pulse - from this session or an earlier one - as the chat and
 * `turri ledger` are told it, and the runs a project has had, each with its pulses.
 */

type Of<K extends LedgerEntry["kind"]> = Extract<LedgerEntry, { kind: K }>;

/** The projects whose ledgers a folder's pulses may be in: its own, and those of the projects in folders under it. */
export function ledgerProjects(cwd: string, depth = 3): string[] {
  const found: string[] = [];
  const visit = (dir: string, left: number) => {
    if (existsSync(join(dir, ".turri", LEDGER_DIR))) found.push(dir);
    if (left === 0) return;
    let names: string[];
    try {
      names = readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
      return;
    }
    for (const name of names) {
      if (name.startsWith(".") || name === "node_modules" || name === "plain_modules" || name === "dist") continue;
      visit(join(dir, name), left - 1);
    }
  };
  visit(resolve(cwd), depth);
  return found;
}

/** One pulse, as its events tell it. */
export interface PulseView {
  id: string;
  run: string;
  /** How its run was started - chat, host, regenerate - and when. */
  runMode?: string;
  queued?: Of<"job.queued"> & { module?: string };
  started?: Of<"job.started">;
  finished?: Of<"job.finished">;
  stages: string[];
  retried: Array<Of<"job.retried">>;
  rounds: Map<string, { round: number; of: number }>;
  scripts: Array<Of<"script.run">>;
  judge: Map<string, number>;
  reviews: Array<Of<"review.verdict">>;
  healers: Array<Of<"healer.ended"> | Of<"healer.failed">>;
  provider: { retries: number; stalls: number; errors: string[] };
  refused: Map<string, number>;
  stopped: string[];
  history: Array<Of<"history.committed"> | Of<"history.failed"> | Of<"history.reset"> | Of<"history.rolledBack">>;
  environment?: Of<"environment.error">;
  usage?: UsageReport;
}

/** A pulse's events, gathered: undefined when the ledger has none of it. `entries` are its run's, oldest first. */
export function pulseView(id: string, entries: LedgerEntry[]): PulseView | undefined {
  const own = entries.filter((entry) => entry.job !== undefined && entry.job.startsWith(id));
  if (own.length === 0) return undefined;
  const fullId = own[0]!.job!;
  const view: PulseView = {
    id: fullId,
    run: own[0]!.run,
    stages: [],
    retried: [],
    rounds: new Map(),
    scripts: [],
    judge: new Map(),
    reviews: [],
    healers: [],
    provider: { retries: 0, stalls: 0, errors: [] },
    refused: new Map(),
    stopped: [],
    history: [],
  };
  const started = entries.find((entry): entry is Of<"run.started"> & LedgerEntry => entry.kind === "run.started" && entry.run === view.run);
  if (started !== undefined) view.runMode = `${started.mode}, ${started.ts.slice(0, 16).replace("T", " ")}`;
  for (const entry of own) {
    if (entry.job !== fullId) continue;
    switch (entry.kind) {
      case "job.queued":
        view.queued = { ...entry, ...(entry.module !== undefined ? { module: entry.module } : {}) };
        break;
      case "job.started":
        view.started = entry;
        break;
      case "job.finished":
        view.finished = entry;
        view.usage = entry.usage;
        break;
      case "job.stage":
        view.stages.push(entry.label);
        break;
      case "job.retried":
        view.retried.push(entry);
        break;
      case "gate.round":
        view.rounds.set(entry.gate, { round: Math.max(entry.round, view.rounds.get(entry.gate)?.round ?? 0), of: entry.of });
        break;
      case "script.run":
        view.scripts.push(entry);
        break;
      case "judge.verdict":
        view.judge.set(entry.culprit, (view.judge.get(entry.culprit) ?? 0) + 1);
        break;
      case "review.verdict":
        view.reviews.push(entry);
        break;
      case "healer.ended":
      case "healer.failed":
        view.healers.push(entry);
        break;
      case "provider.retry":
        view.provider.retries += 1;
        break;
      case "provider.stall":
        view.provider.stalls += 1;
        break;
      case "provider.error":
        view.provider.errors.push(entry.error);
        break;
      case "guard.refused":
        view.refused.set(entry.rule, (view.refused.get(entry.rule) ?? 0) + 1);
        break;
      case "command.refused":
        view.refused.set("command check", (view.refused.get("command check") ?? 0) + 1);
        break;
      case "turn.stopped":
        view.stopped.push(entry.reason);
        break;
      case "history.committed":
      case "history.failed":
      case "history.reset":
      case "history.rolledBack":
        view.history.push(entry);
        break;
      case "environment.error":
        view.environment = entry;
        break;
    }
  }
  return view;
}

/** What a pulse is called: its module, kind and number - as pulseName says it for a live one. */
function nameOf(view: PulseView): string {
  const queued = view.queued;
  if (queued === undefined) return view.id;
  if (queued.module === undefined) return queued.summary;
  return queued.pulse !== undefined ? `${queued.module} · ${queued.jobKind} pulse ${queued.pulse}` : `${queued.module} ${queued.jobKind}`;
}

function outcomeOf(view: PulseView): string {
  const finished = view.finished;
  if (finished === undefined) return view.started !== undefined ? "never ended - its run stopped while it ran" : "never started";
  const landed = finished.landed === true ? ", landed" : finished.landed === false ? ", did not land" : "";
  const stopped = finished.stoppedBy !== undefined ? ` by ${finished.stoppedBy === "turri" ? "turri" : "the person"}` : "";
  return `${finished.status}${stopped}${landed}, after ${formatElapsed(finished.ms)}`;
}

/** A pulse from the ledger, for the chat and `turri ledger <pulse>`: what happened in it, as facts. */
export function describePulseView(view: PulseView): string {
  const lines = [`${view.id} · ${nameOf(view)}${view.queued?.title !== undefined ? ` - ${view.queued.title}` : ""}`];
  lines.push(`  run ${view.run}${view.runMode !== undefined ? ` (${view.runMode})` : ""}`);
  lines.push(`  ${outcomeOf(view)}${view.usage !== undefined && describeUsage(view.usage) !== "" ? ` · ${describeUsage(view.usage)}` : ""}${view.queued?.model !== undefined ? ` · ${view.queued.model}` : ""}`);
  if (view.finished?.error !== undefined) lines.push(`  ended with: ${view.finished.error}`);
  if (view.environment !== undefined) lines.push(`  the environment lacks ${view.environment.missing} (found by ${view.environment.source === "harness" ? "turri" : "an agent"})`);
  for (const retry of view.retried) lines.push(`  tried again (${retry.attempt} of ${retry.of}) after: ${retry.failure}`);
  if (view.rounds.size > 0) lines.push(`  rounds: ${[...view.rounds].map(([gate, { round, of }]) => `${gate} ${round} of ${of}`).join("; ")}`);
  if (view.scripts.length > 0) {
    const failing = view.scripts.filter((run) => run.exit !== 0);
    const signatures = new Map<string, number>();
    for (const run of failing) if (run.signature !== undefined) signatures.set(run.signature, (signatures.get(run.signature) ?? 0) + 1);
    const most = Math.max(0, ...signatures.values());
    const timedOut = view.scripts.filter((run) => run.timedOut).length;
    lines.push(
      `  test runs: ${view.scripts.length}, ${failing.length} failing` +
        (most > 1 ? ` - ${most} of them the same way` : "") +
        (timedOut > 0 ? `, ${timedOut} stopped at the time limit` : ""),
    );
  }
  if (view.judge.size > 0) lines.push(`  the judge blamed: ${[...view.judge].map(([culprit, times]) => `${culprit} ${times}x`).join(", ")}`);
  if (view.reviews.length > 0) lines.push(`  reviews: ${view.reviews.map((review) => (review.pass ? "passed" : `${review.problems} problem${review.problems === 1 ? "" : "s"}`)).join(", ")}`);
  // The same outcome again is counted, not said again: a debugger failing for want of a key fails every time.
  const healed = new Map<string, number>();
  for (const healer of view.healers) {
    const line = healer.kind === "healer.failed" ? `the ${healer.healer} FAILED: ${healer.error}` : `the ${healer.healer}${healer.found !== undefined ? `: ${healer.found}` : " found nothing"}`;
    healed.set(line, (healed.get(line) ?? 0) + 1);
  }
  for (const [line, times] of healed) lines.push(`  ${times > 1 ? line.replace(/^(the \S+( FAILED)?)/, `$1 ${times}x`) : line}`);
  const provider = view.provider;
  if (provider.retries + provider.stalls + provider.errors.length > 0) {
    lines.push(`  the model provider: ${provider.retries} retries, ${provider.stalls} stalls${provider.errors.length > 0 ? `, ${provider.errors.length} errors - last: ${provider.errors.at(-1)}` : ""}`);
  }
  if (view.refused.size > 0) lines.push(`  turri refused calls: ${[...view.refused].map(([rule, times]) => `${rule} ${times}x`).join(", ")}`);
  if (view.stopped.length > 0) lines.push(`  turri stopped ${view.stopped.length} turn${view.stopped.length === 1 ? "" : "s"} - last: ${view.stopped.at(-1)}`);
  for (const event of view.history) {
    if (event.kind === "history.committed") lines.push(`  committed: ${event.subject}`);
    else if (event.kind === "history.failed") lines.push(`  a commit FAILED${event.landing ? " (landing work)" : ""}: ${event.said}`);
    else if (event.kind === "history.reset") lines.push(`  put back to the last commit: ${event.undone} change${event.undone === 1 ? "" : "s"} undone`);
    else lines.push(`  rolled back: ${event.why}`);
  }
  if (view.stages.length > 0) lines.push("  last stages:", ...view.stages.slice(-8).map((stage) => `    ${stage}`));
  const log = view.finished?.logFile ?? view.started?.logFile;
  if (log !== undefined) lines.push(`  log: ${log}`);
  return lines.join("\n");
}

/** A pulse the ledger of any of these projects knows, described - or undefined. */
export function describePastPulse(projects: string[], id: string): string | undefined {
  for (const project of projects) {
    const entries = readLedger(project);
    const view = pulseView(id, entries);
    if (view !== undefined) return describePulseView(view);
  }
  return undefined;
}

/** A run of the project's, and its pulses: the most recent first. */
export interface RunView {
  run: string;
  started?: Of<"run.started">;
  ended?: Of<"run.ended">;
  pulses: PulseView[];
}

export function runViews(project: string): RunView[] {
  const entries = readLedger(project);
  const runs = new Map<string, LedgerEntry[]>();
  for (const entry of entries) runs.set(entry.run, [...(runs.get(entry.run) ?? []), entry]);
  return [...runs]
    .map(([run, own]) => {
      const ids = [...new Set(own.filter((entry) => entry.kind === "job.queued").map((entry) => entry.job!))];
      const started = own.find((entry): entry is Of<"run.started"> & LedgerEntry => entry.kind === "run.started");
      const ended = own.find((entry): entry is Of<"run.ended"> & LedgerEntry => entry.kind === "run.ended");
      return { run, ...(started !== undefined ? { started } : {}), ...(ended !== undefined ? { ended } : {}), pulses: ids.map((id) => pulseView(id, own)!).filter(Boolean) };
    })
    .reverse();
}

/** The project's last runs, a line a pulse: what `turri ledger` prints. */
export function describeRuns(runs: RunView[]): string {
  if (runs.length === 0) return "The ledger is empty: nothing has run here since it began.";
  return runs
    .map((view) => {
      const started = view.started as (Of<"run.started"> & { ts?: string }) | undefined;
      const when = started?.ts !== undefined ? started.ts.slice(0, 19).replace("T", " ") : "";
      const version = started?.version !== undefined && started.version !== null ? ` · turri ${started.version}${started.commit !== null && started.commit !== undefined ? ` (${started.commit.slice(0, 7)}${started.dirty === true ? ", changed" : ""})` : ""}` : "";
      const head = `run ${view.run} · ${started?.mode ?? "?"} · ${when}${view.ended !== undefined ? ` · ${formatElapsed(view.ended.ms)}` : " · still running, or killed"}${version}`;
      const pulses = view.pulses.map((pulse) => `  ${pulse.id} ${nameOf(pulse).padEnd(32)} ${outcomeOf(pulse)}${pulse.usage !== undefined && describeUsage(pulse.usage) !== "" ? ` · ${describeUsage(pulse.usage)}` : ""}`);
      return [head, ...(pulses.length > 0 ? pulses : ["  no pulses"])].join("\n");
    })
    .join("\n\n");
}

/**
 * The pulses of earlier sessions, for a list beside this session's: the last `runs` runs of these projects that are not
 * this one, the most recent first, each pulse as a job of its own marked `earlier` - none `known` to this session's
 * registry. `more`: how many runs the ledger has beyond them.
 */
export function earlierPulses(projects: string[], known: Set<string>, runs = 3): { jobs: Job[]; runs: RunView[]; more: number } {
  const own = ledgerRun();
  const all = projects
    .flatMap((project) => runViews(project))
    .filter((view) => view.run !== own && view.pulses.some((pulse) => !known.has(pulse.id)))
    .sort((a, b) => (b.started?.ts ?? "").localeCompare(a.started?.ts ?? ""));
  const shown = all.slice(0, runs);
  return { jobs: shown.flatMap((view) => view.pulses.filter((pulse) => !known.has(pulse.id)).map(asJob)), runs: shown, more: all.length - shown.length };
}

/** A pulse of the ledger's, as the lists show a job: finished as it ended, its time and cost - and nothing to run. */
export function asJob(view: PulseView): Job {
  const at = (entry: { ts?: string } | undefined) => (entry?.ts !== undefined ? Date.parse(entry.ts) : undefined);
  const queuedAt = at(view.queued as { ts?: string } | undefined) ?? 0;
  const startedAt = at(view.started as { ts?: string } | undefined) ?? queuedAt;
  const finished = view.finished;
  // A pulse whose run ended before it did never finished: it was stopped with its run.
  const status: JobStatus = finished !== undefined && ["succeeded", "failed", "stopped"].includes(finished.status) ? (finished.status as JobStatus) : "stopped";
  const logFile = finished?.logFile ?? view.started?.logFile;
  return {
    id: view.id,
    kind: view.queued?.jobKind ?? "regenerate",
    summary: view.queued?.summary ?? view.id,
    ...(view.queued?.module !== undefined ? { module: view.queued.module } : {}),
    ...(view.queued?.pulse !== undefined ? { pulse: view.queued.pulse } : {}),
    ...(view.queued?.title !== undefined ? { title: view.queued.title } : {}),
    ...(view.queued?.model !== undefined ? { model: view.queued.model } : {}),
    status,
    sequence: 0,
    queuedAt,
    startedAt,
    finishedAt: finished !== undefined ? startedAt + finished.ms : startedAt,
    waitingOn: [],
    tail: "",
    activity: [],
    usage: view.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    agents: [],
    transcript: [],
    ...(logFile !== undefined ? { logFile } : {}),
    ...(finished?.error !== undefined ? { error: finished.error } : {}),
    details: { ...(finished?.landed !== undefined ? { landed: finished.landed } : {}), ...(finished?.passed !== undefined ? { passed: finished.passed } : {}) },
    earlier: { run: view.run, ...(view.runMode !== undefined ? { runMode: view.runMode } : {}), lines: describePulseView(view).split("\n").slice(1).map((line) => line.replace(/^  /, "")) },
  };
}
