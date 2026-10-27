import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const asked = vi.hoisted(() => ({ models: [] as string[] }));
vi.mock("../src/model-check.ts", async (original) => ({
  ...(await original<typeof import("../src/model-check.ts")>()),
  piModelAccess: async () => ({}),
  checkModels: async (used: Array<{ spec: string; usedBy: string[] }>) => {
    asked.models.push(...used.map((model) => model.spec));
    return used.map((model) => ({ ...model, ok: true, ms: 100 }));
  },
}));

const { doctorTool } = await import("../src/doctor-tool.ts");

/** The conversation's doctor: turri doctor's checks, as text the model reads. */

describe("the doctor tool", () => {
  let project: string;
  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), "turri-doctor-tool-"));
    asked.models = [];
    writeFileSync(join(project, "config.turri.yaml"), "harness-model: anthropic/claude-test\ncoding-model: anthropic/claude-test\n");
    writeFileSync(join(project, "game.plain"), "***implementation reqs***\n\n- :Implementation: is written in Zig.\n\n***functional specs***\n\n# draw\nDraw.\n");
  });
  afterEach(() => rmSync(project, { recursive: true, force: true }));

  const run = (cwd: string, params: { models?: boolean } = {}) => doctorTool({ cwd }).execute("call", params, undefined, undefined, undefined as never);

  it("checks the machine and the conversation's project, and says what to fix, uncoloured", async () => {
    const result = await run(project);
    const text = result.content[0].text as string;
    expect(text).toMatch(/^✓ Node: /);
    expect(text).toContain("✗ game: its implementation reqs need Zig (zig), which this machine lacks");
    expect(text).toContain("    → install Zig on this machine");
    expect(text).toMatch(/Not ready: \d+ things? to fix \(✗ above\)\.$/);
    expect(text).not.toMatch(/\u001b\[/);
    expect(result.details).toMatchObject({ ready: false });
  });

  it("finds the project from a folder inside it", async () => {
    const inside = join(project, "docs");
    mkdirSync(inside);
    expect((await run(inside)).content[0].text).toContain("✗ game:");
  });

  it("asks the models only when told to", async () => {
    await run(project);
    expect(asked.models).toEqual([]);
    const text = (await run(project, { models: true })).content[0].text as string;
    expect(asked.models).toEqual(["anthropic/claude-test"]);
    expect(text).toContain("✓ harness-model, coding-model: anthropic/claude-test answered");
  });

  it("leaves out what matters only in a terminal", async () => {
    const text = (await run(project)).content[0].text as string;
    expect(text).not.toContain("turri on PATH");
    expect(text).not.toContain("turri in every pi");
  });
});
