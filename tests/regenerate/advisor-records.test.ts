import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { advisorModel, readProjectConfig } from "../../src/config.ts";
import {
  advisorEntry,
  advisorPath,
  isCurrent,
  pendingEntries,
  putAdvisorEntry,
  readAdvisor,
  removeAdvisorEntry,
  textHash,
} from "../../src/regenerate/advisor-records.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "turri-advisor-records-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("the test-advisor setting and the advisor role", () => {
  it("leaves the advisor on unless test-advisor is false", () => {
    expect(readProjectConfig(dir).testAdvisor).toBeUndefined();
    writeFileSync(join(dir, "config.turri.yaml"), "test-advisor: false\n");
    expect(readProjectConfig(dir).testAdvisor).toBe(false);
    writeFileSync(join(dir, "config.turri.yaml"), "test_advisor: true\n");
    expect(readProjectConfig(dir).testAdvisor).toBe(true);
  });

  it("runs the advisor on the coding model alone when models: names no advisor, and on models.advisor - or default - when it does", () => {
    writeFileSync(join(dir, "config.turri.yaml"), "harness-model: a/talk:high\ncoding-model: b/code:medium\n");
    expect(advisorModel(readProjectConfig(dir))).toBe("b/code");
    writeFileSync(join(dir, "config.turri.yaml"), "harness-model: a/talk:high\ncoding-model: b/code:medium\nmodels:\n  default: c/cheap\n");
    expect(advisorModel(readProjectConfig(dir))).toBe("c/cheap");
    writeFileSync(join(dir, "config.turri.yaml"), "coding-model: b/code\nmodels:\n  default: c/cheap\n  advisor: { model: d/fast, thinking: minimal }\n");
    expect(advisorModel(readProjectConfig(dir))).toBe("d/fast:minimal");
    writeFileSync(join(dir, "config.turri.yaml"), "harness-model: a/talk\n");
    expect(advisorModel(readProjectConfig(dir))).toBe("a/talk");
  });
});

describe("the advisor file", () => {
  it("round-trips an entry and its report, in .turri/advisor/<module>.json", () => {
    const report = { verdict: "yes" as const, questions: [{ question: "silent-failure" as const, evidence: "returns 3 for 2 + 2" }], inputs: [{ input: "2 + 2", agreed: "4" }, { input: "2 + -2", readings: ["0", "an error"] }] };
    putAdvisorEntry(dir, "core", "core.plain", { funcId: "add", hash: textHash("Adds two numbers."), state: "yes", report, model: "d/fast", tip: "app.plain" });
    putAdvisorEntry(dir, "core", "core.plain", { funcId: "sub", hash: textHash("Subtracts."), state: "pending" });
    expect(existsSync(advisorPath(dir, "core"))).toBe(true);
    // .turri ignores itself, as every scratch folder of turri's does.
    expect(readFileSync(join(dir, ".turri", ".gitignore"), "utf8")).toContain("*");
    const file = readAdvisor(dir, "core")!;
    expect(file.module).toBe("core");
    expect(file.plainFile).toBe("core.plain");
    expect(file.entries.add).toMatchObject({ funcId: "add", state: "yes", report, model: "d/fast", tip: "app.plain" });
    expect(typeof file.entries.add!.at).toBe("string");
    expect(pendingEntries(dir)).toEqual([{ module: "core", plainFile: "core.plain", entry: expect.objectContaining({ funcId: "sub" }) }]);
    removeAdvisorEntry(dir, "core", "sub");
    expect(advisorEntry(dir, "core", "sub")).toBeUndefined();
    expect(pendingEntries(dir)).toEqual([]);
  });

  it("makes an entry stale once the functional spec's text changes, and not for whitespace around it", () => {
    putAdvisorEntry(dir, "core", "core.plain", { funcId: "add", hash: textHash("Adds two numbers."), state: "no" });
    const entry = advisorEntry(dir, "core", "add");
    expect(isCurrent(entry, textHash("  Adds two numbers.\n"))).toBe(true);
    expect(isCurrent(entry, textHash("Adds two or more numbers."))).toBe(false);
    expect(isCurrent(undefined, textHash("Adds two numbers."))).toBe(false);
  });

  it("reads nothing from a file that is not there or does not parse", () => {
    expect(readAdvisor(dir, "core")).toBeUndefined();
    putAdvisorEntry(dir, "core", "core.plain", { funcId: "add", hash: "x", state: "pending" });
    writeFileSync(advisorPath(dir, "core"), "{ not json");
    expect(readAdvisor(dir, "core")).toBeUndefined();
    expect(pendingEntries(dir)).toEqual([]);
  });
});
