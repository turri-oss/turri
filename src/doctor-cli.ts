import { rmSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { asksModels, verdictOf, checkNode, type Check, type Level } from "@turri-dev/core/system";
import { allChecks, MARK } from "@turri-dev/core/commands";
import { globalExtensionFile } from "@turri-dev/core/startup";
import { configKeyOptions, parseArgs } from "./cli-options.ts";
import { brand } from "./brand.ts";

function report(checks: Check[]): number {
  const paint: Record<Level, (text: string) => string> = { ok: brand.success, missing: brand.error, limited: brand.warning, info: brand.muted };
  // The names in one column, however long the longest - `judge-model, models.judge` - is.
  const width = Math.max(20, ...checks.map((check) => check.name.length)) + 1;
  const under = " ".repeat(width + 4);
  console.log("");
  for (const check of checks) {
    const name = check.level === "missing" ? brand.bold(check.name.padEnd(width)) : check.name.padEnd(width);
    console.log(`  ${paint[check.level](MARK[check.level])} ${name}${check.level === "info" ? brand.muted(check.detail) : check.detail}`);
    for (const line of check.more ?? []) console.log(`${under}${brand.muted(line)}`);
    if (check.fix && check.level !== "ok") console.log(`${under}${brand.accent(`→ ${check.fix}`)}`);
  }
  const verdict = verdictOf(checks);
  console.log("");
  console.log((verdict.ready ? (verdict.limited ? brand.warning : brand.success) : brand.error)(verdict.text));
  return verdict.ready ? 0 : 1;
}

/**
 * Ask a yes/no question. With --yes, yes. With no terminal to ask on, no - nothing is changed
 * without asking - and it says so, so a piped run shows what it would have done.
 */
async function confirm(question: string, fallback: boolean, yes: boolean): Promise<boolean> {
  if (yes) return true;
  if (!process.stdin.isTTY) {
    console.log(`${question} - not asked: no terminal. Run turri doctor in a terminal, or with --yes.`);
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} ${fallback ? "[Y/n]" : "[y/N]"} `)).trim().toLowerCase();
    return answer === "" ? fallback : answer.startsWith("y");
  } finally {
    rl.close();
  }
}

/**
 * Take turri out of every `pi`: the extension file an older `turri setup` wrote. The themes it copied stay - they only
 * add turri's themes to pi's list.
 */
function removeGlobalExtension(): void {
  const file = globalExtensionFile();
  if (file === undefined) return;
  rmSync(file, { force: true });
  console.log(`  removed ${file}`);
}

const USAGE = [
  "usage: turri doctor [--harness-model <m>] [--coding-model <m>] [--judge-model <m>] [--no-models] [--yes]",
  "",
  "Check everything turri needs - in a project, what its modules need of this machine too, and that",
  "each model its config names answers with this machine's credentials (one short request a model;",
  "--no-models skips it). The model options are read as the config's keys, as turri regenerate reads them:",
  "a headless run's models can be checked before it starts, with no config.turri.yaml.",
  "It changes nothing but this, asked first: a plain pi that an older turri made load turri too is put back to",
  "plain pi. --yes answers yes.",
].join("\n");

export async function main(args: string[]): Promise<number> {
  const { options } = parseArgs(args, ["--no-models", "--yes", "-y"], USAGE, ["--harness-model", "--judge-model"]);
  configKeyOptions(options);
  console.log(brand.bold(brand.accent("Checking what turri needs.")));
  const node = checkNode();
  if (node.level !== "ok") return report([node]);
  const modelsGiven = ["harness-model", "model", "judge-model"].some((name) => options[name] !== undefined);
  const checking = { dir: process.cwd(), models: options["no-models"] === undefined, cli: true, modelsGiven };
  if (asksModels(checking)) console.log(brand.muted("Asking each model the config names for a word..."));
  const code = report(await allChecks(checking));
  // turri and pi are kept apart: a plain pi does not start turri. An older turri's file that made it do so goes, asked.
  const global = globalExtensionFile();
  if (global !== undefined && (await confirm(`\nA plain \`pi\` loads turri too, through ${global}. Remove it, so pi stays pi?`, true, options.yes !== undefined || args.includes("-y")))) {
    removeGlobalExtension();
  }
  return code;
}
