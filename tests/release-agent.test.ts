import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/** The task each release agent was given, and what it was asked. */
const tasks: string[] = [];

vi.mock("../src/pi.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/pi.ts")>()),
  createExecutor: vi.fn(async (opts: { task: string }) => {
    tasks.push(opts.task);
    return { dispose: () => {} };
  }),
  ask: vi.fn(async () => "Released to dist/app."),
}));

const { runReleaseAgent } = await import("../src/release-agent.ts");
const { createDeployState } = await import("../src/release-tools.ts");

const dirs: string[] = [];
afterEach(() => {
  tasks.splice(0);
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
});
