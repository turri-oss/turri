import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Each chat's tools as pi holds them: registered, and active - what the model is offered. */
const chats: Array<{ registered: string[]; active: string[] }> = [];

// A chat's session, as pi makes one: turri's extension built into it, its tools registered and all active, and shown -
// session_start told - so turri sets them as the config says.
vi.mock("@earendil-works/pi-coding-agent", async (actual) => {
  const pi = await actual<typeof import("@earendil-works/pi-coding-agent")>();
  class DefaultResourceLoader {
    factories: Array<(api: unknown) => void>;
    constructor(options: { extensionFactories: Array<(api: unknown) => void> }) {
      this.factories = options.extensionFactories;
    }
    async reload() {}
  }
  const quiet = (): unknown => new Proxy(() => undefined, { get: (_target, key) => (key === "then" ? undefined : quiet()) });
  return {
    ...pi,
    DefaultResourceLoader,
    SessionManager: { create: () => ({}), open: () => ({}) },
    createAgentSession: async ({ resourceLoader }: { resourceLoader: DefaultResourceLoader }) => {
      const tools = { registered: [] as string[], active: [] as string[] };
      chats.push(tools);
      const started: Array<(event: unknown, ctx: unknown) => void> = [];
      const api = new Proxy(
        {},
        {
          get: (_target, key) => {
            if (key === "on") return (event: string, handler: (event: unknown, ctx: unknown) => void) => (event === "session_start" ? started.push(handler) : undefined);
            if (key === "registerTool") return (tool: { name: string }) => (tools.registered.push(tool.name), tools.active.push(tool.name));
            if (key === "getAllTools") return () => tools.registered.map((name) => ({ name }));
            if (key === "getActiveTools") return () => [...tools.active];
            if (key === "setActiveTools") return (names: string[]) => (tools.active = [...names]);
            return () => undefined;
          },
        },
      );
      for (const factory of resourceLoader.factories) factory(api);
      const context = new Proxy({ hasUI: false }, { get: (target, key) => (key in target ? target[key as keyof typeof target] : quiet()) });
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
        bindExtensions: async () => {
          for (const handler of started) {
            try {
              handler({}, context);
            } catch {
              /* a handler that wants more of the context than this one has: not what is tested */
            }
          }
        },
        abort: async () => {},
        dispose: () => {},
      };
      return { session };
    },
  };
});

const { createTurri } = await import("../src/host-session.ts");

let dir: string;
let cwd: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "turri-host-conformance-")));
  cwd = process.cwd();
  process.chdir(dir);
  writeFileSync(join(dir, "config.turri.yaml"), "module: app.plain\nsentinel: false\n");
  writeFileSync(join(dir, "app.plain"), "***implementation reqs***\n\n- :Implementation: is Python.\n\n***functional specs***\n\n# say-hello\nSay hello.\n");
  chats.length = 0;
});
afterEach(() => {
  process.chdir(cwd);
  rmSync(dir, { recursive: true, force: true });
});

const offered = (chat: number) => ({
  conform: chats[chat]!.active.includes("conform"),
  evaluate: chats[chat]!.active.includes("evaluate_tests"),
  turnOn: chats[chat]!.active.includes("turn_on_conformance_tests"),
});

describe("a host turning conformance tests on", () => {
  it("writes conformance-tests: true in config.turri.yaml, and switches every open chat's tools - no model call", async () => {
    const turri = await createTurri();
    await turri.openChat();
    await turri.openChat();
    // Off, as it is unset: each chat has the tool that turns them on, not conform or evaluate_tests.
    for (const chat of [0, 1]) expect(offered(chat)).toEqual({ conform: false, evaluate: false, turnOn: true });
    expect(turri.turnOnConformanceTests()).toBe("config.turri.yaml");
    expect(readFileSync(join(dir, "config.turri.yaml"), "utf8")).toMatch(/^conformance-tests: true$/m);
    for (const chat of [0, 1]) expect(offered(chat)).toEqual({ conform: true, evaluate: true, turnOn: false });
    await turri.dispose();
  });

  it("writes the module's stack's file when that sets the key - which the project's alone would not change", async () => {
    writeFileSync(join(dir, "config.turri.app.yaml"), "conformance-tests: false\n");
    const turri = await createTurri();
    await turri.openChat();
    expect(offered(0).turnOn).toBe(true);
    expect(turri.turnOnConformanceTests("app.plain")).toBe("config.turri.app.yaml");
    expect(readFileSync(join(dir, "config.turri.app.yaml"), "utf8")).toMatch(/^conformance-tests: true$/m);
    expect(readFileSync(join(dir, "config.turri.yaml"), "utf8")).not.toContain("conformance-tests");
    expect(offered(0)).toEqual({ conform: true, evaluate: true, turnOn: false });
    await turri.dispose();
  });
});
