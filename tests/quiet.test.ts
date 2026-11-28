import { describe, expect, it } from "vitest";
import { dropNoise } from "../src/quiet.ts";

describe("warnings nobody can act on", () => {
  it("are dropped for good, and nothing else is", () => {
    const printed: unknown[][] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => void printed.push(args);
    try {
      dropNoise();
      console.warn("Both GOOGLE_API_KEY and GEMINI_API_KEY are set. Using GOOGLE_API_KEY.");
      console.warn("something that matters");
      expect(printed).toEqual([["something that matters"]]);
    } finally {
      console.warn = warn;
    }
  });
});
