import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A unittest run that fails when it ran no tests, on every Python: 3.12 exits 5 then, and older ones pass it - Debian's
 * 3.11 among them.
 */
function unittest(command: string): string[] {
  return [
    `OUTPUT="$(${command} 2>&1)"; STATUS=$?`,
    'printf \'%s\\n\' "$OUTPUT"',
    'if [ "$STATUS" -eq 0 ] && printf \'%s\' "$OUTPUT" | grep -q "^Ran 0 tests"; then exit 5; fi',
    'exit "$STATUS"',
  ];
}

/**
 * Testing scripts for a test project, in `test_scripts/` beside its specs - as the
 * implement-*-testing-script skills write them, cut down: stage the build in a fresh temp folder, run the suite.
 */
export const UNIT_SCRIPT = [
  "#!/bin/bash",
  // A folder of its own each run: on the host, test files running side by side would share one /tmp/python_code.
  'WORKING_FOLDER="$(mktemp -d)" && trap \'rm -rf "$WORKING_FOLDER"\' EXIT',
  'cp -R "$1"/. "$WORKING_FOLDER" && cd "$WORKING_FOLDER" || exit 2',
  ...unittest("python3 -m unittest discover"),
  "",
].join("\n");

export const CONFORMANCE_SCRIPT = [
  "#!/bin/bash",
  // A folder of its own each run: on the host, test files running side by side would share one /tmp/python_code.
  'WORKING_FOLDER="$(mktemp -d)" && trap \'rm -rf "$WORKING_FOLDER"\' EXIT',
  'cp -R "$1"/. "$WORKING_FOLDER" && cd "$WORKING_FOLDER" || exit 2',
  ...unittest('python3 -m unittest discover -s "$2" -t "$2"'),
  "",
].join("\n");

export function writeTestScripts(
  projectDir: string,
  scripts: { unit?: string; conformance?: string } = { unit: UNIT_SCRIPT, conformance: CONFORMANCE_SCRIPT },
): void {
  const dir = join(projectDir, "test_scripts");
  mkdirSync(dir, { recursive: true });
  if (scripts.unit !== undefined) writeFileSync(join(dir, "run_unittests_python.sh"), scripts.unit);
  if (scripts.conformance !== undefined) writeFileSync(join(dir, "run_conformance_tests_python.sh"), scripts.conformance);
}
