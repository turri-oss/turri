import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testPlainFile } from "../test-plain.ts";

/**
 * What the test advisor writes on a yes, with every agent scripted: the test reqs call, the script's skill and the
 * scenarios' skill - their steps run by the real skill machinery - and the scenarios' judge.
 */
type Tool = { name: string; execute: (...args: unknown[]) => Promise<unknown> };
type StubSession = { tools: Tool[]; label?: string; cwd: string; judge?: boolean };

/** What the agents did, in order. */
let did: string[] = [];
/** What the scenarios' writer writes, by func-id. */
let scenarios = "# says-hello\nRunning it prints hello.";
/** The judge's verdict. */
let verdict: "pass" | "fail" = "pass";
/** Run while the scenarios' writer works: a stop, say. */
let whileWriting: (() => void) | undefined;
/** What the copy's tip held when the script's skill ran. */
let tipWhenScripted = "";

vi.mock("../../src/pi.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/pi.ts")>();
  return {
    ...actual,
    createExecutor: vi.fn(async (opts: { customTools: Tool[]; label?: string; cwd: string }) => ({
      tools: opts.customTools,
      label: opts.label,
      cwd: opts.cwd,
      sessionFile: undefined,
      subscribe: () => () => {},
      steer: async () => {},
      dispose() {},
    })),
    createJudge: vi.fn(async (opts: { verdictTool: Tool; cwd: string }) => ({ session: { tools: [opts.verdictTool], cwd: opts.cwd, judge: true, dispose() {} }, modelNote: "stub" })),
    ask: vi.fn(async (session: StubSession, text: string) => {
      const tool = (name: string) => session.tools.find((candidate) => candidate.name === name)!;
      if (session.judge === true) {
        did.push("judge");
        await tool("submit_verdict").execute("id", verdict === "pass" ? { verdict, violations: [] } : { verdict, violations: [{ criterion: "2", evidence: "x", fix: "y" }] });
        return "Judged.";
      }
      if (session.label?.endsWith("test reqs") === true) {
        did.push("test reqs");
        await tool("submit_test_reqs").execute("id", { reqs: [":ConformanceTests: use Python's unittest.", ":ConformanceTests: run the app as a process, and never import it."] });
        return "Done.";
      }
      if (text.includes("of the skill 'implement-conformance-testing-script'")) {
        did.push("script");
        tipWhenScripted = readFileSync(join(session.cwd, "app.plain"), "utf8");
        await tool("write").execute("id", { path: join(session.cwd, "test_scripts", "run_conformance_tests_python.sh"), content: "#!/bin/sh\nexit 0\n" });
        return "Written.";
      }
      if (text.includes("of the skill 'write-test-scenarios'") || text.includes("rejected by review")) {
        did.push("scenarios");
        mkdirSync(join(session.cwd, "tests", "app"), { recursive: true });
        await tool("write").execute("id", { path: join(session.cwd, "tests", "app", "say-hello.plain"), content: testPlainFile("app", "say-hello", { conformance: [scenarios] }) });
        whileWriting?.();
        await tool("write_artifact").execute("id", { path: "write-test-scenarios.md", content: "tests/app/say-hello.plain\nthe report\nvalidate: All specs valid." });
        return "Written.";
      }
      return "Nothing to do.";
    }),
  };
});

const { createAdvisorWriter, withImport, withTestReqs } = await import("../../src/regenerate/advisor-writer.ts");
const { createTestAdvisor } = await import("../../src/regenerate/advisor-runs.ts");
const { advisorEntry, textHash } = await import("../../src/regenerate/advisor-records.ts");
const { createJobRegistry } = await import("../../src/regenerate/jobs.ts");
const { createWorkLoop } = await import("../../src/regenerate/loop.ts");
const { writeCodeRecord, writeTestsRecord } = await import("../../src/regenerate/records.ts");
const { recordHistory } = await import("../../src/regenerate/lineage.ts");
type JobRunner = import("../../src/regenerate/loop.ts").JobRunner;

let dir: string;
let cwd: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "turri-advisor-writer-")));
  cwd = process.cwd();
  process.chdir(dir);
  writeFileSync(join(dir, "config.turri.yaml"), "");
  did = [];
  scenarios = "# says-hello\nRunning it prints hello.";
  verdict = "pass";
  whileWriting = undefined;
  tipWhenScripted = "";
});
afterEach(() => {
  process.chdir(cwd);
  rmSync(dir, { recursive: true, force: true });
});

const SAY_HELLO = "# say-hello\nRunning the app prints hello.\n";
const report = { verdict: "yes" as const, questions: [{ question: "silent-failure" as const, evidence: "It prints hallo." }], inputs: [{ input: "no arguments", agreed: "hello" }] };

/** The work on say-hello, on the project's app.plain. */
function workOn(controller = new AbortController()) {
  return {
    project: dir,
    module: "app",
    funcId: "say-hello",
    plainFile: join(dir, "app.plain"),
    tip: join(dir, "app.plain"),
    text: "Running the app prints hello.",
    hash: textHash("Running the app prints hello."),
    report,
    previous: [],
    signal: controller.signal,
  };
}

const bringUp = vi.fn(async () => []);
const stubLoop = () => ({ bringUp }) as never;

describe("what the test advisor writes on a yes", () => {
  it("writes the stack's conformance import, then the script, then the scenarios - in that order - and lands them as one change", async () => {
    writeFileSync(join(dir, "app.plain"), `---\nimport:\n  - stdlib/cli/python-argparse\n---\n\n***functional specs***\n\n${SAY_HELLO}`);
    const written = await createAdvisorWriter({ loop: stubLoop })(workOn());
    expect(did).toEqual(["script", "scenarios", "judge"]);
    // The import was there before the script was written.
    expect(tipWhenScripted).toContain("  - stdlib/cli/conformance/python-argparse");
    expect(readFileSync(join(dir, "app.plain"), "utf8")).toContain("import:\n  - stdlib/cli/python-argparse\n  - stdlib/cli/conformance/python-argparse\n---");
    expect(existsSync(join(dir, "test_scripts", "run_conformance_tests_python.sh"))).toBe(true);
    expect(readFileSync(join(dir, "tests", "app", "say-hello.plain"), "utf8")).toContain("# says-hello");
    expect(written).toEqual({ scenarios: [{ kind: "conformance", id: "says-hello", hash: textHash("Running it prints hello.") }], testReqs: true, script: true });
    expect(bringUp).toHaveBeenCalledWith(join(dir, "app.plain"), { specChange: true });
    // The copy it worked on is gone.
    expect(readdirSync(join(dir, ".turri", "advisor", "work"))).toEqual([]);
  });

  it("says what it lands, so the audit of an agent's command running meanwhile leaves it", async () => {
    const { writtenByConversation } = await import("../../src/regenerate/conversation-writes.ts");
    writeFileSync(join(dir, "app.plain"), `---\nimport:\n  - stdlib/cli/python-argparse\n---\n\n***functional specs***\n\n${SAY_HELLO}`);
    const since = Date.now() - 1;
    await createAdvisorWriter({ loop: stubLoop })(workOn());
    expect(writtenByConversation(join(dir, "tests", "app", "say-hello.plain"), since)).toBe(true);
    expect(writtenByConversation(join(dir, "app.plain"), since)).toBe(true);
  });

  it("writes the module's own test reqs when its stack has no conformance template", async () => {
    writeFileSync(join(dir, "app.plain"), `***implementation reqs***\n\n- :Implementation: is Python.\n\n***functional specs***\n\n${SAY_HELLO}`);
    await createAdvisorWriter({ loop: stubLoop })(workOn());
    expect(did).toEqual(["test reqs", "script", "scenarios", "judge"]);
    expect(readFileSync(join(dir, "app.plain"), "utf8")).toContain("***test reqs***\n\n- :ConformanceTests: use Python's unittest.\n- :ConformanceTests: run the app as a process, and never import it.\n\n***functional specs***");
  });

  it("leaves the test reqs and the script there are as they are", async () => {
    const app = `***implementation reqs***\n\n- :Implementation: is Python.\n\n***test reqs***\n\n- :ConformanceTests: use pytest.\n\n***functional specs***\n\n${SAY_HELLO}`;
    writeFileSync(join(dir, "app.plain"), app);
    mkdirSync(join(dir, "test_scripts"));
    writeFileSync(join(dir, "test_scripts", "run_conformance_tests_python.sh"), "#!/bin/sh\n# the person's\nexit 0\n");
    const written = await createAdvisorWriter({ loop: stubLoop })(workOn());
    expect(did).toEqual(["scenarios", "judge"]);
    expect(written).toMatchObject({ testReqs: false, script: false });
    expect(readFileSync(join(dir, "app.plain"), "utf8")).toBe(app);
    expect(readFileSync(join(dir, "test_scripts", "run_conformance_tests_python.sh"), "utf8")).toContain("the person's");
  });

  it("leaves the project untouched when it is stopped mid-way", async () => {
    const app = `***implementation reqs***\n\n- :Implementation: is Python.\n\n***functional specs***\n\n${SAY_HELLO}`;
    writeFileSync(join(dir, "app.plain"), app);
    const controller = new AbortController();
    whileWriting = () => controller.abort();
    await expect(createAdvisorWriter({ loop: stubLoop })(workOn(controller))).rejects.toThrow();
    expect(readFileSync(join(dir, "app.plain"), "utf8")).toBe(app);
    expect(existsSync(join(dir, "tests"))).toBe(false);
    expect(existsSync(join(dir, "test_scripts"))).toBe(false);
    expect(bringUp).not.toHaveBeenCalledWith(join(dir, "app.plain"), { specChange: true });
  });

  it("drops what it wrote when the functional spec's text changed while it wrote", async () => {
    writeFileSync(join(dir, "app.plain"), `***implementation reqs***\n\n- :Implementation: is Python.\n\n***test reqs***\n\n- :ConformanceTests: use pytest.\n\n***functional specs***\n\n${SAY_HELLO}`);
    mkdirSync(join(dir, "test_scripts"));
    writeFileSync(join(dir, "test_scripts", "run_conformance_tests_python.sh"), "#!/bin/sh\nexit 0\n");
    whileWriting = () => writeFileSync(join(dir, "app.plain"), `***implementation reqs***\n\n- :Implementation: is Python.\n\n***test reqs***\n\n- :ConformanceTests: use pytest.\n\n***functional specs***\n\n# say-hello\nRunning the app prints hello twice.\n`);
    await expect(createAdvisorWriter({ loop: stubLoop })(workOn())).rejects.toThrow(/changed while it wrote/);
    expect(existsSync(join(dir, "tests"))).toBe(false);
  });

  it("writes nothing when the scenarios' review fails, and the advisor records the failure", async () => {
    writeFileSync(join(dir, "app.plain"), `***implementation reqs***\n\n- :Implementation: is Python.\n\n***test reqs***\n\n- :ConformanceTests: use pytest.\n\n***functional specs***\n\n${SAY_HELLO}`);
    mkdirSync(join(dir, "test_scripts"));
    writeFileSync(join(dir, "test_scripts", "run_conformance_tests_python.sh"), "#!/bin/sh\nexit 0\n");
    verdict = "fail";
    const advisor = createTestAdvisor({ advise: async () => report, write: createAdvisorWriter({ loop: stubLoop }) });
    const { putAdvisorEntry } = await import("../../src/regenerate/advisor-records.ts");
    putAdvisorEntry(dir, "app", "app.plain", { funcId: "say-hello", hash: textHash("Running the app prints hello."), state: "pending", tip: "app.plain" });
    advisor.resume(dir);
    await advisor.idle();
    // Tried, retried twice, and let through by nobody.
    expect(did.filter((step) => step === "judge")).toHaveLength(3);
    expect(existsSync(join(dir, "tests"))).toBe(false);
    expect(advisorEntry(dir, "app", "say-hello")).toMatchObject({ state: "failed", reason: "the review of its scenarios did not pass", report });
  });

  it("starts the conformance pulse once the module's code is built", async () => {
    writeFileSync(join(dir, "app.plain"), `***implementation reqs***\n\n- :Implementation: is Python.\n\n***functional specs***\n\n${SAY_HELLO}`);
    const conformed: string[] = [];
    const lands: JobRunner = async (job) => {
      mkdirSync(job.buildDir, { recursive: true });
      writeFileSync(join(job.buildDir, "app.py"), "print('hello')\n");
      writeCodeRecord(job.buildDir, job.spec.tree);
      recordHistory(job.buildDir, job.planned.title);
      return { landed: true, report: "landed" };
    };
    const runConformance: JobRunner = async (job) => {
      conformed.push(...job.planned.cases.add.map((spec) => spec.funcId));
      const tests = join(dir, "plain_modules", "app", "tests");
      mkdirSync(tests, { recursive: true });
      writeFileSync(join(tests, "test_app.py"), "# conformance\n");
      writeTestsRecord(tests, job.planned.step.tree);
      recordHistory(job.buildDir, `conformance: ${job.planned.title}`);
      return { landed: true, report: "passed" };
    };
    const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, run: lands, runConformance });
    await loop.bringUp("app.plain");
    await loop.drain();
    expect(conformed).toEqual([]);
    await createAdvisorWriter({ loop: () => loop })(workOn());
    await loop.drain();
    expect(conformed).toEqual(["say-hello"]);
  });
});

describe("the advisor's edits to a module", () => {
  it("adds an import to the frontmatter however it is written, and makes one where there is none", () => {
    expect(withImport("***functional specs***\n", "stdlib/x")).toBe("---\nimport:\n  - stdlib/x\n---\n\n***functional specs***\n");
    expect(withImport("---\ndescription: d\n---\n\nbody", "stdlib/x")).toBe("---\ndescription: d\nimport:\n  - stdlib/x\n---\n\nbody");
    expect(withImport("---\nimport: [a, b]\n---\nbody", "stdlib/x")).toBe("---\nimport: [a, b, stdlib/x]\n---\nbody");
    expect(withImport("---\nimport:\n    - a\nrequires:\n  - core\n---\nbody", "stdlib/x")).toBe("---\nimport:\n    - a\n    - stdlib/x\nrequires:\n  - core\n---\nbody");
  });

  it("puts test reqs before the functional specs", () => {
    expect(withTestReqs("***definitions***\n\n- :A: is a.\n\n***functional specs***\n\n# a\nA.\n", [":ConformanceTests: use pytest."])).toBe(
      "***definitions***\n\n- :A: is a.\n\n***test reqs***\n\n- :ConformanceTests: use pytest.\n\n***functional specs***\n\n# a\nA.\n",
    );
  });
});
