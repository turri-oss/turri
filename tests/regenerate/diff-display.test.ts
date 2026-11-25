import { describe, expect, it } from "vitest";
import { summarizeDiff } from "../../src/regenerate/job-panel.ts";

const diff = [
  "diff --git a/backend.plain b/backend.plain",
  "--- a/backend.plain",
  "+++ b/backend.plain",
  "@@ -3,6 +3,8 @@",
  " - :User: is a registered student account.",
  "+",
  "+- :Kudo: is a unit of appreciation a :User: gives to a :StudySession:.",
  " ",
  "-- Old rule.",
  "+- A repeated :Kudo: has no further effect.",
  "",
].join("\n");

describe("showing a spec change", () => {
  it("sums it up in one line: the files, the lines, and what it is about", () => {
    expect(summarizeDiff(diff)).toBe("backend.plain +3 −1 · :Kudo: is a unit of appreciation a :User: gives to a :StudySession:.");
  });

});

describe("colouring a spec change", () => {
  const style = { added: (t: string) => `<green>${t}</green>`, removed: (t: string) => `<red>${t}</red>` };

  it("colours the counts in the summary line", () => {
    expect(summarizeDiff(diff, style)).toBe(
      "backend.plain <green>+3</green> <red>−1</red> · :Kudo: is a unit of appreciation a :User: gives to a :StudySession:.",
    );
  });
});
