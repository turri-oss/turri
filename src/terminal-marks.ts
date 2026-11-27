import { didNotPass, type Job } from "@turri-dev/core";

/**
 * The terminal's marks for turri's work: the key that opens the side panel, the spinner every working thing turns, and
 * the mark a finished pulse is shown with. The core says what happened; how a screen marks it is the terminal's.
 */

/** Opens the side panel; ctrl+j would conflict with the editor's newline. */
export const PANEL_KEY = "ctrl+h";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** The spinner's frame at `now`: one a second, so every spinner on the screen turns together. */
export function spinner(now: number): string {
  return SPINNER[Math.floor(now / 1000) % SPINNER.length]!;
}

interface MarkPaint {
  success(text: string): string;
  error(text: string): string;
  warning(text: string): string;
}

const PLAIN_MARKS: MarkPaint = { success: (text) => text, error: (text) => text, warning: (text) => text };

/** A finished pulse's mark: ✗ for one that failed or did not pass, ■ stopped, ✓ landed. */
export function finishedMark(job: Job, paint: MarkPaint = PLAIN_MARKS): string {
  if (didNotPass(job) || job.status === "failed") return paint.error("✗");
  if (job.status === "stopped") return paint.warning("■");
  return paint.success("✓");
}
