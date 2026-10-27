import { load as loadYaml } from "js-yaml";
import { extractConceptsFromSpecText, DEFAULT_CONCEPTS } from "./concepts.ts";
import { PlainSyntaxError } from "./errors.ts";
import { getLoadedTemplates } from "./files.ts";
import { renderPlainSource } from "./liquid.ts";
import { parseMarkdown, type LinkedResource } from "./markdown.ts";
import { findLinkedResources, normalizeLineEndings, processSectionCodeVariables, restoreStrippedLines } from "./parser.ts";
import { ACCEPTANCE_TEST_HEADING, CONFORMANCE_TEST_HEADING, isSemanticId, type CodeVariable, type ScenarioItem } from "./spec.ts";

/**
 * Port of test_plain_file.py: test plain files, the conformance and acceptance scenarios of one functionality.
 *
 * A test plain file binds to a functionality with the frontmatter keys `module` and `func_id`. It holds a
 * `***conformance tests***` section followed by an `***acceptance tests***` section; each scenario in them is a
 * `# <scenario-id>` heading followed by free text, which is kept verbatim.
 */

export const MODULE_KEY = "module";
export const FUNC_ID_KEY = "func_id";
export const FRONTMATTER_KEYS = [MODULE_KEY, FUNC_ID_KEY];
export const SECTION_HEADINGS = [CONFORMANCE_TEST_HEADING, ACCEPTANCE_TEST_HEADING] as const;

export interface Scenario {
  id: string;
  lineNumber: number;
  /** The body as written, without `>` comment lines and without leading and trailing blank lines. */
  text: string;
  linkedResources: LinkedResource[];
  codeVariables: CodeVariable[];
}

/** A scenario as the parse gives it: `{id, text, linked_resources}`, and `code_variables` when it uses any. */
export function scenarioItem(scenario: Scenario): ScenarioItem {
  const entry: ScenarioItem = { id: scenario.id, text: scenario.text, linked_resources: scenario.linkedResources };
  if (scenario.codeVariables.length > 0) entry.code_variables = scenario.codeVariables;
  return entry;
}

export interface TestPlainFile {
  /** The path of the file as shown in messages. */
  name: string;
  module: string;
  funcId: string;
  conformanceTests: Scenario[];
  acceptanceTests: Scenario[];
}

export function scenariosOf(file: TestPlainFile): Scenario[] {
  return [...file.conformanceTests, ...file.acceptanceTests];
}

/** Whether a frontmatter binds its file to a functionality, which makes the file a test plain file. */
export function isTestPlainFile(metadata: Record<string, unknown>): boolean {
  return FRONTMATTER_KEYS.every((key) => key in metadata);
}

const error = (message: string) => new PlainSyntaxError(`Plain syntax error: ${message}`);
const at = (lineNumber: number, name: string) => `Syntax error at line ${lineNumber} in test plain file '${name}'`;

/**
 * The frontmatter and content of a ***plain file, as python-frontmatter reads them: a block between two lines of
 * three or more dashes, loaded as YAML - a block that is not a mapping is no metadata - and the content after it,
 * stripped. Raises the YAML error as it is.
 */
export function loadFrontmatter(text: string): { metadata: Record<string, unknown>; content: string } {
  const match = /^-{3,}[ \t]*\n(?:([\s\S]*?)\n)?-{3,}[ \t]*(?:\n|$)/.exec(text);
  if (match === null) return { metadata: {}, content: text.trim() };
  const block = match[1] ?? "";
  const loaded = block.trim() === "" ? {} : loadYaml(block);
  const metadata = loaded !== null && typeof loaded === "object" && !Array.isArray(loaded) ? (loaded as Record<string, unknown>) : {};
  return { metadata, content: text.slice(match[0].length).trim() };
}

/** The frontmatter and content of a test plain file; raise unless the keys are exactly module and func_id. */
export function readMetadata(text: string, name: string): { metadata: Record<string, unknown>; content: string } {
  let post: { metadata: Record<string, unknown>; content: string };
  try {
    post = loadFrontmatter(text);
  } catch (e) {
    throw error(`Test plain file '${name}' has invalid frontmatter: ${e instanceof Error ? e.message : String(e)}`);
  }

  for (const key of FRONTMATTER_KEYS) {
    if (!(key in post.metadata)) throw error(`Test plain file '${name}' has no \`${key}:\` key in its frontmatter.`);
    const value = post.metadata[key];
    if (typeof value !== "string" || value.trim() === "") {
      throw error(`Test plain file '${name}': the frontmatter key \`${key}:\` must be a non-empty string.`);
    }
  }

  for (const key of Object.keys(post.metadata)) {
    if (!FRONTMATTER_KEYS.includes(key)) {
      throw error(`Test plain file '${name}' has the frontmatter key \`${key}:\`; only \`module:\` and \`func_id:\` are allowed.`);
    }
  }

  return post;
}

function trimBlankLines(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]!.trim() === "") start += 1;
  while (end > start && lines[end - 1]!.trim() === "") end -= 1;
  return lines.slice(start, end);
}

/** The scenarios of the rendered content, keyed by section heading; raise on the first structural error. */
export function readScenarios(renderedText: string, name: string): Record<string, Scenario[]> {
  const sections: Record<string, Scenario[]> = {};
  let currentSection: string | null = null;
  let current: Scenario | null = null;
  let body: string[] = [];
  // The marker of the open fenced code block (``` or ~~~), null outside one.
  let fence: string | null = null;
  // Scenario-id to the line of its heading.
  const headingLines = new Map<string, number>();

  const closeScenario = () => {
    if (current === null) return;
    if (fence !== null) throw error(`${at(current.lineNumber, name)}: Scenario \`${current.id}\` has a code fence that is not closed.`);
    const lines = trimBlankLines(body);
    if (lines.length === 0) throw error(`${at(current.lineNumber, name)}: Scenario \`${current.id}\` has no text.`);
    current.text = lines.join("\n");
  };

  renderedText.split("\n").forEach((line, index) => {
    const lineNumber = index + 1;
    const where = at(lineNumber, name);
    // Inside a fenced code block every line is body text: a `# ` line is not a heading there, a `***` line is not a
    // section marker, and a `>` line is not a comment.
    const stripped = line.trimStart();
    if (stripped.startsWith("```") || stripped.startsWith("~~~")) {
      const marker = stripped.slice(0, 3);
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
      if (current !== null) {
        body.push(line);
        return;
      }
    } else if (fence !== null && current !== null) {
      body.push(line);
      return;
    }

    if (line.startsWith("***")) {
      const trimmed = line.trim();
      const heading = trimmed.endsWith("***") && trimmed.length > 6 ? trimmed.slice(3, -3) : null;
      if (heading === null || !(SECTION_HEADINGS as readonly string[]).includes(heading)) {
        throw error(
          `${where}: Invalid section (\`${trimmed}\`). A test plain file has the sections ` +
            `\`***${SECTION_HEADINGS[0]}***\` and \`***${SECTION_HEADINGS[1]}***\`, in this order.`,
        );
      }
      if (heading in sections) throw error(`${where}: Duplicate section \`***${heading}***\`.`);
      if (heading !== SECTION_HEADINGS[Object.keys(sections).length]) {
        throw error(`${where}: The \`***${heading}***\` section must come after \`***${SECTION_HEADINGS[0]}***\`.`);
      }
      closeScenario();
      current = null;
      currentSection = heading;
      sections[heading] = [];
    } else if (line.startsWith("# ") || line === "#") {
      const scenarioId = line.slice(1).trim();
      if (currentSection === null) {
        throw error(
          `${where}: Scenario \`${scenarioId}\` comes before the first section; a test plain file starts ` +
            `with \`***${SECTION_HEADINGS[0]}***\`.`,
        );
      }
      if (!isSemanticId(scenarioId)) {
        throw error(
          `${where}: Invalid scenario-id (\`${scenarioId}\`). A scenario-id is lowercase letters and digits, ` +
            "with single hyphens between them.",
        );
      }
      if (headingLines.has(scenarioId)) {
        throw error(`${where}: Duplicate scenario-id \`${scenarioId}\`; it is first used at line ${headingLines.get(scenarioId)}.`);
      }
      closeScenario();
      current = { id: scenarioId, lineNumber, text: "", linkedResources: [], codeVariables: [] };
      body = [];
      headingLines.set(scenarioId, lineNumber);
      sections[currentSection]!.push(current);
    } else if (line.trimStart().startsWith(">")) {
      return;
    } else if (current !== null) {
      body.push(line);
    } else if (line.trim() !== "") {
      if (currentSection === null) {
        throw error(
          `${where}: Content before the first section (\`${line.trim()}\`); a test plain file starts with ` +
            `\`***${SECTION_HEADINGS[0]}***\`.`,
        );
      }
      throw error(`${where}: Content before the first \`# <scenario-id>\` heading in the \`${currentSection}\` section (\`${line.trim()}\`).`);
    }
  });

  closeScenario();

  for (const heading of SECTION_HEADINGS) {
    if (!(heading in sections)) throw error(`Test plain file '${name}' has no \`***${heading}***\` section.`);
  }

  return sections;
}

export function findScenarioLinkedResources(scenario: Scenario, templateDirs: string[], name: string): LinkedResource[] {
  const document = parseMarkdown(scenario.text);
  return findLinkedResources(document.children ?? [], templateDirs, ` in test plain file '${name}', scenario \`${scenario.id}\``);
}

/**
 * Parse the text of a test plain file. Liquid runs as on a spec plain file, with the same template folders; every
 * link in a scenario is resolved against them. Concepts are not checked here, see `validateScenarioConcepts`.
 */
export function parseTestPlainFileSource(
  plainSourceText: string,
  name: string,
  templateDirs: string[],
  codeVariables: Record<string, Record<string, string>>,
): TestPlainFile {
  plainSourceText = normalizeLineEndings(plainSourceText);
  const post = readMetadata(plainSourceText, name);
  const [, loadedTemplates] = getLoadedTemplates(templateDirs, plainSourceText, name);
  const content = restoreStrippedLines(plainSourceText, post.content);
  const renderedText = renderPlainSource(content, loadedTemplates, codeVariables);
  const sections = readScenarios(renderedText, name);

  for (const scenario of [...sections[SECTION_HEADINGS[0]]!, ...sections[SECTION_HEADINGS[1]]!]) {
    scenario.linkedResources = findScenarioLinkedResources(scenario, templateDirs, name);
    const entry: { text: string; code_variables?: CodeVariable[] } = { text: scenario.text };
    processSectionCodeVariables(entry, codeVariables, "text");
    scenario.text = entry.text;
    scenario.codeVariables = entry.code_variables ?? [];
  }

  return {
    name,
    module: String(post.metadata[MODULE_KEY]),
    funcId: String(post.metadata[FUNC_ID_KEY]),
    conformanceTests: sections[SECTION_HEADINGS[0]]!,
    acceptanceTests: sections[SECTION_HEADINGS[1]]!,
  };
}

/** One message per concept used in a scenario that is neither in `concepts` nor predefined. */
export function validateScenarioConcepts(file: TestPlainFile, concepts: Set<string>): string[] {
  const errors: string[] = [];
  for (const scenario of scenariosOf(file)) {
    for (const concept of new Set(extractConceptsFromSpecText(scenario.text))) {
      if (!concepts.has(concept) && !DEFAULT_CONCEPTS.has(concept)) {
        errors.push(
          `${at(scenario.lineNumber, file.name)}: Concept ${concept} used in scenario \`${scenario.id}\` is not defined in module '${file.module}'.`,
        );
      }
    }
  }
  return errors;
}
