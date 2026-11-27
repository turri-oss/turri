import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const piVersion = () => JSON.parse(readFileSync("package.json", "utf8")).dependencies["@earendil-works/pi-coding-agent"] as string;
describe("turri --version", () => {
  it("is answered by turri, not passed to pi - with -v too - its version line first, then where this turri is and every turri on the PATH", () => {
    expect(piVersion()).toMatch(/^\d+\.\d+\.\d+/);
    for (const flag of ["--version", "-v"]) {
      const lines = execFileSync(process.execPath, ["bin/turri.mjs", flag], { encoding: "utf8" }).trim().split("\n");
      expect(lines[0]).toMatch(new RegExp(`^turri \\S+.*\\(pi ${piVersion()!.replace(/\./g, "\\.")}\\)$`));
      expect(lines[1]).toContain(resolve("."));
      expect(lines.some((line) => line.startsWith("  turri on PATH"))).toBe(true);
    }
  });
});
