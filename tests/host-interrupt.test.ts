import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** What each chat's session was asked to do, by the order the chats were made in. */
const sessions: Array<{ isStreaming: boolean; did: string[] }> = [];

// A host's chats on pi sessions that run nothing: each says whether a turn is running, and records what stops it.
vi.mock("@earendil-works/pi-coding-agent", async (actual) => {
  const pi = await actual<typeof import("@earendil-works/pi-coding-agent")>();
  class DefaultResourceLoader {
    async reload() {}
  }
  return {
    ...pi,
    DefaultResourceLoader,
    SessionManager: { create: () => ({}), open: () => ({}) },
    createAgentSession: async () => {
      const state = { isStreaming: false, did: [] as string[] };
      sessions.push(state);
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
