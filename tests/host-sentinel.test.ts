import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** A tool turri registered in a chat, run as pi runs it: id, arguments, the turn's signal, updates, the context. */
type Tool = { execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }> };

/** An event handler turri registered in a chat. */
type Handler = (event: unknown, ctx: unknown) => unknown;

/** A chat's session: what it was asked to do, the tools and handlers turri registered in it, the model and thinking set on it. */
type Session = {
  isStreaming: boolean;
  did: string[];
  tools: Map<string, Tool>;
  sent: string[];
  handlers: Map<string, Handler[]>;
  model?: { provider: string; id: string };
  thinking?: string;
};

/** Each chat's session, by the order the chats were made in. */
const sessions: Session[] = [];

// A host's chats on pi sessions that run nothing: each says whether a turn is running, and records what stops it. The
// extensions are built into each, keeping the tools they register.
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
      const state: Session = { isStreaming: false, did: [], tools: new Map(), sent: [], handlers: new Map() };
      sessions.push(state);
      const api = new Proxy(
        {},
        {
          get: (_target, key) =>
            key === "registerTool"
              ? (tool: Tool & { name: string }) => state.tools.set(tool.name, tool)
              : key === "sendMessage"
                ? (message: { customType: string }) => state.sent.push(message.customType)
                : key === "on"
                  ? (event: string, handler: Handler) => state.handlers.set(event, [...(state.handlers.get(event) ?? []), handler])
                  : key === "setModel"
                    ? async (model: { provider: string; id: string }) => (state.model = model)
                    : key === "setThinkingLevel"
                      ? (level: string) => (state.thinking = level)
                      : key === "getAllTools"
                        ? () => [...state.tools.keys()].map((name) => ({ name }))
                        : () => undefined,
        },
      );
      for (const factory of resourceLoader.factories) factory(api);
      const session = {
        get isStreaming() {
          return state.isStreaming;
        },
        isCompacting: false,
        isRetrying: false,
        isBashRunning: false,
        sessionFile: undefined,
        messages: [],
        sessionManager: { getSessionName: () => undefined },
        extensionRunner: { getUIContext: () => undefined },
        subscribe: () => () => {},
        bindExtensions: async () => {},
        abort: async () => {
          state.did.push("abort");
          state.isStreaming = false;
        },
        abortBash: () => state.did.push("abortBash"),
        dispose: () => state.did.push("dispose"),
      };
      return { session };
    },
  };
});

const { createTurri } = await import("../src/host-session.ts");
const { SENTINEL } = await import("../src/sentinel.ts");

const settled = () => new Promise((resolve) => setTimeout(resolve, 30));

/** Anything a handler asks of its context that the test does not care about: a function that does nothing, all the way down. */
const anything: unknown = new Proxy(() => undefined, {
  get: (_target, key) => (key === "then" || typeof key === "symbol" ? undefined : anything),
  apply: () => anything,
});

/** A new session shown, as pi starts it: its session_start handlers run, with a model registry that has every model asked for. */
async function start(session: Session): Promise<void> {
  const modelRegistry = { find: (provider: string, id: string) => ({ provider, id }) };
  const sessionManager = { getEntries: () => [], getBranch: () => [], getSessionName: () => undefined };
  const ctx = new Proxy({ modelRegistry, sessionManager }, { get: (target, key) => (key in target ? target[key as keyof typeof target] : anything) });
  for (const handler of session.handlers.get("session_start") ?? []) await handler({ type: "session_start", reason: "new" }, ctx);
}

describe("the sentinel in a host", () => {
  const cwd = process.cwd();
  beforeEach(() => {
    sessions.length = 0;
    process.chdir(mkdtempSync(join(tmpdir(), "turri-sentinel-")));
  });
  afterEach(() => process.chdir(cwd));

  it("is opened as a chat of its own with the first finished pulse, focus left where it was, and told of the pulse", async () => {
    const turri = await createTurri();
    const mine = await turri.openChat();
    turri.focus(mine.id);
    const job = turri.jobs.start({ kind: "regenerate", summary: "app pulse 1", module: "app", run: async () => ({ report: "done", details: { passed: true, landed: true } }) });
    await turri.jobs.wait(job.id);
    await settled();
    const sentinel = turri.chats().find((chat) => chat.role === SENTINEL);
    expect(sentinel).toMatchObject({ title: SENTINEL, shown: false });
    expect(turri.chats().find((chat) => chat.id === mine.id)?.shown).toBe(true);
    // The person's chat is told the pulse landed, to say so; the sentinel checks it.
    expect(sessions[0]!.sent).toEqual(["turri_job_landed"]);
    expect(sessions[1]!.sent).toEqual(["turri_sentinel_pulse"]);
  });

  it("runs on the chat's model, with its thinking, when models.sentinel names none - not on the model its session started on", async () => {
    writeFileSync("config.turri.yaml", "harness-model: amazon-bedrock/claude-chat:high\ncoding-model: amazon-bedrock/claude-coder\n");
    const turri = await createTurri();
    const mine = await turri.openChat();
    turri.focus(mine.id);
    const job = turri.jobs.start({ kind: "regenerate", summary: "app pulse 1", module: "app", run: async () => ({ report: "done", details: { passed: true, landed: true } }) });
    await turri.jobs.wait(job.id);
    await settled();
    await start(sessions[1]!);
    expect(sessions[1]!.model).toEqual({ provider: "amazon-bedrock", id: "claude-chat" });
    expect(sessions[1]!.thinking).toBe("high");
  });

  it("has tools that read and notify, and none that write - and its notice reaches the host, answered back into the person's chat", async () => {
    const heard: Array<{ id: string; chat: string }> = [];
    const turri = await createTurri({ onNotice: (notice) => heard.push({ id: notice.id, chat: notice.chat }) });
    const mine = await turri.openChat();
    turri.focus(mine.id);
    const job = turri.jobs.start({ kind: "regenerate", summary: "app pulse 1", module: "app", run: async () => ({ report: "done", details: { passed: true, landed: true } }) });
    await turri.jobs.wait(job.id);
    await settled();
    const tools = sessions[1]!.tools;
    for (const name of ["read", "bash", "grep", "notify_person", "conclude", "keep_guidance"]) expect(tools.has(name), name).toBe(true);
    expect(tools.has("write")).toBe(false);
    expect(tools.has("edit")).toBe(false);
    const result = await tools.get("notify_person")!.execute(
      "call",
      { severity: "error", summary: "the home page answers 500", evidence: ["GET / → 500"], actions: [{ label: "Regenerate fs 1 again", task: "regenerate app.plain fs 1 again" }], pulse: job.id },
      undefined,
      undefined,
      {},
    );
    expect(result.content[0]!.text).toContain("Put to the person");
    expect(heard).toEqual([{ id: expect.any(String), chat: mine.id }]);
    expect(turri.notices()).toMatchObject([{ module: "app", summary: "the home page answers 500" }]);
    expect(await turri.answer(heard[0]!.id, { action: "Regenerate fs 1 again" })).toBe("done");
    expect(sessions[0]!.sent).toEqual(["turri_job_landed", "turri_notice_answer"]);
    expect(turri.notices()).toEqual([]);
    // Done with it: the person's chat is told, to say so.
    await tools.get("conclude")!.execute("call", { pulse: job.id, verdict: "wrong", summary: "the home page answers 500" }, undefined, undefined, {});
    expect(sessions[0]!.sent).toEqual(["turri_job_landed", "turri_notice_answer", "turri_sentinel_concluded"]);
  });
});
