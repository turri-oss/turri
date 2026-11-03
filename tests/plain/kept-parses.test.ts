import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parsePlainFile, plainFileParser, sectionOf, withParseCache } from "../../src/plain/parser.ts";
import { renderToMarkdown } from "../../src/plain/markdown.ts";
import type { MarshalledPlainSource } from "../../src/plain/spec.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "turri-kept-parses-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const write = (name: string, text: string) => {
  mkdirSync(join(dir, name, ".."), { recursive: true });
  writeFileSync(join(dir, name), text);
};

/** The definitions a module's parse has, as text. */
const definitions = (tree: MarshalledPlainSource) => JSON.stringify(tree["definitions"] ?? []);

const parse = (name: string, dirs = [dir]) => plainFileParser(`${name}.plain`, dirs, { allowNoFunctionalities: true })[1];

const APP = (front: string) => `---\n${front}\n---\n\n***implementation reqs***\n\n- Python.\n\n***functional specs***\n\n# serve\nServe the :Thing:.\n`;

describe("a parse kept between calls", () => {
  it("sees an imported module changed since", () => {
    write("lib.plain", "***definitions***\n\n- :Thing: is a box.\n");
    write("app.plain", APP("import:\n  - lib"));
    expect(definitions(parse("app"))).toContain("a box");
    write("lib.plain", "***definitions***\n\n- :Thing: is a crate.\n");
    expect(definitions(parse("app"))).toContain("a crate");
  });

  it("sees a definition a required module exports changed since - in a chain parsed inside one look, and again after it", () => {
    write("base.plain", "---\nexported_concepts:\n  - :Thing:\n---\n\n***definitions***\n\n- :Thing: is a box.\n\n***implementation reqs***\n\n- Python.\n\n***functional specs***\n\n# store\nStore the :Thing:.\n");
    write("app.plain", APP("requires:\n  - base"));
    expect(withParseCache(() => definitions(parse("app")))).toContain("a box");
    write("base.plain", "---\nexported_concepts:\n  - :Thing:\n---\n\n***definitions***\n\n- :Thing: is a crate.\n\n***implementation reqs***\n\n- Python.\n\n***functional specs***\n\n# store\nStore the :Thing:.\n");
    expect(withParseCache(() => definitions(parse("app")))).toContain("a crate");
    expect(definitions(parse("app"))).toContain("a crate");
  });

  it("sees a module written since in a folder looked in before the one it was read from", () => {
    const template = join(dir, "template");
    write("template/lib.plain", "***definitions***\n\n- :Thing: is a box.\n");
    write("app.plain", APP("import:\n  - lib"));
    expect(definitions(parse("app", [dir, template]))).toContain("a box");
    write("lib.plain", "***definitions***\n\n- :Thing: is a crate.\n");
    expect(definitions(parse("app", [dir, template]))).toContain("a crate");
  });

  it("sees a Liquid include changed since", () => {
    write("thing.md", "a box");
    write("app.plain", "***definitions***\n\n- :Thing: is {% include 'thing.md' %}.\n\n***implementation reqs***\n\n- Python.\n\n***functional specs***\n\n# serve\nServe the :Thing:.\n");
    expect(definitions(parse("app"))).toContain("a box");
    write("thing.md", "a crate");
    expect(definitions(parse("app"))).toContain("a crate");
  });

  it("hands each caller its own copy: what one caller changes, the next parse does not have", () => {
    write("lib.plain", "***definitions***\n\n- :Thing: is a box.\n");
    write("app.plain", APP("import:\n  - lib"));
    const first = parse("app");
    (first["definitions"] as unknown[]).length = 0;
    expect(definitions(parse("app"))).toContain("a box");
  });

  it("of a file parsed on its own sees each file it read - itself, an import, an include - changed since, though no bigger", () => {
    const own = () => (sectionOf(parsePlainFile("app", {}, [dir], [], []).plainSource, "definitions")?.children ?? []).map((node) => renderToMarkdown(node)).join("\n");
    write("lib.plain", "***definitions***\n\n- :Other: is a box.\n");
    write("thing.md", "a box");
    write("app.plain", "---\nimport:\n  - lib\n---\n\n***definitions***\n\n- :Thing: is {% include 'thing.md' %}.\n");
    expect(own()).toContain(":Thing: is a box");
    write("thing.md", "a bag");
    expect(own()).toContain(":Thing: is a bag");
    write("lib.plain", "***definitions***\n\n- :Other: is a bag.\n");
    expect(own()).toContain(":Other: is a bag");
    write("app.plain", "---\nimport:\n  - lib\n---\n\n***definitions***\n\n- :Thing: is {% include 'thing.md' %}!\n");
    expect(own()).toContain(":Thing: is a bag!");
  });
});
