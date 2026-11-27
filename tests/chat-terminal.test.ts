import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentSessionRuntime, InteractiveMode, type AgentSession, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { chatTabs, type TabAction } from "../src/chat-tabs.ts";
import { pressCtrlC, type CtrlCScreen } from "../src/chat-terminal.ts";
import { Shade, showWaiting, type WaitingScreen } from "../src/chat-waiting.ts";
import { Container, Text, visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { openTerminal, piApi, standInSession } from "./terminal-session.ts";

const PI = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
const piFile = (path: string) => readFileSync(join(PI, path), "utf8");

describe("what the terminal's chats reach of pi", () => {
  // pi has no hooks for several live sessions on one screen: chat-terminal.ts patches its classes and reads their
  // fields. A pi that changes them fails here, before a person finds it.
  it("finds the methods it patches and calls", () => {
    const screen = InteractiveMode.prototype as unknown as Record<string, unknown>;
    for (const name of ["mountInteractiveTui", "rebindCurrentSession", "handleEvent", "resetExtensionUI", "handleCtrlC", "clearEditor", "restoreQueuedMessagesToEditor", "shutdown", "updatePendingMessagesDisplay", "getAllQueuedMessages", "addMessageToChat", "getAppKeyDisplay", "updateAvailableProviderCount"]) expect(typeof screen[name], name).toBe("function");
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
    for (const call of ["pendingMessages: this.pendingMessagesContainer", "this.pendingBashComponents.push(this.bashComponent);", 'case "queue_update":\n                this.updatePendingMessagesDisplay();', "this.chatContainer.addChild(userComponent);", 'onAction("app.clear", () => this.handleCtrlC())', "for (const removeOverlay of [...this.extensionOverlays.values()].reverse())", "this.extensionOverlays.set(overlayHandle, removeOverlay);", "this.runtimeHost.setRebindSession(", "await this.rebindCurrentSession({ renderBeforeBind: true })", "await this.runtimeHost.newSession()", "await this.runtimeHost.switchSession(sessionPath"]) {
      expect(screen, call).toContain(call);
    }
  });
});

const settled = () => new Promise((resolve) => setTimeout(resolve, 20));

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
    const first = standInSession("first");
    const second = standInSession("second");
    let cleared = 0;
    let overlaysHidden = 0;
    const panel = {};
    const screen = {
      runtimeHost: undefined as unknown,
      handleEvent: async () => {},
      shutdown: async () => {},
      // The side panel, an overlay an extension opened.
      extensionOverlays: new Map<unknown, () => void>([[panel, () => void (overlaysHidden += 1)]]),
    };
    let runtime: Record<string, unknown> & { _session: AgentSession; session: AgentSession; rebindSession(): Promise<void> };
    // The session's chats are made on pi's runtime (chat-terminal.ts): turri's extension built into each.
    const open = await openTerminal({ sessions: (terminal) => driveTerminal(terminal) });
    const { turri, terminal } = open;
    try {
      runtime = {
        _session: first as AgentSession,
        _services: {},
        get session() {
          return this._session;
        },
        services: { agentDir: "/agent" },
        cwd: process.cwd(),
        // pi's reset: the extension's UI cleared, and every overlay an extension opened taken off the screen.
        beforeSessionInvalidate: () => {
          cleared += 1;
          for (const remove of [...screen.extensionOverlays.values()].reverse()) remove();
          screen.extensionOverlays.clear();
        },
        rebindSession: async () => {
          // pi binds the session to its screen as it draws it.
          runtime._session.extensionRunner.setUIContext(real.ui, "tui");
          await (InteractiveMode.prototype as unknown as { rebindCurrentSession: (this: unknown) => Promise<void> }).rebindCurrentSession.call(screen);
        },
        createRuntime: async () => {
          await turri.extension(piApi());
          return { session: second, services: {} };
        },
      };
      screen.runtimeHost = runtime;
      Object.setPrototypeOf(runtime, AgentSessionRuntime.prototype);

      // pi's screen comes up on its first session, turri's extension built into it.
      await turri.extension(piApi());
      await runtime.rebindSession();
      await settled();
      expect(turri.chats.list()).toHaveLength(1);
      const firstId = turri.chats.focused()!;
      expect(turri.chats.get(firstId)?.session).toBe(first);
      expect(terminal.welcomeVisible(firstId)).toBe(true);

      // /new: a chat beside it, shown, the first one kept.
      await (AgentSessionRuntime.prototype as unknown as { newSession(this: unknown): Promise<unknown> }).newSession.call(runtime);
      expect(turri.chats.list().map((chat) => chat.shown)).toEqual([false, true]);
      expect(runtime.session).toBe(second);
      const secondId = turri.chats.focused()!;
      expect(terminal.welcomeVisible(secondId)).toBe(false);
      expect(terminal.welcomeVisible(firstId)).toBe(true);

      // Exercise pi's real submit handler: an extension command is dispatched without a normal message input event.
      const submitted: string[] = [];
      const editor = { onSubmit: async (_text: string) => {}, addToHistory() {} };
      const submitScreen = { defaultEditor: editor, editor, session: second, flushPendingBashComponents() {}, onInputCallback: (text: string) => submitted.push(text) };
      (InteractiveMode.prototype as unknown as { setupEditorSubmitHandler(): void }).setupEditorSubmitHandler.call(submitScreen);
      await editor.onSubmit("   ");
      expect(terminal.welcomeVisible(firstId)).toBe(true);
      await editor.onSubmit("/regenerate");
      expect(submitted).toEqual(["/regenerate"]);
      expect(terminal.welcomeVisible(firstId)).toBe(false);
      expect(first.disposed).toBe(false);
      expect(cleared).toBe(1);
      // The side panel, an overlay, stays on the screen as another chat is shown - and pi still takes it off on a reload.
      expect(overlaysHidden).toBe(0);
      expect([...screen.extensionOverlays.keys()]).toEqual([panel]);
      screen.extensionOverlays.get(panel)!();
      expect(overlaysHidden).toBe(1);

      // The first chat asks while hidden: nothing on the screen until it is shown again.
      const answer = first.extensionRunner.getUIContext()!.select("Which CRM?", ["a", "b"]);
      expect(real.did).toEqual([]);
      expect(terminal.chats()[0]!.status).toBe("question");
      await turri.chats.focus(firstId);
      expect(await answer).toBe("picked");
      expect(real.did).toEqual(["select Which CRM?"]);
      first.extensionRunner.getUIContext()!.notify("said", "info");
      expect(real.did).toEqual(["select Which CRM?", "notify said"]);
      expect(runtime.session).toBe(first);

      // Leaving turri lets the other chat go; pi lets go of the one it shows itself.
      await (AgentSessionRuntime.prototype as unknown as { dispose(this: unknown): Promise<void> }).dispose.call(runtime).catch(() => {});
      expect(second.disposed).toBe(true);
      expect(first.disposed).toBe(false);
    } finally {
      await open.close();
    }
  });
});

describe("the chat tabs", () => {
  const mouse = (type: TuiMouseEvent["type"], x: number, width: number): TuiMouseEvent => ({
    type, button: "left", x, y: 0, screenX: x + 2, screenY: 1, width, height: 1, shift: false, alt: false, ctrl: false,
  });
  const first = { id: "a", title: "会話", status: "idle", shown: true } as const;

  it("opens a chat on a click on + beside the first tab, leaving the editor focused", () => {
    const picks: TabAction[] = [];
    const tabs = chatTabs(() => [first], (text) => text, (action) => picks.push(action));
    const [line] = tabs.render(80);
    expect(line).toMatch(/^ ▸ 1 会話 × +\+ +\*\*\*plain › $/);
    const plus = visibleWidth(line!.split("+")[0]!);
    expect(tabs.handleMouse!(mouse("press", plus, 80))).toEqual({ handled: true });
    expect(picks).toEqual([]);
    tabs.handleMouse!(mouse("click", plus, 80));
    expect(picks).toEqual([{ kind: "open" }]);
  });

  it("switches to the tab clicked even after resizing with wide titles and a waiting question", () => {
    const picks: TabAction[] = [];
    const tabs = chatTabs(() => [first, { id: "b", title: "frontend", status: "question", shown: false }], (text) => text, (action) => picks.push(action));
    expect(tabs.render(80)[0]).toMatch(/▸ 1 会話 × +2 frontend \? × +\+/);
    for (const width of [80, 20, 9]) {
      const [line] = tabs.render(width);
      expect(visibleWidth(line!)).toBeLessThanOrEqual(width);
      const second = visibleWidth(line!.split("2")[0]!);
      tabs.handleMouse!(mouse("press", second, width));
      tabs.handleMouse!(mouse("click", second, width));
      tabs.handleMouse!({ ...mouse("click", second, width), button: "right" });
      tabs.handleMouse!(mouse("press", 0, width));
      tabs.handleMouse!(mouse("click", 0, width)); // already shown
    }
    expect(picks).toEqual(Array(3).fill({ kind: "show", id: "b" }));
  });

  it("keeps the plain button clickable at the right edge when many chats have long or wide titles", () => {
    const picks: TabAction[] = [];
    const tabs = chatTabs(() => Array.from({ length: 9 }, (_, i) => ({ ...first, id: `${i}`, title: "長い".repeat(15) })), (text) => text, (action) => picks.push(action));
    for (const width of [50, 120]) {
      const [line] = tabs.render(width);
      expect(visibleWidth(line!)).toBe(width);
      expect(line!.endsWith(" ***plain › ")).toBe(true);
      tabs.handleMouse!(mouse("press", width - 2, width));
      tabs.handleMouse!(mouse("click", width - 2, width));
    }
    expect(picks).toEqual([{ kind: "plain" }, { kind: "plain" }]);
  });

  it("toggles the panel from its button while regeneration is active and keeps its notification count", () => {
    const state = { open: false, busy: true, notifications: 2 };
    let paint: string | undefined;
    const tabs = chatTabs(() => [first], (text, _active, _hovered, role) => { if (text.includes("***plain")) paint = role; return text; }, (action) => { if (action.kind === "plain") state.open = !state.open; }, () => state);
    for (const arrow of ["›", "‹"]) {
      expect(tabs.render(60)[0]).toMatch(new RegExp(`[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] \\*\\*\\*plain · 2 ${arrow}`));
      expect(paint).toBe("regenerating");
      for (const event of ["press", "click"] as const) tabs.handleMouse!(mouse(event, 58, 60));
    }
    state.busy = false;
    expect(tabs.render(60)[0]).toMatch(/\+ +\*\*\*plain · 2 › $/);
    expect(paint).toBe("panel");
  });

  it("highlights the close button independently, clears it on leaving and closes the hidden chat without switching", () => {
    const picks: TabAction[] = [];
    const tabs = chatTabs(() => [first, { ...first, id: "b", shown: false }], (text, _shown, hover) => hover ? `<${text}>` : text, (action) => picks.push(action));
    const [plain] = tabs.render(80);
    const x = visibleWidth(plain!.slice(0, plain!.lastIndexOf("×")));
    const send = (type: TuiMouseEvent["type"]) => tabs.pointer.dispatch(() => tabs.handleMouse!({ ...mouse(type, x, 80), button: type === "move" ? "none" : "left" }), () => {});
    send("move");
    expect(tabs.render(80)[0]).toContain("2 会話< × >");
    tabs.pointer.dispatch(() => {}, () => {}); // move dispatched to the editor instead
    expect(tabs.render(80)).toEqual([plain]);
    expect(picks).toEqual([]);
    send("press");
    send("click");
    expect(picks).toEqual([{ kind: "close", id: "b" }]);
  });
});

describe("ctrl+c in the chat shown", () => {
  /** pi's screen as ctrl+c reaches it, the chat shown doing `doing`, and what was done to it. */
  const screenDoing = (doing: { streaming?: boolean; bash?: boolean; compacting?: boolean; draft?: string } = {}) => {
    const did: string[] = [];
    const screen: CtrlCScreen = {
      session: { isStreaming: doing.streaming === true, isBashRunning: doing.bash === true, isCompacting: doing.compacting === true, isRetrying: false },
      editor: { getText: () => doing.draft ?? "" },
      clearEditor: () => void did.push("clear"),
      restoreQueuedMessagesToEditor: (options) => (did.push(options?.abort === true ? "stop turn" : "restore"), 0),
      shutdown: async () => void did.push("leave"),
    };
    // The session's chat: what stopping it does is the core's (Chat.stop).
    const chat = { stop: async () => (did.push("stop"), "stopped" as const) };
    return { screen, chat, did };
  };

  it("stops the turn it is in - a skill, a tool - its queued messages back in the editor, keeping the draft and turri", () => {
    const { screen, chat, did } = screenDoing({ streaming: true, draft: "half a thought" });
    expect(pressCtrlC(screen, chat, 0)).toBe("stopped");
    expect(did).toEqual(["restore", "stop"]);
  });

  it("stops a ! command and a compaction", () => {
    const bash = screenDoing({ bash: true });
    expect(pressCtrlC(bash.screen, bash.chat, 0)).toBe("stopped");
    expect(bash.did).toEqual(["stop"]);
    const compacting = screenDoing({ compacting: true });
    expect(pressCtrlC(compacting.screen, compacting.chat, 0)).toBe("stopped");
    expect(compacting.did).toEqual(["stop"]);
  });

  it("leaves turri when the chat is doing nothing", () => {
    const { screen, chat, did } = screenDoing();
    expect(pressCtrlC(screen, chat, 0)).toBe("left");
    expect(did).toEqual(["leave"]);
  });

  it("clears a draft before it leaves", () => {
    const { screen, chat, did } = screenDoing({ draft: "not sent" });
    expect(pressCtrlC(screen, chat, 0)).toBe("cleared");
    expect(did).toEqual(["clear"]);
  });

  it("does not leave on a press straight after one that stopped something", () => {
    const now = 10_000;
    const { screen, chat, did } = screenDoing();
    expect(pressCtrlC(screen, chat, now - 100, now)).toBe("ignored");
    expect(pressCtrlC(screen, chat, now - 500, now)).toBe("left");
    expect(did).toEqual(["leave"]);
  });
});

describe("a message sent while the agent works", () => {
  /** pi's screen as chat-waiting.ts reaches it: a message drawn as a line of its text, in whichever container is the chat. */
  function waitingScreen(queued: { steering: string[]; followUp: string[] }) {
    const screen: WaitingScreen = {
      chatContainer: new Container(),
      pendingMessagesContainer: new Container(),
      getAllQueuedMessages: () => queued,
      addMessageToChat(message) {
        this.chatContainer.addChild(new Text((message as { content: Array<{ text: string }> }).content[0]!.text, 0, 0));
      },
      getAppKeyDisplay: () => "alt+up",
    };
    return screen;
  }
  const plain = (lines: string[]) => lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd()).filter((line) => line !== "");

  it("is drawn under the chat as a message, shaded and marked not read yet, in the order they were sent", () => {
    const screen = waitingScreen({ steering: ["make it blue"], followUp: ["then deploy it"] });
    screen.chatContainer.addChild(new Text("the agent at work", 0, 0));
    showWaiting(screen);

    expect(plain(screen.chatContainer.render(80))).toEqual(["the agent at work"]);
    const shades = screen.pendingMessagesContainer.children.filter((part) => part instanceof Shade);
    expect(shades).toHaveLength(2);
    expect(screen.pendingMessagesContainer.render(80).filter((line) => line.trim() !== "").every((line) => line.startsWith("\x1b[2m"))).toBe(true);
    expect(plain(screen.pendingMessagesContainer.render(80))).toEqual([
      "make it blue",
      " not read yet · alt+up to edit",
      "then deploy it",
      " not read yet · alt+up to edit",
    ]);
  });

  it("leaves the area under the chat once the agent has read it - pi puts it in the chat then", () => {
    const queued = { steering: ["make it blue"], followUp: [] as string[] };
    const screen = waitingScreen(queued);
    showWaiting(screen);
    queued.steering = [];
    showWaiting(screen);

    expect(screen.pendingMessagesContainer.children).toEqual([]);
    expect(screen.chatContainer.children).toEqual([]);
  });

  it("is drawn under the output of a command the person ran meanwhile, which stays there as pi keeps it", () => {
    const queued = { steering: ["make it blue"], followUp: [] as string[] };
    const screen = waitingScreen(queued);
    const output = new Text("$ ls\nREADME.md", 0, 0);
    screen.pendingBashComponents = [output];
    showWaiting(screen);

    expect(screen.pendingMessagesContainer.children[0]).toBe(output);
    expect(plain(screen.pendingMessagesContainer.render(80))).toEqual(["$ ls", "README.md", "make it blue", " not read yet · alt+up to edit"]);
    queued.steering = [];
    showWaiting(screen);
    expect(screen.pendingMessagesContainer.children).toEqual([output]);
  });
});
