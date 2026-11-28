import type { SkillReport, SkillStep } from "@turri-dev/core";
import { c } from "./module-report.ts";

/**
 * A gated skill's run as `turri cultivate` prints it: its steps and their gates as it starts, then each step, artifact,
 * judge and gate decision as the core reports it (`SkillRunOptions.onReport`).
 */

/** A step and its gate, in a line. */
export function gateLine(step: SkillStep): string {
  const gate = step.gate;
  if (gate === undefined) return `${step.name} -> no gate`;
  const live = gate.continuous !== undefined ? ` + continuous(${gate.continuous.rubric}, judges=${gate.continuous.judges})` : "";
  return `${step.name} -> gate(${gate.rubric}, judges=${gate.judges}, quorum=${gate.quorum}, on_fail=${gate.onFail}, max_retries=${gate.maxRetries})${live}`;
}

/** What a skill run reports, printed as it is made. */
export function printReport(report: SkillReport): void {
  switch (report.kind) {
    case "start":
      console.log(c.bold(`skill: ${report.skill}`));
      for (const step of report.steps) console.log(`  ${c.dim(gateLine(step))}`);
      return;
    case "step":
      return console.log(`\n${c.bold(c.accent(`> step ${report.step}`))} ${c.dim(`attempt ${report.attempt}`)}`);
    case "artifact":
      console.log(c.dim(`  ${report.path}:`));
      for (const line of report.body.split("\n")) console.log(c.dim(`  | ${line}`));
      return;
    case "livePass":
      return console.log(report.findings === 0 ? c.dim(`  review ${report.step}: ${report.scope} - clean`) : `  ${c.warning(`review ${report.step}`)}: ${report.scope} ${c.dim(`- ${report.findings} to fix`)}`);
    case "liveReview":
      return console.log(
        report.findings === 0
          ? `${c.bold(c.warning(`> gate ${report.step}`))} ${c.dim(`reviewer read along in ${report.passes} passes, nothing outstanding`)}`
          : `${c.bold(c.warning(`> gate ${report.step}`))} ${c.dim(`${report.findings} unresolved from the reviewer - failing without spending judges`)}`,
      );
    case "gate":
      return console.log(
        report.judges === 0
          ? `${c.bold(c.warning(`> gate ${report.step}`))} ${c.dim("no artifact - failing without spending judges")}`
          : `${c.bold(c.warning(`> gate ${report.step}`))} ${c.dim(`${report.judges} independent judges`)}`,
      );
    case "judge": {
      const mark = report.verdict === "pass" ? c.success("pass") : c.error(report.verdict);
      return console.log(`  judge ${report.judge + 1} ${c.dim(`(${report.model})`)}: ${mark}${report.violations ? c.dim(` (${report.violations})`) : ""}`);
    }
    case "outcome": {
      const colour = { advance: c.success, retry: c.warning, escalate: c.warning, abort: c.error }[report.decision];
      console.log(`  ${c.bold(colour(report.decision))} ${c.dim(`<- gate ${report.step}`)}`);
      if (report.critique) for (const line of report.critique.split("\n")) console.log(c.dim(`    ${line}`));
      return;
    }
  }
}
