import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSkill, readRubric, skillStatus } from "../../src/skill.ts";

let dir: string;

function skill(body: string, frontmatter = "") {
  const path = join(dir, "demo");
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "SKILL.md"), `---\nname: demo\ndescription: A skill.\n${frontmatter}---\n\n${body}`);
  return loadSkill(path);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "turri-steps-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("a skill without a Steps section", () => {
  it("is one step, named after the skill", () => {
    const s = skill("# Demo\n\nDo the thing carefully.\n");
    expect(s.steps.map((x) => x.name)).toEqual(["demo"]);
  });

  it("carries the whole body as its instructions", () => {
    const s = skill("# Demo\n\nDo the thing carefully.\n");
    expect(s.steps[0]!.instructions).toContain("Do the thing carefully.");
  });

  it("does not split on headings in its prose", () => {
    // The trap this replaced: a prose skill's explanatory subsections are not steps.
    const s = skill("# Demo\n\n## Workflow\n\n### 1. Read the file\n\ntext\n\n### 2. Edit it\n\ntext\n");
    expect(s.steps).toHaveLength(1);
    expect(s.steps[0]!.instructions).toContain("### 1. Read the file");
  });
});

describe("a skill with a Steps section", () => {
  const body = `# Demo

## Notes

### Not a step

prose

## Steps

### first

Do the first thing.

### second

Do the second thing.
`;

  it("takes its steps from that section only", () => {
    expect(skill(body).steps.map((x) => x.name)).toEqual(["first", "second"]);
  });

  it("keeps each step's own instructions", () => {
    expect(skill(body).steps[1]!.instructions).toBe("Do the second thing.");
  });
});

describe("gates", () => {
  it("attach to the named step", () => {
    const s = skill("## Steps\n\n### first\n\nDo it.\n", "metadata:\n  gates:\n    - after: first\n      review:\n        rubric: ./r.md\n");
    expect(s.steps[0]!.gate?.review.rubric).toBe("./r.md");
  });

  it("can gate the implicit single step by naming the skill", () => {
    const s = skill("Do it.\n", "metadata:\n  gates:\n    - after: demo\n      review:\n        rubric: ./r.md\n");
    expect(s.steps[0]!.gate).toBeDefined();
  });

  it("are rejected when they name a step that does not exist", () => {
    expect(() =>
      skill("Do it.\n", "metadata:\n  gates:\n    - after: nope\n      review:\n        rubric: ./r.md\n"),
    ).toThrow(/gate references unknown step 'nope'/);
  });
});

describe("what each step does", () => {
  it("comes from metadata.phases, a line a step by its name", () => {
    const s = skill("## Steps\n\n### first\n\nDo it.\n\n### second\n\nThen this.\n", "metadata:\n  phases:\n    first: \"reads the spec\"\n");
    expect(s.steps.map((step) => step.about)).toEqual(["reads the spec", undefined]);
  });

  it("is rejected when it describes a step that does not exist", () => {
    expect(() => skill("## Steps\n\n### first\n\nDo it.\n", "metadata:\n  phases:\n    nope: \"does nothing\"\n")).toThrow(
      /'metadata.phases' describes unknown step 'nope'/,
    );
  });

  it("is said for every phase of every skill that has phases", () => {
    for (const name of readdirSync(join(process.cwd(), "genome", "skills"))) {
      const loaded = loadSkill(join(process.cwd(), "genome", "skills", name));
      if (loaded.steps.length < 2) continue;
      for (const step of loaded.steps) expect(step.about, `${name}: ${step.name}`).toBeTruthy();
    }
  });
});

describe("an empty skill", () => {
  it("is rejected", () => {
    expect(() => skill("\n")).toThrow(/body is empty/);
  });
});

describe("continuous review", () => {
  it("is off unless the gate asks for it", () => {
    const skill = loadSkill("genome/skills/analyze-func-specs");
    expect(skill.steps.every((s) => s.gate?.continuous === undefined)).toBe(true);
  });

  it("is parsed alongside the phase gate", () => {
    const s = skill(
      "## Steps\n\n### product\n\nDo it.\n",
      "metadata:\n  gates:\n    - after: product\n      continuous:\n        rubric: ./live.md\n        judges: 1\n        judge_tools: [read, ls, grep, find]\n      review:\n        rubric: ./r.md\n        judges: 2\n",
    );
    const step = s.steps.find((x) => x.name === "product")!;
    expect(step.gate?.continuous).toEqual({
      rubric: "./live.md",
      judges: 1,
      model: undefined,
      judgeTools: ["read", "ls", "grep", "find"],
    });
    // The end-of-phase gate is untouched by it.
    expect(step.gate?.review.judges).toBe(2);
  });
});

describe("an interview's frontmatter", () => {
  const steps = "## Steps\n\n### intent\n\nAsk.\n\n### stack\n\nAsk.\n\n### product\n\nAsk.\n";

  it("names the phases the questioning level caps and those where every answer is a spec change", () => {
    const s = skill(steps, "metadata:\n  questioning: [stack, product]\n  change-plain-per-answer: [product]\n");
    expect(s.questioning).toEqual(["stack", "product"]);
    expect(s.diffPerAnswer).toEqual(["product"]);
    expect(skill(steps).questioning).toEqual([]);
  });

  it("is paced and left to the model unless it says otherwise", () => {
    expect(skill(steps).paced).toBe(true);
    expect(skill(steps).commandOnly).toBe(false);
    const own = skill(steps, "metadata:\n  paced: false\n  command-only: true\n");
    expect(own.paced).toBe(false);
    expect(own.commandOnly).toBe(true);
  });

  it("is rejected when its questioning level names a step it does not have", () => {
    expect(() => skill(steps, "metadata:\n  questioning: [testing]\n")).toThrow(/'metadata.questioning' names unknown step 'testing'/);
  });
});

describe("a skill's tools", () => {
  it("are the ones its frontmatter names, and none when it names none", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    expect(loadSkill("genome/skills/debug-specs").allowedTools).toEqual(["read", "write", "edit", "bash", "ls", "grep", "find"]);
    const dir = mkdtempSync(join(tmpdir(), "turri-skill-"));
    writeFileSync(join(dir, "SKILL.md"), "---\nname: none\ndescription: nothing\n---\n\nDo nothing.\n");
    expect(loadSkill(dir).allowedTools).toEqual([]);
  });

  it("every skill here names its tools - the ones that only read and report can only read, and one that writes only through change_plain has no file tools to write with", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    for (const name of readdirSync("genome/skills")) {
      expect(readFileSync(`genome/skills/${name}/SKILL.md`, "utf8"), name).toMatch(/^allowed-tools: \[/m);
      const tools = loadSkill(`genome/skills/${name}`).allowedTools;
      expect(tools, name).toContain("read");
      if (name.startsWith("analyze-")) expect(tools, name).not.toContain("write");
      else if (tools.includes("change_plain")) for (const tool of ["write", "edit"]) expect(tools, name).not.toContain(tool);
      else expect(tools, name).toEqual(expect.arrayContaining(["write", "edit"]));
    }
  });

  it("convert-old-syntax rewrites a module through change_plain alone, its rewrite judged before it is kept", () => {
    const skill = loadSkill("genome/skills/convert-old-syntax");
    expect(skill.allowedTools).toEqual(["read", "ls", "grep", "find", "change_plain", "parse"]);
    expect(skill.steps.map((step) => step.name)).toEqual(["ids", "rewrite", "check"]);
    const gate = skill.steps.find((step) => step.name === "rewrite")!.gate!;
    expect(gate.review.judgeTools).toEqual(["read", "ls", "grep", "find"]);
    expect(readRubric(skill, gate.review)).toContain("word for word");
    expect(skill.paced).toBe(true);
    expect(skill.questioning).toEqual([]);
  });
});

describe("the status line while a skill runs", () => {
  const skill = {
    name: "probe",
    steps: ["intent", "stack", "product"].map((name) => ({
      name,
      instructions: "",
    })),
  } as unknown as Parameters<typeof skillStatus>[0];

  it("names the phase and where it sits among them", () => {
    expect(skillStatus(skill, "stack", 1)).toBe("probe: stack (phase 2 of 3)");
  });

  it("says when a phase is being retried after its gate", () => {
    expect(skillStatus(skill, "product", 2)).toBe("probe: product (phase 3 of 3), attempt 2");
  });
});
