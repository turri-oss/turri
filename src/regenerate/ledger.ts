import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { currentChat } from "../chat-scope.ts";
import { readProjectConfig } from "../config.ts";
import { turriIdentity } from "../environment.ts";
import type { DiffWhere } from "./diff-view.ts";
import { currentPlace, onModelEvent, type ModelEvent, type UsageReport } from "./activity.ts";
import { maskSecrets } from "./masking.ts";
import { ensureInScratch } from "./paths.ts";

/**
 * The ledger: what turri does, as typed facts, one JSON line each, written as it happens - to
 * `.turri/ledger/` in the project, one file a run (a conversation, a headless run, a host's session).
 *
 * The job and debug logs keep the bodies - every prompt, reply and tool result, whole - for reading one
 * pulse closely. The ledger keeps the facts about them, across pulses, sessions and runs: that a pulse
 * was queued, started, went through its stages and ended, and how; what each agent's model calls and
 * turns cost; each tool call and test run, how long it took and how it ended; the gates' rounds and
 * verdicts; what turri refused or stopped; what its healers did; the history's commits. What a pulse
 * from an earlier session did is looked up here (`pulses`, `diagnose`, `turri ledger`) - and what it
 * regenerated, its ***plain diff, kept whole as the one body the ledger has. Never stored: prompts,
 * replies, thinking, tool arguments and results, file contents - and what strings an event carries are
 * masked as the logs are.
 *
 * A host hears each event as it is recorded (`onLedgerEvent`), with the project it is about, rather than reading the
 * file again - written or not, so a project that keeps no ledger is heard all the same.
 *
 * Observation, never control: turri may react to events as they happen, but never reads the ledger on
 * disk to decide what to build - the code and tests records are that (records.ts). Deleting
 * `.turri/ledger/` loses only what can be looked up. A ledger that cannot be written stops, and never
 * fails the work.
 *
 * Closed runs are gzipped, and the oldest pruned past `ledger-keep:` megabytes (100 unset; 0 keeps none),
 * when a run first writes to the project. `.turri` ignores itself, so none of it is ever committed.
 */

export const LEDGER_DIR = "ledger";

/** Megabytes of ledger a project keeps when `ledger-keep:` does not say. */
export const DEFAULT_LEDGER_KEEP_MB = 100;

/** Who did it: the agent an event is about. */
export interface AgentRef {
  role?: string;
  label?: string;
  model?: string;
}

/** Every event's own fields, by kind. */
export type LedgerEvent =
  // A run: one turri process writing to the project.
  | { kind: "run.started"; mode: string; version: string | null; commit: string | null; dirty: boolean | null; pid: number; platform: string; node: string }
  | { kind: "run.ended"; ms: number }
  // A chat of the run's, opened - fresh, or a saved one reopened - and closed: its id is the entry's chat.
  | { kind: "chat.opened"; reopened: boolean }
  | { kind: "chat.closed" }
  // A pulse, from queued to its end.
  | { kind: "job.queued"; jobKind: string; summary: string; pulse?: number; title?: string; model?: string; stack?: string; waitingOn: string[]; follows?: string }
  | { kind: "job.started"; waitedMs: number; logFile?: string }
  // Its ***plain diff, whole, as its agent is given it - again each time steering moves it - and where its lines are written.
  | { kind: "job.diff"; diff: string; where?: DiffWhere }
  | { kind: "job.stage"; label: string }
  | { kind: "job.retried"; attempt: number; of: number; failure: string }
  | {
      kind: "job.finished";
      status: string;
      landed?: boolean;
      passed?: boolean;
      ms: number;
      usage: UsageReport;
      failedForGood?: boolean;
      /** Who stopped it, for one stopped: the person, or turri itself, and why. */
      stoppedBy?: "person" | "turri";
      error?: string;
      logFile?: string;
    }
  // The work loop: what it planned, halted and stopped.
  | { kind: "loop.halted"; why: string; track: "code" | "conformance" }
  | { kind: "loop.stopped"; why: string }
  | { kind: "planner.failed"; step: "group" | "place" | "title"; error: string }
  | { kind: "planner.fellBack"; step: "group" | "place" | "title"; why: string }
  // The model: today's ModelEvent, and the error that ends a turn.
  | { kind: "model.call"; ms?: number; usage?: UsageReport }
  | { kind: "model.turn" }
  | { kind: "model.compaction" }
  | { kind: "provider.retry"; error: string; attempt: number; of: number; waitMs: number }
  | { kind: "provider.stall"; waitMs: number }
  | { kind: "provider.error"; error: string; transient: boolean }
  | { kind: "turn.stopped"; reason: string }
  // Tools and test runs.
  | { kind: "tool.call"; tool: string; ms: number; ok: boolean; resultChars: number }
  | { kind: "script.run"; script: string; exit: number; ms: number; timedOut: boolean; inPlace: boolean; mutated?: boolean; signature?: string }
  // The gates: their rounds and verdicts.
  | { kind: "gate.round"; gate: "unit tests" | "conformance" | "regression"; round: number; of: number; signature?: string }
  | { kind: "review.verdict"; reviewer: "unit"; review: number; pass: boolean; problems: number }
  | { kind: "arbiter.ruling"; upheld: number; dismissed: number }
  | { kind: "judge.verdict"; culprit: string; round: number; reason: string }
  // What turri refused or put back.
  | { kind: "guard.refused"; rule: "repeat" | "budget" | "restricted"; tool: string; times: number }
  | { kind: "command.refused"; rule: string }
  | { kind: "audit.putBack"; putBack: number; left: number; lost: number; conversation: number }
  // The healers: the debugger, the diagnosis of a failed pulse.
  | { kind: "healer.started"; healer: string }
  | { kind: "healer.ended"; healer: string; ms: number; found?: string }
  | { kind: "healer.failed"; healer: string; ms: number; error: string }
  // The module's history.
  | { kind: "history.committed"; subject: string; commit?: string }
  | { kind: "history.failed"; subject: string; said: string; landing: boolean }
  | { kind: "history.reset"; undone: number; paths: string[] }
  | { kind: "history.rolledBack"; why: string }
  // What the machine lacks.
  | { kind: "environment.error"; missing: string; source: string; sandbox: boolean };

export type LedgerKind = LedgerEvent["kind"];

/** One line of the ledger: the event, and where and when it happened. */
export type LedgerEntry = LedgerEvent & {
  v: 1;
  ts: string;
  seq: number;
  run: string;
  job?: string;
  module?: string;
  agent?: AgentRef;
  /** The chat the work was asked for in, in a session of several (chat-scope.ts). */
  chat?: string;
};

/** Where an event happened, when not where the code recording it runs: a job's own place is found by itself. */
export interface LedgerPlace {
  project?: string;
  job?: string;
  module?: string;
  agent?: AgentRef;
}

interface Writer {
  file?: string;
  broken: boolean;
}

interface Run {
  id: string;
  mode: string;
  started: number;
  /** The project an event with no place of its own is about: the conversation's, the headless run's. */
  project?: string;
  writers: Map<string, Writer>;
  warn?: (message: string) => void;
  unsubscribe: () => void;
}

let current: Run | undefined;
let seq = 0;

const listeners = new Set<(entry: LedgerEntry, project: string) => void>();

/**
 * Hear every event from now on, as it is recorded, with the project it is about - while the ledger is on. Returns
 * what stops it. A listener that throws is left out of that event, never the work.
 */
export function onLedgerEvent(listener: (entry: LedgerEntry, project: string) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function tell(entry: LedgerEntry, project: string): void {
  for (const listener of listeners) {
    try {
      listener(entry, project);
    } catch {
      /* a listener that fails does not take the work down */
    }
  }
}

/** Whether turri turns the ledger on as it starts: always, unless TURRI_LEDGER=off. */
export function ledgerWanted(): boolean {
  return process.env.TURRI_LEDGER !== "off";
}

/** This run's id, while the ledger is on. */
export function ledgerRun(): string | undefined {
  return current?.id;
}

/**
 * Start the ledger for this process: from now on, what is recorded is written. `project` is the one events about no
 * project of their own go to. `warn` is told, once a project, when its ledger cannot be written. Returns what stops it.
 */
export function startLedger(options: { mode: string; project?: string; warn?: (message: string) => void }): () => void {
  stopLedger();
  const run: Run = {
    id: randomUUID().slice(0, 8),
    mode: options.mode,
    started: Date.now(),
    ...(options.project !== undefined ? { project: resolve(options.project) } : {}),
    writers: new Map(),
    ...(options.warn !== undefined ? { warn: options.warn } : {}),
    unsubscribe: () => {},
  };
  current = run;
  run.unsubscribe = onModelEvent((event) => recordModelEvent(event));
  process.once("exit", endRun);
  return stopLedger;
}

/** Stop the ledger: each project this run wrote to is told it ended. */
export function stopLedger(): void {
  if (current === undefined) return;
  endRun();
}

function endRun(): void {
  const run = current;
  if (run === undefined) return;
  process.removeListener("exit", endRun);
  for (const project of run.writers.keys()) write(run, project, { kind: "run.ended", ms: Date.now() - run.started }, {});
  run.unsubscribe();
  current = undefined;
}

/** Record an event: where it happened is the job this code runs for, unless `place` says. Nothing while the ledger is off. */
export function record(event: LedgerEvent, place: LedgerPlace = {}): void {
  const run = current;
  if (run === undefined) return;
  const here = currentPlace();
  const project = place.project ?? here.project ?? run.project;
  if (project === undefined) return;
  const job = place.job ?? here.job;
  const module = place.module ?? here.module;
  const chat = currentChat()?.id;
  write(run, resolve(project), event, {
    ...(job !== undefined ? { job } : {}),
    ...(module !== undefined ? { module } : {}),
    ...(place.agent !== undefined ? { agent: place.agent } : {}),
    ...(chat !== undefined ? { chat } : {}),
  });
}

/**
 * Run a healer - the debugger, the diagnosis of a failed pulse - and record it: started, ended with what it found, or
 * failed and why. A healer that fails gives undefined, as it did before it was recorded, but is no longer silent.
 */
export async function healing<T>(healer: string, work: () => Promise<T>, found?: (result: T) => string | undefined): Promise<T | undefined> {
  const started = Date.now();
  record({ kind: "healer.started", healer });
  try {
    const result = await work();
    const said = result !== undefined && found !== undefined ? found(result) : undefined;
    record({ kind: "healer.ended", healer, ms: Date.now() - started, ...(said !== undefined ? { found: firstLine(said, 240) } : {}) });
    return result;
  } catch (error) {
    record({ kind: "healer.failed", healer, ms: Date.now() - started, error: firstLine(error instanceof Error ? error.message : String(error), 300) });
    return undefined;
  }
}

/** A failure's fingerprint, short: two runs failing the same way have the same one. */
export function signatureHash(signature: string): string {
  return createHash("sha1").update(signature).digest("hex").slice(0, 12);
}

/** The first line of a text, at most `max` characters: what an event keeps of an error or a reason. */
export function firstLine(text: string, max = 200): string {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function recordModelEvent(event: ModelEvent): void {
  const agent: AgentRef = { ...(event.role !== undefined ? { role: event.role } : {}), ...(event.label !== undefined ? { label: event.label } : {}), ...(event.model !== undefined ? { model: event.model } : {}) };
  const place: LedgerPlace = { ...(event.job !== undefined ? { job: event.job } : {}), ...(Object.keys(agent).length > 0 ? { agent } : {}) };
  switch (event.kind) {
    case "call":
      record({ kind: "model.call", ...(event.ms !== undefined ? { ms: event.ms } : {}), ...(event.usage !== undefined ? { usage: event.usage } : {}) }, place);
      break;
    case "turn":
      record({ kind: "model.turn" }, place);
      break;
    case "compaction":
      record({ kind: "model.compaction" }, place);
      break;
    case "provider_retry":
      record({ kind: "provider.retry", error: firstLine(event.error ?? "", 300), attempt: event.attempt ?? 0, of: event.of ?? 0, waitMs: event.waitMs ?? 0 }, place);
      break;
    case "provider_stall":
      record({ kind: "provider.stall", waitMs: event.waitMs ?? 0 }, place);
      break;
    case "stopped":
      record({ kind: "turn.stopped", reason: firstLine(event.reason ?? "", 300) }, place);
      break;
  }
}

/** The project's ledger folder. */
export function ledgerDir(project: string): string {
  return join(resolve(project), ".turri", LEDGER_DIR);
}

/** How many megabytes of ledger the project keeps. */
function keepOf(project: string): number {
  try {
    return readProjectConfig(project).ledgerKeep ?? DEFAULT_LEDGER_KEEP_MB;
  } catch {
    return DEFAULT_LEDGER_KEEP_MB;
  }
}

function write(run: Run, project: string, event: LedgerEvent, where: Omit<LedgerPlace, "project"> & { chat?: string }): void {
  let writer = run.writers.get(project);
  if (writer === undefined) {
    writer = openWriter(run, project);
    run.writers.set(project, writer);
  }
  seq += 1;
  const entry = { v: 1, ts: new Date().toISOString(), seq, run: run.id, ...where, ...masked(event) } as LedgerEntry;
  tell(entry, project);
  if (writer.broken || writer.file === undefined) return;
  try {
    appendFileSync(writer.file, `${JSON.stringify(entry)}\n`);
  } catch (error) {
    writer.broken = true;
    run.warn?.(`turri's ledger for ${project} cannot be written, and is not from now on: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** The run's file in the project, begun with its run.started - or none, when the project keeps no ledger. */
function openWriter(run: Run, project: string): Writer {
  const keep = keepOf(project);
  const dir = ledgerDir(project);
  const identity = turriIdentity();
  seq += 1;
  const started: LedgerEvent = {
    kind: "run.started",
    mode: run.mode,
    version: identity.version,
    commit: identity.git_commit,
    dirty: identity.git_dirty,
    pid: process.pid,
    platform: process.platform,
    node: process.versions.node,
  };
  const entry = { v: 1, ts: new Date().toISOString(), seq, run: run.id, ...started } as LedgerEntry;
  // Heard whether it is written or not: a project that keeps no ledger is still a run a host shows.
  tell(entry, project);
  try {
    if (existsSync(dir)) tidy(dir, keep * 1024 * 1024);
    if (keep <= 0) return { broken: false };
    ensureInScratch(join(project, ".turri"), dir);
    const stamp = new Date(run.started).toISOString().replace(/[:.]/g, "-");
    const file = join(dir, `${stamp}-${run.id}-p${process.pid}.jsonl`);
    writeFileSync(file, `${JSON.stringify(entry)}\n`, { flag: "a" });
    return { file, broken: false };
  } catch (error) {
    run.warn?.(`turri's ledger for ${project} cannot be written: ${error instanceof Error ? error.message : String(error)}`);
    return { broken: true };
  }
}

/** Every string an event carries, masked as the logs are. */
function masked<T>(value: T): T {
  if (typeof value === "string") return maskSecrets(value) as T;
  if (Array.isArray(value)) return value.map((item) => masked(item)) as T;
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, masked(item)])) as T;
  return value;
}

/** A run file's process, from its name: `<stamp>-<run>-p<pid>.jsonl`. */
function pidOf(name: string): number | undefined {
  const match = /-p(\d+)\.jsonl(?:\.gz)?$/.exec(name);
  return match !== null ? Number(match[1]) : undefined;
}

function alive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Not ours to signal, but there.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Keep the ledger folder within `keepBytes`: the files of runs that have ended gzipped, then the oldest pruned until
 * the rest fit. A run still going - this one, or another turri's in the same project - is never touched.
 */
export function tidy(dir: string, keepBytes: number): void {
  const files = () => readdirSync(dir).filter((name) => /\.jsonl(?:\.gz)?$/.test(name)).sort();
  const live = (name: string) => {
    const pid = pidOf(name);
    return name.endsWith(".jsonl") && (pid === undefined || alive(pid));
  };
  for (const name of files()) {
    if (!name.endsWith(".jsonl") || live(name)) continue;
    try {
      const path = join(dir, name);
      writeFileSync(`${path}.gz`, gzipSync(readFileSync(path)));
      unlinkSync(path);
    } catch {
      /* left as it is - pruned like any other */
    }
  }
  const sized = files().map((name) => ({ name, size: sizeOf(join(dir, name)) }));
  let total = sized.reduce((sum, file) => sum + file.size, 0);
  for (const file of sized) {
    if (total <= keepBytes) break;
    if (live(file.name)) continue;
    try {
      unlinkSync(join(dir, file.name));
      total -= file.size;
    } catch {
      /* kept */
    }
  }
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** What to read of the ledger. */
export interface LedgerQuery {
  /** A pulse, by its id or the start of it. */
  job?: string;
  run?: string;
  kinds?: LedgerKind[];
  /** Only events at or after this time. */
  since?: Date;
}

/**
 * The project's ledger, oldest first - every run's, the gzipped ones too, as `query` narrows it. A line that does not
 * parse, or a kind this turri does not know, is skipped: the ledger is read as it is, whatever wrote it.
 */
export function readLedger(project: string, query: LedgerQuery = {}): LedgerEntry[] {
  const dir = ledgerDir(project);
  if (!existsSync(dir)) return [];
  const since = query.since?.toISOString();
  const entries: LedgerEntry[] = [];
  for (const name of readdirSync(dir).filter((file) => /\.jsonl(?:\.gz)?$/.test(file)).sort()) {
    let text: string;
    try {
      const raw = readFileSync(join(dir, name));
      text = name.endsWith(".gz") ? gunzipSync(raw).toString("utf8") : raw.toString("utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      let entry: LedgerEntry;
      try {
        entry = JSON.parse(line) as LedgerEntry;
      } catch {
        continue;
      }
      if (entry.v !== 1 || typeof entry.kind !== "string") continue;
      if (query.run !== undefined && entry.run !== query.run) continue;
      if (query.job !== undefined && (entry.job === undefined || !entry.job.startsWith(query.job))) continue;
      if (query.kinds !== undefined && !query.kinds.includes(entry.kind)) continue;
      if (since !== undefined && entry.ts < since) continue;
      entries.push(entry);
    }
  }
  return entries;
}
