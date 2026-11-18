import { existsSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readProjectConfig } from "../config.ts";
import { whyFailed } from "./diagnose-job.ts";
import type { Job } from "./jobs.ts";
import { DEFAULT_LEDGER_KEEP_MB, ledgerRun } from "./ledger.ts";
import { maskSecrets } from "./masking.ts";
import { ensureInScratch } from "./paths.ts";

/**
 * Why a pulse did not land, kept past its session.
 *
 * Outside debug mode a pulse's log and transcript go as it ends (pulse-files.ts), and the ledger keeps facts, never
 * what a tool printed. So a pulse of an earlier session would be told as one-line facts alone - its failure's first
 * line, its test runs' exit codes. What `pulses` says of one that did not land - its diagnosis, the stages that went
 * wrong, the last failing test run's output, the last review that sent the work back, the tool calls that failed - is
 * written here as it ends, whatever the debug setting, masked as the logs are: `.turri/pulses/<id>.md`. Kept while the
 * ledger is on, and as long as the project keeps a ledger (`ledger-keep:`, 0 for none); the newest `KEPT` alone.
 */

/** The folder, in a project's `.turri`. */
export const REPORTS_DIR = "pulses";

/** How many reports a project keeps: the newest. */
export const KEPT = 200;

/** Where a project's reports are. */
export function reportsDir(project: string): string {
  return join(resolve(project), ".turri", REPORTS_DIR);
}

/** Whether a pulse ended without landing: failed, stopped, or finished with nothing landed. */
export function didNotLand(job: Job): boolean {
  if (job.status === "failed" || job.status === "stopped") return true;
  return job.status === "succeeded" && (job.details as { landed?: boolean } | undefined)?.landed === false;
}

/** Whether the project keeps a ledger, and so its reports. */
function keeps(project: string): boolean {
  try {
    return (readProjectConfig(project).ledgerKeep ?? DEFAULT_LEDGER_KEEP_MB) > 0;
  } catch {
    return true;
  }
}

/**
 * A pulse has ended: one that failed, or finished with nothing landed, has its report written, and the oldest past
 * `KEPT` go. A stopped one has none - the person halted it, or the ***plain moved on, and the ledger says which. Nothing
 * while the ledger is off, or where the project keeps none. Never throws: a report that cannot be written is never a
 * reason for the pulse to fail.
 */
export function keepFailureReport(project: string, job: Job): void {
  if (ledgerRun() === undefined || job.status === "stopped" || !didNotLand(job) || !keeps(project)) return;
  try {
    const dir = ensureInScratch(join(resolve(project), ".turri"), reportsDir(project));
    writeFileSync(join(dir, `${job.id}.md`), `${maskSecrets(whyFailed(job))}\n`);
    prune(dir);
  } catch {
    /* kept when it can be: the ledger still has the facts */
  }
}

/** The newest `KEPT` reports stay. */
function prune(dir: string): void {
  const reports = readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .map((name) => ({ name, at: statSync(join(dir, name)).mtimeMs }))
    .sort((a, b) => b.at - a.at);
  for (const old of reports.slice(KEPT)) unlinkSync(join(dir, old.name));
}

/** A pulse's report, by its whole id - or undefined when it has none. */
export function failureReport(project: string, id: string): string | undefined {
  const file = join(reportsDir(project), `${id}.md`);
  if (!existsSync(file)) return undefined;
  try {
    return readFileSync(file, "utf8").trimEnd();
  } catch {
    return undefined;
  }
}
