import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFORMANCE_OFF_REFUSAL, conformanceBlock, conformanceTestsOn, conformanceTestsOnIn, turnOnConformanceTests } from "../src/conformance-switch.ts";
import { checkPlainFile } from "../src/plain/check.ts";
import { createJobRegistry } from "../src/regenerate/jobs.ts";
import { recordHistory } from "../src/regenerate/lineage.ts";
import { createWorkLoop, describeDrift, type JobRunner } from "../src/regenerate/loop.ts";
import { writeCodeRecord, writeTestsRecord } from "../src/regenerate/records.ts";
import { testPlainFile } from "./test-plain.ts";
import { writeTestScripts } from "./test-scripts.ts";

// A project with a module that has test reqs, testing scripts, and a functional spec with scenarios: everything
// conformance testing needs - but whether it is on is the config's.
let dir: string;
let cwd: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "turri-conformance-switch-")));
  cwd = process.cwd();
  process.chdir(dir);
  writeFileSync(join(dir, "config.turri.yaml"), "module: app.plain\n");
  writeTestScripts(dir);
  writeFileSync(join(dir, "app.plain"), "***implementation reqs***\n\n- :Implementation: is Python.\n\n***test reqs***\n\n- :ConformanceTests: use pytest.\n\n***functional specs***\n\n# say-hello\nSay hello.\n");
  mkdirSync(join(dir, "tests", "app"), { recursive: true });
  writeFileSync(join(dir, "tests", "app", "say-hello.plain"), testPlainFile("app", "say-hello", { conformance: ["# greets\nIt says hello."] }));
});
afterEach(() => {
  process.chdir(cwd);
  rmSync(dir, { recursive: true, force: true });
});

const config = () => readFileSync(join(dir, "config.turri.yaml"), "utf8");

/** A loop whose code and conformance pulses land, each noted. */
function loop() {
  const ran: string[] = [];
  const land =
    (track: string): JobRunner =>
    async (job) => {
      ran.push(track);
      if (track === "code") writeCodeRecord(job.buildDir, job.spec.tree);
      else {
        mkdirSync(join(dir, "plain_modules", "app", "tests"), { recursive: true });
        writeTestsRecord(join(dir, "plain_modules", "app", "tests"), job.planned.step.tree);
      }
      recordHistory(job.buildDir, job.planned.title);
      return { landed: true, report: "landed" };
    };
  const work = createWorkLoop({ registry: createJobRegistry({ maxRunning: 1 }), cwd: dir, planner: false, run: land("code"), runConformance: land("conformance") });
  return { ran, work };
}

describe("conformance tests", () => {
  it("are off when the config says nothing - on with conformance-tests: true, a stack's own over the project's", () => {
    expect(conformanceTestsOn(join(dir, "app.plain"))).toBe(false);
    expect(conformanceTestsOnIn(dir)).toBe(false);
    writeFileSync(join(dir, "config.turri.yaml"), "module: app.plain\nconformance-tests: true\n");
    expect(conformanceTestsOn(join(dir, "app.plain"))).toBe(true);
    // A stack named after the module, saying its own: over the project's.
    writeFileSync(join(dir, "config.turri.app.yaml"), "conformance-tests: false\n");
    expect(conformanceTestsOn(join(dir, "app.plain"))).toBe(false);
  });

  it("off, are never written: the code is built, no conformance pulse runs, and drift and conform say they are off", async () => {
    const { ran, work } = loop();
    await work.bringUp("app.plain");
    await work.drain();
    expect(ran).toEqual(["code"]);
    expect(describeDrift(work.drift("app.plain"))).toContain("conformance tests: off (conformance-tests: false) - none written or run");
    await expect(work.conformance("app.plain")).rejects.toThrow("Conformance tests are off for app (conformance-tests: false, or unset): nothing is conformance tested.");
    // No step of adding them is skipped, so no module waits on one.
    expect(work.status()[0]!.why).not.toContain("waiting for its");
  });

  it("turned on, are written for what is built - the work loop picks them up at its next look", async () => {
    const { ran, work } = loop();
    await work.bringUp("app.plain");
    await work.drain();
    expect(turnOnConformanceTests(dir)).toBe("config.turri.yaml");
    expect(config()).toMatch(/^conformance-tests: true$/m);
    await work.bringUp("app.plain");
    await work.drain();
    expect(ran).toEqual(["code", "conformance"]);
  });

  it("are turned on in a stack's file when that says its own - else in config.turri.yaml", () => {
    writeFileSync(join(dir, "config.turri.app.yaml"), "conformance-tests: false\n");
    expect(turnOnConformanceTests(dir, join(dir, "app.plain"))).toBe("config.turri.app.yaml");
    expect(readFileSync(join(dir, "config.turri.app.yaml"), "utf8")).toMatch(/^conformance-tests: true$/m);
    expect(config()).not.toContain("conformance-tests");
    expect(conformanceTestsOn(join(dir, "app.plain"))).toBe(true);
  });

  it("off, leave the scenarios written untested - parse says so, and warns of no step of adding them", () => {
    expect(checkPlainFile(join(dir, "app.plain")).warnings).toEqual([
      "its scenarios are not tested - app:say-hello: conformance tests are off (conformance-tests: false, or unset). /conform in the chat turns them on, or conformance-tests: true in config.turri.yaml.",
    ]);
  });
});

describe("what the chat is told of conformance tests", () => {
  it("is what they are every turn - off, that they are, why, and that the person alone turns them on with /conform", () => {
    const off = conformanceBlock(false);
    expect(off).toContain("Conformance tests are black-box tests");
    expect(off).toContain("They are off here");
    expect(off).toContain("They make each change take about twice as long");
    expect(off).toContain("turning them on is theirs alone");
    expect(off).toContain("They decide, and turn them on with /conform");
    const on = conformanceBlock(true);
    expect(on).toContain("They are on here (conformance-tests: true)");
    // On, the chat decides which functional specs need scenarios, by the rules' criteria - nothing does it for it.
    expect(on).toContain("judge whether it needs scenarios, as the rules on test plain files say");
    expect(on).toContain("a visible ***plain change the person reviews like any other");
    // And sets up what its scenarios need, unasked: on is the person's yes.
    expect(on).toContain("write it first, in that order - the test reqs, then the script with");
    expect(on).toContain("asking nothing: conformance tests on is the person's yes to them");
  });

  it("refuses the chat while they are off, sending it to the person with its reasons", () => {
    expect(CONFORMANCE_OFF_REFUSAL).toContain("turning them on is the person's decision");
    expect(CONFORMANCE_OFF_REFUSAL).toContain("Tell the person, in a line or two, why you want conformance tests here");
    expect(CONFORMANCE_OFF_REFUSAL).toContain("turn them on with /conform");
  });
});
