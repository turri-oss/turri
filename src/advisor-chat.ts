import { relative, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import type { ChatLink } from "./chats.ts";
import type { AdvisorQuestion } from "./regenerate/advisor-records.ts";
import type { AdvisorVerdict, TestAdvisor } from "./regenerate/advisor-runs.ts";
import type { WorkLoop } from "./regenerate/loop.ts";
import { projectDirOf } from "./regenerate/paths.ts";

/**
 * The test advisor in the chat (docs/test-advisor.md). The advisor decides; the chat is the only writer of the ***plain.
 * A finished verdict reaches the chat the person looks at once it is idle - never interrupting it: a yes is a message
 * that starts a turn, in which the chat tells the person and writes the scenarios with change_plain, asking nothing; a
 * no is one line drawn by turri, starting no turn. What else the chat is told of the advisor - in its system prompt, in a
 * change's result - is here too.
 */

/** Why, in a few words, by the first question of a yes. */
const WHY: Partial<Record<AdvisorQuestion, string>> = {
  "silent-failure": "a wrong implementation could look right",
  divergence: "it can be read two ways",
  cost: "a bug in it would be costly",
};

const specOf = (verdict: AdvisorVerdict) => `${verdict.module}:${verdict.funcId}`;

/** The line a no is drawn as: the functional spec, and the classifier's reading in a few words - a no has no evidence. */
export function noLine(verdict: AdvisorVerdict): string {
  const only = verdict.report.questions.map((answered) => answered.question);
  const reading = only.length > 0 && only.every((question) => question === "revisited") ? "its unit tests cover it as it is built on" : "nothing silent to get wrong";
  return `${specOf(verdict)} doesn't need testing scenarios - ${reading}.`;
}

/** The line the chat is to tell the person a yes in. */
export function yesLine(verdict: AdvisorVerdict): string {
  const why = verdict.report.questions.map((answered) => WHY[answered.question]).find((reason) => reason !== undefined);
  return `${specOf(verdict)} needs testing scenarios${why !== undefined ? ` - ${why}` : ""}. Writing them now.`;
}

/** A yes's report, as the chat's agent is given it: the questions that were a yes with their evidence, and the inputs. */
export function describeReport(verdict: AdvisorVerdict): string[] {
  return [
    "Why it needs testing:",
    ...verdict.report.questions.map((answered) => `- ${answered.question}: ${answered.evidence}`),
    "Inputs to cover:",
    ...(verdict.report.inputs.length === 0
      ? ["- none picked: cover its expected use, as the rules on test plain files say"]
      : verdict.report.inputs.map((input, index) =>
          "agreed" in input
            ? `${index + 1}. input: ${input.input} - agreed output: ${input.agreed}`
            : `${index + 1}. input: ${input.input} - split: ${input.readings.map((reading, at) => `(${at + 1}) ${reading}`).join("; ")}`,
        )),
  ];
}

/** The turn a batch of yeses starts: each one's report, and what the chat is to do with them - asking the person nothing. */
export function yesTask(verdicts: AdvisorVerdict[]): string {
  const where = (path: string, project: string) => relative(project, path) || path;
  return [
    `My test advisor judged that ${verdicts.length === 1 ? "this functional spec needs" : "these functional specs need"} explicit testing scenarios. You write them now.`,
    "",
    ...verdicts.flatMap((verdict) => [
      `<functional_spec name="${specOf(verdict)}" plain_file="${where(verdict.plainFile, verdict.project)}" tested_in="${where(verdict.tip, verdict.project)}" test_plain_file="${verdict.testFile}">`,
      ...describeReport(verdict),
      "</functional_spec>",
      "",
    ]),
    "What to do, in this turn, asking the person nothing:",
    `1. Tell the person in a line for each, e.g. "${yesLine(verdicts[0]!)}"`,
    "2. With change_plain, write whatever the step-7 guard would refuse, in this order, only what is missing: the ***test reqs*** of the module",
    "   it is tested in - the stack's conformance template, stdlib/<kind>/conformance/<stack>, imported, or the module's own - then the",
    "   conformance testing script for its stack, with implement-conformance-testing-script, then the scenarios in its test plain file.",
    "3. Cover each input of the report that is this functional spec's: an agreed one with the readers' output, never a placeholder such as",
    "   <name> where a value belongs; a split one settled by the reading most consistent with the functional spec and its module - say which",
    "   reading you took. Leave out an input that exercises another functional spec, or nothing this one says.",
    "4. Ask the person nothing: the change is visible, and turri tests the scenarios once the code is built.",
  ].join("\n");
}

/** The line a no is drawn as, in the transcript and in no model's context. */
const ADVISOR_ENTRY = "turri_advisor";

/** How long a verdict waits before the chat is looked at again, while the person types or it cannot be told yet. */
export const ADVISOR_RECHECK_MS = 2000;

/**
 * A chat's verdicts: held until the chat is idle - its agent done, and nothing typed in its editor - then delivered
 * together: one turn for every yes, one line for each no. A verdict no longer about its functional spec as it is - its
 * text changed, or it was given scenarios meanwhile - is let go.
 */
export function verdictDelivery(pi: ExtensionAPI, link: ChatLink, context: () => ExtensionContext | undefined): { put(verdict: AdvisorVerdict): void } {
  const waiting: AdvisorVerdict[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;

  pi.registerEntryRenderer(ADVISOR_ENTRY, (entry, _options, theme) => {
    const data = entry.data as { text: string } | undefined;
    if (data === undefined) return undefined;
    const box = new Box(1, 0);
    box.addChild(new Text(theme.fg("muted", data.text), 0, 0));
    return box;
  });

  /** Whether the chat is busy: its agent working, or the person typing - or no session to tell yet. */
  const busy = (): boolean => {
    const session = link.session();
    if (session === undefined || session.isStreaming || session.isCompacting || session.isRetrying) return true;
    const ctx = context();
    try {
      if (ctx !== undefined && (!ctx.isIdle() || ctx.hasPendingMessages())) return true;
      if (ctx?.hasUI === true && ctx.ui.getEditorText().trim() !== "") return true;
    } catch {
      /* a context let go: the session says enough */
    }
    return false;
  };

  const later = (ms: number) => {
    if (timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      deliver();
    }, ms);
    timer.unref?.();
  };

  const deliver = () => {
    if (waiting.length === 0) return;
    if (busy()) {
      // Its agent ending says so (agent_settled); the person's typing does not, so it is looked at again.
      later(ADVISOR_RECHECK_MS);
      return;
    }
    const now = waiting.splice(0).filter((verdict) => {
      try {
        return verdict.current();
      } catch {
        return false;
      }
    });
    const yes = now.filter((verdict) => verdict.report.verdict === "yes");
    try {
      for (const verdict of now.filter((verdict) => verdict.report.verdict === "no")) pi.appendEntry(ADVISOR_ENTRY, { text: noLine(verdict) });
      if (yes.length > 0) {
        // A follow-up, never a steer: should a turn start in between, this waits for it to end.
        void pi.sendMessage(
          { customType: "turri_advisor_verdict", content: yesTask(yes), display: false, details: { specs: yes.map(specOf) } },
          { triggerTurn: true, deliverAs: "followUp" },
        );
      }
    } catch {
      // Not bound to its session yet: kept, and tried again.
      waiting.unshift(...now);
      later(ADVISOR_RECHECK_MS);
      return;
    }
    for (const verdict of now) verdict.delivered();
  };

  pi.on("agent_settled", () => deliver());
  pi.on("session_start", () => later(0));

  return {
    put(verdict) {
      // A newer verdict on the same functional spec replaces the one waiting.
      const at = waiting.findIndex((known) => known.project === verdict.project && specOf(known) === specOf(verdict));
      if (at !== -1) waiting.splice(at, 1);
      waiting.push(verdict);
      // The rest of what arrives at once comes with it.
      later(0);
    },
  };
}

/** The test advisor and the chat, in its system prompt while the session has the advisor and the project wants it. */
export const TEST_ADVISOR_BLOCK = [
  "<test advisor>",
  "My test advisor checks each new or changed functional spec that has no scenarios, in the background, for whether it needs explicit testing",
  "scenarios - it could fail silently, be read two ways, or cost a lot when wrong. It writes nothing: you are the only writer of the ***plain.",
  "- A change's result names the functional specs it is checking: tell the person, in a line, that testing scenarios are being evaluated for",
  "  them, and go on - there is nothing to wait for.",
  "- A yes comes to you as a message: tell the person in a line, and write the test reqs, conformance testing script and scenarios it needs",
  "  with change_plain, as it says - asking the person nothing.",
  "- A no is a line turri draws itself: there is nothing for you to do.",
  "When the person asks you for scenarios (\"write conformance scenarios for core:add-task\"), decide and write them yourself, with change_plain,",
  "as a ***plain change they see, as the rules say - whatever test-advisor says.",
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
 * agent tells the person they are being evaluated - nothing when it has taken up none.
 */
export function advisingNote(loop: WorkLoop, plainFile: string): string {
  const taking = advisorsOfLoops.get(loop)?.()?.taking(projectDirOf(resolve(plainFile))) ?? [];
  if (taking.length === 0) return "";
  return [
    `My test advisor is evaluating ${taking.join(", ")} in the background, to see whether ${taking.length === 1 ? "it needs" : "they need"} explicit testing scenarios.`,
    "Tell the person, in a line, that testing scenarios are being evaluated for them, and go on - there is nothing to wait for: the verdict",
    "comes back to this chat.",
  ].join("\n");
}
