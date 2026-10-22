import { AgentSessionRuntime, InteractiveMode, SessionManager, type AgentSession, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { RunRecord } from "./chat-records.ts";
import { interruptChat, terminalUi, type ChatState, type Stoppable, type TurriCore } from "./chats.ts";

/**
 * The terminal's chats: pi's screen, showing one chat while the others go on working.
 *
 * pi's interactive mode reads its conversation from its runtime, which holds one session and replaces it - disposing
 * the old one - on /new, /resume and /fork. Here a chat is shown by putting its live session in the runtime and having
 * the screen drawn from it again, nothing disposed: a chat hidden keeps its turn, its tools and its questions, drawing
 * on a stand-in of the screen meanwhile (chat-ui.ts). /new opens a chat beside the others, /resume opens a saved one as
 * a chat of its own; /fork and /reload still rebuild the chat shown, as pi does. ctrl+c stops what the chat shown is
 * doing, and nothing in the others; in a chat doing nothing it leaves turri. Leaving turri lets every chat go.
 *
 * pi has no hooks for any of this: its classes are patched, as pi-launch.ts patches others. A pi update that changes
 * them shows here first - `npm test` runs tests/chat-terminal.test.ts against the pi installed.
 */

/** What of pi's interactive mode and runtime this reaches: their own fields, in plain JavaScript. */
interface Screen {
  runtimeHost: Runtime;
  handleEvent(event: unknown): Promise<void>;
  /** pi-tui's screen: its overlays among it. */
  ui: { hideOverlay(): void };
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

interface Patched {
  rebindCurrentSession(...args: unknown[]): Promise<void>;
  handleCtrlC(): void;
}

/** What ctrl+c reaches of pi's screen: the chat shown, its editor, and leaving. */
export interface CtrlCScreen {
  session: Stoppable;
  editor: { getText(): string };
  clearEditor(): void;
  /** Its queued messages back in the editor - and, with `abort`, the turn stopped: pi's own esc. */
  restoreQueuedMessagesToEditor(options?: { abort?: boolean }): number;
  shutdown(): Promise<void>;
}

/**
 * ctrl+c, in the chat shown: what it is doing stopped, the other chats left as they are (`interruptChat`). In a chat
 * doing nothing it clears a draft in the editor, and with none leaves turri, every chat with it.
 */
export function pressCtrlC(screen: CtrlCScreen, lastStop: number, now = Date.now()): "stopped" | "ignored" | "cleared" | "left" {
  return interruptChat(screen.session, {
    lastStop,
    now,
    stopTurn: () => void screen.restoreQueuedMessagesToEditor({ abort: true }),
    idle: () => {
      if (screen.editor.getText().trim() !== "") {
        screen.clearEditor();
        return "cleared" as const;
      }
      void screen.shutdown();
      return "left" as const;
    },
  });
}

export function driveTerminal(core: TurriCore, options: { restore?: RunRecord } = {}): void {
  let screen: Screen | undefined;
  let runtime: Runtime | undefined;
  let real: ExtensionUIContext | undefined;
  let restore = options.restore;

  /** The screen has drawn a session: the chat it is, shown - drawing on its stand-in from now on. */
  const bound = () => {
    const session = runtime!.session;
    const chat = core.adopt(session, runtime!._services);
    const runner = session.extensionRunner as unknown as { getUIContext(): ExtensionUIContext; setUIContext(ui: ExtensionUIContext, mode: string): void; mode: string };
    real = runner.getUIContext();
    const ui = terminalUi(chat, () => real, () => core.changed());
    ui.show(real);
    runner.setUIContext(ui.ui, runner.mode);
    catchUp(session);
    core.showing(chat);
    // The run `--continue` reopens: its first chat is pi's own, the rest are opened beside it.
    if (restore !== undefined) {
      const saved = restore;
      restore = undefined;
      void core.restore(saved, { skipFirst: true });
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

  const prototype = InteractiveMode.prototype as unknown as Patched;
  const rebind = prototype.rebindCurrentSession;
  prototype.rebindCurrentSession = async function (this: Screen, ...args: unknown[]) {
    await rebind.apply(this, args);
    screen = this;
    runtime = this.runtimeHost;
    bound();
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
      core.notify(error instanceof Error ? error.message : String(error), "warning");
      return { cancelled: true };
    }
  };

  // ctrl+c: pi's clears the editor and leaves on a second press; here it stops what the chat shown is doing, and leaves
  // when it is doing nothing.
  let lastStop = 0;
  prototype.handleCtrlC = function (this: Patched) {
    const did = pressCtrlC(this as unknown as CtrlCScreen, lastStop);
    if (did === "stopped") lastStop = Date.now();
  };

  // /new: a fresh chat beside the others.
  const newSession = runtimes.newSession;
  runtimes.newSession = function (this: unknown, asked) {
    if (this !== runtime || asked?.parentSession !== undefined || asked?.setup !== undefined) return newSession.call(this, asked);
    return opening(() => core.open());
  };

  // /resume: the saved chat, as a chat of its own - or shown, when one is open on it.
  const switchSession = runtimes.switchSession;
  runtimes.switchSession = function (this: unknown, path, asked) {
    if (this !== runtime) return switchSession.call(this, path, asked);
    return opening(() => core.open({ sessionFile: path }));
  };

  // Leaving turri: every chat let go - the one shown by pi, as it always is.
  const dispose = runtimes.dispose;
  runtimes.dispose = async function (this: unknown) {
    if (this === runtime) await core.dispose({ except: runtime!.session });
    return dispose.call(this);
  };

  core.setDriver({
    terminal: true,

    async create(chat: ChatState, sessionFile: string | undefined) {
      if (runtime === undefined) throw new Error("turri's screen is not up yet: open a chat once it is.");
      const now = runtime;
      const manager = now.session.sessionManager;
      const sessionManager =
        sessionFile !== undefined
          ? SessionManager.open(sessionFile, manager.getSessionDir())
          : manager.isPersisted()
            ? SessionManager.create(now.cwd, manager.getSessionDir())
            : SessionManager.inMemory(now.cwd);
      const made = await now.createRuntime({
        cwd: now.cwd,
        agentDir: now.services.agentDir,
        sessionManager,
        sessionStartEvent: { type: "session_start", reason: sessionFile !== undefined ? "resume" : "new", previousSessionFile: now.session.sessionFile },
      });
      chat.session = made.session;
      chat.services = made.services;
      // Up and working before it is ever shown: on its stand-in.
      const ui = terminalUi(chat, () => real, () => core.changed());
      await made.session.bindExtensions({ uiContext: ui.ui, mode: "tui" });
    },

    async show(chat: ChatState, from: ChatState | undefined) {
      if (runtime === undefined || chat.session === undefined) return;
      from?.ui?.hide();
      // pi takes the shown chat's widgets and dialogs off the screen, as it does before replacing a session - but not the
      // overlay on it: the side panel, the session's and not the chat's, stays where it is, beside the chat or over it.
      const tui = screen?.ui;
      const hideOverlay = tui?.hideOverlay;
      if (tui !== undefined) tui.hideOverlay = () => {};
      try {
        runtime.beforeSessionInvalidate?.();
      } finally {
        if (tui !== undefined && hideOverlay !== undefined) tui.hideOverlay = hideOverlay;
      }
      runtime._session = chat.session;
      runtime._services = chat.services;
      // The screen drawn from the chat's session, and bound to it: `bound` above.
      await runtime.rebindSession?.(chat.session);
    },

    async dispose(chat: ChatState) {
      const session = chat.session;
      if (session === undefined) return;
      try {
        await session.abort();
      } finally {
        session.dispose();
      }
    },
  });
}
