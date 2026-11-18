import { CONFIG_FILE, readProjectConfig } from "./config.ts";
import { parseArgs } from "./cli-options.ts";
import { headlessOptions, runLoop } from "./loop-cli.ts";

const USAGE = `usage: turri regenerate [file.plain] [module:func-id ...] [options]

Regenerates the module's code from its spec as it is now, and everything it requires, bottom first, as
the chat does: what is left to regenerate - from what each module's code was regenerated from to its
spec now - is planned into jobs, and they run one after the other until the code is regenerated from
the spec, then the conformance tests of every functional spec with scenarios whose tests are behind. Then it says
how each went. With functional specs named - each as module:func-id - those are regenerated though their spec did
not change, as regenerate does in the chat with funcIds named: their code taken out and built anew, doing what the
spec says.

The project's config.turri.yaml, in the current directory, gives the defaults: module (the file to
build when none is given), coding-model (the agents that build) and harness-model (the planner). It exits
0 only when every module is complete: regenerated from the spec as it is, and its conformance tests written
for every functional spec's scenarios.

  --dry-run                look ahead: plan the work as regenerate would and print the prompt of each codebase's
                           next pulse, starting and writing nothing
  --start-over             start over, without asking, a codebase regenerated without a module it now requires -
                           with no terminal to ask and without it, the run stops there
  --from-scratch           delete the module's code and conformance tests (its lineage keeps them) and regenerate all of it
  --from-scratch-chain     the same for every module of its requires chain, built again from the bottom - after
                           modules were split or moved
  --harness-model <p/id>   config.turri.yaml's harness-model for this run: the planner
  --coding-model <p/id>    its coding-model, --model too: the agents that build; p/id:level for how hard a model thinks
  --judge-model <p/id>     its judge-model: the judge and the test review
  --review <true|false>    its review: whether the code and its tests are reviewed once they pass
  --mutation-testing <true|false>
                           its mutation-testing: whether the coding agent and the reviewer can put a bug in the code
                           for one test run (can_it_fail), to see that a test catches it
  --build-dir <dir>        as the run ends, however it ends, export the code there: the furthest-built codebase's
                           last commit, which holds every module it requires - the folder's contents are replaced
  --report <file.json>     write a report of the run there - outcome, usage, pulses, functional specs completed -
                           as it starts, as each pulse ends and as it exits (docs/headless.md)

  PLAIN_TEMPLATE_DIRS      colon-separated template directories`;

const { positional, options } = parseArgs(process.argv.slice(2), ["--dry-run", "--start-over", "--from-scratch", "--from-scratch-chain"], USAGE, ["--build-dir", "--report", "--harness-model", "--judge-model", "--review", "--mutation-testing"]);
const { report, buildDir } = headlessOptions(options);
const named = positional[0] ?? readProjectConfig(process.cwd()).module;
// Functional specs named after the file: regenerated again though their spec did not change.
const again = positional.slice(1);
if (!named) {
  console.error(`${USAGE}\n\nNo file given, and ${CONFIG_FILE} names no module.`);
  process.exit(1);
}
const scratch = options["from-scratch-chain"] !== undefined ? "chain" : options["from-scratch"] !== undefined ? "module" : undefined;
const dryRun = options["dry-run"] !== undefined;
// A dry run writes nothing: from scratch deletes the code before it plans, and functional specs named are marked in the records first.
if (scratch !== undefined && dryRun) {
  console.error(`--from-scratch${scratch === "chain" ? "-chain" : ""} deletes the code before anything is planned: it cannot be a dry run.`);
  process.exit(1);
}
if (again.length > 0 && dryRun) {
  console.error(`${again.join(", ")} would be marked to regenerate again in the code records before anything is planned: that cannot be a dry run.`);
  process.exit(1);
}
runLoop({
  plainFile: named,
  ...(buildDir !== undefined ? { buildDir } : {}),
  ...(report !== undefined ? { report } : {}),
  command: ["regenerate", ...process.argv.slice(2)],
  dryRun,
  startOver: options["start-over"] !== undefined,
  // A dry run is a look ahead: planned as regenerate plans it, nothing started.
  ask: (loop) =>
    dryRun
      ? loop.lookAhead(named)
      : again.length > 0
      ? loop.regenerateAgain(named, again)
      : scratch !== undefined
        ? loop.fromScratch(named, { chain: scratch === "chain" })
        : loop.bringUp(named),
}).catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
