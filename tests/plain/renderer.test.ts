import { describe, expect, it } from "vitest";
import { marshallPlainSource, parsePlainSource } from "../../src/plain/parser.ts";
import {
  FUNCTIONAL_REQUIREMENTS,
  NON_FUNCTIONAL_REQUIREMENTS,
  getFunctionalSpecs,
  getSpecificationItems,
} from "../../src/plain/spec.ts";

/**
 * Regressions from running this parser against real specs.
 *
 * Every expected value here was taken from the Python implementation, not written by
 * hand: mdast and mistletoe disagree about inline decoding, list geometry and blank
 * lines in ways that only real documents expose.
 */
function marshal(source: string) {
  return marshallPlainSource(parsePlainSource(source, {}, [], [], []).plainSource);
}

const first = (source: string, heading = NON_FUNCTIONAL_REQUIREMENTS) =>
  getSpecificationItems(marshal(source), heading)![0]!;

/** The body of a module's first functional spec. */
const body = (text: string) => getFunctionalSpecs(marshal(`***implementation reqs***\n- Req.\n\n***functional specs***\n\n# f\n${text}`))[0]!.markdown;

describe("markdown rendering fidelity", () => {
  it("keeps backslash escapes that mdast decodes", () => {
    const item = first(
      `***implementation reqs***\n- Convert to json strings (e.g., "{\\"key1\\":\\"value1\\"}").\n`,
    );
    expect(item.markdown).toBe('- Convert to json strings (e.g., "{\\"key1\\":\\"value1\\"}").');
  });

  it("keeps the emphasis delimiter the source used", () => {
    const item = first("***implementation reqs***\n- Path is <:Node: name>_<index>.csv and _stressed_ text.\n");
    expect(item.markdown).toBe("- Path is <:Node: name>_<index>.csv and _stressed_ text.");
  });

  it("indents nested lists by the item's prepend, not the column gap", () => {
    const item = first(`***implementation reqs***
- Use the listing.
    - The ctx should contain fileCount.
        - Deeper still.
`);
    expect(item.markdown).toBe("- Use the listing.\n    - The ctx should contain fileCount.\n        - Deeper still.");
  });

  it("does not double-indent lazy paragraph continuation lines", () => {
    const item = first(`***implementation reqs***
- Outer item.
    - Inner paragraph line.
        -NotABullet continues the paragraph.
            - Looks like a bullet but is lazy.
`);

    expect(item.markdown).toBe(
      "- Outer item.\n    - Inner paragraph line.\n      -NotABullet continues the paragraph.\n      - Looks like a bullet but is lazy.",
    );
  });

  it("keeps a list under a paragraph in a functional spec's body where it is", () => {
    expect(body("Implement something nice and useful\n  - the nice thing should be really nice\n  - the useful thing should be really useful\n")).toBe(
      "Implement something nice and useful\n  - the nice thing should be really nice\n  - the useful thing should be really useful",
    );
  });

  it("takes the functional spec under a heading as the text, not the heading", () => {
    expect(getFunctionalSpecs(marshal("***implementation reqs***\n- Req.\n\n***functional specs***\n\n# f\nFirst.\n"))[0]!.id).toBe("f");
  });
});

/**
 * The six things a free-text body can hold that a bullet never did. Each expected value comes from reading
 * mistletoe's MarkdownRenderer (1.6.0): the reference parses inside the renderer's context, so every blank line is a
 * BlankLine token and survives.
 */
describe("functional spec bodies, as mistletoe renders them", () => {
  it("keeps two blank lines between paragraphs", () => {
    expect(body("First.\n\n\nSecond.\n")).toBe("First.\n\n\nSecond.");
  });

  it("keeps both blank lines around a comment between paragraphs", () => {
    expect(body("First.\n\n> a comment\n\nSecond.\n")).toBe("First.\n\n\nSecond.");
  });

  it("keeps a fence's delimiter and info string", () => {
    expect(body("Run it:\n\n~~~python title\nx = 1\n~~~\n")).toBe("Run it:\n\n~~~python title\nx = 1\n~~~");
  });

  it("keeps an indented code block's four spaces", () => {
    expect(body("Run it:\n\n    x = 1\n")).toBe("Run it:\n\n    x = 1");
  });

  it("keeps a thematic break as it is written", () => {
    expect(body("Above.\n\n___\n\nBelow.\n")).toBe("Above.\n\n___\n\nBelow.");
  });

  it("re-renders a table with every column at least three wide", () => {
    expect(body("Totals:\n\n| a | b |\n|---|---|\n| 1 | 2 |\n")).toBe("Totals:\n\n| a   | b   |\n| --- | --- |\n| 1   | 2   |");
  });

  it("aligns a table's columns as its separator row says", () => {
    expect(body("| left | centre | right |\n|:---|:---:|---:|\n| a | b | c |\n")).toBe(
      "| left | centre | right |\n| ---- | :----: | ----: |\n| a    |   b    |     c |",
    );
  });

  it("keeps one blank line after a list that ends before a paragraph, however many there were", () => {
    expect(body("- one\n- two\n\n\nAfter.\n")).toBe("- one\n- two\n\nAfter.");
  });

  it("keeps every blank line between the items of a list", () => {
    expect(body("- one\n\n\n- two\n")).toBe("- one\n\n\n- two");
  });
});

describe("functional spec sections", () => {
  it("reads every functional spec of the section", () => {
    const marshalled = marshal("***implementation reqs***\n- Req.\n\n***functional specs***\n\n# a\nA.\n\n# b\nB.\n");
    expect((marshalled[FUNCTIONAL_REQUIREMENTS] as Array<{ id: string }>).map((item) => item.id)).toEqual(["a", "b"]);
  });
});
