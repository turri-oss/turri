import { join } from "node:path";
import { historyLog, historyShow, MODULES_DIR } from "@turri-dev/core/project";

const USAGE = `usage: turri lineage <module> [commit]

A module's lineage: every generation of its code and tests, and what each was regenerated from, as git commits.
With a commit, that commit in full.`;

const [module, commit] = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));
if (module === undefined || process.argv.includes("--help")) {
  console.log(USAGE);
  process.exit(module === undefined ? 1 : 0);
}
// core-gap: where a module's code is built - plain_modules/<module>/code - is the core's defaultBuildDir, which is not
// public: the layout is written out here until it is.
const buildDir = join(process.cwd(), MODULES_DIR, module, "code");
console.log(commit !== undefined ? historyShow(buildDir, commit) : historyLog(buildDir));
