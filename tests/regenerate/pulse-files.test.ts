import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { debugMode } from "../../src/config.ts";
import { tidyCaches } from "../../src/regenerate/agent-env.ts";
import { debugDir, startDebugLog } from "../../src/regenerate/debug-log.ts";
import { diagnosisPrompt } from "../../src/regenerate/diagnose.ts";
import { createJobRegistry } from "../../src/regenerate/jobs.ts";
import { keepOutput } from "../../src/regenerate/testing.ts";

let project: string;
const modules = () => join(project, "plain_modules");
const moduleDir = (name: string) => join(modules(), name);
const scratch = () => join(modules(), ".turri");
const files = (dir: string) => (existsSync(dir) ? readdirSync(dir) : []);

/** A pi session with nothing to say: enough for a debug log to be started for it. */
const quietSession = { model: { provider: "anthropic", id: "claude-sonnet-5" }, systemPrompt: "You are the coding agent.", subscribe: () => () => {} };

/** A module of the project with code, and dependencies installed in it. */
function moduleWithDependencies(name: string): string {
  mkdirSync(join(moduleDir(name), "code", "node_modules", "left-pad"), { recursive: true });
  writeFileSync(join(moduleDir(name), "code", "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");
  mkdirSync(join(moduleDir(name), "code", ".venv"), { recursive: true });
  return moduleDir(name);
}

/** A pulse of `module`'s, with `chain` its lanes, that writes what a pulse writes for a person: its agent's log, an output, a temporary file. */
async function pulse(module: string, chain: string[]) {
  const registry = createJobRegistry();
  const job = registry.start({
    kind: "regenerate",
    summary: `${module}.plain`,
    module,
    pulse: 1,
    lanes: chain,
    run: async () => {
      startDebugLog(quietSession, { cwd: join(moduleDir(module), "code"), label: `${module} 1 coding agent` });
      keepOutput(moduleDir(module), "unit tests", "1 failed\n".repeat(2000));
      mkdirSync(join(scratch(), "tmp", module), { recursive: true });
      writeFileSync(join(scratch(), "tmp", module, "build.o"), "");
      return { report: "done", details: { passed: true, landed: true } };
    },
  });
  return registry.wait(job.id);
}

beforeEach(() => {
  project = realpathSync(mkdtempSync(join(tmpdir(), "turri-pulse-files-")));
  delete process.env.TURRI_DEBUG;
});
afterEach(() => {
  delete process.env.TURRI_DEBUG;
  rmSync(project, { recursive: true, force: true });
});

describe("what a pulse writes for a person", () => {
  it("goes as the pulse ends: its log, its agents' logs, its outputs and its temporary folder - and nothing names its log", async () => {
    const app = moduleWithDependencies("app");
    const finished = await pulse("app", [app]);

    expect(finished.status).toBe("succeeded");
    expect(files(join(project, ".turri", "jobs"))).toEqual([]);
    expect(files(debugDir(project)).filter((name) => name.endsWith(".log"))).toEqual([]);
    expect(files(join(scratch(), "logs"))).toEqual([]);
    expect(existsSync(join(scratch(), "tmp", "app"))).toBe(false);
    expect(finished.logFile).toBeUndefined();
    // The pulse's own module keeps what it installed: its next pulse works in it.
    expect(existsSync(join(app, "code", "node_modules", "left-pad"))).toBe(true);
  });

  it("is all kept in debug mode", async () => {
    process.env.TURRI_DEBUG = "1";
    const finished = await pulse("app", [moduleWithDependencies("app"), moduleWithDependencies("base")]);

    expect(files(join(project, ".turri", "jobs"))).toHaveLength(1);
    expect(files(debugDir(project)).filter((name) => name.endsWith(".log"))).toHaveLength(1);
    expect(files(join(scratch(), "logs"))).toHaveLength(1);
    expect(existsSync(join(scratch(), "tmp", "app", "build.o"))).toBe(true);
    expect(finished.logFile).toBeDefined();
    expect(existsSync(join(moduleDir("base"), "code", "node_modules"))).toBe(true);
  });

  it("takes with it the dependencies installed in the modules below its own in the chain", async () => {
    const base = moduleWithDependencies("base");
    const app = moduleWithDependencies("app");
    await pulse("app", [app, base]);

    expect(existsSync(join(base, "code", "node_modules"))).toBe(false);
    expect(existsSync(join(base, "code", ".venv"))).toBe(false);
    expect(existsSync(join(app, "code", "node_modules"))).toBe(true);
  });

  it("leaves the chain alone when the pulse never started: another may be working in it", async () => {
    const base = moduleWithDependencies("base");
    const app = moduleWithDependencies("app");
    const other = moduleWithDependencies("other");
    const registry = createJobRegistry();
    let finish!: () => void;
    const started = new Promise<void>((begun) => {
      // `other` is built on `app`, which a pulse is working in: it waits for that pulse, and is stopped meanwhile.
      registry.start({
        kind: "regenerate",
        summary: "app.plain",
        module: "app",
        lanes: [app, base],
        run: () => {
          begun();
          return new Promise((done) => (finish = () => done({ report: "done" })));
        },
      });
    });
    const working = registry.list()[0]!;
    const waiting = registry.start({ kind: "regenerate", summary: "other.plain", module: "other", lanes: [other, app, base], run: async () => ({ report: "done" }) });
    registry.stop(waiting.id);
    await started;
    // It settles once the pulse ahead of it ends: had it cleared its chain, `app` - below `other` - would be bare.
    finish();
    await registry.wait(working.id);
    expect((await registry.wait(waiting.id)).status).toBe("stopped");
    expect(existsSync(join(app, "code", "node_modules"))).toBe(true);
  });
});

describe("an agent outside a pulse", () => {
  it("writes no log of its own outside debug mode", () => {
    mkdirSync(join(moduleDir("app"), "code"), { recursive: true });
    expect(startDebugLog(quietSession, { cwd: join(moduleDir("app"), "code"), label: "release agent" })).toBeUndefined();
    expect(existsSync(debugDir(project))).toBe(false);
  });
});

describe("the diagnosis of a pulse that failed", () => {
  const prompt = () => diagnosisPrompt({ job: { id: "j1", kind: "regenerate", summary: "app.plain" }, failures: ["tests failed"], projectDir: project, harnessDir: project });

  it("is told the logs go as the pulse ends, and to quote them - but not in debug mode, where they are kept", () => {
    expect(prompt()).toContain("never send");
    process.env.TURRI_DEBUG = "1";
    expect(prompt()).not.toContain("never send");
  });
});

describe("debug mode", () => {
  it("is off unless the project or this run says so - TURRI_DEBUG over debug:", () => {
    expect(debugMode(project)).toBe(false);
    writeFileSync(join(project, "config.turri.yaml"), "debug: true\n");
    expect(debugMode(project)).toBe(true);
    process.env.TURRI_DEBUG = "0";
    expect(debugMode(project)).toBe(false);
    rmSync(join(project, "config.turri.yaml"));
    process.env.TURRI_DEBUG = "1";
    expect(debugMode(project)).toBe(true);
  });
});

describe("the package caches", () => {
  /** A cache of `megabytes`, last written `daysAgo`. */
  const cache = (path: string, megabytes: number, daysAgo: number) => {
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "blob"), Buffer.alloc(megabytes * 1024 * 1024));
    const when = new Date(Date.now() - daysAgo * 86_400_000);
    utimesSync(join(path, "blob"), when, when);
    utimesSync(path, when, when);
  };

  it("are held to cache-keep, the least recently written going first - an agent's home's caches with them", () => {
    cache(join(scratch(), "cache", "npm"), 2, 9);
    cache(join(scratch(), "home", "app", "Library", "Caches", "node-gyp"), 1, 5);
    cache(join(scratch(), "cache", "pip"), 1, 1);

    tidyCaches(scratch(), 2);

    expect(existsSync(join(scratch(), "cache", "npm"))).toBe(false);
    expect(existsSync(join(scratch(), "home", "app", "Library", "Caches", "node-gyp"))).toBe(true);
    expect(existsSync(join(scratch(), "cache", "pip"))).toBe(true);
  });

  it("count as written when anything inside them was, not when their own folder last changed", () => {
    cache(join(scratch(), "cache", "npm"), 2, 9);
    cache(join(scratch(), "cache", "pip"), 1, 1);
    // npm wrote deep inside its cache today: its own folder still says nine days ago.
    const today = new Date();
    utimesSync(join(scratch(), "cache", "npm", "blob"), today, today);
    utimesSync(join(scratch(), "cache", "npm"), new Date(Date.now() - 9 * 86_400_000), new Date(Date.now() - 9 * 86_400_000));

    tidyCaches(scratch(), 2);

    expect(existsSync(join(scratch(), "cache", "npm"))).toBe(true);
    expect(existsSync(join(scratch(), "cache", "pip"))).toBe(false);
  });

  it("go whole even when read-only, as Go's module cache is - and what could not go is not counted as gone", () => {
    const module = join(scratch(), "cache", "go-mod", "example.com", "lib@v1.0.0");
    cache(join(scratch(), "cache", "go-mod"), 2, 9);
    mkdirSync(module, { recursive: true });
    writeFileSync(join(module, "lib.go"), "package lib\n");
    chmodSync(module, 0o555);
    chmodSync(join(scratch(), "cache", "go-mod", "example.com"), 0o555);
    const old = new Date(Date.now() - 9 * 86_400_000);
    for (const path of [join(module, "lib.go"), module, join(scratch(), "cache", "go-mod", "example.com"), join(scratch(), "cache", "go-mod", "blob"), join(scratch(), "cache", "go-mod")]) utimesSync(path, old, old);
    cache(join(scratch(), "cache", "npm"), 1, 1);

    tidyCaches(scratch(), 2);

    expect(existsSync(join(scratch(), "cache", "go-mod"))).toBe(false);
    expect(existsSync(join(scratch(), "cache", "npm"))).toBe(true);
  });

  it("are all kept under cache-keep, and none at 0", () => {
    cache(join(scratch(), "cache", "npm"), 1, 3);
    tidyCaches(scratch(), 1024);
    expect(existsSync(join(scratch(), "cache", "npm"))).toBe(true);
    tidyCaches(scratch(), 0);
    expect(files(join(scratch(), "cache"))).toEqual([]);
  });
});
