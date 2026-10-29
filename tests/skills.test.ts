import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureInScratch } from "../src/regenerate/paths.ts";
import { catalogueLine, chosenCommand, createCommandGate, startPicked, discoverSkills, leftOutNote, startedByCommandOnly } from "../src/skills.ts";

let root: string;
let harness: string;
let project: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "turri-skills-"));
  harness = join(root, "turri");
  project = join(root, "project");
  mkdirSync(project);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function skill(dir: string, name: string, description = `${name}, described.`, body = "# Do it\n\nDo the thing.\n") {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\nallowed-tools: [read]\n---\n\n${body}`);
}

describe("the skills turri can run", () => {
  it("are its own, then the project's from .turri/skills and .agents/skills, each said whose it is", () => {
    skill(join(harness, "genome", "skills", "onboard"), "onboard");
    skill(join(project, ".turri", "skills", "release-notes"), "release-notes");
    skill(join(project, ".agents", "skills", "changelog"), "changelog");

    const found = discoverSkills(harness, project);
    expect(found.skills.map((s) => s.name)).toEqual(["onboard", "release-notes", "changelog"]);
    expect(found.skills.map((s) => s.origin)).toEqual(["turri", { project: join(".turri", "skills", "release-notes") }, { project: join(".agents", "skills", "changelog") }]);
    expect(found.skills[2]!.dir).toBe(join(project, ".agents", "skills", "changelog"));
    expect(found.skills.map(catalogueLine)).toEqual([
      "- onboard: onboard, described.",
      `- release-notes (this project's, ${join(".turri", "skills", "release-notes")}): release-notes, described.`,
      `- changelog (this project's, ${join(".agents", "skills", "changelog")}): changelog, described.`,
    ]);
  });

  it("are run in the gated format: a project's skill keeps its steps and its gates", () => {
    const dir = join(project, ".turri", "skills", "intake");
    skill(
      dir,
      "intake",
      "Asks, then writes.",
      "# Intake\n\n## Steps\n\n### ask\n\nAsk.\n\n### write\n\nWrite.\n",
    );
    const raw = readFileSync(join(dir, "SKILL.md"), "utf8").replace("allowed-tools: [read]\n", "allowed-tools: [read]\nmetadata:\n  gates:\n    - after: write\n      review:\n        rubric: ./rubric.md\n");
    writeFileSync(join(dir, "SKILL.md"), raw);

    const [intake] = discoverSkills(harness, project).skills;
    expect(intake!.steps.map((step) => step.name)).toEqual(["ask", "write"]);
    expect(intake!.steps[1]!.gate?.review.rubric).toBe("./rubric.md");
  });

  it("leave out a project's skill whose name is taken - turri's own first, then .turri/skills - and say so", () => {
    skill(join(harness, "genome", "skills", "onboard"), "onboard");
    skill(join(project, ".turri", "skills", "onboard"), "onboard", "An onboard of our own.");
    skill(join(project, ".turri", "skills", "notes"), "notes");
    skill(join(project, ".agents", "skills", "notes"), "notes", "Other notes.");

    const found = discoverSkills(harness, project);
    expect(found.skills.map((s) => `${s.name}: ${s.description}`)).toEqual(["onboard: onboard, described.", "notes: notes, described."]);
    expect(found.shadowed).toEqual([
      `${join(".turri", "skills", "onboard")} (onboard is turri's own)`,
      `${join(".agents", "skills", "notes")} (notes is ${join(".turri", "skills", "notes")})`,
    ]);
    expect(leftOutNote(found)).toContain("Left out, their names taken:");
  });

  it("report a project's skill that does not parse by its folder, and keep the rest", () => {
    mkdirSync(join(project, ".agents", "skills", "broken"), { recursive: true });
    writeFileSync(join(project, ".agents", "skills", "broken", "SKILL.md"), "---\nname: broken\n---\n\nNo description.\n");
    skill(join(project, ".agents", "skills", "fine"), "fine");

    const found = discoverSkills(harness, project);
    expect(found.skills.map((s) => s.name)).toEqual(["fine"]);
    expect(found.pending).toEqual([join(".agents", "skills", "broken")]);
    expect(leftOutNote(found)).toBe(`\n\nFailed to load and therefore not runnable: ${join(".agents", "skills", "broken")}.`);
  });

  it("are turri's own alone when there is no project, or it has no skill folders", () => {
    skill(join(harness, "genome", "skills", "onboard"), "onboard");
    expect(discoverSkills(harness, undefined).skills.map((s) => s.name)).toEqual(["onboard"]);
    expect(discoverSkills(harness, project).skills.map((s) => s.name)).toEqual(["onboard"]);
  });
});

describe("the scratch folder", () => {
  it("ignores everything in it but the project's skills", () => {
    execFileSync("git", ["init", "-q"], { cwd: project });
    const scratch = join(project, ".turri");
    ensureInScratch(scratch, join(scratch, "runs", "onboard"));
    writeFileSync(join(scratch, "runs", "onboard", "run.json"), "{}");
    skill(join(scratch, "skills", "notes"), "notes");
    mkdirSync(join(scratch, "skills", "notes", "references"));
    writeFileSync(join(scratch, "skills", "notes", "references", "rubric.md"), "rubric");

    const status = execFileSync("git", ["status", "--porcelain", "-uall"], { cwd: project, encoding: "utf8" });
    expect(status.split("\n").filter((line) => line !== "").sort()).toEqual([
      "?? .turri/skills/notes/SKILL.md",
      "?? .turri/skills/notes/references/rubric.md",
    ]);
  });

  it("brings up to date a .gitignore written before skills were kept in it, and leaves one of the person's own", () => {
    const scratch = join(project, ".turri");
    mkdirSync(scratch);
    writeFileSync(join(scratch, ".gitignore"), "*\n");
    ensureInScratch(scratch, join(scratch, "runs"));
    expect(readFileSync(join(scratch, ".gitignore"), "utf8")).toBe("*\n!skills/\n!skills/**\n");

    writeFileSync(join(scratch, ".gitignore"), "*\n!notes.md\n");
    ensureInScratch(scratch, join(scratch, "runs"));
    expect(readFileSync(join(scratch, ".gitignore"), "utf8")).toBe("*\n!notes.md\n");
  });
});

describe("the skills the person starts themselves", () => {
  it("are a project's marked command-only - none of turri's own - each marked in cultivate's list with its command", () => {
    const own = join(project, ".turri", "skills", "kickoff");
    mkdirSync(own, { recursive: true });
    writeFileSync(join(own, "SKILL.md"), "---\nname: kickoff\ndescription: kickoff, described.\nallowed-tools: [read]\nmetadata:\n  command-only: true\n---\n\nDo it.\n");
    const { skills } = discoverSkills(process.cwd(), project);
    expect(skills.filter((skill) => skill.commandOnly).map((skill) => skill.name)).toEqual(["kickoff"]);
    expect(catalogueLine(skills.find((skill) => skill.name === "kickoff")!)).toContain("Started only by the person, with /kickoff");
    expect(catalogueLine(skills.find((skill) => skill.name === "analyze-func-specs")!)).not.toContain("Started only by the person");
  });

  it("start once their command is typed, and not again until it is typed again", () => {
    const gate = createCommandGate();
    const kickoff = { name: "kickoff", commandOnly: true };
    expect(gate.mayStart(kickoff)).toBe(false);
    gate.typed("kickoff");
    expect(gate.mayStart(kickoff)).toBe(true);
    gate.started("kickoff");
    expect(gate.mayStart(kickoff)).toBe(false);
  });

  it("leave every other skill free for the model to start", () => {
    expect(createCommandGate().mayStart({ name: "analyze-func-specs", commandOnly: false })).toBe(true);
  });

  it("are refused with how the person starts them - their command, or an option picked", () => {
    expect(startedByCommandOnly("onboard")).toContain("with /onboard or by picking an option starting /onboard");
  });

  it("start from an option the person picked that starts with their command", () => {
    const skills = [
      { name: "onboard", commandOnly: true },
      { name: "analyze-func-specs", commandOnly: false },
    ];
    expect(chosenCommand("/onboard - an interview: the stack, the testing and every feature", skills)).toBe("onboard");
    expect(chosenCommand("Just do it - no skill: I write it here", skills)).toBeUndefined();
    expect(chosenCommand("/analyze-func-specs", skills)).toBeUndefined();
    expect(chosenCommand("I would rather /onboard later", skills)).toBeUndefined();
  });

  it("are started at once once picked, with what the person asked for word for word", () => {
    const told = startPicked("kickoff", " create a small server in java springboot ");
    expect(told).toContain('call cultivate with skill "kickoff" at once');
    expect(told).toContain('word for word: "create a small server in java springboot"');
    expect(told).toContain("never ask them to type /kickoff");
  });
});

describe("the skills that run in the background", () => {
  it("are turri's two that write a testing script, on the coding model - each marked in cultivate's list - and no other of its own", () => {
    const { skills } = discoverSkills(process.cwd(), project);
    const background = skills.filter((skill) => skill.background);
    expect(background.map((skill) => [skill.name, skill.model])).toEqual([
      ["implement-conformance-testing-script", "coding"],
      ["implement-unit-testing-script", "coding"],
    ]);
    expect(catalogueLine(background[0]!)).toContain("Runs in the background: cultivate returns at once");
    expect(catalogueLine(skills.find((skill) => skill.name === "analyze-func-specs")!)).not.toContain("in the background");
  });

  it("name no model but the coding one", () => {
    const own = join(project, ".turri", "skills", "tidy");
    mkdirSync(own, { recursive: true });
    writeFileSync(join(own, "SKILL.md"), "---\nname: tidy\ndescription: tidy, described.\nallowed-tools: [read]\nmetadata:\n  background: true\n  model: judge\n---\n\nDo it.\n");
    expect(discoverSkills(process.cwd(), project).pending).toEqual([expect.stringContaining("tidy")]);
  });
});
