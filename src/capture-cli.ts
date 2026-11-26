import { relative, resolve } from "node:path";
import { CaptureError, DEFAULT_PARALLEL, runCapture } from "./capture/capture.ts";
import { c } from "./module-report.ts";

/**
 * `turri capture [path] [--harness-model <m>] [--coding-model <m>] [--into <folder>] [--parallel <n>]`: capture the
 * codebase at `path` - the current folder by default - into ***plain in `<path>/plain`, offline: nothing is asked, and
 * what was decided is in the report. A capture stopped part-way is gone on with by running it again.
 */

const USAGE = [
  "usage: turri capture [path] [--harness-model <m>] [--coding-model <m>] [--into <folder>] [--parallel <n>]",
  "",
  "Capture the codebase at path (the current folder by default) into ***plain, in <path>/plain - nothing is asked:",
  "what capture decided, left out or could not capture is in plain/.turri/capture/report.md. Run it again to go on",
  "with a capture that was stopped.",
  "",
  "  --harness-model <m>  the project's harness model; Claude capture defaults to Haiku low / Sonnet low / Opus medium",
  "  --coding-model <m>   the project's coding model; set models.capture-exploration, capture-analysis and capture to override capture's tiers",
  "  --into <folder>      where the ***plain goes, instead of <path>/plain",
  `  --parallel <n>       how many agents work at once (default: ${DEFAULT_PARALLEL})`,
].join("\n");

function option(args: string[], name: string): string | undefined {
  const at = args.findIndex((arg) => arg === name || arg.startsWith(`${name}=`));
  if (at === -1) return undefined;
  const arg = args[at]!;
  return arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : args[at + 1];
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.includes("-h") || args.includes("--help")) {
    console.log(USAGE);
    return 0;
  }
  // cli.ts hands --coding-model on as --model, as every command's agents take it.
  const valued = ["--harness-model", "--model", "--into", "--parallel"];
  const positional = args.filter((arg, at) => !arg.startsWith("-") && !valued.includes(args[at - 1] ?? ""));
  const unknown = args.filter((arg, at) => arg.startsWith("-") && !valued.some((name) => arg === name || arg.startsWith(`${name}=`)) && !valued.includes(args[at - 1] ?? ""));
  if (positional.length > 1 || unknown.length > 0) {
    console.error(`${unknown.length > 0 ? `unknown option: ${unknown[0]}` : "capture takes one path"}\n\n${USAGE}`);
    return 1;
  }
  const parallelText = option(args, "--parallel");
  const parallel = parallelText !== undefined ? Number.parseInt(parallelText, 10) : undefined;
  if (parallel !== undefined && (!Number.isInteger(parallel) || parallel < 1)) {
    console.error(`--parallel takes a whole number of at least 1, not ${parallelText}.`);
    return 1;
  }
  const root = resolve(positional[0] ?? ".");
  const into = option(args, "--into");
  const harnessModel = option(args, "--harness-model");
  const codingModel = option(args, "--model");
  const started = Date.now();
  console.log(c.bold(`capturing ${root}`));
  try {
    const result = await runCapture({
      root,
      // The captured project starts as the config in use here: the one turri reads where the command is run.
      configFrom: process.cwd(),
      ...(into !== undefined ? { plainDir: resolve(into) } : {}),
      ...(harnessModel !== undefined ? { model: harnessModel, harnessModel } : {}),
      ...(codingModel !== undefined ? { codingModel } : {}),
      ...(parallel !== undefined ? { parallel } : {}),
      progress: (line) => console.log(c.dim(`  ${line}`)),
    });
    const minutes = Math.round((Date.now() - started) / 60_000);
    console.log(`\n${c.success(c.bold(result.summary))} ${c.dim(`(${minutes} min)`)}`);
    console.log(c.dim(`the report: ${relative(process.cwd(), result.reportFile) || result.reportFile}`));
    return 0;
  } catch (error) {
    console.error(`\n${c.error(c.bold("not captured"))} ${error instanceof Error ? error.message : String(error)}`);
    if (!(error instanceof CaptureError) && error instanceof Error && error.stack !== undefined) console.error(c.dim(error.stack));
    return 1;
  }
}

process.exit(await main());
