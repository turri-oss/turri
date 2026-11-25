import type { Job } from "./jobs.ts";

/** Opens the side panel; ctrl+j would conflict with the editor's newline. */
export const PANEL_KEY = "ctrl+h";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function spinner(now: number): string {
  return SPINNER[Math.floor(now / 1000) % SPINNER.length]!;
}

/** A pulse that ran to its end and whose build did not pass is not a success. */
export function didNotPass(job: Job): boolean {
  return job.status === "succeeded" && (job.details as { passed?: unknown } | undefined)?.passed === false;
}

interface MarkPaint {
  success(text: string): string;
  error(text: string): string;
  warning(text: string): string;
}

const PLAIN_MARKS: MarkPaint = { success: (text) => text, error: (text) => text, warning: (text) => text };

export function finishedMark(job: Job, paint: MarkPaint = PLAIN_MARKS): string {
  if (didNotPass(job) || job.status === "failed") return paint.error("✗");
  if (job.status === "stopped") return paint.warning("■");
  return paint.success("✓");
}

export function pulseCost(job: Job): string {
  return job.usage.cost > 0 ? ` · $${job.usage.cost.toFixed(2)}` : "";
}

export interface DiffStyle {
  added(text: string): string;
  removed(text: string): string;
}

const PLAIN_DIFF: DiffStyle = { added: (text) => text, removed: (text) => text };

/** One line saying what a spec change does: the files, the lines added and removed, and the first line it adds. */
export function summarizeDiff(diff: string, style: DiffStyle = PLAIN_DIFF): string {
  const files = new Set<string>();
  let added = 0;
  let removed = 0;
  let first: string | undefined;
  let firstRemoved: string | undefined;
  for (const line of diff.split("\n")) {
    const file = /^\+\+\+ (?:b\/)?(.+)$/.exec(line);
    if (file) {
      if (file[1] !== "/dev/null") files.add(file[1]!.split("/").pop()!);
      continue;
    }
    if (line.startsWith("---") || line.startsWith("diff --git") || line.startsWith("index ")) continue;
    if (line.startsWith("+")) {
      added += 1;
      const text = line.slice(1).replace(/^- /, "").trim();
      if (first === undefined && text !== "" && !/^\*\*\*.*\*\*\*$/.test(text)) first = text;
    } else if (line.startsWith("-")) {
      removed += 1;
      const text = line.slice(1).replace(/^- /, "").trim();
      if (firstRemoved === undefined && text !== "") firstRemoved = text;
    }
  }
  const what = first !== undefined ? ` · ${first}` : firstRemoved !== undefined ? ` · removes: ${firstRemoved}` : "";
  return `${[...files].join(", ")} ${style.added(`+${added}`)} ${style.removed(`−${removed}`)}${what}`;
}
