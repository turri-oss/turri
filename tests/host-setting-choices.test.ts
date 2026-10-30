import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { THINKING_LEVELS } from "../src/config.ts";

/** The models signed in to: two providers, sixty models between them - more than the terminal's completions show. */
const MODELS = [
  ...Array.from({ length: 30 }, (_, at) => ({ provider: "anthropic", id: `claude-${String(at).padStart(2, "0")}` })),
  ...Array.from({ length: 30 }, (_, at) => ({ provider: "openai", id: `gpt-${String(at).padStart(2, "0")}` })),
];

/** /turri-config as each chat registered it: its argument completions. */
const commands: Array<{ getArgumentCompletions: (prefix: string) => Array<{ value: string; label: string }> | null }> = [];

// A chat's session, as pi makes one: turri's extension built into it, and shown - its session_start told a context with
// the model registry the chats use. No /turri-config is ever run in it.
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
      const started: Array<(event: unknown, ctx: unknown) => void> = [];
      const api = new Proxy(
        {},
        {
          get: (_target, key) => {
            if (key === "on") return (event: string, handler: (event: unknown, ctx: unknown) => void) => (event === "session_start" ? started.push(handler) : undefined);
            if (key === "registerCommand") return (name: string, command: (typeof commands)[number]) => (name === "turri-config" ? commands.push(command) : undefined);
            return () => undefined;
          },
        },
      );
      for (const factory of resourceLoader.factories) factory(api);
      const context = new Proxy({ hasUI: false, modelRegistry: { getAvailable: () => MODELS } }, { get: (target, key) => (key in target ? target[key as keyof typeof target] : quiet()) });
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
  dir = mkdtempSync(join(tmpdir(), "turri-setting-choices-"));
  cwd = process.cwd();
  process.chdir(dir);
  commands.length = 0;
});
afterEach(() => {
  process.chdir(cwd);
  rmSync(dir, { recursive: true, force: true });
});

describe("a setting's values, for a host's settings list", () => {
  it("are every model of every provider signed in - whole, past what the terminal's completions show, and without unset", async () => {
    const turri = await createTurri();
    await turri.openChat();
    const choices = turri.settingChoices("harness-model");
    expect(choices).toHaveLength(60);
    expect(choices).toContain("anthropic/claude-00");
    expect(choices).toContain("openai/gpt-29");
    expect(choices).not.toContain("unset");
    expect(choices).toEqual(MODELS.map((model) => `${model.provider}/${model.id}`).sort());
    // The same values the chat's completions offer, in the same order: those cut at forty, unset among them when it fits.
    const completed = commands[0]!.getArgumentCompletions("harness-model ")!;
    expect(completed).toHaveLength(40);
    expect(completed.map((item) => item.label)).toEqual(choices.slice(0, 40));
    expect(turri.settingChoices("harness-model", "openai/")).toEqual(choices.filter((choice) => choice.startsWith("openai/")));
    await turri.dispose();
  });

  it("are a model's thinking levels after its colon, as the completions give them", async () => {
    const turri = await createTurri();
    await turri.openChat();
    expect(turri.settingChoices("harness-model", "anthropic/claude-07:")).toEqual(THINKING_LEVELS.map((level) => `anthropic/claude-07:${level}`));
    expect(turri.settingChoices("harness-model", "anthropic/claude-07:h")).toEqual(THINKING_LEVELS.filter((level) => level.startsWith("h")).map((level) => `anthropic/claude-07:${level}`));
    await turri.dispose();
  });

  it("are a setting's own options otherwise - and none for a key there is no setting of", async () => {
    const turri = await createTurri();
    await turri.openChat();
    expect(turri.settingChoices("review")).toEqual(["true", "false"]);
    expect(turri.settingChoices("testing-scripts-run-on")).toEqual(["in-place", "copy"]);
    expect(turri.settingChoices("no-such-setting")).toEqual([]);
    await turri.dispose();
  });
});
