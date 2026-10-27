import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { collectConcepts } from "./concepts.ts";
import { MissingTestPlainFileError, PlainSyntaxError, UnsupportedBase64Content } from "./errors.ts";
import { findLargeBase64Blob, relativeResourcePath } from "./files.ts";
import { parseModuleChain } from "./parser.ts";
import {
  ACCEPTANCE_TESTS,
  CONFORMANCE_TESTS,
  getFunctionalSpecs,
  type MarshalledPlainSource,
} from "./spec.ts";
import {
  isTestPlainFile,
  loadFrontmatter,
  parseTestPlainFileSource,
  scenarioItem,
  validateScenarioConcepts,
  type TestPlainFile,
} from "./test-plain-file.ts";

/** Port of project.py: a module with its requires chain and the test plain files bound to its functionalities. */

export interface BoundTestPlainFile {
  /** The file on disk. */
  path: string;
  /** The path relative to the entry module's folder, with `/` as separator. */
  name: string;
  parsed: TestPlainFile;
}

export interface ProjectParseResult {
  /** As `parseModuleChain` gives it, with the scenarios of the test plain files merged into the functionalities. */
  chain: Array<[string, MarshalledPlainSource]>;
  testPlainFiles: BoundTestPlainFile[];
}

const PLAIN_SOURCE_FILE_EXTENSION = ".plain";

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * `[path, name]` of every .plain file under the test folders: folder by folder, and within one by path - each
 * folder's files before its subfolders', as `os.walk` gives them. A test folder that does not exist is skipped.
 */
export function discoverTestPlainFiles(testDirs: string[], entryDir: string): Array<[string, string]> {
  const found: Array<[string, string]> = [];
  const walk = (root: string) => {
    const entries = readdirSync(root, { withFileTypes: true });
    const byName = (a: { name: string }, b: { name: string }) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries.filter((e) => !e.isDirectory()).sort(byName)) {
      if (entry.name.endsWith(PLAIN_SOURCE_FILE_EXTENSION)) {
        found.push([join(root, entry.name), relativeResourcePath(entryDir, root, entry.name)]);
      }
    }
    for (const entry of entries.filter((e) => e.isDirectory()).sort(byName)) walk(join(root, entry.name));
  };
  for (const testDir of testDirs) if (isDirectory(testDir)) walk(testDir);
  return found;
}

export function readTestPlainFileText(path: string, name: string): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path));
  } catch {
    throw new PlainSyntaxError(`Plain syntax error: File '${name}' under a test folder is not a text file.`);
  }

  const blob = findLargeBase64Blob(text);
  if (blob !== null) {
    throw new UnsupportedBase64Content(
      `Test plain file '${name}' contains a base64-encoded blob (${blob.length} characters) inlined in the ` +
        "scenarios. This is not supported. Remove the base64 data from the file.",
    );
  }
  return text;
}

/**
 * Read every test plain file under the test folders and add its scenarios to the functionality it binds to, in
 * place in the chain's trees.
 *
 * A `.plain` file under a test folder without the `module:` and `func_id:` keys is an error, as is a file that binds
 * to a module outside the chain or to a func-id the module does not have. The concepts of the scenarios must be
 * visible to the bound module. Files bound to one functionality are merged in discovery order; a scenario-id is
 * unique across that merged set.
 */
export function bindTestPlainFiles(
  chain: Array<[string, MarshalledPlainSource]>,
  testDirs: string[],
  templateDirs: string[],
  entryDir: string,
): BoundTestPlainFile[] {
  const trees = new Map(chain);
  const bound: BoundTestPlainFile[] = [];
  // (module, func-id) -> scenario-id -> where it is first used.
  const scenarioPlaces = new Map<string, Map<string, string>>();
  for (const [path, name] of discoverTestPlainFiles(testDirs, entryDir)) {
    const text = readTestPlainFileText(path, name);
    let metadata: Record<string, unknown>;
    try {
      metadata = loadFrontmatter(text.split("\r\n").join("\n")).metadata;
    } catch (e) {
      throw new PlainSyntaxError(
        `Plain syntax error: File '${name}' under a test folder has invalid frontmatter: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (!isTestPlainFile(metadata)) {
      throw new PlainSyntaxError(
        `Plain syntax error: File '${name}' is under a test folder but is not a test plain file: its ` +
          "frontmatter needs the keys `module:` and `func_id:`.",
      );
    }

    const parsed = parseTestPlainFileSource(text, name, templateDirs, {});
    const tree = trees.get(parsed.module);
    if (tree === undefined) {
      throw new PlainSyntaxError(
        `Plain syntax error: Test plain file '${name}' binds to module '${parsed.module}', which is not the ` +
          `entry module or one of its required modules (${[...trees.keys()].join(", ")}).`,
      );
    }
    const functionality = getFunctionalSpecs(tree).find((item) => item.id === parsed.funcId);
    if (functionality === undefined) {
      throw new PlainSyntaxError(
        `Plain syntax error: Test plain file '${name}' binds to functionality ` +
          `'${parsed.module}:${parsed.funcId}', which module '${parsed.module}' does not have.`,
      );
    }

    const [concepts] = collectConcepts(tree);
    const errors = validateScenarioConcepts(parsed, new Set(concepts));
    if (errors.length > 0) {
      throw new PlainSyntaxError(`Plain syntax error: Found ${errors.length} errors in test plain file '${name}':\n${errors.join("\n")}`);
    }

    const key = `${parsed.module}\0${parsed.funcId}`;
    if (!scenarioPlaces.has(key)) scenarioPlaces.set(key, new Map());
    const places = scenarioPlaces.get(key)!;
    for (const [listKey, scenarios] of [
      [CONFORMANCE_TESTS, parsed.conformanceTests],
      [ACCEPTANCE_TESTS, parsed.acceptanceTests],
    ] as const) {
      for (const scenario of scenarios) {
        if (places.has(scenario.id)) {
          throw new PlainSyntaxError(
            `Plain syntax error: Syntax error at line ${scenario.lineNumber} in test plain file ` +
              `'${name}': Duplicate scenario-id \`${scenario.id}\` for functionality ` +
              `'${parsed.module}:${parsed.funcId}'; it is first used ${places.get(scenario.id)}.`,
          );
        }
        places.set(scenario.id, `at line ${scenario.lineNumber} in test plain file '${name}'`);
        functionality[listKey].push(scenarioItem(scenario));
      }
    }

    bound.push({ path, name, parsed });
  }

  return bound;
}

/**
 * Throw for the first functionality of the chain, in render order, that has no test plain file bound to it.
 * The sections of the file may be empty; the file itself is what the check asks for.
 */
export function checkTestPlainFiles(chain: Array<[string, MarshalledPlainSource]>, bound: BoundTestPlainFile[]): void {
  const missing = missingTestPlainFiles(chain, bound)[0];
  if (missing !== undefined) {
    throw new MissingTestPlainFileError(
      `Functionality ${missing.module}:${missing.funcId} has no test plain file. Add one, by convention ` +
        `tests/${missing.module}/${missing.funcId}.plain, with the add-test-scenarios skill.`,
    );
  }
}

/**
 * Parse a module with its requires chain and bind the test plain files under `testDirs` to its functionalities.
 *
 * `templateDirs[0]` is the entry module's folder; test plain files are named relative to it. With
 * `requireTestPlainFiles`, every functionality of every module in the chain needs a test plain file.
 */
export function parseProject(
  plainFileName: string,
  templateDirs: string[],
  testDirs: string[],
  requireTestPlainFiles: boolean,
): ProjectParseResult {
  const chain = parseModuleChain(plainFileName, templateDirs).map(([name, tree]): [string, MarshalledPlainSource] => [name, structuredClone(tree)]);
  const bound = bindTestPlainFiles(chain, testDirs, templateDirs, templateDirs[0]!);
  if (requireTestPlainFiles) checkTestPlainFiles(chain, bound);
  return { chain, testPlainFiles: bound };
}

/** Every functionality of the chain, in render order, with no test plain file bound to it. turri's: it lists them all. */
export function missingTestPlainFiles(
  chain: Array<[string, MarshalledPlainSource]>,
  bound: BoundTestPlainFile[],
): Array<{ module: string; funcId: string }> {
  const boundFunctionalities = new Set(bound.map((item) => `${item.parsed.module}\0${item.parsed.funcId}`));
  const missing: Array<{ module: string; funcId: string }> = [];
  for (const [moduleName, tree] of chain) {
    for (const functionality of getFunctionalSpecs(tree)) {
      if (!boundFunctionalities.has(`${moduleName}\0${functionality.id}`)) missing.push({ module: moduleName, funcId: functionality.id });
    }
  }
  return missing;
}
