import { Markdown } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { highlightPlain, highlightPlainCodeBlocks, isPlainBlock, isPlainLanguage } from "../src/plain-code-blocks.ts";

/** pi-tui's Markdown with a theme that marks what the theme itself highlighted. */
function markdown(text: string): Markdown {
  const same = (value: string) => value;
  const theme = {
    heading: same,
    link: same,
    linkUrl: same,
    code: same,
    codeBlock: same,
    codeBlockBorder: same,
    quote: same,
    quoteBorder: same,
    hr: same,
    listBullet: same,
    bold: same,
    italic: same,
    underline: same,
    strikethrough: same,
    highlightCode: (code: string, lang?: string) => code.split("\n").map((line) => `[${lang}]${line}`),
  };
  return new Markdown(text, 0, 0, theme);
}

const SECTION_PINK = "38;2;255;127;166";

describe("***plain in the chat's code blocks", () => {
  it("is highlighted by turri's grammar in a fence of plain, every other fence left to the theme", () => {
    highlightPlainCodeBlocks(() => ({ appearance: "dark", getColorMode: () => "truecolor" }));
    const plain = markdown("```plain\n***functional specs***\n\n# add-note\nA :User: can add a :Note:.\n```").render(80).join("\n");
    expect(plain).toContain(SECTION_PINK);
    expect(plain).not.toContain("[plain]");

    const python = markdown("```python\nprint('hi')\n```").render(80).join("\n");
    expect(python).toContain("[python]print('hi')");
    expect(python).not.toContain("\x1b[");
  });

  it("knows a fence with no language as ***plain by a section's header in it", () => {
    highlightPlainCodeBlocks(() => ({ appearance: "dark", getColorMode: () => "truecolor" }));
    expect(markdown("```\n***functional specs***\n\n# add-note\nA :User: can add a :Note:.\n```").render(80).join("\n")).toContain(SECTION_PINK);
    expect(isPlainBlock(undefined, "---\nimport:\n  - shared\n---\n\n***functional specs***\n")).toBe(true);
    expect(isPlainBlock("", "just some ***bold italics*** in text")).toBe(false);
    expect(isPlainBlock("markdown", "***functional specs***")).toBe(false);
  });

  it("knows ***plain by the fence's language", () => {
    expect(["plain", "***plain", "Plain"].map(isPlainLanguage)).toEqual([true, true, true]);
    expect(["plaintext", "text", undefined].map(isPlainLanguage)).toEqual([false, false, false]);
  });

  it("paints each piece by its role and the text around it as given", () => {
    const [line] = highlightPlain("A :User: can add a :Note:.", (role, text) => `<${role}>${text}</${role}>`, (text) => `{${text}}`);
    expect(line).toBe("{A }<concept>:User:</concept>{ can add a }<concept>:Note:</concept>{.}");
  });
});
