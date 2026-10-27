import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { checkTouchedPlain, formatCheckResults } from "./plain/check.ts";
import { applySpecDiff, plainFilesOf, revertSpecDiff } from "./regenerate/regenerate.ts";
import { testPlainFileRefusal } from "./test-plain-files.ts";
import { parseArgs } from "./cli-options.ts";
import { headlessOptions, runLoop } from "./loop-cli.ts";

const USAGE = `usage: turri change-plain <file.plain> <diff-file> [options]

Applies a change to ***plain, given as a git diff of the .plain files - modules and test plain files - and
builds it: the headless
counterpart of regenerate, given a diff. The diff is applied first, unless it is already in; then, as
turri regenerate does, what is left to build is planned into jobs and built.

  --harness-model <p/id>   config.turri.yaml's harness-model for this run: the planner, the conformance chooser, a diagnosis
  --coding-model <p/id>    its coding-model, --model too: the agents that build
  --start-over             start over, without asking, a codebase regenerated without a module it now requires
  --judge-model <p/id>     its judge-model: the judge and the test review
  --review <true|false>    its review: whether the code and its tests are reviewed once they pass
  --conformance-tests <all|chosen|module|false>
                           its conformance-tests: which conformance tests are written and run
  --build-dir <dir>        as the run ends, export the code there (see turri regenerate --help)
  --report <file.json>     write a report of the run there (see turri regenerate --help)`;

const { positional, options } = parseArgs(process.argv.slice(2), ["--start-over"], USAGE, ["--build-dir", "--report", "--conformance-tests", "--harness-model", "--judge-model", "--review"]);
const { report, buildDir } = headlessOptions(options, true);
const [plainFile, diffFile] = positional;
if (plainFile === undefined || diffFile === undefined) {
  console.error(USAGE);
  process.exit(1);
}
const refusal = testPlainFileRefusal(plainFile);
if (refusal !== undefined) {
  console.error(refusal);
  process.exit(1);
}
const diff = readFileSync(diffFile, "utf8");
const cwd = process.cwd();
const applied = applySpecDiff(diff, cwd);
// Every file the diff touched is checked - a test plain file as its module - not only the one named.
const failed = checkTouchedPlain([plainFile, ...plainFilesOf(diff)].map((file) => resolve(cwd, file))).filter((check) => !check.ok);
if (failed.length > 0) {
  if (applied === "applied") revertSpecDiff(diff, cwd);
  console.error(`Nothing was changed: with this diff the ***plain no longer checks.\n${formatCheckResults(failed)}`);
  process.exit(1);
}
runLoop({
  plainFile,
  startOver: options["start-over"] !== undefined,
  ...(buildDir !== undefined ? { buildDir } : {}),
  ...(report !== undefined ? { report } : {}),
  command: ["change-plain", ...process.argv.slice(2)],
  ask: (loop) => loop.bringUp(plainFile),
}).catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
