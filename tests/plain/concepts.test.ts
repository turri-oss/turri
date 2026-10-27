import { describe, expect, it } from "vitest";
import { extractConceptsFromDefinition, sortDefinitions } from "../../src/plain/concepts.ts";
import { PlainSyntaxError } from "../../src/plain/errors.ts";

/** Port of tests/test_concept_utils.py. */

const definitions = (...markdown: string[]) => markdown.map((line) => ({ markdown: line }));
const definedConcepts = (sorted: Array<{ markdown: string }>) =>
  sorted.map((definition) => extractConceptsFromDefinition(definition.markdown)[0][0]);

function sortError(defs: Array<{ markdown: string }>): string {
  try {
    sortDefinitions(defs);
  } catch (error) {
    expect(error).toBeInstanceOf(PlainSyntaxError);
    return (error as Error).message;
  }
  throw new Error("the definitions sorted");
}

const separateTwoCycles = (count: number) =>
  Array.from({ length: count }, (_, i) => [`- :A${i}: uses :B${i}:.`, `- :B${i}: uses :A${i}:.`]).flat();
const cycleLines = (message: string) => message.split("\n").filter((line) => line.startsWith("Cycle "));

describe("sorting definitions", () => {
  it("leaves a single definition as it is", () => {
    const defs = definitions("- :A: is x.");
    sortDefinitions(defs);
    expect(definedConcepts(defs)).toEqual([":A:"]);
  });

  it("keeps the file order of definitions that mention no concept", () => {
    const defs = definitions("- :B: is y.", "- :A: is x.");
    sortDefinitions(defs);
    expect(definedConcepts(defs)).toEqual([":B:", ":A:"]);
  });

  it("puts a dependency before its dependant", () => {
    const defs = definitions("- :B: uses :A:.", "- :A: is x.");
    sortDefinitions(defs);
    expect(definedConcepts(defs)).toEqual([":A:", ":B:"]);
  });

  it("resolves diamond dependencies", () => {
    const defs = definitions("- :D: uses :B: and :C:.", "- :B: uses :A:.", "- :C: uses :A:.", "- :A: is x.");
    sortDefinitions(defs);
    const order = definedConcepts(defs);
    expect(order.indexOf(":A:")).toBeLessThan(order.indexOf(":B:"));
    expect(order.indexOf(":B:")).toBeLessThan(order.indexOf(":D:"));
    expect(order.indexOf(":A:")).toBeLessThan(order.indexOf(":C:"));
    expect(order.indexOf(":C:")).toBeLessThan(order.indexOf(":D:"));
  });

  it("follows references in sub-bullets", () => {
    const defs = definitions("- :B: is y.\n  - it uses :A:.", "- :A: is x.");
    sortDefinitions(defs);
    expect(definedConcepts(defs)).toEqual([":A:", ":B:"]);
  });

  it("puts a definition of several concepts before its dependants", () => {
    const defs = definitions("- :C: uses :A: and :B:.", "- :A:, :B: are twins.");
    sortDefinitions(defs);
    expect(definedConcepts(defs)).toEqual([":A:", ":C:"]);
  });

  it("ignores a concept that mentions itself", () => {
    const defs = definitions("- :B: uses :A:.", "- :A: is like :A:.");
    sortDefinitions(defs);
    expect(definedConcepts(defs)).toEqual([":A:", ":B:"]);
  });

  it("ignores predefined concepts", () => {
    const defs = definitions("- :B: uses :A: and :Implementation:.", "- :A: is x.");
    sortDefinitions(defs);
    expect(definedConcepts(defs)).toEqual([":A:", ":B:"]);
  });

  it("rejects a two-node cycle, listing both definitions", () => {
    const message = sortError(definitions("- :A: uses :B:.", "- :B: uses :A:."));
    expect(message).toContain("Cycles are not allowed");
    expect(message).toContain("- :A: uses :B:.");
    expect(message).toContain("- :B: uses :A:.");
  });

  it("rejects a long cycle, listing every definition on it and none off it", () => {
    const message = sortError(definitions("- :A: uses :B:.", "- :B: uses :C:.", "- :C: uses :A:.", "- :D: is on its own."));
    for (const definition of ["- :A: uses :B:.", "- :B: uses :C:.", "- :C: uses :A:."]) expect(message).toContain(definition);
    expect(message).not.toContain("- :D: is on its own.");
  });

  it("rejects a cycle through a definition of several concepts", () => {
    expect(sortError(definitions("- :A:, :B: use :C:.", "- :C: uses :B:."))).toContain("Cycles are not allowed");
  });

  it("reports both of two separate cycles", () => {
    const message = sortError(definitions("- :A: uses :B:.", "- :B: uses :A:.", "- :X: uses :Y:.", "- :Y: uses :X:."));
    expect(message).toContain("Found 2 cycle");
    expect(message).toContain("Cycle 1: :A: -> :B: -> :A:");
    expect(message).toContain("Cycle 2: :X: -> :Y: -> :X:");
  });

  it("reports every elementary cycle of a tangle", () => {
    const message = sortError(
      definitions(
        "- :Order: is placed by a :Customer: and billed by an :Invoice:.",
        "- :Customer: has :Order: items and :Invoice: items.",
        "- :Invoice: bills an :Order: to a :Customer:.",
      ),
    );
    expect(message).toContain("Found 5 cycle");
    expect(message.split("Cycle ").length - 1).toBe(5);
  });

  it("caps the number of cycles it reports", () => {
    const message = sortError(
      definitions(
        "- :Order: is placed by a :Customer:, billed by an :Invoice:, settled by a :Payment:.",
        "- :Customer: has :Order:, :Invoice: and :Payment: items.",
        "- :Invoice: bills an :Order: to a :Customer: and is settled by a :Payment:.",
        "- :Payment: settles an :Invoice: for an :Order: by a :Customer:.",
      ),
    );
    expect(message).toContain("Found more than 10 cycles");
    expect(message).toContain("Showing the first 10.");
    expect(message.split("Cycle ").length - 1).toBe(10);
  });

  it("reports a cycle in the order its concepts refer to each other", () => {
    const message = sortError(definitions("- :A: uses :B:.", "- :B: uses :C:.", "- :C: uses :A:."));
    expect(message).toContain("Cycle 1: :A: -> :B: -> :C: -> :A:\n- :A: uses :B:.\n- :B: uses :C:.\n- :C: uses :A:.");
  });

  it("rejects a cycle that also mentions an undefined concept", () => {
    expect(sortError(definitions("- :A: uses :B: and :Ghost:.", "- :B: uses :A:."))).toContain("Cycles are not allowed");
  });

  it("reports exactly the maximum without cutting the report short", () => {
    const message = sortError(definitions(...separateTwoCycles(10)));
    expect(message).toContain("Found 10 cycle(s)");
    expect(message).not.toContain("Showing");
    expect(cycleLines(message)).toHaveLength(10);
  });

  it("shows the earliest defined cycles when the report is cut short", () => {
    const lines = cycleLines(sortError(definitions(...separateTwoCycles(12))));
    expect(lines[0]).toBe("Cycle 1: :A0: -> :B0: -> :A0:");
    expect(lines[lines.length - 1]).toBe("Cycle 10: :A9: -> :B9: -> :A9:");
  });

  it("cuts the report short by definition order, not first mention", () => {
    // :A10: and :A11: are mentioned on the first line but defined last, so their cycles are not among the first 10.
    const defs = separateTwoCycles(12);
    defs[0] = "- :A0: uses :B0:, :A10: and :A11:.";
    const lines = cycleLines(sortError(definitions(...defs)));
    expect(lines[lines.length - 1]).toBe("Cycle 10: :A9: -> :B9: -> :A9:");
    expect(lines.filter((line) => /:A1[01]:/.test(line))).toEqual([]);
  });

  it("prints a definition shared by a cycle's concepts once per cycle", () => {
    const message = sortError(definitions("- :A:, :B: use :X: and :Y:.", "- :X: uses :B:.", "- :Y: uses :A:."));
    const blocks = message.split("\n\n").slice(1);
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) expect(block.split("- :A:, :B: use :X: and :Y:.").length - 1).toBe(1);
  });
});
