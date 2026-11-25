import { describe, expect, it } from "vitest";
import { capturePlan } from "../../src/capture/plan.ts";
import type { MapFile } from "../../src/capture/map.ts";

const source: MapFile = { path: "app.js", kind: "source", lines: 100, bytes: 4000, surfaces: [], imports: [] };
const plan = (...files: MapFile[]) => capturePlan({ root: ".", files }, 6000).kind;

describe("choosing a capture pipeline from the map", () => {
  it("counts test evidence and contracts, but a large collection of assets does not need more writers", () => {
    expect(plan(source, ...Array.from({ length: 100 }, () => ({ ...source, kind: "asset" as const })))).toBe("compact");
    expect(plan(source, { ...source, kind: "test", lines: 701 })).toBe("staged");
    expect(plan(source, { ...source, kind: "contract", bytes: 128_000 })).toBe("staged");
  });

  it("gives a short but interface-heavy or minified program the staged pipeline", () => {
    expect(plan({ ...source, surfaces: Array.from({ length: 13 }, (_, i) => ({ kind: "option", name: `--flag-${i}` })) })).toBe("staged");
    expect(plan({ ...source, lines: 1, bytes: 100_000 })).toBe("staged");
    expect(plan(...Array.from({ length: 13 }, (_, i) => ({ ...source, path: `m${i}.js`, lines: 2 })))).toBe("staged");
  });
});
