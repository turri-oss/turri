import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ChatLink } from "./chats.ts";

/**
 * Whether a chat is busy, for what turri tells it of its own accord - a test advisor's verdict, a background skill run's
 * end - and so waits: its agent working, or the person typing - or no session to tell yet. Nothing told so interrupts.
 */
export function chatBusy(link: ChatLink, context: () => ExtensionContext | undefined): boolean {
  const session = link.session();
  if (session === undefined || session.isStreaming || session.isCompacting || session.isRetrying) return true;
  const ctx = context();
  try {
    if (ctx !== undefined && (!ctx.isIdle() || ctx.hasPendingMessages())) return true;
    if (ctx?.hasUI === true && ctx.ui.getEditorText().trim() !== "") return true;
  } catch {
    /* a context let go: the session says enough */
  }
  return false;
}
