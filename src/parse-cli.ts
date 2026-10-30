import { checkPlainTargets, formatCheckResults } from "./plain/check.ts";
import { c } from "./module-report.ts";

const USAGE = `usage: turri parse <file.plain | directory> [options]

Parses ***plain - its syntax and structure, never its code or tests: each module with its test plain files,
its imports and required modules, every error reported without regenerating anything - and every test plain file
outside its module's folder. A functional spec with no test plain file is not tested. A module whose
functional specs have scenarios but which has no test reqs, or no conformance testing script for its
stack, is a warning: its conformance tests are not written until it has them. A test plain file or
test folder is refused: name its module.

  --template-dir <dir>   extra template directory (repeatable)
  --json                 machine-readable output

  PLAIN_TEMPLATE_DIRS    colon-separated template directories`;


const argv = process.argv.slice(2);
const templateDirs: string[] = [];
const positional: string[] = [];
let json = false;

for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i]!;
  if (arg === "--template-dir") templateDirs.push(argv[++i]!);
  else if (arg === "--json") json = true;
  else if (arg === "-h" || arg === "--help") {
    console.log(USAGE);
    process.exit(0);
  } else positional.push(arg);
}

const target = positional[0] ?? ".";
const results = checkPlainTargets(target, templateDirs);

if (results.length === 0) {
  console.error(`No .plain files found in ${target}.`);
  process.exit(1);
}

if (json) {
  console.log(JSON.stringify(results, null, 2));
} else {
  const output = formatCheckResults(results)
    .split("\n")
    .map((line) =>
      line.startsWith("PASS") ? c.success(line) : line.startsWith("FAIL") ? c.error(line) : line.startsWith("WARN") ? c.warning(line) : c.dim(line),
    )
    .join("\n");
  console.log(output);

  const failed = results.filter((r) => !r.ok).length;
  const warned = results.reduce((count, r) => count + (r.warnings?.length ?? 0), 0);
  const warnings = warned > 0 ? c.warning(` - ${warned} warning${warned === 1 ? "" : "s"}`) : "";
  console.log(
    `\n${failed === 0 ? c.success(c.bold("all specs valid")) + warnings : c.error(c.bold(`${failed} of ${results.length} failed`))}`,
  );
}

process.exit(results.every((r) => r.ok) ? 0 : 1);
