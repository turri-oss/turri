import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { conceptBeingTyped, conceptsOf, findConcepts, plainGraph, STDLIB_KINDS, stdlibTemplates } from "../src/host.ts";
import { DEFAULT_CONCEPTS } from "../src/plain/concepts.ts";
import { STDLIB_ROOT } from "../src/plain/stdlib.ts";

let project: string;
beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), "turri-host-plain-"));
  mkdirSync(join(project, "template"));
  write("base.plain", "---\nexported_concepts:\n  - :Order:\n---\n\n***definitions***\n\n- :User: is a person who signs up.\n\n- :Order: is what a :User: pays for.\n\n- :Secret: is kept to itself.\n\n***implementation reqs***\n\n- :Implementation: is in Python.\n\n***functional specs***\n\n# sign-up\n:User: can sign up.\n");
  write("template/shared.plain", "***definitions***\n\n- :Money: is an amount in euros.\n");
  write("app.plain", "---\nimport:\n  - shared\n  - stdlib/backend/python-flask\nrequires:\n  - base\n---\n\n***definitions***\n\n- :Cart: is the :Order: a :User: is making, priced in :Money:.\n\n***functional specs***\n\n# fill-cart\n:User: can fill :Cart:.\n");
  write("broken.plain", "---\nimport:\n  - missing\n  - shared\nrequires:\n  - base\n  - nowhere\n---\n\n***definitions***\n\n- :Thing: is something.\n\n***functional specs***\n\n# thing-exists\n:Thing: exists.\n");
  for (const dir of ["docs", "data"]) mkdirSync(join(project, dir));
  for (const file of ["docs/style.md", "schema.json", "docs/api.md", "notes.txt", "data/sample.csv"]) write(file, "x\n");
  write(
    "linked.plain",
    [
      "***implementation reqs***",
      "",
      "- :Implementation: follows [the style](docs/style.md) and [the old guide](gone.md).",
      "",
      "***functional specs***",
      "",
      "# export",
      "Export the data as [the schema](schema.json) says and [the API](docs/api.md) shows,",
      "in the format [the notes](notes.txt) give.",
      "",
    ].join("\n"),
  );
  write("garbled.plain", "---\nimport: [shared\n---\n\n***functional specs***\n\n# it-works\nIt works.\n");
});
afterEach(() => rmSync(project, { recursive: true, force: true }));

function write(name: string, text: string): void {
  writeFileSync(join(project, name), text);
}

describe("the standard library for a host", () => {
  const templates = stdlibTemplates();
  const named = (name: string) => templates.find((template) => template.name === name)!;

  it("gives each template its kind, its file, and the modules its front matter imports", () => {
    const flask = named("stdlib/backend/python-flask");
    expect(flask).toMatchObject({ kind: "backend", file: join(STDLIB_ROOT, "stdlib/backend/python-flask.plain"), imports: ["stdlib/lang/python", "stdlib/backend/common"] });
    expect(named("stdlib/lang/python").kind).toBe("lang");
    for (const template of templates) expect(STDLIB_KINDS.map(({ kind }) => kind)).toContain(template.kind);
  });

  it("links a stack and its conformance template both ways, and gives common neither", () => {
    expect(named("stdlib/backend/python-flask").conformance).toBe("stdlib/backend/conformance/python-flask");
    expect(named("stdlib/backend/conformance/python-flask").tests).toBe("stdlib/backend/python-flask");
    expect(named("stdlib/backend/conformance/common").tests).toBeUndefined();
    expect(named("stdlib/backend/common").conformance).toBeUndefined();
  });

  it("lists the kinds in their order, languages last", () => {
    expect(STDLIB_KINDS.map(({ kind }) => kind)).toEqual(["backend", "frontend", "cli", "library", "lang"]);
  });
});

describe("a project's .plain files and their links", () => {
  const entry = (graph: ReturnType<typeof plainGraph>, module: string) => graph.modules.find((each) => each.module === module)!;
  const at = (file: string, line: number) => `${join(project, file)}:${line}`;

  it("resolves what each file imports and requires, the standard library's from turri's own folder", () => {
    const graph = plainGraph(project);
    const app = entry(graph, "app");
    expect(app.error).toBeUndefined();
    expect(app.imports).toEqual([
      { name: "shared", file: join(project, "template", "shared.plain") },
      { name: "stdlib/backend/python-flask", file: join(STDLIB_ROOT, "stdlib/backend/python-flask.plain") },
    ]);
    expect(app.requires).toEqual([{ name: "base", file: join(project, "base.plain") }]);
    // The templates it imports are in the graph too, with their own imports.
    expect(entry(graph, "stdlib/backend/python-flask").imports.map((link) => link.name)).toEqual(["stdlib/lang/python", "stdlib/backend/common"]);
  });

  it("gives each file what requires it and what imports it", () => {
    const graph = plainGraph(project);
    expect(entry(graph, "base").requiredBy.map((link) => link.name).sort()).toEqual(["app", "broken"]);
    expect(entry(graph, "shared").importedBy.map((link) => link.name).sort()).toEqual(["app", "broken"]);
    expect(entry(graph, "stdlib/backend/python-flask").importedBy).toEqual([{ name: "app", file: join(project, "app.plain") }]);
  });

  it("gives a file that does not parse what its front matter says, with the parser's error, and a missing module no file", () => {
    const graph = plainGraph(project);
    const broken = entry(graph, "broken");
    expect(broken.error).toMatch(/missing/);
    expect(broken.imports).toEqual([{ name: "missing", file: null }, { name: "shared", file: join(project, "template", "shared.plain") }]);
    expect(broken.requires).toEqual([{ name: "base", file: join(project, "base.plain") }, { name: "nowhere", file: null }]);
    const garbled = entry(graph, "garbled");
    expect(garbled.error).toMatch(/frontmatter/);
    expect(garbled.imports).toEqual([]);
  });
  it("gives each module its own items, each with its section, line, text and a functional spec's func-id - none of its imports'", () => {
    const graph = plainGraph(project);
    const app = entry(graph, "app");
    const items = app.items.map((id) => graph.items.find((item) => item.id === id)!);
    expect(items.map(({ section, line, funcId }) => ({ section, line, funcId }))).toEqual([
      { section: "definitions", line: 11, funcId: undefined },
      { section: "functional specs", line: 15, funcId: "fill-cart" },
    ]);
    expect(items[1]).toMatchObject({ id: at("app.plain", 15), file: join(project, "app.plain"), module: "app", text: ":User: can fill :Cart:." });
    expect(items[0]!.defines).toEqual([":Cart:"]);
  });

  it("links each concept an item names to the definition it is, through imports and required modules' exports", () => {
    const graph = plainGraph(project);
    const cart = graph.items.find((item) => item.id === at("app.plain", 11))!;
    expect(cart.uses).toEqual([
      { concept: ":Order:", definition: at("base.plain", 10) },
      { concept: ":User:", definition: at("base.plain", 8) },
      { concept: ":Money:", definition: at("template/shared.plain", 3) },
    ]);
    const reqs = graph.items.find((item) => item.id === at("base.plain", 16))!;
    expect(reqs.uses).toEqual([{ concept: ":Implementation:", definition: null }]);
  });

  it("gives each concept where it is defined and every item that names it, ***plain's own among them", () => {
    const graph = plainGraph(project);
    const user = graph.concepts.find((concept) => concept.concept === ":User:" && concept.definition === at("base.plain", 8))!;
    expect(user).toMatchObject({ module: "base", text: "is a person who signs up." });
    expect(user.usedBy.sort()).toEqual([at("app.plain", 11), at("app.plain", 15), at("base.plain", 10), at("base.plain", 20)].sort());
    const implementation = graph.concepts.find((concept) => concept.concept === ":Implementation:" && concept.module === null)!;
    expect(implementation.usedBy).toContain(at("base.plain", 16));
  });

  it("reads the items of a module that does not parse from its own text", () => {
    const graph = plainGraph(project);
    const items = entry(graph, "broken").items.map((id) => graph.items.find((item) => item.id === id)!);
    expect(items.map((item) => item.text)).toEqual(["- :Thing: is something.", ":Thing: exists."]);
    expect(items[1]!.uses).toEqual([{ concept: ":Thing:", definition: at("broken.plain", 12) }]);
  });
});

describe("the test plain files of a project", () => {
  const testPlain = (folder: string, name: string, text: string) => {
    mkdirSync(join(project, "tests", folder), { recursive: true });
    write(`tests/${folder}/${name}`, text);
  };

  it("are nodes linked to the functional spec they bind to, which carries its file and its scenarios", () => {
    testPlain("app", "fill-cart.plain", "---\nmodule: app\nfunc_id: fill-cart\n---\n\n***conformance tests***\n\n# adds-an-item\nAn item put in is in :Cart:.\n\n***acceptance tests***\n\n# pays\nA full :Cart: is paid for.\n");
    const graph = plainGraph(project);
    const file = graph.testPlainFiles.find((node) => node.file === join(project, "tests", "app", "fill-cart.plain"))!;
    const spec = graph.items.find((item) => item.funcId === "fill-cart")!;
    expect(file).toMatchObject({ module: "app", funcId: "fill-cart", item: spec.id });
    expect(file.conformance).toEqual([{ id: "adds-an-item", text: "An item put in is in :Cart:.", line: 8 }]);
    expect(file.acceptance.map((scenario) => [scenario.id, scenario.line])).toEqual([["pays", 13]]);
    expect(spec.testPlainFile).toBe(file.file);
    expect(spec.scenarios?.acceptance.map((scenario) => scenario.id)).toEqual(["pays"]);
    // One with no file has none.
    expect(graph.items.find((item) => item.funcId === "sign-up")).toMatchObject({ testPlainFile: null, scenarios: { conformance: [], acceptance: [] } });
  });

  it("gives a stray, an unparsable or an unbound one its error, bound to nothing", () => {
    testPlain("nowhere", "x.plain", "---\nmodule: nowhere\nfunc_id: x\n---\n\n***conformance tests***\n\n# works\nIt works.\n");
    testPlain("app", "gone.plain", "---\nmodule: app\nfunc_id: gone\n---\n\n***conformance tests***\n\n# works\nIt works.\n");
    testPlain("app", "bad.plain", "---\nmodule: app\nfunc_id: fill-cart\n---\n\n***acceptance tests***\n\n***conformance tests***\n");
    const nodes = plainGraph(project).testPlainFiles;
    const of = (folder: string, name: string) => nodes.find((node) => node.file === join(project, "tests", folder, name))!;
    expect(of("nowhere", "x.plain")).toMatchObject({ item: null, error: expect.stringContaining("no module nowhere") });
    expect(of("app", "gone.plain")).toMatchObject({ item: null, error: expect.stringContaining("no such functional spec") });
    expect(of("app", "bad.plain")).toMatchObject({ item: null, error: expect.any(String) });
  });
});

describe("the linked resources an item names", () => {
  const itemAt = (graph: ReturnType<typeof plainGraph>, file: string, line: number) => graph.items.find((item) => item.id === `${join(project, file)}:${line}`)!;

  it("gives each link with its text, its target, the file regenerating reads, and its line - two on one line, one on the next", () => {
    const spec = itemAt(plainGraph(project), "linked.plain", 7);
    expect(spec.resources.slice(0, 3)).toEqual([
      { text: "the schema", target: "schema.json", file: join(project, "schema.json"), line: 8 },
      { text: "the API", target: "docs/api.md", file: join(project, "docs/api.md"), line: 8 },
      { text: "the notes", target: "notes.txt", file: join(project, "notes.txt"), line: 9 },
    ]);
  });

  it("gives a link to a file that is not there no file, the module the parser's error", () => {
    const graph = plainGraph(project);
    expect(itemAt(graph, "linked.plain", 3).resources).toEqual([
      { text: "the style", target: "docs/style.md", file: join(project, "docs/style.md"), line: 3 },
      { text: "the old guide", target: "gone.md", file: null, line: 3 },
    ]);
    expect(graph.modules.find((module) => module.module === "linked")!.error).toMatch(/gone\.md does not exist/);
  });

  it("gives every item its resources, none when it names none", () => {
    const graph = plainGraph(project);
    for (const item of graph.items) expect(Array.isArray(item.resources), item.id).toBe(true);
    expect(itemAt(graph, "app.plain", 15).resources).toEqual([]);
  });
});

describe("the concepts a module can name", () => {
  const of = (file: string) => conceptsOf(join(project, file));

  it("gives its own, its imports', its required modules' exported ones and ***plain's own, each with where it is defined", () => {
    const concepts = of("app.plain");
    expect(concepts.filter((each) => each.module !== null)).toEqual(
      expect.arrayContaining([
        { concept: ":Cart:", definition: "is the :Order: a :User: is making, priced in :Money:.", module: "app" },
        { concept: ":Money:", definition: "is an amount in euros.", module: "shared" },
        { concept: ":Order:", definition: "is what a :User: pays for.", module: "base" },
        { concept: ":User:", definition: "is a person who signs up.", module: "base" },
      ]),
    );
    expect(concepts.map((each) => each.concept)).not.toContain(":Secret:");
    const own = concepts.filter((each) => each.module === null);
    expect(own.map((each) => each.concept)).toEqual([...DEFAULT_CONCEPTS]);
    for (const each of own) expect(each.definition).not.toBe("");
  });

  it("gives what it can of a module that does not parse: its own definitions and what it names that is there", () => {
    const concepts = of("broken.plain");
    expect(concepts.filter((each) => each.module !== null).map((each) => [each.concept, each.module])).toEqual([
      [":Money:", "shared"],
      [":Thing:", "broken"],
      [":Order:", "base"],
      [":User:", "base"],
    ]);
  });

  it("gives ***plain's own of a file that is not there, and throws nothing", () => {
    expect(of("nothing.plain").map((each) => each.module)).toEqual([...DEFAULT_CONCEPTS].map(() => null));
  });
});

describe("concepts in a piece of text", () => {
  it("finds each concept written, with where it is", () => {
    expect(findConcepts("A :User: fills :Cart: - not : this, nor :two words:.")).toEqual([
      { concept: ":User:", start: 2, end: 8 },
      { concept: ":Cart:", start: 15, end: 21 },
    ]);
  });

  it("spots a concept being typed, and none once it is closed", () => {
    expect(conceptBeingTyped("Then :Us")).toEqual({ typed: ":Us", start: 5 });
    expect(conceptBeingTyped("Then :")).toEqual({ typed: ":", start: 5 });
    expect(conceptBeingTyped("Then :User:")).toBeUndefined();
    expect(conceptBeingTyped("Then :User: and")).toBeUndefined();
  });
});

describe("where a module's test plain files are", () => {
  it("is the project's tests folder unless test-dir names another, its stack's over the project's", async () => {
    const { DEFAULT_TEST_DIR, testDirOf } = await import("../src/host.ts");
    expect(DEFAULT_TEST_DIR).toBe("tests");
    writeFileSync(join(project, "config.turri.yaml"), "");
    expect(testDirOf(join(project, "app.plain"))).toBe(join(project, "tests"));
    writeFileSync(join(project, "config.turri.yaml"), "test-dir: scenarios\n");
    expect(testDirOf(join(project, "app.plain"))).toBe(join(project, "scenarios"));
    writeFileSync(join(project, "config.turri.backend.yaml"), "test-dir: backend-tests\n");
    writeFileSync(join(project, "backend.plain"), "***functional specs***\n\n# ping\nIt answers.\n");
    expect(testDirOf(join(project, "backend.plain"))).toBe(join(project, "backend-tests"));
  });
});
