/** pi's line on the way out that says how to resume the session, left out: turri leaves nothing behind but the command run. */
export function withoutResumeLine(text: string): string {
  return text.replace(/^(?:\x1b\[[0-9;]*m)*To resume this session:.*\n?/m, "");
}
