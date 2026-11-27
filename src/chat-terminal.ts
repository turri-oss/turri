import { AgentSessionRuntime, InteractiveMode, SessionManager, type AgentSession, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { BANNER_ENTRY, type Chat, type ExternalSessions } from "@turri-dev/core";
import { chatTabHeader, type ChatScreen } from "./chat-tab-header.ts";
import { chatTabs, closeTerminalChat } from "./chat-tabs.ts";
import { showWaitingMessages } from "./chat-waiting.ts";
import { buttonLabel } from "./pointer-hover.ts";
import type { Terminal } from "./terminal-view.ts";

/**
 * The terminal's chats: pi's screen, showing one chat while the others go on working.
 *
 * pi's interactive mode reads its conversation from its runtime, which holds one session and replaces it - disposing
 * the old one - on /new, /resume and /fork. Here a chat is shown by putting its live session in the runtime and having
 * the screen drawn from it again, nothing disposed: a chat hidden keeps its turn, its tools and its questions, drawing
 * on a stand-in of the screen meanwhile (chat-ui.ts). /new opens a chat beside the others, /resume opens a saved one as
 * a chat of its own; /fork and /reload still rebuild the chat shown, as pi does - the session adopts each session pi
 * binds. ctrl+c stops what the chat shown is doing, and nothing in the others; in a chat doing nothing it leaves turri.
 * Leaving turri lets every chat go.
 *
 * The session makes no pi session of the terminal's: they are made here, on pi's runtime, with turri's extension built
 * in (`sessions: { kind: "external" }`), and the session asks for them, shows them and lets them go through it.
 *
 * pi has no hooks for any of this: its classes are patched, as pi-launch.ts patches others. A pi update that changes
 * them shows here first - `npm test` runs tests/chat-terminal.test.ts against the pi installed.
 */

/** What of pi's interactive mode and runtime this reaches: their own fields, in plain JavaScript. */
interface Screen {
  runtimeHost: Runtime;
  /** pi's queued messages under the chat - and, with chat-waiting.ts, in it. */
  updatePendingMessagesDisplay?(): void;
  handleEvent(event: unknown): Promise<void>;
  /** The overlays extensions opened on the screen, each with what takes it off - the side panel among them. */
  extensionOverlays?: Map<unknown, () => void>;
  shutdown(): Promise<void>;
}

interface Runtime {
  session: AgentSession;
  services: { agentDir: string };
  cwd: string;
  _session: AgentSession;
  _services: unknown;
  rebindSession?: (session: AgentSession) => Promise<void>;
  beforeSessionInvalidate?: () => void;
  createRuntime(options: unknown): Promise<{ session: AgentSession; services: unknown }>;
}

interface Patched extends ChatScreen {
  session: AgentSession;
  defaultEditor: { onSubmit(text: string): Promise<void> };
  setupEditorSubmitHandler(): void;
  addCustomEntryToChat(entry: { customType: string }): void;
  mountInteractiveTui(tui: TUI, components: Component[]): void;
  rebindCurrentSession(...args: unknown[]): Promise<void>;
  handleCtrlC(): void;
  updateAvailableProviderCount(): unknown;
}

/** A second ctrl+c this soon after one that stopped something stops nothing more and leaves nothing: one pressed twice to be sure. */
export const INTERRUPT_SETTLE_MS = 500;

/** What ctrl+c reaches of pi's screen: the chat shown, its editor, and leaving. */
export interface CtrlCScreen {
  session: Pick<AgentSession, "isStreaming" | "isCompacting" | "isRetrying" | "isBashRunning">;
  editor: { getText(): string };
  clearEditor(): void;
  /** Its queued messages back in the editor - and, with `abort`, the turn stopped: pi's own esc. */
  restoreQueuedMessagesToEditor(options?: { abort?: boolean }): number;
  shutdown(): Promise<void>;
}

/**
 * ctrl+c, in the chat shown: what it is doing stopped - `Chat.stop()`: its turn, a skill or a tool in it, a `!` command,
 * a compaction, a retry - and nothing in the other chats; the messages it had queued put back in the editor first, as
 * pi's esc does. In a chat doing nothing it clears a draft in the editor, and with none leaves turri, every chat with it
 * - unless the last ctrl+c, at `lastStop`, stopped something a moment ago.
 */
export function pressCtrlC(screen: CtrlCScreen, chat: Pick<Chat, "stop"> | undefined, lastStop: number, now = Date.now()): "stopped" | "ignored" | "cleared" | "left" {
  const { session } = screen;
  if (session.isBashRunning || session.isStreaming || session.isCompacting || session.isRetrying) {
    if (session.isStreaming) screen.restoreQueuedMessagesToEditor();
    void chat?.stop().catch(() => undefined);
    return "stopped";
  }
  if (now - lastStop < INTERRUPT_SETTLE_MS) return "ignored";
  if (screen.editor.getText().trim() !== "") {
    screen.clearEditor();
    return "cleared";
  }
  void screen.shutdown();
  return "left";
}

/**
 * pi's screen patched to hold the session's chats - once a process - and the session's chats made on it: what the
 * session is told as its `sessions`. `restore`: `turri -c` - pi reopens the first of the last run's chats itself, and the
 * session reopens the rest beside it once pi's first is up.
 */
export function driveTerminal(terminal: Terminal, options: { restore?: boolean } = {}): ExternalSessions {
  let screen: Screen | undefined;
  let runtime: Runtime | undefined;
  let restore = options.restore === true;
  /** pi's services each chat's session was made with: handed to pi's runtime with it as it is shown. */
  const servicesOf = new WeakMap<AgentSession, unknown>();
  /** A chat being put on the screen by the session: the screen bound to it is not to show it again. */
  let showing = false;

  /** The screen has drawn a session: the chat it is, shown - drawing on the screen from now on, its stand-in kept. */
  const bound = () => {
    const turri = terminal.turri;
    const session = runtime!.session;
    servicesOf.set(session, runtime!._services);
    // pi's first session, one it rebuilt (/fork, /reload), or the chat the session asked to show: a chat of the session's.
    const chat = turri.chats.adopt(session);
    terminal.welcome(chat.id);
    const runner = session.extensionRunner as unknown as { getUIContext(): ExtensionUIContext; setUIContext(ui: ExtensionUIContext, mode: string): void; mode: string };
    const real = runner.getUIContext();
    terminal.setScreen(real);
    const ui = terminal.uiOf(chat.id);
    ui.show(real);
    runner.setUIContext(ui.ui, runner.mode);
    catchUp(session);
    // What the chat shown was sent while its agent worked, and has not read yet: in its chat, shaded.
    screen?.updatePendingMessagesDisplay?.();
    if (!showing && turri.chats.focused() !== chat.id) void turri.chats.focus(chat.id).catch(() => undefined);
    // `turri -c`: the last run's chats, but the first - pi reopened it itself - opened beside it.
    if (restore) {
      restore = false;
      void turri.chats.restore().catch((error: unknown) => terminal.notify(error instanceof Error ? error.message : String(error), "warning"));
    }
  };

  /**
   * A chat shown mid-turn: the screen draws what its session has saved, and the reply being written is not saved yet -
   * the screen is told the turn and the reply began, and follows it from there.
   */
  const catchUp = (session: AgentSession) => {
    if (!session.isStreaming || screen === undefined) return;
    void screen.handleEvent({ type: "agent_start" });
    const writing = session.agent.state.streamingMessage;
    if (writing !== undefined && writing.role === "assistant") void screen.handleEvent({ type: "message_start", message: writing });
  };

  showWaitingMessages();
  const prototype = InteractiveMode.prototype as unknown as Patched;
  let switching = false;
  const tabs = chatTabs(() => terminal.chats(), (text, shown, hovered, role) => {
    const theme = terminal.screen()?.theme;
    return theme === undefined ? text : buttonLabel(theme, text, shown, hovered, role);
  }, (action) => {
    if (switching || runtime === undefined) return;
    if (action.kind === "plain") {
      const ui = terminal.screen();
      if (ui !== undefined) terminal.panel.toggle(ui);
      return;
    }
    switching = true;
    const change = action.kind === "open" ? terminal.open() : action.kind === "close" ? closeTerminalChat(terminal, action.id) : terminal.show(action.id);
    void change.catch((error: unknown) => terminal.notify(error instanceof Error ? error.message : String(error), "warning")).finally(() => { switching = false; });
  }, () => ({ notifications: terminal.inbox.count, open: terminal.panel.visible(), busy: terminal.panel.busy() }));

  const header = chatTabHeader(tabs, () => {
    const id = terminal.shown();
    return id !== undefined && !terminal.welcomeVisible(id);
  });
  // pi dispatches slash commands before the extension's input event. Catch the submission before either path.
  const setupSubmit = prototype.setupEditorSubmitHandler;
  prototype.setupEditorSubmitHandler = function () {
    setupSubmit.call(this);
    const editor = this.defaultEditor;
    const submit = editor.onSubmit;
    editor.onSubmit = (text) => {
      if (text.trim()) terminal.dismissWelcome();
      return submit.call(editor, text);
    };
  };
  const addEntry = prototype.addCustomEntryToChat;
  prototype.addCustomEntryToChat = function (entry) {
    addEntry.call(this, entry);
    if (entry.customType === BANNER_ENTRY) header.afterBanner(this.chatContainer, entry, () => terminal.welcomeVisible());
  };
  let stopWatchingTabs: (() => void) | undefined;
  const mount = prototype.mountInteractiveTui;
  prototype.mountInteractiveTui = function (tui, components) {
    stopWatchingTabs?.();
    mount.call(this, tui, header.mount(this, components));
    const unwatch = header.watch(this, tui);
    let ticker: ReturnType<typeof setInterval> | undefined;
    const refresh = () => {
      if (terminal.panel.busy() || terminal.chats().some((chat) => chat.status === "working")) {
        ticker ??= setInterval(() => tui.requestRender(), 250).unref();
      } else {
        clearInterval(ticker);
        ticker = undefined;
      }
      tui.requestRender();
    };
    const stop = terminal.onChange(refresh);
    refresh();
    stopWatchingTabs = () => { stop(); clearInterval(ticker); unwatch(); };
  };
  const rebind = prototype.rebindCurrentSession;
  prototype.rebindCurrentSession = async function (this: Screen, ...args: unknown[]) {
    await rebind.apply(this, args);
    screen = this;
    runtime = this.runtimeHost;
    terminal.leave = () => void this.shutdown();
    bound();
  };

  // Signed in or out - pi says how many providers it has again: every chat put on harness-model, where it can be now.
  const providers = prototype.updateAvailableProviderCount;
  let reached: Promise<void> | undefined;
  prototype.updateAvailableProviderCount = function (this: Patched) {
    const counted = providers.call(this);
    try {
      reached ??= terminal.turri.chats.onHarnessModel().catch(() => undefined).finally(() => { reached = undefined; });
    } catch {
      /* the session is not open yet: it puts each chat on harness-model as it starts */
    }
    return counted;
  };

  const runtimes = AgentSessionRuntime.prototype as unknown as {
    newSession(options?: { parentSession?: string; setup?: unknown }): Promise<{ cancelled: boolean }>;
    switchSession(path: string, options?: unknown): Promise<{ cancelled: boolean }>;
    dispose(): Promise<void>;
  };
  const opening = async (open: () => Promise<unknown>): Promise<{ cancelled: boolean }> => {
    try {
      await open();
      return { cancelled: false };
    } catch (error) {
      terminal.notify(error instanceof Error ? error.message : String(error), "warning");
      return { cancelled: true };
    }
  };

  // ctrl+c: pi's clears the editor and leaves on a second press; here it stops what the chat shown is doing, and leaves
  // when it is doing nothing.
  let lastStop = 0;
  prototype.handleCtrlC = function (this: Patched) {
    const id = terminal.shown();
    const chat = id !== undefined ? terminal.turri.chats.get(id) : undefined;
    const did = pressCtrlC(this as unknown as CtrlCScreen, chat, lastStop);
    if (did === "stopped") lastStop = Date.now();
  };

  // /new: a fresh chat beside the others.
  const newSession = runtimes.newSession;
  runtimes.newSession = function (this: unknown, asked) {
    if (this !== runtime || asked?.parentSession !== undefined || asked?.setup !== undefined) return newSession.call(this, asked);
    return opening(() => terminal.turri.chats.open());
  };

  // /resume: the saved chat, as a chat of its own - or shown, when one is open on it.
  const switchSession = runtimes.switchSession;
  runtimes.switchSession = function (this: unknown, path, asked) {
    if (this !== runtime) return switchSession.call(this, path, asked);
    return opening(() => terminal.turri.chats.open({ sessionFile: path }));
  };

  // Leaving turri: every chat let go - the one shown by pi, as it always is.
  const dispose = runtimes.dispose;
  runtimes.dispose = async function (this: unknown) {
    if (this === runtime) {
      stopWatchingTabs?.();
      await terminal.turri.dispose();
    }
    return dispose.call(this);
  };

  return {
    kind: "external",

    async create({ chat, sessionFile, persisted }) {
      if (runtime === undefined) throw new Error("turri's screen is not up yet: open a chat once it is.");
      const now = runtime;
      const manager = now.session.sessionManager;
      const sessionManager =
        sessionFile !== undefined
          ? SessionManager.open(sessionFile, manager.getSessionDir())
          : persisted && manager.isPersisted()
            ? SessionManager.create(now.cwd, manager.getSessionDir())
            : SessionManager.inMemory(now.cwd);
      // pi's runtime builds every extension it was started with into the session - turri's among them, for this chat.
      const made = await now.createRuntime({
        cwd: now.cwd,
        agentDir: now.services.agentDir,
        sessionManager,
        sessionStartEvent: { type: "session_start", reason: sessionFile !== undefined ? "resume" : "new", previousSessionFile: now.session.sessionFile },
      });
      servicesOf.set(made.session, made.services);
      // Up and working before it is ever shown: on its stand-in.
      await made.session.bindExtensions({ uiContext: terminal.uiOf(chat).ui, mode: "tui" });
      return made.session;
    },

    async show(id) {
      const session = terminal.turri.chats.get(id)?.session;
      if (runtime === undefined || session === undefined || runtime.session === session) return;
      const from = terminal.shown();
      if (from !== undefined && from !== id) terminal.uiOf(from).hide();
      // pi takes the shown chat's widgets and dialogs off the screen, as it does before replacing a session - but not the
      // overlays on it: the side panel, the session's and not the chat's, stays where it is, beside the chat or over it.
      // pi takes off every overlay it holds, so for that moment it holds none.
      const overlays = screen?.extensionOverlays;
      const kept = [...(overlays ?? [])];
      overlays?.clear();
      try {
        runtime.beforeSessionInvalidate?.();
      } finally {
        for (const [handle, remove] of kept) overlays?.set(handle, remove);
      }
      runtime._session = session;
      runtime._services = servicesOf.get(session);
      // The screen drawn from the chat's session, and bound to it: `bound` above.
      showing = true;
      try {
        await runtime.rebindSession?.(session);
      } finally {
        showing = false;
      }
    },

    async release(_id, session) {
      // The session pi's screen holds is pi's to let go, as turri leaves.
      if (session === runtime?.session) return;
      try {
        await session.abort();
      } finally {
        session.dispose();
      }
    },
  };
}
