import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { didNotPass, type ChatInfo, type Frontend, type Job, type MarkedPage, type ModelOutOfReach, type NoticeAnswer, type Turri, type WorkStatus } from "@turri-dev/core";
import { registerBanner } from "./banner.ts";
import { captureProgress, type CaptureProgressView } from "./capture-view.ts";
import { registerChats } from "./chat-commands.ts";
import type { TerminalChats } from "./chat-tabs.ts";
import { createChatUi, type ChatUi } from "./chat-ui.ts";
import { registerEntries } from "./entry-renderers.ts";
import { makePanel, registerNotifications, registerPanelKey, terminalAsk, type PanelSource, type SidePanelHost } from "./panel-view.ts";
import { openPiSettings } from "./pi-settings.ts";
import { canReopen, captureOpenQuestion, capturedEnv, reopenIn } from "./reopen.ts";
import { skillProgress } from "./skill-progress.ts";
import { TerminalNotifications } from "./terminal-notifications.ts";

/**
 * The terminal: turri's session as pi's screen shows it - one chat at a time, the others working behind it, regen in a
 * side panel, an inbox of what ended. One a process (pi-launch.ts): its `frontend` is what the session is told of it,
 * and it draws from the session's events. The chats' pi sessions are made on pi's own screen (chat-terminal.ts).
 *
 * Everything here is presentation: what happened, and what to do, is the session's - read from its events and methods.
 */

/** Where the person watches turri's work, in the terminal's own words - told to the model. */
export const TERMINAL_SURFACE = [
  "turri's terminal: the conversation, one chat at a time.",
  "- regen is the side panel (ctrl+h): the ***plain with each functionality and item marked built, regenerating, planned or",
  "  waiting - and behind it the pulses (/pulses), every pulse regenerating, planned and finished. Say regen, lowercase.",
  "  It was the regeneration, the job queue, or the job panel.",
  "- Pulses that ended, and the sentinel's notices and what it concluded, wait in regen's notifications",
  "  (/notifications): the person answers a notice there.",
  "- The person's chats are tabs above the conversation: /chat opens, shows and closes them.",
].join("\n");

export interface Terminal extends TerminalChats, PanelSource {
  /** What the session is told of the terminal - all of it but where the chats' sessions are made (chat-terminal.ts). */
  readonly frontend: Omit<Frontend, "sessions">;
  /** The session, once it is open. */
  readonly turri: Turri;
  /** The session it shows, once it is open: its events drawn from then on. */
  attach(turri: Turri): void;
  /** The chat on the screen. */
  shown(): string | undefined;
  /** pi's screen: what the chat shown draws on. Set as pi first binds a chat to it. */
  screen(): ExtensionUIContext | undefined;
  setScreen(ui: ExtensionUIContext): void;
  /** What the chat draws on - the screen while it is shown, a stand-in while it is not (chat-ui.ts). */
  uiOf(chat: string): ChatUi;
  /** The first chat's banner greets the person, until anything is sent in any chat. */
  welcomeVisible(chat?: string): boolean;
  /** The chat the welcome is in: the session's first. */
  welcome(chat: string): void;
  dismissWelcome(): void;
  /** The session's side panel, the same whichever chat is shown. */
  readonly panel: SidePanelHost;
  /** How turri leaves - pi's screen shut down: set once the screen is up. */
  leave: (() => void) | undefined;
}

const OUT_OF_REACH_WIDGET = "turri-out-of-reach";

export function createTerminal(): Terminal {
  let session: Turri | undefined;
  const turri = (): Turri => {
    if (session === undefined) throw new Error("turri's session is not open yet.");
    return session;
  };
  let real: ExtensionUIContext | undefined;
  const uis = new Map<string, ChatUi>();
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        /* a listener's trouble is its own */
      }
    }
  };
  const inbox = new TerminalNotifications();
  let welcomeChat: string | undefined;
  let welcomeDismissed = false;
  // A pulse that went wrong since the panel was last opened: the panel opens on it.
  let needsLooking: string | undefined;
  // The session's work and spec map, as last read - read again once an event says they changed.
  let work: { status: WorkStatus; all: Job[] } | undefined;
  let pages: MarkedPage[] | undefined;
  const captures = new Map<string, CaptureProgressView>();

  const focused = (): string | undefined => session?.chats.focused();
  const uiOf = (chat: string): ChatUi => {
    let ui = uis.get(chat);
    if (ui === undefined) {
      ui = createChatUi({ screen: () => real, onChange: changed });
      uis.set(chat, ui);
    }
    return ui;
  };
  /** What a chat draws on - none named, the chat shown, else the screen itself. */
  const drawOn = (chat: string | undefined): ExtensionUIContext | undefined => {
    const id = chat ?? focused();
    return id !== undefined ? uiOf(id).ui : real;
  };
  const workNow = () => (work ??= { status: turri().work.status(), all: turri().work.jobs() });

  /** harness-model out of reach, above the chat's input while it is - the chat sends nothing to a model meanwhile. */
  const showOutOfReach = (chat: string, outOfReach: ModelOutOfReach | undefined | null) => {
    const ui = uiOf(chat).ui;
    if (outOfReach === undefined || outOfReach === null) return ui.setWidget(OUT_OF_REACH_WIDGET, undefined);
    const text =
      outOfReach.why === "unknown"
        ? `harness-model ${outOfReach.model} is not a model here, so this chat sends nothing to a model - check harness-model with /settings, or the provider's extension`
        : `${outOfReach.provider} is not signed in, so harness-model ${outOfReach.model} cannot answer and this chat sends nothing to a model - /login, or another harness-model with /settings`;
    ui.setWidget(OUT_OF_REACH_WIDGET, (_tui, theme) => ({ render: (width: number) => [truncateToWidth(theme.fg("warning", text), width, "…")], invalidate() {} }));
  };

  const terminal: Terminal = {
    get turri() {
      return turri();
    },
    attach(opened) {
      session = opened;
      opened.on((event) => {
        if (inbox.hear(event)) changed();
        switch (event.type) {
          case "chats": {
            // A chat closed: what it drew on let go - a question waiting in it answered with nothing.
            for (const [id, ui] of uis) {
              if (event.chats.some((chat) => chat.id === id)) continue;
              ui.close();
              uis.delete(id);
              captures.delete(id);
            }
            changed();
            break;
          }
          case "job":
            work = undefined;
            if (event.final && (event.job.status === "failed" || event.job.status === "stopped" || didNotPass(event.job))) needsLooking = event.job.id;
            break;
          case "plan":
            work = undefined;
            break;
          case "map":
            pages = event.pages;
            break;
          case "skillProgress": {
            const ui = drawOn(event.chat);
            if (ui !== undefined) skillProgress(ui, event.progress);
            break;
          }
          case "captureProgress": {
            const key = event.chat ?? "";
            let view = captures.get(key);
            if (view === undefined) {
              const ui = drawOn(event.chat);
              if (ui === undefined) break;
              view = captureProgress(ui);
              captures.set(key, view);
            }
            view.update(event.status);
            break;
          }
          case "captureEnded":
            captures.get(event.chat ?? "")?.close();
            captures.delete(event.chat ?? "");
            break;
          case "outOfReach":
            showOutOfReach(event.chat, event.outOfReach);
            break;
        }
      });
    },

    // The chats - as the tabs and /chat show them: a chat with a dialog waiting to be shown is asking.
    chats: (): ChatInfo[] =>
      (session?.chats.list() ?? []).map((chat) => (chat.status !== "question" && (uis.get(chat.id)?.waiting() ?? 0) > 0 ? { ...chat, status: "question" } : chat)),
    shown: focused,
    open: () => turri().chats.open(),
    show: (id) => turri().chats.focus(id),
    close: (id) => turri().chats.close(id),
    notify(message, level) {
      try {
        real?.notify(message, level);
      } catch {
        /* a screen let go says nothing */
      }
    },
    onChange(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    changed,

    screen: () => real,
    setScreen(ui) {
      real = ui;
    },
    uiOf(chat) {
      const ui = uiOf(chat);
      // What it says of harness-model, as it is now - a chat adopted again, or shown first.
      try {
        showOutOfReach(chat, session?.chats.get(chat)?.outOfReach());
      } catch {
        /* closed meanwhile */
      }
      return ui;
    },

    welcomeVisible: (chat) => !welcomeDismissed && (welcomeChat === undefined || (chat ?? focused() ?? welcomeChat) === welcomeChat),
    welcome(chat) {
      welcomeChat ??= chat;
    },
    dismissWelcome() {
      if (welcomeDismissed) return;
      welcomeDismissed = true;
      changed();
    },

    // What the side panel reads.
    jobs: () => {
      const { status, all } = workNow();
      return [...status.planned, ...all];
    },
    busy: () => (session !== undefined ? workNow().status.busy : false),
    map: () => (pages ??= turri().work.map()),
    refreshMap() {
      pages = turri().work.map({ refresh: true });
    },
    history: () => turri().work.history(),
    inbox,
    answer(id: string, answer: NoticeAnswer) {
      void turri()
        .notices.answer(id, answer)
        .catch((error: unknown) => terminal.notify(error instanceof Error ? error.message : String(error), "warning"));
    },

    panel: undefined as unknown as SidePanelHost,
    leave: undefined,

    frontend: undefined as unknown as Omit<Frontend, "sessions">,
  };

  (terminal as { panel: SidePanelHost }).panel = makePanel(terminal, () => {
    const id = needsLooking;
    needsLooking = undefined;
    return id;
  });

  (terminal as { frontend: Omit<Frontend, "sessions"> }).frontend = {
    surface: TERMINAL_SURFACE,
    // In every chat, after turri's own: the entries drawn, the banner, the side panel's key, /notifications and /chat.
    extensions: [
      (pi) => {
        registerEntries(pi);
        registerBanner(pi, () => terminal.welcomeVisible());
        registerPanelKey(pi, terminal.panel);
        registerNotifications(pi, terminal.panel);
        registerChats(pi, terminal);
      },
    ],
    // A question of no chat's - a skill run's, a start over - is put in the chat shown.
    ask: terminalAsk(drawOn, (chat) => {
      const id = chat ?? focused();
      void (id !== undefined ? session?.chats.get(id)?.decline() : undefined)?.catch(() => undefined);
    }),
    // /pulses: the side panel, on the pulses - or the map, or one pulse.
    reveal(target) {
      const ui = real;
      if (ui === undefined) return false;
      if (target.kind === "pulse") terminal.panel.openOn(ui, target.id);
      else terminal.panel.open(ui, target.kind === "map" ? "map" : "pulses");
      return true;
    },
    // A capture wrote a project of its own: turri closes here and opens again there - `turri` started this chat, and the
    // person agrees - where the capture's report is told.
    async openProject(dir, { summary }) {
      const ui = drawOn(undefined);
      if (!canReopen() || terminal.leave === undefined || ui === undefined) return false;
      const question = captureOpenQuestion(process.cwd(), dir, summary);
      if (!(await ui.confirm(question.title, question.message))) return false;
      if (!reopenIn(dir, { env: capturedEnv(summary) })) return false;
      terminal.leave();
      return true;
    },
    openPiSettings,
    // The terminal shows these itself: a pulse's end in the chat and the inbox, notices in the inbox - answered there -
    // and the spec map in regen.
    shows: { pulseEnds: true, notices: true, map: true },
  };

  return terminal;
}
