import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentSessionRuntime, InteractiveMode, type AgentSession, type ExtensionAPI, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createChats } from "../src/chats.ts";
import { chatStrip } from "../src/chat-commands.ts";
import { createJobRegistry } from "../src/regenerate/jobs.ts";

const PI = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
const piFile = (path: string) => readFileSync(join(PI, path), "utf8");

describe("what the terminal's chats reach of pi", () => {
  // pi has no hooks for several live sessions on one screen: chat-terminal.ts patches its classes and reads their
  // fields. A pi that changes them fails here, before a person finds it.
  it("finds the methods it patches and calls", () => {
    const screen = InteractiveMode.prototype as unknown as Record<string, unknown>;
    for (const name of ["rebindCurrentSession", "handleEvent", "resetExtensionUI"]) expect(typeof screen[name], name).toBe("function");
    const runtime = AgentSessionRuntime.prototype as unknown as Record<string, unknown>;
    for (const name of ["newSession", "switchSession", "dispose", "setRebindSession", "setBeforeSessionInvalidate"]) expect(typeof runtime[name], name).toBe("function");
  });

  it("finds the fields it reads and sets", () => {
    const runtime = piFile("core/agent-session-runtime.js");
    for (const field of ["this._session = _session", "this._services = _services", "this.createRuntime = createRuntime", "this.rebindSession(this.session)", "this.beforeSessionInvalidate?.()"]) {
      expect(runtime, field).toContain(field);
    }
    const runner = piFile("core/extensions/runner.js");
    for (const method of ["setUIContext(uiContext, mode", "getUIContext()", "this.mode = mode"]) expect(runner, method).toContain(method);
    const screen = piFile("modes/interactive/interactive-mode.js");
    for (const call of ["this.ui.hideOverlay();", "this.runtimeHost.setRebindSession(", "await this.rebindCurrentSession({ renderBeforeBind: true })", "await this.runtimeHost.newSession()", "await this.runtimeHost.switchSession(sessionPath"]) {
      expect(screen, call).toContain(call);
    }
  });
});

/** A pi session as the terminal's driver handles it. */
function fakeSession(name: string) {
  let ui: ExtensionUIContext | undefined;
  const session = {
    name,
    disposed: false,
    sessionFile: undefined,
    messages: [],
    isStreaming: false,
    agent: { state: {} },
    subscribe: () => () => {},
    sessionManager: { getSessionName: () => undefined, getSessionDir: () => "/sessions", isPersisted: () => false },
    extensionRunner: {
      mode: "tui",
      getUIContext: () => ui,
      // As pi's runner keeps it: a copy, with its dialogs wrapped.
      setUIContext: (next: ExtensionUIContext) => {
        ui = { ...next };
      },
    },
    bindExtensions: async (bindings: { uiContext: ExtensionUIContext }) => {
      ui = { ...bindings.uiContext };
    },
    abort: async () => {},
    dispose() {
      this.disposed = true;
    },
  };
  return session as typeof session & AgentSession;
}

/** pi's screen: what it asks and says, and how often it was cleared for another session. */
function realScreen() {
  const did: string[] = [];
  const ui = {
    select: async (title: string) => {
      did.push(`select ${title}`);
      return "picked";
    },
    notify: (message: string) => did.push(`notify ${message}`),
    setWidget: () => {},
    setStatus: () => {},
    getEditorText: () => "",
    setEditorText: () => {},
  } as unknown as ExtensionUIContext;
  return { ui, did };
}

describe("the terminal's chats", () => {
  it("opens a chat beside the first and switches between them, nothing let go", async () => {
    // pi's own rebind is left out: it draws a screen there is none of here.
    (InteractiveMode.prototype as unknown as { rebindCurrentSession: () => Promise<void> }).rebindCurrentSession = async () => {};
    const { driveTerminal } = await import("../src/chat-terminal.ts");

    const real = realScreen();
    const first = fakeSession("first");
    const second = fakeSession("second");
    const core = createChats({ cwd: process.cwd(), host: {}, jobs: createJobRegistry(), extension: () => {} });
    driveTerminal(core);

    let cleared = 0;
    let overlaysHidden = 0;
    const screen = { runtimeHost: undefined as unknown, handleEvent: async () => {}, ui: { hideOverlay: () => (overlaysHidden += 1) } };
    const runtime = {
      _session: first as AgentSession,
      _services: {},
      get session() {
        return this._session;
      },
      services: { agentDir: "/agent" },
      cwd: process.cwd(),
      // pi's reset: the extension's UI cleared, and the overlay on the screen hidden.
      beforeSessionInvalidate: () => {
        cleared += 1;
        screen.ui.hideOverlay();
      },
      rebindSession: async () => {
        // pi binds the session to its screen as it draws it.
        runtime._session.extensionRunner.setUIContext(real.ui, "tui");
        await (InteractiveMode.prototype as unknown as { rebindCurrentSession: (this: unknown) => Promise<void> }).rebindCurrentSession.call(screen);
      },
      createRuntime: async () => {
        core.extension({} as ExtensionAPI);
        return { session: second, services: {} };
      },
    };
    screen.runtimeHost = runtime;
    Object.setPrototypeOf(runtime, AgentSessionRuntime.prototype);

    // pi's screen comes up on its first session.
    await runtime.rebindSession();
    expect(core.chats()).toHaveLength(1);

    // /new: a chat beside it, shown, the first one kept.
    await (AgentSessionRuntime.prototype as unknown as { newSession(this: unknown): Promise<unknown> }).newSession.call(runtime);
    expect(core.chats().map((chat) => chat.shown)).toEqual([false, true]);
    expect(runtime.session).toBe(second);
    expect(first.disposed).toBe(false);
    expect(cleared).toBe(1);
    // The side panel, an overlay, stays on the screen as another chat is shown.
    expect(overlaysHidden).toBe(0);
    screen.ui.hideOverlay();
    expect(overlaysHidden).toBe(1);

    // The first chat asks while hidden: nothing on the screen until it is shown again.
    const answer = first.extensionRunner.getUIContext()!.select("Which CRM?", ["a", "b"]);
    expect(real.did).toEqual([]);
    expect(core.chats()[0]!.status).toBe("question");
    await core.show(core.chats()[0]!.id);
    expect(await answer).toBe("picked");
    expect(real.did).toEqual(["select Which CRM?"]);
    first.extensionRunner.getUIContext()!.notify("said", "info");
    expect(real.did).toEqual(["select Which CRM?", "notify said"]);
    expect(runtime.session).toBe(first);

    // Leaving turri lets the other chat go; pi lets go of the one it shows itself.
    await (AgentSessionRuntime.prototype as unknown as { dispose(this: unknown): Promise<void> }).dispose.call(runtime).catch(() => {});
    expect(second.disposed).toBe(true);
  });
});

describe("the strip of chats above the editor", () => {
  const style = { shown: (text: string) => `[${text}]`, muted: (text: string) => text };

  it("names each chat by its number, its title and what it is doing, the one shown set apart, a rule between them", () => {
    const line = chatStrip(
      [
        { id: "a", title: "backend", status: "idle", shown: true },
        { id: "b", title: "frontend", status: "question", shown: false },
        { id: "c", title: "docs", status: "unread", shown: false },
      ],
      120,
      style,
    );
    expect(line).toEqual([" [1 backend] │ 2 frontend ? │ 3 docs •"]);
  });

  it("is not drawn for a single chat", () => {
    expect(chatStrip([{ id: "a", title: "only", status: "idle", shown: true }], 80, style)).toEqual([]);
  });
});
