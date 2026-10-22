import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { AgentSession, ExtensionAPI, ExtensionContext, ExtensionFactory, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { currentChat, inChat, type ChatScope } from "./chat-scope.ts";
import { adoptRun, forgetChat, recordRun, type ChatRecord, type RunRecord } from "./chat-records.ts";
import { createChatUi, type ChatUi } from "./chat-ui.ts";
import { debugMode } from "./config.ts";
import type { AskUserIO } from "./ask.ts";
import { record } from "./regenerate/ledger.ts";
import type { Job, JobRegistry } from "./regenerate/jobs.ts";

/**
 * The chats of a turri session.
 *
 * One turri process is one session on one project, and holds up to MAX_CHATS chats: conversations, each with its own
 * history, model, thinking level, stack and questions, each working while another is shown. What they share is the
 * session's: the one job registry and work loop the project's pulses run in - a pulse any chat starts is in every
 * chat's side panel - the coding model, steering, releases and the ledger.
 *
 * A chat is a pi session with turri's extension in it. The extension, built once for each, links itself to its chat
 * here (`attach`); its tools, commands and handlers then run inside the chat's scope (chat-scope.ts), so a pulse knows
 * which chat asked for it, and is reported back there when it ends - to the chat shown, when that one is closed.
 *
 * Where the chats live is a driver's: the terminal's (chat-terminal.ts) swaps which one pi's screen shows; a host's
 * (`createTurri`) makes a session for each and shows them in its own windows.
 */

/** The most chats a session has open at once. */
export const MAX_CHATS = 9;

/** What a chat is called until something is said in it. */
export const NEW_CHAT_TITLE = "new chat";

export type ChatStatus = "idle" | "working" | "question" | "unread";

export interface ChatInfo {
  id: string;
  title: string;
  /** What it is doing: a turn running, a question waiting for it to be shown, something said since it was last shown. */
  status: ChatStatus;
  /** On the screen now - the terminal's, or the window the host said it shows (`focus`). */
  shown: boolean;
}

/** What turri tells and asks a host that runs its conversation itself. */
export interface TurriHost {
  /** A job started, moved to another stage, did something, or ended. */
  onJobChange?(job: Job): void;
  /** What is planned changed with no job - a module being planned, or planned. */
  onPlanChange?(): void;
  /** The dialogs ask_user puts its questions in - the conversation's and a skill's interview - instead of the terminal's. */
  dialogs?: AskUserIO;
  /**
   * The host's own UI, in its own words: the views it has in place of the terminal's, what its marks and buttons mean,
   * where questions appear. Given, turri tells the model none of the terminal's - its keys, the side panel, regen,
   * /pulses - and gives it this instead, as a `<surface>` block in turri's identity. Absent, the terminal is the surface.
   */
  surface?: string;
  /**
   * The last word on the whole system prompt, as turri has built it for this turn - after its own before_agent_start
   * work: what it returns is what is sent. For a host that needs to change anything else.
   */
  systemPrompt?(prompt: string): string;
}

/** What a chat's extension does for its chat when the session asks. */
export interface ChatInstance {
  /** A pulse it asked for ended: said in the chat, and its agent told. */
  announce(job: Job): void;
  /** The jobs changed: what it draws of them is drawn again. */
  jobsChanged(): void;
  /** How hard the chat's model thinks now: sub-agents started from it think as hard. */
  thinkingLevel(): string | undefined;
  /** The chat's context, as its tools get it - for its model and its providers. */
  context(): ExtensionContext | undefined;
}

/** A chat's extension, linked to its chat. */
export interface ChatLink {
  readonly id: string;
  readonly scope: ChatScope;
  /** The host's dialogs, for this chat's questions - undefined in the terminal. */
  readonly dialogs: AskUserIO | undefined;
  /** The extension built for the chat - again, when pi rebuilds it - and what it does for it. */
  live(instance: ChatInstance): void;
}

/** Where chats live: the terminal's screen, or a host's windows. */
export interface ChatDriver {
  /** pi's terminal: the chats are switched between with its keys and /chat. */
  terminal?: boolean;
  /** A session for the chat - its saved one, when `sessionFile` - with the session's extension built for it. */
  create(chat: ChatState, sessionFile: string | undefined): Promise<void>;
  /** Put the chat on the screen. */
  show?(chat: ChatState, from: ChatState | undefined): Promise<void>;
  /** The chat is closed or the session ends: its session let go. */
  dispose(chat: ChatState): Promise<void>;
}

/** A chat, as the session keeps it. */
export interface ChatState {
  id: string;
  scope: ChatScope;
  /** Its title as recorded, until it says one of its own. */
  recordedTitle?: string;
  session?: AgentSession;
  /** pi's services the session was made with - the terminal's driver hands them to pi with it. */
  services?: unknown;
  /** What it draws on, in the terminal. */
  ui?: ChatUi;
  instance?: ChatInstance;
  dialogs?: AskUserIO;
  working: boolean;
  unread: boolean;
  unsubscribe?: () => void;
}

export interface TurriCore {
  readonly cwd: string;
  readonly host: TurriHost;
  readonly jobs: JobRegistry;
  /** turri's extension, for pi to build into each chat's session. */
  readonly extension: ExtensionFactory;
  /** Whether chats can be opened beside the one there is - with a driver that has somewhere to put them. */
  readonly canOpen: boolean;
  /** Whether the chats are the terminal's, switched between with /chat and its keys. */
  readonly terminal: boolean;
  chats(): ChatInfo[];
  /** The chat's pi session. */
  session(id: string): AgentSession | undefined;
  /** The chat shown now. */
  shown(): string | undefined;
  /** Open a chat - fresh, or the saved one `sessionFile` is - shown at once unless `hidden`. */
  open(options?: { sessionFile?: string; hidden?: boolean; title?: string }): Promise<ChatInfo>;
  close(id: string): Promise<void>;
  /** Show the chat - in the terminal, put it on the screen; for a host, the one its person looks at now. */
  show(id: string): Promise<void>;
  onChats(listener: () => void): () => void;
  /** For a driver: something about the chats changed - a question waiting, one shown - and those listening are told. */
  changed(): void;
  /** Said in the chat shown - or the first one shown, when none is yet. */
  notify(message: string, level: "info" | "warning" | "error"): void;
  /** Every chat let go, but the one pi is letting go itself. */
  dispose(options?: { except?: AgentSession }): Promise<void>;
  /** For the extension: the chat a pi API is built for (see ChatLink). */
  attach(pi: ExtensionAPI): ChatLink;
  /** For a driver: the chat whose session this is, or none. */
  chatOfSession(session: AgentSession): ChatState | undefined;
  /** For a driver: the chat shown now, as the session keeps it. */
  shownChat(): ChatState | undefined;
  /** For the terminal's driver: the chat made by pi itself, its session now known - the first, or one pi rebuilt. */
  adopt(session: AgentSession, services: unknown): ChatState;
  /** For a driver: `chat` is on the screen now. */
  showing(chat: ChatState): void;
  /** For the extension: a pulse ended - told to the chat that asked for it. */
  jobFinished(job: Job): void;
  /** For the extension: the jobs changed - every chat draws them again. */
  jobsChanged(): void;
  /** The chat whose work this is, else the one shown: its instance. */
  instanceInScope(): ChatInstance | undefined;
  setDriver(driver: ChatDriver): void;
  /** Reopen a run's chats - `--continue` - beside the first, which pi reopened itself. */
  restore(run: RunRecord, options?: { skipFirst?: boolean }): Promise<void>;
}

export interface CoreOptions {
  cwd: string;
  host: TurriHost;
  jobs: JobRegistry;
  /** The extension, as it builds itself into a chat. */
  extension: (pi: ExtensionAPI, link: ChatLink) => void;
  /** Record the open chats in .turri/chats.json - not for pi's print, json and rpc modes. */
  persist?: boolean;
  /** The host's dialogs, a chat's own. */
  dialogs?: (chat: string) => AskUserIO | undefined;
}

/** A chat's title from what it says: its name, else its first message, short. */
function titleOf(session: AgentSession | undefined): string | undefined {
  if (session === undefined) return undefined;
  try {
    const named = session.sessionManager.getSessionName()?.trim();
    if (named) return named;
    for (const message of session.messages) {
      if (message.role !== "user") continue;
      const content = (message as { content?: unknown }).content;
      const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => (part as { text?: string }).text ?? "").join(" ") : "";
      const words = text.replace(/\s+/g, " ").trim();
      if (words !== "") return words.length > TITLE_CHARS ? `${words.slice(0, TITLE_CHARS - 1)}…` : words;
    }
  } catch {
    /* a session let go has no title to read */
  }
  return undefined;
}

const TITLE_CHARS = 32;

export function createChats(options: CoreOptions): TurriCore {
  const { cwd, host, jobs } = options;
  const chats: ChatState[] = [];
  const listeners = new Set<() => void>();
  let driver: ChatDriver | undefined;
  let shownId: string | undefined;
  /** The chat whose extension pi is building now. */
  let attaching: ChatState | undefined;
  /** Chats are opened one at a time: each one's extension is built while it is the one attaching. */
  let opening: Promise<unknown> = Promise.resolve();
  let notices: Array<[string, "info" | "warning" | "error"]> = [];
  const run: RunRecord = { run: randomUUID().slice(0, 8), pid: process.pid, started: new Date().toISOString(), chats: [] };

  const changed = () => {
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        /* a listener that fails is left out of this change */
      }
    }
  };

  /** A chat nothing was said in yet is a new chat: its number is beside it already, in the strip and the picker. */
  const titleFor = (chat: ChatState) => titleOf(chat.session) ?? chat.recordedTitle ?? NEW_CHAT_TITLE;

  const statusOf = (chat: ChatState): ChatStatus =>
    (chat.ui?.waiting() ?? 0) > 0 ? "question" : chat.working ? "working" : chat.unread ? "unread" : "idle";

  /** What the session keeps of its chats on disk: those with something said in them, in order. */
  const persist = () => {
    if (options.persist !== true) return;
    run.chats = chats.flatMap((chat): ChatRecord[] => {
      const file = chat.session?.sessionFile;
      return file !== undefined && existsSync(file) ? [{ id: chat.id, title: titleFor(chat), sessionFile: file }] : [];
    });
    recordRun(cwd, run, { keep: debugMode(cwd) });
  };

  const newChat = (title?: string): ChatState => {
    const id = randomUUID().slice(0, 8);
    const chat: ChatState = {
      id,
      scope: { id, stack: process.env.TURRI_STACK?.trim() || undefined },
      ...(title !== undefined ? { recordedTitle: title } : {}),
      working: false,
      unread: false,
    };
    chat.dialogs = options.dialogs?.(id);
    chats.push(chat);
    return chat;
  };

  /** What the chat's session does, as the session follows it: its turns, its name. */
  const follow = (chat: ChatState) => {
    chat.unsubscribe?.();
    const session = chat.session;
    if (session === undefined) return;
    chat.unsubscribe = session.subscribe((event) => {
      if (event.type === "agent_start") {
        chat.working = true;
        changed();
      } else if (event.type === "agent_end") {
        chat.working = false;
        if (shownId !== chat.id) chat.unread = true;
        persist();
        changed();
      } else if (event.type === "session_info_changed") {
        persist();
        changed();
      }
    });
  };

  const core: TurriCore = {
    cwd,
    host,
    jobs,
    extension: (pi) => options.extension(pi, core.attach(pi)),
    get canOpen() {
      return driver !== undefined;
    },
    get terminal() {
      return driver?.terminal === true;
    },
    chats: () => chats.map((chat) => ({ id: chat.id, title: titleFor(chat), status: statusOf(chat), shown: chat.id === shownId })),
    session: (id) => chats.find((chat) => chat.id === id)?.session,
    shown: () => shownId,
    shownChat: () => chats.find((chat) => chat.id === shownId),
    chatOfSession: (session) => chats.find((chat) => chat.session === session),

    async open(asked = {}) {
      if (driver === undefined) throw new Error("This turri has one chat: there is nowhere to open another.");
      const done = opening.then(async () => {
        const already = asked.sessionFile !== undefined ? chats.find((chat) => chat.session?.sessionFile === asked.sessionFile) : undefined;
        if (already !== undefined) return already;
        if (chats.length >= MAX_CHATS) throw new Error(`${MAX_CHATS} chats are open, the most there can be: close one first.`);
        const chat = newChat(asked.title);
        attaching = chat;
        try {
          await driver!.create(chat, asked.sessionFile);
        } catch (error) {
          chats.splice(chats.indexOf(chat), 1);
          throw error;
        } finally {
          attaching = undefined;
        }
        follow(chat);
        inChat(chat.scope, () => record({ kind: "chat.opened", reopened: asked.sessionFile !== undefined }, { project: cwd }));
        persist();
        changed();
        return chat;
      });
      opening = done.catch(() => undefined);
      const chat = await done;
      if (asked.hidden !== true) await core.show(chat.id);
      return core.chats().find((info) => info.id === chat.id)!;
    },

    async close(id) {
      const index = chats.findIndex((chat) => chat.id === id);
      if (index === -1) return;
      const chat = chats[index]!;
      if (shownId === id) {
        const next = chats[index + 1] ?? chats[index - 1];
        if (next !== undefined) await core.show(next.id);
        else shownId = undefined;
      }
      const recorded = run.chats.find((kept) => kept.id === id);
      chats.splice(chats.indexOf(chat), 1);
      chat.unsubscribe?.();
      chat.ui?.close();
      inChat(chat.scope, () => record({ kind: "chat.closed" }, { project: cwd }));
      try {
        await driver?.dispose(chat);
      } finally {
        if (options.persist === true) {
          forgetChat(cwd, run.run, recorded, { keep: debugMode(cwd) });
          run.chats = run.chats.filter((kept) => kept.id !== id);
        }
        changed();
      }
    },

    async show(id) {
      const chat = chats.find((candidate) => candidate.id === id);
      if (chat === undefined || shownId === id) return;
      const from = core.shownChat();
      if (driver?.show !== undefined) await driver.show(chat, from);
      else core.showing(chat);
    },

    showing(chat) {
      shownId = chat.id;
      chat.unread = false;
      for (const [message, level] of notices.splice(0)) core.notify(message, level);
      changed();
    },

    onChats(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    changed,

    notify(message, level) {
      const chat = core.shownChat();
      const ui: ExtensionUIContext | undefined = chat?.ui?.ui ?? chat?.session?.extensionRunner.getUIContext();
      if (ui === undefined) {
        notices = [...notices, [message, level] as [string, typeof level]].slice(-10);
        return;
      }
      try {
        ui.notify(message, level);
      } catch {
        /* a chat let go says nothing */
      }
    },

    async dispose(asked = {}) {
      for (const chat of chats.splice(0)) {
        chat.unsubscribe?.();
        chat.ui?.close();
        if (chat.session === asked.except) continue;
        try {
          await driver?.dispose(chat);
        } catch {
          /* let go already */
        }
      }
      changed();
    },

    attach() {
      // The chat pi builds this extension for: the one being opened; else, the session's first - pi makes it itself -
      // or, once there is one, the chat shown, rebuilt by pi (a /reload, a /fork).
      const chat = attaching ?? core.shownChat() ?? (chats.length === 0 ? newChat() : chats[chats.length - 1]!);
      return {
        id: chat.id,
        scope: chat.scope,
        dialogs: chat.dialogs,
        live: (instance) => {
          chat.instance = instance;
        },
      };
    },

    adopt(session, services) {
      const chat = core.chatOfSession(session) ?? core.shownChat() ?? chats.find((candidate) => candidate.session === undefined) ?? newChat();
      if (chat.session !== session) {
        chat.session = session;
        chat.services = services;
        follow(chat);
        if (shownId === undefined) inChat(chat.scope, () => record({ kind: "chat.opened", reopened: session.messages.length > 0 }, { project: cwd }));
      }
      return chat;
    },

    jobFinished(job) {
      const asked = chats.find((chat) => chat.id === job.chat);
      const chat = asked?.instance !== undefined ? asked : (core.shownChat() ?? chats[0]);
      if (chat === undefined) return;
      if (chat.id !== shownId) chat.unread = true;
      try {
        chat.instance?.announce(job);
      } catch {
        // A chat let go as the pulse ended: the one shown is told instead.
        const shown = core.shownChat();
        if (shown !== undefined && shown !== chat) shown.instance?.announce(job);
      }
      changed();
    },

    jobsChanged() {
      for (const chat of chats) {
        try {
          chat.instance?.jobsChanged();
        } catch {
          /* a chat let go draws nothing */
        }
      }
    },

    instanceInScope() {
      const scoped = currentChat();
      return (chats.find((chat) => chat.id === scoped?.id) ?? core.shownChat() ?? chats[0])?.instance;
    },

    setDriver(given) {
      driver = given;
    },

    async restore(saved, asked = {}) {
      adoptRun(cwd, saved.run);
      const [first, ...rest] = saved.chats;
      if (first !== undefined && asked.skipFirst === true) {
        const chat = chats[0];
        if (chat !== undefined) chat.recordedTitle ??= first.title;
      }
      for (const kept of asked.skipFirst === true ? rest : saved.chats) {
        try {
          await core.open({ sessionFile: kept.sessionFile, hidden: true, title: kept.title });
        } catch (error) {
          core.notify(`The chat "${kept.title}" could not be reopened: ${error instanceof Error ? error.message : String(error)}`, "warning");
        }
      }
      persist();
    },
  };
  return core;
}

/**
 * pi's extension API for a chat: every tool, command, shortcut and handler the extension registers runs inside the
 * chat's scope - its stack, and its id on what it starts.
 */
export function scopedToChat(pi: ExtensionAPI, scope: ChatScope): ExtensionAPI {
  const within =
    <A extends unknown[], R>(work: ((...args: A) => R) | undefined) =>
    work === undefined ? undefined : (...args: A): R => inChat(scope, () => work(...args));
  return new Proxy(pi, {
    get(target, key, receiver) {
      if (key === "registerTool")
        return (tool: { execute: (...args: unknown[]) => unknown }) => target.registerTool({ ...tool, execute: within(tool.execute)! } as never);
      if (key === "registerCommand")
        return (name: string, command: { handler: (...args: unknown[]) => unknown }) => target.registerCommand(name, { ...command, handler: within(command.handler)! } as never);
      if (key === "registerShortcut")
        return (shortcut: string, options: { handler: (...args: unknown[]) => unknown }) => target.registerShortcut(shortcut as never, { ...options, handler: within(options.handler)! } as never);
      if (key === "on") return (event: string, handler: (...args: unknown[]) => unknown) => (target.on as (event: string, handler: unknown) => void)(event, within(handler));
      const value = Reflect.get(target, key, receiver) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/** A chat's stand-in for the screen, for the terminal's driver. */
export function terminalUi(chat: ChatState, screen: () => ExtensionUIContext | undefined, onChange: () => void): ChatUi {
  chat.ui ??= createChatUi({ screen, onChange });
  return chat.ui;
}
