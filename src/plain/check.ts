import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { testDirOf } from "../config.ts";
import { projectDirOf, resolveTemplateDirs } from "../regenerate/paths.ts";
import { importingModules, isImportModule } from "../regenerate/requires.ts";
import { testingGap } from "../regenerate/testing-steps.ts";
import { moduleOfTestPlainFile, projectModules, strayTestPlainFiles, testPlaceOf, testPlainFileRefusal } from "../test-plain-files.ts";
import { plainFileParser, PLAIN_SOURCE_FILE_EXTENSION, PREVIOUS_SYNTAX_HINT, readPlainSourceMetadata, REQUIRES_DIRECTIVE } from "./parser.ts";
import {
  ACCEPTANCE_TESTS,
  CONFORMANCE_TESTS,
  getFunctionalSpecs,
  TEST_PLAIN_FILES,
  type MarshalledPlainSource,
  type TestPlainFileBinding,
} from "./spec.ts";

/**
 * Static validation of ***plain, using this repo's own parser - `turri validate`, the chat's `validate`, and the check
 * `change_plain` and `turri change-plain` run on what a change touched.
 *
 * It parses each module with its test plain files, resolves its imports and required modules, and reports every error
 * the parser can see without generating anything. The parser's errors come one at a time, the first it meets, as the
 * reference gives them. turri's own checks list everything they find at once: every functional spec without a test
 * plain file, and every test plain file that is not where it belongs. A module whose functional specs have scenarios
 * but which has no test reqs, or no conformance testing script for its stack, passes with a warning.
 */

export interface CheckedFunctionalSpec {
  funcId: string;
  /** Its test plain files, from the project's folder. */
  testPlainFiles: string[];
  conformance: number;
  acceptance: number;
}

export interface CheckResult {
  /** The module's file - or, for the test folder's check, the test folder. */
  file: string;
  ok: boolean;
  moduleName?: string;
  /** The module's own functional specs, each with its test plain files and how many scenarios they have. */
  functionalSpecs?: CheckedFunctionalSpec[];
  requiredModules?: string[];
  /** The parser's own message, verbatim - it names the line and the construct. */
  error?: string;
  errorType?: string;
  /** turri's next step for the error, when it has one: old syntax, say. */
  nextStep?: string;
  /** turri's own findings, all of them: what is wrong, and what to do about each. */
  problems?: string[];
  /** What does not fail it but leaves something undone: a step of adding tests skipped, and the next step. */
  warnings?: string[];
}

/** Whether a parser error is one the previous ***plain syntax makes. */
export function isPreviousSyntaxError(message: string): boolean {
  return message.includes(PREVIOUS_SYNTAX_HINT) || message.includes("is not allowed in a spec plain file; test scenarios live in test plain files");
}

/** turri's next step for a module in the previous ***plain syntax. */
export function previousSyntaxStep(file: string): string {
  return (
    `${basename(file)} is in the old ***plain syntax. Ask turri to convert it: it goes one module at a time, ` +
    "proposing func-ids and test plain files, and asks you before writing anything."
  );
}

/** A path from the project's folder, as a person reads it. */
function shown(path: string, projectDir: string): string {
  return relative(projectDir, resolve(path)).split(sep).join("/");
}

/**
 * The modules of a project whose requires chains a module is in and that nothing requires: the tips its conformance
 * tests are written in, by name with their files. None when nothing requires it - it is a tip itself.
 */
function tipsAbove(moduleName: string, projectDir: string): Array<{ name: string; file: string }> {
  const modules = projectModules(projectDir);
  const requiredBy = new Map<string, string[]>();
  for (const [name, file] of modules) {
    let requires: string[] = [];
    try {
      requires = (readPlainSourceMetadata(readFileSync(file, "utf8")).metadata[REQUIRES_DIRECTIVE] as string[] | undefined) ?? [];
    } catch {
      continue;
    }
    for (const required of requires) {
      const below = basename(required.replace(/^\.\//, ""), PLAIN_SOURCE_FILE_EXTENSION);
      requiredBy.set(below, [...(requiredBy.get(below) ?? []), name]);
    }
  }
  const tips = new Set<string>();
  const seen = new Set<string>();
  const up = (name: string) => {
    if (seen.has(name)) return;
    seen.add(name);
    const above = requiredBy.get(name) ?? [];
    if (above.length === 0 && name !== moduleName) tips.add(name);
    for (const next of above) up(next);
  };
  up(moduleName);
  return [...tips].sort().flatMap((name) => (modules.has(name) ? [{ name, file: modules.get(name)! }] : []));
}

/**
 * The steps of adding tests a module skipped, as warnings. A module another requires has its conformance tests
 * written in the tips above it, from their test reqs and with their script: it is judged by each of them, which says so.
 */
function testingGapsOf(moduleName: string, path: string, tree: MarshalledPlainSource, projectDir: string, templateDirs: string[]): string[] {
  const tips = tipsAbove(moduleName, projectDir);
  if (tips.length === 0) {
    const gap = testingGap({ moduleName, plainFile: path, tree });
    return gap !== undefined ? [gap.text] : [];
  }
  return tips.flatMap((tip) => {
    let tipTree: MarshalledPlainSource;
    try {
      [, tipTree] = plainFileParser(basename(tip.file), resolveTemplateDirs(tip.file, templateDirs), {
        allowNoFunctionalities: true,
        testDir: testDirOf(tip.file),
        requireTestPlainFiles: false,
      });
    } catch {
      // A tip that does not parse is reported when it is checked itself.
      return [];
    }
    const gap = testingGap({ moduleName: tip.name, plainFile: tip.file, tree: tipTree });
    return gap !== undefined ? [`${moduleName}'s conformance tests are written in ${tip.name}, which requires it: ${gap.text}`] : [];
  });
}

export function checkPlainFile(file: string, templateDirs: string[] = []): CheckResult {
  const path = resolve(file);

  if (extname(path) !== PLAIN_SOURCE_FILE_EXTENSION) {
    return { file, ok: false, error: `Not a ${PLAIN_SOURCE_FILE_EXTENSION} file.`, errorType: "UsageError" };
  }
  if (!existsSync(path)) {
    return { file, ok: false, error: "File does not exist.", errorType: "UsageError" };
  }
  const refusal = testPlainFileRefusal(path);
  if (refusal !== undefined) return { file, ok: false, error: refusal, errorType: "UsageError" };

  const projectDir = projectDirOf(path);
  const testDir = testDirOf(path);
  try {
    const dirs = resolveTemplateDirs(path, templateDirs);
    // A module with no functional specs yet is valid - it is how every module starts, and how
    // an import module always is. It is reported, not failed.
    const [moduleName, tree, requiredModules] = plainFileParser(basename(path), dirs, {
      allowNoFunctionalities: true,
      testDir,
      requireTestPlainFiles: false,
    });
    // Scenarios with a step of adding tests skipped - the test reqs, or the conformance testing script: a warning, never a failure.
    const gaps = testingGapsOf(moduleName, path, tree, projectDir, templateDirs);
    const bindings = Object.entries((tree[TEST_PLAIN_FILES] as Record<string, TestPlainFileBinding> | undefined) ?? {});
    return {
      file,
      ok: true,
      moduleName,
      ...(gaps.length > 0 ? { warnings: gaps } : {}),
      functionalSpecs: getFunctionalSpecs(tree).map((item) => ({
        funcId: item.id,
        testPlainFiles: bindings
          .filter(([, binding]) => binding.module === moduleName && binding.func_id === item.id)
          .map(([name]) => shown(join(dirs[0]!, name), projectDir)),
        conformance: item[CONFORMANCE_TESTS].length,
        acceptance: item[ACCEPTANCE_TESTS].length,
      })),
      requiredModules,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      file,
      ok: false,
      error: message,
      errorType: error instanceof Error ? error.name : "Error",
      ...(isPreviousSyntaxError(message) ? { nextStep: previousSyntaxStep(path) } : {}),
    };
  }
}

/** The check of a project's test folder: every test plain file not where it belongs. Undefined when there is none. */
export function checkTestFolder(projectDir: string): CheckResult | undefined {
  const strays = strayTestPlainFiles(projectDir);
  if (strays.length === 0) return undefined;
  const testDir = testDirOf(join(projectDir, `x${PLAIN_SOURCE_FILE_EXTENSION}`));
  return {
    file: `${shown(testDir, projectDir)}/`,
    ok: false,
    errorType: `${strays.length} test plain file${strays.length === 1 ? "" : "s"} outside a module's folder`,
    problems: strays.map((stray) => `${stray.file} - ${stray.problem}`),
  };
}

/** Every `.plain` file directly in a directory, or the single file given. */
export function resolvePlainTargets(target: string): string[] {
  const path = resolve(target);
  if (existsSync(path) && statSync(path).isDirectory()) {
    return readdirSync(path)
      .filter((entry) => entry.endsWith(PLAIN_SOURCE_FILE_EXTENSION))
      .sort()
      .map((entry) => join(path, entry));
  }
  return [path];
}

/**
 * Check a file, or every .plain file directly in a folder - never a test folder, which holds no module - and then the
 * project's test folder, once, at the end.
 */
export function checkPlainTargets(target: string, templateDirs: string[] = []): CheckResult[] {
  const path = resolve(target);
  if (existsSync(path) && statSync(path).isDirectory()) {
    const refusal = testPlainFileRefusal(path);
    if (refusal !== undefined) return [{ file: target, ok: false, error: refusal, errorType: "UsageError" }];
  }
  const results = resolvePlainTargets(target).map((file) => checkPlainFile(file, templateDirs));
  const projects = [...new Set(resolvePlainTargets(target).map((file) => projectDirOf(file)))];
  for (const project of projects) {
    const folder = checkTestFolder(project);
    if (folder !== undefined) results.push(folder);
  }
  return results;
}

/**
 * The check of what a ***plain change touched, shared by `change_plain` and `turri change-plain`: each module it
 * touched, an import module as the modules that import it read it, and each test plain file as its module - by its
 * folder - is parsed with its test plain files; a test plain file the change put where it does not belong is refused
 * as `validate` refuses it. A file the change deleted is checked through the module it belonged to.
 */
export function checkTouchedPlain(paths: string[]): CheckResult[] {
  const modules = new Set<string>();
  const results: CheckResult[] = [];
  for (const given of paths) {
    const path = resolve(given);
    const place = testPlaceOf(path);
    if (place !== undefined && !place.directory) {
      const stray = strayTestPlainFiles(place.projectDir).find((found) => resolve(place.projectDir, found.file) === path);
      if (stray !== undefined) {
        results.push({ file: path, ok: false, errorType: "a test plain file outside its module's folder", problems: [`${stray.file} - ${stray.problem}`] });
        continue;
      }
      const owner = moduleOfTestPlainFile(path);
      if (owner?.plainFile !== undefined) modules.add(owner.plainFile);
      else if (owner !== undefined) results.push({ file: path, ok: false, errorType: "a test plain file outside a module's folder", problems: [`${shown(path, place.projectDir)} - no module ${owner.module}`] });
      continue;
    }
    if (!existsSync(path)) continue;
    const importing = isImportModule(path) ? importingModules(path) : [];
    for (const module of importing.length > 0 ? importing : [path]) modules.add(resolve(module));
  }
  for (const module of modules) results.push(checkPlainFile(module));
  return results;
}

/** Columns padded to their widest cell, each line indented under the module's. */
function columns(rows: string[][]): string[] {
  const widths = rows.reduce<number[]>((acc, row) => row.map((cell, index) => Math.max(acc[index] ?? 0, cell.length)), []);
  return rows.map((row) => `        ${row.map((cell, index) => (index === row.length - 1 ? cell : cell.padEnd(widths[index]!))).join("  ")}`);
}

/** How many scenarios a functional spec has, or that it has none and so is not tested. */
function scenarioCounts(spec: CheckedFunctionalSpec): string {
  const counts = [spec.conformance > 0 ? `${spec.conformance} conformance` : "", spec.acceptance > 0 ? `${spec.acceptance} acceptance` : ""].filter(Boolean);
  return counts.length === 0 ? "no scenarios - not tested" : counts.join(", ");
}

/**
 * One line per file, plus the parser's message under any that failed and turri's next step, or every problem turri
 * found; a module that passed, its functional specs under it, each with its test plain file and its scenarios - and
 * a WARN line for each warning, a step of adding tests it skipped.
 */
export function formatCheckResults(results: CheckResult[]): string {
  const lines: string[] = [];
  for (const result of results) {
    const name = result.file.endsWith("/") ? result.file : basename(result.file);
    if (result.ok) {
      const specs = result.functionalSpecs ?? [];
      const requires =
        result.requiredModules && result.requiredModules.length > 0 ? `, requires ${result.requiredModules.join(", ")}` : "";
      lines.push(
        specs.length === 0
          ? `PASS  ${name}  no functional specs yet${requires}`
          : `PASS  ${name}  ${specs.length} functional spec${specs.length === 1 ? "" : "s"}${requires}`,
      );
      // No test plain file is a functional spec not tested, as an empty one is - and the way to say so.
      lines.push(...columns(specs.map((spec) => [spec.funcId, spec.testPlainFiles.length > 0 ? spec.testPlainFiles.join(", ") : "no test plain file", scenarioCounts(spec)])));
      for (const warning of result.warnings ?? []) lines.push(`WARN  ${name}  ${warning}`);
    } else {
      lines.push(`FAIL  ${name}  ${result.errorType ?? "Error"}`);
      for (const line of [...(result.error ?? "").split("\n").filter((line, index) => index > 0 || line !== ""), ...(result.problems ?? [])]) lines.push(`        ${line}`);
      if (result.nextStep !== undefined) lines.push(`        ${result.nextStep}`);
    }
  }
  return lines.join("\n");
}
