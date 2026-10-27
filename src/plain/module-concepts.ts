import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { resolveTemplateDirs } from "../regenerate/paths.ts";
import { DEFAULT_CONCEPT_DEFINITIONS, definitionText, extractConceptsFromDefinition } from "./concepts.ts";
import { renderToMarkdown, type AnyNode } from "./markdown.ts";
import {
  exportedDefinitionsOf,
  IMPORT_DIRECTIVE,
  parsePlainFile,
  parsePlainSource,
  PLAIN_SOURCE_FILE_EXTENSION,
  readPlainSourceMetadata,
  REQUIRES_DIRECTIVE,
  restoreStrippedLines,
  sectionOf,
  type PlainFileParseResult,
} from "./parser.ts";
import { DEFINITIONS } from "./spec.ts";

/** A concept a module can name, what it is, and the module that defines it - null for ***plain's own. */
export interface ModuleConcept {
  concept: string;
  /** The definition's text after its concepts: `is a person who signs up`. */
  definition: string;
  module: string | null;
}

/** A module as the parser reads it, for what it names: its own parse, and every definition it can name. */
export interface ReadModule {
  /** Its parse, its imports merged in - or, when that fails, its own text read without them; undefined when neither reads. */
  parsed?: PlainFileParseResult;
  /** Its own definitions, those its imports bring and those its required modules export, each with the module it is written in. */
  definitions: Array<{ node: AnyNode; module: string }>;
}

/**
 * A module read for what it can name, as the parser builds its definitions: its own, its imports' (`import`), and its
 * required modules' `exported_concepts` with the definitions they use. Never throws: a module that does not parse
 * gives its own definitions read without its imports, and what of those it names is there.
 */
export function readModule(moduleName: string, plainFile: string, templateDirs: string[]): ReadModule {
  const parse = (name: string) => attempt(() => parsePlainFile(name, {}, templateDirs, [], []));
  const definitions: ReadModule["definitions"] = [];
  const add = (result: PlainFileParseResult, nodes: AnyNode[], module: string) => {
    for (const node of nodes) definitions.push({ node, module: result.importedFrom.get(node) ?? module });
  };
  const definitionsOf = (result: PlainFileParseResult) => sectionOf(result.plainSource, DEFINITIONS)?.children ?? [];

  let requires: string[];
  let parsed = parse(moduleName);
  if (parsed !== undefined) {
    add(parsed, definitionsOf(parsed), moduleName);
    requires = parsed.requiredModules;
  } else {
    // What its front matter names, each read on its own, and its own text without them.
    const text = attempt(() => readFileSync(plainFile, "utf8"));
    const front = text === undefined ? undefined : attempt(() => readPlainSourceMetadata(text));
    for (const name of namesIn(front?.metadata[IMPORT_DIRECTIVE])) {
      const imported = parse(name);
      if (imported !== undefined) add(imported, definitionsOf(imported), name);
    }
    parsed = front && attempt(() => parsePlainSource(restoreStrippedLines(text!, front.content), {}, templateDirs, [], [moduleName]));
    if (parsed !== undefined) add(parsed, definitionsOf(parsed), moduleName);
    requires = namesIn(front?.metadata[REQUIRES_DIRECTIVE]);
  }

  for (const name of requires) {
    const required = parse(name);
    const exported = required && attempt(() => exportedDefinitionsOf(required));
    if (required !== undefined && exported !== undefined) add(required, exported, name);
  }
  return { ...(parsed !== undefined ? { parsed } : {}), definitions };
}

/**
 * Every concept a module can name: its own definitions, those its imports bring, those its required modules export,
 * and ***plain's own - read as the parser reads them. A module that does not parse gives what can be read of it.
 */
export function conceptsOf(plainFile: string, templateDirs: string[] = resolveTemplateDirs(plainFile)): ModuleConcept[] {
  const found: ModuleConcept[] = [];
  const seen = new Set<string>();
  for (const { node, module } of readModule(basename(plainFile, PLAIN_SOURCE_FILE_EXTENSION), plainFile, templateDirs).definitions) {
    const text = renderToMarkdown(node);
    for (const concept of extractConceptsFromDefinition(text)[0]) {
      if (seen.has(`${concept}\0${module}`)) continue;
      seen.add(`${concept}\0${module}`);
      found.push({ concept, definition: definitionText(text), module });
    }
  }
  for (const [concept, definition] of Object.entries(DEFAULT_CONCEPT_DEFINITIONS)) found.push({ concept, definition, module: null });
  return found;
}

export function attempt<T>(run: () => T): T | undefined {
  try {
    return run();
  } catch {
    return undefined;
  }
}

export function namesIn(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((name): name is string => typeof name === "string") : [];
}
