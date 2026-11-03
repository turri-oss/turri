import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createJobRegistry } from "../../src/regenerate/jobs.ts";
import { chainSpec, createWorkLoop, functionalityCompletion } from "../../src/regenerate/loop.ts";
import { writeCodeRecord } from "../../src/regenerate/records.ts";
import { requiresOrder, resolveRequiresChain } from "../../src/regenerate/requires.ts";
import { projectStanding } from "../../src/regenerate/standing.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "turri-standing-"));
  writeFileSync(join(dir, "config.turri.yaml"), "coding-model: p/small\n");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A module of its own functional specs, requiring another or not. */
function spec(name: string, specs: string[], requires?: string): string {
  const file = join(dir, `${name}.plain`);
  const front = requires !== undefined ? `---\nrequires:\n  - ${requires}\n---\n\n` : "";
  writeFileSync(file, `${front}***implementation reqs***\n\n- Python.\n\n***functional specs***\n\n${specs.map((text) => `# ${text.toLowerCase().replace(/[^a-z ]/g, "").split(" ").slice(0, 2).join("-")}\n${text}`).join("\n\n")}\n`);
  return file;
}

/** A codebase built from its chain's spec as it is, but for its own last functional spec. */
function build(file: string): void {
  const chain = resolveRequiresChain(file, [], undefined, { allowNoFunctionalities: true });
  const tree = chainSpec(chain).tree;
  writeCodeRecord(chain.at(-1)!.buildDir, { ...tree, "functional specs": (tree["functional specs"] as unknown[]).slice(0, -1) });
  mkdirSync(join(chain.at(-1)!.buildDir, "src"), { recursive: true });
  writeFileSync(join(chain.at(-1)!.buildDir, "src", "app.py"), "print(1)\n");
}

/** What drift and functionalityCompletion say of a module, each asked alone - as a host asked them before. */
function alone(file: string) {
  const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, dryRun: true });
  return { drift: loop.drift(file), completion: functionalityCompletion(file) };
}

describe("how a project's modules stand", () => {
  it("is what drift and functionalityCompletion say of each module alone, for every module of the project in one call", () => {
    const base = spec("base", ["Base one.", "Base two."]);
    const middle = spec("middle", ["Middle one."], "base");
    const app = spec("app", ["App one.", "App two."], "middle");
    build(base);
    build(app);

    const standing = projectStanding(dir);
    expect(standing.map((entry) => entry.module)).toEqual(["app", "base", "middle"]);
    for (const file of [app, base, middle]) {
      const entry = standing.find((each) => each.plainFile === file)!;
      expect({ drift: entry.drift, completion: entry.completion }).toEqual(alone(file));
      expect(entry.driftError).toBeUndefined();
      expect(entry.completionError).toBeUndefined();
    }
    // Something to say in each: app's codebase holds all but its own last functional spec.
    const appCompletion = standing.find((entry) => entry.module === "app")!.completion![0]!;
    expect(appCompletion.modules.map((module) => module.incomplete)).toEqual([[], [], ["app-two"]]);
  });

  it("sees a change made since the call before", () => {
    const app = spec("app", ["App one.", "App two."]);
    build(app);
    expect(projectStanding(dir)[0]!.completion![0]!.modules[0]!.incomplete).toEqual(["app-two"]);
    spec("app", ["App one, changed.", "App two."]);
    const after = projectStanding(dir)[0]!;
    expect(after.completion![0]!.modules[0]!.incomplete).toEqual(["app-one", "app-two"]);
    expect(after).toEqual({ ...alone(app), plainFile: app, module: "app" });
  });

  it("looks only at the files given, and says what could not be read of one without failing the others", () => {
    spec("app", ["App one."]);
    writeFileSync(join(dir, "broken.plain"), "---\nrequires:\n  - nowhere\n---\n\n***implementation reqs***\n\n- Python.\n\n***functional specs***\n\n# one\nOne.\n");
    const standing = projectStanding(dir, { files: ["broken.plain", "app.plain"] });
    expect(standing.map((entry) => entry.module)).toEqual(["broken", "app"]);
    expect(standing[0]!.driftError ?? standing[0]!.completionError).toMatch(/nowhere/);
    expect(standing[1]!.completion![0]!.modules[0]!.incomplete).toEqual(["app-one"]);
  });
});

describe("the order a project's modules are built in", () => {
  /** A module's file, requiring those named. */
  const module = (name: string, requires: string[] = [], body = "***implementation reqs***\n\n- Python.\n\n***functional specs***\n\n# one\nOne.\n") =>
    writeFileSync(join(dir, `${name}.plain`), `${requires.length > 0 ? `---\nrequires:\n${requires.map((each) => `  - ${each}`).join("\n")}\n---\n\n` : ""}${body}`);
  const names = (files: string[]) => files.map((file) => file.split("/").pop()!.replace(".plain", ""));

  it("puts each module after every module it requires - taken by name, each brought in after what it requires", () => {
    module("ocean");
    module("depths", ["ocean"]);
    module("arena", ["depths"]);
    module("scenery", ["arena"]);
    module("bestiary");
    // arena first by name, so its chain before it - then bestiary, then scenery, after arena.
    expect(names(requiresOrder(dir))).toEqual(["ocean", "depths", "arena", "bestiary", "scenery"]);
  });

  it("orders only the files given - absolute or from the project - and places a module that does not parse after what it says it requires", () => {
    module("ocean");
    module("depths", ["ocean"], "***functional specs***\n\nnot a functional spec\n");
    module("arena", ["depths"]);
    module("cycle-a", ["cycle-b"]);
    module("cycle-b", ["cycle-a"]);
    expect(names(requiresOrder(dir, { files: ["arena.plain", join(dir, "depths.plain"), "ocean.plain"] }))).toEqual(["ocean", "depths", "arena"]);
    // A cycle never resolves: each is placed once, neither lost.
    expect(names(requiresOrder(dir, { files: ["cycle-a.plain", "cycle-b.plain"] })).sort()).toEqual(["cycle-a", "cycle-b"]);
  });
});
