import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { debugMode, judgeModelOf, testDirOf } from "../config.ts";
import { PACKAGE_ROOT } from "../environment.ts";
import { runSkill, type RunSkillResult } from "../genome.ts";
import type { Reporter } from "../graph.ts";
import { checkTouchedPlain, formatCheckResults } from "../plain/check.ts";
import { plainFileParser } from "../plain/parser.ts";
import { FUNCTIONAL_REQUIREMENTS, TEST_REQUIREMENTS, type FunctionalSpecItem } from "../plain/spec.ts";
import { projectFiles } from "../plain-files.ts";
import { checkPlainTool } from "../validate-tool.ts";
import { clearOfStop, JobStoppedError } from "./activity.ts";
import { scenariosOf, textHash, type AdvisorReport } from "./advisor-records.ts";
import { AdvisorDroppedError, type AdvisorWork, type AdvisorWritten } from "./advisor-runs.ts";
import { conversationWriting } from "./conversation-writes.ts";
import type { WorkLoop } from "./loop.ts";
import { ensureInScratch, MODULES_DIR, resolveTemplateDirs } from "./paths.ts";
import { writeTestReqs } from "./test-advisor.ts";
import { conformanceScriptOf, conformanceTemplateOf } from "./testing-steps.ts";

/**
 * What the test advisor writes on a yes, in order, only what is missing - what the step-7 guard (`testingGap`) would
 * refuse the scenarios for (docs/test-advisor.md):
 *
 * 1. **The tip's test reqs:** the import of its stack's conformance template, `stdlib/<kind>/conformance/<stack>`, added
 *    by code where there is one - else written by one call on the advisor's model.
 * 2. **The conformance testing script:** the `implement-conformance-testing-script` skill, in the background - accepted
 *    unread, as a script the chat writes is.
 * 3. **The scenarios:** the gated `write-test-scenarios` skill, from the report, judged.
 *
 * "Background" is how a skill is started here, not anything of the skill's: it runs on a copy of the project's ***plain -
 * its .plain files, test plain files, linked resources, testing scripts and config - with nobody to ask and no sign of
 * it anywhere. What it wrote lands at the end as one ***plain change, brought up through the loop as any change is; the
 * stop signal throws the copy away, and nothing half-written reaches the project. A text that changed, or a file of the
 * change that changed in the project meanwhile, drops the work instead of landing it.
 */

export interface AdvisorWriterOptions {
  /** The session's work loop, which the change is brought up through - none yet: the change lands, and is built when asked. */
  loop: () => WorkLoop | undefined;
  /** The conversation's own words on what matters for a module. */
  context?: (plainFile: string) => string[];
}

/** turri's own skills, by name. */
const skillDir = (name: string) => join(PACKAGE_ROOT, "genome", "skills", name);

/** A skill's progress, told to nobody: the advisor's work shows nowhere. */
const SILENT: Reporter = {
  step: () => {},
  artifact: () => {},
  gate: () => {},
  judge: () => {},
  outcome: () => {},
};

/** A module's frontmatter with `name` added to its imports - the frontmatter made, when it has none. */
export function withImport(text: string, name: string): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/.exec(text);
  if (match === null) return `---\nimport:\n  - ${name}\n---\n\n${text}`;
  const lines = match[1]!.split(/\r?\n/);
  const at = lines.findIndex((line) => /^import\s*:/.test(line));
  if (at === -1) lines.push("import:", `  - ${name}`);
  else {
    const rest = lines[at]!.replace(/^import\s*:\s*/, "").trim();
    if (rest.startsWith("[")) {
      const inner = rest.replace(/^\[/, "").replace(/\]$/, "").trim();
      lines[at] = `import: [${inner === "" ? name : `${inner}, ${name}`}]`;
    } else if (rest !== "") {
      lines.splice(at, 1, "import:", `  - ${rest}`, `  - ${name}`);
    } else {
      let end = at + 1;
      while (end < lines.length && /^\s+-\s/.test(lines[end]!)) end += 1;
      const indent = /^(\s+)-/.exec(lines[at + 1] ?? "")?.[1] ?? "  ";
      lines.splice(end, 0, `${indent}- ${name}`);
    }
  }
  return `---\n${lines.join("\n")}\n---${match[2]}${text.slice(match[0].length)}`;
}

/** A module with a `***test reqs***` section of `reqs`, put before its functional specs. */
export function withTestReqs(text: string, reqs: string[]): string {
  const section = `***test reqs***\n\n${reqs.map((req) => `- ${req}`).join("\n")}\n\n`;
  const at = text.search(/^\*\*\*functional specs\*\*\*/m);
  return at === -1 ? `${text.trimEnd()}\n\n${section}` : `${text.slice(0, at)}${section}${text.slice(at)}`;
}

/** A module's tree, its test plain files with it - or nothing when it does not parse. */
function treeOf(plainFile: string) {
  try {
    return plainFileParser(basename(plainFile), resolveTemplateDirs(plainFile), { allowNoFunctionalities: true, testDir: testDirOf(plainFile) })[1];
  } catch {
    return undefined;
  }
}

/** A functional spec of a module, as its .plain file has it now. */
function itemOf(plainFile: string, funcId: string): FunctionalSpecItem | undefined {
  return ((treeOf(plainFile)?.[FUNCTIONAL_REQUIREMENTS] as FunctionalSpecItem[] | undefined) ?? []).find((item) => item.id === funcId);
}

/** The report, as the scenarios' writer is given it. */
export function describeReport(report: AdvisorReport): string[] {
  return [
    "Why it needs testing:",
    ...report.questions.map((answered) => `- ${answered.question}: ${answered.evidence}`),
    "Inputs to cover:",
    ...report.inputs.map((input, index) =>
      "agreed" in input ? `${index + 1}. input: ${input.input} - agreed output: ${input.agreed}` : `${index + 1}. input: ${input.input} - split: ${input.readings.map((reading, at) => `(${at + 1}) ${reading}`).join("; ")}`,
    ),
  ];
}

/** The writer of the advisor's scenarios, landing through the session's loop. */
export function createAdvisorWriter(options: AdvisorWriterOptions): (work: AdvisorWork) => Promise<AdvisorWritten> {
  return async (work) => {
    const { project } = work;
    const scratch = join(project, ".turri");
    const copy = ensureInScratch(scratch, join(scratch, "advisor", "work", `${work.module}-${work.funcId}-${Date.now().toString(36)}`));
    try {
      // The copy: the project's ***plain, and what the agents read beside it - a project of its own, plain_modules/ marking it.
      const snapshot = projectFiles(project);
      for (const path of [...snapshot.keys(), ...(existsSync(join(project, "AGENTS.md")) ? ["AGENTS.md"] : [])]) {
        mkdirSync(dirname(join(copy, path)), { recursive: true });
        copyFileSync(join(project, path), join(copy, path));
      }
      mkdirSync(join(copy, MODULES_DIR), { recursive: true });
      const inCopy = (path: string) => join(copy, relative(project, path));
      const tip = inCopy(work.tip);
      const module = inCopy(work.plainFile);
      const tipName = basename(work.tip).replace(/\.plain$/, "");
      const context = [...(existsSync(join(project, "AGENTS.md")) ? [readFileSync(join(project, "AGENTS.md"), "utf8")] : []), ...(options.context?.(work.plainFile) ?? [])];
      const callOptions = { cwd: copy, ...(work.model !== undefined ? { model: work.model } : {}) };
      const stopped = () => {
        if (work.signal.aborted) throw new JobStoppedError();
      };

      // 1. The tip's test reqs - the chain's tests live there.
      let testReqs = false;
      const tipTree = treeOf(tip);
      if (tipTree === undefined) throw new Error(`${tipName} does not check, so nothing is written for it`);
      if (((tipTree[TEST_REQUIREMENTS] as unknown[] | undefined) ?? []).length === 0) {
        const template = conformanceTemplateOf(tip);
        const text = readFileSync(tip, "utf8");
        const reqs = template === undefined ? await writeTestReqs({ module: tipName, text }, context, callOptions) : [];
        stopped();
        writeFileSync(tip, template !== undefined ? withImport(text, template) : withTestReqs(text, reqs));
        testReqs = true;
      }

      // 2. The conformance testing script, for the tip's stack.
      let script = false;
      if (conformanceScriptOf(tip).script === undefined) {
        await background("implement-conformance-testing-script", {
          copy,
          work,
          context: [
            `turri's test advisor is adding conformance tests to the module ${tipName} (${relative(project, work.tip)}), in the background: nobody can be asked.`,
            "Write the conformance testing script for its stack, as this skill says, and make sure turri finds it. Decide what the skill would ask - the",
            "language, the dependency manifest - from the module's ***plain and its ***test reqs***.",
          ].join("\n"),
        });
        stopped();
        if (conformanceScriptOf(tip).script === undefined) throw new Error("no conformance testing script was written for the module's stack");
        script = true;
      }

      // 3. The scenarios.
      const testFile = join(relative(project, testDirOf(work.plainFile)), work.module, `${work.funcId}.plain`);
      const previous = work.previous.map((scenario) => `${scenario.kind} ${scenario.id}`);
      const ran = await background("write-test-scenarios", {
        copy,
        work,
        judged: true,
        context: [
          `turri's test advisor judged the functional spec ${work.module}:${work.funcId} to need explicit testing scenarios. Write them, in the background: nobody can be asked.`,
          "",
          `The functional spec: ${work.module}:${work.funcId}, in ${relative(project, work.plainFile)}`,
          `Its test plain file: ${testFile}`,
          previous.length > 0 ? `turri's earlier scenarios, which you may replace or drop: ${previous.join(", ")}` : "",
          "",
          "<report>",
          ...describeReport(work.report),
          "</report>",
        ]
          .filter((line, index, all) => line !== "" || all[index - 1] !== "")
          .join("\n"),
      });
      stopped();
      if (!ran.ok) throw new Error("the review of its scenarios did not pass");
      const written = scenariosOf(itemOf(module, work.funcId));
      if (written.length === 0) throw new Error(`no scenario was written for ${work.module}:${work.funcId}, or its module does not check with it`);

      // Landing: the text it judged still the text, the files it changed still as it copied them - else the work is dropped.
      const after = projectFiles(copy, snapshot.keys());
      const changed = [...new Set([...after.keys(), ...snapshot.keys()])].filter((path) => after.get(path) !== snapshot.get(path)).sort();
      const now = projectFiles(project, changed);
      const moved = changed.filter((path) => now.get(path) !== snapshot.get(path));
      if (moved.length > 0) throw new AdvisorDroppedError(`${moved.join(", ")} changed while it wrote`);
      const item = itemOf(work.plainFile, work.funcId);
      if (item === undefined || textHash(item.markdown) !== work.hash) throw new AdvisorDroppedError("the functional spec's text changed while it wrote");
      stopped();
      const originals = new Map(changed.map((path) => [path, existsSync(join(project, path)) ? readFileSync(join(project, path)) : undefined]));
      // Written beside the pulses as the conversation's writes are: the audit of an agent's command running now leaves them.
      const put = (path: string, content: Buffer | undefined) => {
        const done = conversationWriting([join(project, path)]);
        try {
          if (content === undefined) rmSync(join(project, path), { force: true });
          else {
            mkdirSync(dirname(join(project, path)), { recursive: true });
            writeFileSync(join(project, path), content);
          }
        } finally {
          done();
        }
      };
      for (const path of changed) put(path, existsSync(join(copy, path)) ? readFileSync(join(copy, path)) : undefined);
      // As change_plain does: nothing that does not check stays written.
      const touched = changed.filter((path) => path.endsWith(".plain")).map((path) => resolve(project, path));
      const failed = checkTouchedPlain([work.plainFile, work.tip, ...touched]).filter((check) => !check.ok);
      if (failed.length > 0) {
        for (const [path, content] of originals) put(path, content);
        throw new Error(`what it wrote does not check: ${formatCheckResults(failed).split("\n")[0]}`);
      }
      // One ***plain change, brought up as any is: what is not built is planned, and the conformance pulse follows the code.
      try {
        // Clear of the work's stop: what the change starts outlives it.
        const loop = options.loop();
        if (loop !== undefined) await clearOfStop(loop).bringUp(work.tip, { specChange: true });
      } catch {
        /* the change is in the files: it is built the next time the loop looks */
      }
      return { scenarios: scenariosOf(itemOf(work.plainFile, work.funcId)), testReqs, script };
    } finally {
      if (!debugMode(project)) rmSync(copy, { recursive: true, force: true });
    }
  };
}

/** A skill run in the background on the copy: no one to ask, no sign of it, stopped with the work. */
async function background(name: string, given: { copy: string; work: AdvisorWork; context: string; judged?: boolean }): Promise<RunSkillResult> {
  const judge = given.judged === true ? judgeModelOf(given.work.plainFile) : undefined;
  return runSkill({
    skillDir: skillDir(name),
    cwd: given.copy,
    runDir: join(given.copy, ".turri", "runs", name),
    report: SILENT,
    // A gate that cannot be satisfied is not let through: nobody is there to say so.
    escalate: async () => false,
    context: given.context,
    ...(given.work.model !== undefined ? { model: given.work.model } : {}),
    ...(judge !== undefined ? { judgeModel: judge } : {}),
    role: "advisor",
    sharedTools: [checkPlainTool(given.copy)],
    signal: given.work.signal,
  });
}
