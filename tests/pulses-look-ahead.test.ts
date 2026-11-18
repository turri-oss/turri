import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeTestScripts } from "./test-scripts.ts";

// The planner's agents, counted: no test calls a model. Hello and goodbye go together, counting alone.
const planned = vi.hoisted(() => ({ calls: 0 }));
vi.mock("../src/regenerate/chunk-plan.ts", async (original) => ({
  ...(await original<typeof import("../src/regenerate/chunk-plan.ts")>()),
  llmChunkAgents: () => ({
    group: async (specs: Array<{ number: number }>) => {
      planned.calls += 1;
      return specs.length === 3 ? { groups: [{ specs: [1, 2], title: "Greetings" }, { specs: [3], title: "Counting" }] } : undefined;
    },
    place: async () => undefined,
  }),
}));

const { createTurriCore } = await import("../src/extension.ts");

type Tool = { execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }> };

/** turri's extension built into a pi that keeps the tools it registers. */
function chatTools() {
  const tools = new Map<string, Tool>();
  const pi = new Proxy({}, {
    get: (_target, key) => (key === "registerTool" ? (tool: Tool & { name: string }) => tools.set(tool.name, tool) : () => undefined),
  }) as never;
  const core = createTurriCore();
  core.extension(pi);
  const pulses = async (params: Record<string, unknown>) => (await tools.get("pulses")!.execute("call", params, undefined, undefined, { hasUI: false })).content[0]!.text;
  return { core, tools, pulses };
}

let dir: string;
let before: string;
beforeEach(() => {
  before = process.cwd();
  dir = mkdtempSync(join(tmpdir(), "turri-look-ahead-"));
  process.chdir(dir);
  planned.calls = 0;
});
afterEach(() => {
  process.chdir(before);
  rmSync(dir, { recursive: true, force: true });
});

describe("the pulses tool's look ahead", () => {
  it("is the chat's one tool for what runs next - there is no glimpse", () => {
    const { tools } = chatTools();
    expect(tools.has("pulses")).toBe(true);
    expect(tools.has("glimpse")).toBe(false);
  });

  it("plans a module with plain_file, starts nothing, and shows the next pulse's prompt from the plan kept for a planned row's id", async () => {
    writeTestScripts(dir);
    writeFileSync(
      join(dir, "app.plain"),
      "***implementation reqs***\n\n- :Implementation: is Python.\n\n***functional specs***\n\n# say-hello\nSay hello.\n\n# say-goodbye\nSay goodbye.\n\n# count-to-ten\nCount to ten.\n",
    );
    const { core, pulses } = chatTools();
    const looked = await pulses({ plain_file: "app.plain" });
    expect(looked).toContain("planned-app-1  app.plain Greetings");
    expect(looked).toContain("planned-app-2  app.plain Counting");
    expect(looked).toContain("Nothing was started.");
    expect(core.jobs.list()).toEqual([]);
    expect(existsSync(join(dir, "plain_modules", "app"))).toBe(false);

    // Listed with the rest, marked as waiting for regenerate.
    expect(await pulses({})).toMatch(/planned-app-1 +planned .*looked ahead: waits for regenerate/);

    const next = await pulses({ job_id: "planned-app-1" });
    expect(next).toContain("Planned by a look ahead");
    expect(next).toContain("<prompt>");
    expect(next).toContain("Say hello.");
    expect(next).toContain("Say goodbye.");
    const later = await pulses({ job_id: "planned-app-2" });
    expect(later).not.toContain("<prompt>");
    expect(later).toContain("its prompt depends on what that one lands");
    // Told from the plan kept: the planner ran once.
    expect(planned.calls).toBe(1);
  });

  it("refuses plain_file and job_id together", async () => {
    const { pulses } = chatTools();
    expect(await pulses({ plain_file: "app.plain", job_id: "planned-app-1" })).toContain("Pass job_id or plain_file, not both");
  });
});
