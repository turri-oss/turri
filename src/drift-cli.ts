import { readProjectConfig, CONFIG_FILE } from "@turri-dev/core/config";
import { describeDrift, readDrift } from "@turri-dev/core/commands";

const USAGE = `usage: turri drift [file.plain]

How far the module's code has drifted from its spec, in each codebase where it lives: what is left to
regenerate, and the conformance tests left to write. Plans nothing, starts nothing, calls no model.`;

const [given] = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(USAGE);
  process.exit(0);
}
const named = given ?? readProjectConfig(process.cwd()).module;
if (named === undefined) {
  console.error(`${USAGE}\n\nNo file given, and ${CONFIG_FILE} names no module.`);
  process.exit(1);
}
try {
  console.log(describeDrift(readDrift(named)));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
