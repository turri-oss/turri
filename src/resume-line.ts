/**
 * pi's lines on the way out that say how to resume the session - its label, then the command on a line of its own -
 * left out: turri leaves nothing behind but the command run.
 */
export function withoutResumeLine(text: string): string {
  return text.replace(/^(?:\x1b\[[0-9;]*m)*To resume this session:(?:\x1b\[[0-9;]*m)*\n[^\n]*\n?/m, "");
}
