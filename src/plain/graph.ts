import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { resolveTemplateDirs } from "../regenerate/paths.ts";
import { locateModule } from "../regenerate/requires.ts";
import { resourceFile } from "../regenerate/resources.ts";
import { DEFAULT_CONCEPT_DEFINITIONS, DEFAULT_CONCEPTS, definitionText, extractConceptsFromDefinition, findConcepts } from "./concepts.ts";
import { lineNumber, renderToMarkdown, renderTokens, type AnyNode } from "./markdown.ts";
import { attempt, namesIn, readModule } from "./module-concepts.ts";
import {
  IMPORT_DIRECTIVE,
  linksIn,
  modulePlainFile,
  parsePlainFile,
  PLAIN_SOURCE_FILE_EXTENSION,
  plainFileParser,
  readPlainSourceMetadata,
  REQUIRES_DIRECTIVE,
  functionalitiesOf,
  sectionOf,
  withParseCache,
} from "./parser.ts";
import { DEFINITIONS, FUNCTIONAL_REQUIREMENTS, NON_FUNCTIONAL_REQUIREMENTS, TEST_REQUIREMENTS } from "./spec.ts";
import { isStdlibModule } from "./stdlib.ts";
import { discoverTestPlainFiles, readTestPlainFileText } from "./project.ts";
import { parseTestPlainFileSource, type Scenario } from "./test-plain-file.ts";
import { testDirOf } from "../config.ts";
import { strayTestPlainFiles } from "../test-plain-files.ts";

/**
 * A project's ***plain as a graph, to go from one place in it to another: its modules, each item of their sections,
 * and the concepts - an item linked to its module, to the concepts it names and to where each is defined, a module to
 * what it imports and requires and to what imports and requires it.
 */
export interface PlainGraph {
  modules: PlainModuleNode[];
  items: PlainItemNode[];
  concepts: PlainConceptNode[];
  /** The test plain files in the project's test folder, each linked to the functional spec it binds to. */
  testPlainFiles: PlainTestPlainFileNode[];
}

/** A scenario of a test plain file: its scenario-id, its text, and the line its `# <scenario-id>` heading is on. */
export interface PlainScenario {
  id: string;
  text: string;
  line: number;
}

/**
 * A test plain file: the functional spec it binds to - its `module:` and `func_id:`, and that functional spec's item -
 * and its scenarios. A file that does not parse, is outside its module's folder or binds to no functional spec has
 * `error`, and `item` null.
 */
export interface PlainTestPlainFileNode {
  file: string;
  module: string | null;
  funcId: string | null;
  /** The functional spec's item id, or null. */
  item: string | null;
  conformance: PlainScenario[];
  acceptance: PlainScenario[];
  error?: string;
}

/** A module one .plain file names, and the file it is - null when it is not found. */
export interface PlainLink {
  name: string;
  file: string | null;
}

/** A .plain file: what it imports and requires, what imports and requires it, its items, and why it does not parse. */
export interface PlainModuleNode {
  file: string;
  module: string;
  /** Resolved as the parser reads an import: a standard library module from turri's `stdlib/`. */
  imports: PlainLink[];
  /** Resolved as the requires chain finds a required module. */
  requires: PlainLink[];
  importedBy: PlainLink[];
  requiredBy: PlainLink[];
  /** Its own items, in the order they are written: their ids. */
  items: string[];
  /** The parser's message, when the file does not parse. Its links are then what its front matter says, its items what of its own text reads. */
  error?: string;
}

export type PlainSection = typeof DEFINITIONS | typeof NON_FUNCTIONAL_REQUIREMENTS | typeof TEST_REQUIREMENTS | typeof FUNCTIONAL_REQUIREMENTS;

/** An item of a section: a list item, or a functional spec - its heading's line, its body's text. */
export interface PlainItemNode {
  /** `<file>:<line>`. */
  id: string;
  file: string;
  module: string;
  section: PlainSection;
  /** The line it starts on, from 1. */
  line: number;
  text: string;
  /** A functional spec's func-id, its `# <func-id>` heading. */
  funcId?: string;
  /** A functional spec's test plain file, and its scenarios - none when it has no file, or an empty one. */
  testPlainFile?: string | null;
  scenarios?: { conformance: PlainScenario[]; acceptance: PlainScenario[] };
  /** The concepts a definition defines. */
  defines: string[];
  /** The concepts it names, each with the definition it is - an item's id - or null for ***plain's own and one defined nowhere it can see. */
  uses: Array<{ concept: string; definition: string | null }>;
  /**
   * The linked resources it names - `[text](target)` as the parser reads
   * them - with the file each is read from when regenerating, null when it is not there, and the line the link is on.
   */
  resources: Array<{ text: string; target: string; file: string | null; line: number }>;
}

/** A concept as defined in one place - or ***plain's own - and every item that names it there. */
export interface PlainConceptNode {
  concept: string;
  /** The item that defines it; null for ***plain's own. */
  definition: string | null;
  module: string | null;
  /** The definition's text after its concepts. */
  text: string;
  usedBy: string[];
}

const SECTIONS: PlainSection[] = [DEFINITIONS, NON_FUNCTIONAL_REQUIREMENTS, TEST_REQUIREMENTS, FUNCTIONAL_REQUIREMENTS];

/**
 * A project's ***plain as a graph: every .plain file in its folder and its `template/` folder, and every module they
 * import or require, wherever the parser finds it, the standard library's too. Never throws: a file that does not
 * parse is given with what its front matter says, what of its own text reads, and the error.
 */
export function plainGraph(projectDir: string): PlainGraph {
  const root = resolve(projectDir);
  // The folders a .plain file of the project is read with: its own, its template/ folder, PLAIN_TEMPLATE_DIRS.
  const dirs = resolveTemplateDirs(join(root, `project${PLAIN_SOURCE_FILE_EXTENSION}`));
  const modules = new Map<string, PlainModuleNode>();
  const queue: PlainModuleNode[] = [];
  const visit = (file: string, module: string) => {
    if (modules.has(file)) return;
    const node: PlainModuleNode = { file, module, imports: [], requires: [], importedBy: [], requiredBy: [], items: [] };
    modules.set(file, node);
    queue.push(node);
  };
  for (const dir of [root, join(root, "template")]) {
    const names = attempt(() => readdirSync(dir).filter((name) => name.endsWith(PLAIN_SOURCE_FILE_EXTENSION)).sort()) ?? [];
    for (const name of names) visit(join(dir, name), basename(name, PLAIN_SOURCE_FILE_EXTENSION));
  }

  for (let node = queue.shift(); node !== undefined; node = queue.shift()) {
    let metadata: Record<string, unknown> = {};
    try {
      metadata = readPlainSourceMetadata(readFileSync(node.file, "utf8")).metadata;
    } catch (error) {
      node.error = messageOf(error);
    }
    node.imports = namesIn(metadata[IMPORT_DIRECTIVE]).map((name) => ({ name, file: modulePlainFile(name, dirs) }));
    node.requires = namesIn(metadata[REQUIRES_DIRECTIVE]).map((name) => ({ name, file: attempt(() => locateModule(name, dirs)) ?? null }));
    for (const link of [...node.imports, ...node.requires]) if (link.file !== null) visit(link.file, link.name);
  }
  for (const node of modules.values()) {
    for (const link of node.imports) if (link.file !== null) modules.get(link.file)!.importedBy.push({ name: node.module, file: node.file });
    for (const link of node.requires) if (link.file !== null) modules.get(link.file)!.requiredBy.push({ name: node.module, file: node.file });
  }

  return withParseCache(() => {
    const items: PlainItemNode[] = [];
    const concepts = new Map<string, PlainConceptNode>();
    for (const [concept, text] of Object.entries(DEFAULT_CONCEPT_DEFINITIONS)) concepts.set(`${concept}\0`, { concept, definition: null, module: null, text, usedBy: [] });

    const lines = new Map<string, string[]>();
    const idOf = (node: AnyNode, file: string) => `${file}:${lineOf(node, file, lines)}`;
    const fileOf = (module: string, node: PlainModuleNode) => (module === node.module ? node.file : modulePlainFile(module, dirs));

    for (const node of modules.values()) {
      if (node.error === undefined) node.error = parseError(node, dirs);
      const read = readModule(node.module, node.file, dirs);
      // Where each concept it can name is defined, the first definition winning, as the parser's checks find one.
      const visible = new Map<string, string>();
      for (const { node: definition, module } of read.definitions) {
        const file = fileOf(module, node);
        if (file === null) continue;
        const id = idOf(definition, file);
        const text = renderToMarkdown(definition);
        for (const concept of extractConceptsFromDefinition(text)[0]) {
          if (!visible.has(concept)) visible.set(concept, id);
          if (!concepts.has(`${concept}\0${id}`)) concepts.set(`${concept}\0${id}`, { concept, definition: id, module, text: definitionText(text), usedBy: [] });
        }
      }

      for (const section of SECTIONS) {
        // An item of a list section is its list item; a functional spec is its `# <func-id>` heading and its body.
        const own: Array<{ nodes: AnyNode[]; line: number; parsedLine: number; text: string; funcId?: string }> = [];
        if (read.parsed !== undefined && section === FUNCTIONAL_REQUIREMENTS) {
          for (const functionality of functionalitiesOf(read.parsed.plainSource)) {
            const at = lineOf({ type: "heading", position: { start: { line: functionality.lineNumber, column: 1 }, end: { line: functionality.lineNumber, column: 1 } } }, node.file, lines, { needle: `# ${functionality.id}` });
            own.push({ nodes: functionality.body, line: at, parsedLine: functionality.lineNumber, text: renderTokens(functionality.body), funcId: functionality.id });
          }
        } else {
          for (const item of ((read.parsed && sectionOf(read.parsed.plainSource, section)?.children) ?? []).filter((item) => !read.parsed!.importedFrom.has(item))) {
            own.push({ nodes: [item], line: lineOf(item, node.file, lines), parsedLine: lineNumber(item), text: renderToMarkdown(item).trim() });
          }
        }
        for (const { nodes, line, parsedLine, text, funcId } of own) {
          const defines = section === DEFINITIONS ? extractConceptsFromDefinition(text)[0] : [];
          const named = [...new Set(findConcepts(text).map((found) => found.concept))].filter((concept) => !defines.includes(concept));
          const id = `${node.file}:${line}`;
          // A link is on the line the parser has it on, moved as Liquid moved its item.
          const resources = nodes.flatMap((item) => linksIn(item)).map(({ text, target, node: link }) => ({
            text,
            target,
            file: resourceFile(target, dirs),
            line: lineOf(link, node.file, lines, { at: lineNumber(link) + line - parsedLine, needle: `](${target})`, from: line }),
          }));
          const uses = named.map((concept) => ({ concept, definition: DEFAULT_CONCEPTS.has(concept) ? null : (visible.get(concept) ?? null) }));
          for (const use of uses) concepts.get(`${use.concept}\0${use.definition ?? ""}`)?.usedBy.push(id);
          items.push({ id, file: node.file, module: node.module, section, line, text, ...(funcId !== undefined ? { funcId } : {}), defines, uses, resources });
          node.items.push(id);
        }
      }
    }
    const testPlainFiles = testPlainFileNodes(root, dirs, items, lines);
    return { modules: [...modules.values()], items, concepts: [...concepts.values()], testPlainFiles };
  });
}

/**
 * The test plain files under the project's test folder, each parsed for its binding and its scenarios, and linked to the
 * functional spec it binds to - that item given its file and its scenarios. A stray one, one that does not parse, or one
 * that binds to no functional spec has its error.
 */
function testPlainFileNodes(root: string, dirs: string[], items: PlainItemNode[], lines: Map<string, string[]>): PlainTestPlainFileNode[] {
  const testDir = testDirOf(join(root, `project${PLAIN_SOURCE_FILE_EXTENSION}`));
  const strays = new Map((attempt(() => strayTestPlainFiles(root)) ?? []).map((stray) => [resolve(root, stray.file), stray.problem]));
  for (const item of items) if (item.funcId !== undefined) Object.assign(item, { testPlainFile: null, scenarios: { conformance: [], acceptance: [] } });
  return (attempt(() => discoverTestPlainFiles([testDir], root)) ?? []).map(([path, name]): PlainTestPlainFileNode => {
    const node: PlainTestPlainFileNode = { file: path, module: null, funcId: null, item: null, conformance: [], acceptance: [] };
    let parsed: ReturnType<typeof parseTestPlainFileSource>;
    try {
      parsed = parseTestPlainFileSource(readTestPlainFileText(path, name), name, dirs, {});
    } catch (error) {
      return { ...node, error: messageOf(error) };
    }
    const scenarios = (list: Scenario[]) =>
      list.map((scenario) => ({ id: scenario.id, text: scenario.text, line: lineOf({ type: "heading", position: { start: { line: scenario.lineNumber, column: 1 }, end: { line: scenario.lineNumber, column: 1 } } } as AnyNode, path, lines, { needle: `# ${scenario.id}` }) }));
    Object.assign(node, { module: parsed.module, funcId: parsed.funcId, conformance: scenarios(parsed.conformanceTests), acceptance: scenarios(parsed.acceptanceTests) });
    const stray = strays.get(path);
    if (stray !== undefined) return { ...node, error: stray };
    const bound = items.find((item) => item.module === parsed.module && item.funcId === parsed.funcId && item.section === FUNCTIONAL_REQUIREMENTS);
    if (bound === undefined) return { ...node, error: `${name} binds to ${parsed.module}:${parsed.funcId}, and there is no such functional spec` };
    bound.testPlainFile = path;
    bound.scenarios = { conformance: node.conformance, acceptance: node.acceptance };
    return { ...node, item: bound.id };
  });
}

/** Why a module does not parse: an import module as an import is parsed, a module of its own as one - functional specs or not yet. */
function parseError(node: PlainModuleNode, dirs: string[]): string | undefined {
  const imported = node.importedBy.length > 0 || isStdlibModule(node.module) || basename(dirname(node.file)) === "template";
  try {
    if (imported) parsePlainFile(node.module, {}, dirs, [], []);
    else plainFileParser(`${node.module}${PLAIN_SOURCE_FILE_EXTENSION}`, dirs, { allowNoFunctionalities: true });
    return undefined;
  } catch (error) {
    return messageOf(error);
  }
}

/**
 * The line an item starts on in its file. The parser's is a line of the text after Liquid has run, which is the file's
 * own unless an include or a tag changed the lines above it: then the first line of the file that has the item's
 * first line is taken. A link is looked for so too - by its `](target)`, from its item's line on.
 */
function lineOf(node: AnyNode, file: string, cache: Map<string, string[]>, look: { at?: number; needle?: string; from?: number } = {}): number {
  let lines = cache.get(file);
  if (lines === undefined) {
    lines = (attempt(() => readFileSync(file, "utf8")) ?? "").split(/\r?\n/);
    cache.set(file, lines);
  }
  const at = look.at ?? lineNumber(node);
  const needle = look.needle ?? renderToMarkdown(node).trim().split("\n")[0]!.replace(/^[-*+]\s+/, "").trim();
  if (needle === "" || lines[at - 1]?.includes(needle)) return at;
  const from = Math.max(0, (look.from ?? 1) - 1);
  const found = lines.findIndex((line, index) => index >= from && line.includes(needle));
  return found === -1 ? at : found + 1;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
