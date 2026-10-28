import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const cultivate = (...args: string[]) => {
  const run = spawnSync(process.execPath, ["bin/turri.mjs", "cultivate", ...args], { encoding: "utf8" });
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

  it("asks for a skill when it is given none", () => {
    expect(cultivate()).toContain("usage: turri cultivate");
    expect(cultivate("--model", "anthropic/claude-opus-5-5")).toContain("usage: turri cultivate");
  });
});
