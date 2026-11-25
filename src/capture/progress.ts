import { basename, sep } from "node:path";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { skillProgressLine } from "../skill-progress.ts";
import type { AgentWatch } from "./agents.ts";
import { featureKey, isMerged } from "./assemble.ts";
import type { CaptureState } from "./state.ts";

/**
 * A capture as it runs, for whoever shows it - the chat's lines above the input. A capture works in the background
 * for minutes; without these, nothing on the screen moves between its start and its report, a capture at work cannot
 * be told from one that hangs, and nobody can tell how much is left.
 *
 *   capture shorty  ✓ survey ━ ✓ outline ━ ⠋ features ─ ○ concepts ─ ○ readability ─ ○ interface ─ ○ trial ─ ○ scripts  phase 3 of 8
 *     ██████▓▓▓▓▓▓░░░░░░░░░░░░  1 of 3 features captured, 2 at work · 2m 10s · $0.84
 *       feature short-links#create-link   40s  ○ read app/api/links.py · thinking
 *       feature short-links#follow-link    5s  waiting for the model
 *     captured short-links#link-clicks: 1 functional spec
 *
 * The first line: its phases, as a skill's are drawn - those done ticked, the one it is in spinning, those to come - and
 * how far through them it is. Under it, the phase it is in: a strip of its work in the regen panel's colours - done,
 * at work, waiting - what that is in words, how long it has taken and what its models have cost. Under that, each agent
 * at work: what it does, for how long, and what it did last. Last, what the capture said last.
 */

export type CaptureStage = "mapping" | "surveying" | "checking" | "extracting" | "outlining" | "dividing" | "compact-writing" | "capturing" | "filling" | "gathering" | "reconciling" | "reading" | "verifying" | "trying" | "writing" | "scripts";

export interface CaptureAgentStatus {
  /** What it does: `survey`, `feature short-links#create-link`. */
  label: string;
  /** When it started. */
  since: number;
  /** The last thing it did: `○ read app/main.py`. */
  did?: string;
  /** What it is at this moment: thinking, waiting for the model, writing a call. */
  now?: string;
}

/** A capture's phases, as its first line names them: what each stage is part of (`phaseOf`). */
export const CAPTURE_PHASES = ["survey", "outline", "features", "concepts", "readability", "interface", "trial", "scripts"];
const COMPACT_PHASES = ["survey", "features", "interface", "trial", "scripts"];

/** The phase a stage is part of, by its place in CAPTURE_PHASES. */
export function phaseOf(stage: CaptureStage): number {
  switch (stage) {
    case "mapping":
    case "surveying":
    case "checking":
    case "extracting":
      return 0;
    case "outlining":
    case "dividing":
      return 1;
    case "capturing":
    case "compact-writing":
    case "filling":
    case "gathering":
      return 2;
    case "reconciling":
      return 3;
    case "reading":
      return 4;
    case "verifying":
      return 5;
    case "trying":
      return 6;
    case "writing":
    case "scripts":
      return 7;
  }
}

export interface CaptureStatus {
  root: string;
  started: number;
  stage: CaptureStage;
  pipeline?: "compact" | "staged";
  /** Features outlined so far - none merged into others - and how many of them are done: captured, or failed. */
  features: { outlined: number; done: number };
  /** Areas still to be split or outlined: more features to come. */
  outlining: number;
  /** The work of a stage other than the features - parts divided, concepts, modules, scripts - given as it starts, and how much is done. */
  work: { done: number; total: number };
  /** The agents at work, in the order they started. */
  agents: CaptureAgentStatus[];
  /** What its models have cost so far, in dollars. */
  cost: number;
  /** What it said last: an area split, a feature captured. */
  last?: string;
}

/** Keeps a capture's status as it runs, and hands on every line it says and every change. */
export class CaptureTracker {
  readonly status: CaptureStatus;
  private readonly progress: (line: string) => void;
  private readonly watch: (status: CaptureStatus) => void;

  constructor(root: string, progress: (line: string) => void = () => {}, watch: (status: CaptureStatus) => void = () => {}) {
    this.status = { root, started: Date.now(), stage: "mapping", features: { outlined: 0, done: 0 }, outlining: 0, work: { done: 0, total: 0 }, agents: [], cost: 0 };
    this.progress = progress;
    this.watch = watch;
    this.changed();
  }

  /** The stage it is at, with how much work it has to do there, when it is counted. */
  stage(stage: CaptureStage, total = 0): void {
    this.status.stage = stage;
    this.status.work = { done: 0, total };
    this.changed();
  }

  /** A piece of the stage's work done. */
  worked(): void {
    this.status.work.done += 1;
    this.changed();
  }

  said(line: string): void {
    this.status.last = line;
    this.progress(line);
    this.changed();
  }

  /** The features outlined and done, counted from the state as it is now. */
  counted(state: CaptureState): void {
    this.status.pipeline = state.plan?.kind;
    this.status.features = featureCounts(state);
    this.status.outlining = Object.values(state.areas).filter((area) => area.children === undefined && area.features === undefined && area.failed === undefined).length;
    this.changed();
  }

  /** An agent's watch: it shows while the agent works, with what it did last. */
  agent(label: string): AgentWatch {
    const root = this.status.root;
    let shown: CaptureAgentStatus | undefined;
    return {
      started: () => {
        shown = { label, since: Date.now() };
        this.status.agents.push(shown);
        this.changed();
      },
      did: (line) => {
        if (shown === undefined) return;
        shown.did = activityLine(line, root);
        this.changed();
      },
      now: (label) => {
        if (shown === undefined || shown.now === label) return;
        if (label === undefined) delete shown.now;
        else shown.now = label;
        this.changed();
      },
      spent: (cost) => {
        this.status.cost += cost;
        this.changed();
      },
      ended: () => {
        this.status.agents = this.status.agents.filter((agent) => agent !== shown);
        shown = undefined;
        this.changed();
      },
    };
  }

  private changed(): void {
    this.watch(this.status);
  }
}

/** Features outlined so far, across every area - those merged into others not among them - and how many of them are done. */
export function featureCounts(state: CaptureState): { outlined: number; done: number } {
  const outlined = Object.values(state.areas).reduce((sum, area) => sum + (area.features ?? []).filter((feature) => !isMerged(state, featureKey(area.id, feature.name))).length, 0);
  const done = Object.values(state.features).filter((feature) => feature.captured !== undefined || feature.failed !== undefined).length;
  return { outlined, done };
}

/** A tool call as the activity says it, for a line of its own: no role, no model's time, the codebase's paths relative to it. */
export function activityLine(line: string, root: string): string {
  const trimmed = line
    .trim()
    .replace(/^\([\w-]+\)\s+/, "")
    .replace(/\s+\(model [^)]*\)$/, "");
  const slashedRoot = root.split(sep).join("/");
  return [`${root}${sep}`, `${slashedRoot}/`].reduce((text, prefix) => text.split(prefix).join(""), trimmed);
}

export interface StatusStyle {
  heading(text: string): string;
  /** What is done: a phase passed, work finished. */
  done(text: string): string;
  /** What is happening now: the phase it is in, work at work. */
  now(text: string): string;
  muted(text: string): string;
}

const PLAIN: StatusStyle = { heading: (t) => t, done: (t) => t, now: (t) => t, muted: (t) => t };

/** How many agents get a line each; the rest are counted on one. */
const AGENT_LINES = 6;
/** The widest an agent's label is padded to. */
const LABEL_WIDTH = 40;
/** The cells of a phase's strip, as many as the regen panel's. */
const STRIP_CELLS = 24;

/** The status as lines across `width`, the spinner at `frame` and the clock at `now`. */
export function captureStatusLines(status: CaptureStatus, at: { frame: string; now: number; width: number }, style: StatusStyle = PLAIN): string[] {
  const steps = status.pipeline === "compact" ? COMPACT_PHASES : CAPTURE_PHASES;
  const phases = skillProgressLine({ skill: `capture ${basename(status.root)}`, phases: steps, current: steps.indexOf(CAPTURE_PHASES[phaseOf(status.stage)]!), attempt: 1, frame: at.frame }, at.width, style);
  const work = workOf(status);
  const cost = status.cost > 0 ? ` · $${status.cost.toFixed(2)}` : "";
  const phase = `  ${work !== undefined ? `${workStrip(work, style)}  ` : `${style.now(at.frame)} `}${stageText(status, work)} ${style.muted(`· ${duration(at.now - status.started)}${cost}`)}`;
  const shown = status.agents.slice(0, AGENT_LINES);
  const pad = Math.min(LABEL_WIDTH, Math.max(0, ...shown.map((agent) => visibleWidth(agent.label))));
  const agents = shown.map((agent) => {
    const label = visibleWidth(agent.label) > pad ? truncateToWidth(agent.label, pad, "…") : agent.label.padEnd(pad);
    const what = [agent.did, agent.now !== undefined ? style.muted(agent.now) : undefined].filter((part) => part !== undefined).join(style.muted(" · "));
    return `    ${label}  ${style.muted(duration(at.now - agent.since).padStart(6))}  ${what || style.muted("starting")}`;
  });
  const more = status.agents.length > shown.length ? [style.muted(`    and ${status.agents.length - shown.length} more agents`)] : [];
  const last = status.last !== undefined ? [style.muted(`  ${status.last}`)] : [];
  return [phases, phase, ...agents, ...more, ...last].map((line) => truncateToWidth(line, at.width, "…"));
}

/** The stages whose work is counted as they start - parts, concepts, modules, scripts - rather than from the features. */
const COUNTED_STAGES = new Set<CaptureStage>(["checking", "extracting", "dividing", "filling", "gathering", "reconciling", "reading", "verifying", "trying", "scripts"]);

/** The phase's work, for its strip: how much there is, how much is done, how much is at work - none while it is not counted. */
export function workOf(status: CaptureStatus): { total: number; done: number; running: number } | undefined {
  if (status.stage === "capturing") {
    const { outlined, done } = status.features;
    if (outlined === 0) return undefined;
    const running = status.agents.filter((agent) => agent.label.startsWith("feature ")).length;
    return { total: outlined, done, running: Math.min(running, outlined - done) };
  }
  if (!COUNTED_STAGES.has(status.stage)) return undefined;
  const { total, done } = status.work;
  if (total === 0) return undefined;
  return { total, done, running: Math.min(status.agents.length, total - done) };
}

/** A phase's work as the regen panel's strip draws functional specs: done, at work, waiting - in their colours. */
export function workStrip(work: { total: number; done: number; running: number }, style: StatusStyle, cells = STRIP_CELLS): string {
  const parts = [
    { count: work.done, glyph: "█", paint: style.done },
    { count: work.running, glyph: "█", paint: style.now },
    { count: Math.max(0, work.total - work.done - work.running), glyph: "▓", paint: style.muted },
  ];
  let used = 0;
  let counted = 0;
  let out = "";
  for (const part of parts) {
    counted += part.count;
    const upTo = Math.round((counted / Math.max(1, work.total)) * cells);
    if (upTo > used) out += part.paint(part.glyph.repeat(upTo - used));
    used = Math.max(used, upTo);
  }
  return out + style.muted("░".repeat(Math.max(0, cells - used)));
}

/** Where the capture is, in words - with its work counted where the phase has it. */
function stageText(status: CaptureStatus, work: { total: number; done: number; running: number } | undefined): string {
  const atWork = work !== undefined && work.running > 0 ? `, ${work.running} at work` : "";
  switch (status.stage) {
    case "mapping":
      return "mapping the codebase";
    case "surveying":
      return "surveying the codebase";
    case "compact-writing":
      return "capturing the whole program as one module";
    case "outlining": {
      const { outlined } = status.features;
      const more = status.outlining > 0 ? `, ${status.outlining === 1 ? "1 area" : `${status.outlining} areas`} still being outlined` : "";
      return outlined === 0 ? "outlining the features" : `${outlined} feature${outlined === 1 ? "" : "s"} outlined${more}`;
    }
    case "checking":
      return "checking the conventions against the code";
    case "extracting":
      return work !== undefined ? `taking the interface from the code: ${work.done} of ${work.total} agent${work.total === 1 ? "" : "s"} done${atWork}` : "taking the interface from the code";
    case "dividing":
      return "giving each behaviour to one feature";
    case "filling":
      return work !== undefined ? `capturing the interface no feature named: ${work.done} of ${work.total} writer${work.total === 1 ? "" : "s"} done${atWork}` : "capturing the interface no feature named";
    case "gathering":
      return "gathering the features into modules by concern, in the order they are built";
    case "verifying":
      return work !== undefined ? `${work.done} of ${work.total} module${work.total === 1 ? "" : "s"} checked against the code${atWork}` : "checking the interface against the code";
    case "trying":
      return work !== undefined ? `trying the scenarios on the original: ${work.done} of ${work.total} agent${work.total === 1 ? "" : "s"} done${atWork}` : "trying the scenarios on the original";
    case "capturing": {
      const { outlined, done } = status.features;
      return `${done} of ${outlined} feature${outlined === 1 ? "" : "s"} captured${atWork}`;
    }
    case "reconciling":
      return `reconciling concepts defined twice${atWork}`;
    case "reading":
      return work !== undefined ? `${work.done} of ${work.total} module${work.total === 1 ? "" : "s"} read for readability${atWork}` : "reading the ***plain for readability";
    case "writing":
      return "writing the ***plain";
    case "scripts":
      return work !== undefined ? `${work.done} of ${work.total} testing script${work.total === 1 ? "" : "s"} written${atWork}` : "writing the testing scripts";
  }
}

/** `40s`, `2m 10s`, `1h 05m`. */
export function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}
