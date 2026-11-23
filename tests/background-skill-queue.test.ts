import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A background skill asked for two modules at once - a backend's testing script and a frontend's, in one turn: the
 * second waits its turn rather than being dropped, and its module's script counts as being written from the moment it
 * is asked for, so the work loop never starts that module with another module's script in between.
 */

/** Each run of the skill, by the .plain file it is for, and what ends it. */
const runs: Array<{ for: string; end: () => void }> = [];
vi.mock("../src/genome.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/genome.ts")>()),
  runSkill: (opts: { context?: string; skillDir: string }) =>
    new Promise((resolve) => {
      const shown = /It is for ([^,.\s]+\.plain)/.exec(opts.context ?? "")?.[1] ?? "?";
      runs.push({ for: shown, end: () => resolve({ skill: { name: "implement-unit-testing-script" }, ok: true, artifacts: {}, output: "written" }) });
    }),
}));

const { createTurriCore } = await import("../src/extension.ts");
const { scriptBeingWritten } = await import("../src/regenerate/scripts-being-written.ts");

let project: string;
let before: string;
beforeEach(() => {
  runs.length = 0;
  project = realpathSync(mkdtempSync(join(tmpdir(), "turri-skill-queue-")));
  writeFileSync(join(project, "config.turri.yaml"), "conformance-tests: false\n");
  writeFileSync(join(project, "config.turri.backend.yaml"), "unittests-script: test_scripts/run_unittests_python.sh\n");
  writeFileSync(join(project, "backend.plain"), "***functional specs***\n\n# serve\nServe.\n");
  writeFileSync(join(project, "frontend.plain"), "***functional specs***\n\n# show\nShow.\n");
  before = process.cwd();
  process.chdir(project);
});
afterEach(() => {
  process.chdir(before);
  rmSync(project, { recursive: true, force: true });
});

function chatTools() {
  const tools = new Map<string, { execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }> }>();
  const pi = new Proxy({}, {
    get: (_target, key) =>
      key === "registerTool" ? (tool: { name: string; execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }> }) => tools.set(tool.name, tool) : () => undefined,
  }) as never;
  createTurriCore().extension(pi);
  const ctx = { hasUI: true, mode: "tui", model: undefined, sessionManager: { getBranch: () => [] } };
  return (plainFile: string) => tools.get("cultivate")!.execute("id", { skill: "implement-unit-testing-script", plainFile, context: "two stacks" }, undefined, undefined, ctx);
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("a background skill asked for a second module while it runs for one", () => {
  it("waits its turn and runs once the first ends - its module's script counted as being written all along", async () => {
    const cultivate = chatTools();
    expect((await cultivate("backend.plain")).content[0]!.text).toContain("is writing the unit testing script for backend.plain");
    const queued = (await cultivate("frontend.plain")).content[0]!.text;
    expect(queued).toContain("running in the background for backend.plain; the run for frontend.plain starts once it ends");
    expect(runs.map((run) => run.for)).toEqual(["backend.plain"]);
    // The frontend has no file of its own: a script written for none is anyone's, and one for it is on its way.
    expect(scriptBeingWritten(project, "unit")).toBe(true);

    runs[0]!.end();
    await settled();
    expect(runs.map((run) => run.for)).toEqual(["backend.plain", "frontend.plain"]);
    expect(scriptBeingWritten(project, "unit")).toBe(true);

    runs[1]!.end();
    await settled();
    expect(scriptBeingWritten(project, "unit")).toBe(false);
  });

  it("is the run under way, asked for the same module again - nothing new started or queued", async () => {
    const cultivate = chatTools();
    await cultivate("backend.plain");
    expect((await cultivate("backend.plain")).content[0]!.text).toContain("running in the background already");
    await cultivate("frontend.plain");
    expect((await cultivate("frontend.plain")).content[0]!.text).toContain("running in the background already");
    runs[0]!.end();
    await settled();
    runs[1]!.end();
    await settled();
    expect(runs.map((run) => run.for)).toEqual(["backend.plain", "frontend.plain"]);
  });
});
