import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writePlain } from "../test-plain.ts";
import { lastCommit, recordHistory } from "../../src/regenerate/lineage.ts";
import { exportModule, holdsCommit, listLaunched, runningLaunched, startLaunched, stopLaunched, stopLeftBehind, type LaunchRecord } from "../../src/regenerate/launch.ts";
import { activateTool, projectNotes } from "../../src/launch-agent.ts";
import { createLaunchTrack, type Launch, type LaunchOutcome } from "../../src/launch-track.ts";
import { haltLaunched } from "../../src/loop-tools.ts";
import { launchedNote, replacedNote } from "../../src/launch-session.ts";
import type { ExportedCode } from "../../src/regenerate/launch.ts";
import { NOTES_FILE } from "../../src/regenerate/notes.ts";
import { RECORD_FILE } from "../../src/regenerate/records.ts";

let dir: string;

/** A module with its code committed, the way a render leaves it. */
function built(moduleName: string, files: Record<string, string>): string {
  const code = join(dir, "plain_modules", moduleName, "code");
  mkdirSync(code, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(join(code, file, ".."), { recursive: true });
    writeFileSync(join(code, file), content);
  }
  recordHistory(code, `render ${moduleName}:greet`);
  return code;
}

function spec(name: string, requires?: string): string {
  const file = join(dir, `${name}.plain`);
  writePlain(dir, `${name}.plain`, `${requires !== undefined ? `---\nrequires:\n    - ${requires}\n---\n\n` : ""}***implementation reqs***\n\n- Python.\n\n***functional specs***\n\n# greet\n${name} greets.\n`);
  return file;
}

/** A port nothing listens on. */
function freePort(): Promise<number> {
  return new Promise((done) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => done(port));
    });
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "turri-launch-"));
  writeFileSync(join(dir, "config.yaml"), "module: app.plain\n");
});
afterEach(async () => {
  await stopLaunched();
  rmSync(dir, { recursive: true, force: true });
});

describe("exporting a codebase for a launch", () => {
  it("exports into a folder of its own when given one - turri regenerate --build-dir - its code and that of every module below", () => {
    built("base", { "base.py": "BASE = 1\n" });
    built("app", { "base.py": "BASE = 1\n", "app.py": "import base\n", [RECORD_FILE]: "{}" });
    const into = join(dir, "out", "build");
    mkdirSync(into, { recursive: true });
    writeFileSync(join(into, "stale.py"), "old\n");
    mkdirSync(join(into, "stale", "deep"), { recursive: true });
    // The folder itself stays - it may be a mount point, which cannot be removed: only what is in it is replaced.
    const before = statSync(into).ino;
    spec("base");
    const deployment = exportModule(spec("app", "base"), { into });
    expect(deployment.dir).toBe(into);
    expect(readFileSync(join(into, "app.py"), "utf8")).toBe("import base\n");
    expect(existsSync(join(into, "base.py"))).toBe(true);
    expect(existsSync(join(into, "stale.py"))).toBe(false);
    expect(existsSync(join(into, "stale"))).toBe(false);
    expect(statSync(into).ino).toBe(before);
    expect(existsSync(join(into, RECORD_FILE))).toBe(false);
    expect(existsSync(join(dir, "dist"))).toBe(false);
  });

  it("puts its last commit in dist/<module> - leaving out what a job is writing now, and the harness's own files", () => {
    const code = built("app", { "app.py": "print('hello')\n", [RECORD_FILE]: "{}", [NOTES_FILE]: "- notes\n" });
    // A render at work: a file half-written, one not committed, dependencies installed.
    writeFileSync(join(code, "app.py"), "print('hel");
    writeFileSync(join(code, "wip.py"), "half\n");
    mkdirSync(join(code, "node_modules", "left-pad"), { recursive: true });

    const deployment = exportModule(spec("app"));

    expect(deployment.dir).toBe(join(dir, "dist", "app"));
    expect(readFileSync(join(deployment.dir, "app.py"), "utf8")).toBe("print('hello')\n");
    expect(existsSync(join(deployment.dir, "wip.py"))).toBe(false);
    expect(existsSync(join(deployment.dir, "node_modules"))).toBe(false);
    expect(existsSync(join(deployment.dir, RECORD_FILE))).toBe(false);
    expect(existsSync(join(deployment.dir, NOTES_FILE))).toBe(false);
    expect(deployment.unfinished).toBe(true);
    expect(deployment.subject).toBe("render app:greet");
    // The work under way is the job's: it is left as it was.
    expect(readFileSync(join(code, "app.py"), "utf8")).toBe("print('hel");
    expect(existsSync(join(code, "wip.py"))).toBe(true);
  });

  it("replaces what an earlier launch left in dist", () => {
    built("app", { "app.py": "print('hello')\n" });
    const first = exportModule(spec("app"));
    writeFileSync(join(first.dir, "stale.txt"), "from before\n");
    const again = exportModule(spec("app"));
    expect(existsSync(join(again.dir, "stale.txt"))).toBe(false);
    expect(existsSync(join(again.dir, "app.py"))).toBe(true);
  });

  it("takes the module on top of the chain, which holds the code of the ones below", () => {
    built("base", { "base.py": "base\n" });
    built("app", { "base.py": "base\n", "app.py": "app\n" });
    spec("base");
    const deployment = exportModule(spec("app", "base"));
    expect(deployment.moduleName).toBe("app");
    expect(existsSync(join(deployment.dir, "app.py"))).toBe(true);
  });

  it("takes the module below, when the one on top has nothing built yet", () => {
    built("base", { "base.py": "base\n" });
    spec("base");
    const deployment = exportModule(spec("app", "base"));
    expect(deployment.moduleName).toBe("base");
    expect(deployment.instead).toBe("app");
    expect(deployment.dir).toBe(join(dir, "dist", "base"));
  });

  it("says there is nothing to launch before anything is built", () => {
    expect(() => exportModule(spec("app"))).toThrow(/Nothing is built yet/);
  });

  it("exports the commit it is given - a pulse's - though the codebase has moved on, and leaves the working tree alone", () => {
    const code = built("app", { "app.py": "print('one')\n" });
    spec("app");
    const first = lastCommit(code)!;
    writeFileSync(join(code, "app.py"), "print('two')\n");
    recordHistory(code, "spec diff: app says two");
    // The next pulse at work, writing.
    writeFileSync(join(code, "app.py"), "print('thr");
    const exported = exportModule(join(dir, "app.plain"), { commit: first });
    expect(exported.commit).toBe(first);
    expect(readFileSync(join(exported.dir, "app.py"), "utf8")).toBe("print('one')\n");
    expect(readFileSync(join(code, "app.py"), "utf8")).toBe("print('thr");
    expect(holdsCommit(join(dir, "plain_modules", "app"), first, lastCommit(code)!)).toBe(true);
    expect(holdsCommit(join(dir, "plain_modules", "app"), lastCommit(code)!, first)).toBe(false);
  });
});

describe("what a launch starts", () => {
  it("waits for a server to answer at its URL, and stops it when asked", async () => {
    const port = await freePort();
    mkdirSync(join(dir, "site"));
    const started = await startLaunched({ name: "web", command: `exec python3 -m http.server ${port} --bind 127.0.0.1`, dir: join(dir, "site"), moduleName: "app", logDir: join(dir, "logs"), url: `http://127.0.0.1:${port}/` });
    expect(started.ok).toBe(true);
    expect(started.text).toContain(`is up at http://127.0.0.1:${port}/`);
    expect(runningLaunched("app").map((item) => item.name)).toEqual(["web"]);

    expect(await stopLaunched({ name: "web" })).toEqual(["web"]);
    expect(runningLaunched()).toEqual([]);
  }, 30_000);

  it("starts nothing on a port something else holds, and says so", async () => {
    const port = await freePort();
    mkdirSync(join(dir, "site"));
    const url = `http://127.0.0.1:${port}/`;
    const first = await startLaunched({ name: "one", command: `exec python3 -m http.server ${port} --bind 127.0.0.1`, dir: join(dir, "site"), moduleName: "app", logDir: join(dir, "logs"), url });
    expect(first.ok).toBe(true);
    const second = await startLaunched({ name: "two", command: `exec python3 -m http.server ${port} --bind 127.0.0.1`, dir: join(dir, "site"), moduleName: "app", logDir: join(dir, "logs"), url });
    expect(second.ok).toBe(false);
    expect(second.text).toContain(`Port ${port} is in use already`);
    expect(listLaunched().map((item) => item.name)).not.toContain("two");
  }, 30_000);

  it("starts nothing in a folder that is not there - saying so, and what the folder it is named from holds - and the process lives on", async () => {
    mkdirSync(join(dir, "site"));
    writeFileSync(join(dir, "site", "app.py"), "print('hello')\n");
    const crashes: unknown[] = [];
    const onCrash = (error: unknown) => crashes.push(error);
    process.on("uncaughtException", onCrash);
    try {
      const started = await startLaunched({ name: "web", command: "sleep 30", dir: join(dir, "site", "frontend"), root: join(dir, "site"), moduleName: "app", logDir: join(dir, "logs") });
      await new Promise((done) => setTimeout(done, 200));
      expect(started.ok).toBe(false);
      expect(started.text).toContain("web was not started:");
      expect(started.text).toContain(`${join("site", "frontend")} does not exist`);
      expect(started.text).toContain(`\`dir\` is relative to ${join(dir, "site")}`);
      expect(started.text).toContain("holds: app.py.");
      expect(runningLaunched()).toEqual([]);
      expect(crashes).toEqual([]);
    } finally {
      process.off("uncaughtException", onCrash);
    }
  });

  it("shows the end of its output when it exits before it is ready", async () => {
    mkdirSync(join(dir, "site"));
    const started = await startLaunched({ name: "broken", command: "echo 'ModuleNotFoundError: flask'; exit 3", dir: join(dir, "site"), moduleName: "app", logDir: join(dir, "logs") });
    expect(started.ok).toBe(false);
    expect(started.text).toContain("exited with 3");
    expect(started.text).toContain("ModuleNotFoundError: flask");
  }, 30_000);
});

/** A launch track whose agent is scripted: what each launch was given, and what it does. */
function track(agent: (launch: Launch, code: ExportedCode) => Promise<LaunchOutcome> = async (launch) => ({ launched: true, summary: `${launch.codebase} runs.` })) {
  const runs: Array<{ id: string; commit: string; app: string }> = [];
  /** What the track told, as onChange was called: each launch as it stood then. */
  const told: Launch[] = [];
  const launches = createLaunchTrack({
    cwd: dir,
    run: async (launch, code) => {
      runs.push({ id: launch.id, commit: launch.short, app: readFileSync(join(code.dir, "app.py"), "utf8") });
      return agent(launch, code);
    },
    onChange: (launch) => told.push({ ...launch }),
  });
  return { launches, runs, told };
}

describe("the launch track", () => {
  it("launches a codebase's last commit in dist, and does nothing for it again while what it started runs - again, once a pulse lands", async () => {
    const code = built("app", { "app.py": "print('hello')\n" });
    spec("app");
    const { launches, runs } = track(async (launch, exported) => {
      const started = await startLaunched({ name: "sleeper", command: "sleep 30", dir: exported.dir, moduleName: launch.codebase, logDir: join(dir, "logs") });
      return { launched: started.ok, summary: "sleeper runs." };
    });
    const first = launches.request({ plainFile: join(dir, "app.plain"), cause: {} });
    expect(first.already).toBe(false);
    expect((await launches.done(first.launch.id)).status).toBe("launched");
    expect(runs).toHaveLength(1);
    // Asked again with nothing new - guidance passed on as the agent found it, say: nothing exported, nothing stopped.
    const again = launches.request({ plainFile: join(dir, "app.plain"), guidance: "Start it with python3 app.py.", cause: {} });
    expect(again.already).toBe(true);
    expect(runningLaunched("app").map((item) => item.name)).toEqual(["sleeper"]);
    const firstPid = runningLaunched("app")[0]!.pid;
    // A pulse lands: launched again, what ran stopped first.
    writeFileSync(join(code, "app.py"), "print('hello again')\n");
    recordHistory(code, "spec diff: app greets again");
    const after = launches.request({ plainFile: join(dir, "app.plain"), cause: {} });
    expect(after.already).toBe(false);
    await launches.done(after.launch.id);
    expect(runs.map((run) => run.app)).toEqual(["print('hello')\n", "print('hello again')\n"]);
    expect(() => process.kill(firstPid, 0)).toThrow();
    expect(runningLaunched("app").map((item) => item.pid)).not.toContain(firstPid);
    // Asked to, it launches again even with nothing new.
    const forced = launches.request({ plainFile: join(dir, "app.plain"), again: true, cause: {} });
    expect(forced.already).toBe(false);
    await launches.done(forced.launch.id);
    expect(runs).toHaveLength(3);
  }, 30_000);

  it("launches one commit at a time, the newest waiting winning - and what waited takes the newest's end", async () => {
    const code = built("app", { "app.py": "one\n" });
    spec("app");
    let release!: () => void;
    const held = new Promise<void>((done) => (release = done));
    // The first launch is held, so the commits after it land while it runs.
    const { launches, runs } = track(async (launch) => {
      if (runs.length === 1) await held;
      return { launched: true, summary: `${launch.short} runs.` };
    });
    const commits: string[] = [];
    const land = (text: string) => {
      writeFileSync(join(code, "app.py"), text);
      recordHistory(code, `spec diff: ${text.trim()}`);
      commits.push(lastCommit(code)!);
      return launches.request({ plainFile: join(dir, "app.plain"), commit: lastCommit(code)!, cause: { pulse: `p${commits.length}`, title: text.trim() } }).launch;
    };
    const first = land("two\n");
    expect(first.status).toBe("running");
    const second = land("three\n");
    const third = land("four\n");
    expect(second.status).toBe("superseded");
    expect(second.supersededBy).toBe(third.id);
    expect(third.status).toBe("waiting");
    expect(launches.pending("app")?.id).toBe(first.id);
    release();
    await launches.settled("app");
    // The one in between was never launched: the newest holds its code.
    expect(runs.map((run) => run.app)).toEqual(["two\n", "four\n"]);
    expect((await launches.done(second.id)).id).toBe(third.id);
    expect(launches.holds("app", commits[1]!)).toBe(true);
    expect(launches.current("app")?.id).toBe(third.id);
  }, 30_000);

  it("takes a commit with the same code as what runs - one that landed only tests - as out already, and what runs as holding it", async () => {
    const code = built("app", { "app.py": "one\n" });
    spec("app");
    const { launches, runs } = track();
    await launches.done(launches.request({ plainFile: join(dir, "app.plain"), cause: {} }).launch.id);
    mkdirSync(join(dir, "plain_modules", "app", "tests"), { recursive: true });
    writeFileSync(join(dir, "plain_modules", "app", "tests", "test_app.py"), "assert True\n");
    recordHistory(code, "conformance tests: app greets");
    const tests = lastCommit(code)!;
    const asked = launches.request({ plainFile: join(dir, "app.plain"), commit: tests, cause: { pulse: "p2", title: "conformance" } });
    expect(asked.already).toBe(true);
    expect(runs).toHaveLength(1);
    expect(launches.holds("app", tests)).toBe(true);
  });

  it("tells the host of a request whose code is out already - launched, already, its own cause and the commit asked for - leaving the launch that started what runs as it was", async () => {
    const code = built("app", { "app.py": "one\n" });
    spec("app");
    const { launches, runs, told } = track();
    const first = launches.request({ plainFile: join(dir, "app.plain"), cause: { chat: "c1" } }).launch;
    await launches.done(first.id);
    const ran = lastCommit(code)!;
    mkdirSync(join(dir, "plain_modules", "app", "tests"), { recursive: true });
    writeFileSync(join(dir, "plain_modules", "app", "tests", "test_app.py"), "assert True\n");
    recordHistory(code, "conformance tests: app greets");
    const tests = lastCommit(code)!;
    told.length = 0;

    const asked = launches.request({ plainFile: join(dir, "app.plain"), commit: tests, cause: { pulse: "p2", title: "conformance" } });

    expect(asked.already).toBe(true);
    expect(runs).toHaveLength(1);
    expect(told).toEqual([
      expect.objectContaining({ id: asked.launch.id, status: "launched", already: true, commit: tests, short: tests.slice(0, 7), cause: { pulse: "p2", title: "conformance" }, summary: "app runs." }),
    ]);
    expect(asked.launch.id).not.toBe(first.id);
    expect(first).toMatchObject({ commit: ran, cause: { chat: "c1" } });
    expect(first.already).toBeUndefined();
    expect(launches.current("app")?.id).toBe(asked.launch.id);
    expect(launches.holds("app", tests)).toBe(true);
    expect(launches.holds("app", ran)).toBe(true);
    // Its end is told as any launch's is.
    expect((await launches.done(asked.launch.id)).status).toBe("launched");
  });

  it("says a launch whose agent throws failed, why - and what runs holds its commit all the same, for the sentinel to find out about", async () => {
    const code = built("app", { "app.py": "one\n" });
    spec("app");
    const { launches } = track(async () => {
      throw new Error("port 8000 is taken");
    });
    const { launch } = launches.request({ plainFile: join(dir, "app.plain"), commit: lastCommit(code)!, cause: { pulse: "p1", title: "one" } });
    const ended = await launches.done(launch.id);
    expect(ended.status).toBe("failed");
    expect(ended.summary).toBe("port 8000 is taken");
    expect(launches.holds("app", lastCommit(code)!)).toBe(true);
  });

  it("marks a launch stopped once what it started is halted on request - told to the host, nothing of it current - and launches the codebase anew after", async () => {
    built("app", { "app.py": "one\n" });
    spec("app");
    // The first starts a server; the one after needs nothing started to show it launched anew.
    const { launches, runs, told } = track(async (launch, exported) => {
      if (runs.length > 1) return { launched: true, summary: "launched anew." };
      const started = await startLaunched({ name: "backend", command: "sleep 30", dir: exported.dir, moduleName: launch.codebase, logDir: join(dir, "logs") });
      return { launched: started.ok, summary: "backend runs." };
    });
    const first = launches.request({ plainFile: join(dir, "app.plain"), cause: { chat: "c1" } }).launch;
    expect((await launches.done(first.id)).status).toBe("launched");
    told.length = 0;

    expect(await haltLaunched("app", launches)).toBe("Halted backend.");

    expect(told).toEqual([expect.objectContaining({ id: first.id, status: "stopped", summary: "Stopped on request." })]);
    expect(first.status).toBe("stopped");
    expect(launches.current("app")).toBeUndefined();
    expect(launches.holds("app", first.commit)).toBe(false);
    const next = launches.request({ plainFile: join(dir, "app.plain"), cause: { chat: "c1" } });
    expect(next.already).toBe(false);
    expect((await launches.done(next.launch.id)).status).toBe("launched");
    expect(runs).toHaveLength(2);
  }, 30_000);

  it("leaves a launch as it is when one server of several is halted, and stops it with the last", async () => {
    built("app", { "app.py": "one\n" });
    spec("app");
    const { launches, told } = track(async (launch, exported) => {
      await Promise.all(["backend", "frontend"].map((name) => startLaunched({ name, command: "sleep 30", dir: exported.dir, moduleName: launch.codebase, logDir: join(dir, "logs") })));
      return { launched: true, summary: "both run." };
    });
    const first = launches.request({ plainFile: join(dir, "app.plain"), cause: {} }).launch;
    await launches.done(first.id);
    told.length = 0;
    await haltLaunched("backend", launches);
    expect(told).toEqual([]);
    expect(launches.current("app")?.id).toBe(first.id);
    await haltLaunched("frontend", launches);
    expect(told.map((each) => `${each.id} ${each.status}`)).toEqual([`${first.id} stopped`]);
  }, 30_000);

  it("replaces a launch that ends with a newer one waiting - its real status told the host, whoever asked for it told at once that the newer one took over, then that one's end", async () => {
    const code = built("app", { "app.py": "one\n" });
    spec("app");
    let release!: () => void;
    const held = new Promise<void>((done) => (release = done));
    const { launches, told } = track(async (launch) => {
      if (launch.id === "launch-1") await held;
      return { launched: true, summary: `${launch.short} runs.` };
    });
    const asked = launches.request({ plainFile: join(dir, "app.plain"), cause: { chat: "c1" } }).launch;
    let takenBy: Launch | undefined;
    void launches.replaced(asked.id).then((next) => (takenBy = next));
    writeFileSync(join(code, "app.py"), "two\n");
    recordHistory(code, "spec diff: two");
    const pulse = launches.request({ plainFile: join(dir, "app.plain"), commit: lastCommit(code)!, cause: { pulse: "p1", title: "two" } }).launch;
    expect(pulse.status).toBe("waiting");
    release();
    const heard = await launches.done(asked.id);

    expect(heard.id).toBe(pulse.id);
    expect(heard.status).toBe("launched");
    expect(takenBy?.id).toBe(pulse.id);
    expect(asked).toMatchObject({ status: "launched", replacedBy: pulse.id });
    expect(told.find((each) => each.id === asked.id && each.status === "launched")?.replacedBy).toBe(pulse.id);
    expect(pulse.replacedBy).toBeUndefined();
    expect(launches.current("app")?.id).toBe(pulse.id);
  });

  it("does not replace a launch whose waiting successor is out already - it stays what runs, and is told as up", async () => {
    built("app", { "app.py": "one\n" });
    spec("app");
    let release!: () => void;
    const held = new Promise<void>((done) => (release = done));
    const { launches, runs } = track(async (launch) => {
      if (launch.id === "launch-1") await held;
      return { launched: true, summary: `${launch.short} runs.` };
    });
    const asked = launches.request({ plainFile: join(dir, "app.plain"), cause: { chat: "c1" } }).launch;
    const same = launches.request({ plainFile: join(dir, "app.plain"), cause: { chat: "c2" } }).launch;
    expect(same.status).toBe("waiting");
    release();
    const heard = await launches.done(asked.id);
    expect(heard.id).toBe(asked.id);
    expect(asked.replacedBy).toBeUndefined();
    expect((await launches.done(same.id)).already).toBe(true);
    expect(runs).toHaveLength(1);
  });

  it("stops the launch under way and the one waiting when halted, leaving nothing of them current", async () => {
    const code = built("app", { "app.py": "one\n" });
    spec("app");
    const { launches } = track((_launch) => new Promise(() => undefined));
    const first = launches.request({ plainFile: join(dir, "app.plain"), cause: {} }).launch;
    writeFileSync(join(code, "app.py"), "two\n");
    recordHistory(code, "spec diff: two");
    const second = launches.request({ plainFile: join(dir, "app.plain"), cause: {} }).launch;
    expect(await launches.stop("app")).toEqual([`${second.id} (app)`, `${first.id} (app)`]);
    expect((await launches.done(second.id)).status).toBe("stopped");
    expect((await launches.done(first.id)).status).toBe("stopped");
    expect(launches.current("app")).toBeUndefined();
    expect(launches.pending("app")).toBeUndefined();
  });
});

describe("activate", () => {
  const call = async (tool: { execute: (...args: never[]) => Promise<unknown> }, params: object) =>
    ((await (tool.execute as (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }>)("id", params, undefined, undefined, undefined)).content[0]!.text);

  it("starts a command that fetches as it starts without asking anyone first", async () => {
    built("app", { "app.py": "print('hello')\n" });
    const code = exportModule(spec("app"));
    const tool = activateTool({ codebase: "app", plainFile: join(dir, "app.plain"), hostDir: dir }, code);
    const text = await call(tool, { name: "app", command: "npx --version >/dev/null 2>&1; sleep 30" });
    expect(text).toContain("app is running");
  }, 30_000);

  it("starts nothing when dir is the project's path to dist, and says what dir is relative to - the process living on", async () => {
    built("app", { "app.py": "print('hello')\n" });
    const code = exportModule(spec("app"));
    const tool = activateTool({ codebase: "app", plainFile: join(dir, "app.plain"), hostDir: dir }, code);
    const crashes: unknown[] = [];
    const onCrash = (error: unknown) => crashes.push(error);
    process.on("uncaughtException", onCrash);
    try {
      const text = await call(tool, { name: "app", command: "sleep 30", dir: join("dist", "app") });
      await new Promise((done) => setTimeout(done, 200));
      expect(text).toContain("app was not started:");
      expect(text).toContain(`${join("dist", "app", "dist", "app")} does not exist`);
      expect(text).toContain("never the project's path to it");
      expect(text).toContain("app.py");
      expect(runningLaunched()).toEqual([]);
      expect(crashes).toEqual([]);
    } finally {
      process.off("uncaughtException", onCrash);
    }
  });

  it("starts what guidance says runs in the host codebase from there, with from: host - and nothing outside it", async () => {
    built("app", { "app.py": "print('hello')\n" });
    const code = exportModule(spec("app"));
    mkdirSync(join(dir, "host-app"));
    const tool = activateTool({ codebase: "app", plainFile: join(dir, "app.plain"), hostDir: dir }, code);
    expect(await call(tool, { name: "host", command: "sleep 30", from: "host", dir: "host-app" })).toContain("host is running");
    expect(runningLaunched("app")[0]?.dir).toBe(join(dir, "host-app"));
    await expect(call(tool, { name: "out", command: "sleep 30", from: "host", dir: ".." })).rejects.toThrow(/is outside/);
  }, 30_000);
});

describe("what the launch agent finds guidance in", () => {
  it("reads the project's AGENTS.md and its skills, once each", () => {
    writeFileSync(join(dir, "AGENTS.md"), "Launch with scripts/deploy.sh.\n");
    mkdirSync(join(dir, ".agents", "skills", "ship"), { recursive: true });
    writeFileSync(join(dir, ".agents", "skills", "ship", "SKILL.md"), "Then start scripts/start.sh with activate.\n");
    const notes = projectNotes([dir, dir]).join("\n");
    expect(notes).toContain("Launch with scripts/deploy.sh.");
    expect(notes).toContain("Then start scripts/start.sh with activate.");
    expect(notes.match(/Launch with scripts\/deploy\.sh\./g)).toHaveLength(1);
  });
});

describe("what the chat is told of a launch", () => {
  const launch = (over: Partial<Launch>): Launch => ({ id: "launch-2", codebase: "greet", moduleDir: "", plainFile: "", commit: "abcdef0123", short: "abcdef0", hostDir: "", cause: { chat: "c1" }, status: "launched", queuedAt: 0, ...over });

  it("says a launch it asked for that a newer one replaced came up only to be stopped, which one takes its place, and that it is told that one's end", () => {
    const next = launch({ id: "launch-3", commit: "1234567890", short: "1234567", cause: { pulse: "p4", title: "wave" } });
    const text = replacedNote(launch({ replacedBy: "launch-3" }), next);
    expect(text).toContain("The launch of greet at abcdef0 you asked for (launch-2) came up, but not for long: a newer launch of it, launch-3 at 1234567 after pulse p4 landed, takes its place and stops what it started.");
    expect(text).toContain("You are told where that one runs, or why it did not come up, once it ends.");
    expect(text).not.toContain("is launched");
  });

  it("says one superseded as it waited never started", () => {
    const text = replacedNote(launch({ status: "superseded", supersededBy: "launch-3" }), launch({ id: "launch-3", short: "1234567" }));
    expect(text).toContain("(launch-2) never started: a newer launch of it, launch-3 at 1234567, takes its place.");
  });

  it("says a launch that ended up where it runs", () => {
    expect(launchedNote(launch({ summary: "http://localhost:8001" }))).toContain("greet at abcdef0 is launched.\n\nhttp://localhost:8001");
  });
});

describe("what an earlier session left running", () => {
  /** A server a turri that has since ended started: its own process group, and turri's record of it. */
  function leftRunning(over: Partial<LaunchRecord> = {}): { pid: number; record: string } {
    const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    child.unref();
    // A turri that ended: a process that has exited.
    const ended = spawnSync("true");
    const record: LaunchRecord = { pid: child.pid!, pgid: child.pid!, name: "backend", moduleName: "app", command: "sleep 30", dir: join(dir, "dist", "app"), url: "http://127.0.0.1:8000", startedAt: Date.now(), turri: ended.pid!, ...over };
    const file = join(dir, ".turri", "launch", "running", `${child.pid}.json`);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, JSON.stringify(record));
    return { pid: child.pid!, record: file };
  }
  const isAlive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const left: number[] = [];
  afterEach(() => {
    for (const pid of left.splice(0)) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        /* gone */
      }
    }
  });

  it("is stopped - its record taken out - when the turri that started it has ended", async () => {
    const { pid, record } = leftRunning();
    left.push(pid);
    const stopped = await stopLeftBehind(dir, "app");
    expect(stopped.map((each) => each.pid)).toEqual([pid]);
    expect(isAlive(pid)).toBe(false);
    expect(existsSync(record)).toBe(false);
  });

  it("is left alone when its turri still runs, when it is another codebase's, and when its pid is now another process's", async () => {
    const theirs = leftRunning({ turri: process.ppid });
    const other = leftRunning({ moduleName: "web" });
    // The pid given again since: the process there started long after the record says.
    const reused = leftRunning({ startedAt: Date.now() - 3_600_000 });
    left.push(theirs.pid, other.pid, reused.pid);
    expect(await stopLeftBehind(dir, "app")).toEqual([]);
    for (const each of [theirs, other, reused]) expect(isAlive(each.pid)).toBe(true);
    expect(existsSync(theirs.record)).toBe(true);
    expect(existsSync(other.record)).toBe(true);
    // Not turri's: its record goes, the process stays.
    expect(existsSync(reused.record)).toBe(false);
  });

  it("is stopped before the codebase's next launch, which says so in its summary - and what this session starts is recorded until it ends", async () => {
    built("app", { "app.py": "one\n" });
    spec("app");
    const { pid } = leftRunning();
    left.push(pid);
    let recorded: string[] = [];
    const { launches } = track(async (launch, exported) => {
      const started = await startLaunched({ name: "backend", command: "sleep 30", dir: exported.dir, moduleName: launch.codebase, logDir: join(dir, ".turri", "launch") });
      recorded = readdirSync(join(dir, ".turri", "launch", "running"));
      return { launched: started.ok, summary: "backend runs." };
    });
    const { launch } = launches.request({ plainFile: join(dir, "app.plain"), cause: {} });
    const ended = await launches.done(launch.id);
    expect(isAlive(pid)).toBe(false);
    expect(ended.summary).toBe(`Stopped what an earlier turri session left running of app: backend (pid ${pid}, http://127.0.0.1:8000).\nbackend runs.`);
    expect(recorded).toEqual([`${runningLaunched("app")[0]!.pid}.json`]);
    await stopLaunched();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(readdirSync(join(dir, ".turri", "launch", "running"))).toEqual([]);
  }, 30_000);
});
