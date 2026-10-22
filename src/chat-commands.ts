import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { MAX_CHATS, type ChatInfo, type TurriCore } from "./chats.ts";
import { spinner } from "./regenerate/job-panel.ts";

/**
 * The terminal's chats, for the person: `/chat` - new, close, a number, or a pick - its keys, and the strip above the
 * editor naming each chat with what it is doing.
 */

/** A fresh chat. */
export const NEW_CHAT_KEY = "alt+n";
/** The chat shown, closed. */
export const CLOSE_CHAT_KEY = "alt+w";
/** alt+1 … alt+9: that chat, shown. */
const SHOW_KEYS = Array.from({ length: MAX_CHATS }, (_, index) => `alt+${index + 1}`);

const STRIP_WIDGET = "turri-chats";

/**
 * On a Mac, alt is Option, which types ¡ and ñ unless the terminal sends it as Meta: said once a session, as the second
 * chat opens - when the keys are first worth having.
 */
export const OPTION_AS_META =
  "Chats: ⌥1…⌥9 switch, ⌥N opens one, ⌥W closes the one shown - on macOS only once your terminal sends Option as Meta: " +
  "Ghostty, macos-option-as-alt = true; iTerm2, Profiles → Keys → Left Option key: Esc+; Terminal.app, Profiles → Keyboard → " +
  "Use Option as Meta key; Kitty, macos_option_as_alt yes. /chat works without it.";

/** The sessions told already. */
const toldOfOption = new WeakSet<TurriCore>();

/** Said once a session, as its second chat opens, on a Mac. */
export function tellOfOptionOnce(session: TurriCore, platform: NodeJS.Platform = process.platform): void {
  if (platform !== "darwin" || toldOfOption.has(session)) return;
  toldOfOption.add(session);
  const stop = session.onChats(() => {
    if (session.chats().length < 2) return;
    stop();
    // Once the new chat is on the screen: said there.
    setTimeout(() => session.notify(OPTION_AS_META, "info"), 0);
  });
}

/** What a chat's mark in the strip and the picker says it is doing. */
export function chatMark(chat: ChatInfo, now = Date.now()): string {
  switch (chat.status) {
    case "working":
      return spinner(now);
    case "question":
      return "?";
    case "unread":
      return "•";
    default:
      return " ";
  }
}

/** Between two chats in the strip. */
const STRIP_DELIMITER = " │ ";

/** The strip: each chat by its number, its title and its mark - the one shown set apart - on one line, a rule between them. */
export function chatStrip(chats: ChatInfo[], width: number, style: { shown: (text: string) => string; muted: (text: string) => string }, now = Date.now()): string[] {
  if (chats.length < 2) return [];
  const room = Math.max(8, Math.floor((width - 2) / chats.length) - STRIP_DELIMITER.length - 4);
  const parts = chats.map((chat, index) => {
    const mark = chatMark(chat, now).trim();
    const label = `${index + 1} ${truncateToWidth(chat.title, room, "…")}${mark !== "" ? ` ${mark}` : ""}`;
    return chat.shown ? style.shown(label) : style.muted(label);
  });
  return [truncateToWidth(` ${parts.join(style.muted(STRIP_DELIMITER))}`, width, "…")];
}

const label = (chat: ChatInfo, index: number) => `${index + 1}  ${chatMark(chat)} ${chat.title}${chat.shown ? "  (shown)" : ""}`;

/** What the person asked of the chats, done once pi has finished with the command or key that asked it. */
function later(ctx: ExtensionContext, session: TurriCore, work: () => Promise<unknown>): void {
  setTimeout(() => {
    work().catch((error: unknown) => {
      try {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
      } catch {
        session.notify(error instanceof Error ? error.message : String(error), "warning");
      }
    });
  }, 0);
}

/** The chat `which` names - its number, or the shown one when none - or why there is none. */
function chatNamed(session: TurriCore, which: string): ChatInfo | string {
  const chats = session.chats();
  if (which === "") return chats.find((chat) => chat.shown) ?? "No chat is shown.";
  const number = Number.parseInt(which, 10);
  const chat = Number.isInteger(number) ? chats[number - 1] : undefined;
  return chat ?? `There is no chat ${which}: ${chats.length === 1 ? "there is one" : `there are ${chats.length}`}.`;
}

function closeChat(ctx: ExtensionContext, session: TurriCore, which: string): void {
  const chat = chatNamed(session, which);
  if (typeof chat === "string") return ctx.ui.notify(chat, "warning");
  if (session.chats().length === 1) return ctx.ui.notify("This is the only chat - /quit leaves turri.", "info");
  later(ctx, session, () => session.close(chat.id));
}

function showChat(ctx: ExtensionContext, session: TurriCore, which: string): void {
  const chat = chatNamed(session, which);
  if (typeof chat === "string") return ctx.ui.notify(chat, "warning");
  later(ctx, session, () => session.show(chat.id));
}

export function registerChats(pi: ExtensionAPI, session: TurriCore): void {
  tellOfOptionOnce(session);
  pi.registerCommand("chat", {
    description: `Chats beside this one, each working while another is shown: /chat [new | close [n] | n] - ${NEW_CHAT_KEY} a new one, alt+1…9 to switch, ${CLOSE_CHAT_KEY} to close${process.platform === "darwin" ? " (alt is ⌥, once the terminal sends Option as Meta)" : ""}`,
    getArgumentCompletions: (prefix: string) => {
      const items = ["new", "close", ...session.chats().map((_, index) => `${index + 1}`)].filter((item) => item.startsWith(prefix)).map((item) => ({ value: item, label: item }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const [verb = "", rest = ""] = args.trim().split(/\s+(.*)/s);
      if (verb === "new") return later(ctx, session, () => session.open());
      if (verb === "close") return closeChat(ctx, session, rest.trim());
      if (verb !== "") return showChat(ctx, session, verb);
      const chats = session.chats();
      const fresh = `New chat  (${NEW_CHAT_KEY})`;
      const picked = await ctx.ui.select(`Chats - ${chats.length} of ${MAX_CHATS}`, [...chats.map(label), ...(chats.length < MAX_CHATS ? [fresh] : [])]);
      if (picked === undefined) return;
      if (picked === fresh) return later(ctx, session, () => session.open());
      const chosen = chats.find((chat, index) => label(chat, index) === picked);
      if (chosen !== undefined) later(ctx, session, () => session.show(chosen.id));
    },
  });

  pi.registerShortcut(NEW_CHAT_KEY as never, {
    description: "A new chat beside this one",
    handler: async (ctx) => later(ctx, session, () => session.open()),
  });
  pi.registerShortcut(CLOSE_CHAT_KEY as never, {
    description: "Close this chat",
    handler: async (ctx) => closeChat(ctx, session, ""),
  });
  SHOW_KEYS.forEach((key, index) =>
    pi.registerShortcut(key as never, {
      description: `Show chat ${index + 1}`,
      handler: async (ctx) => showChat(ctx, session, `${index + 1}`),
    }),
  );

  // The strip above the editor, while there are two chats or more: drawn again as they change, and while one works.
  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;
    ctx.ui.setWidget(STRIP_WIDGET, (tui, theme) => {
      const stop = session.onChats(() => tui.requestRender());
      const ticker = setInterval(() => {
        if (session.chats().some((chat) => chat.status === "working")) tui.requestRender();
      }, 250);
      ticker.unref?.();
      return {
        render: (width: number) => chatStrip(session.chats(), width, { shown: (text) => theme.bold(theme.fg("accent", text)), muted: (text) => theme.fg("muted", text) }),
        invalidate: () => {},
        dispose: () => {
          stop();
          clearInterval(ticker);
        },
      };
    });
  });
}
