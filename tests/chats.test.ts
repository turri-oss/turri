import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OPTION_AS_META, tellOfOptionOnce } from "../src/chat-commands.ts";
import { openTerminal, type OpenTerminal } from "./terminal-session.ts";

const settled = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("the alt keys on a Mac", () => {
  let open: OpenTerminal;
  let platform: PropertyDescriptor | undefined;
  beforeEach(async () => {
    // The chats' own /chat says it on this machine's platform: here, the platform each test names.
    platform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "linux" });
    open = await openTerminal();
  });
  afterEach(async () => {
    await open.close();
    if (platform !== undefined) Object.defineProperty(process, "platform", platform);
  });

  it("says once, as the second chat opens, that Option has to be sent as Meta", async () => {
    const { turri, terminal } = open;
    const said: string[] = [];
    terminal.notify = (message) => void said.push(message);
    tellOfOptionOnce(terminal, "darwin");
    tellOfOptionOnce(terminal, "darwin");
    await turri.chats.open();
    await settled();
    expect(said).toEqual([]);
    await turri.chats.open();
    await turri.chats.open();
    await settled();
    expect(said).toEqual([OPTION_AS_META]);
  });

  it("says nothing where alt is alt", async () => {
    const { turri, terminal } = open;
    const said: string[] = [];
    terminal.notify = (message) => void said.push(message);
    tellOfOptionOnce(terminal, "linux");
    await turri.chats.open();
    await turri.chats.open();
    await settled();
    expect(said).toEqual([]);
  });
});
