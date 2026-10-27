import { describe, expect, it } from "vitest";
import { highlightLines, roleOf } from "../../src/plain/highlight.ts";

/** Each line as its pieces and what each is: `text|role`, nothing as `-`. */
const read = (lines: string[]) => highlightLines(lines).map((tokens) => tokens.map((token) => `${token.text}|${roleOf(token.scopes) ?? "-"}`));

describe("***plain, highlighted by turri's own grammar", () => {
  it("tells a section's header, a concept, a name in backticks, text in quotes, a link and a comment apart", () => {
    expect(read(["***functional specs***", '- :User: sets `HUBSPOT_TOKEN` to "on", as [the docs](docs/a.md) say.', "> not built"])).toEqual([
      ["***functional specs***|section"],
      ["-|bullet", " |-", ":User:|concept", " sets |-", "`HUBSPOT_TOKEN`|literal", " to |-", '"on"|literal', ", as |-", "[the docs](docs/a.md)|link", " say.|-"],
      ["> not built|comment"],
    ]);
  });

  it("carries the front matter from the line that opens it to the one that closes it - its keys and the modules it names", () => {
    expect(read(["---", "import:", "  - crm_common", "requires:", "  - base", "---", "import: is text again"])).toEqual([
      ["---|-"],
      ["import:|keyword"],
      ["  - |-", "crm_common|module"],
      ["requires:|keyword"],
      ["  - |-", "base|module"],
      ["---|-"],
      ["import: is text again|-"],
    ]);
  });

  it("reads a test plain file - its module: as a module, its func_id:, both sections, and each scenario's id heading", () => {
    expect(read(["---", "module: todo", "func_id: add-task", "---", "", "***conformance tests***", "", "# rejects-empty-title", "An empty title is refused.", "", "***acceptance tests***"])).toEqual([
      ["---|-"],
      ["module:|keyword", " |-", "todo|module"],
      ["func_id:|keyword", " add-task|-"],
      ["---|-"],
      [],
      ["***conformance tests***|section"],
      [],
      ["# rejects-empty-title|id"],
      ["An empty title is refused.|-"],
      [],
      ["***acceptance tests***|section"],
    ]);
  });

  it("reads a functional spec's func-id heading as an id, and a section header only at the start of a line", () => {
    expect(read(["# add-task", "A :User: can add a task.", "    ***acceptance tests***"])).toEqual([
      ["# add-task|id"],
      ["A |-", ":User:|concept", " can add a task.|-"],
      ["    ***acceptance tests***|-"],
    ]);
  });

  it("leaves text with nothing in it as it is", () => {
    expect(read(["Plain words.", ""])).toEqual([["Plain words.|-"], []]);
  });
});
