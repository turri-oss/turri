import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Launch } from "../src/launch-track.ts";
import type { ExportedCode } from "../src/regenerate/launch.ts";

/** The task each launch agent was given. */
const tasks: string[] = [];
/** The tools each launch agent was given. */
const toolSets: Array<Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }>> = [];
/** What the scripted agent does with its tools on its first turn - and on the turn it is asked again. */
const script: { first?: (call: (name: string, params: object) => Promise<unknown>) => Promise<string>; again?: (call: (name: string, params: object) => Promise<unknown>) => Promise<string> } = {};

vi.mock("../src/pi.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/pi.ts")>()),
  createExecutor: vi.fn(async (opts: { task: string; customTools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> }) => {
    tasks.push(opts.task);
    toolSets.push(opts.customTools);
    return { dispose: () => {}, abort: async () => {}, turns: 0 };
  }),
  ask: vi.fn(async (session: { turns: number }) => {
    const tools = toolSets[toolSets.length - 1]!;
    const call = (name: string, params: object) => tools.find((tool) => tool.name === name)!.execute("id", params, undefined, undefined, undefined);
    session.turns += 1;
    const turn = session.turns === 1 ? script.first : script.again;
    return turn !== undefined ? turn(call) : "Launched to dist/app.";
  }),
}));

const { runLaunchAgent } = await import("../src/launch-agent.ts");

const dirs: string[] = [];
afterEach(() => {
  tasks.splice(0);
  toolSets.splice(0);
  delete script.first;
  delete script.again;
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

function project(): { dir: string; launch: Launch; code: ExportedCode } {
  const dir = mkdtempSync(join(tmpdir(), "turri-launch-agent-"));
  dirs.push(dir);
  writeFileSync(join(dir, "config.turri.yaml"), "launch-after-pulse: true\n");
  writeFileSync(join(dir, "app.plain"), "***functional specs***\n\n- Say hello.\n");
  mkdirSync(join(dir, "dist", "app"), { recursive: true });
  const code: ExportedCode = {
    moduleName: "app",
    plainFile: join(dir, "app.plain"),
    dir: join(dir, "dist", "app"),
    buildDir: join(dir, "plain_modules", "app", "code"),
    commit: "abcdef0123456789",
    short: "abcdef0",
    subject: "spec diff: say hello",
    when: "a minute ago",
    unfinished: false,
  };
  const launch: Launch = {
    id: "launch-1",
    codebase: "app",
    moduleDir: join(dir, "plain_modules", "app"),
    plainFile: join(dir, "app.plain"),
    commit: code.commit,
    short: code.short,
    hostDir: dir,
    cause: { pulse: "p1", title: "Say hello." },
    status: "running",
    queuedAt: 0,
  };
  return { dir, launch, code };
}

describe("the launch agent", () => {
  it("launches what a pulse landed whatever the guidance says of launching after a build - the guidance says only how - and takes the code from dist, never plain_modules", async () => {
    const { dir, launch, code } = project();
    await runLaunchAgent({ launch, code, cwd: dir });
    expect(tasks[0]).toContain("The project launches what every pulse lands: launch it now, whether or not the guidance speaks of launching after a build");
    expect(tasks[0]).toContain("app's code at commit abcdef0");
    expect(tasks[0]).toContain(`Take it from there, never from ${join(dir, "plain_modules", "app", "code")}`);
    expect(tasks[0]).toContain("you install nothing on the machine and change none of its settings");
    expect(tasks[0]).toContain("call submit_launch once");
  });

  it("returns how it went as submitted - not its prose", async () => {
    const { dir, launch, code } = project();
    script.first = async (call) => {
      await call("submit_launch", { launched: false, summary: "node is not installed: brew install node." });
      return "All done, it is running!";
    };
    expect(await runLaunchAgent({ launch, code, cwd: dir })).toEqual({ launched: false, summary: "node is not installed: brew install node." });
  });

  it("asks once more when it ends without submitting, then takes it as not launched", async () => {
    const { dir, launch, code } = project();
    script.first = async () => "I think it works.";
    script.again = async () => "Still not sure.";
    expect(await runLaunchAgent({ launch, code, cwd: dir })).toEqual({ launched: false, summary: "Still not sure." });
  });

  it("never writes the ***plain - a module or a test plain file - though it may write beside it", async () => {
    const { dir, launch, code } = project();
    await runLaunchAgent({ launch, code, cwd: dir });
    const tool = (name: string) => toolSets[0]!.find((candidate) => candidate.name === name)!;
    await expect(tool("write").execute("id", { path: "app.plain", content: "***functional specs***\n\n- Say goodbye.\n" })).rejects.toThrow(/is \*\*\*plain/);
    await expect(tool("write").execute("id", { path: "tests/app/say-hello.plain", content: "x" })).rejects.toThrow(/is \*\*\*plain/);
    await expect(tool("edit").execute("id", { path: "app.plain", edits: [{ oldText: "hello", newText: "goodbye" }] })).rejects.toThrow(/is \*\*\*plain/);
    await expect(tool("write").execute("id", { path: "plain_modules/app/code/app.py", content: "x" })).rejects.toThrow(/is built code/);
    expect(readFileSync(join(dir, "app.plain"), "utf8")).toContain("Say hello.");
    expect(existsSync(join(dir, "tests", "app", "say-hello.plain"))).toBe(false);
    await tool("write").execute("id", { path: "launch.sh", content: "#!/bin/sh\n" });
    expect(existsSync(join(dir, "launch.sh"))).toBe(true);
  });

  it("has activate and submit_launch, and nothing that launches, halts or regenerates", async () => {
    const { dir, launch, code } = project();
    await runLaunchAgent({ launch, code, cwd: dir });
    const names = toolSets[0]!.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(["activate", "submit_launch", "bash", "read", "write", "edit"]));
    for (const name of ["launch", "halt", "regenerate"]) expect(names).not.toContain(name);
  });
});

describe("the launch agent's shell", () => {
  it("installs what the launch needs into the project, and refuses what would change the machine", async () => {
    const { launchShell } = await import("../src/launch-agent.ts");
    const shell = launchShell(mkdtempSync(join(tmpdir(), "turri-launch-shell-"))) as unknown as { execute: (...args: unknown[]) => Promise<unknown>; description: string };
    expect(shell.description).toContain("activate does");
    expect(shell.description).toContain("It installs nothing on the machine and changes none of its settings");
    await expect(shell.execute("call", { command: "brew install node" }, undefined, undefined, {})).rejects.toThrow(/turri changes nothing of this machine's - brew installs into the system/);
    await expect(shell.execute("call", { command: "npm install -g serve" }, undefined, undefined, {})).rejects.toThrow(/installs globally/);
  });
});
