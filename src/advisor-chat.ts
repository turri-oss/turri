import { resolve } from "node:path";
import type { AdvisorQuestion } from "./regenerate/advisor-records.ts";
import type { AdvisorLanding, TestAdvisor } from "./regenerate/advisor-runs.ts";
import type { WorkLoop } from "./regenerate/loop.ts";
import { projectDirOf } from "./regenerate/paths.ts";

/**
 * What the chat the person looks at says when the test advisor's scenarios land, and what its agent is told
 * (docs/test-advisor.md): one line after the fact, the way a landed pulse is mentioned, and the report's gist for the
 * agent - to answer "why are there tests on add-task", and to do nothing more. A "no" says nothing.
 */

/** Why, in a few words, by the first question of the verdict that was a yes. */
const WHY: Partial<Record<AdvisorQuestion, string>> = {
  "silent-failure": "a wrong implementation could look right",
  divergence: "it can be read two ways",
  cost: "a bug in it would be costly",
};

/** The line the person is shown. */
export function advisorLine(landing: AdvisorLanding): string {
  const count = landing.written.scenarios.length;
  const spec = `${landing.module}:${landing.funcId}`;
  const why = landing.report.questions.map((answered) => WHY[answered.question]).find((reason) => reason !== undefined);
  const also = [landing.written.testReqs ? "its test reqs" : undefined, landing.written.script ? "a conformance testing script" : undefined].filter((part) => part !== undefined);
  const added = `I added ${count} scenario${count === 1 ? "" : "s"} to ${spec}${also.length > 0 ? `, with ${also.join(" and ")}` : ""}`;
  const when = landing.built ? "They're tested now that its code is built." : "They're tested once its code is built.";
  return `${added}${why !== undefined ? ` - ${why}` : ""}. ${when}`;
}

/** What the chat's agent is told: the line, the report's gist, and that the scenarios are not its to do anything about. */
export function advisorNote(landing: AdvisorLanding): string {
  const spec = `${landing.module}:${landing.funcId}`;
  return [
    `My test advisor wrote scenarios for ${spec} in the background, and they landed as a ***plain change: ${landing.written.scenarios.map((scenario) => `${scenario.kind} ${scenario.id}`).join(", ")}.`,
    `The person was shown: "${advisorLine(landing)}"`,
    "",
    "Why it judged them needed:",
    ...landing.report.questions.map((answered) => `- ${answered.question}: ${answered.evidence}`),
    "",
    "Do nothing about them: do not re-do, extend, review or test them unless the person asks. If the person asks why there are tests on " +
      `${spec}, this is why. Once the person edits one, the scenarios are theirs.`,
  ].join("\n");
}

/**
 * The chat's two paths to scenarios, in its system prompt while the session has the advisor: asked, it writes them
 * itself; the advisor's landing, it only knows why.
 */
export const TEST_ADVISOR_BLOCK = [
  "<test advisor>",
  "My test advisor checks each new or changed functional spec that has no scenarios, in the background, and when one needs testing - it could fail",
  "silently, be read two ways, or cost a lot when wrong - writes its test reqs, conformance testing script and scenarios itself, as one ***plain",
  "change. So there are two paths to scenarios:",
  "- The person asks you for scenarios (\"write conformance scenarios for core:add-task\"): decide and write them yourself, with change_plain, as a",
  "  ***plain change they see, as the rules say - whatever test-advisor says. Do not run write-test-scenarios for it: that skill is the advisor's.",
  "- The advisor's scenarios land: the person is shown a line saying so, and you are told why. Do nothing about them - never re-do, extend or",
  "  review them unless the person asks.",
  "A change's result names the functional specs the advisor is checking: say turri is checking them, and never offer to write their scenarios",
  "or call them untested. Keep the advisor's scenarios in step with a text you change, in the same change, as any scenarios: they stay its.",
  "Scenarios the advisor wrote are the person's once they edit one on its own, the text unchanged.",
  "</test advisor>",
].join("\n");

/** Each work loop's session's test advisor - the chat's and a host's loops have one. */
const advisorsOfLoops = new WeakMap<WorkLoop, () => TestAdvisor | undefined>();

/** The test advisor of the session a work loop is in. */
export function bindAdvisor(loop: WorkLoop, advisor: () => TestAdvisor | undefined): void {
  advisorsOfLoops.set(loop, advisor);
}

/**
 * What a change's tool result tells the chat's agent of the test advisor: the functional specs it has taken up, so the
 * agent says that rather than offering to write their scenarios itself - nothing when it has taken up none.
 */
export function advisingNote(loop: WorkLoop, plainFile: string): string {
  const taking = advisorsOfLoops.get(loop)?.()?.taking(projectDirOf(resolve(plainFile))) ?? [];
  if (taking.length === 0) return "";
  return [
    `My test advisor is checking ${taking.join(", ")} in the background, to see whether ${taking.length === 1 ? "it needs" : "they need"} explicit testing scenarios,`,
    "and writes them itself when one does. Tell the person that turri is checking it, in a line - and do not offer to write scenarios for",
    "them yourself, or say they are untested: that is the advisor's to decide. Only when the person asks for scenarios, write them.",
  ].join("\n");
}
