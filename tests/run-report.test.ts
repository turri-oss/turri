import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testPlainFile } from "./test-plain.ts";
import { overrideConfig, projectModels, readProjectConfig, booleanOption, roleModel } from "../src/config.ts";
import { configKeyOptions, parseArgs } from "../src/cli-options.ts";
import { headlessOptions, moduleStates } from "../src/loop-cli.ts";
import { reportModelEvent, reportUsage } from "../src/regenerate/activity.ts";
import { createJobRegistry } from "../src/regenerate/jobs.ts";
import { recordHistory } from "../src/regenerate/lineage.ts";
import { conformanceDirFor } from "../src/regenerate/conformance.ts";
import { chainSpec, functionalityCompletion } from "../src/regenerate/loop.ts";
import { modulesRoot } from "../src/regenerate/paths.ts";
import { writeCodeRecord, writeTestsRecord } from "../src/regenerate/records.ts";
import { resolveRequiresChain } from "../src/regenerate/requires.ts";
import { startRunReport, writeAtomically, type UsageTotals } from "../src/run-report.ts";

const TURRI = resolve("bin/turri.mjs");
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "turri-report-"));
});
afterEach(() => {
  overrideConfig({});
  rmSync(dir, { recursive: true, force: true });
});

const spent = (input: number, output: number, cost: number) => ({ input, output, cacheRead: input * 10, cacheWrite: input * 2, cost });

/** A report that is never written as the process exits: the test asks for it. */
function report(file = join(dir, "report.json")) {
  return startRunReport({
    file,
    command: ["regenerate", "app.plain"],
    specFile: join(dir, "app.plain"),
    projectDir: dir,
    models: { harness: { model: "p/big", thinking: "medium" }, coding: { model: "p/small", thinking: "low" }, judge: { model: "p/big", thinking: "medium" } },
    onExit: false,
  });
}

describe("the run report's usage", () => {
  it("adds up to the pulses' own usage - what their lines print - and the calls made outside any pulse", async () => {
    const reporter = report();
    const registry = createJobRegistry();
    reporter.attach({ jobs: () => registry.list() });
    // Two pulses, their agents' calls reported as pi.ts reports them: the job's usage, and the event beside it.
    const pulse = (kind: string, calls: Array<ReturnType<typeof spent>>, landed: boolean) =>
      registry.start({
        kind,
        summary: kind,
        module: "app",
        run: async () => {
          reportModelEvent({ kind: "turn", model: "p/small:low", role: "coding", label: "app coding agent" });
          for (const usage of calls) {
            reportUsage(usage);
            reportModelEvent({ kind: "call", model: "p/small:low", role: "coding", label: "app coding agent", usage, ms: 1500 });
          }
          return { report: "done", details: { landed } };
        },
      });
    const code = pulse("regenerate", [spent(100, 20, 0.5), spent(200, 30, 0.25)], true);
    const tests = pulse("conformance", [spent(50, 5, 0.125)], false);
    await registry.wait(code.id);
    await registry.wait(tests.id);
    // The planner, outside any pulse.
    reportModelEvent({ kind: "turn", model: "p/big:medium", role: "planner" });
    reportModelEvent({ kind: "call", model: "p/big:medium", role: "planner", usage: spent(1000, 100, 2), ms: 4000 });

    const built = reporter.build() as {
      usage: Record<"total" | "in_pulses" | "outside_pulses", UsageTotals> & Record<"by_model" | "by_role" | "by_pulse_kind", Record<string, UsageTotals>>;
      pulses: { counts: Record<string, number>; list: Array<{ kind: string; landed: boolean; usage: UsageTotals }> };
    };
    const jobTokens = registry.list().reduce((sum, job) => sum + job.usage.input, 0);
    expect(built.usage.in_pulses.input_tokens).toBe(jobTokens);
    expect(built.usage.in_pulses).toMatchObject({ input_tokens: 350, output_tokens: 55, cache_read_tokens: 3500, cache_write_tokens: 700, cost_usd: 0.875, llm_calls: 3, agent_turns: 2, model_seconds: 4.5 });
    expect(built.usage.outside_pulses).toMatchObject({ input_tokens: 1000, output_tokens: 100, cost_usd: 2, llm_calls: 1, agent_turns: 1, model_seconds: 4 });
    expect(built.usage.total).toMatchObject({ input_tokens: 1350, output_tokens: 155, cost_usd: 2.875, llm_calls: 4, agent_turns: 3 });
    expect(built.usage.by_model["p/small:low"]).toMatchObject({ input_tokens: 350, llm_calls: 3 });
    expect(built.usage.by_role.planner).toMatchObject({ input_tokens: 1000, cost_usd: 2 });
    expect(built.usage.by_pulse_kind.code).toMatchObject({ input_tokens: 300, llm_calls: 2, agent_turns: 1 });
    expect(built.usage.by_pulse_kind.conformance).toMatchObject({ input_tokens: 50, llm_calls: 1 });
    expect(built.pulses.counts).toMatchObject({ total: 2, landed: 1, failed: 0, rolled_back: 1, running: 0 });
    expect(built.pulses.list.map((one) => [one.kind, one.landed, one.usage.input_tokens])).toEqual([
      ["code", true, 300],
      ["conformance", false, 50],
    ]);
  });
});

describe("the run report's time to first regeneration", () => {
  it("is how long after the run's start its first code pulse started, and its first landed - nothing before", async () => {
    const reporter = report();
    const registry = createJobRegistry();
    reporter.attach({ jobs: () => registry.list() });
    const before = reporter.build() as { pulses: Record<string, unknown> };
    expect(before.pulses).toMatchObject({ first_started_seconds: null, first_landed_seconds: null });

    const code = registry.start({ kind: "regenerate", summary: "the first spec", module: "app", run: async () => ({ report: "done", details: { landed: true } }) });
    await registry.wait(code.id);
    const after = reporter.build() as { duration_seconds: number; pulses: { first_started_seconds: number; first_landed_seconds: number } };
    expect(after.pulses.first_started_seconds).toBeGreaterThanOrEqual(0);
    expect(after.pulses.first_landed_seconds).toBeGreaterThanOrEqual(after.pulses.first_started_seconds);
    expect(after.pulses.first_landed_seconds).toBeLessThanOrEqual(after.duration_seconds);
  });
});

describe("the run report's spec gaps", () => {
  it("lists each gap a pulse's agents met, with its pulse and whether that pulse landed", async () => {
    const reporter = report();
    const registry = createJobRegistry();
    reporter.attach({ jobs: () => registry.list() });
    const pulse = (pulse: number, landed: boolean, specGaps?: Array<{ question: string; assumption: string }>) =>
      registry.start({ kind: "regenerate", summary: "app", module: "app", pulse, run: async () => ({ report: "done", details: { landed, ...(specGaps !== undefined ? { specGaps } : {}) } }) });
    const first = pulse(1, true, [{ question: "Are names case-sensitive?", assumption: "Names are case-sensitive" }]);
    const quiet = pulse(2, true);
    const second = pulse(3, false, [{ question: "What happens to an archived contact?", assumption: "It is left as synced" }]);
    for (const job of [first, quiet, second]) await registry.wait(job.id);

    expect((reporter.build() as { spec_gaps: unknown }).spec_gaps).toEqual([
      { module: "app", pulse: 1, pulse_id: first.id, landed: true, question: "Are names case-sensitive?", assumption: "Names are case-sensitive" },
      { module: "app", pulse: 3, pulse_id: second.id, landed: false, question: "What happens to an archived contact?", assumption: "It is left as synced" },
    ]);
  });

  it("is an empty list when no agent met one", () => {
    expect((report().build() as { spec_gaps: unknown }).spec_gaps).toEqual([]);
  });
});

describe("the run report's turn incidents", () => {
  it("lists each provider failure waited out and each turn turri stopped, and counts them in the usage", () => {
    const reporter = report();
    reportModelEvent({ kind: "provider_retry", model: "p/small:low", role: "coding", error: "529 overloaded", attempt: 1, of: 6, waitMs: 15000 });
    reportModelEvent({ kind: "stopped", model: "p/small:low", role: "conformance explorer", reason: "10 submit_exploration calls failed in a row" });
    const built = reporter.build() as { turn_incidents: unknown; usage: { total: UsageTotals } };
    expect(built.turn_incidents).toEqual([
      { kind: "provider_retry", pulse_id: null, role: "coding", model: "p/small:low", error: "529 overloaded", attempt: 1, of: 6, wait_seconds: 15 },
      { kind: "stopped", pulse_id: null, role: "conformance explorer", model: "p/small:low", reason: "10 submit_exploration calls failed in a row" },
    ]);
    expect(built.usage.total).toMatchObject({ provider_retries: 1, turns_stopped: 1, compactions: 0 });
  });
});

describe("how the run report says the run ended", () => {
  it("is running until the run ends, then what the run decided - unless a crash came after", () => {
    const reporter = report();
    expect((reporter.build() as { outcome: { status: string } }).outcome.status).toBe("running");
    reporter.end("incomplete", "app needs a start over");
    expect((reporter.build(1) as { outcome: unknown }).outcome).toMatchObject({ status: "incomplete", exit_code: 1, error: "app needs a start over" });
    reporter.crashed(new Error("the disk is full"));
    expect((reporter.build(1) as { outcome: unknown }).outcome).toMatchObject({ status: "crashed", error: "the disk is full" });
  });

  it("calls an exit on a signal's code, the run not ended, interrupted", () => {
    expect((report().build(143) as { outcome: unknown }).outcome).toMatchObject({ status: "interrupted", signal: "SIGTERM", exit_code: 143 });
    expect((report().build(130) as { outcome: unknown }).outcome).toMatchObject({ status: "interrupted", signal: "SIGINT" });
  });

  it("is written as a process stopped by SIGTERM exits, the way turri's own handler exits", async () => {
    const file = join(dir, "out", "report.json");
    const child = join(dir, "child.ts");
    writeFileSync(
      child,
      [
        `import { startRunReport } from ${JSON.stringify(resolve("src/run-report.ts"))};`,
        `startRunReport({ file: ${JSON.stringify(file)}, command: ["regenerate"], specFile: "app.plain", projectDir: ${JSON.stringify(dir)}, models: { harness: {}, coding: {}, judge: {} } });`,
        `process.on("SIGTERM", () => process.exit(143));`,
        `console.log("ready");`,
        `setInterval(() => {}, 1000);`,
      ].join("\n"),
    );
    const proc = spawn(process.execPath, [child], { stdio: ["ignore", "pipe", "inherit"] });
    await new Promise<void>((done) => proc.stdout.once("data", () => done()));
    // Written as it started: a run killed outright still leaves one.
    expect(JSON.parse(readFileSync(file, "utf8")).outcome.status).toBe("running");
    const code = await new Promise<number | null>((done) => {
      proc.once("exit", (exit) => done(exit));
      proc.kill("SIGTERM");
    });
    expect(code).toBe(143);
    const written = JSON.parse(readFileSync(file, "utf8"));
    expect(written.outcome).toMatchObject({ status: "interrupted", signal: "SIGTERM", exit_code: 143 });
    expect(written.finished_at).not.toBeNull();
    expect(written.schema_version).toBe(2);
  });
});

describe("writing the run report", () => {
  it("replaces the file whole, leaving nothing beside it", () => {
    const file = join(dir, "deep", "report.json");
    writeAtomically(file, "{\"a\":1}\n");
    writeAtomically(file, "{\"a\":2}\n");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ a: 2 });
    expect(readdirSync(join(dir, "deep"))).toEqual(["report.json"]);
  });
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

/** A functional spec as a record has it. */
const item = (text: string, extra: object = {}) => ({ id: idOf(text), markdown: text, ...extra });

describe("the functional specs completed", () => {
  it("counts each module's in the furthest-built codebase - what its record has as the spec has it now - and those with scenarios, which are tested", () => {
    spec("base", ["Base one.", "Base two."]);
    // app's first has a scenario: it is the one tested.
    mkdirSync(join(dir, "tests", "app"), { recursive: true });
    writeFileSync(join(dir, "tests", "app", "app-one.plain"), testPlainFile("app", "app-one", { acceptance: ["# works\nIt works."] }));
    const app = spec("app", ["App one.", "App two.", "App three."], "base");
    const chain = resolveRequiresChain(app, [], undefined, { allowNoFunctionalities: true });
    // app's codebase: built on all of base, and its own first two - the third not landed yet.
    const tree = chainSpec(chain).tree;
    const own = tree["functional specs"] as unknown[];
    writeCodeRecord(chain[1]!.buildDir, { ...tree, "functional specs": own.slice(0, 2) });
    mkdirSync(join(chain[1]!.buildDir, "src"), { recursive: true });
    // Conformance tests written for app's first.
    writeTestsRecord(join(dir, "plain_modules", "app", "tests"), { "functional specs": [item("App one.", { acceptance_tests: [{ id: "works", text: "It works." }] })] });

    const [counted] = functionalityCompletion(app);
    expect(counted!.codebase).toBe(chain[1]!.buildDir);
    expect(counted!.modules).toEqual([
      { module: "base", specified: 2, withScenarios: 0, completed: 2, conformanceTested: 0, tested: [], incomplete: [] },
      { module: "app", specified: 3, withScenarios: 1, completed: 2, conformanceTested: 1, tested: ["app-one"], incomplete: ["app-three"] },
    ]);
    // Its scenario changed: its tests are written for an earlier one, and it is not counted as tested.
    writeFileSync(join(dir, "tests", "app", "app-one.plain"), testPlainFile("app", "app-one", { acceptance: ["# works\nIt works well."] }));
    expect(functionalityCompletion(app)[0]!.modules[1]).toMatchObject({ withScenarios: 1, conformanceTested: 0, tested: [] });

    // base's second spec says something else now: what app's code has of it is not what the spec says.
    spec("base", ["Base one.", "Base two, changed."]);
    expect(functionalityCompletion(app)[0]!.modules[0]).toMatchObject({ completed: 1, incomplete: ["base-two"] });
  });

  it("counts nothing completed where nothing is built", () => {
    const app = spec("app", ["App one."]);
    expect(functionalityCompletion(app)[0]!.modules).toEqual([{ module: "app", specified: 1, withScenarios: 0, completed: 0, conformanceTested: 0, tested: [], incomplete: ["app-one"] }]);
  });
});

/** The conformance tests recorded as written for these of a module's functional specs, where the loop keeps them. */
function testsFor(module: string, specs: Array<{ id: string; markdown: string }>, required: Array<{ id: string; markdown: string; module: string }> = []): void {
  writeTestsRecord(conformanceDirFor(module, modulesRoot(dir)), { "functional specs": specs, ...(required.length > 0 ? { "required functional specs": required } : {}) });
}

/** Each module's conformance-tested functional specs, by func-id - checked against its count on the way. */
function testedOf(app: string): Record<string, string[]> {
  const [counted] = functionalityCompletion(app);
  for (const module of counted!.modules) expect(module.conformanceTested).toBe(module.tested.length);
  return Object.fromEntries(counted!.modules.map((module) => [module.module, module.tested]));
}

describe("the functional specs conformance tested", () => {
  it("lists exactly the completed ones its conformance tests are written for, in the spec's order", () => {
    const app = spec("app", ["App one.", "App two.", "App three.", "App four."]);
    const [entry] = resolveRequiresChain(app, [], undefined, { allowNoFunctionalities: true });
    writeCodeRecord(entry!.buildDir, chainSpec([entry!]).tree);
    // Recorded out of order: the spec's order is what is listed.
    testsFor("app", [
      item("App three."),
      item("App one."),
    ]);
    expect(testedOf(app)).toEqual({ app: ["app-one", "app-three"] });
  });

  it("leaves out a functional spec that is not completed - not built yet, changed since, or marked to regenerate again", () => {
    const app = spec("app", ["App one.", "App two.", "App three."]);
    const [entry] = resolveRequiresChain(app, [], undefined, { allowNoFunctionalities: true });
    const tree = chainSpec([entry!]).tree;
    const own = tree["functional specs"] as Array<{ markdown: string }>;
    // The first built, the second marked to regenerate again, the third not built.
    writeCodeRecord(entry!.buildDir, { ...tree, "functional specs": [own[0]!, { ...own[1]!, regenerate_again: true }] });
    testsFor("app", [
      item("App one."),
      item("App two."),
      item("App three."),
    ]);
    expect(testedOf(app)).toEqual({ app: ["app-one"] });

    // The first changed since it was built, its conformance tests already written for the new text.
    spec("app", ["App one, changed.", "App two.", "App three."]);
    testsFor("app", [
      item("App one, changed."),
      item("App two."),
      item("App three."),
    ]);
    expect(testedOf(app)).toEqual({ app: [] });
  });

  it("leaves out a completed functional spec whose conformance tests were written for other text", () => {
    const app = spec("app", ["App one.", "App two."]);
    const [entry] = resolveRequiresChain(app, [], undefined, { allowNoFunctionalities: true });
    writeCodeRecord(entry!.buildDir, chainSpec([entry!]).tree);
    testsFor("app", [
      item("App one."),
      item("App two, as it was."),
    ]);
    expect(testedOf(app)).toEqual({ app: ["app-one"] });
  });

  it("is empty for a module with no conformance record", () => {
    const app = spec("app", ["App one.", "App two."]);
    const [entry] = resolveRequiresChain(app, [], undefined, { allowNoFunctionalities: true });
    writeCodeRecord(entry!.buildDir, chainSpec([entry!]).tree);
    expect(existsSync(conformanceDirFor("app", modulesRoot(dir)))).toBe(false);
    expect(testedOf(app)).toEqual({ app: [] });
  });

  it("leaves out a functional spec regenerated again until its conformance tests are written again for the new code", () => {
    const app = spec("app", ["App one.", "App two."]);
    const [entry] = resolveRequiresChain(app, [], undefined, { allowNoFunctionalities: true });
    writeCodeRecord(entry!.buildDir, chainSpec([entry!]).tree);
    testsFor("app", [
      item("App one."),
      item("App two.", { regenerate_again: true }),
    ]);
    expect(testedOf(app)).toEqual({ app: ["app-one"] });
  });

  it("reads each module's from the tests record of the codebase that holds the chain, by module", () => {
    spec("base", ["Base one.", "Base two."]);
    const app = spec("app", ["App one.", "App two."], "base");
    const chain = resolveRequiresChain(app, [], undefined, { allowNoFunctionalities: true });
    writeCodeRecord(chain[1]!.buildDir, chainSpec(chain).tree);
    // base's own codebase, left behind: what its tests record says no longer counts.
    testsFor("base", [item("Base one.")]);
    // app's suite holds base's second too: it is base's, not app's.
    testsFor("app", [item("App two.")], [item("Base two.", { module: "base" })]);
    expect(testedOf(app)).toEqual({ base: ["base-two"], app: ["app-two"] });
  });

  it("is empty for every module where nothing is built", () => {
    spec("base", ["Base one."]);
    const app = spec("app", ["App one."], "base");
    testsFor("base", [item("Base one.")]);
    testsFor("app", [item("App one.")]);
    expect(testedOf(app)).toEqual({ base: [], app: [] });
  });
});

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
    expect(roleModel(config, "judge")).toEqual({ model: "p/own-judge", thinking: "high" });
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
    writeCodeRecord(code, chainSpec(resolveRequiresChain(app, [], undefined, { allowNoFunctionalities: true })).tree);
    recordHistory(code, "app pulse 1 landed");
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
