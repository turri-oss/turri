import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describeEvents, describePastPulse, describeRuns, ledgerProjects, runViews, sinceOf } from "./regenerate/ledger-view.ts";

type AnyTool = ToolDefinition<any, any, any>;

/** How many runs `ledger` lists when it is asked for none. */
const RUNS_SHOWN = 3;

/**
 * ledger: what turri did, as the ledger recorded it - in this session and every one before it. One pulse, by its id,
 * as facts; the last runs, a line a pulse; or the events of some kinds, counted and listed. Reads only.
 */
export function ledgerTool(options: { cwd: string }): AnyTool {
  return defineTool({
    name: "ledger",
    label: "Ledger",
    description:
      "What turri did here, as its ledger recorded it - facts, not transcripts - in this session and every earlier one. " +
      "With pulse: that pulse, this session's or an earlier one's - how it ended, its rounds and test runs (how many failed " +
      "the same way), the judge's and the reviews' verdicts, the healers (the debugger, the diagnosis) and whether they " +
      "failed, the model provider's trouble, what turri refused and stopped, what it committed or rolled back, its last " +
      "stages and its log. With kinds (and module, since): how many events of those kinds there were, and the most recent, " +
      "a line each - healer.failed, provider.error, script.run, gate.round, judge.verdict, guard.refused, history.failed, " +
      "job.finished, ...; a group by its first part, healer for every healer event. Otherwise: the last runs, a line a pulse - " +
      "how each ended, how long, what it cost. Starts nothing and calls no model.",
    promptSnippet: "ledger: what turri did - a pulse as facts, the last runs, or events counted by kind - this session and earlier ones",
    promptGuidelines: [
      "Use ledger for what turri recorded of the work - a pulse's rounds, test runs, verdicts, healers and commits, this session's or an earlier one's; how often something happened; what earlier runs did and cost - rather than reading .turri/ledger with the shell. pulses is what is running and planned now; a pulse's whole transcript is its log, which ledger names.",
    ],
    parameters: Type.Object({
      pulse: Type.Optional(Type.String({ description: "A pulse's id, or the start of it: that pulse, as the ledger has it" })),
      kinds: Type.Optional(Type.Array(Type.String(), { description: "Event kinds to count and list - healer.failed, or healer for the whole group" })),
      module: Type.Optional(Type.String({ description: "With kinds: only the events of this module" })),
      since: Type.Optional(Type.String({ description: "With kinds: only events since then - 24h, 7d, 30m, or a date and time" })),
      runs: Type.Optional(Type.Number({ description: `Without pulse or kinds: how many of the last runs to list (default ${RUNS_SHOWN})` })),
      limit: Type.Optional(Type.Number({ description: "With kinds: how many of the most recent events to list (default 20)" })),
    }),
    async execute(_id, params) {
      const text = (body: string, details: Record<string, unknown> = {}) => ({ content: [{ type: "text" as const, text: body }], details });
      const projects = ledgerProjects(options.cwd);
      if (projects.length === 0) return text("The ledger is empty here: nothing has run in this folder, or in a project under it, since it began.", { found: false });
      if (params.pulse !== undefined) {
        const described = describePastPulse(projects, params.pulse.trim());
        return described !== undefined ? text(described, { found: true }) : text(`The ledger has no pulse ${params.pulse}.`, { found: false });
      }
      if (params.kinds !== undefined && params.kinds.length > 0) {
        let since: Date | undefined;
        if (params.since !== undefined) {
          since = sinceOf(params.since);
          if (since === undefined) return text(`since takes 24h, 7d, 30m or a date and time, not ${JSON.stringify(params.since)}.`, { found: false });
        }
        return text(
          describeEvents(projects, {
            kinds: params.kinds,
            ...(params.module !== undefined ? { module: params.module } : {}),
            ...(since !== undefined ? { since } : {}),
            ...(params.limit !== undefined ? { limit: params.limit } : {}),
          }),
          { found: true },
        );
      }
      const count = params.runs !== undefined && Number.isFinite(params.runs) ? Math.max(1, Math.floor(params.runs)) : RUNS_SHOWN;
      const runs = projects.flatMap((project) => runViews(project)).sort((a, b) => (b.started?.ts ?? "").localeCompare(a.started?.ts ?? ""));
      const shown = runs.slice(0, count);
      const more = runs.length - shown.length;
      return text(`${describeRuns(shown)}${more > 0 ? `\n\n${more} earlier run${more === 1 ? "" : "s"} beyond these: ask with runs for more.` : ""}`, { found: true, runs: shown.length });
    },
  });
}
