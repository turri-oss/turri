import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import { Spacer, truncateToWidth, type Component } from "@earendil-works/pi-tui";

/**
 * A message sent while the chat's agent works, shown as a message at once: pi queues it until the agent's turn reaches
 * a point it can read it - the end of a step, which a long tool call holds off for minutes - and until then lists it
 * only as a dim `Steering:` line under the chat. Here each message waiting is drawn there as the message it is,
 * shaded and marked not read yet - under the chat, so it stays below what the agent writes and the tools it calls
 * meanwhile. When the agent reads it, it leaves the queue and pi puts it in the chat, a normal message, where it was
 * read. Taken back into the editor (pi's dequeue, esc, ctrl+c), it goes with the queue.
 *
 * pi has no hook for it: its screen is patched, as chat-terminal.ts patches it - tests/chat-terminal.test.ts checks
 * what it reaches against the pi installed.
 */

/** What of pi's interactive mode this reaches: its own fields and methods, in plain JavaScript. */
export interface WaitingScreen {
  chatContainer: Container;
  pendingMessagesContainer: Container;
  getAllQueuedMessages(): { steering: string[]; followUp: string[] };
  addMessageToChat(message: unknown, options?: unknown): void;
  getAppKeyDisplay?(action: string): string;
}

interface Container {
  children: Component[];
  addChild(component: Component): void;
  clear(): void;
}

const DIM = "\x1b[2m";
const UNDIM = "\x1b[22m";

/** A part of a message waiting to be read, drawn shaded - with, under the last part, what it is waiting for. */
export class Shade implements Component {
  inner: Component;
  note: string;

  constructor(inner: Component, note = "") {
    this.inner = inner;
    this.note = note;
  }

  render(width: number): string[] {
    // Dim kept on past every reset in a line: a bold word or a colour must not end the shade.
    const lines = this.inner.render(width).map((line) => `${DIM}${line.replace(/\x1b\[(?:0|22)?m/g, (reset) => `${reset}${DIM}`)}${UNDIM}`);
    return this.note === "" ? lines : [...lines, `${DIM}${truncateToWidth(` ${this.note}`, width)}${UNDIM}`];
  }

  invalidate(): void {
    this.inner.invalidate();
  }
}

/**
 * Under the chat, each message the agent has not read yet, drawn as pi draws a message in the chat - shaded, and
 * marked not read yet - in the order they were sent.
 */
export function showWaiting(screen: WaitingScreen): void {
  const area = screen.pendingMessagesContainer;
  area.clear();
  const { steering, followUp } = screen.getAllQueuedMessages();
  const waiting = [...steering, ...followUp];
  if (waiting.length === 0) return;
  const key = screen.getAppKeyDisplay?.("app.message.dequeue");
  const note = `not read yet${key !== undefined && key !== "" ? ` · ${key} to edit` : ""}`;
  // Drawn by pi's own drawing of a message in the chat, into the area under it instead.
  const chat = screen.chatContainer;
  screen.chatContainer = area;
  try {
    for (const text of waiting) {
      // A line between it and the chat; pi puts one between messages itself.
      if (area.children.length === 0) area.addChild(new Spacer(1));
      const before = area.children.length;
      screen.addMessageToChat({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
      const parts = area.children.slice(before);
      parts.forEach((part, index) => {
        if (part instanceof Spacer) return;
        area.children[before + index] = new Shade(part, index === parts.length - 1 ? note : "");
      });
    }
  } finally {
    screen.chatContainer = chat;
  }
}

/** What of pi's session `unqueue` reaches. */
export interface QueueOf {
  getSteeringMessages(): readonly string[];
  getFollowUpMessages(): readonly string[];
  clearQueue(): { steering: string[]; followUp: string[] };
  steer(text: string, images?: undefined, options?: { source: "extension" }): Promise<unknown>;
  followUp(text: string, images?: undefined, options?: { source: "extension" }): Promise<unknown>;
}

/**
 * A message taken out of the session's queue - read by another agent, a skill's - the rest put back as they were, in
 * order. pi takes none out alone: the queue is emptied and filled again. False when it is not queued.
 */
export async function unqueue(session: QueueOf, text: string): Promise<boolean> {
  if (!session.getSteeringMessages().includes(text) && !session.getFollowUpMessages().includes(text)) return false;
  const { steering, followUp } = session.clearQueue();
  const at = steering.indexOf(text);
  if (at !== -1) steering.splice(at, 1);
  else followUp.splice(followUp.indexOf(text), 1);
  // Put back as turri's, not typed: what watches the person's input does not take them again.
  for (const message of steering) await session.steer(message, undefined, { source: "extension" });
  for (const message of followUp) await session.followUp(message, undefined, { source: "extension" });
  return true;
}

/** pi's screen patched, once: the messages waiting for the agent drawn under the chat as messages, shaded. */
export function showWaitingMessages(): void {
  const prototype = InteractiveMode.prototype as unknown as { updatePendingMessagesDisplay(): void; turriWaiting?: boolean };
  if (prototype.turriWaiting === true) return;
  prototype.turriWaiting = true;
  prototype.updatePendingMessagesDisplay = function (this: WaitingScreen) {
    showWaiting(this);
  };
}
