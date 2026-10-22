import type { AgentSession, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { currentChat, inChat } from "../src/chat-scope.ts";
import { createChats, MAX_CHATS, scopedToChat, type ChatLink, type TurriCore } from "../src/chats.ts";
import { chooseStack, chosenStack } from "../src/config.ts";
import { createJobRegistry, type Job } from "../src/regenerate/jobs.ts";
import { OPTION_AS_META, tellOfOptionOnce } from "../src/chat-commands.ts";

/** A pi session as the session follows it: its events, sent by the test. */
function fakeSession() {
  const listeners = new Set<(event: { type: string }) => void>();
  const session = {
    subscribe: (listener: (event: { type: string }) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    sessionFile: undefined,
    messages: [],
    sessionManager: { getSessionName: () => undefined },
    extensionRunner: { getUIContext: () => undefined },
  } as unknown as AgentSession;
  return { session, emit: (type: string) => listeners.forEach((listener) => listener({ type })) };
}

/** A session whose chats live nowhere but here: each chat's extension links itself, and is told what ends. */
function session() {
  const told = new Map<string, string[]>();
  const links: ChatLink[] = [];
  const sessions = new Map<string, ReturnType<typeof fakeSession>>();
  let core: TurriCore;
  const jobs = createJobRegistry({ onFinish: (job) => core.jobFinished(job) });
  core = createChats({
    cwd: process.cwd(),
    host: {},
    jobs,
    extension: (_pi, link) => {
      links.push(link);
      link.live({
        announce: (job: Job) => told.set(link.id, [...(told.get(link.id) ?? []), job.summary]),
        jobsChanged: () => {},
        thinkingLevel: () => undefined,
        context: () => undefined,
      });
    },
  });
  core.setDriver({
    async create(chat) {
      core.extension({} as ExtensionAPI);
      const made = fakeSession();
      sessions.set(chat.id, made);
      chat.session = made.session;
    },
    async dispose() {},
  });
  return { core, jobs, told, links, sessions };
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("the chats of a session", () => {
  it(`opens up to ${MAX_CHATS} chats, each shown as it opens, and refuses one more`, async () => {
    const { core } = session();
    for (let index = 0; index < MAX_CHATS; index += 1) await core.open();
    expect(core.chats()).toHaveLength(MAX_CHATS);
    expect(core.chats().filter((chat) => chat.shown).map((chat) => chat.id)).toEqual([core.chats().at(-1)!.id]);
    await expect(core.open()).rejects.toThrow(`${MAX_CHATS} chats are open, the most there can be: close one first.`);
  });

  it("calls a chat nothing was said in a new chat", async () => {
    const { core } = session();
    await core.open();
    await core.open();
    expect(core.chats().map((chat) => chat.title)).toEqual(["new chat", "new chat"]);
  });

  it("opens a chat hidden when asked, leaving the one shown as it is", async () => {
    const { core } = session();
    const first = await core.open();
    await core.open({ hidden: true });
    expect(core.shown()).toBe(first.id);
  });

  it("tells the chat that asked for a pulse how it went, shown or not", async () => {
    const { core, jobs, told, links } = session();
    await core.open();
    await core.open();
    const [asker] = links;
    inChat(asker!.scope, () => jobs.start({ kind: "render", summary: "app pulse 1", run: async () => ({ report: "done" }) }));
    await settled();
    expect(told.get(asker!.id)).toEqual(["app pulse 1"]);
    expect(told.get(links[1]!.id)).toBeUndefined();
    expect(core.chats().find((chat) => chat.id === asker!.id)?.status).toBe("unread");
  });

  it("tells the chat shown of a pulse whose chat was closed", async () => {
    const { core, jobs, told, links } = session();
    await core.open();
    await core.open();
    const [asker, other] = links;
    let finish: () => void = () => {};
    inChat(asker!.scope, () => jobs.start({ kind: "render", summary: "app pulse 2", run: () => new Promise((resolve) => (finish = () => resolve({ report: "done" }))) }));
    await core.close(asker!.id);
    finish();
    await settled();
    expect(told.get(other!.id)).toEqual(["app pulse 2"]);
  });

  it("shows the next chat when the one shown is closed", async () => {
    const { core } = session();
    const first = await core.open();
    const second = await core.open();
    await core.show(first.id);
    await core.close(first.id);
    expect(core.shown()).toBe(second.id);
    expect(core.chats().map((chat) => chat.id)).toEqual([second.id]);
  });

  it("says a hidden chat is working, then that it has something new, until it is shown", async () => {
    const { core, sessions } = session();
    const hidden = await core.open();
    await core.open();
    const status = () => core.chats().find((chat) => chat.id === hidden.id)?.status;
    sessions.get(hidden.id)!.emit("agent_start");
    expect(status()).toBe("working");
    sessions.get(hidden.id)!.emit("agent_end");
    expect(status()).toBe("unread");
    await core.show(hidden.id);
    expect(status()).toBe("idle");
  });

  it("has one chat and nowhere to open another without a driver", async () => {
    const core = createChats({ cwd: process.cwd(), host: {}, jobs: createJobRegistry(), extension: () => {} });
    expect(core.canOpen).toBe(false);
    await expect(core.open()).rejects.toThrow("This turri has one chat");
  });
});

describe("what each chat keeps for itself", () => {
  it("keeps the stack it chose, apart from the other chats' and the command line's", () => {
    const backend = { id: "a", stack: undefined };
    const frontend = { id: "b", stack: undefined };
    inChat(backend, () => chooseStack("backend"));
    inChat(frontend, () => chooseStack("frontend"));
    expect(inChat(backend, () => chosenStack())).toBe("backend");
    expect(inChat(frontend, () => chosenStack())).toBe("frontend");
    expect(chosenStack()).toBe(process.env.TURRI_STACK?.trim() || undefined);
  });

  it("starts a chat with the stack the command line chose", async () => {
    const before = process.env.TURRI_STACK;
    process.env.TURRI_STACK = "backend";
    try {
      const { core, links } = session();
      await core.open();
      expect(links[0]!.scope.stack).toBe("backend");
      expect(core.chats()).toHaveLength(1);
    } finally {
      if (before === undefined) delete process.env.TURRI_STACK;
      else process.env.TURRI_STACK = before;
    }
  });

  it("runs every tool, command and handler a chat's extension registers in the chat's scope", async () => {
    const registered: Record<string, (...args: unknown[]) => unknown> = {};
    const pi = {
      registerTool: (tool: { name: string; execute: (...args: unknown[]) => unknown }) => (registered[tool.name] = tool.execute),
      registerCommand: (name: string, command: { handler: (...args: unknown[]) => unknown }) => (registered[`/${name}`] = command.handler),
      on: (event: string, handler: (...args: unknown[]) => unknown) => (registered[event] = handler),
    } as unknown as ExtensionAPI;
    const scoped = scopedToChat(pi, { id: "c1", stack: undefined });
    scoped.registerTool({ name: "t", execute: async () => currentChat()?.id } as never);
    scoped.registerCommand("c", { handler: async () => currentChat()?.id } as never);
    scoped.on("agent_end", (() => currentChat()?.id) as never);
    expect(await registered.t!()).toBe("c1");
    expect(await registered["/c"]!()).toBe("c1");
    expect(registered.agent_end!()).toBe("c1");
    expect(currentChat()).toBeUndefined();
  });
});

describe("the alt keys on a Mac", () => {
  it("says once, as the second chat opens, that Option has to be sent as Meta", async () => {
    const { core } = session();
    const said: string[] = [];
    core.notify = (message) => said.push(message);
    tellOfOptionOnce(core, "darwin");
    tellOfOptionOnce(core, "darwin");
    await core.open();
    await settled();
    expect(said).toEqual([]);
    await core.open();
    await core.open();
    await settled();
    expect(said).toEqual([OPTION_AS_META]);
  });

  it("says nothing where alt is alt", async () => {
    const { core } = session();
    const said: string[] = [];
    core.notify = (message) => said.push(message);
    tellOfOptionOnce(core, "linux");
    await core.open();
    await core.open();
    await settled();
    expect(said).toEqual([]);
  });
});
