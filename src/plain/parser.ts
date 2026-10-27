import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import { extname, isAbsolute, basename, join, resolve } from "node:path";
import { load as loadYaml } from "js-yaml";
import {
  extractConceptsFromDefinition,
  findConceptDefinitionsInPlainSource,
  sortDefinitions,
  validateConcepts,
  DEFAULT_CONCEPTS,
} from "./concepts.ts";
import {
  ImportedModuleWithFunctionalitiesError,
  MissingFunctionalitiesError,
  ModuleDoesNotExistError,
  PlainSyntaxError,
  UnsupportedBase64Content,
} from "./errors.ts";
import { findIn, findLargeBase64Blob, getLoadedTemplates, openFrom } from "./files.ts";
import { renderPlainSource } from "./liquid.ts";
import { isStdlibModule, readStdlibModule, stdlibModuleFile } from "./stdlib.ts";
import {
  getRawText,
  lineNumber,
  parseMarkdown,
  removeQuotes,
  renderToMarkdown,
  renderTokens,
  traverse,
  type AnyNode,
  type LinkedResource,
  type Section,
} from "./markdown.ts";
import {
  ACCEPTANCE_TESTS,
  ACCEPTANCE_TEST_HEADING,
  ALLOWED_IMPORT_SPECIFICATION_HEADINGS,
  ALLOWED_SPECIFICATION_HEADINGS,
  CONFORMANCE_TESTS,
  CONFORMANCE_TEST_HEADING,
  DEFINITIONS,
  FUNCTIONAL_REQUIREMENTS,
  LIST_SECTION_HEADINGS,
  NON_FUNCTIONAL_REQUIREMENTS,
  TEST_PLAIN_FILES,
  TEST_REQUIREMENTS,
  getFunctionalSpecs,
  getSpecificationItems,
  isSemanticId,
  REQUIRED_FUNCTIONAL_SPECS,
  type CodeVariable,
  type FunctionalSpecItem,
  type InheritedSpecificationItem,
  type MarshalledPlainSource,
  type SpecificationItem,
  type TestPlainFileBinding,
} from "./spec.ts";
import { bindTestPlainFiles, checkTestPlainFiles } from "./project.ts";

export const IMPORT_DIRECTIVE = "import";
export const REQUIRES_DIRECTIVE = "requires";
export const PREVIOUS_SYNTAX_HINT =
  "A functionality is a `# <func-id>` heading followed by its body; the previous syntax is not supported.";
export const REQUIRED_CONCEPTS_DIRECTIVE = "required_concepts";
export const EXPORTED_CONCEPTS_DIRECTIVE = "exported_concepts";

export const PLAIN_SOURCE_FILE_EXTENSION = ".plain";

/** A functional spec as it is read: its func-id and the blocks of its body. */
export interface Functionality {
  id: string;
  lineNumber: number;
  /** Every block after its heading, up to the next heading or section marker, in source order. */
  body: AnyNode[];
  linkedResources: LinkedResource[];
}

/**
 * definitions / implementation reqs / test reqs always exist as keys, each a section of list items; functional specs
 * does not, and is a list of functional specs when it does.
 */
export type ParsedPlainSource = Record<string, Section | Functionality[] | null | undefined>;

/** A list section of a parsed module. */
export function sectionOf(plainSource: ParsedPlainSource, heading: string): Section | null | undefined {
  return plainSource[heading] as Section | null | undefined;
}

/** The functional specs of a parsed module, none when it has no section for them. */
export function functionalitiesOf(plainSource: ParsedPlainSource): Functionality[] {
  return (plainSource[FUNCTIONAL_REQUIREMENTS] as Functionality[] | null | undefined) ?? [];
}

function newPlainSource(): ParsedPlainSource {
  return {
    [DEFINITIONS]: null,
    [NON_FUNCTIONAL_REQUIREMENTS]: null,
    [TEST_REQUIREMENTS]: null,
  };
}

export interface FrontmatterPost {
  metadata: Record<string, unknown>;
  content: string;
}

export interface PlainFileParseResult {
  plainSource: ParsedPlainSource;
  plainSourceObj: FrontmatterPost;
  requiredModules: string[];
  requiredConcepts: string[];
  /** The items its imports brought into its sections, each with the module it is written in. turri's: the Python parser does not keep it. */
  importedFrom: Map<AnyNode, string>;
}

export function getFilenameFromModuleName(moduleName: string): string {
  return `${moduleName}${PLAIN_SOURCE_FILE_EXTENSION}`;
}

export function getModuleNameFromFilename(filename: string): string {
  return filename.split(PLAIN_SOURCE_FILE_EXTENSION).join("");
}

export function hasScheme(target: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(target);
}

/**
 * Port of loaders.resolve_linked_resource: a link's file, in the first of the folders resources are loaded from - the
 * spec's own folder first, then the other template folders - where it exists, or null. Existence, not being a file,
 * decides the match, as in `open_from`'s search. Links are relative to the spec, so a spec in a subfolder is checked
 * where it is, wherever turri was started.
 */
export function resolveLinkedResource(dirs: string[], target: string): string | null {
  for (const dir of dirs) {
    const candidate = join(dir, target);
    consulted?.add(resolve(candidate));
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * The linked files a parse looked for, found or not, while one runs: a kept parse holds while each is as it was - a
 * resource written after a parse that did not find it is seen, though it is in a folder the fingerprint does not walk.
 */
let consulted: Set<string> | undefined;

/** What the linked files a parse looked for are now: there or not, their size and time. */
function linkedStamp(paths: string[]): string {
  return paths
    .map((path) => {
      try {
        const stat = statSync(path);
        return `${path}:${stat.size}:${stat.mtimeMs}`;
      } catch {
        return `${path}:-`;
      }
    })
    .join("\n");
}

/** A parse, with every linked file it looked for gathered as it ran. */
function parseNoting(run: () => ParsedModule): { parsed?: ParsedModule; error?: unknown; linked: string[] } {
  const outer = consulted;
  const mine = new Set<string>();
  consulted = mine;
  try {
    return { parsed: run(), linked: [...mine] };
  } catch (error) {
    return { error, linked: [...mine] };
  } finally {
    // A parse inside another's - an import, a required module - is part of what the outer one looked for too.
    if (outer !== undefined) for (const path of mine) outer.add(path);
    consulted = outer;
  }
}

/** A kept parse that still holds: nothing it could read has changed, the linked files it looked for included. */
function stillHolds(kept: KeptParse | undefined, fingerprint: string | undefined): kept is KeptParse {
  return kept !== undefined && fingerprint !== undefined && kept.fingerprint === fingerprint && linkedStamp(kept.linked) === kept.linkedStamp;
}

/** The links written in an item - what each says and where it points - as the parser reads them, checked or not. */
export function linksIn(section: AnyNode): Array<{ text: string; target: string; node: AnyNode }> {
  return [...traverse(section, "link")].map((link) => ({ text: String(link.children?.[0]?.value ?? ""), target: String(link.url ?? ""), node: link }));
}

/**
 * The links in the blocks, each checked to be a relative path to an existing file that is not a .plain file.
 * `where` names the place of the links in error messages, e.g. " in test plain file 'tests/m/f.plain', scenario `s`".
 */
export function findLinkedResources(nodes: AnyNode[], dirs: string[] = [], where = ""): LinkedResource[] {
  const linkedResources: LinkedResource[] = [];

  for (const { text, target, node: link } of nodes.flatMap((node) => linksIn(node))) {
    const children = link.children ?? [];

    if (hasScheme(target) || isAbsolute(target)) {
      throw new PlainSyntaxError(
        `Plain syntax error: Only relative links are allowed${where} (text: ${text}, target: ${target}).`,
      );
    }

    const file = resolveLinkedResource(dirs, target);
    if (file === null) {
      const searched = dirs.map((dir, index) => `  ${index + 1}. ${dir}`).join("\n");
      throw new PlainSyntaxError(
        `Plain syntax error: Link ${target}${where} does not exist. ` +
          "Linked resources are looked up relative to the following directories " +
          `(highest to lowest precedence):\n${searched}`,
      );
    }

    if (!statSync(file).isFile()) {
      throw new PlainSyntaxError(`Plain syntax error: Link ${target}${where} must be a file (resolved to ${file}).`);
    }

    if (children.length !== 1) {
      throw new PlainSyntaxError(`Plain syntax error: Link${where} must have text specified (link: ${target}).`);
    }

    if (extname(basename(target)) === ".plain") {
      throw new PlainSyntaxError(
        `Referenced resource '${target}'${where} is a .plain file. ` +
          "Referencing .plain files through Linked Resources is not supported. " +
          "Please use the import section to include definitions or implementation/test requirements from another module.",
      );
    }

    linkedResources.push({ text, target });
  }

  return linkedResources;
}

export function checkSectionForLinkedResources(section: AnyNode, dirs: string[] = []): void {
  const linkedResources = findLinkedResources([section], dirs);
  if (linkedResources.length > 0) section.linked_resources = linkedResources;
}

export function checkForLinkedResources(plainSource: ParsedPlainSource, dirs: string[] = []): void {
  for (const heading of LIST_SECTION_HEADINGS) {
    for (const requirement of sectionOf(plainSource, heading)?.children ?? []) checkSectionForLinkedResources(requirement, dirs);
  }
  for (const functionality of functionalitiesOf(plainSource)) {
    functionality.linkedResources = findLinkedResources(functionality.body, dirs);
  }
}

/** Put `{{ name }}` placeholders back into the section text and record the code variables it uses. */
export function processSectionCodeVariables(
  section: { code_variables?: CodeVariable[] } & Record<string, unknown>,
  codeVariables: Record<string, Record<string, string>>,
  textKey = "markdown",
): void {
  if (!(textKey in section)) return;

  const codeVariablesArray: Array<{ name: string; value: string }> = [];
  for (const [key, value] of Object.entries(codeVariables)) {
    if (!String(section[textKey]).includes(key)) continue;

    const variableName = Object.keys(value)[0]!;
    section[textKey] = String(section[textKey]).split(key).join(`{{ ${variableName} }}`);
    codeVariablesArray.push({ name: variableName, value: value[variableName]! });
  }

  if (codeVariablesArray.length > 0) section.code_variables = codeVariablesArray;
}

export function processCodeVariables(
  marshalled: MarshalledPlainSource,
  codeVariables: Record<string, Record<string, string>>,
): void {
  for (const heading of ALLOWED_SPECIFICATION_HEADINGS) {
    for (const requirement of getSpecificationItems(marshalled, heading) ?? []) {
      processSectionCodeVariables(requirement as unknown as Record<string, unknown>, codeVariables);
    }
  }
}

/** Whether the module declares a ***functional specs*** section (even if it is empty). */
export function hasFunctionalSpecsSection(plainSource: ParsedPlainSource): boolean {
  return FUNCTIONAL_REQUIREMENTS in plainSource;
}

/** Number of functionalities under ***functional specs*** (0 if absent or empty). */
export function countFunctionalities(plainSource: ParsedPlainSource): number {
  return functionalitiesOf(plainSource).length;
}

export function validateFunctionalitiesHaveImplementationReqs(
  plainSource: ParsedPlainSource,
  moduleName: string,
  hasRequires = false,
): void {
  const implementationReqs = sectionOf(plainSource, NON_FUNCTIONAL_REQUIREMENTS);
  const hasImplementationReqs = Boolean(implementationReqs && implementationReqs.children.length > 0);

  if (hasImplementationReqs) return;

  let message =
    `Plain syntax error: Module '${moduleName}' defines functionalities but specifies no ` +
    `${NON_FUNCTIONAL_REQUIREMENTS}. At least one implementation req is required.`;
  if (hasRequires) {
    message +=
      " Implementation reqs are not inherited through 'requires' — " +
      "add them to this module, or 'import' a module that provides them.";
  }
  throw new PlainSyntaxError(message);
}

export function marshallFunctionality(functionality: Functionality): FunctionalSpecItem {
  return {
    id: functionality.id,
    markdown: renderTokens(functionality.body),
    linked_resources: functionality.linkedResources,
    [CONFORMANCE_TESTS]: [],
    [ACCEPTANCE_TESTS]: [],
  };
}

export function marshallPlainSource(input: ParsedPlainSource): MarshalledPlainSource {
  const plainSource: MarshalledPlainSource = {};

  for (const heading of LIST_SECTION_HEADINGS) {
    const section = sectionOf(input, heading);
    if (!section) continue;

    const listOfRequirements: SpecificationItem[] = [];
    for (const requirement of section.children) {
      const requirementSection: SpecificationItem = {
        markdown: renderToMarkdown(requirement).trim(),
      };
      if (requirement.linked_resources) {
        requirementSection.linked_resources = requirement.linked_resources;
      }
      listOfRequirements.push(requirementSection);
    }

    plainSource[heading] = listOfRequirements;
  }

  if (FUNCTIONAL_REQUIREMENTS in input) {
    plainSource[FUNCTIONAL_REQUIREMENTS] = functionalitiesOf(input).map(marshallFunctionality);
  }

  return plainSource;
}

export function normalizeLineEndings(plainSourceText: string): string {
  return plainSourceText.split("\r\n").join("\n").split("\r").join("\n");
}

/**
 * Frontmatter parsing strips leading blank lines, which would shift every reported
 * line number. Put them back so syntax errors point at the real line.
 */
export function restoreStrippedLines(plainSourceText: string, content: string): string {
  const strippedSource = plainSourceText.replace(/\s+$/, "");
  if (!content || !strippedSource.endsWith(content)) return content;

  const prefix = strippedSource.slice(0, strippedSource.length - content.length);
  const strippedLineCount = (prefix.match(/\n/g) ?? []).length;
  return "\n".repeat(strippedLineCount) + content;
}

export function readPlainSourceMetadata(plainSourceText: string): FrontmatterPost {
  let metadata: Record<string, unknown> = {};
  let content = plainSourceText;

  // python-frontmatter's boundary: a line of three or more dashes, the block between them possibly empty.
  const match = /^-{3,}[ \t]*\n(?:([\s\S]*?)\n)?-{3,}[ \t]*(?:\n|$)/.exec(plainSourceText);
  if (match) {
    try {
      // python-frontmatter yields {} when the block does not parse to a mapping,
      // so a malformed directive block is ignored rather than fatal.
      const block = match[1] ?? "";
      const loaded = block.trim() === "" ? {} : loadYaml(block);
      metadata =
        loaded !== null && typeof loaded === "object" && !Array.isArray(loaded)
          ? (loaded as Record<string, unknown>)
          : {};
    } catch (error) {
      throw new PlainSyntaxError(
        `Plain syntax error: Invalid frontmatter: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    content = plainSourceText.slice(match[0].length);
  }
  content = content.trim();

  for (const directive of [EXPORTED_CONCEPTS_DIRECTIVE, REQUIRED_CONCEPTS_DIRECTIVE]) {
    if (!(directive in metadata)) continue;
    const value = metadata[directive];
    if (!Array.isArray(value)) {
      throw new Error(`Syntax error: Invalid ${directive} metadata. Expected a list.`);
    }

    const prepared: string[] = [];
    for (const item of value) {
      if (item !== null && typeof item === "object" && !Array.isArray(item)) {
        for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
          prepared.push(`- ${k}: ${v}`);
        }
      } else if (typeof item === "string") {
        prepared.push(`- ${item}`);
      } else {
        throw new PlainSyntaxError(
          `Plain syntax error: Invalid ${directive} metadata. Expected a dictionary or a string.`,
        );
      }
    }
    metadata[directive] = prepared;
  }

  return { metadata, content };
}

/** `Syntax error at line N in module 'm'`, without the parts that are not known. */
export function syntaxErrorAt(line: number | null | undefined, moduleName: string | null | undefined): string {
  let where = "Syntax error";
  if (line !== null && line !== undefined) where += ` at line ${line}`;
  if (moduleName) where += ` in module '${moduleName}'`;
  return where;
}

export const TEST_PLAIN_FILE_SECTION_HEADINGS = [CONFORMANCE_TEST_HEADING, ACCEPTANCE_TEST_HEADING];

/** Throw when a `***conformance tests***` or `***acceptance tests***` marker is anywhere in a spec plain file. */
export function checkNoTestSections(plainSourceFullText: string, moduleName?: string | null): void {
  plainSourceFullText.split("\n").forEach((line, index) => {
    for (const heading of TEST_PLAIN_FILE_SECTION_HEADINGS) {
      if (line.trim() === `***${heading}***`) {
        throw new PlainSyntaxError(
          `Plain syntax error: ${syntaxErrorAt(index + 1, moduleName)}: The \`${heading}\` section is not ` +
            "allowed in a spec plain file; test scenarios live in test plain files.",
        );
      }
    }
  });
}

/** The name in a `***name***` paragraph, or null when the paragraph is not a section marker. */
export function sectionMarker(token: AnyNode): string | null {
  const paragraphChildren = token.children ?? [];
  if (paragraphChildren.length !== 1 || paragraphChildren[0]!.type !== "emphasis") return null;
  const emphasisChildren = paragraphChildren[0]!.children ?? [];
  if (emphasisChildren.length !== 1 || emphasisChildren[0]!.type !== "strong") return null;
  return String((emphasisChildren[0]!.children ?? [])[0]?.value ?? "");
}

/** Whether a block is an ATX heading - `# text` - as mistletoe's `Heading`; a setext one is not. */
function isAtxHeading(token: AnyNode): boolean {
  return token.type === "heading" && token.sourceLine === undefined;
}

/**
 * Add the sections of the rendered spec plain file to `plainSource`.
 *
 * A list section holds a section whose children are its list items; `functional specs` holds a list of
 * functionalities, one per `# <func-id>` heading, each with every block up to the next heading or section marker.
 * Throw on the first structural error.
 */
export function readSections(plainSource: ParsedPlainSource, document: AnyNode, moduleName?: string | null): void {
  let currentSpecificationHeading: string | null = null;
  let currentFunctionality: Functionality | null = null;
  const processedSpecificationHeadings = new Set<string>();
  // Func-id to the line of its heading.
  const functionalityLines = new Map<string, number>();

  const closeFunctionality = () => {
    if (currentFunctionality !== null && currentFunctionality.body.length === 0) {
      throw new PlainSyntaxError(
        `Plain syntax error: ${syntaxErrorAt(currentFunctionality.lineNumber, moduleName)}: ` +
          `Functionality \`${currentFunctionality.id}\` has no body.`,
      );
    }
  };

  for (const token of document.children ?? []) {
    const tokenText = getRawText(token).trim();
    const where = syntaxErrorAt(lineNumber(token), moduleName);
    const inFunctionalSpecs = currentSpecificationHeading === FUNCTIONAL_REQUIREMENTS;
    if (isAtxHeading(token)) {
      if (!inFunctionalSpecs) {
        throw new PlainSyntaxError(
          `Plain syntax error: ${where}: A \`# <func-id>\` heading is allowed only in the ` +
            `${FUNCTIONAL_REQUIREMENTS} section (\`${tokenText}\`).`,
        );
      }
      if (token.depth !== 1) {
        throw new PlainSyntaxError(
          `Plain syntax error: ${where}: Invalid heading level ${token.depth as number} (\`${tokenText}\`). ` +
            "A functionality heading is `# <func-id>`.",
        );
      }
      if (!isSemanticId(tokenText)) {
        throw new PlainSyntaxError(
          `Plain syntax error: ${where}: Invalid func-id (\`${tokenText}\`). A func-id is lowercase letters ` +
            "and digits, with single hyphens between them.",
        );
      }
      if (functionalityLines.has(tokenText)) {
        throw new PlainSyntaxError(
          `Plain syntax error: ${where}: Duplicate func-id \`${tokenText}\`; it is first used at line ` +
            `${functionalityLines.get(tokenText)}.`,
        );
      }
      closeFunctionality();
      functionalityLines.set(tokenText, lineNumber(token));
      currentFunctionality = { id: tokenText, lineNumber: lineNumber(token), body: [], linkedResources: [] };
      functionalitiesOf(plainSource).push(currentFunctionality);
    } else if (token.type === "paragraph") {
      const specificationHeading = sectionMarker(token);
      if (specificationHeading === null) {
        if (!inFunctionalSpecs) {
          throw new PlainSyntaxError(`Plain syntax error: ${where}: Invalid specification (\`${tokenText}\`)`);
        }
        if (currentFunctionality === null) {
          throw new PlainSyntaxError(
            `Plain syntax error: ${where}: Content before the first \`# <func-id>\` heading in the ` +
              `${FUNCTIONAL_REQUIREMENTS} section (\`${tokenText}\`). ${PREVIOUS_SYNTAX_HINT}`,
          );
        }
        currentFunctionality.body.push(token);
        continue;
      }

      if (!ALLOWED_SPECIFICATION_HEADINGS.includes(specificationHeading)) {
        throw new PlainSyntaxError(
          `Plain syntax error: ${where}: Invalid specification heading (\`${specificationHeading}\`). ` +
            `Allowed headings: ${ALLOWED_SPECIFICATION_HEADINGS.join(", ")}`,
        );
      }

      if (processedSpecificationHeadings.has(specificationHeading)) {
        throw new PlainSyntaxError(
          `Plain syntax error: ${where}: Duplicate specification heading (\`${specificationHeading}\`)`,
        );
      }

      if (specificationHeading === DEFINITIONS && currentSpecificationHeading !== null) {
        throw new PlainSyntaxError(
          `Plain syntax error: ${where}: Definitions specification must be the first specification in ` +
            `the section (\`${tokenText}\`)`,
        );
      }

      closeFunctionality();
      currentFunctionality = null;
      currentSpecificationHeading = specificationHeading;
      if (specificationHeading === FUNCTIONAL_REQUIREMENTS) {
        plainSource[specificationHeading] = [];
      } else if (plainSource[specificationHeading] == null) {
        plainSource[specificationHeading] = { children: [] };
      }

      processedSpecificationHeadings.add(specificationHeading);
    } else if (token.type === "list" && !inFunctionalSpecs) {
      if (currentSpecificationHeading === null) {
        throw new PlainSyntaxError(`Plain syntax error: ${where}: Missing specification heading (\`${tokenText}\`)`);
      }
      sectionOf(plainSource, currentSpecificationHeading)!.children.push(...(token.children ?? []));
    } else if (inFunctionalSpecs) {
      // The body of a functionality is free text: a list at any indentation, a code block, or any other block.
      if (currentFunctionality === null) {
        throw new PlainSyntaxError(
          `Plain syntax error: ${where}: Content before the first \`# <func-id>\` heading in the ` +
            `${FUNCTIONAL_REQUIREMENTS} section (\`${tokenText}\`). ${PREVIOUS_SYNTAX_HINT}`,
        );
      }
      currentFunctionality.body.push(token);
    } else {
      throw new PlainSyntaxError(`Plain syntax error: ${where}: Invalid source structure (\`${tokenText}\`)`);
    }
  }

  closeFunctionality();
}

function processImports(
  plainSource: ParsedPlainSource,
  imports: string[],
  codeVariables: Record<string, Record<string, string>>,
  templateDirs: string[],
  importedModules: string[],
  modulesTrace: string[],
  importedFrom: Map<AnyNode, string>,
): string[] {
  const requiredConcepts: string[] = [];

  for (const moduleName of imports) {
    if (modulesTrace.includes(moduleName)) {
      throw new PlainSyntaxError(`Plain syntax error: Circular import detected: ${moduleName}.`);
    }
    if (importedModules.includes(moduleName)) continue;

    const result = parsePlainFile(moduleName, codeVariables, templateDirs, importedModules, modulesTrace);

    if (hasFunctionalSpecsSection(result.plainSource)) {
      throw new ImportedModuleWithFunctionalitiesError(
        `Module '${moduleName}' is imported but contains functional specs. ` +
          "Imported modules may only provide definitions, implementation reqs, and test reqs — " +
          "use 'requires' instead of 'import' if this module's functionalities should be built on.",
      );
    }

    for (const heading of LIST_SECTION_HEADINGS) {
      for (const item of sectionOf(result.plainSource, heading)?.children ?? []) importedFrom.set(item, result.importedFrom.get(item) ?? moduleName);
    }

    for (const heading of Object.keys(result.plainSource)) {
      if (!ALLOWED_IMPORT_SPECIFICATION_HEADINGS.includes(heading)) {
        throw new PlainSyntaxError(
          `Plain syntax error: Invalid specification heading (\`${heading}\`). ` +
            `Allowed headings: ${ALLOWED_IMPORT_SPECIFICATION_HEADINGS.join(", ")}`,
        );
      }

      if (plainSource[heading] == null) {
        plainSource[heading] = result.plainSource[heading] ?? null;
      } else if (result.plainSource[heading] != null) {
        sectionOf(plainSource, heading)!.children.push(...sectionOf(result.plainSource, heading)!.children);
      }
    }

    if (REQUIRED_CONCEPTS_DIRECTIVE in result.plainSourceObj.metadata) {
      for (const item of result.plainSourceObj.metadata[REQUIRED_CONCEPTS_DIRECTIVE] as unknown[]) {
        if (typeof item !== "string") {
          throw new Error(`Syntax error: Invalid ${REQUIRED_CONCEPTS_DIRECTIVE} metadata. Expected a string.`);
        }
        const [newConcepts] = extractConceptsFromDefinition(item);
        requiredConcepts.push(...newConcepts);
      }
      requiredConcepts.push(...result.requiredConcepts);
    }

    importedModules.push(moduleName);
  }

  return requiredConcepts;
}

export function parsePlainSource(
  plainSourceText: string,
  codeVariables: Record<string, Record<string, string>>,
  templateDirs: string[],
  importedModules: string[],
  modulesTrace: string[],
  moduleName?: string,
): PlainFileParseResult {
  plainSourceText = normalizeLineEndings(plainSourceText);

  const plainSourceObj = readPlainSourceMetadata(plainSourceText);
  const plainSource = newPlainSource();

  let requiredConcepts: string[] = [];
  const importedFrom = new Map<AnyNode, string>();
  if (IMPORT_DIRECTIVE in plainSourceObj.metadata) {
    requiredConcepts = processImports(
      plainSource,
      plainSourceObj.metadata[IMPORT_DIRECTIVE] as string[],
      codeVariables,
      templateDirs,
      importedModules,
      modulesTrace,
      importedFrom,
    );
  }

  const [, loadedTemplates] = getLoadedTemplates(templateDirs, plainSourceText, moduleName);
  const plainSourceContent = restoreStrippedLines(plainSourceText, plainSourceObj.content);
  const plainSourceFullText = renderPlainSource(plainSourceContent, loadedTemplates, codeVariables);

  checkNoTestSections(plainSourceFullText, moduleName);

  // Blank lines are kept as the reference keeps them, parsed inside its renderer: one BlankLine token per blank line.
  const plainFile = parseMarkdown(plainSourceFullText);
  removeQuotes(plainFile);

  readSections(plainSource, plainFile, moduleName);

  const definedConcepts = new Set<string>();
  const definitionsSection = sectionOf(plainSource, DEFINITIONS);
  if (definitionsSection) {
    for (const token of definitionsSection.children) {
      const [newConcepts] = extractConceptsFromDefinition(renderToMarkdown(token));
      for (const concept of newConcepts) {
        definedConcepts.add(concept);
        const index = requiredConcepts.indexOf(concept);
        if (index !== -1) requiredConcepts.splice(index, 1);
      }
    }
  }

  if (EXPORTED_CONCEPTS_DIRECTIVE in plainSourceObj.metadata) {
    const tracedModule = modulesTrace[modulesTrace.length - 1];
    const subject = tracedModule ? `Module '${tracedModule}'` : "Module";

    for (const entry of plainSourceObj.metadata[EXPORTED_CONCEPTS_DIRECTIVE] as string[]) {
      const [exportedConcepts, errors] = extractConceptsFromDefinition(entry);
      if (errors.length > 0) {
        throw new PlainSyntaxError(
          `Plain syntax error: ${subject} exports an invalid concept (\`${entry}\`). ` +
            "Expected a concept token, e.g. :ConceptName:.",
        );
      }

      for (const exportedConcept of exportedConcepts) {
        if (DEFAULT_CONCEPTS.has(exportedConcept)) {
          throw new PlainSyntaxError(
            `Plain syntax error: ${subject} cannot export default concept ${exportedConcept}. ` +
              "Only user-defined concepts can be exported.",
          );
        }

        if (!definedConcepts.has(exportedConcept)) {
          let message = `Plain syntax error: ${subject} exports undefined concept ${exportedConcept}.`;
          if (REQUIRES_DIRECTIVE in plainSourceObj.metadata) {
            message +=
              " An exported concept must be defined in this module's definitions or in an " +
              "imported module; a concept inherited through requires cannot be re-exported.";
          }
          throw new PlainSyntaxError(message);
        }
      }
    }
  }

  const requiredModules = (plainSourceObj.metadata[REQUIRES_DIRECTIVE] as string[] | undefined) ?? [];

  return { plainSource, plainSourceObj, requiredModules, requiredConcepts, importedFrom };
}

/**
 * The file a module name is read from, as `readModulePlainSource` reads it - a standard library module's in turri's
 * `stdlib/`, any other's in the first template folder that has it - or null when there is none.
 */
export function modulePlainFile(moduleName: string, templateDirs: string[]): string | null {
  return isStdlibModule(moduleName) ? stdlibModuleFile(moduleName) : findIn(templateDirs, moduleName + PLAIN_SOURCE_FILE_EXTENSION);
}

export function readModulePlainSource(moduleName: string, templateDirs: string[]): string {
  // `stdlib/...` is turri's standard library, and only that - see stdlib.ts.
  const plainSourceText = isStdlibModule(moduleName) ? readStdlibModule(moduleName, templateDirs) : openFrom(templateDirs, moduleName + PLAIN_SOURCE_FILE_EXTENSION);
  if (plainSourceText === null) {
    throw new ModuleDoesNotExistError(`Module does not exist (${moduleName}).`);
  }

  const blob = findLargeBase64Blob(plainSourceText);
  if (blob !== null) {
    throw new UnsupportedBase64Content(
      `Module '${moduleName}' contains a base64-encoded blob (${blob.length} characters) ` +
        "inlined in the specification. This is not supported. " +
        "Remove the base64 data from the .plain file or if necessary, " +
        "include the binary file path in the specification.",
    );
  }

  return plainSourceText;
}

export function parsePlainFile(
  moduleName: string,
  codeVariables: Record<string, Record<string, string>>,
  templateDirs: string[],
  importedModules: string[],
  modulesTrace: string[],
): PlainFileParseResult {
  const plainSourceText = readModulePlainSource(moduleName, templateDirs);
  return parsePlainSource(
    plainSourceText,
    codeVariables,
    templateDirs,
    importedModules,
    [...modulesTrace, moduleName],
    moduleName,
  );
}

/**
 * Parse every required module, deepest first, without validating it - each with code variables of its own - and
 * return the definitions the directly required modules export. A module listed again right after it was walked is
 * not parsed again, and what it exports is still visible to this module. `exports` records what each module walked
 * exports, so a repeat can find it.
 */
export function processRequiredModules(
  requiredModules: string[],
  templateDirs: string[],
  allRequiredModules: string[],
  modulesTrace: string[],
  exports: Map<string, AnyNode[]> = new Map(),
): AnyNode[] {
  const exportedDefinitions: AnyNode[] = [];

  for (const moduleName of requiredModules) {
    if (modulesTrace.includes(moduleName)) {
      throw new PlainSyntaxError(`Plain syntax error: Circular required module detected: ${moduleName}.`);
    }

    if (allRequiredModules.length > 0 && moduleName === allRequiredModules[allRequiredModules.length - 1]) {
      // Already walked as an earlier entry; its exports are still visible to this module.
      exportedDefinitions.push(...(exports.get(moduleName) ?? []));
      continue;
    }

    const result = parsePlainFile(moduleName, {}, templateDirs, [], []);

    if (result.requiredModules.length === 0) {
      if (allRequiredModules.length > 0) {
        // Required modules must form one chain; independent modules cannot yet be merged.
        throw new PlainSyntaxError(
          `Plain syntax error: There must be a fixed order how required modules are dependent (${moduleName}).`,
        );
      }
    } else {
      processRequiredModules(result.requiredModules, templateDirs, allRequiredModules, [...modulesTrace, moduleName], exports);
    }

    const own = exportedDefinitionsOf(result);
    exports.set(moduleName, own);
    exportedDefinitions.push(...own);

    allRequiredModules.push(moduleName);
  }

  return exportedDefinitions;
}

/**
 * The definitions a required module exports: those of its `exported_concepts`, with the definitions they use. What
 * it may export is checked as it is parsed (`parsePlainSource`).
 */
export function exportedDefinitionsOf(result: PlainFileParseResult): AnyNode[] {
  if (!(EXPORTED_CONCEPTS_DIRECTIVE in result.plainSourceObj.metadata)) return [];
  const exportedConcepts = (result.plainSourceObj.metadata[EXPORTED_CONCEPTS_DIRECTIVE] as string[]).flatMap(
    (concept) => extractConceptsFromDefinition(concept)[0],
  );

  return exportedConcepts.flatMap((exportedConcept) =>
    findConceptDefinitionsInPlainSource(exportedConcept, sectionOf(result.plainSource, DEFINITIONS) ?? null),
  );
}

export function processExportedDefinitions(
  plainSource: ParsedPlainSource,
  exportedDefinitions: AnyNode[],
): void {
  if (exportedDefinitions.length === 0) return;

  if (!plainSource[DEFINITIONS]) plainSource[DEFINITIONS] = { children: [] };
  const definitions = sectionOf(plainSource, DEFINITIONS)!;

  for (const exportedDefinition of exportedDefinitions) {
    const exportedRendered = renderToMarkdown(exportedDefinition).trim();
    const alreadyPresent = definitions.children.some(
      (definition) => renderToMarkdown(definition).trim() === exportedRendered,
    );
    if (!alreadyPresent) definitions.children.push(exportedDefinition);
  }
}

/**
 * Parse a .plain file into the marshalled tree.
 *
 * Returns the module name, the tree, and the modules it requires.
 */
export interface ParseOptions {
  /**
   * Accept a module with no functional specs yet. Not renderable one functionality at a
   * time - there is none - but a spec change can already be built from it: a module whose
   * product interview has so far given it definitions and reqs.
   */
  allowNoFunctionalities?: boolean;
  /**
   * The project's test folder: the module's chain is parsed with its test plain files, `<testDir>/<module>` for each
   * module of the chain - turri hands the reference one test folder per module - and their scenarios are bound to
   * the functional specs they name. turri's: the reference takes the test folders themselves.
   */
  testDir?: string;
  /**
   * With `testDir`: every functional spec of the chain must have a test plain file, which may hold no scenario
   * (`MissingTestPlainFileError` for the first one that has none). On unless set to false - turri always asks for
   * them, where the reference does only when the project names a conformance testing script.
   */
  requireTestPlainFiles?: boolean;
}

export function plainFileParser(
  plainSourceFileName: string,
  templateDirs: string[],
  options: ParseOptions = {},
): [string, MarshalledPlainSource, string[]] {
  const tests = options.testDir === undefined ? "" : `${resolve(options.testDir)}${options.requireTestPlainFiles === false ? "" : "!"}`;
  const key = `${options.allowNoFunctionalities ? "any" : "renderable"}\0${process.cwd()}\0${templateDirs.join("\0")}\0${plainSourceFileName}\0${tests}`;
  if (activeCache === undefined) {
    // Between calls: the parse from before, while nothing it could have read has changed since.
    const fingerprint = filesFingerprint(templateDirs, options.testDir);
    const kept = lastParses.get(key);
    if (stillHolds(kept, fingerprint)) {
      if (kept.error !== undefined) throw kept.error;
      return structuredClone(kept.parsed!);
    }
    const result = parseNoting(() => parseWithTestPlainFiles(plainSourceFileName, templateDirs, new Map(), options));
    // A spec that does not parse does not parse again until it, or a file it links, changes: it is not parsed again to say so.
    if (fingerprint !== undefined) remember(key, { fingerprint, linked: result.linked, linkedStamp: linkedStamp(result.linked), ...(result.error !== undefined ? { error: result.error } : { parsed: structuredClone(result.parsed!) }) });
    if (result.error !== undefined) throw result.error;
    return result.parsed!;
  }
  let parsed = activeCache.get(key);
  if (parsed === undefined) {
    // Nothing changes while `run` runs: each folder set's fingerprint is taken once.
    const dirsKey = `${templateDirs.join("\0")}\0${options.testDir ?? ""}`;
    let fingerprint = activeCache.fingerprints.get(dirsKey);
    if (!activeCache.fingerprints.has(dirsKey)) {
      fingerprint = filesFingerprint(templateDirs, options.testDir);
      activeCache.fingerprints.set(dirsKey, fingerprint);
    }
    const kept = lastParses.get(key);
    if (stillHolds(kept, fingerprint)) {
      if (kept.error !== undefined) throw kept.error;
      parsed = structuredClone(kept.parsed!);
    } else {
      const modules = activeCache.modules;
      const result = parseNoting(() => parseWithTestPlainFiles(plainSourceFileName, templateDirs, modules, options));
      if (fingerprint !== undefined) remember(key, { fingerprint, linked: result.linked, linkedStamp: linkedStamp(result.linked), ...(result.error !== undefined ? { error: result.error } : { parsed: structuredClone(result.parsed!) }) });
      if (result.error !== undefined) throw result.error;
      parsed = result.parsed!;
    }
    activeCache.set(key, parsed);
  }
  return parsed;
}

/**
 * Port of plain_file.parse_module_chain: a module and every module in its `requires` chain, each as its name and its
 * tree - every required module first, deepest ancestors first, then the module itself. A module reached through more
 * than one `requires` path appears once, at its first (deepest) position.
 */
export function parseModuleChain(
  plainSourceFileName: string,
  templateDirs: string[],
  options: ParseOptions = {},
): Array<[string, MarshalledPlainSource]> {
  return withParseCache(() => {
    const [moduleName, tree, requiredModules] = plainFileParser(plainSourceFileName, templateDirs, options);
    const chain: Array<[string, MarshalledPlainSource]> = [];
    const walked = new Set<string>();
    const walk = (names: string[]) => {
      for (const name of names) {
        if (walked.has(name)) continue;
        const [requiredName, requiredTree, itsRequires] = plainFileParser(
          `${name}${PLAIN_SOURCE_FILE_EXTENSION}`,
          templateDirs,
        );
        walk(itsRequires);
        if (walked.has(requiredName)) continue;
        walked.add(requiredName);
        chain.push([requiredName, requiredTree]);
      }
    };
    walk(requiredModules);
    chain.push([moduleName, tree]);
    return chain;
  });
}

/**
 * One parse per file for the length of `run`, however many times it is asked for.
 *
 * Walking a requires chain parses each module in it, and each parse gathers what it inherits
 * by parsing the modules below - so looking across a project of long chains asks for the
 * same files thousands of times. Inside `run` they are parsed once. Outside it nothing is
 * kept, so an edit made between two calls is always seen: the cache is for one question
 * about the specs, not for the life of the process.
 */
export function withParseCache<T>(run: () => T): T {
  if (activeCache !== undefined) return run();
  activeCache = Object.assign(new Map<string, ParsedModule>(), { modules: new Map<string, ParsedModule>(), fingerprints: new Map<string, string | undefined>() });
  try {
    return run();
  } finally {
    activeCache = undefined;
  }
}

let activeCache: (Map<string, ParsedModule> & { modules: Map<string, ParsedModule>; fingerprints: Map<string, string | undefined> }) | undefined;

/**
 * Parses kept between calls, each with what the files it could have read were when it was made: every file directly
 * in the template folders and the current one - its name, size and modification time, and a .plain file's text - and
 * every linked file it looked for, there or not.
 * The same fingerprint, the same parse: a spec is parsed again only once something it could read has changed. A
 * copy is handed out, so no caller can change what is kept. Bounded, oldest out first.
 */
interface KeptParse {
  fingerprint: string;
  /** The linked files it looked for, and what they were then. */
  linked: string[];
  linkedStamp: string;
  parsed?: ParsedModule;
  error?: unknown;
}
const lastParses = new Map<string, KeptParse>();
const KEPT_PARSES = 200;

function remember(key: string, entry: KeptParse): void {
  lastParses.delete(key);
  lastParses.set(key, entry);
  while (lastParses.size > KEPT_PARSES) lastParses.delete(lastParses.keys().next().value!);
}

function filesFingerprint(templateDirs: string[], testDir?: string): string | undefined {
  try {
    const parts: string[] = [];
    // Every .plain file under the test folder, by name and text: a scenario written, changed or removed is seen.
    if (testDir !== undefined) for (const path of plainFilesUnder(resolve(testDir))) parts.push(`${path}:${readFileSync(path, "utf8")}`);
    for (const dir of [process.cwd(), ...templateDirs]) {
      let entries: Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        parts.push(`${dir}:-`);
        continue;
      }
      for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
        if (!entry.isFile()) continue;
        const path = resolve(dir, entry.name);
        const stat = statSync(path);
        parts.push(`${path}:${stat.size}:${stat.mtimeMs}${entry.name.endsWith(".plain") ? `:${readFileSync(path, "utf8")}` : ""}`);
      }
    }
    return createHash("sha1").update(parts.join("\n")).digest("hex");
  } catch {
    return undefined;
  }
}

type ParsedModule = [string, MarshalledPlainSource, string[]];

/** Every .plain file under a folder, at any depth, sorted; none when it is not there. */
function plainFilesUnder(dir: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...plainFilesUnder(path));
    else if (entry.name.endsWith(PLAIN_SOURCE_FILE_EXTENSION)) found.push(path);
  }
  return found;
}

/**
 * A module parsed, and - with `options.testDir` - its chain's test plain files bound to it: the scenarios on its
 * functional specs and on the ones it inherits, `TEST_PLAIN_FILES` naming each file and what it binds to.
 */
function parseWithTestPlainFiles(
  plainSourceFileName: string,
  templateDirs: string[],
  cache: Map<string, ParsedModule>,
  options: ParseOptions,
): ParsedModule {
  const [moduleName, tree, requiredModules] = parseModule(plainSourceFileName, templateDirs, cache, options);
  if (options.testDir === undefined) return [moduleName, tree, requiredModules];

  // The chain, deepest first, each tree a copy the scenarios are bound into.
  const chain: Array<[string, MarshalledPlainSource]> = [];
  const walked = new Set<string>();
  const walk = (names: string[]) => {
    for (const name of names) {
      if (walked.has(name)) continue;
      let parsed = cache.get(name);
      if (parsed === undefined) {
        parsed = parseModule(`${name}${PLAIN_SOURCE_FILE_EXTENSION}`, templateDirs, cache);
        cache.set(name, parsed);
      }
      walk(parsed[2]);
      if (walked.has(parsed[0])) continue;
      walked.add(parsed[0]);
      chain.push([parsed[0], structuredClone(parsed[1])]);
    }
  };
  walk(requiredModules);
  const own = structuredClone(tree);
  chain.push([moduleName, own]);

  const testDirs = chain.map(([name]) => join(options.testDir!, name));
  const bound = bindTestPlainFiles(chain, testDirs, templateDirs, templateDirs[0] ?? ".");
  if (options.requireTestPlainFiles !== false) checkTestPlainFiles(chain, bound);

  // What the module inherits carries the scenarios bound in the module it is written in.
  const boundItems = new Map<string, FunctionalSpecItem>();
  for (const [name, chainTree] of chain) for (const item of getFunctionalSpecs(chainTree)) boundItems.set(`${name}\0${item.id}`, item);
  const inherited = own[REQUIRED_FUNCTIONAL_SPECS] as InheritedSpecificationItem[] | undefined;
  if (inherited !== undefined) {
    own[REQUIRED_FUNCTIONAL_SPECS] = inherited.map((item) => {
      const boundItem = boundItems.get(`${item.module}\0${item.id}`);
      return boundItem === undefined ? item : { ...item, [CONFORMANCE_TESTS]: boundItem[CONFORMANCE_TESTS], [ACCEPTANCE_TESTS]: boundItem[ACCEPTANCE_TESTS] };
    });
  }
  own[TEST_PLAIN_FILES] = Object.fromEntries(
    bound.map((file): [string, TestPlainFileBinding] => [file.name, { module: file.parsed.module, func_id: file.parsed.funcId }]),
  );
  return [moduleName, own, requiredModules];
}

/**
 * The functional specs a module inherits through `requires`, bottom of the chain first.
 *
 * This is what `requires` means: the required module's code is this module's starting
 * point, so its functional specs - and, transitively, its ancestors' - are previous
 * functional specs here. Each required module's own tree already carries what it inherits,
 * so taking that and then its own specs walks the whole chain; a module reached twice, as
 * when `requires` lists ancestors for their exported concepts, is counted once.
 */
function inheritFunctionalSpecs(
  requires: string[],
  templateDirs: string[],
  cache: Map<string, ParsedModule>,
): InheritedSpecificationItem[] {
  const inherited: InheritedSpecificationItem[] = [];
  const seen = new Set<string>();
  const add = (item: InheritedSpecificationItem) => {
    const key = `${item.module}/${item.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    inherited.push(item);
  };

  for (const name of requires) {
    let parsed = cache.get(name);
    if (parsed === undefined) {
      parsed = parseModule(`${name}${PLAIN_SOURCE_FILE_EXTENSION}`, templateDirs, cache);
      cache.set(name, parsed);
    }
    const [moduleName, tree] = parsed;
    for (const item of (tree[REQUIRED_FUNCTIONAL_SPECS] as InheritedSpecificationItem[] | undefined) ?? []) add(item);
    for (const item of getFunctionalSpecs(tree)) add({ ...item, module: moduleName });
  }
  return inherited;
}

function parseModule(
  plainSourceFileName: string,
  templateDirs: string[],
  cache: Map<string, ParsedModule>,
  options: ParseOptions = {},
): ParsedModule {
  const suffix = extname(plainSourceFileName);
  if (suffix !== PLAIN_SOURCE_FILE_EXTENSION) {
    throw new PlainSyntaxError(
      `Plain syntax error: Invalid plain file extension: ${suffix}. Expected: ${PLAIN_SOURCE_FILE_EXTENSION}.`,
    );
  }

  const moduleName = isAbsolute(plainSourceFileName)
    ? basename(plainSourceFileName, PLAIN_SOURCE_FILE_EXTENSION)
    : plainSourceFileName.slice(0, -PLAIN_SOURCE_FILE_EXTENSION.length).split("\\").join("/");

  // Populated while Liquid renders; read back after the tree is marshalled.
  const codeVariables: Record<string, Record<string, string>> = {};

  const result = parsePlainFile(moduleName, codeVariables, templateDirs, [], []);

  if (result.requiredConcepts.length > 0) {
    throw new PlainSyntaxError(
      "Plain syntax error: Not all required concepts were defined. Missing required concepts: " +
        `${result.requiredConcepts.join(", ")}.`,
    );
  }

  if (!options.allowNoFunctionalities && !hasFunctionalSpecsSection(result.plainSource)) {
    // Valid as an import, but not renderable.
    throw new MissingFunctionalitiesError(
      `Module '${moduleName}' does not have any functionality specified. ` +
        "At least one functionality is required for rendering.",
    );
  }

  if (!options.allowNoFunctionalities && countFunctionalities(result.plainSource) === 0) {
    throw new PlainSyntaxError(
      `Plain syntax error: Module '${moduleName}' has a '${FUNCTIONAL_REQUIREMENTS}' section ` +
        `without a \`# <func-id>\` heading. ${PREVIOUS_SYNTAX_HINT}`,
    );
  }

  validateFunctionalitiesHaveImplementationReqs(
    result.plainSource,
    moduleName,
    result.requiredModules.length > 0,
  );

  const exportedDefinitions = processRequiredModules(result.requiredModules, templateDirs, [], []);
  processExportedDefinitions(result.plainSource, exportedDefinitions);
  checkForLinkedResources(result.plainSource, templateDirs);

  const marshalled = marshallPlainSource(result.plainSource);
  processCodeVariables(marshalled, codeVariables);

  const validationErrors = validateConcepts(marshalled);
  if (validationErrors.length > 0) {
    const msg = `Found ${validationErrors.length} errors in the plain file:\n${validationErrors.join("\n")}`;
    throw new PlainSyntaxError(`Plain syntax error: ${msg}`);
  }

  const definitions = getSpecificationItems(marshalled, DEFINITIONS);
  if (definitions !== undefined) sortDefinitions(definitions);

  // What `import` brings - definitions, implementation reqs, test reqs - is already merged
  // into the module's own sections. What `requires` brings is the functional specs.
  const inherited = inheritFunctionalSpecs(result.requiredModules, templateDirs, cache);
  if (inherited.length > 0) marshalled[REQUIRED_FUNCTIONAL_SPECS] = inherited;

  return [moduleName, marshalled, result.requiredModules];
}
