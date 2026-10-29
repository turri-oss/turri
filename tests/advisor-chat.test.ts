import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdvisorVerdict } from "../src/regenerate/advisor-runs.ts";

/** A tool or an event handler turri registered in a chat. */
type Handler = (event: unknown, ctx: unknown) => unknown;

/** What a chat's session was sent, with how. */
type Sent = { customType: string; content: string; display: boolean; options?: { triggerTurn?: boolean; deliverAs?: string } };

/** A chat's session: what turri sent it, the entries it drew in it, its handlers, and the session itself. */
type Session = { sent: Sent[]; entries: Array<{ type: string; data: unknown }>; handlers: Map<string, Handler[]>; tools: string[]; session: { isStreaming: boolean } };

const sessions: Session[] = [];

// A host's chats on pi sessions that run nothing, as tests/host-sentinel.test.ts has them: what turri sends each is kept.
vi.mock("@earendil-works/pi-coding-agent", async (actual) => {
  const pi = await actual<typeof import("@earendil-works/pi-coding-agent")>();
  class DefaultResourceLoader {
    factories: Array<(api: unknown) => void>;
    constructor(options: { extensionFactories: Array<(api: unknown) => void> }) {
      this.factories = options.extensionFactories;
    }
    async reload() {}
  }
  return {
    ...pi,
    DefaultResourceLoader,
    SessionManager: { create: () => ({}), open: () => ({}) },
    createAgentSession: async ({ resourceLoader }: { resourceLoader: DefaultResourceLoader }) => {
      const session = {
        isStreaming: false,
        isCompacting: false,
        isRetrying: false,
        isBashRunning: false,
        sessionFile: undefined,
        messages: [],
        sessionManager: { getSessionName: () => undefined },
        extensionRunner: { getUIContext: () => undefined },
        subscribe: () => () => {},
        bindExtensions: async () => {},
        abort: async () => {},
        abortBash: () => {},
        dispose: () => {},
      };
      const state: Session = { sent: [], entries: [], handlers: new Map(), tools: [], session };
      sessions.push(state);
      const api = new Proxy(
        {},
        {
          get: (_target, key) =>
            key === "sendMessage"
              ? (message: Omit<Sent, "options">, options?: Sent["options"]) => state.sent.push({ ...message, ...(options !== undefined ? { options } : {}) })
              : key === "appendEntry"
                ? (type: string, data: unknown) => state.entries.push({ type, data })
                : key === "on"
                  ? (event: string, handler: Handler) => state.handlers.set(event, [...(state.handlers.get(event) ?? []), handler])
                  : key === "getAllTools"
                    ? () => []
                    : key === "registerTool"
                      ? (tool: { name: string }) => state.tools.push(tool.name)
                      : () => undefined,
        },
      );
      for (const factory of resourceLoader.factories) factory(api);
      return { session };
    },
  };
});

/** What the session's advisor was made with: its verdicts are handed on by hand, as the advisor hands them on. */
let made: { onVerdict?: (verdict: AdvisorVerdict) => void } | undefined;
/** What a host asked the advisor to evaluate. */
const evaluated: Array<{ module: string; funcId: string; reason?: string }> = [];

vi.mock("../src/regenerate/advisor-runs.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/regenerate/advisor-runs.ts")>();
  return {
    ...actual,
    createTestAdvisor: (options: { onVerdict?: (verdict: AdvisorVerdict) => void }) => {
      made = options;
      return { seen() {}, resume() {}, idle: async () => {}, stop() {}, taking: () => [], evaluate: (asked: { module: string; funcId: string; reason?: string }) => (evaluated.push(asked), asked.funcId === "no-such-thing" ? ("missing" as const) : ("started" as const)) };
    },
  };
});

const { createTurri } = await import("../src/host-session.ts");
const { ADVISOR_RECHECK_MS, noLine, TEST_ADVISOR_BLOCK, yesLine, yesTask } = await import("../src/advisor-chat.ts");

const anything: unknown = new Proxy(() => undefined, {
  get: (_target, key) => (key === "then" || typeof key === "symbol" ? undefined : anything),
  apply: () => anything,
});

/** A chat's context as its handlers get it: what is given, and anything else as it comes. */
function contextWith(given: Record<string, unknown>): unknown {
  return new Proxy(given, { get: (target, key) => (key in target ? target[key as string] : key === "then" || typeof key === "symbol" ? undefined : anything) });
}

/** The system prompt a session's agent is given, as its before_agent_start handlers leave it - with the context they are given. */
async function systemPrompt(session: Session, ctx: unknown = anything): Promise<string> {
  let prompt = "pi's own";
  for (const handler of session.handlers.get("before_agent_start") ?? []) {
    const result = (await handler({ type: "before_agent_start", prompt: "hi", systemPrompt: prompt, systemPromptOptions: { skills: [] } }, ctx)) as { systemPrompt?: string } | undefined;
    if (result?.systemPrompt !== undefined) prompt = result.systemPrompt;
  }
  return prompt;
}

/** A chat's agent done: its agent_settled handlers run. */
async function settled(session: Session): Promise<void> {
  for (const handler of session.handlers.get("agent_settled") ?? []) await handler({ type: "agent_settled", aborted: false }, anything);
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

/** A verdict as the advisor hands it on, with what was done with it. */
function verdict(funcId: string, yes: boolean, current = true): AdvisorVerdict & { told: number } {
  const made = {
    project: process.cwd(),
    module: "core",
    funcId,
    plainFile: join(process.cwd(), "core.plain"),
    tip: join(process.cwd(), "core.plain"),
    testFile: join("tests", "core", `${funcId}.plain`),
    hash: "h",
    report: yes
      ? {
          verdict: "yes" as const,
          questions: [{ question: "silent-failure" as const, evidence: "Clearing two tasks leaves one." }, { question: "revisited" as const, evidence: "Undo later." }],
          inputs: [{ input: "clear with 2 tasks", agreed: "No tasks." }, { input: "clear with 0 tasks", readings: ["No tasks.", "An error: nothing to clear."] }],
        }
      : { verdict: "no" as const, questions: [], inputs: [] },
    told: 0,
    current: () => current,
    delivered: () => {
      made.told += 1;
    },
  };
  return made;
}

describe("the test advisor's verdicts in a host's chat", () => {
  const cwd = process.cwd();
  beforeEach(() => {
    sessions.length = 0;
    made = undefined;
    process.chdir(mkdtempSync(join(tmpdir(), "turri-advisor-chat-")));
    writeFileSync("config.turri.yaml", "sentinel: false\n");
  });
  afterEach(() => {
    vi.useRealTimers();
    process.chdir(cwd);
  });

  it("starts one turn in the chat the person looks at for a yes, with the report and what to write", async () => {
    const turri = await createTurri();
    await turri.openChat();
    const mine = await turri.openChat();
    turri.focus(mine.id);
    const yes = verdict("clear-tasks", true);
    made!.onVerdict!(yes);
    await settle();
    expect(sessions[0]!.sent).toEqual([]);
    expect(sessions[1]!.sent).toHaveLength(1);
    const sent = sessions[1]!.sent[0]!;
    expect(sent).toMatchObject({ customType: "turri_advisor_verdict", display: false, options: { triggerTurn: true, deliverAs: "followUp" } });
    expect(sent.content).toBe(yesTask([yes]));
    expect(sent.content).toContain("- silent-failure: Clearing two tasks leaves one.");
    expect(sent.content).toContain("1. input: clear with 2 tasks - agreed output: No tasks.");
    expect(sent.content).toContain("2. input: clear with 0 tasks - split: (1) No tasks.; (2) An error: nothing to clear.");
    expect(sent.content).toContain(`test_plain_file="${join("tests", "core", "clear-tasks.plain")}"`);
    expect(sent.content).toContain('"core:clear-tasks needs testing scenarios - a wrong implementation could look right. Writing them now."');
    expect(sent.content).toContain("implement-conformance-testing-script");
    expect(sent.content).toContain("Ask the person nothing");
    expect(sessions[1]!.entries).toEqual([]);
    expect(yes.told).toBe(1);
  });

  it("lets a host ask the advisor itself, as evaluate_tests does, and says what came of each", async () => {
    writeFileSync("core.plain", "***functional specs***\n\n# add-task\nAdd a task.\n");
    const turri = await createTurri();
    evaluated.length = 0;
    const outcome = turri.evaluateTests(["core:add-task", "core:no-such-thing"], { reason: "the person pressed Evaluate" });
    expect(outcome.started).toEqual(["core:add-task"]);
    expect(outcome.missing).toHaveLength(1);
    expect(evaluated[0]).toMatchObject({ module: "core", funcId: "add-task", reason: "the person pressed Evaluate" });
  });

  it("draws one line for a no, starting no turn", async () => {
    const turri = await createTurri();
    const mine = await turri.openChat();
    turri.focus(mine.id);
    const no = verdict("list-tasks", false);
    made!.onVerdict!(no);
    await settle();
    expect(sessions[0]!.sent).toEqual([]);
    expect(sessions[0]!.entries).toEqual([{ type: "turri_advisor", data: { text: "core:list-tasks doesn't need testing scenarios - nothing silent to get wrong." } }]);
    expect(noLine(no)).toBe("core:list-tasks doesn't need testing scenarios - nothing silent to get wrong.");
    expect(yesLine(verdict("clear-tasks", true))).toBe("core:clear-tasks needs testing scenarios - a wrong implementation could look right. Writing them now.");
  });

  it("waits while the chat's agent works, then delivers what came meanwhile together: one turn for the yeses, a line for each no", async () => {
    const turri = await createTurri();
    const mine = await turri.openChat();
    turri.focus(mine.id);
    sessions[0]!.session.isStreaming = true;
    const first = verdict("clear-tasks", true);
    const second = verdict("add-task", true);
    const no = verdict("list-tasks", false);
    for (const given of [first, second, no]) made!.onVerdict!(given);
    await settle();
    expect(sessions[0]!.sent).toEqual([]);
    expect(sessions[0]!.entries).toEqual([]);
    expect(first.told).toBe(0);
    sessions[0]!.session.isStreaming = false;
    await settled(sessions[0]!);
    expect(sessions[0]!.sent).toHaveLength(1);
    expect(sessions[0]!.sent[0]!.content).toBe(yesTask([first, second]));
    expect(sessions[0]!.entries.map((entry) => entry.data)).toEqual([{ text: noLine(no) }]);
    expect([first.told, second.told, no.told]).toEqual([1, 1, 1]);
  });

  it("waits while the person types, and delivers once the editor is empty", async () => {
    const turri = await createTurri();
    const mine = await turri.openChat();
    turri.focus(mine.id);
    let typed = "does add-task";
    await systemPrompt(sessions[0]!, contextWith({ hasUI: true, ui: contextWith({ getEditorText: () => typed }), isIdle: () => true, hasPendingMessages: () => false }));
    vi.useFakeTimers();
    made!.onVerdict!(verdict("clear-tasks", true));
    vi.advanceTimersByTime(0);
    expect(sessions[0]!.sent).toEqual([]);
    vi.advanceTimersByTime(ADVISOR_RECHECK_MS);
    expect(sessions[0]!.sent).toEqual([]);
    typed = "";
    vi.advanceTimersByTime(ADVISOR_RECHECK_MS);
    expect(sessions[0]!.sent).toHaveLength(1);
  });

  it("lets go of a verdict no longer about its functional spec as it is", async () => {
    const turri = await createTurri();
    const mine = await turri.openChat();
    turri.focus(mine.id);
    made!.onVerdict!(verdict("clear-tasks", true, false));
    await settle();
    expect(sessions[0]!.sent).toEqual([]);
  });

  it("holds a verdict that comes before any chat is open, and hands it to the first", async () => {
    const turri = await createTurri();
    const early = verdict("clear-tasks", true);
    made!.onVerdict!(early);
    await settle();
    const mine = await turri.openChat();
    turri.focus(mine.id);
    await settle();
    expect(sessions[0]!.sent.map((sent) => sent.customType)).toEqual(["turri_advisor_verdict"]);
    expect(early.told).toBe(1);
  });

  it("gives a host's chat evaluate_tests, whatever test-advisor says", async () => {
    writeFileSync("config.turri.yaml", "sentinel: false\ntest-advisor: false\n");
    const turri = await createTurri();
    await turri.openChat();
    expect(sessions[0]!.tools).toContain("evaluate_tests");
  });

  it("tells the chat's agent of the advisor, and that it alone writes scenarios, while the project wants the advisor", async () => {
    const turri = await createTurri();
    const mine = await turri.openChat();
    turri.focus(mine.id);
    expect(await systemPrompt(sessions[0]!)).toContain(TEST_ADVISOR_BLOCK);
    writeFileSync("config.turri.yaml", "sentinel: false\ntest-advisor: false\n");
    expect(await systemPrompt(sessions[0]!)).not.toContain("<test advisor>");
  });
});

describe("what a change's result says of the test advisor", () => {
  it("names the functional specs the advisor is taking, and nothing when it takes none or the loop has no advisor", async () => {
    const { advisingNote, bindAdvisor } = await import("../src/advisor-chat.ts");
    const dir = mkdtempSync(join(tmpdir(), "turri-advising-"));
    writeFileSync(join(dir, "config.turri.yaml"), "sentinel: false\n");
    const loop = {} as never;
    let taking: string[] = ["core:clear-tasks", "notes:count-words"];
    const asked: Array<string | undefined> = [];
    bindAdvisor(loop, () => ({ taking: (project?: string) => (asked.push(project), taking) }) as never);
    const note = advisingNote(loop, join(dir, "core.plain"));
    expect(note).toContain("My test advisor is evaluating core:clear-tasks, notes:count-words in the background");
    expect(note).toContain("testing scenarios are being evaluated");
    expect(asked).toEqual([dir]);
    taking = [];
    expect(advisingNote(loop, join(dir, "core.plain"))).toBe("");
    expect(advisingNote({} as never, join(dir, "core.plain"))).toBe("");
  });
});
