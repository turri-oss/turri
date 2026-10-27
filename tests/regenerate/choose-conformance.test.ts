import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BEGIN } from "../../src/pi.ts";

/** The chooser's answer, as the stub agent gives it - or none. */
let answers: Array<{ funcIds: string[]; why: string; groups?: string[][] }> = [];
const tasks: string[] = [];
const models: Array<string | undefined> = [];
type StubSession = { tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }> }> };
vi.mock("../../src/pi.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/pi.ts")>();
  return {
    ...actual,
    createExecutor: async (opts: { customTools: StubSession["tools"]; task: string; model?: string }) => {
      tasks.push(opts.task);
      models.push(opts.model);
      return { tools: opts.customTools, dispose() {} };
    },
    ask: async (session: StubSession, prompt: string) => {
      const answer = answers.shift();
      if (answer !== undefined) {
        const result = await session.tools[0]!.execute("id", answer);
        return result.content[0]!.text;
      }
      return prompt === BEGIN ? "Thinking." : "Still thinking.";
    },
  };
});
const { chooseConformance } = await import("../../src/regenerate/choose-conformance.ts");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "turri-choose-"));
  writeFileSync(join(dir, "app.plain"), "***functional specs***\n\n# say-hello\nSay hello.\n\n# log-greetings\nLog every greeting.\n");
  answers = [];
  tasks.length = 0;
  models.length = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const specs = [
  { funcId: "say-hello", text: "Say hello." },
  { funcId: "log-greetings", text: "Log every greeting." },
];

describe("choosing the conformance tests", () => {
  it("asks the harness model with the module's spec and what to choose from, and takes what it chose and why", async () => {
    answers = [{ funcIds: ["say-hello"], why: "a client relies on the greeting; the log is internal" }];
    const chosen = await chooseConformance({ plainFile: join(dir, "app.plain"), specs, model: "amazon-bedrock/eu.anthropic.claude-opus-5-5" });
    expect(chosen).toEqual({ funcIds: ["say-hello"], why: "a client relies on the greeting; the log is internal" });
    expect(models).toEqual(["amazon-bedrock/eu.anthropic.claude-opus-5-5"]);
    expect(tasks[0]).toContain("- log-greetings: Log every greeting.");
    expect(tasks[0]).toContain('<spec file="app.plain">\n***functional specs***');
  });

  it("refuses a func-id it was not offered, and takes the answer given again", async () => {
    answers = [{ funcIds: ["nothing-such"], why: "wrong" }, { funcIds: ["log-greetings"], why: "right" }];
    expect(await chooseConformance({ plainFile: join(dir, "app.plain"), specs })).toEqual({ funcIds: ["log-greetings"], why: "right" });
  });

  it("refuses more than the module's budget, and takes the answer that fits", async () => {
    answers = [{ funcIds: ["say-hello", "log-greetings"], why: "both" }, { funcIds: ["say-hello"], why: "the greeting matters most" }];
    expect(await chooseConformance({ plainFile: join(dir, "app.plain"), specs, budget: 1 })).toEqual({ funcIds: ["say-hello"], why: "the greeting matters most" });
    expect(tasks[0]).toContain("Choose at most 1 - the module's conformance budget");
  });

  it("chooses none when the agent never answers", async () => {
    expect((await chooseConformance({ plainFile: join(dir, "app.plain"), specs })).funcIds).toEqual([]);
  });

  it("is told, as a pulse ends, that the pulse just regenerated what it chooses from - and plans nothing", async () => {
    answers = [{ funcIds: ["say-hello"], why: "the greeting" }];
    expect(await chooseConformance({ plainFile: join(dir, "app.plain"), specs, when: "pulse" })).toEqual({ funcIds: ["say-hello"], why: "the greeting" });
    expect(tasks[0]).toContain("conformance-tests: chosen - a code pulse has just regenerated these");
    expect(tasks[0]).not.toContain("Plan them too");
  });

  it("under module, plans the pulses too - every one chosen in exactly one group - and asks again when the groups do not fit", async () => {
    answers = [
      { funcIds: ["say-hello", "log-greetings"], why: "both", groups: [["say-hello"]] },
      { funcIds: ["say-hello", "log-greetings"], why: "both, apart", groups: [["say-hello"], ["log-greetings"]] },
    ];
    expect(await chooseConformance({ plainFile: join(dir, "app.plain"), specs, when: "module" })).toEqual({ funcIds: ["say-hello", "log-greetings"], why: "both, apart", groups: [["say-hello"], ["log-greetings"]] });
    expect(tasks[0]).toContain("conformance-tests: module - the whole module is regenerated now");
    expect(tasks[0]).toContain("Plan them too: in groups, each a conformance pulse");
  });
});
