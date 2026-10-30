import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { AgentSession, ExtensionAPI, ExtensionContext, ExtensionFactory, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { currentChat, inChat, type ChatScope } from "./chat-scope.ts";
import { adoptRun, forgetChat, forgetSessionFile, recordRun, type ChatRecord, type RunRecord } from "./chat-records.ts";
import { createChatUi, type ChatUi } from "./chat-ui.ts";
import { debugMode, type SentinelSetting } from "./config.ts";
import type { AskUserIO } from "./ask.ts";
import { record } from "./regenerate/ledger.ts";
import type { Job, JobRegistry } from "./regenerate/jobs.ts";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AdvisorVerdict } from "./regenerate/advisor-runs.ts";
import { newNotice, noticeTask, SENTINEL, sentinelStartChoice, wentWrong, type ChatRole, type Conclusion, type Notice, type NoticeAnswer, type NoticeInput } from "./notice.ts";

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
 *
 * With the project's sentinel on (sentinel.ts), every finished pulse goes to the sentinel - a chat of the session's own,
 * opened in the background with the first, and again after it is closed - and the chat the person looks at shows only
 * that it landed. The sentinel checks each pulse in a conversation of its own: its chat keeps its id, and is given a new
 * session for each pulse, one at a time. What the sentinel finds wrong it puts to the person as a notice, in the chat
 * they look at. Under `sentinel: ask`, the person is asked first - a notice of turri's own, before it first opens in the
 * session - the pulses that end meanwhile held until they answer.
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
  /** `sentinel` for the session's sentinel; none for a chat of the person's. */
  role?: ChatRole;
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
  /**
   * A chat's session replaced by a new one, under the same id: the sentinel's, a fresh conversation for each pulse it
   * checks - told before the pulse is put to it. The host follows this session in place of the one it had.
   */
  onChatSession?(chat: string, session: AgentSession): void;
  /** The sentinel is done with a pulse - told to the chat it names, whose agent says so. */
  onConcluded?(conclusion: Conclusion & { chat: string }): void;
  /** What the sentinel puts to the person - and, `kind: "sentinel-start"`, whether to start it: the host draws it in the chat it names, and answers it with `answer`. */
  onNotice?(notice: Notice): void;
  /** A notice is over - answered, dismissed, or superseded by a newer one about its module: the host takes its card down. */
  onNoticeOver?(notice: Notice): void;
  /**
   * The sentinel's own tools beside turri's - a host's browser, say - and its surface: where the person watches it use
   * them, in the host's words. Given, the sentinel tries a release with those tools, keeping its shell for what they
   * cannot show; absent, the person does not watch it, and the tools are only to test with as well.
   */
  sentinel?: { tools?: ToolDefinition[]; surface?: string };
}

/** What a chat's extension does for its chat when the session asks. */
export interface ChatInstance {
  /** A pulse it asked for ended: said in the chat, and its agent told, to react to it. */
  announce(job: Job): void;
  /**
   * A pulse ended, with the sentinel on: said in the chat - and, with `tell`, its agent told it landed and what the
   * sentinel does with it, to tell the person and do nothing more.
   */
  landed(job: Job, options?: { tell?: boolean }): void;
  /** The sentinel's: a pulse ended - its agent, in a conversation of its own for this pulse, told of it. */
  brief(job: Job, context: { asked?: string; focused?: string }): Promise<void>;
  /** A notice put in the chat: drawn, and - in the terminal - put to the person once the chat is idle. */
  notice(notice: Notice): void;
  /** A notice is over: its dialog closed, if it is open. */
  noticeOver(notice: Notice): void;
  /** The sentinel is done with a pulse: said in the chat, and its agent told, to tell the person and do nothing more. */
  concluded(conclusion: Conclusion): void;
  /** The person answered a notice with something to do: the chat's agent started on it. */
  act(task: string): void;
  /**
   * The test advisor's verdict: once the chat is idle - its agent done, nothing typed - a yes starts a turn that writes its
   * scenarios, and a no is a line. Those that arrive meanwhile are delivered together.
   */
  advised(verdict: AdvisorVerdict): void;
  /** The jobs changed: what it draws of them is drawn again. */
  jobsChanged(): void;
  /** How hard the chat's model thinks now: sub-agents started from it think as hard. */
  thinkingLevel(): string | undefined;
  /** The chat's context, as its tools get it - for its model and its providers. */
  context(): ExtensionContext | undefined;
  /** Conformance tests turned on or off: the chat's tools switched to match - conform and evaluate_tests, or the tool that turns them on. */
  conformanceSwitched?(): void;
}

/** A chat's extension, linked to its chat. */
export interface ChatLink {
  readonly id: string;
  readonly scope: ChatScope;
  /** The host's dialogs, for this chat's questions - undefined in the terminal. */
  readonly dialogs: AskUserIO | undefined;
  /** `sentinel` for the session's sentinel. */
  readonly role: ChatRole | undefined;
  /** Its pi session, once it has one. */
  session(): AgentSession | undefined;
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
  role?: ChatRole;
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
  /** The questions the chat asks now declined, as ctrl+c at one declines it - `none` when it asks nothing. */
  decline(id: string): "declined" | "none" | "missing";
  /** The chat shown now. */
  shown(): string | undefined;
  /** Open a chat - fresh, or the saved one `sessionFile` is - shown at once unless `hidden`; the sentinel with `role`. */
  open(options?: { sessionFile?: string; hidden?: boolean; title?: string; role?: ChatRole }): Promise<ChatInfo>;
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
  /** For the extension: a pulse ended - told to the chat that asked for it, or, with the sentinel on, to the sentinel. */
  jobFinished(job: Job): void;
  /** Whether finished pulses go to the sentinel now: it is on, and there is somewhere to open it. */
  sentinelOn(): boolean;
  /** A notice put to the person, in the chat they look at - the sentinel's, or turri's own. Undefined: no chat to put it in. */
  notice(input: NoticeInput): Notice | undefined;
  /** The sentinel done with a pulse: told to the chat the person looks at. Undefined: no chat to tell. */
  concluded(conclusion: Conclusion): string | undefined;
  /** The test advisor's verdict, for the chat the person looks at - held until there is one. Undefined: no chat to hand it to yet. */
  advised(verdict: AdvisorVerdict): string | undefined;
  /** The notices put to the person and not yet answered. */
  notices(): Notice[];
  /**
   * A notice answered: what it asked done in the chat it is in, dismissed, or - an ignorable one - ignored for good.
   * `refused`: `ignore` on one that is not ignorable.
   */
  answer(id: string, answer: NoticeAnswer): "done" | "dismissed" | "ignored" | "refused" | "missing" | "over";
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
  /** Whether the project wants a sentinel - read as each pulse finishes: on, off, or ask the person first. Unset: none. */
  sentinel?: () => SentinelSetting;
  /** Under `sentinel: ask`: what the person is asked before the sentinel first opens, about the pulse that would open it. */
  sentinelStart?: (job: Job) => NoticeInput;
  /** The person chose for the project, asked whether to start the sentinel: `sentinel:` written. */
  setSentinel?: (on: boolean) => void;
  /** The person ignored a notice for good: kept in the sentinel's guidance, for every conversation after. */
  ignored?: (notice: Notice) => void;
}

/** A chat's session, as stopping what it does reaches it. */
export type Stoppable = Pick<AgentSession, "isStreaming" | "isCompacting" | "isRetrying" | "isBashRunning" | "abort" | "abortBash">;

/** A second interrupt this soon after one that stopped something stops nothing more and ends nothing: one pressed twice to be sure. */
export const INTERRUPT_SETTLE_MS = 500;

/**
 * ctrl+c in a chat, the terminal's or a host's: what the chat is doing stopped - its turn, a skill or a tool in it, a
 * `!` command, a compaction, a retry - and nothing in the other chats. `stopTurn` ends its turn: pi's own esc in the
 * terminal. A chat doing nothing gets `idle`'s answer - the session ended - unless the last interrupt, at `lastStop`,
 * stopped something a moment ago: then it is `ignored`.
 */
export function interruptChat<R>(session: Stoppable, asked: { lastStop: number; now?: number; stopTurn?: () => void; idle: () => R }): "stopped" | "ignored" | R {
  if (session.isBashRunning || session.isStreaming || session.isCompacting || session.isRetrying) {
    if (session.isBashRunning) session.abortBash();
    if (session.isStreaming) (asked.stopTurn ?? (() => void session.abort()))();
    else if (session.isCompacting || session.isRetrying) void session.abort();
    return "stopped";
  }
  if ((asked.now ?? Date.now()) - asked.lastStop < INTERRUPT_SETTLE_MS) return "ignored";
  return asked.idle();
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
  /** What the sentinel put to the person, and turri itself, this session: open until answered or superseded. */
  const open: Notice[] = [];
  /** The pulse the sentinel's conversation is on, from its brief until its agent is done: a newer one of the same module replaces a check of one that went well. */
  let checking: { job: Job; wrong: boolean } | undefined;
  /** Pulses that finished while the sentinel was at work: each checked in turn, in a conversation of its own. */
  const waiting: Job[] = [];
  /** What the sentinel is given is given one pulse at a time: its conversations made, and its pulses put to them, in order. */
  let sentinelWork: Promise<unknown> = Promise.resolve();
  /**
   * Under `sentinel: ask`, whether the person said to start the sentinel this session: asked - the notice `asking` open,
   * the pulses that ended meanwhile `held` - started, or not this session.
   */
  let consent: "unasked" | "asking" | "given" | "declined" = "unasked";
  let asking: Notice | undefined;
  const held: Job[] = [];
  /** The test advisor's verdicts that came with no chat of the person's to hand them to: handed on as one comes up. */
  const unplaced: AdvisorVerdict[] = [];
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
  const titleFor = (chat: ChatState) => (chat.role === SENTINEL ? SENTINEL : (titleOf(chat.session) ?? chat.recordedTitle ?? NEW_CHAT_TITLE));
  const sentinelChat = () => chats.find((chat) => chat.role === SENTINEL);
  /** The person's chats: all but the sentinel. */
  const people = () => chats.filter((chat) => chat.role !== SENTINEL);
  const setting = (): SentinelSetting => {
    try {
      return options.sentinel?.() ?? false;
    } catch {
      return false;
    }
  };
  /** On, or asked for - and not declined this session. */
  const wantsSentinel = () => {
    const now = setting();
    return now === true || (now === "ask" && consent !== "declined");
  };
  /** The chat the person looks at, for what is put to them - never the sentinel: when it is shown, `fallback`, else their first. */
  const personFacing = (fallback?: ChatState) => {
    const shown = chats.find((chat) => chat.id === shownId);
    if (shown !== undefined && shown.role !== SENTINEL && shown.instance !== undefined) return shown;
    return fallback?.instance !== undefined && fallback.role !== SENTINEL ? fallback : people().find((chat) => chat.instance !== undefined);
  };

  const statusOf = (chat: ChatState): ChatStatus =>
    (chat.ui?.waiting() ?? 0) > 0 ? "question" : chat.working ? "working" : chat.unread ? "unread" : "idle";

  /** What the session keeps of its chats on disk: those with something said in them, in order. */
  const persist = () => {
    if (options.persist !== true) return;
    // The sentinel last: `--continue` opens the first as pi's own chat, and that is the person's.
    run.chats = [...people(), ...chats.filter((chat) => chat.role === SENTINEL)].flatMap((chat): ChatRecord[] => {
      const file = chat.session?.sessionFile;
      return file !== undefined && existsSync(file) ? [{ id: chat.id, title: titleFor(chat), sessionFile: file, ...(chat.role !== undefined ? { role: chat.role } : {}) }] : [];
    });
    recordRun(cwd, run, { keep: debugMode(cwd) });
  };

  const newChat = (title?: string, role?: ChatRole): ChatState => {
    const id = randomUUID().slice(0, 8);
    const chat: ChatState = {
      id,
      scope: { id, stack: process.env.TURRI_STACK?.trim() || undefined, asking: new Set() },
      ...(title !== undefined ? { recordedTitle: title } : {}),
      ...(role !== undefined ? { role } : {}),
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
        // Done with its pulse - or with what the person said to it: the next pulse waiting, in a conversation of its own.
        if (chat.role === SENTINEL && (event as { willRetry?: boolean }).willRetry !== true) {
          checking = undefined;
          toSentinel(() => nextPulse(chat));
        }
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
    chats: () => chats.map((chat) => ({ id: chat.id, title: titleFor(chat), status: statusOf(chat), shown: chat.id === shownId, ...(chat.role !== undefined ? { role: chat.role } : {}) })),
    session: (id) => chats.find((chat) => chat.id === id)?.session,
    decline(id) {
      const chat = chats.find((candidate) => candidate.id === id);
      if (chat === undefined) return "missing";
      const asking = [...chat.scope.asking];
      for (const decline of asking) decline();
      return asking.length > 0 ? "declined" : "none";
    },
    shown: () => shownId,
    shownChat: () => chats.find((chat) => chat.id === shownId),
    chatOfSession: (session) => chats.find((chat) => chat.session === session),

    async open(asked = {}) {
      if (driver === undefined) throw new Error("This turri has one chat: there is nowhere to open another.");
      const done = opening.then(async () => {
        const already =
          asked.sessionFile !== undefined ? chats.find((chat) => chat.session?.sessionFile === asked.sessionFile) : asked.role === SENTINEL ? sentinelChat() : undefined;
        if (already !== undefined) return already;
        // The sentinel has a slot of its own: with it on, the person's chats are one fewer.
        const room = asked.role === SENTINEL ? MAX_CHATS - people().length : (wantsSentinel() ? MAX_CHATS - 1 : MAX_CHATS) - people().length;
        if (room <= 0) {
          const most = wantsSentinel() ? MAX_CHATS - 1 : MAX_CHATS;
          throw new Error(`${most} chats are open, the most there can be${wantsSentinel() ? " beside the sentinel" : ""}: close one first.`);
        }
        const chat = newChat(asked.title, asked.role);
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
        inChat(chat.scope, () => record({ kind: "chat.opened", reopened: asked.sessionFile !== undefined, ...(chat.role !== undefined ? { role: chat.role } : {}) }, { project: cwd }));
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
        const others = chats.filter((other) => other !== chat);
        const next = others.find((other, at) => other.role !== SENTINEL && at >= index) ?? [...others].reverse().find((other) => other.role !== SENTINEL) ?? others[0];
        if (next !== undefined) await core.show(next.id);
        else shownId = undefined;
      }
      const recorded = run.chats.find((kept) => kept.id === id);
      chats.splice(chats.indexOf(chat), 1);
      // Closed, the sentinel is let go with what it had to check: the next pulse that finishes opens it again.
      if (chat.role === SENTINEL) {
        checking = undefined;
        waiting.length = 0;
      }
      // The question whether to start the sentinel was in it: put again in the chat the person looks at now.
      if (asking?.chat === id) askAgain();
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
        role: chat.role,
        session: () => chat.session,
        live: (instance) => {
          chat.instance = instance;
          // The advisor's verdicts that waited for a chat of the person's.
          if (unplaced.length > 0 && personFacing() !== undefined) for (const verdict of unplaced.splice(0)) core.advised(verdict);
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

    sentinelOn: () => driver !== undefined && wantsSentinel(),

    jobFinished(job) {
      // The question was settled in config.turri.yaml while it was open: what it held goes as the file now says.
      if (consent === "asking" && setting() !== "ask") settleStart(setting() === true ? "given" : "declined", "superseded");
      if (core.sentinelOn()) {
        if (consent === "asking" || (setting() === "ask" && consent === "unasked" && sentinelChat() === undefined && askToStart(job))) {
          held.push(job);
          changed();
          return;
        }
        sentinelFinished(job);
        return;
      }
      toAsker(job);
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

    notice(input) {
      const asked = chats.find((chat) => chat.id === (input.job !== undefined ? jobs.get(input.job)?.chat : undefined));
      const target = personFacing(asked);
      if (target === undefined) return undefined;
      // One notice open a module: a newer one makes the older one's call to action stale.
      if (input.module !== undefined) {
        for (const older of open.filter((notice) => notice.state === "open" && notice.module === input.module)) over(older, "superseded");
      }
      // Only the sentinel's own may be ignored: never the question whether to start it.
      const { ignorable, ...rest } = input;
      const notice = newNotice(ignorable === true && input.kind !== "sentinel-start" ? input : rest, target.id);
      open.push(notice);
      if (target.id !== shownId) target.unread = true;
      inChat(target.scope, () => record({ kind: "notice.put", notice: notice.id, severity: notice.severity, ...(notice.module !== undefined ? { module: notice.module } : {}) }, { project: cwd }));
      try {
        target.instance?.notice(notice);
      } catch {
        /* a chat let go as it was put: the host still hears it */
      }
      try {
        host.onNotice?.(notice);
      } catch {
        /* a host that throws must not lose the notice */
      }
      changed();
      return notice;
    },

    notices: () => open.filter((notice) => notice.state === "open"),

    concluded(conclusion) {
      const job = jobs.get(conclusion.job);
      const target = personFacing(chats.find((chat) => chat.id === job?.chat));
      if (target === undefined) return undefined;
      const module = conclusion.module ?? job?.module;
      const pulse = conclusion.pulse ?? job?.pulse;
      const told = { ...conclusion, ...(module !== undefined ? { module } : {}), ...(pulse !== undefined ? { pulse } : {}) };
      if (target.id !== shownId) target.unread = true;
      inChat(target.scope, () => record({ kind: "sentinel.concluded", verdict: told.verdict, ...(module !== undefined ? { module } : {}) }, { project: cwd, job: told.job }));
      try {
        target.instance?.concluded(told);
      } catch {
        /* a chat let go as it was told: the host still hears it */
      }
      try {
        host.onConcluded?.({ ...told, chat: target.id });
      } catch {
        /* a host that throws must not lose it */
      }
      changed();
      return target.id;
    },

    advised(verdict) {
      const target = personFacing();
      if (target?.instance === undefined) {
        unplaced.push(verdict);
        return undefined;
      }
      if (target.id !== shownId) target.unread = true;
      try {
        target.instance.advised(verdict);
      } catch {
        /* a chat let go as it was told: a yes stays undelivered in the advisor's file, for the next start */
      }
      changed();
      return target.id;
    },

    answer(id, answer) {
      const notice = open.find((candidate) => candidate.id === id);
      if (notice === undefined) return "missing";
      if (notice.state !== "open") return "over";
      // Left as the build has it, for good: nothing done in the chat, and the sentinel told not to raise it again.
      if ("ignore" in answer) {
        if (notice.ignorable !== true) return "refused";
        try {
          options.ignored?.(notice);
        } catch (error) {
          core.notify(`The sentinel's guidance could not be written: ${error instanceof Error ? error.message : String(error)}`, "warning");
        }
        over(notice, "ignored");
        return "ignored";
      }
      if (notice.kind === "sentinel-start") return answerStart(notice, answer);
      const task = noticeTask(notice, answer);
      over(notice, "dismiss" in answer ? "dismissed" : "steer" in answer ? "steered" : "accepted");
      if (task === undefined) return "dismissed";
      const chat = chats.find((candidate) => candidate.id === notice.chat) ?? personFacing();
      chat?.instance?.act(task);
      return "done";
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
      // The first of the person's chats is the one pi reopened itself (pi-launch.ts): the sentinel is never it.
      const first = saved.chats.find((kept) => kept.role === undefined);
      if (first !== undefined && asked.skipFirst === true) {
        const chat = chats[0];
        if (chat !== undefined) chat.recordedTitle ??= first.title;
      }
      for (const kept of asked.skipFirst === true ? saved.chats.filter((other) => other !== first) : saved.chats) {
        try {
          await core.open({ sessionFile: kept.sessionFile, hidden: true, title: kept.title, ...(kept.role !== undefined ? { role: kept.role } : {}) });
        } catch (error) {
          core.notify(`The chat "${kept.title}" could not be reopened: ${error instanceof Error ? error.message : String(error)}`, "warning");
        }
      }
      persist();
    },
  };
  /** A notice ended - answered, dismissed, superseded: its dialog closed, and the host told. */
  function over(notice: Notice, state: Exclude<Notice["state"], "open">): void {
    notice.state = state;
    const chat = chats.find((candidate) => candidate.id === notice.chat);
    try {
      chat?.instance?.noticeOver(notice);
    } catch {
      /* a chat let go has no dialog to close */
    }
    try {
      host.onNoticeOver?.(notice);
    } catch {
      /* a host that throws must not keep the notice open */
    }
    if (chat !== undefined) inChat(chat.scope, () => record({ kind: "notice.over", notice: notice.id, state }, { project: cwd }));
  }

  /** A pulse ended, told to the chat that asked for it - as without a sentinel - or the chat shown, when that one is closed. */
  function toAsker(job: Job): void {
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
  }

  /**
   * Under `sentinel: ask`, the first pulse that would open the sentinel this session: the person asked whether to start it,
   * in the chat they look at. False when there is nothing to ask with, or no chat to ask in: the sentinel opens as asked.
   */
  function askToStart(job: Job): boolean {
    let input: NoticeInput | undefined;
    try {
      input = options.sentinelStart?.(job);
    } catch {
      input = undefined;
    }
    if (input === undefined) return false;
    consent = "asking";
    asking = core.notice({ ...input, kind: "sentinel-start" });
    if (asking === undefined) consent = "unasked";
    return asking !== undefined;
  }

  /** The chat the question was put in is gone: it is put in the chat the person looks at - none left, the pulses go as without one. */
  function askAgain(): void {
    const question = asking!;
    over(question, "superseded");
    asking = undefined;
    consent = "unasked";
    if (!askToStart(held[0]!)) settleStart("declined", "superseded");
  }

  /** The person answered whether to start the sentinel: written to the project, when they chose for it, and what was held let go. */
  function answerStart(notice: Notice, answer: NoticeAnswer): "done" | "dismissed" {
    const choice = sentinelStartChoice(notice, answer);
    try {
      if (choice === "always" || choice === "never") options.setSentinel?.(choice === "always");
    } catch (error) {
      core.notify(`config.turri.yaml could not be written: ${error instanceof Error ? error.message : String(error)}`, "warning");
    }
    settleStart(choice === "start" || choice === "always" ? "given" : "declined", "dismiss" in answer ? "dismissed" : "steer" in answer ? "steered" : "accepted");
    // Their own words are the chat's to act on: the sentinel is not started.
    if ("steer" in answer) {
      const task = noticeTask(notice, answer);
      const chat = chats.find((candidate) => candidate.id === notice.chat) ?? personFacing();
      if (task !== undefined) chat?.instance?.act(task);
    }
    return "dismiss" in answer ? "dismissed" : "done";
  }

  /** Whether to start the sentinel is settled: its question closed, and the pulses held go to it - or, declined, to their chats. */
  function settleStart(now: "given" | "declined", state: Exclude<Notice["state"], "open">): void {
    consent = now;
    const question = asking;
    asking = undefined;
    if (question !== undefined && question.state === "open") over(question, state);
    for (const job of held.splice(0)) {
      if (core.sentinelOn()) sentinelFinished(job);
      else toAsker(job);
    }
    changed();
  }

  /**
   * A pulse ended, with the sentinel on: the chat the person looks at says so - its agent told of one that landed, to
   * tell the person it landed and what the sentinel does with it, and nothing more; of one that went wrong, not, the
   * sentinel's notice being what it hears of it - and the sentinel is given it, opened in the background when it is not
   * open.
   */
  function sentinelFinished(job: Job): void {
    const asked = chats.find((chat) => chat.id === job.chat && chat.role !== SENTINEL);
    const where = personFacing(asked);
    if (where !== undefined) {
      if (where.id !== shownId) where.unread = true;
      try {
        where.instance?.landed(job, { tell: !wentWrong(job) });
      } catch {
        /* a chat let go as the pulse ended: the sentinel still hears of it */
      }
    }
    changed();
    toSentinel(async () => {
      let sentinel = sentinelChat();
      if (sentinel === undefined) {
        try {
          await core.open({ hidden: true, role: SENTINEL });
          sentinel = sentinelChat();
        } catch (error) {
          // No room for it, or nowhere to open it: the pulse is told as it is without one.
          core.notify(`The sentinel could not be opened: ${error instanceof Error ? error.message : String(error)}`, "warning");
          (asked ?? where)?.instance?.announce(job);
          return;
        }
      }
      if (sentinel?.instance === undefined) return;
      await takePulse(sentinel, job);
    });
  }

  /** The sentinel's work, after what it was given before. */
  function toSentinel(work: () => Promise<void> | void): void {
    sentinelWork = sentinelWork.then(work).catch((error: unknown) => {
      core.notify(`The sentinel: ${error instanceof Error ? error.message : String(error)}`, "warning");
    });
  }

  /** Whether the sentinel is at work: on a pulse - its turn starts as it is told of one - or on what the person said to it. */
  const sentinelBusy = (sentinel: ChatState) => sentinel.session?.isStreaming === true;

  /**
   * A finished pulse, for the sentinel: checked now when it is free. Busy, a newer pulse of a module replaces a check of
   * the module's last pulse that went well - and a pulse of it that went well and waits - and one that went wrong is
   * looked into to its end; the rest wait their turn.
   */
  function takePulse(sentinel: ChatState, job: Job): Promise<void> | void {
    if (!sentinelBusy(sentinel)) return check(sentinel, job);
    const sameModule = (other: Job) => job.module !== undefined && other.module === job.module;
    if (checking !== undefined && !checking.wrong && sameModule(checking.job)) return check(sentinel, job, checking.job);
    const older = waiting.findIndex((other) => sameModule(other) && !wentWrong(other));
    if (older !== -1) waiting.splice(older, 1, job);
    else waiting.push(job);
  }

  /** The sentinel free again: the next pulse that waits, checked. */
  function nextPulse(sentinel: ChatState): Promise<void> | void {
    if (!chats.includes(sentinel) || sentinelBusy(sentinel)) return;
    const job = waiting.shift();
    if (job !== undefined) return check(sentinel, job);
  }

  /**
   * The sentinel on a pulse, from scratch: a conversation of its own - its prompt, the project's guidance and this
   * pulse's brief, nothing of the pulses before it - in place of the one it had, stopped when it was on `replacing`.
   */
  async function check(sentinel: ChatState, job: Job, replacing?: Job): Promise<void> {
    checking = { job, wrong: wentWrong(job) };
    const module = job.module;
    inChat(sentinel.scope, () =>
      record({ kind: "sentinel.checking", ...(module !== undefined ? { module } : {}), ...(replacing !== undefined ? { replaced: replacing.id } : {}) }, { project: cwd, job: job.id }),
    );
    const session = sentinel.session;
    if (session !== undefined && (session.messages.length > 0 || session.isStreaming)) await freshConversation(sentinel);
    if (sentinel.id !== shownId) sentinel.unread = true;
    const asked = chats.find((chat) => chat.id === job.chat && chat.role !== SENTINEL && chat.instance !== undefined);
    const where = personFacing(asked);
    try {
      await sentinel.instance!.brief(job, {
        ...(asked !== undefined ? { asked: titleFor(asked) } : {}),
        ...(where !== undefined ? { focused: titleFor(where) } : {}),
      });
    } catch (error) {
      core.notify(`The sentinel could not be told of ${job.id}: ${error instanceof Error ? error.message : String(error)}`, "warning");
      checking = undefined;
    }
    changed();
  }

  /**
   * The sentinel's chat given a new session, under the same id: what it does now stopped, and what it said let go - its
   * saved conversation deleted outside debug mode. The model and thinking it had carry over: what the person picked in
   * it stands. Shown in the terminal, the screen is drawn from the new one. A new session that cannot be made leaves it
   * the one it had.
   */
  async function freshConversation(chat: ChatState): Promise<void> {
    const old = { session: chat.session!, services: chat.services, instance: chat.instance };
    chat.unsubscribe?.();
    chat.unsubscribe = undefined;
    try {
      await old.session.abort();
    } catch {
      /* stopped already */
    }
    chat.working = false;
    const model = old.session.model;
    const thinking = old.session.thinkingLevel;
    // Made as a chat is opened, one at a time: its extension built while it is the one attaching.
    const made = opening.then(async () => {
      attaching = chat;
      try {
        await driver!.create(chat, undefined);
      } finally {
        attaching = undefined;
      }
    });
    opening = made.catch(() => undefined);
    try {
      await made;
    } catch (error) {
      Object.assign(chat, old);
      follow(chat);
      core.notify(`The sentinel goes on in the conversation it had - a new one could not be started: ${error instanceof Error ? error.message : String(error)}`, "warning");
      return;
    }
    const fresh = chat.session!;
    try {
      if (model !== undefined && fresh.model !== model) await fresh.setModel(model);
      if (thinking !== undefined) fresh.setThinkingLevel(thinking);
    } catch {
      /* the model its session started on, then */
    }
    follow(chat);
    if (shownId === chat.id) await driver?.show?.(chat, undefined);
    try {
      old.session.dispose();
    } catch {
      /* let go already */
    }
    if (old.session.sessionFile !== undefined && old.session.sessionFile !== fresh.sessionFile) forgetSessionFile(old.session.sessionFile, { keep: debugMode(cwd) });
    try {
      host.onChatSession?.(chat.id, fresh);
    } catch {
      /* a host that throws still has the chat's new session in session(id) */
    }
    persist();
    changed();
  }

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
