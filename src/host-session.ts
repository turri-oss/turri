import { createAgentSession, DefaultResourceLoader, getAgentDir, SessionManager, type AgentSession, type ExtensionFactory, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { AskUserIO } from "./ask.ts";
import { lastRun } from "./chat-records.ts";
import { interruptChat, type ChatInfo, type TurriHost } from "./chats.ts";
import { createTurriCore, sessionLoop } from "./extension.ts";
import { stopDeployed } from "./regenerate/release.ts";
import type { JobRegistry } from "./regenerate/jobs.ts";
import type { WorkLoop } from "./regenerate/loop.ts";
import type { Notice, NoticeAnswer } from "./notice.ts";

/**
 * turri's session for a host that runs its chats itself - a desktop app, an editor: the chats, each a pi session with
 * turri in it, on one job registry and work loop. The host shows each chat in its own way - subscribes to its session,
 * prompts it - and tells turri which one its person looks at (`focus`): a pulse a closed chat asked for is reported
 * there.
 */

export interface TurriOptions extends Omit<TurriHost, "dialogs"> {
  /** pi's folder - its settings, models and credentials. Default: pi's own (`~/.pi/agent`). */
  agentDir?: string;
  /** Where the chats' conversations are saved. Default: pi's own folder for this project. */
  sessionDir?: string;
  /** The host's own extensions, built into every chat after turri's. */
  extensions?: ExtensionFactory[];
  /**
   * The dialogs a chat's questions are put in - ask_user's, a skill's interview, a review gate's - by the chat's id. Each
   * is given a `signal`, aborted when its question is over without its answer - declined, or its turn stopped - for the
   * host to close it.
   */
  dialogs?: (chat: string) => AskUserIO | undefined;
  /** What a chat's other UI calls - its notices, its working line - come to, by the chat's id. */
  uiContext?: (chat: string) => ExtensionUIContext | undefined;
  /** Reopen the chats of the last session here that has ended, in their order - as `turri --continue` does. */
  restore?: boolean;
}

export interface Turri {
  /** The session's job registry: every pulse any chat starts. */
  readonly jobs: JobRegistry;
  /** The session's work loop - once a chat is open: what each codebase has planned, and why. */
  readonly loop: WorkLoop;
  /** The chats, in their order. */
  chats(): ChatInfo[];
  /** A chat's pi session: to subscribe to, prompt and abort. */
  session(id: string): AgentSession | undefined;
  /** A fresh chat - or the saved one `sessionFile` is. At most nine are open. */
  openChat(options?: { sessionFile?: string }): Promise<ChatInfo & { session: AgentSession }>;
  /** A chat closed: its turn stopped, its conversation deleted - its pulses run on. */
  closeChat(id: string): Promise<void>;
  /** The chat the person looks at now. */
  focus(id: string): void;
  /**
   * ctrl+c in a chat, as the terminal has it: what the chat is doing stopped - its turn, a skill or a tool in it, a `!`
   * command, a compaction - and nothing in the others (`stopped`). In a chat doing nothing the session ends - every
   * chat let go and what activate started stopped, as `dispose` does - for the host to close what showed it (`ended`).
   * A second interrupt straight after one that stopped something does nothing (`ignored`); `missing` for a chat not open.
   */
  interrupt(id: string): Promise<"stopped" | "ignored" | "ended" | "missing">;
  /**
   * ctrl+c at a question, as the terminal has it: the question the chat asks now - its ask_user, a skill's interview, a
   * review gate's escalation - declined. The asker is told the person declined to answer and the turn goes on; the
   * host's dialog for it is told through its `signal`. Each question it is called at, however many in a row - it never
   * stops the turn. `none` when the chat asks nothing now, `missing` for a chat not open.
   */
  decline(id: string): Promise<"declined" | "none" | "missing">;
  /**
   * The notices put to the person and not yet over - the sentinel's, and turri's own: each in the chat it names. A host
   * hears each as it is put (`onNotice`) and as it ends (`onNoticeOver`).
   */
  notices(): Notice[];
  /**
   * A notice answered: one of its actions (by index or label) - the chat it is in started on it - the person's own words
   * about it, dismissed, or - `ignorable: true` - ignored for good: left as the build has it, the sentinel told not to
   * raise it again. `refused` for `ignore` on one that is not ignorable, `over` when it was answered or superseded
   * already, `missing` for one never put.
   */
  answer(id: string, answer: NoticeAnswer): Promise<"done" | "dismissed" | "ignored" | "refused" | "missing" | "over">;
  /** Told when a chat is opened, closed, renamed, or starts or stops working. */
  onChats(listener: (chats: ChatInfo[]) => void): () => void;
  /** Every chat let go, and what activate started stopped. */
  dispose(): Promise<void>;
}

/** turri's session in a host, in the process's working folder - the project's. */
export async function createTurri(options: TurriOptions = {}): Promise<Turri> {
  const { dialogs, uiContext, extensions = [], agentDir = getAgentDir(), sessionDir, restore, ...host } = options;
  const core = createTurriCore(host, { persist: true, advisor: true, ...(dialogs !== undefined ? { dialogs } : {}) });
  const cwd = core.cwd;
  core.setDriver({
    async create(chat, sessionFile) {
      const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, extensionFactories: [core.extension, ...extensions] });
      await resourceLoader.reload();
      const sessionManager = sessionFile !== undefined ? SessionManager.open(sessionFile, sessionDir) : SessionManager.create(cwd, sessionDir);
      const { session } = await createAgentSession({ cwd, agentDir, resourceLoader, sessionManager });
      chat.session = session;
      await session.bindExtensions({ uiContext: uiContext?.(chat.id), mode: "tui" });
    },
    async dispose(chat) {
      const session = chat.session;
      if (session === undefined) return;
      try {
        await session.abort();
      } finally {
        session.dispose();
      }
    },
  });
  if (restore === true) {
    const saved = lastRun(cwd);
    if (saved !== undefined) await core.restore(saved);
    const first = core.chats()[0];
    if (first !== undefined) await core.show(first.id);
  }
  let lastStop = 0;
  const dispose = async () => {
    await core.dispose();
    await stopDeployed();
  };
  return {
    jobs: core.jobs,
    get loop() {
      return sessionLoop(core);
    },
    chats: () => core.chats(),
    session: (id) => core.session(id),
    async openChat(asked = {}) {
      const chat = await core.open(asked);
      return { ...chat, session: core.session(chat.id)! };
    },
    closeChat: (id) => core.close(id),
    focus: (id) => void core.show(id),
    async interrupt(id) {
      const session = core.session(id);
      if (session === undefined) return "missing";
      const did = interruptChat(session, { lastStop, idle: () => "ended" as const });
      if (did === "stopped") lastStop = Date.now();
      if (did === "ended") await dispose();
      return did;
    },
    decline: async (id) => core.decline(id),
    notices: () => core.notices(),
    answer: async (id, answer) => core.answer(id, answer),
    onChats: (listener) => core.onChats(() => listener(core.chats())),
    dispose,
  };
}
