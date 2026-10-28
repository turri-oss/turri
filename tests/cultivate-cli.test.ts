import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const TURRI = resolve("bin/turri.mjs");

// An empty folder for a project: a skill that starts keeps its run there.
let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "turri-cultivate-")));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const cultivate = (...args: string[]) => {
  const run = spawnSync(process.execPath, [TURRI, "cultivate", ...args], { cwd: dir, encoding: "utf8" });
  return `${run.stdout}${run.stderr}`;
};

describe("turri cultivate", () => {
  it("takes the skill it is given, with --model or without it", () => {
    for (const said of [cultivate("no-such-skill"), cultivate("--model", "anthropic/claude-opus-5-5", "no-such-skill"), cultivate("no-such-skill", "--model", "anthropic/claude-opus-5-5")]) {
      expect(said).not.toContain("usage: turri cultivate");
      expect(said).toContain("No skill named no-such-skill");
      expect(said).toContain("implement-unit-testing-script");
    }
  });

  it("ends on what went wrong, not on a stack trace, as the other commands do", () => {
    const said = cultivate("implement-unit-testing-script", "--model", "nope/no-such-model");
    expect(said).toContain("is not a model pi knows");
    expect(said).not.toMatch(/^\s+at /m);
  });

  it("asks for a skill when it is given none", () => {
    expect(cultivate()).toContain("usage: turri cultivate");
    expect(cultivate("--model", "anthropic/claude-opus-5-5")).toContain("usage: turri cultivate");
  });
});
