import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { inChat } from "../src/chat-scope.ts";
import { createChats, MAX_CHATS, type ChatLink, type SentinelLaunches, type TurriCore, type TurriHost } from "../src/chats.ts";
import { createJobRegistry, type Job } from "../src/regenerate/jobs.ts";
import { LAUNCHED_ONLY } from "../src/launch-session.ts";
import { describeNotice, noticeTask, SENTINEL, SENTINEL_TOOLS, sentinelBrief, sentinelCheckBrief, sentinelFileTools, sentinelPrompt, whoHoldsTool, type Notice, type SentinelCheck } from "../src/sentinel.ts";
import { createServer } from "node:net";

/**
 * A pi session as the session follows it: its events sent by the test, whether its agent is at work, what it was told,
 * whether it was stopped and let go, and the model and thinking set on it.
 */
function fakeSession() {
  const listeners = new Set<(event: { type: string }) => void>();
  const state = { isStreaming: false, aborted: 0, disposed: false, model: undefined as { id: string } | undefined, thinking: undefined as string | undefined };
  const messages: unknown[] = [];
  const session = {
    subscribe: (listener: (event: { type: string }) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get isStreaming() {
      return state.isStreaming;
    },
    get model() {
      return state.model;
    },
    get thinkingLevel() {
      return state.thinking;
    },
    setModel: async (model: { id: string }) => void (state.model = model),
    setThinkingLevel: (level: string) => void (state.thinking = level),
    abort: async () => {
      state.aborted += 1;
      state.isStreaming = false;
    },
    dispose: () => void (state.disposed = true),
    sessionFile: undefined,
    messages,
    sessionManager: { getSessionName: () => undefined },
    extensionRunner: { getUIContext: () => undefined },
  } as unknown as AgentSession;
  return { session, state, messages, emit: (type: string) => listeners.forEach((listener) => listener({ type })) };
}

interface Told {
  announced: string[];
  landed: Array<{ job: string; tell: boolean }>;
  briefs: Array<{ job: string; asked?: string; focused?: string }>;
  notices: Notice[];
  over: Array<{ id: string; state: string }>;
  acted: string[];
  concluded: string[];
  checks: Array<{ check: string; focused?: string }>;
  resumed: string[];
  launched: string[];
}

/** A session with the sentinel on, its chats living nowhere but here: each chat's extension says what it is told. */
function session(options: { sentinel?: boolean | "ask"; host?: TurriHost; ignored?: (notice: Notice) => void; launches?: SentinelLaunches; resume?: (work: { job: Job } | { check: SentinelCheck }) => void } = {}) {
  const told = new Map<string, Told>();
  const links: ChatLink[] = [];
  /** Each chat's session now - and every session each chat had, in order. */
  const sessions = new Map<string, ReturnType<typeof fakeSession>>();
  const history = new Map<string, Array<ReturnType<typeof fakeSession>>>();
  const shownBy: string[] = [];
  let core: TurriCore;
  const jobs = createJobRegistry({ onFinish: (job) => core.jobFinished(job) });
  const of = (id: string): Told => {
    if (!told.has(id)) told.set(id, { announced: [], landed: [], briefs: [], notices: [], over: [], acted: [], concluded: [], checks: [], resumed: [], launched: [] });
    return told.get(id)!;
  };
  core = createChats({
    cwd: process.cwd(),
    host: options.host ?? {},
    jobs,
    sentinel: () => options.sentinel ?? true,
    ...(options.ignored !== undefined ? { ignored: options.ignored } : {}),
    ...(options.launches !== undefined ? { launches: options.launches } : {}),
    sentinelStart: (about) => ({
      severity: "info",
      summary: "kind" in about ? `${about.summary} finished - start the sentinel?` : `checking ${about.module} needs the sentinel - start it?`,
      evidence: [],
      actions: [{ label: "Start the sentinel", task: "" }, { label: "Not this session", task: "" }],
      ...("kind" in about ? { job: about.id } : { check: about.id }),
    }),
    extension: (_pi, link) => {
      links.push(link);
      link.live({
        announce: (job: Job) => of(link.id).announced.push(job.summary),
        landed: (job: Job, options) => of(link.id).landed.push({ job: job.summary, tell: options?.tell === true }),
        // As pi does, the brief starts a turn: the session is at work, the pulse's message its first.
        brief: async (job, context) => {
          of(link.id).briefs.push({ job: job.summary, ...context });
          const made = sessions.get(link.id)!;
          made.messages.push({ role: "custom", customType: "turri_sentinel_pulse", details: { jobId: job.id } });
          made.state.isStreaming = true;
        },
        // The check's message its first, as the brief's.
        briefCheck: async (check, context) => {
          of(link.id).checks.push({ check: check.id, ...context });
          const made = sessions.get(link.id)!;
          made.messages.push({ role: "custom", customType: "turri_sentinel_check", details: { checkId: check.id } });
          made.state.isStreaming = true;
        },
        // Carried on in the conversation it was in: a turn of its own.
        resume: async (work) => {
          options.resume?.(work);
          of(link.id).resumed.push("job" in work ? work.job.summary : work.check.id);
          sessions.get(link.id)!.state.isStreaming = true;
        },
        launched: (launch) => of(link.id).launched.push(`${launch.id} ${launch.status}`),
        notice: (notice) => of(link.id).notices.push(notice),
        noticeOver: (notice) => of(link.id).over.push({ id: notice.id, state: notice.state }),
        act: (task) => of(link.id).acted.push(task),
        concluded: (conclusion) => of(link.id).concluded.push(`${conclusion.check !== undefined ? `check ${conclusion.check} ` : ""}${conclusion.module} ${conclusion.verdict}: ${conclusion.summary}`),
        thinkingLevel: () => undefined,
        context: () => undefined,
      });
    },
  });
  core.setDriver({
    async create(chat) {
      core.extension({} as ExtensionAPI);
      const made = fakeSession();
      sessions.set(chat.id, made);
      history.set(chat.id, [...(history.get(chat.id) ?? []), made]);
      chat.session = made.session;
    },
    async show(chat) {
      shownBy.push(chat.id);
      core.showing(chat);
    },
    async dispose() {},
  });
  const sentinel = () => core.chats().find((chat) => chat.role === SENTINEL);
  /** The sentinel's agent done with its turn. */
  const finish = async () => {
    const made = sessions.get(sentinel()!.id)!;
    made.state.isStreaming = false;
    // As pi does: agent_end while it still streams, agent_settled once it is idle.
    made.emit("agent_end");
    made.emit("agent_settled");
    await settled();
  };
  return { core, jobs, told: of, links, sessions, history, shownBy, sentinel, finish };
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 20));

const pulse = (summary: string, module: string, outcome: "lands" | "fails" = "lands") => ({
  kind: "regenerate",
  summary,
  module,
  run: async () => {
    if (outcome === "fails") throw new Error("the unit tests failed");
    return { report: "done", details: { passed: true, landed: true } };
  },
});

describe("the sentinel", () => {
  it("is told of every finished pulse, opened in the background with the first - the chat the person looks at told only that it landed", async () => {
    const { core, jobs, told, links, sentinel } = session();
    const mine = await core.open();
    inChat(links[0]!.scope, () => jobs.start(pulse("app pulse 1", "app")));
    await settled();
    expect(told(mine.id).landed).toEqual([{ job: "app pulse 1", tell: true }]);
    expect(told(mine.id).announced).toEqual([]);
    const opened = sentinel();
    expect(opened).toMatchObject({ title: SENTINEL, role: SENTINEL, shown: false });
    expect(core.shown()).toBe(mine.id);
    expect(told(opened!.id).briefs).toEqual([{ job: "app pulse 1", asked: "new chat", focused: "new chat" }]);
  });

  it("has a pulse that went wrong to itself: the chat the person looks at shows it, its agent not told", async () => {
    const { core, jobs, told, sentinel } = session();
    const mine = await core.open();
    jobs.start(pulse("app pulse 1", "app", "fails"));
    await settled();
    expect(told(mine.id).landed).toEqual([{ job: "app pulse 1", tell: false }]);
    expect(told(mine.id).announced).toEqual([]);
    expect(told(sentinel()!.id).briefs.map((brief) => brief.job)).toEqual(["app pulse 1"]);
  });

  it("is opened once, and again by the next finished pulse after it is closed", async () => {
    const { core, jobs, sentinel } = session();
    await core.open();
    jobs.start(pulse("app pulse 1", "app"));
    await settled();
    jobs.start(pulse("app pulse 2", "app"));
    await settled();
    expect(core.chats().filter((chat) => chat.role === SENTINEL)).toHaveLength(1);
    await core.close(sentinel()!.id);
    expect(sentinel()).toBeUndefined();
    jobs.start(pulse("app pulse 3", "app"));
    await settled();
    expect(sentinel()).toBeDefined();
  });

  it(`keeps a slot of its own: the person opens ${MAX_CHATS - 1} chats beside it, and it opens all the same`, async () => {
    const { core, jobs, sentinel } = session();
    for (let index = 0; index < MAX_CHATS - 1; index += 1) await core.open();
    await expect(core.open()).rejects.toThrow(`${MAX_CHATS - 1} chats are open, the most there can be beside the sentinel: close one first.`);
    jobs.start(pulse("app pulse 1", "app"));
    await settled();
    expect(sentinel()).toBeDefined();
    expect(core.chats()).toHaveLength(MAX_CHATS);
  });

  it("is not there when the project turns it off: the chat that asked is told, as without one", async () => {
    const { core, jobs, told, links, sentinel } = session({ sentinel: false });
    const mine = await core.open();
    inChat(links[0]!.scope, () => jobs.start(pulse("app pulse 1", "app")));
    await settled();
    expect(told(mine.id).announced).toEqual(["app pulse 1"]);
    expect(sentinel()).toBeUndefined();
  });

  it("checks each pulse in a conversation of its own: a new session under the same chat id, the one before stopped and let go", async () => {
    const changed: Array<[string, AgentSession]> = [];
    const { core, jobs, told, history, sentinel, finish } = session({ host: { onChatSession: (chat, made) => void changed.push([chat, made]) } });
    await core.open();
    const one = jobs.start(pulse("app pulse 1", "app"));
    await settled();
    const id = sentinel()!.id;
    await finish();
    const two = jobs.start(pulse("app pulse 2", "app"));
    await settled();
    expect(sentinel()!.id).toBe(id);
    expect(history.get(id)).toHaveLength(2);
    const [first, second] = history.get(id)!;
    // The pulse's message is the first of each conversation, and nothing of the pulse before is in the second.
    const pulses = (made: typeof first) => made!.messages.map((message) => (message as { details: { jobId: string } }).details.jobId);
    expect(pulses(first)).toEqual([one.id]);
    expect(pulses(second)).toEqual([two.id]);
    expect(first!.state).toMatchObject({ aborted: 1, disposed: true });
    expect(core.session(id)).toBe(second!.session);
    expect(changed).toEqual([[id, second!.session]]);
    expect(told(id).briefs.map((brief) => brief.job)).toEqual(["app pulse 1", "app pulse 2"]);
  });

  it("starts the first pulse in the conversation it was opened with", async () => {
    const { core, jobs, history, sentinel } = session();
    await core.open();
    jobs.start(pulse("app pulse 1", "app"));
    await settled();
    expect(history.get(sentinel()!.id)).toHaveLength(1);
  });

  it("keeps the model and thinking its chat had - what the person picked in it stands", async () => {
    const { core, jobs, sessions, sentinel, finish } = session();
    await core.open();
    jobs.start(pulse("app pulse 1", "app"));
    await settled();
    const id = sentinel()!.id;
    Object.assign(sessions.get(id)!.state, { model: { id: "picked" }, thinking: "high" });
    await finish();
    jobs.start(pulse("app pulse 2", "app"));
    await settled();
    expect(sessions.get(id)!.state).toMatchObject({ model: { id: "picked" }, thinking: "high" });
  });

  it("draws the new conversation on the screen when the sentinel is the chat shown", async () => {
    const { core, jobs, shownBy, sentinel, finish } = session();
    await core.open();
    jobs.start(pulse("app pulse 1", "app"));
    await settled();
    const id = sentinel()!.id;
    await core.show(id);
    await finish();
    shownBy.length = 0;
    jobs.start(pulse("app pulse 2", "app"));
    await settled();
    expect(shownBy).toEqual([id]);
    expect(core.shown()).toBe(id);
  });

  it("has pulses that finish while it works wait their turn, each then checked from scratch", async () => {
    const { core, jobs, told, history, sentinel, finish } = session();
    await core.open();
    jobs.start(pulse("app pulse 1", "app"));
    await settled();
    const id = sentinel()!.id;
    jobs.start(pulse("web pulse 1", "web"));
    await settled();
    jobs.start(pulse("api pulse 1", "api"));
    await settled();
    expect(told(id).briefs.map((brief) => brief.job)).toEqual(["app pulse 1"]);
    await finish();
    expect(told(id).briefs.map((brief) => brief.job)).toEqual(["app pulse 1", "web pulse 1"]);
    await finish();
    expect(told(id).briefs.map((brief) => brief.job)).toEqual(["app pulse 1", "web pulse 1", "api pulse 1"]);
    expect(history.get(id)!.map((made) => made.messages.length)).toEqual([1, 1, 1]);
  });

  it("waits for what the person says to it to be answered before a pulse starts afresh", async () => {
    const { core, jobs, told, sessions, sentinel, finish } = session();
    await core.open();
    jobs.start(pulse("app pulse 1", "app"));
    await settled();
    const id = sentinel()!.id;
    await finish();
    // The person talks to it.
    sessions.get(id)!.state.isStreaming = true;
    jobs.start(pulse("app pulse 2", "app"));
    await settled();
    expect(told(id).briefs.map((brief) => brief.job)).toEqual(["app pulse 1"]);
    await finish();
    expect(told(id).briefs.map((brief) => brief.job)).toEqual(["app pulse 1", "app pulse 2"]);
  });

  it("checks every pulse, in order - a newer pulse of a module waits its turn, never taking the place of one before", async () => {
    const { core, jobs, told, history, sentinel, finish } = session();
    await core.open();
    jobs.start(pulse("app pulse 1", "app"));
    await settled();
    const id = sentinel()!.id;
    jobs.start(pulse("app pulse 2", "app"));
    await settled();
    jobs.start(pulse("web pulse 1", "web"));
    await settled();
    jobs.start(pulse("app pulse 3", "app", "fails"));
    await settled();
    // The check of the first is not stopped for the newer pulses of its module.
    expect(history.get(id)![0]!.state).toMatchObject({ aborted: 0, disposed: false });
    expect(told(id).briefs.map((brief) => brief.job)).toEqual(["app pulse 1"]);
    await finish();
    await finish();
    await finish();
    expect(told(id).briefs.map((brief) => brief.job)).toEqual(["app pulse 1", "app pulse 2", "web pulse 1", "app pulse 3"]);
  });

  it("takes the pulse that waited once its session settles - not at agent_end, while pi still counts the run as streaming", async () => {
    const { core, jobs, told, sessions, sentinel } = session();
    await core.open();
    jobs.start(pulse("app pulse 1", "app"));
    await settled();
    const id = sentinel()!.id;
    jobs.start(pulse("app pulse 2", "app"));
    await settled();
    // pi: agent_end comes while the run is still active...
    sessions.get(id)!.emit("agent_end");
    await settled();
    expect(told(id).briefs.map((brief) => brief.job)).toEqual(["app pulse 1"]);
    // ...and agent_settled once it is not.
    sessions.get(id)!.state.isStreaming = false;
    sessions.get(id)!.emit("agent_settled");
    await settled();
    expect(told(id).briefs.map((brief) => brief.job)).toEqual(["app pulse 1", "app pulse 2"]);
  });

  it("lets go of the pulses that waited for it when it is closed", async () => {
    const { core, jobs, told, sentinel, finish } = session();
    await core.open();
    jobs.start(pulse("app pulse 1", "app"));
    await settled();
    jobs.start(pulse("web pulse 1", "web"));
    await settled();
    await core.close(sentinel()!.id);
    jobs.start(pulse("api pulse 1", "api"));
    await settled();
    await finish();
    expect(told(sentinel()!.id).briefs.map((brief) => brief.job)).toEqual(["api pulse 1"]);
  });
});

describe("the sentinel and the launches", () => {
  /** A launch track as the sentinel waits on it: each codebase's launches settled when the test says. */
  function launches(options: { refuse?: (job: Job) => string | undefined; nothingFor?: string } = {}) {
    const waiting = new Map<string, Array<() => void>>();
    const busy = new Set<string>();
    const gate: SentinelLaunches = {
      async readyFor(job) {
        const codebase = job.module!;
        if (busy.has(codebase)) await new Promise<void>((resolve) => waiting.set(codebase, [...(waiting.get(codebase) ?? []), resolve]));
        const why = options.refuse?.(job);
        if (why !== undefined) throw new Error(why);
      },
      async readyForCheck(check) {
        if (options.nothingFor === check.module) throw new Error(`nothing of ${check.module} is launched to test it in`);
      },
      settled: (codebase) => (busy.has(codebase) ? new Promise<void>((resolve) => waiting.set(codebase, [...(waiting.get(codebase) ?? []), resolve])) : Promise.resolve()),
    };
    return {
      gate,
      launching: (codebase: string) => busy.add(codebase),
      settle: (codebase: string) => {
        busy.delete(codebase);
        for (const resolve of waiting.get(codebase) ?? []) resolve();
        waiting.delete(codebase);
      },
    };
  }
  const launch = (codebase: string, status: "running" | "launched" = "running") =>
    ({ id: "launch-2", codebase, moduleDir: "", plainFile: "", commit: "abc", short: "abc", hostDir: "", cause: { pulse: "p2", title: "x" }, status, queuedAt: 0 }) as const;

  it("is told of a pulse only once what runs of its codebase is settled - the pulses after it waiting with it", async () => {
    const track = launches();
    const { core, jobs, told, sentinel } = session({ launches: track.gate });
    await core.open();
    track.launching("app");
    jobs.start(pulse("app pulse 1", "app"));
    await settled();
    jobs.start(pulse("web pulse 1", "web"));
    await settled();
    expect(told(sentinel()!.id).briefs).toEqual([]);
    track.settle("app");
    await settled();
    expect(told(sentinel()!.id).briefs.map((brief) => brief.job)).toEqual(["app pulse 1"]);
  });

  it("pauses its check when its codebase is launched again, and carries it on in the conversation it was in once the launches settle", async () => {
    const track = launches();
    const { core, jobs, told, sessions, history, sentinel, finish } = session({ launches: track.gate });
    await core.open();
    jobs.start(pulse("app pulse 1", "app"));
    await settled();
    const id = sentinel()!.id;
    jobs.start(pulse("app pulse 2", "app"));
    await settled();
    // The next pulse's launch starts: the check of the first stopped where it is, its conversation kept.
    track.launching("app");
    core.launchChanged(launch("app") as never);
    await settled();
    expect(sessions.get(id)!.state.aborted).toBe(1);
    sessions.get(id)!.emit("agent_end");
    sessions.get(id)!.emit("agent_settled");
    await settled();
    // Paused, it takes nothing else - the next pulse waits.
    expect(told(id).briefs.map((brief) => brief.job)).toEqual(["app pulse 1"]);
    // A launch of another codebase leaves it alone.
    core.launchChanged(launch("web") as never);
    await settled();
    expect(sessions.get(id)!.state.aborted).toBe(1);
    track.settle("app");
    await settled();
    expect(told(id).resumed).toEqual(["app pulse 1"]);
    expect(history.get(id)).toHaveLength(1);
    await finish();
    expect(told(id).briefs.map((brief) => brief.job)).toEqual(["app pulse 1", "app pulse 2"]);
  });

  it("leaves a check it has concluded alone when its codebase is launched again - it is only saying so", async () => {
    const track = launches();
    const { core, jobs, told, sessions, sentinel } = session({ launches: track.gate });
    await core.open();
    jobs.start(pulse("app pulse 1", "app"));
    await settled();
    const id = sentinel()!.id;
    core.concluded({ job: jobs.list().find((job) => job.summary === "app pulse 1")!.id, verdict: "wrong", summary: "the launch did not come up" });
    track.launching("app");
    core.launchChanged(launch("app") as never);
    await settled();
    expect(sessions.get(id)!.state.aborted).toBe(0);
    track.settle("app");
    await settled();
    expect(told(id).resumed).toEqual([]);
  });

  it("refuses a pulse what runs cannot hold - an error where the person is, the pulse unchecked - and takes the next", async () => {
    const track = launches({ refuse: (job) => (job.summary === "app pulse 1" ? "what runs of app is its commit abc, which does not hold pulse's commit def." : undefined) });
    const { core, jobs, told, sentinel } = session({ launches: track.gate });
    const mine = await core.open();
    jobs.start(pulse("app pulse 1", "app"));
    await settled();
    jobs.start(pulse("app pulse 2", "app"));
    await settled();
    expect(told(mine.id).concluded).toEqual(["app unchecked: Not checked: what runs of app is its commit abc, which does not hold pulse's commit def."]);
    expect(told(sentinel()!.id).briefs.map((brief) => brief.job)).toEqual(["app pulse 2"]);
  });

  it("tells the pulse's chat, with the sentinel off, of its launch that ended - not of one a newer launch replaced as it ended", async () => {
    const { core, jobs, told } = session({ sentinel: false });
    const mine = await core.open();
    const job = jobs.start(pulse("app pulse 1", "app"));
    await settled();
    const ended = { ...launch("app", "launched"), cause: { pulse: job.id, title: "x" } };
    core.launchChanged({ ...ended, id: "launch-1", replacedBy: "launch-2" } as never);
    expect(told(mine.id).launched).toEqual([]);
    core.launchChanged(ended as never);
    expect(told(mine.id).launched).toEqual(["launch-2 launched"]);
  });

  it("says a refused pulse as an error, naming the pulse once - turri got it wrong", async () => {
    const track = launches({ refuse: () => "what runs of app is its commit abc, which does not hold pulse's commit def." });
    const { core, jobs } = session({ launches: track.gate });
    const notified = vi.spyOn(core, "notify");
    await core.open();
    const job = jobs.start(pulse("app pulse 1", "app"));
    await settled();
    expect(notified).toHaveBeenCalledWith(`The sentinel cannot check pulse ${job.id}: what runs of app is its commit abc, which does not hold pulse's commit def.`, "error");
  });

  it("carries a check on that what runs no longer holds as refused, once the launches settle", async () => {
    const track = launches();
    const { core, jobs, told, sentinel } = session({
      launches: track.gate,
      resume: () => {
        throw new Error("nothing of app runs - no launch holds pulse's commit.");
      },
    });
    const mine = await core.open();
    jobs.start(pulse("app pulse 1", "app"));
    await settled();
    track.launching("app");
    core.launchChanged(launch("app") as never);
    await settled();
    track.settle("app");
    await settled();
    expect(told(mine.id).concluded).toEqual(["app unchecked: Not checked: nothing of app runs - no launch holds pulse's commit."]);
    expect(told(sentinel()!.id).resumed).toEqual([]);
  });
});

describe("asking to start the sentinel", () => {
  it("holds every pulse that ends while the person is asked, and gives them all to the sentinel once they say so", async () => {
    const { core, jobs, told, sentinel, finish } = session({ sentinel: "ask" });
    const mine = await core.open();
    jobs.start(pulse("app pulse 1", "app"));
    await settled();
    jobs.start(pulse("web pulse 1", "web"));
    await settled();
    expect(told(mine.id).notices.map((notice) => [notice.kind, notice.summary])).toEqual([["sentinel-start", "app pulse 1 finished - start the sentinel?"]]);
    expect(told(mine.id).landed).toEqual([]);
    expect(sentinel()).toBeUndefined();
    expect(core.answer(told(mine.id).notices[0]!.id, { action: 0 })).toBe("done");
    await settled();
    expect(told(mine.id).acted).toEqual([]);
    // Each in turn, in a conversation of its own.
    expect(told(sentinel()!.id).briefs.map((brief) => brief.job)).toEqual(["app pulse 1"]);
    await finish();
    expect(told(sentinel()!.id).briefs.map((brief) => brief.job)).toEqual(["app pulse 1", "web pulse 1"]);
    await finish();
    // Started: the next pulse goes to it without asking.
    jobs.start(pulse("app pulse 2", "app"));
    await settled();
    expect(told(mine.id).notices).toHaveLength(1);
    expect(told(sentinel()!.id).briefs.map((brief) => brief.job)).toEqual(["app pulse 1", "web pulse 1", "app pulse 2"]);
  });

  it("puts the question again in the chat the person looks at when the chat it was in is closed", async () => {
    const { core, jobs, told } = session({ sentinel: "ask" });
    const first = await core.open();
    const second = await core.open();
    jobs.start(pulse("app pulse 1", "app"));
    await settled();
    expect(told(second.id).notices).toHaveLength(1);
    await core.close(second.id);
    expect(told(first.id).notices.map((notice) => notice.kind)).toEqual(["sentinel-start"]);
    expect(core.notices().map((notice) => notice.chat)).toEqual([first.id]);
  });

  it("tells the terminal how to switch to it - the chat it opens as, after those open", async () => {
    const { startTitle } = await import("../src/sentinel-chat.ts");
    const notice = { summary: "app pulse 1 finished - start the sentinel?" } as Notice;
    expect(startTitle(notice, 1)).toBe("app pulse 1 finished - start the sentinel?\nUse \"/chat 2\" to open the sentinel.");
  });

  it("does not ask when the sentinel is open already - reopened by turri --continue", async () => {
    const { core, jobs, told, sentinel } = session({ sentinel: "ask" });
    const mine = await core.open();
    await core.open({ hidden: true, role: SENTINEL });
    jobs.start(pulse("app pulse 1", "app"));
    await settled();
    expect(told(mine.id).notices).toEqual([]);
    expect(told(sentinel()!.id).briefs.map((brief) => brief.job)).toEqual(["app pulse 1"]);
  });
});

describe("the sentinel's conclusion", () => {
  it("is told to the chat the person looks at, all well or not - and to the host", async () => {
    const heard: string[] = [];
    const { core, jobs, told, links, sentinel } = session({ host: { onConcluded: (conclusion) => heard.push(`${conclusion.chat} ${conclusion.verdict}`) } });
    const first = await core.open();
    const second = await core.open();
    inChat(links[0]!.scope, () => jobs.start(pulse("app pulse 1", "app")));
    await settled();
    const job = jobs.list()[0]!.id;
    expect(core.concluded({ job, verdict: "holds", summary: "GET /ping answers pong" })).toBe(second.id);
    expect(told(second.id).concluded).toEqual(["app holds: GET /ping answers pong"]);
    // While the person looks at the sentinel: the chat that asked for the pulse.
    await core.show(sentinel()!.id);
    expect(core.concluded({ job, verdict: "wrong", summary: "the alias route answers 404" })).toBe(first.id);
    expect(heard).toEqual([`${second.id} holds`, `${first.id} wrong`]);
  });

  it("tells the chat to say what the sentinel found, and do nothing more", async () => {
    const { concludedNote } = await import("../src/sentinel.ts");
    expect(concludedNote({ job: "p1", verdict: "holds", summary: "GET /ping answers pong", module: "app", pulse: 2 })).toBe(
      "The sentinel is done with app pulse 2 (p1): it holds.\nGET /ping answers pong\n\nTell the person, in a line, that the sentinel checked it and it holds - and what it checked. Do nothing else about it.",
    );
  });
});

describe("a notice", () => {
  const input = (module = "app") => ({ severity: "error" as const, summary: "the sign-up page answers 500", evidence: ["POST /signup → 500"], actions: [{ label: "Regenerate fs 2 again", task: "regenerate app.plain fs 2 again" }], module });

  it("is put in the chat the person looks at - or, while they look at the sentinel, the chat that asked for its pulse", async () => {
    const { core, jobs, told, links, sentinel } = session();
    const first = await core.open();
    const second = await core.open();
    inChat(links[0]!.scope, () => jobs.start(pulse("app pulse 1", "app")));
    await settled();
    expect(core.notice({ ...input(), job: jobs.list()[0]!.id })?.chat).toBe(second.id);
    await core.show(sentinel()!.id);
    expect(core.notice({ ...input("web"), job: jobs.list()[0]!.id })?.chat).toBe(first.id);
    expect(told(first.id).notices.map((notice) => notice.summary)).toEqual(["the sign-up page answers 500"]);
  });

  it("is one open a module: a newer one supersedes it, and the host hears both", async () => {
    const heard: string[] = [];
    const { core, told } = session({ host: { onNotice: (notice) => heard.push(`put ${notice.id}`), onNoticeOver: (notice) => heard.push(`${notice.state} ${notice.id}`) } });
    const mine = await core.open();
    const older = core.notice(input())!;
    const newer = core.notice(input())!;
    const other = core.notice(input("web"))!;
    expect(core.notices().map((notice) => notice.id)).toEqual([newer.id, other.id]);
    expect(told(mine.id).over).toEqual([{ id: older.id, state: "superseded" }]);
    expect(heard).toEqual([`put ${older.id}`, `superseded ${older.id}`, `put ${newer.id}`, `put ${other.id}`]);
  });

  it("answered, starts the chat it is in on what was chosen - or on the person's own words - and dismissed, on nothing", async () => {
    const { core, told } = session();
    const mine = await core.open();
    const chosen = core.notice(input())!;
    expect(core.answer(chosen.id, { action: 0 })).toBe("done");
    expect(told(mine.id).acted[0]).toContain("The person chose: Regenerate fs 2 again. Do it now:\nregenerate app.plain fs 2 again");
    expect(core.answer(chosen.id, { action: 0 })).toBe("over");
    const steered = core.notice(input())!;
    core.answer(steered.id, { steer: "leave it, the page is not done yet" });
    expect(told(mine.id).acted[1]).toContain("The person answered it in their own words - do what they say:\nleave it, the page is not done yet");
    const dismissed = core.notice(input())!;
    expect(core.answer(dismissed.id, { dismiss: true })).toBe("dismissed");
    expect(told(mine.id).acted).toHaveLength(2);
    expect(core.answer("nope", { dismiss: true })).toBe("missing");
  });

  it("refuses to be ignored when it is not ignorable - left open, nothing kept", async () => {
    const kept: string[] = [];
    const { core } = session({ ignored: (notice) => void kept.push(notice.id) });
    await core.open();
    const broken = core.notice(input())!;
    expect(core.answer(broken.id, { ignore: true })).toBe("refused");
    expect(core.notices().map((notice) => notice.id)).toEqual([broken.id]);
    expect(kept).toEqual([]);
  });

  it("is never ignorable when it asks whether to start the sentinel", async () => {
    const { core } = session();
    await core.open();
    const question = core.notice({ ...input(), kind: "sentinel-start", ignorable: true })!;
    expect(question.ignorable).toBeUndefined();
    expect(core.answer(question.id, { ignore: true })).toBe("refused");
  });

  it("ignored, does nothing in the chat and ends as ignored - kept for the sentinel", async () => {
    const kept: string[] = [];
    const { core, told } = session({ ignored: (notice) => void kept.push(notice.id) });
    const mine = await core.open();
    const gap = core.notice({ ...input(), ignorable: true })!;
    expect(core.answer(gap.id, { ignore: true })).toBe("ignored");
    expect(told(mine.id).acted).toEqual([]);
    expect(told(mine.id).over).toEqual([{ id: gap.id, state: "ignored" }]);
    expect(core.notices()).toEqual([]);
    expect(kept).toEqual([gap.id]);
  });

  it("of a fix the sentinel made is a note: it supersedes no notice about its module, and asks nothing", async () => {
    const { core, told } = session();
    const mine = await core.open();
    const problem = core.notice({ severity: "error", summary: "GET / answers 500", evidence: [], actions: [{ label: "Regenerate", task: "regenerate app.plain" }], module: "app" })!;
    const fixed = core.notice({ kind: "fixed", severity: "info", summary: "the unit testing script runs python, not python3", evidence: ["- python3 -m pytest", "+ python -m pytest"], actions: [], module: "app" })!;
    expect(core.notices().map((notice) => notice.id)).toEqual([problem.id, fixed.id]);
    expect(told(mine.id).notices.map((notice) => notice.kind)).toEqual([undefined, "fixed"]);
    expect(told(mine.id).over).toEqual([]);
  });

  it("says what is wrong, what shows it and what can be done, for an agent", () => {
    const notice = { severity: "warning" as const, summary: "the page loads slowly", evidence: ["GET / took 9s"], actions: [{ label: "Add a cache", task: "…" }] };
    expect(describeNotice(notice)).toBe("! the page loads slowly\n  GET / took 9s\nWhat can be done:\n  1. Add a cache");
    expect(noticeTask({ ...notice, id: "n1", chat: "c1", state: "open", at: "" }, { dismiss: true })).toBeUndefined();
  });
});

describe("what the sentinel is told of a pulse", () => {
  const job = (details: unknown) =>
    ({ id: "p1", kind: "regenerate", summary: "x", module: "app", pulse: 2, status: "succeeded", sequence: 1, queuedAt: 0, startedAt: 0, finishedAt: 2000, report: "landed fs 2", details, waitingOn: [], tail: "", activity: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, agents: [], transcript: [] }) as unknown as Job;

  const launched = { id: "launch-3", codebase: "app", moduleDir: "/p/plain_modules/app", plainFile: "/p/app.plain", commit: "fffeeee", short: "fffeeee", hostDir: "/p", cause: { pulse: "p3", title: "x" }, status: "launched", queuedAt: 0 } as const;
  const server = { name: "app", moduleName: "app", command: "npm start", dir: "/p/dist/app", url: "http://localhost:3000", log: "/p/.turri/launch/app.log", pid: 1, startedAt: 0 };

  it("names the launch that holds its commit, the pulses after it that it holds too, where it runs - and what to test", () => {
    const later = { ...job({ passed: true, landed: true }), id: "p3", pulse: 3 } as Job;
    const text = sentinelBrief(job({ passed: true, landed: true }), {
      project: process.cwd(),
      focused: "new chat",
      launch: { commit: "abcdef1234", launch: launched as never, later: [later], laterSpecs: [{ module: "app", funcId: "greet" }], running: [server] },
      reaction: "",
    });
    expect(text).toContain("app · regenerate pulse 2 - finished, and landed what it built");
    expect(text).toContain("Its commit is abcdef1. It was launched in the background (launch-after-pulse): what runs is app at fffeeee (launch-3), which holds it and the pulses that landed after it - p3 (app · regenerate pulse 3).");
    expect(text).toContain("app: http://localhost:3000 - in /p/dist/app, its output in /p/.turri/launch/app.log");
    expect(text).toContain("Test what this pulse changed - but not app:greet: a later pulse changed it again, and its check tests it.");
    expect(text).toContain("When you are done with it, call conclude for p1 - whether all is well or not.");
  });

  it("names where to try it from when its launch left nothing running, and never plain_modules nor a server of its own", () => {
    const text = sentinelBrief(job({ passed: true, landed: true }), {
      project: process.cwd(),
      launch: { commit: "abcdef1234", launch: { ...launched, code: { dir: "/p/dist/app" } } as never, later: [], laterSpecs: [], running: [] },
      reaction: "",
    });
    expect(text).toContain("What runs now:\n  nothing is left running. It is in place in /p/dist/app: try it from there - a CLI or a library as its README and entry points say.");
    expect(text).toContain("Never run the code in plain_modules, where a pulse may be writing, nor start a server of your own - not in your shell, not with a host's terminal");
    expect(text).toContain("A server that should run and does not is your finding.");
    expect(text).not.toContain("a CLI or a library is tried from its folder");
  });

  it("says the rule against plain_modules and a server of its own whatever was launched - off, stopped, not asked for, failed", () => {
    const base = { commit: "abcdef1234", later: [], laterSpecs: [], running: [] };
    for (const launch of [
      { ...base, off: true },
      { ...base, stopped: true },
      { ...base, notAsked: "no module to launch" },
      { ...base, launch: { ...launched, status: "failed", summary: "port 8000 is held by PID 66816" } as never },
      { ...base, launch: launched as never },
    ]) {
      expect(sentinelBrief(job({ passed: true, landed: true }), { project: process.cwd(), launch, reaction: "" })).toContain(LAUNCHED_ONLY);
    }
  });

  it("tells a launch that did not come up as what to find out about", () => {
    const text = sentinelBrief(job({ passed: true, landed: true }), {
      project: process.cwd(),
      launch: { commit: "abcdef1234", launch: { ...launched, status: "failed", summary: "port 3000 is taken by another app" } as never, later: [], laterSpecs: [], running: [] },
      reaction: "",
    });
    expect(text).toContain("That launch did not come up: port 3000 is taken by another app");
    expect(text).toContain("That is what you find out about: the launch did not come up.");
  });

  it("says nothing is running to test when launch-after-pulse is off", () => {
    const text = sentinelBrief(job({ passed: true, landed: true }), { project: process.cwd(), launch: { commit: "abcdef1234", off: true, later: [], laterSpecs: [], running: [] }, reaction: "" });
    expect(text).toContain("launch-after-pulse is off: nothing was launched, and you test nothing running - check the pulse alone.");
  });

  it("asks it to find out why one went wrong, with what the chat would have done as a notice's actions", () => {
    const failed = { ...job({}), status: "failed", error: "the unit tests failed" } as Job;
    const text = sentinelBrief(failed, { project: process.cwd(), launch: { later: [], laterSpecs: [], running: [] }, reaction: "heal it, then resume" });
    expect(text).toContain("failed");
    expect(text).toContain("the unit tests failed");
    expect(text).toContain("It went wrong: find out why. A testing script, or where the config says the scripts are, is yours to fix");
    expect(text).toContain("install is never anyone's but the person's");
    expect(text).toContain("heal it, then resume");
  });
});

describe("what the person's chat is told of a pulse that landed", () => {
  it("says it landed and what the sentinel does with it - and to tell the person, and do nothing else", async () => {
    const { landedNote } = await import("../src/sentinel.ts");
    const job = { id: "p1", kind: "regenerate", summary: "x", module: "app", pulse: 2, status: "succeeded", startedAt: 0, finishedAt: 2000, report: "landed fs 2", details: { passed: true, landed: true } } as unknown as Job;
    const text = landedNote(job, { launching: true });
    expect(text).toContain("Pulse p1 - app · regenerate pulse 2 - landed");
    expect(text).toContain("It is being launched in the background, and the sentinel - a chat of my own beside this one - checks it and tests what runs once it is up.");
    expect(text).toContain("Do nothing else about it: the pulse is the sentinel's now.");
    expect(text).toContain("Do not test it, launch it, open it");
  });
});

describe("the sentinel's tools", () => {
  it("read the whole project, and write and edit its tooling alone - never ***plain, and none that regenerates, steers or launches", () => {
    const names = sentinelFileTools(mkdtempSync(join(tmpdir(), "turri-sentinel-tools-"))).map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(["read", "ls", "grep", "find", "bash", "write", "edit"]));
    for (const name of names) expect(SENTINEL_TOOLS, name).toContain(name);
    expect(SENTINEL_TOOLS).toContain("resume");
    for (const name of ["regenerate", "launch", "activate", "conform", "stop_launched"]) expect(SENTINEL_TOOLS).not.toContain(name);
  });

  it("say what holds a port and whose it is - its shell sees no other process - and stop nothing", async () => {
    const holder = createServer();
    await new Promise<void>((done) => holder.listen(0, "127.0.0.1", () => done()));
    const port = (holder.address() as { port: number }).port;
    try {
      const tool = whoHoldsTool(mkdtempSync(join(tmpdir(), "turri-sentinel-holds-")));
      expect(SENTINEL_TOOLS).toContain(tool.name);
      const held = await tool.execute("t", { port }, undefined, undefined, undefined as never);
      expect(held.content[0]!.text).toContain(`Port ${port} is held by:\n- pid ${process.pid} (`);
      expect(held.content[0]!.text).toContain("which turri did not start");
    } finally {
      await new Promise((done) => holder.close(done));
    }
    const free = await whoHoldsTool(mkdtempSync(join(tmpdir(), "turri-sentinel-holds-"))).execute("t", { port }, undefined, undefined, undefined as never);
    expect(free.content[0]!.text).toBe(`Nothing listens on port ${port}.`);
  });

  it("fix a testing script and where the config says the scripts are - and put back any other change to the config, and refuse ***plain", async () => {
    const project = mkdtempSync(join(tmpdir(), "turri-sentinel-fix-"));
    mkdirSync(join(project, "test_scripts"));
    writeFileSync(join(project, "test_scripts", "run_unittests_python.sh"), "#!/bin/bash\npython3 -m pytest\n");
    writeFileSync(join(project, "run_conformance_tests_python.sh"), "#!/bin/bash\npython3 -m pytest tests\n");
    writeFileSync(join(project, "config.turri.yaml"), "harness-model: anthropic/claude-opus-5-5\nunittests-script: test_scripts/run_unittests_python.sh\n");
    writeFileSync(join(project, "app.plain"), "***functional specs***\n\n# hello\nSay hello.\n");
    const tool = (name: string) => sentinelFileTools(project).find((each) => each.name === name) as unknown as { execute: (...args: unknown[]) => Promise<unknown> };
    const edit = (path: string, oldText: string, newText: string) => tool("edit").execute("call", { path, edits: [{ oldText, newText }] }, undefined, undefined, {});

    await edit("test_scripts/run_unittests_python.sh", "python3 -m pytest", "python -m pytest");
    expect(readFileSync(join(project, "test_scripts", "run_unittests_python.sh"), "utf8")).toContain("python -m pytest");
    await edit("run_conformance_tests_python.sh", "python3", "python");
    await edit("config.turri.yaml", "unittests-script: test_scripts/run_unittests_python.sh", "unittests-script: test_scripts/run_unittests_python.sh\ntoolchains: [/opt/python]");
    expect(readFileSync(join(project, "config.turri.yaml"), "utf8")).toContain("toolchains: [/opt/python]");

    // Another setting: put back, and said why.
    const config = readFileSync(join(project, "config.turri.yaml"), "utf8");
    await expect(edit("config.turri.yaml", "anthropic/claude-opus-5-5", "anthropic/claude-haiku-5-5")).rejects.toThrow(/changes only unittests-script, .* not harness-model/);
    expect(readFileSync(join(project, "config.turri.yaml"), "utf8")).toBe(config);
    // The ***plain is the person's.
    await expect(edit("app.plain", "Say hello.", "Say hi.")).rejects.toThrow(/outside this agent's write directory/);
    await expect(tool("write").execute("call", { path: "notes.md", content: "x" }, undefined, undefined, {})).rejects.toThrow(/outside this agent's write directory/);
    expect(readFileSync(join(project, "app.plain"), "utf8")).toContain("Say hello.");
  });
});

describe("a check a host asks of the sentinel", () => {
  /** A check of app's functional specs, as sentinel-check.ts makes one once it finds them good. */
  const asked = (id: string, funcIds = ["add-task"]): SentinelCheck => ({ id, module: "app", plainFile: "/project/app.plain", funcIds, at: "" });

  it("waits its turn behind the pulse the sentinel is on, then is taken in a conversation of its own", async () => {
    const { core, jobs, told, sentinel, finish, history } = session();
    const mine = await core.open();
    jobs.start(pulse("app pulse 1", "app"));
    await settled();
    expect(core.check(() => asked("c1"))).toEqual({ check: "c1" });
    await settled();
    expect(told(sentinel()!.id).checks).toEqual([]);
    await finish();
    expect(told(sentinel()!.id).checks).toEqual([{ check: "c1", focused: "new chat" }]);
    // A new session for it, the pulse's stopped and let go.
    const [first, second] = history.get(sentinel()!.id)!;
    expect(second!.messages).toEqual([{ role: "custom", customType: "turri_sentinel_check", details: { checkId: "c1" } }]);
    expect(first!.state.disposed).toBe(true);
    // A pulse that finishes while it is checked waits for it: a check is not replaced by a pulse of its module.
    jobs.start(pulse("app pulse 2", "app"));
    await settled();
    expect(told(sentinel()!.id).briefs.map((brief) => brief.job)).toEqual(["app pulse 1"]);
    await finish();
    expect(told(sentinel()!.id).briefs.map((brief) => brief.job)).toEqual(["app pulse 1", "app pulse 2"]);
    expect(told(mine.id).concluded).toEqual([]);
  });

  it("is concluded - the check's id in place of a pulse's - when the sentinel says so, to the chat the person looks at and the host", async () => {
    const heard: Array<{ check?: string; job?: string; module?: string; verdict: string }> = [];
    const { core, told } = session({ host: { onConcluded: ({ check, job, module, verdict }) => heard.push({ check, job, module, verdict }) } });
    const mine = await core.open();
    core.check(() => asked("c1"));
    await settled();
    expect(core.concluded({ check: "c1", verdict: "holds", summary: "adding a task lists it" })).toBe(mine.id);
    expect(told(mine.id).concluded).toEqual(["check c1 app holds: adding a task lists it"]);
    expect(heard).toEqual([{ check: "c1", job: undefined, module: "app", verdict: "holds" }]);
  });

  it("puts a notice about it under its module", async () => {
    const { core, told } = session();
    const mine = await core.open();
    core.check(() => asked("c1"));
    await settled();
    core.notice({ severity: "error", summary: "adding a task loses it", evidence: [], actions: [], check: "c1" });
    expect(told(mine.id).notices).toMatchObject([{ module: "app", check: "c1" }]);
  });

  it("ends as unchecked, said as a conclusion alone - no error notice - when nothing of its module is launched; the sentinel told nothing, and the next work taken", async () => {
    const { core, told, sentinel } = session({
      launches: {
        readyFor: async () => {},
        readyForCheck: async (check) => {
          if (check.id === "c1") throw new Error("nothing of app is launched to test it in - ask the chat to try it first, which launches it.");
        },
        settled: async () => {},
      },
    });
    const notified = vi.spyOn(core, "notify");
    const mine = await core.open();
    core.check(() => asked("c1"));
    core.check(() => asked("c2"));
    await settled();
    expect(told(mine.id).concluded).toEqual(["check c1 app unchecked: Not checked: nothing of app is launched to test it in - ask the chat to try it first, which launches it."]);
    expect(notified).not.toHaveBeenCalled();
    expect(told(sentinel()!.id).checks.map((check) => check.check)).toEqual(["c2"]);
  });

  it("is refused while the sentinel is off - what is asked not even looked at - and refused as the host's prepare says", async () => {
    let prepared = 0;
    const off = session({ sentinel: false });
    await off.core.open();
    expect(off.core.check(() => (prepared++, asked("c1")))).toEqual({ refused: expect.stringContaining("sentinel: false") });
    expect(prepared).toBe(0);
    const on = session();
    await on.core.open();
    expect(on.core.check(() => ({ refused: "app has no functional spec nope." }))).toEqual({ refused: "app has no functional spec nope." });
    await settled();
    expect(on.sentinel()).toBeUndefined();
  });

  it("asks first under sentinel: ask - checked once the person starts it, ended as unchecked when they say not now", async () => {
    const started = session({ sentinel: "ask" });
    const mine = await started.core.open();
    expect(started.core.check(() => asked("c1"))).toEqual({ check: "c1" });
    await settled();
    expect(started.told(mine.id).notices.map((notice) => [notice.kind, notice.check])).toEqual([["sentinel-start", "c1"]]);
    expect(started.sentinel()).toBeUndefined();
    started.core.answer(started.told(mine.id).notices[0]!.id, { action: 0 });
    await settled();
    expect(started.told(started.sentinel()!.id).checks.map((check) => check.check)).toEqual(["c1"]);

    const declined = session({ sentinel: "ask" });
    const theirs = await declined.core.open();
    declined.core.check(() => asked("c1"));
    await settled();
    declined.core.answer(declined.told(theirs.id).notices[0]!.id, { action: "Not this session" });
    await settled();
    expect(declined.told(theirs.id).concluded).toEqual(["check c1 app unchecked: Not checked: the person did not start the sentinel."]);
    // Not now holds for the session: the next is refused.
    expect(declined.core.check(() => asked("c2"))).toEqual({ refused: expect.stringContaining("not started this session") });
  });

  it("ends as unchecked when the sentinel is closed before it gets to it", async () => {
    const { core, jobs, told, sentinel } = session();
    const mine = await core.open();
    jobs.start(pulse("app pulse 1", "app"));
    await settled();
    core.check(() => asked("c1"));
    await settled();
    await core.close(sentinel()!.id);
    expect(told(mine.id).concluded).toEqual(["check c1 app unchecked: Not checked: the sentinel was closed before it got to it."]);
  });
});

describe("what the sentinel is told of a check", () => {
  it("says the module's last launch did not come up - what to find out about, and nothing to test in its place", () => {
    const brief = sentinelCheckBrief(
      { id: "c2", module: "app", plainFile: "/p/app.plain", funcIds: ["app:add-task"], at: "" },
      { specs: [{ funcId: "app:add-task", text: "Adding a task lists it.", conformance: [], acceptance: [] }], running: [], commit: "abc1234", failed: { id: "launch-2", summary: "port 8080 is taken" } },
    );
    expect(brief).toContain("Its last launch, launch-2, did not come up: port 8080 is taken");
    expect(brief).toContain("Test nothing in its place.");
    expect(brief).toContain(LAUNCHED_ONLY);
    expect(brief).not.toContain("What runs now:");
    expect(brief).not.toContain("nothing is left running");
  });

  it("names the folder to try it from when its launch left nothing running - and never plain_modules, nor a server of its own", () => {
    const brief = sentinelCheckBrief(
      { id: "c3", module: "app", plainFile: "/p/app.plain", funcIds: ["app:add-task"], at: "" },
      { specs: [{ funcId: "app:add-task", text: "Adding a task lists it.", conformance: [], acceptance: [] }], running: [], commit: "abc1234", dir: "/p/dist/app" },
    );
    expect(brief).toContain("What runs now:\n  nothing is left running. It is in place in /p/dist/app: try it from there");
    expect(brief).toContain("Something there that should serve and does not is what you find out about.");
    expect(brief).toContain(LAUNCHED_ONLY);
  });

  it("names its functional specs - what each says and its scenarios - to test those alone, in what runs, and to conclude for the check", () => {
    const brief = sentinelCheckBrief(
      { id: "c1", module: "app", plainFile: "/p/app.plain", funcIds: ["app:add-task", "base:login"], at: "" },
      {
        specs: [
          { funcId: "app:add-task", text: "Adding a :Task: lists it.", conformance: [{ id: "lists-it", text: "Add one; it is listed." }], acceptance: [] },
          { funcId: "base:login", text: "A :User: logs in.", conformance: [], acceptance: [{ id: "logs-in", text: "Log in;\nthe home page shows." }] },
        ],
        running: [{ name: "web", moduleName: "app", command: "npm run dev", dir: "/p/dist/app", url: "http://localhost:5173", log: "/p/web.log", pid: 1, startedAt: 0 }],
        commit: "abc1234",
        focused: "my chat",
      },
    );
    expect(brief).toContain("Check c1: the person asked you to check 2 functional specs of app, in what is launched of it.");
    expect(brief).toContain("at its commit abc1234");
    expect(brief).toContain("What runs now:\n  web: http://localhost:5173 - in /p/dist/app, its output in /p/web.log");
    expect(brief).toContain("only these, not its others");
    expect(brief).toContain("# app:add-task\nAdding a :Task: lists it.\nConformance scenarios:\n- lists-it: Add one; it is listed.");
    expect(brief).toContain("# base:login\nA :User: logs in.\nAcceptance scenarios:\n- logs-in: Log in; the home page shows.");
    expect(brief).toContain("call conclude for check c1");
  });
});

describe("the sentinel's resume", () => {
  it("brings the module it names up again - after a fix of its own - and says what was started", async () => {
    const { resumeTool } = await import("../src/sentinel.ts");
    const asked: string[] = [];
    const tool = resumeTool(async (plainFile) => (asked.push(plainFile), "app: 1 pulse planned")) as unknown as { execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }> };
    const result = await tool.execute("call", { plain_file: "app.plain" }, undefined, undefined, {});
    expect(asked).toEqual(["app.plain"]);
    expect(result.content[0]!.text).toBe("app: 1 pulse planned");
  });
});

describe("how the sentinel tests what is launched", () => {
  it("tries, where the ***plain picks one way among several, an input on which the ways differ - not a tie that is also alphabetical", () => {
    const prompt = sentinelPrompt(mkdtempSync(join(tmpdir(), "turri-sentinel-prompt-")));
    expect(prompt).toContain("try an input on which the ways give");
    expect(prompt).toContain('a tie whose first word is also first');
    // Its shell writes $TMPDIR, not /tmp: told up front, not by a refused command.
    expect(prompt).toContain("the files you try a launch with go in $TMPDIR - /tmp is outside what it may write");
  });
});
