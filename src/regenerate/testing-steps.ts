import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { stackForModule, stackPinned, withStack } from "../config.ts";
import { IMPORT_DIRECTIVE, readPlainSourceMetadata } from "../plain/parser.ts";
import { FUNCTIONAL_REQUIREMENTS, REQUIRED_FUNCTIONAL_SPECS, TEST_REQUIREMENTS, type MarshalledPlainSource } from "../plain/spec.ts";
import { isStdlibModule, STDLIB_ROOT } from "../plain/stdlib.ts";
import { projectDirOf, resolveTemplateDirs } from "./paths.ts";
import { hasScenarios } from "./records.ts";
import { findTestScripts, projectRootFor } from "./test-scripts.ts";

/**
 * The steps of adding tests to a module, and the one it skipped. Nothing about testing exists until the person asks
 * for it; then, in order: its test reqs - the stack's conformance template, or its own - the conformance testing script
 * for its stack, and the scenarios in its test plain files. A module whose functional specs have scenarios but which
 * skipped one of the first two has its conformance pulses refused - by the work loop and by `conform` alike - and
 * `validate` and the map say what is missing. A module with no scenarios skipped nothing: it is not tested.
 */

export interface TestingGap {
  /** The first step skipped. */
  step: "test reqs" | "conformance testing script";
  /** What is missing, and the next step - a refusal's, a warning's and the loop's why. */
  text: string;
  /** In a few words, for the map's row. */
  short: string;
}

/** The stack template a module imports, `stdlib/<kind>/<stack>`, through its imports - none, when it imports none. */
function stdlibStackOf(plainFile: string): { kind: string; stack: string } | undefined {
  const dirs = resolveTemplateDirs(resolve(plainFile));
  const seen = new Set<string>();
  const visit = (path: string): { kind: string; stack: string } | undefined => {
    if (seen.has(path) || !existsSync(path)) return undefined;
    seen.add(path);
    let imports: string[];
    try {
      imports = (readPlainSourceMetadata(readFileSync(path, "utf8")).metadata[IMPORT_DIRECTIVE] as string[] | undefined) ?? [];
    } catch {
      return undefined;
    }
    for (const name of imports) {
      const bare = name.replace(/^\.\//, "");
      if (isStdlibModule(bare)) {
        const [, kind, stack, more] = bare.split("/");
        if (kind !== undefined && stack !== undefined && more === undefined && kind !== "lang" && stack !== "common") return { kind, stack };
        continue;
      }
      const found = [dirname(path), ...dirs].map((dir) => join(dir, `${bare}.plain`)).find((candidate) => existsSync(candidate));
      const stack = found !== undefined ? visit(resolve(found)) : undefined;
      if (stack !== undefined) return stack;
    }
    return undefined;
  };
  return visit(resolve(plainFile));
}

/** Whether any functional spec of a codebase's tree - its own, or one it inherits - has scenarios. */
function anyScenarios(tree: MarshalledPlainSource): boolean {
  const items = (section: string) => ((tree[section] as unknown[] | undefined) ?? []);
  return [...items(FUNCTIONAL_REQUIREMENTS), ...items(REQUIRED_FUNCTIONAL_SPECS)].some(hasScenarios);
}

/**
 * The step of adding tests a module skipped, when its functional specs have scenarios: no test reqs - its own or
 * imported - or no conformance testing script for its stack. `tree` is what its conformance tests would be written from:
 * the codebase's spec, the module's own sections with its imports in, and the functional specs it inherits. The script
 * is looked for under the module's stack - the one pinned, else the one `stackForModule` gives it.
 */
export function testingGap(input: { moduleName: string; plainFile: string; tree: MarshalledPlainSource; buildDir?: string }): TestingGap | undefined {
  if (!anyScenarios(input.tree)) return undefined;
  const { moduleName, plainFile } = input;
  const stack = stackPinned() ? undefined : stackForModule(plainFile);
  const scripts = () => {
    const root = input.buildDir !== undefined ? projectRootFor(plainFile, input.buildDir) : projectDirOf(plainFile);
    return findTestScripts(root, plainFile, input.buildDir);
  };
  const found = stackPinned() ? scripts() : withStack(stack, scripts);
  const scriptStep = "write the conformance testing script with the implement-conformance-testing-script skill";
  if (((input.tree[TEST_REQUIREMENTS] as unknown[] | undefined) ?? []).length === 0) {
    const template = stdlibStackOf(plainFile);
    const conformance = template !== undefined ? `stdlib/${template.kind}/conformance/${template.stack}` : undefined;
    const reqs =
      conformance !== undefined && existsSync(join(STDLIB_ROOT, `${conformance}.plain`))
        ? `import the stack's conformance template, ${conformance}`
        : "write the module's own ***test reqs***";
    return {
      step: "test reqs",
      text:
        `${moduleName} has scenarios but no ***test reqs***, so its conformance tests cannot be written - the test reqs are ` +
        `the first step of adding tests. Next step: ${reqs}, with change_plain${found.conformance === undefined ? `; then ${scriptStep}` : ""}.`,
      short: "scenarios not tested: no test reqs",
    };
  }
  if (found.conformance === undefined) {
    const note = found.notes?.conformance;
    return {
      step: "conformance testing script",
      text:
        `${moduleName} has scenarios and ***test reqs*** but no conformance testing script, so nothing can run its conformance ` +
        `tests - the script is the second step of adding tests. Next step: ${scriptStep}.${note !== undefined ? ` ${note}` : ""}`,
      short: "scenarios not tested: no conformance testing script",
    };
  }
  return undefined;
}
