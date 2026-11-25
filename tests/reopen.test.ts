import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canReopen, REOPEN_FILE_ENV, reopenIn, takeReopening } from "../src/reopen.ts";

let dir = "";
let before: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "turri-reopen-"));
  before = process.env[REOPEN_FILE_ENV];
  delete process.env[REOPEN_FILE_ENV];
});
afterEach(() => {
  if (before === undefined) delete process.env[REOPEN_FILE_ENV];
  else process.env[REOPEN_FILE_ENV] = before;
  rmSync(dir, { recursive: true, force: true });
});

describe("a chat opened again in another folder", () => {
  it("is asked for through the file turri named, and taken by turri once - the folder, its arguments and what it is told", () => {
    const file = join(dir, "reopen.json");
    process.env[REOPEN_FILE_ENV] = file;
    expect(canReopen()).toBe(true);
    expect(reopenIn(join(dir, "plain"), { args: ["--model", "a/b", "--thinking", "medium"], env: { TOLD: "captured" } })).toBe(true);

    expect(takeReopening(file)).toEqual({ dir: join(dir, "plain"), args: ["--model", "a/b", "--thinking", "medium"], env: { TOLD: "captured" } });
    expect(existsSync(file)).toBe(false);
    expect(takeReopening(file)).toBeUndefined();
  });

  it("is never offered to a chat turri did not start, and nothing is written for it", () => {
    expect(canReopen()).toBe(false);
    expect(reopenIn(join(dir, "plain"))).toBe(false);
  });

  it("takes nothing from a file that does not say where", () => {
    const file = join(dir, "reopen.json");
    writeFileSync(file, JSON.stringify({ args: [] }));
    expect(takeReopening(file)).toBeUndefined();
    expect(existsSync(file)).toBe(false);
    writeFileSync(file, "not json");
    expect(takeReopening(file)).toBeUndefined();
  });
});
