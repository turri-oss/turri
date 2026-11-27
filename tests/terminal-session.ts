import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession, ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { createTurri, type ExternalSessions, type Turri } from "@turri-dev/core";
import { createTerminal, type Terminal } from "../src/terminal-view.ts";

/**
 * turri's session with the terminal as its front end, as the tests open it - no model called: each chat's pi session is a
 * stand-in that has turri's extension built into it and does nothing else.
 */

/** pi's extension API as an extension is built into it: what it registers dropped, no tools. */
export function piApi(): ExtensionAPI {
  return new Proxy({}, {
    get: (_target, key) => {
      if (key === "getAllTools" || key === "getActiveTools" || key === "getCommands") return () => [];
      return () => undefined;
    },
  }) as ExtensionAPI;
}

/** A pi session as the terminal handles it: idle, kept by nothing, telling whether it was let go and what it was bound to. */
export function standInSession(name: string) {
  let ui: ExtensionUIContext | undefined;
  const session = {
    name,
    disposed: false,
    sessionFile: undefined,
    messages: [],
    isStreaming: false,
    isCompacting: false,
    isRetrying: false,
    isBashRunning: false,
    getSessionStats: () => ({ cost: 0 }),
    agent: { state: {} },
    subscribe: () => () => {},
    sessionManager: { getSessionName: () => undefined, getSessionDir: () => "/sessions", isPersisted: () => false, getBranch: () => [] },
    extensionRunner: {
      mode: "tui",
      getUIContext: () => ui,
      // As pi's runner keeps it: a copy, with its dialogs wrapped.
      setUIContext: (next: ExtensionUIContext) => {
        ui = { ...next };
      },
      createContext: () => ({}),
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

export interface OpenTerminal {
  turri: Turri;
  terminal: Terminal;
  /** The project's folder. */
  dir: string;
  /** The session let go, the folder removed, the working folder as it was. */
  close(): Promise<void>;
}

/**
 * The terminal on a session in a project of its own: `sessions` where its chats are made - by default stand-ins, turri's
 * extension built into each.
 */
export async function openTerminal(options: { config?: string; sessions?: (terminal: Terminal) => ExternalSessions } = {}): Promise<OpenTerminal> {
  const cwd = process.cwd();
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "turri-terminal-")));
  process.chdir(dir);
  writeFileSync(join(dir, "config.turri.yaml"), options.config ?? "sentinel: false\n");
  const terminal = createTerminal();
  let opened: Turri | undefined;
  const sessions =
    options.sessions?.(terminal) ??
    ({
      kind: "external",
      async create() {
        await opened!.extension(piApi());
        return standInSession("chat");
      },
    } satisfies ExternalSessions);
  try {
    opened = await createTurri({ frontend: { ...terminal.frontend, sessions } });
  } catch (error) {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  terminal.attach(opened);
  return {
    turri: opened,
    terminal,
    dir,
    async close() {
      await opened!.dispose();
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
