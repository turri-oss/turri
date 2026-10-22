import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeTestScripts } from "../test-scripts.ts";

/**
 * The coding agent is stubbed: its first turn ends having written nothing - a turn spent planning - and it writes
 * only when asked for a draft, or never when `silent`. The testing scripts run on this machine.
 */
type StubSession = { tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> };
const prompts: string[] = [];
let silent = false;
/** What a prompt asking it to write must say for the stub to write. */
let writesOn = "";

vi.mock("../../src/pi.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/pi.ts")>();
  return {
    ...actual,
    createExecutor: async (opts: { customTools: StubSession["tools"] }) => ({ tools: opts.customTools, dispose() {} }),
    ask: vi.fn(async (session: StubSession, prompt: string) => {
      const review = session.tools.find((candidate) => candidate.name === "submit_review");
      if (review !== undefined) return (await review.execute("id", { pass: true, problems: [] }), "Reviewed.");
      prompts.push(prompt);
      if (!silent && prompt.startsWith("You have not written anything yet") && prompt.includes(writesOn)) {
        await session.tools.find((candidate) => candidate.name === "write")!.execute("id", {
          path: "test_app.py",
          content: "import unittest\n\nclass AppTest(unittest.TestCase):\n    def test_ok(self):\n        self.assertEqual(1 + 1, 2)\n",
        });
      }
      return "I have thought it through.";
    }),
  };
});

const { renderSpecDiff } = await import("../../src/regenerate/regenerate.ts");
const { AGAIN_ASKS, DRAFT_ASKS } = await import("../../src/regenerate/testing.ts");

let dir: string;
let cwd: string;
const plain = (fs: string[]) => `***implementation reqs***\n\n- Python.\n\n***functional specs***\n\n${fs.join("\n\n")}\n`;
const drafts = () => prompts.filter((prompt) => prompt.startsWith("You have not written anything yet"));

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "turri-draft-")));
  writeTestScripts(dir);
  writeFileSync(join(dir, "config.yaml"), "testing-scripts-run-on: in-place\n");
  cwd = process.cwd();
  process.chdir(dir);
  prompts.length = 0;
  silent = false;
  writesOn = "";
});
afterEach(() => {
  process.chdir(cwd);
  rmSync(dir, { recursive: true, force: true });
});

describe("a coding agent that has written nothing", () => {
  it("is asked for a best-guess draft before its tests run - and what it drafts goes on to be tested and reviewed", async () => {
    writeFileSync(join(dir, "app.plain"), plain(["- One."]));
    const diff = ["diff --git a/app.plain b/app.plain", "--- a/app.plain", "+++ b/app.plain", "@@ -6 +6,3 @@", " - One.", "+", "+- Two.", ""].join("\n");
    const result = await renderSpecDiff({ plainFile: "app.plain", diff, cwd: dir });
    expect(drafts()).toHaveLength(1);
    expect(drafts()[0]).toContain("stop planning and write it now: your best guess");
    expect(result.passed).toBe(true);
  });

  it("making a spec change is asked once - for a draft, or why the change needs no code", async () => {
    silent = true;
    writeFileSync(join(dir, "app.plain"), plain(["- One."]));
    const diff = ["diff --git a/app.plain b/app.plain", "--- a/app.plain", "+++ b/app.plain", "@@ -6 +6,3 @@", " - One.", "+", "+- Two.", ""].join("\n");
    await renderSpecDiff({ plainFile: "app.plain", diff, cwd: dir });
    expect(drafts()).toHaveLength(DRAFT_ASKS);
    expect(drafts()[0]).toContain("If you are sure it needs no code at all");
  });
});

describe("a coding agent regenerating a functional spec again that has written nothing", () => {
  const diff = ["diff --git a/app.plain b/app.plain", "--- a/app.plain", "+++ b/app.plain", "@@ -6 +6,3 @@", " - One.", "+", "+- Two.", ""].join("\n");
  const cases = { fresh: false, add: [], patch: [], again: [{ frid: "1", text: "One." }], delete: [], mechanical: false };
  const agains = () => drafts().filter((prompt) => prompt.includes("to be regenerated again"));

  it("is sent back to build it anew, never offered that it needs no code - and what it builds goes on to be tested", async () => {
    writesOn = "to be regenerated again";
    writeFileSync(join(dir, "app.plain"), plain(["- One."]));
    const result = await renderSpecDiff({ plainFile: "app.plain", diff, cwd: dir, cases });
    expect(agains()).toHaveLength(1);
    expect(agains()[0]).toContain("take its\nimplementation and its unit tests out and build them anew");
    expect(drafts().some((prompt) => prompt.includes("If you are sure it needs no code at all"))).toBe(false);
    expect(result.passed).toBe(true);
  });

  it("does not land when it still writes nothing", async () => {
    silent = true;
    writeFileSync(join(dir, "app.plain"), plain(["- One."]));
    const result = await renderSpecDiff({ plainFile: "app.plain", diff, cwd: dir, cases });
    expect(agains()).toHaveLength(AGAIN_ASKS);
    expect(result.passed).toBe(false);
    expect(result.attempts).toBe(0);
  });
});
