import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/** The task each release agent was given, and what it was asked. */
const tasks: string[] = [];
/** The tools each release agent was given. */
const toolSets: Array<Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }>> = [];

vi.mock("../src/pi.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/pi.ts")>()),
  createExecutor: vi.fn(async (opts: { task: string; customTools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> }) => {
    tasks.push(opts.task);
    toolSets.push(opts.customTools);
    return { dispose: () => {} };
  }),
  ask: vi.fn(async () => "Released to dist/app."),
}));

const { runReleaseAgent } = await import("../src/release-agent.ts");
const { createDeployState } = await import("../src/release-tools.ts");

const dirs: string[] = [];
afterEach(() => {
  tasks.splice(0);
  toolSets.splice(0);
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "turri-release-agent-"));
  dirs.push(dir);
  writeFileSync(join(dir, "config.turri.yaml"), "release-after-pulse: true\n");
  writeFileSync(join(dir, "app.plain"), "***functional specs***\n\n- Say hello.\n");
  return dir;
}

describe("the release after a pulse", () => {
  it("releases what the pulse landed whatever the guidance says of releasing after a build - the guidance says only how", async () => {
    const dir = project();
    await runReleaseAgent({ plainFile: join(dir, "app.plain"), cwd: dir, state: createDeployState(), afterPulse: { moduleName: "app", subject: "Say hello." } });
    expect(tasks[0]).toContain("Release it now, before the module's next pulse starts: the project releases after every pulse.");
    expect(tasks[0]).toContain("Release it whether or not the guidance speaks of releasing after a build");
    expect(tasks[0]).not.toContain("call nothing");
  });

  it("never writes the ***plain - a module or a test plain file - though it may write beside it", async () => {
    const dir = project();
    await runReleaseAgent({ plainFile: join(dir, "app.plain"), cwd: dir, state: createDeployState(), afterPulse: { moduleName: "app", subject: "Say hello." } });
    const tool = (name: string) => toolSets[0]!.find((candidate) => candidate.name === name)!;
    await expect(tool("write").execute("id", { path: "app.plain", content: "***functional specs***\n\n- Say goodbye.\n" })).rejects.toThrow(/is \*\*\*plain/);
    await expect(tool("write").execute("id", { path: "tests/app/say-hello.plain", content: "x" })).rejects.toThrow(/is \*\*\*plain/);
    await expect(tool("edit").execute("id", { path: "app.plain", edits: [{ oldText: "hello", newText: "goodbye" }] })).rejects.toThrow(/is \*\*\*plain/);
    expect(readFileSync(join(dir, "app.plain"), "utf8")).toContain("Say hello.");
    expect(existsSync(join(dir, "tests", "app", "say-hello.plain"))).toBe(false);
    await tool("write").execute("id", { path: "release.sh", content: "#!/bin/sh\n" });
    expect(existsSync(join(dir, "release.sh"))).toBe(true);
  });
});
