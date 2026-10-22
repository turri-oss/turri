import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The chat a piece of work runs for: its tools, its commands, its event handlers - and what they start, a pulse
 * queued from them among it. A turri session holds several chats (chats.ts); what each keeps for itself rides along
 * with its work here: its id, which pulses and the ledger's events carry, and the stack it chose.
 */
export interface ChatScope {
  id: string;
  /** The stack this chat chose with /stack or the stack tool - none: the project's config alone. */
  stack: string | undefined;
}

/**
 * One store for the whole process. pi loads an extension through its own module loader when it is given a path rather
 * than a factory - an older turri installed into every pi - and that copy of this module must find the same chat.
 */
const STORE = Symbol.for("turri.chat-scope");
const scope: AsyncLocalStorage<ChatScope> = ((globalThis as Record<symbol, unknown>)[STORE] ??= new AsyncLocalStorage<ChatScope>()) as AsyncLocalStorage<ChatScope>;

/** The chat this code runs for - undefined outside every chat: the command line, a test. */
export function currentChat(): ChatScope | undefined {
  return scope.getStore();
}

/** Run `work` for `chat`: what it starts, and what that starts, is the chat's. */
export function inChat<T>(chat: ChatScope, work: () => T): T {
  return scope.run(chat, work);
}
