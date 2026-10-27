import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { testDirOf } from "../config.ts";
import { projectDirOf, resolveTemplateDirs } from "../regenerate/paths.ts";
import { importingModules, isImportModule } from "../regenerate/requires.ts";
import { moduleOfTestPlainFile, strayTestPlainFiles, testPlaceOf, testPlainFileRefusal } from "../test-plain-files.ts";
import { plainFileParser, PLAIN_SOURCE_FILE_EXTENSION, PREVIOUS_SYNTAX_HINT } from "./parser.ts";
import {
  ACCEPTANCE_TESTS,
  CONFORMANCE_TESTS,
  getFunctionalSpecs,
  REQUIRED_FUNCTIONAL_SPECS,
  TEST_PLAIN_FILES,
  type InheritedSpecificationItem,
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
 * plain file, and every test plain file that is not where it belongs.
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
 * The functional specs of a module's chain that no test plain file binds to, in order - its required modules' first -
 * each as `module:func-id` (the func-id alone for the module's own) and the test plain file it needs.
 */
export function missingTestPlainFiles(moduleName: string, tree: MarshalledPlainSource, testDir: string, projectDir: string): string[] {
  const bindings = Object.values((tree[TEST_PLAIN_FILES] as Record<string, TestPlainFileBinding> | undefined) ?? {});
  const bound = new Set(bindings.map((binding) => `${binding.module}\0${binding.func_id}`));
  const chain = [
    ...((tree[REQUIRED_FUNCTIONAL_SPECS] as InheritedSpecificationItem[] | undefined) ?? []).map((item) => ({ module: item.module, funcId: item.id })),
    ...getFunctionalSpecs(tree).map((item) => ({ module: moduleName, funcId: item.id })),
  ];
  return chain
    .filter(({ module, funcId }) => !bound.has(`${module}\0${funcId}`))
    .map(({ module, funcId }) => `${module === moduleName ? funcId : `${module}:${funcId}`} - add ${shown(join(testDir, module, `${funcId}${PLAIN_SOURCE_FILE_EXTENSION}`), projectDir)}`);
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
    const missing = missingTestPlainFiles(moduleName, tree, testDir, projectDir);
    if (missing.length > 0) {
      return {
        file,
        ok: false,
        moduleName,
        errorType: `${missing.length} functional spec${missing.length === 1 ? "" : "s"} without a test plain file`,
        problems: missing,
      };
    }
    const bindings = Object.entries((tree[TEST_PLAIN_FILES] as Record<string, TestPlainFileBinding> | undefined) ?? {});
    return {
      file,
      ok: true,
      moduleName,
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
 * found; a module that passed, its functional specs under it, each with its test plain file and its scenarios.
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
      lines.push(...columns(specs.map((spec) => [spec.funcId, spec.testPlainFiles.join(", "), scenarioCounts(spec)])));
    } else {
      lines.push(`FAIL  ${name}  ${result.errorType ?? "Error"}`);
      for (const line of [...(result.error ?? "").split("\n").filter((line, index) => index > 0 || line !== ""), ...(result.problems ?? [])]) lines.push(`        ${line}`);
      if (result.nextStep !== undefined) lines.push(`        ${result.nextStep}`);
    }
  }
  return lines.join("\n");
}
