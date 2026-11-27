import { createInterface } from "node:readline/promises";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { createTurri, type Question } from "@turri-dev/core";
import { clientInfo } from "./cli-root.ts";
import { c } from "./module-report.ts";
import { printReport } from "./skill-report.ts";

/**
 * `turri cultivate <skill>`: one of turri's gated skills - the project's, or one in a folder - run end to end from the
 * command line, its steps and review gates enforced by the core. Its questions are asked here, at the terminal; each
 * step, artifact, judge and gate decision is printed as it is made.
 */

const USAGE = "usage: turri cultivate <skill name | path-to-skill-dir> [--model provider/id]";

/** A question at the terminal: options numbered, the number or the words taken; a long brief printed whole above it. */
async function askAtTerminal(question: Question, signal: AbortSignal): Promise<string | undefined> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const context = question.context !== undefined ? `${question.context}\n\n` : "";
    const list = question.kind === "select" ? `\n${question.options.map((option, i) => `  ${c.bold(String(i + 1))}. ${option}`).join("\n")}` : "";
    const reply = (await rl.question(`\n${context}${c.bold(c.accent("? "))}${question.title}${list}\n> `, { signal })).trim();
    if (question.kind === "select") {
      const index = Number.parseInt(reply, 10);
      if (Number.isInteger(index) && index >= 1 && index <= question.options.length) return question.options[index - 1];
    }
    return reply === "" ? undefined : reply;
  } catch (error) {
    // Over without an answer - its turn stopped - or ctrl+d: no answer.
    if ((error as { code?: string }).code === "ABORT_ERR") return undefined;
    throw error;
  } finally {
    rl.close();
  }
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const modelIndex = args.indexOf("--model");
  const model = modelIndex === -1 ? undefined : args[modelIndex + 1];
  // The word after --model is the model, never the skill - and with no --model, no word is.
  const skillArg = args.filter((arg, i) => !arg.startsWith("--") && (modelIndex === -1 || i !== modelIndex + 1))[0];
  if (!skillArg) {
    console.error(USAGE);
    return 1;
  }

  // Its questions and review gates are put here, at the terminal: a front end that asks, and has no chats - nor a sentinel.
  const turri = await createTurri({
    client: clientInfo("cultivate"),
    frontend: { ask: (question, { signal }) => askAtTerminal(question, signal), sessions: { kind: "none" } },
  });
  const stopping = new AbortController();
  process.on("SIGINT", () => {
    if (stopping.signal.aborted) process.exit(130);
    console.error(c.warning("\nstopping - ctrl+c again to leave at once"));
    stopping.abort();
  });
  try {
    // A folder with a SKILL.md, or a skill by name: turri's own or the project's.
    const folder = existsSync(join(skillArg, "SKILL.md"));
    if (!folder && !turri.skills.list().some((found) => found.name === skillArg)) {
      console.error(`No skill named ${skillArg}, and no SKILL.md in a folder of that name. The skills: ${turri.skills.list().map((found) => found.name).join(", ")}.`);
      return 1;
    }
    // A skill that names the coding model runs on it, harness-model on the rest; --model wins.
    const result = await turri.skills.run(folder ? { dir: skillArg } : skillArg, { ...(model !== undefined ? { model } : {}), signal: stopping.signal, onReport: printReport });
    console.log(`\n${result.ok ? c.success(c.bold("run complete")) : c.error(c.bold("run aborted at a gate"))} ${c.dim(`artifacts in ${relative(process.cwd(), result.runDir) || result.runDir}`)}`);
    return result.ok ? 0 : 1;
  } finally {
    await turri.dispose();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
