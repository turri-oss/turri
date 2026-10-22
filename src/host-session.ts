import { createAgentSession, DefaultResourceLoader, getAgentDir, SessionManager, type AgentSession, type ExtensionFactory, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { AskUserIO } from "./ask.ts";
import { lastRun } from "./chat-records.ts";
import type { ChatInfo, TurriHost } from "./chats.ts";
import { createTurriCore, sessionLoop } from "./extension.ts";
import { stopDeployed } from "./regenerate/release.ts";
import type { JobRegistry } from "./regenerate/jobs.ts";
import type { WorkLoop } from "./regenerate/loop.ts";

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
  /** The dialogs a chat's questions are put in - ask_user's, a skill's interview, a review gate's - by the chat's id. */
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
  /** Told when a chat is opened, closed, renamed, or starts or stops working. */
  onChats(listener: (chats: ChatInfo[]) => void): () => void;
  /** Every chat let go, and what activate started stopped. */
  dispose(): Promise<void>;
}

/** turri's session in a host, in the process's working folder - the project's. */
export async function createTurri(options: TurriOptions = {}): Promise<Turri> {
  const { dialogs, uiContext, extensions = [], agentDir = getAgentDir(), sessionDir, restore, ...host } = options;
  const core = createTurriCore(host, { persist: true, ...(dialogs !== undefined ? { dialogs } : {}) });
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
    onChats: (listener) => core.onChats(() => listener(core.chats())),
    async dispose() {
      await core.dispose();
      await stopDeployed();
    },
  };
}
