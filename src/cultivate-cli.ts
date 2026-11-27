import { createInterface } from "node:readline/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createTurri, TurriError, type Question } from "@turri-dev/core";
import { clientInfo } from "./cli-root.ts";
import { c } from "./module-report.ts";

/**
 * `turri cultivate <skill>`: one of turri's gated skills - or the project's - run end to end from the command line, its
 * steps and review gates enforced by the core. Its questions are asked here, at the terminal; its phases are said as it
 * moves through them.
 */

const USAGE = "usage: turri cultivate <skill name> [--model provider/id]";

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

  // core-gap: skills.run runs a skill it finds by name - turri's own or the project's - and none from a folder: a folder
  // with a SKILL.md is refused until the core can run one.
  if (existsSync(join(skillArg, "SKILL.md"))) {
    console.error(`${skillArg} is a skill's folder: turri cultivate runs a skill by its name for now - turri's own, or one in the project's .turri/skills.`);
    return 1;
  }

  // Its questions and review gates are put here, at the terminal. A front end that asks makes chats, so the session is
  // told its chats' pi sessions are made elsewhere - and refuses them: cultivate opens none.
  // core-gap: a front end that asks the person but has no chats cannot say so - the sentinel, on, would try to open a
  // chat as a pulse a skill queued ends, and be refused.
  const turri = await createTurri({
    client: clientInfo(),
    persist: false,
    frontend: {
      ask: (question, { signal }) => askAtTerminal(question, signal),
      sessions: {
        kind: "external",
        create: () => Promise.reject(new TurriError("refused", "turri cultivate runs one skill, with no chats.")),
      },
    },
  });
  const stopping = new AbortController();
  process.on("SIGINT", () => {
    if (stopping.signal.aborted) process.exit(130);
    console.error(c.warning("\nstopping - ctrl+c again to leave at once"));
    stopping.abort();
  });
  try {
    const skills = turri.skills.list();
    const skill = skills.find((found) => found.name === skillArg);
    if (skill === undefined) {
      console.error(`No skill named ${skillArg}. The skills: ${skills.map((found) => found.name).join(", ")}.`);
      return 1;
    }
    console.log(c.bold(`skill: ${skill.name}`));
    // core-gap: describeGates is gone, and skills.run reports no gate's decision as it is made (the old Reporter): each
    // phase is said as it starts, from the skillProgress events, and the gates' judges and decisions are not.
    let shown = "";
    turri.on("skillProgress", ({ progress }) => {
      const step = progress?.phases[progress.current];
      if (progress === null || step === undefined) return;
      const line = `${step}:${progress.attempt}`;
      if (line === shown) return;
      shown = line;
      console.log(`\n${c.bold(c.accent(`> step ${step}`))} ${c.dim(`attempt ${progress.attempt}`)}${progress.about !== undefined ? c.dim(` - ${progress.about}`) : ""}`);
    });
    // A skill that names the coding model runs on it, harness-model on the rest; --model wins.
    const result = await turri.skills.run(skill.name, { ...(model !== undefined ? { model } : {}), signal: stopping.signal });
    // core-gap: skills.run keeps the run's folder to resume from, and does not say where it is: what each step left is named.
    const steps = Object.keys(result.artifacts);
    console.log(`\n${result.ok ? c.success(c.bold("run complete")) : c.error(c.bold("run aborted at a gate"))}${steps.length > 0 ? c.dim(` - artifacts of ${steps.join(", ")}`) : ""}`);
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
