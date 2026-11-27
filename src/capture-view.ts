import { basename } from "node:path";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { capturePhases, captureStageText, type CaptureStage, type CaptureStatus } from "@turri-dev/core";
import { spinner } from "./terminal-marks.ts";
import { skillProgressLine } from "./skill-progress.ts";

/** A capture's status above the input. `close` may be called more than once. */
export interface CaptureProgressView {
  update(status: CaptureStatus): void;
  close(): void;
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

/** `40s`, `2m 10s`, `1h 05m`. */
export function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
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
  const phases = skillProgressLine({ skill: `capture ${basename(status.root)}`, ...capturePhases(status), attempt: 1, frame: at.frame }, at.width, style);
  const work = workOf(status);
  const cost = status.cost > 0 ? ` · $${status.cost.toFixed(2)}` : "";
  const phase = `  ${work !== undefined ? `${workStrip(work, style)}  ` : `${style.now(at.frame)} `}${captureStageText(status, work)} ${style.muted(`· ${duration(at.now - status.started)}${cost}`)}`;
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

export function captureProgress(ctx: ExtensionContext): CaptureProgressView {
  const CAPTURE_WIDGET = "turri-capture";
  let status: CaptureStatus | undefined;
  let redrawNow: (() => void) | undefined;
  ctx.ui.setWidget(CAPTURE_WIDGET, (tui, theme) => {
    const redraw = setInterval(() => tui.requestRender(), 1000);
    redraw.unref?.();
    redrawNow = () => tui.requestRender();
    const style = {
      heading: (text: string) => theme.bold(theme.fg("accent", text)),
      done: (text: string) => theme.fg("success", text),
      now: (text: string) => theme.bold(theme.fg("accent", text)),
      muted: (text: string) => theme.fg("muted", text),
    };
    return {
      render: (width: number) => (status === undefined ? [] : captureStatusLines(status, { frame: spinner(Date.now()), now: Date.now(), width }, style)),
      invalidate: () => {},
      dispose: () => { clearInterval(redraw); redrawNow = undefined; },
    };
  });

  return { update(next) { status = next; redrawNow?.(); }, close() { ctx.ui.setWidget(CAPTURE_WIDGET, undefined); } };
}
