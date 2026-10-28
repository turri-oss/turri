import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** A tool or an event handler turri registered in a chat. */
type Handler = (event: unknown, ctx: unknown) => unknown;

/** A chat's session: what turri sent it, and the entries it drew in it. */
type Session = { sent: Array<{ customType: string; content: string; display: boolean; options?: { triggerTurn?: boolean } }>; entries: Array<{ type: string; data: unknown }>; handlers: Map<string, Handler[]> };

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
      const state: Session = { sent: [], entries: [], handlers: new Map() };
      sessions.push(state);
      const api = new Proxy(
        {},
        {
          get: (_target, key) =>
            key === "sendMessage"
              ? (message: { customType: string; content: string; display: boolean }, options?: { triggerTurn?: boolean }) => state.sent.push({ ...message, ...(options !== undefined ? { options } : {}) })
              : key === "appendEntry"
                ? (type: string, data: unknown) => state.entries.push({ type, data })
                : key === "on"
                  ? (event: string, handler: Handler) => state.handlers.set(event, [...(state.handlers.get(event) ?? []), handler])
                  : key === "getAllTools"
                    ? () => []
                    : () => undefined,
        },
      );
      for (const factory of resourceLoader.factories) factory(api);
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
      return { session };
    },
  };
});

/** What the session's advisor was made with: its landing is called by hand, as the writer would once scenarios land. */
let made: { onLanded?: (landing: unknown) => void } | undefined;
vi.mock("../src/regenerate/advisor-runs.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/regenerate/advisor-runs.ts")>();
  return {
    ...actual,
    createTestAdvisor: (options: { onLanded?: (landing: unknown) => void }) => {
      made = options;
      return { seen() {}, resume() {}, idle: async () => {}, stop() {} };
    },
  };
});

const { createTurri } = await import("../src/host-session.ts");
const { advisorLine, advisorNote, TEST_ADVISOR_BLOCK } = await import("../src/advisor-chat.ts");

const anything: unknown = new Proxy(() => undefined, {
  get: (_target, key) => (key === "then" || typeof key === "symbol" ? undefined : anything),
  apply: () => anything,
});

/** The system prompt a session's agent is given, as its before_agent_start handlers leave it. */
async function systemPrompt(session: Session): Promise<string> {
  let prompt = "pi's own";
  for (const handler of session.handlers.get("before_agent_start") ?? []) {
    const result = (await handler({ type: "before_agent_start", prompt: "hi", systemPrompt: prompt, systemPromptOptions: { skills: [] } }, anything)) as { systemPrompt?: string } | undefined;
    if (result?.systemPrompt !== undefined) prompt = result.systemPrompt;
  }
  return prompt;
}

const landing = {
  project: "/p",
  module: "core",
  funcId: "add-task",
  report: { verdict: "yes" as const, questions: [{ question: "silent-failure" as const, evidence: "Adding \"Buy milk\" shows \"Buy mil\"." }, { question: "revisited" as const, evidence: "Due dates later." }], inputs: [] },
  written: { scenarios: [{ kind: "conformance" as const, id: "adds-one", hash: "a" }, { kind: "conformance" as const, id: "keeps-order", hash: "b" }, { kind: "acceptance" as const, id: "rejects-empty", hash: "c" }], testReqs: false, script: false },
  built: false,
};

describe("what the person sees when the test advisor's scenarios land", () => {
  it("says it in one line, after the fact, with the first reason it judged them needed", () => {
    expect(advisorLine(landing)).toBe("I added 3 scenarios to core:add-task - a wrong implementation could look right. They're tested once its code is built.");
    expect(advisorLine({ ...landing, built: true, written: { ...landing.written, testReqs: true, script: true }, report: { ...landing.report, questions: [{ question: "cost", evidence: "x" }] } })).toBe(
      "I added 3 scenarios to core:add-task, with its test reqs and a conformance testing script - a bug in it would be costly. They're tested now that its code is built.",
    );
  });

  it("tells the chat's agent the report's gist, and to do nothing about the scenarios unless asked", () => {
    const note = advisorNote(landing);
    expect(note).toContain("conformance adds-one, conformance keeps-order, acceptance rejects-empty");
    expect(note).toContain("- silent-failure: Adding \"Buy milk\" shows \"Buy mil\".");
    expect(note).toContain("- revisited: Due dates later.");
    expect(note).toContain("Do nothing about them");
  });
});

describe("the test advisor in a host", () => {
  const cwd = process.cwd();
  beforeEach(() => {
    sessions.length = 0;
    made = undefined;
    process.chdir(mkdtempSync(join(tmpdir(), "turri-advisor-chat-")));
    writeFileSync("config.turri.yaml", "sentinel: false\n");
  });
  afterEach(() => process.chdir(cwd));

  it("draws the line in the chat the person looks at, and tells its agent why without starting a turn", async () => {
    const turri = await createTurri();
    const mine = await turri.openChat();
    turri.focus(mine.id);
    expect(made).toBeDefined();
    made!.onLanded!(landing);
    expect(sessions[0]!.entries).toEqual([{ type: "turri_advisor", data: { text: advisorLine(landing) } }]);
    expect(sessions[0]!.sent.map((message) => message.customType)).toEqual(["turri_advisor_landed"]);
    expect(sessions[0]!.sent[0]).toMatchObject({ content: advisorNote(landing), display: false });
    expect(sessions[0]!.sent[0]!.options?.triggerTurn).toBeUndefined();
  });

  it("tells the chat's agent its two paths to scenarios, while the project wants the advisor", async () => {
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
    expect(note).toContain("My test advisor is checking core:clear-tasks, notes:count-words in the background");
    expect(note).toContain("do not offer to write scenarios for");
    expect(asked).toEqual([dir]);
    taking = [];
    expect(advisingNote(loop, join(dir, "core.plain"))).toBe("");
    expect(advisingNote({} as never, join(dir, "core.plain"))).toBe("");
  });
});
