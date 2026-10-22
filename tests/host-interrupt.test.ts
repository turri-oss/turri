import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** A tool turri registered in a chat, run as pi runs it: id, arguments, the turn's signal, updates, the context. */
type Tool = { execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }> };

/** What each chat's session was asked to do, and the tools turri registered in it, by the order the chats were made in. */
const sessions: Array<{ isStreaming: boolean; did: string[]; tools: Map<string, Tool> }> = [];

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
      const state = { isStreaming: false, did: [] as string[], tools: new Map<string, Tool>() };
      sessions.push(state);
      const api = new Proxy({}, { get: (_target, key) => (key === "registerTool" ? (tool: Tool & { name: string }) => state.tools.set(tool.name, tool) : () => undefined) });
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
const { DECLINED } = await import("../src/ask.ts");
type AskUserIO = import("../src/ask.ts").AskUserIO;

/** A host's dialogs that never answer, keeping each question they were given and the signal it came with. */
function silentDialogs() {
  const shown: Array<{ title: string; signal: AbortSignal | undefined }> = [];
  const dialogs: AskUserIO = {
    select: (title, _options, _context, _at, asked) => {
      shown.push({ title, signal: asked?.signal });
      return new Promise(() => {});
    },
    input: (title, _context, asked) => {
      shown.push({ title, signal: asked?.signal });
      return new Promise(() => {});
    },
  };
  return { dialogs, shown };
}

/** The chat's ask_user, called as its agent calls it in a turn stopped by `turn`. */
function askUser(chat: number, question: string, turn = new AbortController()): Promise<string> {
  const tool = sessions[chat]!.tools.get("ask_user")!;
  return tool.execute("call", { question, options: ["Yes", "No"] }, turn.signal, undefined, { hasUI: false, signal: turn.signal }).then((result) => result.content[0]!.text);
}

/** Once the host's dialogs have shown `count` questions. */
async function shownCount(shown: unknown[], count: number): Promise<void> {
  while (shown.length < count) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("a host interrupting a chat", () => {
  const cwd = process.cwd();
  beforeEach(() => {
    sessions.length = 0;
    process.chdir(mkdtempSync(join(tmpdir(), "turri-interrupt-")));
  });
  afterEach(() => process.chdir(cwd));

  it("stops the turn of that chat alone, and ends the session once it is doing nothing", async () => {
    const turri = await createTurri();
    const first = await turri.openChat();
    await turri.openChat();
    const [one, two] = sessions;
    one!.isStreaming = true;
    two!.isStreaming = true;

    expect(await turri.interrupt(first.id)).toBe("stopped");
    expect(one!.did).toEqual(["abort"]);
    expect(two!.did).toEqual([]);

    // Pressed twice to be sure: nothing ended.
    expect(await turri.interrupt(first.id)).toBe("ignored");
    expect(turri.chats()).toHaveLength(2);

    vi.useFakeTimers({ now: Date.now() + 1000, toFake: ["Date"] });
    try {
      expect(await turri.interrupt(first.id)).toBe("ended");
    } finally {
      vi.useRealTimers();
    }
    expect(turri.chats()).toEqual([]);
    expect(two!.did).toContain("dispose");
    expect(await turri.interrupt(first.id)).toBe("missing");
  });
});

describe("a host declining a chat's question", () => {
  const cwd = process.cwd();
  beforeEach(() => {
    sessions.length = 0;
    process.chdir(mkdtempSync(join(tmpdir(), "turri-decline-")));
  });
  afterEach(() => process.chdir(cwd));

  it("answers the question DECLINED and lets the turn go on", async () => {
    const { dialogs, shown } = silentDialogs();
    const turri = await createTurri({ dialogs: () => dialogs });
    const chat = await turri.openChat();
    sessions[0]!.isStreaming = true;

    const answer = askUser(0, "Ship it?");
    await shownCount(shown, 1);
    expect(await turri.decline(chat.id)).toBe("declined");
    expect(await answer).toContain(DECLINED);
    expect(sessions[0]!.did).toEqual([]);
    expect(sessions[0]!.isStreaming).toBe(true);
  });

  it("declines each question it is called at, five in a row, the turn still running", async () => {
    const { dialogs, shown } = silentDialogs();
    const turri = await createTurri({ dialogs: () => dialogs });
    const chat = await turri.openChat();
    sessions[0]!.isStreaming = true;

    const questions = ["Which stack?", "Which database?", "Which host?", "Which auth?", "Which CI?"];
    for (const [at, question] of questions.entries()) {
      const answer = askUser(0, question);
      await shownCount(shown, at + 1);
      expect(await turri.decline(chat.id)).toBe("declined");
      expect(await answer).toContain(DECLINED);
    }
    expect(shown.map((dialog) => dialog.title)).toEqual(questions);
    expect(sessions[0]!.did).toEqual([]);
    expect(sessions[0]!.isStreaming).toBe(true);
  });

  it("declines nothing in a chat asking nothing, nor in another chat", async () => {
    const { dialogs, shown } = silentDialogs();
    const turri = await createTurri({ dialogs: () => dialogs });
    const first = await turri.openChat();
    const second = await turri.openChat();
    expect(await turri.decline(first.id)).toBe("none");

    const answer = askUser(1, "Ship it?");
    await shownCount(shown, 1);
    expect(await turri.decline(first.id)).toBe("none");
    expect(shown[0]!.signal?.aborted).toBe(false);
    expect(await turri.decline(second.id)).toBe("declined");
    expect(await answer).toContain(DECLINED);
    expect(await turri.decline(second.id)).toBe("none");
  });

  it("says a chat that is not open is missing", async () => {
    const turri = await createTurri();
    expect(await turri.decline("nochat")).toBe("missing");
  });

  it("aborts the signal of the host's dialog when its question is declined", async () => {
    const { dialogs, shown } = silentDialogs();
    const turri = await createTurri({ dialogs: () => dialogs });
    const chat = await turri.openChat();

    const answer = askUser(0, "Ship it?");
    await shownCount(shown, 1);
    expect(shown[0]!.signal?.aborted).toBe(false);
    await turri.decline(chat.id);
    expect(shown[0]!.signal?.aborted).toBe(true);
    await answer;
  });

  it("aborts the signal of the host's dialog when the turn that asked is stopped", async () => {
    const { dialogs, shown } = silentDialogs();
    const turri = await createTurri({ dialogs: () => dialogs });
    const chat = await turri.openChat();

    const turn = new AbortController();
    const answer = askUser(0, "Ship it?", turn);
    await shownCount(shown, 1);
    turn.abort();
    expect(shown[0]!.signal?.aborted).toBe(true);
    expect(await answer).toContain(DECLINED);
    expect(await turri.decline(chat.id)).toBe("none");
  });
});
