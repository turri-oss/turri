import { stripTerminalSequences, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { ChatInfo, TurriCore } from "./chats.ts";
import { PointerHover, type ButtonPaint, type ButtonRole } from "./pointer-hover.ts";
import { spinner } from "./regenerate/job-panel.ts";

/** Shared by the tabs and the /chat picker. */
export function chatMark(chat: ChatInfo): string {
  switch (chat.status) {
    case "working": return spinner(Date.now());
    case "question": return "?";
    case "unread": return "•";
    default: return " ";
  }
}

export type TabAction = { kind: "open" } | { kind: "plain" } | { kind: "show" | "close"; id: string };
const buttonRole: Record<TabAction["kind"], ButtonRole> = { open: "new", plain: "panel", show: "tab", close: "close" };

function buttonKey(action: TabAction): string {
  return "id" in action ? `${action.kind}:${action.id}` : action.kind;
}

/** Shared by ×, /chat close and alt+w. The last person's chat stays open even if the sentinel has its own tab. */
export async function closeTerminalChat(session: TurriCore, id: string): Promise<void> {
  const chats = session.chats();
  const people = chats.filter((chat) => chat.role === undefined);
  if (people.length === 1 && people[0]!.id === id) return session.notify("This is the only chat - /quit leaves turri.", "info");
  await session.close(id);
}

interface Part {
  action?: TabAction;
  text: string;
  shown?: boolean;
}

function layout(chats: ChatInfo[], width: number): Part[] {
  if (width <= 0) return [];
  // Keep the panel button at the right edge while chat titles grow and shrink on the left.
  const panel = width >= 30 ? " ***plain › " : width >= 14 ? " ***plain " : width >= 6 ? "≡" : "";
  const panelWidth = visibleWidth(panel);
  const chatWidth = width - (panel ? panelWidth + 1 : 0);
  // Reserve + and a close target per tab before spending cells on padding, gaps and titles.
  const spaced = chatWidth >= chats.length * 5 + 3;
  const plus = spaced ? " + " : "+";
  const count = Math.min(chats.length, Math.floor((chatWidth - plus.length) / 2));
  const room = Math.floor((chatWidth - plus.length) / Math.max(1, count)) - (spaced ? 1 : 0);
  const parts: Part[] = [];
  for (const [index, chat] of chats.slice(0, count).entries()) {
    const lead = !spaced ? "" : room >= 8 ? (chat.shown ? " ▸ " : "   ") : (chat.shown ? "▸" : " ");
    let label = `${lead}${index + 1}`;
    const close = spaced ? (room > 4 ? " × " : "× ") : "×";
    const mark = chatMark(chat).trim();
    const suffix = mark ? ` ${mark}` : "";
    const titleRoom = room - visibleWidth(label + close + suffix) - 1;
    if (titleRoom > 0) label += ` ${truncateToWidth(stripTerminalSequences(chat.title).replace(/\s+/g, " ").trim(), titleRoom, "…")}${suffix}`;
    parts.push({ text: label, action: { kind: "show", id: chat.id }, shown: chat.shown }, { text: close, action: { kind: "close", id: chat.id }, shown: chat.shown });
    if (spaced) parts.push({ text: " " });
  }
  parts.push({ text: plus, action: { kind: "open" } });
  if (panel) {
    const used = parts.reduce((cells, part) => cells + visibleWidth(part.text), 0);
    parts.push({ text: " ".repeat(width - used - panelWidth) }, { text: panel, action: { kind: "plain" } });
  }
  return parts;
}

export interface ChatTabs extends Component {
  pointer: PointerHover;
}

/** Mouse positions, like the layout, are in terminal cells, not string offsets. */
export function chatTabs(chats: () => ChatInfo[], style: ButtonPaint, pick: (action: TabAction) => void): ChatTabs {
  let pressed: string | undefined;
  return {
    pointer: new PointerHover(),
    render(width) {
      return [layout(chats(), width).map((part) => part.action ? style(part.text, part.shown === true, this.pointer.target === buttonKey(part.action), buttonRole[part.action.kind]) : part.text).join("")];
    },
    handleMouse(event) {
      const move = event.type === "move";
      if (event.y !== 0 || (!move && (event.button !== "left" || (event.type !== "press" && event.type !== "click")))) return;
      const down = pressed;
      if (!move) pressed = undefined;
      let x = 0;
      for (const part of layout(chats(), event.width)) {
        const end = x + visibleWidth(part.text);
        if (event.x >= x && event.x < end && part.action) {
          const key = buttonKey(part.action);
          this.pointer.target = key;
          if (move) return { handled: true, render: false };
          // Claim the press so pi delivers a click on release, without moving focus out of the editor.
          if (event.type === "press") pressed = key;
          // A chat can change its title or close between press and release, moving another tab under the pointer.
          else if (down === key && !(part.shown && part.action.kind === "show")) {
            this.pointer.target = undefined;
            pick(part.action);
          }
          return { handled: true };
        }
        x = end;
      }
    },
    invalidate() {},
  };
}
