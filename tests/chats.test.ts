import { describe, expect, it } from "vitest";
import { OPTION_AS_META, tellOfOptionOnce } from "../src/chat-commands.ts";
import { createTurriCore } from "@turri-dev/core/terminal";

function session() {
  const core = createTurriCore();
  core.setDriver({ async create() { core.extension(new Proxy({}, { get: () => () => {} }) as never); }, async dispose() {} });
  return { core };
}
const settled = () => new Promise((resolve) => setTimeout(resolve, 20));
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
