import { readFileSync } from "node:fs";
import { join } from "node:path";
import { listFiles } from "./testing.ts";

/**
 * The two kinds of test the conformance step writes, and how each is told apart in the code.
 *
 * Conformance tests are written from the functional spec itself: what the functionality does,
 * its edge cases, its errors - as if no acceptance tests had been given. Acceptance tests are the
 * ones the spec's author wrote, each implemented as a test of its own, doing what it says. The
 * two are kept apart even when the acceptance tests would seem to cover the functionality: tests
 * derived only from the acceptance tests check what the author thought to check, and nothing
 * the spec says beyond it.
 *
 * Each kind is labelled where anyone reading the tests can see it - in its file names, and in a
 * comment the harness looks for - so which test is which, and which acceptance test a test
 * implements, never has to be guessed.
 */

export function conformanceLabel(funcId: string): string {
  return `conformance tests of functionality ${funcId}`;
}

export function acceptanceLabel(funcId: string, n: number): string {
  return `acceptance test ${n} of functionality ${funcId}`;
}

/** An acceptance test as the spec gives it, without its bullet. */
export function acceptanceText(item: string): string {
  return item.trim().replace(/^[-*]\s+/, "");
}

function normalise(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ");
}

/**
 * What is missing from the labelling of a functionality's tests: the conformance label, when no
 * test file carries it, and each acceptance test no test is labelled as implementing.
 */
export function missingTestLabels(testsDir: string, funcId: string, acceptanceTests: string[]): string[] {
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
  // The label of `register` must not be found in the label of `register-twice`.
  const has = (label: string) =>
    new RegExp(`${normalise(label).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9]|-[a-z0-9])`).test(text);
  const missing: string[] = [];
  if (!has(conformanceLabel(funcId))) missing.push(`No test file is labelled "${conformanceLabel(funcId)}".`);
  acceptanceTests.forEach((item, i) => {
    if (!has(acceptanceLabel(funcId, i + 1))) missing.push(`No test is labelled "${acceptanceLabel(funcId, i + 1)}": ${acceptanceText(item)}`);
  });
  return missing;
}

/** Sent back when the labels are missing: which, and how to label them. */
export function labelsPrompt(funcId: string, missing: string[], empty = false, hasAcceptance = true): string {
  return labelsPromptFor([{ funcId, missing }], empty, hasAcceptance);
}

/**
 * Sent back when the labels of several functionalities are missing - a spec change that touches them: every one that is
 * missing, in one request, so none is asked for in place of another.
 */
export function labelsPromptFor(items: Array<{ funcId: string; missing: string[] }>, empty = false, hasAcceptance = true): string {
  const pending = items.filter((item) => item.missing.length > 0);
  const funcIds = pending.map((item) => item.funcId);
  const which = funcIds.length === 1 ? `functionality ${funcIds[0]}` : `functionalities ${funcIds.slice(0, -1).join(", ")} and ${funcIds.at(-1)}`;
  return [
    empty
      ? "There are no tests in your tests folder - nothing ran. Whatever a build folder or an earlier report there says, write " +
        `the conformance tests of ${which} now, as files in your tests folder, labelled as the kinds they are:`
      : `The tests are not labelled yet as the kinds they must be kept apart as. Missing, for ${which}:`,
    "",
    ...pending.flatMap((item) => item.missing.map((line) => `- ${line}`)),
    "",
    "Every functionality's conformance tests carry its own label, in a comment of its own line: " +
      `"${conformanceLabel(funcIds[0] ?? "1")}"${funcIds.length > 1 ? `, "${conformanceLabel(funcIds[1]!)}", and so on - one line a functionality` : ""}. ` +
      `A file that tests several functionalities has one such line for each. A label naming several at once - "conformance tests of functionality 1, 2 and 3" - counts for the first alone.`,
    ...(hasAcceptance
      ? [
          `Every acceptance test is its own test, with a comment right above it: "${acceptanceLabel(funcIds[0] ?? "1", 1)}:" and the acceptance test's text - one not implemented yet is written as a test of its own, not folded into a conformance test.`,
        ]
      : []),
    "Add every label missing above. Keep every label and every test that is there already: adding one functionality's label never takes another's away. Then run the tests again.",
  ].join("\n");
}

/**
 * Conformance and acceptance tests in the code folder, where they do not belong: they live in the
 * module's tests folder, which the harness runs as the conformance suite. Found by their label, or
 * by a test file under a name or folder that says conformance or acceptance - one written without
 * a label is misplaced all the same.
 */
export function misplacedConformanceTests(codeDir: string): string[] {
  const label = /conformance tests of (functionality [a-z0-9]|the spec)|acceptance test [0-9]+ of functionality [a-z0-9]/i;
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
    `These are conformance or acceptance tests, in the code folder (${codeDir}), where they do not belong:`,
    "",
    ...files.map((file) => `- ${file}`),
    "",
    testsDir === undefined
      ? "Conformance and acceptance tests are not yours to write: the conformance step writes them, in the module's " +
        "tests folder. Remove these from the code folder. Your tests are the unit tests - write them as unit tests."
      : `Conformance and acceptance tests live in your working directory, ${testsDir}, and nowhere else. Move these ` +
        "there - labelled as they must be - and remove them from the code folder; the harness runs only that folder as " +
        "the conformance suite.",
  ].join("\n");
}

