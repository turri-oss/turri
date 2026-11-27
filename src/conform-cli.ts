import { parseArgs } from "./cli-options.ts";
import { headlessOptions, runLoop } from "./loop-cli.ts";

const USAGE = `usage: turri conform <file.plain> [module:func-id ...] [options]

Writes and runs the black-box conformance tests of a module's functional specs - those named, each
as module:func-id, or every one with scenarios - on the code as it is built, as the chat's conform does:
exactly their conformance and acceptance scenarios, following the spec's test reqs, with the whole suite
the module inherits, a failure fixed in the test or the code, whichever is wrong. A functional spec with
no scenarios is refused: write them first. So is a module with no test reqs, or no conformance testing
script: the refusal names the next step. Every functional spec tested goes in one pulse,
as far as the size guardrail lets. A functional spec named whose tests are written has them written
again: deleted and written anew from its scenarios, its code untouched.

  --one-by-one             a pulse a functional spec instead
  --from-scratch           take out the tests folder where the module's code lives - the tip of its chain - (its
                           lineage keeps it) and write the tests again, starting from a copy of the tests of the
                           module the tip requires; the code untouched
  --from-scratch-chain     the same, starting from nothing: every functional spec of the chain's tests written again
  --harness-model <p/id>   config.turri.yaml's harness-model for this run: the planner, a diagnosis
  --coding-model <p/id>    its coding-model, --model too: the agents that build
  --judge-model <p/id>     its judge-model: the judge and the test review
  --review <true|false>    its review: whether the code and its tests are reviewed once they pass
  --build-dir <dir>        as the run ends, export the code there (see turri regenerate --help)
  --report <file.json>     write a report of the run there (see turri regenerate --help)`;

const { positional, options } = parseArgs(process.argv.slice(2), ["--one-by-one", "--from-scratch", "--from-scratch-chain"], USAGE, ["--build-dir", "--report", "--harness-model", "--judge-model", "--review"]);
const { report, buildDir } = headlessOptions(options);
const [plainFile, ...funcIds] = positional;
if (plainFile === undefined) {
  console.error(USAGE);
  process.exit(1);
}
const scratch = options["from-scratch-chain"] !== undefined ? "chain" : options["from-scratch"] !== undefined ? "module" : undefined;
if (scratch !== undefined && funcIds.length > 0) {
  console.error(`Name functional specs or --from-scratch${scratch === "chain" ? "-chain" : ""}, not both: from scratch writes every one of them again.`);
  process.exit(1);
}
runLoop({
  plainFile,
  ...(buildDir !== undefined ? { buildDir } : {}),
  ...(report !== undefined ? { report } : {}),
  command: ["conform", ...process.argv.slice(2)],
  work: "conform", funcIds, separately: options["one-by-one"] !== undefined, fromScratch: scratch,
}).catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
