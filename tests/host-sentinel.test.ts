import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** A tool turri registered in a chat, run as pi runs it: id, arguments, the turn's signal, updates, the context. */
type Tool = { execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }> };

/** What each chat's session was asked to do, and the tools turri registered in it, by the order the chats were made in. */
const sessions: Array<{ isStreaming: boolean; did: string[]; tools: Map<string, Tool>; sent: string[] }> = [];

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
      const state = { isStreaming: false, did: [] as string[], tools: new Map<string, Tool>(), sent: [] as string[] };
      sessions.push(state);
      const api = new Proxy(
        {},
        {
          get: (_target, key) =>
            key === "registerTool"
              ? (tool: Tool & { name: string }) => state.tools.set(tool.name, tool)
              : key === "sendMessage"
                ? (message: { customType: string }) => state.sent.push(message.customType)
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
