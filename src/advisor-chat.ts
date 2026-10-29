import { resolve } from "node:path";
import type { TestAdvisor } from "./regenerate/advisor-runs.ts";
import type { WorkLoop } from "./regenerate/loop.ts";
import { projectDirOf } from "./regenerate/paths.ts";

/**
 * What the chat is told of the test advisor (docs/test-advisor.md): in its system prompt, that the advisor checks new
 * and changed functional specs and that the chat alone writes scenarios; in a change's result, which functional specs it
 * is checking now.
 */

/** The test advisor and the chat, in its system prompt while the session has the advisor and the project wants it. */
export const TEST_ADVISOR_BLOCK = [
  "<test advisor>",
  "My test advisor checks each new or changed functional spec that has no scenarios, in the background, for whether it needs explicit testing",
  "scenarios - it could fail silently, be read two ways, or cost a lot when wrong. It writes nothing: you are the only writer of the ***plain.",
  "When the person asks you for scenarios (\"write conformance scenarios for core:add-task\"), decide and write them yourself, with change_plain,",
  "as a ***plain change they see, as the rules say - whatever test-advisor says.",
  "A change's result names the functional specs the advisor is checking: say testing scenarios are being evaluated for them, in a line, and go on.",
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
    "Tell the person, in a line, that testing scenarios are being evaluated for them, and go on - there is nothing to wait for.",
  ].join("\n");
}
