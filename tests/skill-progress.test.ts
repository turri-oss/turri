import { visibleWidth } from "@earendil-works/pi-tui";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it, onTestFinished } from "vitest";
import { skillAboutLine, skillProgressLine, type SkillProgress } from "../src/skill-progress.ts";
import { loadSkill } from "../src/skill.ts";
import { join } from "node:path";

const probe = (current: number, attempt = 1): SkillProgress => ({
  skill: "probe",
  phases: ["intent", "stack", "testing", "product"],
  current,
  attempt,
  frame: "⠋",
});

describe("a skill's progress, above the input", () => {
  it("names every phase in order - done ticked, the one it is in marked, the rest to come - and says where it is", () => {
    expect(skillProgressLine(probe(1), 70)).toMatch(/^probe {3,}✓ intent ━+ ⠋ stack ─+ ○ testing ─+ ○ product {3,}phase 2 of 4$/);
    expect(skillProgressLine(probe(-1), 90)).toMatch(/^probe {3,}○ intent ─+ ○ stack ─+ ○ testing ─+ ○ product {3,}starting$/);
    expect(skillProgressLine(probe(3, 2), 120)).toMatch(/✓ testing ━+ ⠋ product {3,}phase 4 of 4, attempt 2$/);
  });

  it("puts the skill at the left edge and where it is at the right, its phases centred between them across 60% of the width", () => {
    for (const width of [100, 120, 161]) {
      const line = skillProgressLine(probe(1), width);
      expect(visibleWidth(line), `${width}`).toBe(width);
      expect(line).toMatch(/^probe .*phase 2 of 4$/);
      const bar = line.slice(line.indexOf("✓"), line.indexOf("○ product") + "○ product".length);
      expect(visibleWidth(bar), `${width}`).toBe(Math.floor(width * 0.6));
      expect(line.indexOf("✓"), `${width}`).toBe(Math.floor((width - visibleWidth(bar)) / 2));
    }
    // Where its share would run into either end, the phases take less, still clear of both and centred.
    const line = skillProgressLine(probe(1), 70);
    expect(visibleWidth(line)).toBe(70);
    expect(line.indexOf("✓")).toBeGreaterThanOrEqual("probe".length + 3);
  });

  it("keeps the phases when the line is narrow, and leaves out where it is first", () => {
    expect(skillProgressLine(probe(1), 55)).toBe("probe  ✓ intent ━━ ⠋ stack ── ○ testing ── ○ product");
    expect(visibleWidth(skillProgressLine(probe(1), 30))).toBeLessThanOrEqual(30);
  });

  it("says under it what the phase it is in does, centred under the phases - nothing before the first starts", () => {
    const about = "the language, frameworks, storage and architecture";
    const line = skillAboutLine({ ...probe(1), about }, 120)!;
    expect(line.trim()).toBe(`stack - ${about}`);
    expect(visibleWidth(line) - visibleWidth(line.trimStart())).toBe(Math.floor((120 - visibleWidth(line.trim())) / 2));
    expect(skillAboutLine({ ...probe(-1), about }, 120)).toBeUndefined();
    expect(skillAboutLine(probe(1), 120)).toBeUndefined();
    // Too long for the width, it is cut short, and on a narrow screen starts at the left.
    const narrow = skillAboutLine({ ...probe(1), about }, 40)!;
    expect(visibleWidth(narrow)).toBeLessThanOrEqual(40);
    expect(narrow.startsWith("stack - ")).toBe(true);
    expect(narrow).toContain("…");
  });

  it("shows a skill of one phase, or none, as the spinner and its name alone - no phases, no where it is, nothing under it", () => {
    const single = (phases: string[], attempt = 1): SkillProgress => ({ skill: "analyze-func-specs", phases, current: phases.length - 1, attempt, frame: "⠹", about: "write it" });
    expect(skillProgressLine(single(["analyze-func-specs"]), 120)).toBe("⠹ analyze-func-specs");
    expect(skillProgressLine(single([]), 120)).toBe("⠹ analyze-func-specs");
    expect(skillProgressLine(single(["analyze-func-specs"], 2), 120)).toBe("⠹ analyze-func-specs   attempt 2");
    expect(skillAboutLine(single(["analyze-func-specs"]), 120)).toBeUndefined();
  });

  it("reads its phases from the skill itself - its steps, in order", () => {
    const dir = mkdtempSync(join(tmpdir(), "turri-phases-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, "SKILL.md"), "---\nname: probe\ndescription: A skill.\nmetadata:\n  phases:\n    intent: asks\n    stack: chooses\n    product: writes\n---\n\n## Steps\n\n### intent\n\nAsk.\n\n### stack\n\nChoose.\n\n### product\n\nWrite.\n");
    expect(loadSkill(dir).steps.map((step) => step.name)).toEqual(["intent", "stack", "product"]);
  });
});
