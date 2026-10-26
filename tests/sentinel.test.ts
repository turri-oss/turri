import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { inChat } from "../src/chat-scope.ts";
import { createChats, MAX_CHATS, type ChatLink, type TurriCore, type TurriHost } from "../src/chats.ts";
import { createJobRegistry, type Job } from "../src/regenerate/jobs.ts";
import { describeNotice, noticeTask, SENTINEL, SENTINEL_TOOLS, sentinelBrief, sentinelFileTools, type Notice } from "../src/sentinel.ts";

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
}

/** A session with the sentinel on, its chats living nowhere but here: each chat's extension says what it is told. */
function session(options: { sentinel?: boolean | "ask"; host?: TurriHost; ignored?: (notice: Notice) => void } = {}) {
  const told = new Map<string, Told>();
  const links: ChatLink[] = [];
  /** Each chat's session now - and every session each chat had, in order. */
  const sessions = new Map<string, ReturnType<typeof fakeSession>>();
  const history = new Map<string, Array<ReturnType<typeof fakeSession>>>();
  const shownBy: string[] = [];
  let core: TurriCore;
  const jobs = createJobRegistry({ onFinish: (job) => core.jobFinished(job) });
  const of = (id: string): Told => {
    if (!told.has(id)) told.set(id, { announced: [], landed: [], briefs: [], notices: [], over: [], acted: [], concluded: [] });
    return told.get(id)!;
  };
  core = createChats({
    cwd: process.cwd(),
    host: options.host ?? {},
    jobs,
    sentinel: () => options.sentinel ?? true,
    ...(options.ignored !== undefined ? { ignored: options.ignored } : {}),
    sentinelStart: (job) => ({ severity: "info", summary: `${job.summary} finished - start the sentinel?`, evidence: [], actions: [{ label: "Start the sentinel", task: "" }, { label: "Not this session", task: "" }], job: job.id }),
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
        notice: (notice) => of(link.id).notices.push(notice),
        noticeOver: (notice) => of(link.id).over.push({ id: notice.id, state: notice.state }),
        act: (task) => of(link.id).acted.push(task),
        concluded: (conclusion) => of(link.id).concluded.push(`${conclusion.module} ${conclusion.verdict}: ${conclusion.summary}`),
        jobsChanged: () => {},
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
    made.emit("agent_end");
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

  it("leaves a check of a module's pulse that went well for the module's next, but looks into one that went wrong to its end", async () => {
    const { core, jobs, told, history, sentinel, finish } = session();
    await core.open();
    jobs.start(pulse("app pulse 1", "app"));
    await settled();
    const id = sentinel()!.id;
    // A newer pulse of the module: the check of the one that went well stopped, the newer checked afresh at once.
    jobs.start(pulse("app pulse 2", "app"));
    await settled();
    expect(history.get(id)![0]!.state).toMatchObject({ aborted: 1, disposed: true });
    // Pulses of another module wait - a newer one of it taking the place of one that went well and waits.
    jobs.start(pulse("web pulse 1", "web"));
    await settled();
    jobs.start(pulse("web pulse 2", "web"));
    await settled();
    // One that went wrong replaces the check of one that went well - and is looked into to its end.
    jobs.start(pulse("app pulse 3", "app", "fails"));
    await settled();
    jobs.start(pulse("app pulse 4", "app"));
    await settled();
    expect(told(id).briefs.map((brief) => brief.job)).toEqual(["app pulse 1", "app pulse 2", "app pulse 3"]);
    await finish();
    await finish();
    expect(told(id).briefs.map((brief) => brief.job)).toEqual(["app pulse 1", "app pulse 2", "app pulse 3", "web pulse 2", "app pulse 4"]);
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

  it("says what is wrong, what shows it and what can be done, for an agent", () => {
    const notice = { severity: "warning" as const, summary: "the page loads slowly", evidence: ["GET / took 9s"], actions: [{ label: "Add a cache", task: "…" }] };
    expect(describeNotice(notice)).toBe("! the page loads slowly\n  GET / took 9s\nWhat can be done:\n  1. Add a cache");
    expect(noticeTask({ ...notice, id: "n1", chat: "c1", state: "open", at: "" }, { dismiss: true })).toBeUndefined();
  });
});

describe("what the sentinel is told of a pulse", () => {
  const job = (details: unknown) =>
    ({ id: "p1", kind: "regenerate", summary: "x", module: "app", pulse: 2, status: "succeeded", sequence: 1, queuedAt: 0, startedAt: 0, finishedAt: 2000, report: "landed fs 2", details, waitingOn: [], tail: "", activity: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, agents: [], transcript: [] }) as unknown as Job;

  it("names what was released and where it runs, to test", () => {
    const text = sentinelBrief(job({ passed: true, released: true }), {
      project: process.cwd(),
      focused: "new chat",
      released: [{ name: "app", moduleName: "app", command: "npm start", dir: "/p/dist/app", url: "http://localhost:3000", log: "/p/.turri/deploy/app.log", pid: 1, startedAt: 0 }],
      releaseAfterPulse: true,
      reaction: "",
    });
    expect(text).toContain("app · regenerate pulse 2 - finished, and landed what it built");
    expect(text).toContain("app: http://localhost:3000 - in /p/dist/app, its output in /p/.turri/deploy/app.log");
    expect(text).toContain("Test it.");
    expect(text).toContain("When you are done with it, call conclude for p1 - whether all is well or not.");
  });

  it("says nothing is running to test when release-after-pulse is off", () => {
    const text = sentinelBrief(job({ passed: true }), { project: process.cwd(), released: [], releaseAfterPulse: false, reaction: "" });
    expect(text).toContain("release-after-pulse is off: nothing was released, and you test nothing running - check the pulse alone.");
  });

  it("asks it to find out why one went wrong, with what the chat would have done as a notice's actions", () => {
    const failed = { ...job({}), status: "failed", error: "the unit tests failed" } as Job;
    const text = sentinelBrief(failed, { project: process.cwd(), released: [], releaseAfterPulse: true, reaction: "heal it, then resume" });
    expect(text).toContain("failed");
    expect(text).toContain("the unit tests failed");
    expect(text).toContain("It went wrong: find out why, and notify the person.");
    expect(text).toContain("heal it, then resume");
  });
});

describe("what the person's chat is told of a pulse that landed", () => {
  it("says it landed and what the sentinel does with it - and to tell the person, and do nothing else", async () => {
    const { landedNote } = await import("../src/sentinel.ts");
    const job = { id: "p1", kind: "regenerate", summary: "x", module: "app", pulse: 2, status: "succeeded", startedAt: 0, finishedAt: 2000, report: "landed fs 2", details: { passed: true, released: true } } as unknown as Job;
    const text = landedNote(job, [{ name: "app", moduleName: "app", command: "npm start", dir: "/p/dist/app", url: "http://localhost:3000", log: "/p/log", pid: 1, startedAt: 0 }]);
    expect(text).toContain("Pulse p1 - app · regenerate pulse 2 - landed");
    expect(text).toContain("is checking it now, and testing what was released (app at http://localhost:3000)");
    expect(text).toContain("Do nothing else about it: the pulse is the sentinel's now.");
  });
});

describe("the sentinel's tools", () => {
  it("read the project and write nothing: no write, no edit - only what reads, its shell among them", () => {
    const names = sentinelFileTools(mkdtempSync(join(tmpdir(), "turri-sentinel-tools-"))).map((tool) => tool.name);
    expect(names).not.toContain("write");
    expect(names).not.toContain("edit");
    expect(names).toEqual(expect.arrayContaining(["read", "ls", "grep", "find", "bash"]));
    for (const name of names) expect(SENTINEL_TOOLS, name).toContain(name);
    for (const name of ["change_plain", "regenerate", "steer", "release", "activate", "write", "edit"]) expect(SENTINEL_TOOLS).not.toContain(name);
  });
});
