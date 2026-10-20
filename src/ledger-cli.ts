import { resolve } from "node:path";
import { readLedger } from "./regenerate/ledger.ts";
import { describePastPulse, describeRuns, ledgerProjects, runViews } from "./regenerate/ledger-view.ts";

const USAGE = `usage: turri ledger [pulse] [--runs <n>] [--json]

What turri did here, from the project's ledger (.turri/ledger): the last runs, a line a pulse - how each ended, how
long it took and what it cost. With a pulse's id, or the start of it, that pulse: its rounds, test runs, verdicts,
healers, what turri refused and what its history recorded. --json prints the events themselves, a JSON line each.

  --runs <n>   how many runs to show, the most recent first (default 5)
  --json       the events, as the ledger has them - the pulse's alone with a pulse`;

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(USAGE);
  process.exit(0);
}
const runsAt = args.indexOf("--runs");
const runs = runsAt >= 0 ? Number(args[runsAt + 1]) : 5;
if (runsAt >= 0 && (!Number.isInteger(runs) || runs < 1)) {
  console.error(`--runs takes a number of runs, at least 1\n\n${USAGE}`);
  process.exit(1);
}
const [pulse] = args.filter((arg, at) => !arg.startsWith("-") && (runsAt < 0 || at !== runsAt + 1));
const projects = ledgerProjects(process.cwd());
if (projects.length === 0) {
  console.log("No ledger here: turri has not run in this folder, or in a project under it, since the ledger began.");
  process.exit(0);
}

if (args.includes("--json")) {
  for (const project of projects) for (const entry of readLedger(project, pulse !== undefined ? { job: pulse } : {})) console.log(JSON.stringify(entry));
  process.exit(0);
}

if (pulse !== undefined) {
  const described = describePastPulse(projects, pulse);
  if (described === undefined) {
    console.error(`The ledger has no pulse ${pulse}.`);
    process.exit(1);
  }
  console.log(described);
  process.exit(0);
}

for (const project of projects) {
  if (projects.length > 1) console.log(`── ${resolve(project)}\n`);
  console.log(describeRuns(runViews(project).slice(0, runs)));
  if (projects.length > 1) console.log("");
}
