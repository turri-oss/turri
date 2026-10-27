import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The judge, stubbed to give the verdicts queued in `verdicts`, one per turn. */
const verdicts: Array<Record<string, unknown>> = [];
const prompts: string[] = [];
type StubSession = { tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }>; task?: string };
vi.mock("../../src/pi.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/pi.ts")>();
  return {
    ...actual,
    createExecutor: async (opts: { customTools: StubSession["tools"]; task?: string }) => ({ tools: opts.customTools, task: opts.task, dispose() {} }),
    ask: async (session: StubSession, prompt: string) => {
      // Its task is its instructions: the turn that begins it reads as the task.
      prompts.push(prompt === actual.BEGIN ? (session.task ?? prompt) : prompt);
      const next = verdicts.shift();
      if (next !== undefined) await session.tools.find((tool) => tool.name === "submit_verdict")!.execute("id", next);
      return "Done.";
    },
  };
});

const { conflictKey, judgeFailure, specConflictProblem, unfoundedCodeVerdict, unfoundedEvidence } = await import("../../src/regenerate/conformance-agents.ts");

describe("a spec conflict", () => {
  // Module app requires base: its codebase, and its conformance suite, hold base's functionalities too.
  const app = (funcId: string) => ({ module: "app", funcId });
  const base = (funcId: string) => ({ module: "base", funcId });
  const scope = { functionalities: [base("store"), base("load"), app("log-in"), app("show-feed"), app("post")], tested: app("post") };

  it("names exactly two functionalities, each by its module and an id that exists there", () => {
    expect(specConflictProblem(undefined, scope)).toMatch(/exactly two functionalities/);
    expect(specConflictProblem([app("post")], scope)).toMatch(/exactly two functionalities/);
    expect(specConflictProblem([app("post"), app("post")], scope)).toMatch(/exactly two functionalities/);
    expect(specConflictProblem([app("log-in"), app("show-feed"), app("post")], scope)).toMatch(/exactly two functionalities/);
    expect(specConflictProblem([app("post"), app("nope")], scope)).toMatch(/There is no functionality app nope/);
    // A func-id is unique in its module only: base's store is not other's.
    expect(specConflictProblem([app("post"), { module: "other", funcId: "store" }], scope)).toMatch(/There is no functionality other store/);
    expect(specConflictProblem([app("show-feed"), app("post")], scope)).toBeUndefined();
  });

  it("can cross modules: this module's functionality and one of a module it requires", () => {
    expect(specConflictProblem([base("store"), app("post")], scope)).toBeUndefined();
  });

  it("raised while testing a functionality, must include that one - two earlier ones were for their own run", () => {
    expect(specConflictProblem([app("log-in"), app("show-feed")], scope)).toMatch(/Only a conflict with functionality app post/);
    expect(specConflictProblem([base("store"), base("load")], scope)).toMatch(/Only a conflict with functionality app post/);
    // A spec diff's run tests no one functionality: any two will do.
    expect(specConflictProblem([base("store"), app("show-feed")], { functionalities: scope.functionalities })).toBeUndefined();
  });

  it("is the same conflict however its two functionalities are named", () => {
    expect(conflictKey([app("post"), base("store")])).toBe(conflictKey([base("store"), app("post")]));
    expect(conflictKey([app("show-feed"), app("log-in")])).toBe("app log-in & app show-feed");
  });
});

describe("the judge", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "turri-judge-"));
    verdicts.length = 0;
    prompts.length = 0;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const judge = (tested?: string) =>
    judgeFailure({
      buildDir: dir,
      conformanceDir: dir,
      spec: { moduleName: "app", text: "***functional specs***\n\n# log-in\nOne.\n\n# show-feed\nTwo." },
      run: { command: "run_conformance_tests.sh", exitCode: 1, output: "FAILED", timeoutMs: 1000 },
      invocation: "python3 app.py",
      scope: { functionalities: ["log-in", "show-feed", "post"].map((funcId) => ({ module: "app", funcId })), tested: tested && { module: "app", funcId: tested } },
      notes: "",
      label: "app post",
    });

  it("is asked again when its spec conflict cannot be raised, and told why", async () => {
    const at = (id: string) => ({ module: "app", id });
    verdicts.push({ culprit: "spec", functionalities: [at("log-in"), at("show-feed")], reason: "x" }, { culprit: "spec", functionalities: [at("show-feed"), at("post")], reason: "y" });
    expect(await judge("post")).toEqual({ culprit: "spec", functionalities: [{ module: "app", funcId: "show-feed" }, { module: "app", funcId: "post" }], reason: "y" });
    expect(prompts[1]).toContain("That spec conflict cannot be raised: Only a conflict with functionality app post");
  });

  it("falls back to the tests when it gives no conflict that can be raised", async () => {
    const one = { culprit: "spec", functionalities: [{ module: "app", id: "log-in" }], reason: "x" };
    verdicts.push(one, one, one);
    expect((await judge("post")).culprit).toBe("tests");
  });

  it("is told to prefer the tests when both could be wrong, and how a spec conflict counts", async () => {
    verdicts.push({ culprit: "tests", reason: "z" });
    await judge("post");
    expect(prompts[0]).toContain("When the code and the tests could both be what is wrong, choose tests.");
    expect(prompts[0]).toContain("One of them must be app post, the one under test");
    expect(prompts[0]).toContain("They can be in different modules");
    // What the spec leaves open is what the code has: never the code's to change.
    expect(prompts[0]).toContain("anything it leaves open - a name, coordinates, a version, a path");
    expect(prompts[0]).toContain("The tests follow it, and it is never\n  code");
    expect(prompts[0]).toContain("raised 3 times, for the same two functionalities");
  });
});

describe("an escalated verdict", () => {
  const opened = (path: string) => path === "code/tsconfig.json";

  it("rests on evidence the judge found itself - a file it opened, the testing script, not the run alone", () => {
    expect(unfoundedEvidence(undefined, opened)).toMatch(/gives no evidence/);
    expect(unfoundedEvidence([{ source: "code/package.json", shows: "main is dist/cli.js" }], opened)).toMatch(/which you did not open/);
    expect(unfoundedEvidence([{ source: "the explorer's account", shows: "the build is in .tmp/node_log_parser" }], opened)).toMatch(/which you did not open/);
    expect(unfoundedEvidence([{ source: "failing run", shows: "dist/cli.js missing" }], opened)).toMatch(/only the failing run/);
    expect(
      unfoundedEvidence(
        [
          { source: "testing script", shows: "it runs .tmp/node_$(basename $1)/dist/cli.js" },
          { source: "code/tsconfig.json", shows: "rootDir . with src/**/*.ts emits dist/src/cli.js" },
        ],
        opened,
      ),
    ).toBeUndefined();
  });

  it("may blame the code for what the testing script needs, in the script's own words", () => {
    const script = '[ -f "$WORK/dist/cli.js" ] || { echo "Error: dist/cli.js missing"; exit 1; }';
    const spec = "- The tool prints a report.";
    expect(unfoundedCodeVerdict({ culprit: "code", reason: "r", scriptNeeds: '[ -f "$WORK/dist/cli.js" ]' }, spec, script)).toBeUndefined();
    expect(unfoundedCodeVerdict({ culprit: "code", reason: "r", scriptNeeds: "dist/main.js" }, spec, script)).toMatch(/is not in the script/);
    // Without the script to check against, script_needs alone is no ground.
    expect(unfoundedCodeVerdict({ culprit: "code", reason: "r", scriptNeeds: "dist/cli.js" }, spec)).toMatch(/quotes no words of the specification/);
  });
});
