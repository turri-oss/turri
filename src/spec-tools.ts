import { resolve } from "node:path";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { advisingNote } from "./advisor-chat.ts";
import { checkTouchedPlain, formatCheckResults } from "./plain/check.ts";
import { applySpecDiff, plainFilesOf, revertSpecDiff } from "./regenerate/regenerate.ts";
import { refuseTestPlainFile } from "./test-plain-files.ts";
import { describeModules, type WorkLoop } from "./regenerate/loop.ts";
import { reviewNote, type LiveReviewer } from "./tools.ts";
import { STACK_PARAM, stacklessBuild, withCallStack } from "./loop-tools.ts";
import { stackNamed } from "./config.ts";
import { projectDirOf } from "./regenerate/paths.ts";

/** Whether a question has been answered since the last new spec change was written. */
export interface SpecPace {
  /** A question was answered; `owesChange` false for one no change comes from - a phase's confirmation, a dismissal. */
  answered(owesChange?: boolean): void;
  /** Whether an answer has come since the last change, and is not written yet. */
  owed(): boolean;
}

type AnyTool = ToolDefinition<any, any, any>;

/**
 * Writing a spec change as a diff, and building it, as one step.
 *
 * In an interview whose unit of work is a spec change, every change is meant to be built the
 * moment it is written. Left to two tool calls - change the file, then start the render - the
 * second is the one that gets forgotten, and nothing notices. So the diff is applied and its
 * build queued in the same call: a change cannot reach the specs without its render being
 * started. A new change needs an answer since the last one; a correction does not.
 */
export function createSpecDiffTools(options: {
  loop: WorkLoop;
  cwd: string;
  liveReview?: LiveReviewer;
  /** One new change per answer (the default); false, for a skill that writes the specs on its own. */
  paced?: boolean;
  /**
   * Whether the phase the interview is in lets a change come without an answer before it: one where each answer owes a
   * change instead (`owed`, refused a next question until it is written), and the agent writes what it decides itself.
   */
  free?: () => boolean;
}): { tools: AnyTool[]; pace: SpecPace } {
  const { loop, cwd, liveReview } = options;
  const skillPaced = options.paced !== false;
  const isPaced = () => skillPaced && options.free?.() !== true;
  /** An answer has come since the last change: it is owed one. */
  let owed = false;
  let answeredSinceLastDiff = true;

  const writeDiff = defineTool({
    name: "change_plain",
    label: "Write spec diff",
    description:
      "Apply a change to the ***plain specs, given as a git diff of the .plain files, and start building it in " +
      "the background. The diff is applied with git; if the specs no longer parse, it is undone and nothing is " +
      "built. Any section may change - definitions, implementation reqs, functional specs, added, changed or removed - and " +
      "every change is built, whatever it touches. A diff may touch test plain files too - tests/<module>/<func-id>.plain, " +
      "a functional spec's conformance and acceptance scenarios. A functional spec with none has no test plain file: " +
      "write one only to give it scenarios.",
    promptSnippet: "apply a git diff of the .plain specs and start building it",
    promptGuidelines: [
      "Every change to a .plain file in the product phase goes through change_plain, as a git diff with paths relative to the project root. It writes the change and starts its build in one step.",
      "A functional spec is a `# <func-id>` heading and its text. One with scenarios has a test plain file, tests/<module>/<func-id>.plain: its `module:` and `func_id:`, then `***conformance tests***` and `***acceptance tests***`, each scenario a `# <scenario-id>` heading and its text - a section only when it has a scenario, an empty one being a syntax error. One with no scenarios has no test plain file. plain_file stays the module's .plain file when the diff touches only its test plain files.",
      skillPaced
        ? "One change per answer, and a new one only after the user has answered a question about it. Set fixes_earlier to correct something already written."
        : "Write the changes one after another, on your own: no answer is needed between them, and none is asked for. Set fixes_earlier to correct something already written.",
      "In a project of stacks, the change is built with the stack named after the module - backend.plain with config.turri.backend.yaml - by itself. For a module whose stack has another name, pass it as stack. A change that cannot be built yet for want of a stack is written all the same: carry on, and pass the stack with the next change.",
      "To take something out of what is already written and queued - the user drops a page or a feature - write the diff that removes it from every spec that names it, with fixes_earlier. What is left to build is worked out from the spec each time, and a build the change undoes is stopped by itself; never stop builds to drop a change - it stays in the files.",
    ],
    parameters: Type.Object({
      plain_file: Type.String({ description: "The .plain file of the module the change is built for" }),
      diff: Type.String({ description: "The change, as a git diff (diff --git a/<file> b/<file> ...)" }),
      fixes_earlier: Type.Optional(
        Type.Boolean({ description: "This corrects something already written - a contradiction, a review finding" }),
      ),
      stack: STACK_PARAM,
      guidance: Type.Optional(
        Type.String({
          description:
            "How to plan the queue for this change, in a sentence or two - which functional specs go together, what first - as the " +
            "user said it or as the interview settled it. A strong preference for the planner. Omit when there is none.",
        }),
      ),
    }),
    async execute(_id, params) {
      const paced = isPaced();
      if (paced && params.fixes_earlier !== true && !answeredSinceLastDiff) {
        throw new Error(
          "No question has been answered since the last spec change. Each change comes from its own answer: ask " +
            "the user with ask_user first. To correct something already written, set fixes_earlier.",
        );
      }

      const touched = plainFilesOf(params.diff);
      if (touched.length === 0) throw new Error("The diff changes no .plain file. Nothing was written.");

      refuseTestPlainFile(resolve(cwd, params.plain_file));
      const result = applySpecDiff(params.diff, cwd);
      // A change that breaks a spec is not written at all, so nothing is ever built from a file that cannot be parsed:
      // each module it touched is parsed with its test plain files - an import module as the modules that import it
      // read it, a test plain file as its module - as validate parses them. A module with no functional specs yet is
      // not broken.
      const failed = checkTouchedPlain([params.plain_file, ...touched].map((file) => resolve(cwd, file))).filter((check) => !check.ok);
      if (failed.length > 0) {
        if (result === "applied") revertSpecDiff(params.diff, cwd);
        throw new Error(`Nothing was written: with this change the ***plain no longer checks.\n${formatCheckResults(failed)}`);
      }
      if (params.fixes_earlier !== true) answeredSinceLastDiff = false;
      owed = false;
      liveReview?.notice(`${params.plain_file}, after the change to ${touched.join(", ")}`);

      // In the files, the change is work: the loop works out what is left to build and plans it - with the stack the call
      // names, else the module's own. A spec change, not a request: a module the person halted stays halted. The change
      // is written whatever the stack: one that cannot be built yet is said, and built once it can - nothing is lost.
      const building = resolve(cwd, params.plain_file);
      let stackless: string | undefined;
      try {
        stackless = params.stack === undefined ? stacklessBuild(building) : (stackNamed(projectDirOf(building), params.stack), undefined);
      } catch (error) {
        stackless = error instanceof Error ? error.message : String(error);
      }
      const statuses =
        stackless === undefined
          ? await withCallStack(building, params.stack, () => loop.bringUp(params.plain_file, { specChange: true, ...(params.guidance !== undefined ? { guidance: params.guidance } : {}) }))
          : [];
      const lines = [
        result === "applied" ? `Applied the change to ${touched.join(", ")}.` : `The change to ${touched.join(", ")} was already applied.`,
        stackless === undefined
          ? `Building in the background:\n${describeModules(statuses)}\n`
          : `Not built yet - ${stackless} The change is in the spec: pass stack with the next change, or call regenerate with it, and everything written so far is built.\n`,
        // An interview goes back to its questions; a skill that writes on its own, straight to its next change - a stop to ask ends it.
        paced
          ? "Carry on with the interview."
          : skillPaced
            ? "Carry on: write the next change you decided yourself, or ask the next question - every answer is written as a change before the question after it."
            : "Write the next change now, without stopping to ask: this skill goes on until everything it is to write is written.",
      ];
      // The functional specs the test advisor took up, for the agent to say so rather than offer their scenarios.
      const advising = advisingNote(loop, building);
      return {
        content: [{ type: "text" as const, text: lines.join(" ") + reviewNote(liveReview) + (advising !== "" ? `\n\n${advising}` : "") }],
        details: { jobIds: statuses.flatMap((status) => (status.running !== undefined ? [status.running.jobId] : [])), files: touched },
      };
    },
  });

  return {
    tools: [writeDiff],
    pace: {
      answered(owesChange = true) {
        answeredSinceLastDiff = true;
        if (owesChange) owed = true;
      },
      owed: () => owed,
    },
  };
}
