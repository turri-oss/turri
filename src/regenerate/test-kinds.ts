import { readFileSync } from "node:fs";
import { join } from "node:path";
import { listFiles } from "./testing.ts";

/**
 * How the conformance tests are labelled, and how the labels are checked.
 *
 * A functional spec's conformance tests are its scenarios, and nothing else: each conformance scenario and each
 * acceptance scenario of its test plain file is carried out by at least one test that does what it says. No test is
 * invented beside them. A functional spec with no scenarios has no conformance tests.
 *
 * Each is labelled where anyone reading the tests can see it - a comment the harness looks for - so which functional
 * spec a file tests, and which scenario a test carries out, never has to be guessed:
 * - a file: `conformance tests of <module>:<func-id>`, one line for each functional spec it tests;
 * - a test: `conformance scenario <scenario-id> of <module>:<func-id>` or `acceptance scenario <scenario-id> of
 *   <module>:<func-id>`, right above it.
 */

/** A scenario as the conformance agent is given it: its id, and its text. */
export interface Scenario {
  id: string;
  text: string;
}

/** A functional spec's scenarios: those its conformance tests carry out. */
export interface TestedSpec {
  funcId: string;
  conformance: Scenario[];
  acceptance: Scenario[];
}

export type ScenarioKind = "conformance" | "acceptance";

/** The label of a file of a functional spec's conformance tests. */
export function conformanceLabel(module: string, funcId: string): string {
  return `conformance tests of ${module}:${funcId}`;
}

/** The label right above a test that carries out a scenario. */
export function scenarioLabel(kind: ScenarioKind, scenarioId: string, module: string, funcId: string): string {
  return `${kind} scenario ${scenarioId} of ${module}:${funcId}`;
}

/** Every scenario of a functional spec, each with its kind, in its file's order: the conformance ones, then the acceptance ones. */
export function scenariosOf(spec: TestedSpec): Array<Scenario & { kind: ScenarioKind }> {
  return [...spec.conformance.map((scenario) => ({ ...scenario, kind: "conformance" as const })), ...spec.acceptance.map((scenario) => ({ ...scenario, kind: "acceptance" as const }))];
}

/** A scenario as the agents are given it: its label, and its text under it. */
export function scenarioText(module: string, funcId: string, scenario: Scenario & { kind: ScenarioKind }): string {
  return `${scenarioLabel(scenario.kind, scenario.id, module, funcId)}:\n${scenario.text.trim()}`;
}

function normalise(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ");
}

/**
 * What is missing from the labelling of a functional spec's tests: the file label, when no test file carries it, and each
 * scenario no test is labelled as carrying out.
 */
export function missingTestLabels(testsDir: string, module: string, spec: TestedSpec): string[] {
  const text = normalise(
    listFiles(testsDir)
      .map((file) => {
        try {
          return readFileSync(join(testsDir, file), "utf8");
        } catch {
          return "";
        }
      })
      .join("\n"),
  );
  // Matched on the whole key: the label of `todo:log-in` must not be found in that of `todo:log-in-2`.
  const has = (label: string) => new RegExp(`${normalise(label).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9_]|-[a-z0-9])`).test(text);
  const missing: string[] = [];
  if (!has(conformanceLabel(module, spec.funcId))) missing.push(`No test file is labelled "${conformanceLabel(module, spec.funcId)}".`);
  for (const scenario of scenariosOf(spec)) {
    const label = scenarioLabel(scenario.kind, scenario.id, module, spec.funcId);
    if (!has(label)) missing.push(`No test is labelled "${label}": ${scenario.text.trim().split("\n")[0]}`);
  }
  return missing;
}

/**
 * Sent back when the labels of functional specs are missing - one, or every one a spec change touches: every one that
 * is missing, in one request, so none is asked for in place of another.
 */
export function labelsPromptFor(module: string, items: Array<{ funcId: string; missing: string[] }>, empty = false): string {
  const pending = items.filter((item) => item.missing.length > 0);
  const names = pending.map((item) => `${module}:${item.funcId}`);
  const which = names.length === 1 ? `functional spec ${names[0]}` : `functional specs ${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  const first = pending[0]?.funcId ?? "<func-id>";
  return [
    empty
      ? "There are no tests in your tests folder - nothing ran. Whatever a build folder or an earlier report there says, write " +
        `the conformance tests of ${which} now, as files in your tests folder, labelled as below:`
      : `The tests are not labelled yet as the scenarios they carry out. Missing, for ${which}:`,
    "",
    ...pending.flatMap((item) => item.missing.map((line) => `- ${line}`)),
    "",
    `Every file of a functional spec's tests carries its label, in a comment of its own line: "${conformanceLabel(module, first)}". ` +
      "A file that tests several functional specs has one such line for each.",
    `Every scenario is carried out by at least one test, with a comment right above it: "${scenarioLabel("conformance", "<scenario-id>", module, first)}" or ` +
      `"${scenarioLabel("acceptance", "<scenario-id>", module, first)}" - one not carried out yet is written as a test of its own.`,
    "Add every label missing above. Keep every label and every test that is there already: adding one scenario's label never takes another's away. Then run the tests again.",
  ].join("\n");
}

/** Sent back when the labels of one functional spec are missing. */
export function labelsPrompt(module: string, funcId: string, missing: string[], empty = false): string {
  return labelsPromptFor(module, [{ funcId, missing }], empty);
}

/**
 * Conformance tests in the code folder, where they do not belong: they live in the module's tests folder, which the
 * harness runs as the conformance suite. Found by their label, or by a test file under a name or folder that says
 * conformance or acceptance - one written without a label is misplaced all the same.
 */
export function misplacedConformanceTests(codeDir: string): string[] {
  const label = /conformance tests of [a-z0-9_]+:[a-z0-9]|(conformance|acceptance) scenario \S+ of [a-z0-9_]+:[a-z0-9]/i;
  return listFiles(codeDir).filter((file) => {
    const parts = file.toLowerCase().split("/");
    const named = parts.some((part) => /conformance|acceptance/.test(part)) && /test/.test(parts.at(-1)!);
    if (named) return true;
    try {
      const text = readFileSync(join(codeDir, file), "utf8");
      return text.length < 500_000 && label.test(text);
    } catch {
      return false;
    }
  });
}

/** Sent back when there are: to the agent writing the code, or to the one writing the tests. */
export function misplacedTestsPrompt(files: string[], codeDir: string, testsDir?: string): string {
  return [
    `These are conformance tests, in the code folder (${codeDir}), where they do not belong:`,
    "",
    ...files.map((file) => `- ${file}`),
    "",
    testsDir === undefined
      ? "Conformance tests are not yours to write: the conformance step writes them, in the module's tests folder. " +
        "Remove these from the code folder. Your tests are the unit tests - write them as unit tests."
      : `Conformance tests live in your working directory, ${testsDir}, and nowhere else. Move these there - labelled as ` +
        "they must be - and remove them from the code folder; the harness runs only that folder as the conformance suite.",
  ].join("\n");
}
