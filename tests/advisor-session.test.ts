import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const { createTurriCore, sessionAdvisor } = await import("../src/extension.ts");

describe("where the test advisor runs", () => {
  const cwd = process.cwd();
  beforeEach(() => {
    process.chdir(mkdtempSync(join(tmpdir(), "turri-advisor-session-")));
    writeFileSync("config.turri.yaml", "sentinel: false\n");
  });
  afterEach(() => process.chdir(cwd));

  it("is in the chat's session and a host's, and not in pi's print, json and rpc modes", () => {
    expect(sessionAdvisor(createTurriCore({}, { persist: true, advisor: true }))).toBeDefined();
    // pi's print, json and rpc modes make the session with no options, as pi builds turri's file into itself.
    expect(sessionAdvisor(createTurriCore())).toBeUndefined();
  });

  it("is never made by a headless command, which builds its own work loop", () => {
    // turri regenerate, conform, change-plain... all run through loop-cli.ts: it makes no session, and no advisor.
    const source = readFileSync(join(cwd, "src", "loop-cli.ts"), "utf8");
    expect(source).not.toMatch(/createTestAdvisor|createTurriCore|onSpec/);
  });
});
