import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { booleanOption, configuredModel, overrideConfig, projectModels, readProjectConfig } from "@turri-dev/core/config";
import { moduleStates } from "@turri-dev/core/commands";
import { configKeyOptions, parseArgs } from "../src/cli-options.ts";
import { headlessOptions } from "../src/loop-cli.ts";
const TURRI = resolve("bin/turri.mjs");
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "turri-report-"));
});
afterEach(() => {
  overrideConfig({});
  rmSync(dir, { recursive: true, force: true });
});

/** A functional spec's func-id: its first two words - "App one, changed." is still `app-one`. */
const idOf = (text: string) => text.toLowerCase().replace(/[^a-z0-9 ]/g, "").split(" ").slice(0, 2).join("-");

/** A spec of its own functional specs, requiring another or not. */
function spec(name: string, specs: string[], requires?: string): string {
  const file = join(dir, `${name}.plain`);
  writeFileSync(
    file,
    `${requires !== undefined ? `---\nrequires:\n  - ${requires}\n---\n\n` : ""}***implementation reqs***\n\n- Python.\n\n***functional specs***\n\n${specs.map((text) => `# ${idOf(text)}\n${text}`).join("\n\n")}\n`,
  );
  return file;
}
describe("each codebase's state", () => {
  it("is complete only with nothing left to regenerate, and says why when it is not", () => {
    const base = { plainFile: "x.plain", scheduled: [] };
    expect(
      moduleStates([
        { ...base, module: "a", code: null, conformance: undefined },
        { ...base, module: "b", code: null, conformance: { fresh: false, add: [], patch: [], again: [], delete: [], mechanical: true } },
        { ...base, module: "c", code: null, conformance: null, why: "pulse 1 did not land" },
        { ...base, module: "d", code: null, conformance: null, startOver: { requires: ["base"], codebases: ["d"] } },
        { ...base, module: "e", code: null, conformance: null, running: { jobId: "j", title: "t" } },
      ]),
    ).toEqual([
      { module: "a", state: "complete" },
      { module: "b", state: "incomplete", why: "its conformance tests are not written for what is built" },
      { module: "c", state: "halted", why: "pulse 1 did not land" },
      { module: "d", state: "start_over_needed", why: "built without base, which it now requires: run with --start-over" },
      { module: "e", state: "running" },
    ]);
  });
});

describe("a headless run's options", () => {
  const exits = () =>
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);

  it("refuses an option the command does not take, rather than eating the word after it", () => {
    const exit = exits();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => parseArgs(["app.plain", "--to", "3"], [], "usage")).toThrow("exit 1");
    expect(error.mock.calls.at(-1)?.[0]).toContain("No such option: --to");
    expect(parseArgs(["app.plain", "--report=r.json", "--coding-model", "p/m"], [], "usage", ["--report"])).toEqual({ positional: ["app.plain"], options: { report: "r.json", model: "p/m" } });
    // An option where a value should be is not taken as the value: the run would lose it.
    expect(() => parseArgs(["app.plain", "--report", "--start-over"], ["--start-over"], "usage", ["--report"])).toThrow("exit 1");
    expect(error.mock.calls.at(-1)?.[0]).toContain("--report needs a value, not the option --start-over");
    expect(() => parseArgs(["app.plain", "--report"], [], "usage", ["--report"])).toThrow("exit 1");
    expect(parseArgs(["--report=--odd.json"], [], "usage", ["--report"]).options).toEqual({ report: "--odd.json" });
    exit.mockRestore();
    error.mockRestore();
  });

  it("reads --harness-model, --coding-model, --judge-model and --review as the config's keys, the config's order kept", () => {
    writeFileSync(join(dir, "config.yaml"), "review: true\njudge-model: p/old\nmodels:\n  judge: { model: p/own-judge, thinking: high }\nunittests-script: run_unittests.sh\n");
    const options = { "harness-model": "p/harness", model: "p/coding:low", "judge-model": "p/judge", review: "false", report: "r.json" };
    expect(headlessOptions(options)).toEqual({ report: "r.json" });
    const config = readProjectConfig(dir);
    expect(config).toMatchObject({
      harnessModel: { model: "p/harness" },
      codingModel: { model: "p/coding", thinking: "low" },
      judgeModel: { model: "p/judge" },
      review: false,
      unittestsScript: "run_unittests.sh",
    });
    // A models: entry wins over judge-model, as it does when the file names both.
    expect(configuredModel(config, "models.judge")).toEqual({ model: "p/own-judge", thinking: "high" });
    expect(projectModels(config)).toMatchObject({ harness: { model: "p/harness" }, coding: { model: "p/coding", thinking: "low" } });
  });

  it("takes the config's own values, and only those", () => {
    expect(["true", "false", "off"].map(booleanOption)).toEqual([true, false, undefined]);
  });

  it("takes no --conformance-tests: what is tested is the functional specs with scenarios", () => {
    const exit = exits();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => parseArgs(["app.plain", "--conformance-tests", "all"], [], "usage", ["--report"])).toThrow("exit 1");
    expect(error.mock.calls.at(-1)?.[0]).toContain("No such option: --conformance-tests");
    exit.mockRestore();
    error.mockRestore();
  });

  it("reads --mutation-testing as the config's mutation-testing, over what the file says, and refuses anything but true or false", () => {
    writeFileSync(join(dir, "config.turri.yaml"), "mutation-testing: true\n");
    expect(readProjectConfig(dir).mutationTesting).toBe(true);
    configKeyOptions({ "mutation-testing": "false" }, { review: true });
    expect(readProjectConfig(dir).mutationTesting).toBe(false);
    const run = spawnSync(process.execPath, [TURRI, "regenerate", "app.plain", "--mutation-testing", "maybe"], { cwd: dir, encoding: "utf8" });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("--mutation-testing takes true or false, not maybe");
  });

  it("refuses a value it cannot read", () => {
    const exit = exits();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => headlessOptions({ review: "maybe" })).toThrow("exit 1");
    expect(() => headlessOptions({ report: undefined })).toThrow("exit 1");
    exit.mockRestore();
    error.mockRestore();
  });
});

describe("turri regenerate, unattended", () => {
  it("stops, with no terminal to ask, at a codebase it would have to start over - and reports why", () => {
    spec("base", ["Base one."]);
    const app = spec("app", ["App one."]);
    const code = join(dir, "plain_modules", "app", "code");
    mkdirSync(code, { recursive: true });
    writeFileSync(join(code, "main.py"), "print(1)\n");
    // A previously landed app, before base became its requirement.
    writeFileSync(join(code, ".turri.json"), JSON.stringify({ "implementation reqs": [{ markdown: "- Python." }], "functional specs": [{ id: "app-one", markdown: "App one.", linked_resources: [] }] }));
    const git = (...args: string[]) => execFileSync("git", ["--git-dir=.plaingit", "--work-tree=.", ...args], { cwd: join(dir, "plain_modules", "app"), stdio: "pipe" });
    git("init"); git("add", "code"); git("-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-m", "app pulse 1 landed");
    // Now it requires base, which its code was not built on.
    spec("app", ["App one."], "base");

    // The whole command a benchmark runs: every model and review given on the command line.
    const command = [
      "regenerate", "app.plain", "--harness-model", "nowhere/big", "--coding-model", "nowhere/small",
      "--review", "false", "--judge-model", "nowhere/judge",
      "--build-dir", "out/build", "--report", "out/report.json",
    ];
    const run = spawnSync(process.execPath, [TURRI, ...command], {
      cwd: dir,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("--start-over");
    const written = JSON.parse(readFileSync(join(dir, "out", "report.json"), "utf8"));
    // --coding-model reaches the command as --model: cli.ts reads the one as the other.
    expect(written.command).toEqual(command.map((arg) => (arg === "--coding-model" ? "--model" : arg)));
    expect(written.models).toMatchObject({
      harness: { model: "nowhere/big", thinking: "medium" },
      coding: { model: "nowhere/small", thinking: "low" },
      judge: { model: "nowhere/judge", thinking: "medium" },
    });
    expect(written).toMatchObject({ review: false });
    expect(written).not.toHaveProperty("conformance_tests");
    expect(written.build_dir_export).toMatchObject({ exported: true, module: "app" });
    expect(readdirSync(join(dir, "out", "build"))).toEqual(["main.py"]);
    expect(written.outcome).toMatchObject({ status: "incomplete", exit_code: 1, modules: [{ module: "app", state: "start_over_needed" }] });
    expect(written.functionalities.total).toEqual({ specified: 2, with_scenarios: 0, completed: 1, conformance_tested: 0 });
    expect(written.pulses.counts.total).toBe(0);
  });

  it("refuses a --build-dir that holds the project", () => {
    const app = spec("app", ["App one."]);
    const run = spawnSync(process.execPath, [TURRI, "regenerate", app, "--model", "nowhere/no-model", "--build-dir", dir], { cwd: dir, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: 60_000 });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("holds the project");
    expect(existsSync(join(dir, "app.plain"))).toBe(true);
  });
});
