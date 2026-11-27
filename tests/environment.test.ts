import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { versionLine } from "../src/cli-root.ts";
const piVersion = () => JSON.parse(readFileSync("package.json", "utf8")).dependencies["@earendil-works/pi-coding-agent"] as string;
describe("turri --version", () => {
  it("says turri's version with the core's and pi's beside it - from a clone, its commit too, as the banner does", () => {
    const core = { version: "0.2.0", commit: null, changed: null, pi: "1.6.0" };
    expect(versionLine(core, { version: "0.1.6", git_commit: null, git_dirty: null })).toBe("turri 0.1.6 (core 0.2.0; pi 1.6.0)");
    expect(versionLine({ ...core, commit: "7aceaa0b1c2d", changed: false }, { version: "0.1.1", git_commit: "336dd6e0f1a2b3c4", git_dirty: true })).toBe(
      "turri 0.1.1, from a clone, 336dd6e with changes (core 0.2.0, from a clone, 7aceaa0; pi 1.6.0)",
    );
    expect(versionLine({ version: null, commit: null, changed: null, pi: null }, { version: "0.1.1", git_commit: null, git_dirty: null })).toBe("turri 0.1.1");
  });

  it("is answered by turri, not passed to pi - with -v too - its version line first, then where this turri is and every turri on the PATH", () => {
    expect(piVersion()).toMatch(/^\d+\.\d+\.\d+/);
    for (const flag of ["--version", "-v"]) {
      const lines = execFileSync(process.execPath, ["bin/turri.mjs", flag], { encoding: "utf8" }).trim().split("\n");
      expect(lines[0]).toMatch(new RegExp(`^turri \\S+.*\\(core \\S+.*; pi ${piVersion()!.replace(/\./g, "\\.")}\\)$`));
      expect(lines[1]).toContain(resolve("."));
      expect(lines.some((line) => line.startsWith("  turri on PATH"))).toBe(true);
    }
  });
});
