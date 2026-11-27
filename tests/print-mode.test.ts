import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { createTurri } from "@turri-dev/core";
import { afterEach, beforeEach, expect, it } from "vitest";
import { adoptAsBound } from "../src/print-mode.ts";
import { piApi, standInSession } from "./terminal-session.ts";

const cwd = process.cwd();
let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "turri-print-")));
  process.chdir(dir);
  writeFileSync(join(dir, "config.turri.yaml"), "sentinel: false\n");
});
afterEach(() => {
  process.chdir(cwd);
  rmSync(dir, { recursive: true, force: true });
});

/** A pi session of `prototype`'s, as print mode binds it: its own stand-in fields, its bindExtensions the prototype's. */
function printSession(name: string, prototype: object): AgentSession {
  const { bindExtensions: _own, ...fields } = standInSession(name);
  return Object.assign(Object.create(prototype), fields) as AgentSession;
}

it("adopts the session pi's print mode binds as the one chat of a session with no front end, and keeps it on the one pi binds next", async () => {
  const turri = await createTurri({ persist: false });
  const bound: unknown[] = [];
  // pi's AgentSession, as far as print mode binds it.
  const prototype = { bindExtensions: async function (this: unknown) { bound.push(this); } };
  const put = adoptAsBound(turri, prototype as unknown as Pick<AgentSession, "bindExtensions">);
  try {
    const session = printSession("print", prototype);
    await turri.extension(piApi());
    await session.bindExtensions({});
    expect(bound).toEqual([session]);
    const [chat] = turri.chats.list();
    expect(turri.chats.list()).toHaveLength(1);
    expect(turri.chats.get(chat!.id)?.session).toBe(session);
    expect(turri.chats.focused()).toBe(chat!.id);
    // rpc's new session: built for the chat, and adopted into it.
    const next = printSession("next", prototype);
    await turri.extension(piApi());
    await next.bindExtensions({});
    expect(turri.chats.list().map((info) => info.id)).toEqual([chat!.id]);
    expect(turri.chats.get(chat!.id)?.session).toBe(next);
  } finally {
    put();
    await turri.dispose();
  }
});
