import { describe, expect, it } from "vitest";
import { capturePlan } from "../../src/capture/plan.ts";
import type { CodeMap, MapFile } from "../../src/capture/map.ts";

function map(files: number, lines: number, interfaces: number): CodeMap {
  return { root: ".", files: Array.from({ length: files }, (_, i): MapFile => ({
    path: `m${i}.js`, kind: "source", imports: [], lines: i === 0 ? lines - files + 1 : 1,
    surfaces: i === 0 ? Array.from({ length: interfaces }, (_, n) => ({ kind: "option", name: `--flag-${n}` })) : [],
  })) };
}

describe("choosing a capture pipeline from the map", () => {
  it.each([
    [28, 764, 3, "compact"],
    [64, 4000, 24, "compact"],
    [65, 4000, 24, "staged"],
    [21, 5326, 5, "staged"],
    [64, 4000, 25, "staged"],
    [65, 4001, 25, "staged"],
  ] as const)("selects %i files, %i lines and %i entries as %s", (files, lines, interfaces, kind) => {
    expect(capturePlan(map(files, lines, interfaces)).kind).toBe(kind);
  });

  it("reconsiders newly found interface entries under the same three thresholds", () => {
    const small = map(28, 764, 0);
    expect(capturePlan(small).kind).toBe("compact");
    expect(capturePlan(small, 25).kind).toBe("staged");
  });

  it("counts test and contract files but not test-only options or assets", () => {
    const code = map(65, 764, 0);
    code.files[1]!.kind = "contract";
    code.files[2]!.kind = "test";
    expect(capturePlan(code).kind).toBe("staged");
    code.files[1]!.kind = "asset";
    expect(capturePlan(code).kind).toBe("compact");
    const options = map(2, 764, 25);
    options.files[0]!.kind = "test";
    expect(capturePlan(options).kind).toBe("compact");
  });
});
