import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENT_ROLES, modelOnly, projectModels, readProjectConfig, ROLE_THINKING, roleModel, roleTurnLimitMs, skillModel, moduleConfigsOf, unknownConfigKeys, unknownConfigLines } from "../src/config.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "turri-config-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("the project's config.yaml", () => {
  it("says what to build, on which model, whether it is reviewed, and where the testing scripts are", () => {
    writeFileSync(
      join(root, "config.yaml"),
      [
        "module: prism_cli.plain",
        "harness-model: anthropic/claude-opus-5-5",
        "coding-model: google/gemini-3.1-flash",
        "judge-model: google/gemini-3.1-pro",
        "review: false",
        "unittests-script: test_scripts/run_unittests_rust.sh",
        "conformance-tests-script: test_scripts/run_conformance_tests_rust.sh",
      ].join("\n"),
    );
    expect(readProjectConfig(root)).toEqual({
      module: "prism_cli.plain",
      harnessModel: { model: "anthropic/claude-opus-5-5" },
      codingModel: { model: "google/gemini-3.1-flash" },
      judgeModel: { model: "google/gemini-3.1-pro" },
      review: false,
      unittestsScript: "test_scripts/run_unittests_rust.sh",
      conformanceTestsScript: "test_scripts/run_conformance_tests_rust.sh",
    });
  });

  it("gives each model a reference and a thinking level, and fills in what one leaves out from the one it inherits", async () => {
    const { projectModels, modelSpec, splitModelSpec } = await import("../src/config.ts");
    writeFileSync(
      join(root, "config.yaml"),
      [
        "harness-model:",
        "  model: anthropic/claude-opus-5-5",
        "  thinking: high",
        "coding-model:",
        "  model: google/gemini-3.1-flash-lite",
        "judge-model:",
        "  thinking: xhigh",
      ].join("\n"),
    );
    const config = readProjectConfig(root);
    expect(config.harnessModel).toEqual({ model: "anthropic/claude-opus-5-5", thinking: "high" });
    const models = projectModels(config);
    // Coding takes the harness's thinking level; the judge takes the coding model, with its own level.
    expect(models.coding).toEqual({ model: "google/gemini-3.1-flash-lite", thinking: "high" });
    expect(models.judge).toEqual({ model: "google/gemini-3.1-flash-lite", thinking: "xhigh" });
    expect(modelSpec(models.judge)).toBe("google/gemini-3.1-flash-lite:xhigh");

    // Not given at all: the judge is the coding model - its model alone, thinking as its role does - the coding model
    // the harness model, its thinking too.
    writeFileSync(join(root, "config.yaml"), "harness-model: google/gemini-3.1-pro:medium\n");
    const inherited = projectModels(readProjectConfig(root));
    expect(inherited.coding).toEqual({ model: "google/gemini-3.1-pro", thinking: "medium" });
    expect(inherited.judge).toEqual({ model: "google/gemini-3.1-pro" });

    // A model id with a colon of its own is not a thinking level.
    expect(splitModelSpec("amazon-bedrock/anthropic.claude-v2:1")).toEqual({ model: "amazon-bedrock/anthropic.claude-v2:1" });
    expect(splitModelSpec(":low")).toEqual({ thinking: "low" });
    // A thinking level that is not one is left out.
    writeFileSync(join(root, "config.yaml"), "coding-model:\n  model: a/b\n  thinking: very\n");
    expect(readProjectConfig(root).codingModel).toEqual({ model: "a/b" });
  });

  it("reads underscores as dashes, and ignores keys it does not know and values of the wrong type", () => {
    writeFileSync(
      join(root, "config.yaml"),
      "module: app.plain\nmutation_testing: true\nunittests_script: run_unittests.sh\nmodel: 42\ntemplate-dir: template\ntest-script-timeout: 600\nconformance-tests: true\n",
    );
    expect(readProjectConfig(root)).toEqual({
      module: "app.plain",
      harnessModel: undefined,
      codingModel: undefined,
      judgeModel: undefined,
      mutationTesting: true,
      unittestsScript: "run_unittests.sh",
      conformanceTestsScript: undefined,
      conformanceTests: true,
    });
  });

  it("reads conformance-tests as a yes or no - a word it is not, nothing - and no conformance-budget", () => {
    writeFileSync(join(root, "config.yaml"), "conformance-tests: false\nconformance-budget: 30%\n");
    expect(readProjectConfig(root).conformanceTests).toBe(false);
    expect(readProjectConfig(root)).not.toHaveProperty("conformanceBudget");
    writeFileSync(join(root, "config.yaml"), "conformance-tests: chosen\n");
    expect(readProjectConfig(root).conformanceTests).toBeUndefined();
  });
});

describe("how hard each role thinks when nothing names a level", () => {
  it("has the agents that do the work think low, the ones that judge medium, and leaves the conversation its own", () => {
    for (const role of ["coding", "conformance", "explorer", "release"] as const) expect(ROLE_THINKING[role], role).toBe("low");
    for (const role of ["reviewer", "test-reviewer", "judge", "arbiter", "debugger", "planner", "diagnosis"] as const) expect(ROLE_THINKING[role], role).toBe("medium");
    // The sentinel is a chat too: it keeps its own level, as the conversation does.
    expect(ROLE_THINKING.chat).toBeUndefined();
    expect(ROLE_THINKING.sentinel).toBeUndefined();
    expect(AGENT_ROLES.filter((role) => role !== "chat" && role !== "sentinel" && ROLE_THINKING[role] === undefined)).toEqual([]);
  });

  it("is what an agent starts with: below a level the config or its model names, above the conversation's", async () => {
    const { agentThinking } = await import("../src/pi.ts");
    const conversation = () => "high" as const;
    expect(agentThinking(undefined, "coding", conversation)).toBe("low");
    expect(agentThinking(undefined, "judge", conversation)).toBe("medium");
    expect(agentThinking("xhigh", "coding", conversation)).toBe("xhigh");
    expect(agentThinking(undefined, undefined, conversation)).toBe("high");
  });

  it("gives a judging role falling back on the coding model the model alone, not how hard the coding agent thinks", () => {
    expect(modelOnly("google/gemini-3.1-flash-lite:low")).toEqual({ model: "google/gemini-3.1-flash-lite" });
    expect(modelOnly("google/gemini-3.1-flash-lite")).toEqual({ model: "google/gemini-3.1-flash-lite" });
    expect(modelOnly(":high")).toEqual({});
    expect(modelOnly(undefined)).toEqual({});
  });
});

describe("models: and turn-limit:", () => {
  const sonnet = "amazon-bedrock/eu.anthropic.claude-sonnet-5";
  const luna = "amazon-bedrock/global.openai.gpt-6-luna";
  const lite = "google/gemini-3.1-flash-lite";
  const opus = "amazon-bedrock/eu.anthropic.claude-opus-5-5";

  it("runs a skill from the command line on the project's harness model, as the chat does, and on pi's default when the project names none", () => {
    expect(skillModel(root)).toBeUndefined();
    writeFileSync(join(root, "config.turri.yaml"), `harness-model: ${opus}:medium\ncoding-model: ${lite}\n`);
    expect(skillModel(root)).toBe(`${opus}:medium`);
    writeFileSync(join(root, "config.turri.yaml"), `harness-model: ${opus}\nmodels:\n  chat: ${sonnet}\n`);
    expect(skillModel(root)).toBe(sonnet);
  });

  it("gives each agent role its own model, thinking and turn limit, and every role it does not name the default", () => {
    writeFileSync(
      join(root, "config.yaml"),
      [
        "harness-model: " + opus,
        "turn-limit: 150",
        "models:",
        `  default: { model: ${luna}, thinking: medium }`,
        `  coding: { model: ${sonnet}, thinking: high, turn-limit: 180 }`,
        `  explorer: ${lite}`,
        "  reviewer:",
        "    thinking: low",
        "  nonsense: whatever",
      ].join("\n"),
    );
    const config = readProjectConfig(root);
    expect(config.models).toEqual({
      default: { model: luna, thinking: "medium" },
      coding: { model: sonnet, thinking: "high", turnLimit: 180 },
      explorer: { model: lite },
      reviewer: { thinking: "low" },
    });
    // The job's model - the coding agents' - and the chat's.
    expect(projectModels(config)).toEqual({ harness: { model: opus }, coding: { model: sonnet, thinking: "high" }, judge: { model: luna, thinking: "medium" } });
    // What a role runs on: its own entry, what it leaves out from the default; the coding role is given its model.
    expect(roleModel(config, "explorer")).toEqual({ model: lite, thinking: "medium" });
    expect(roleModel(config, "reviewer")).toEqual({ model: luna, thinking: "low" });
    expect(roleModel(config, "judge")).toEqual({ model: luna, thinking: "medium" });
    expect(roleModel(config, "coding")).toBeUndefined();
    // The debugger, unnamed, runs on the coding model it is given - not the default.
    expect(roleModel(config, "debugger")).toBeUndefined();
    // The conversation's side keeps the chat's model unless named.
    expect(roleModel(config, "planner")).toBeUndefined();
    // The release is not of it: it follows steps, on the model it is given - the coding model - or the default.
    expect(roleModel(config, "release")).toEqual({ model: luna, thinking: "medium" });
    // Nor the diagnosis of a failed job: unnamed, the default - else the coding model it is given, never the chat's.
    expect(roleModel(config, "diagnosis")).toEqual({ model: luna, thinking: "medium" });
    expect(roleModel({ harnessModel: { model: opus } }, "diagnosis")).toBeUndefined();
    // Turn limits: the role's own, else the default's, else turn-limit:.
    expect(roleTurnLimitMs(config, "coding")).toBe(180_000);
    expect(roleTurnLimitMs(config, "explorer")).toBe(150_000);
    expect(roleTurnLimitMs(config, undefined)).toBe(150_000);
  });

  it("runs the debugger on its own model when models: names one, and on the coding model when it does not", () => {
    writeFileSync(join(root, "config.yaml"), "models:\n  default: openai/gpt-5.5\n  debugger: { model: anthropic/claude-opus-5-5, thinking: high }\n");
    expect(roleModel(readProjectConfig(root), "debugger")).toEqual({ model: "anthropic/claude-opus-5-5", thinking: "high" });
    writeFileSync(join(root, "config.yaml"), "models:\n  default: openai/gpt-5.5\n");
    expect(roleModel(readProjectConfig(root), "debugger")).toBeUndefined();
  });

  it("takes one turn limit for every agent from turn-limit: alone, and none from nothing - the harness's two minutes", () => {
    writeFileSync(join(root, "config.yaml"), "turn-limit: 150\n");
    expect(roleTurnLimitMs(readProjectConfig(root), "conformance")).toBe(150_000);
    writeFileSync(join(root, "config.yaml"), "coding-model: google/gemini-3.8-flash\n");
    expect(roleTurnLimitMs(readProjectConfig(root), "conformance")).toBeUndefined();
  });

  it("reads the old keys as before, models: winning over them - judge-model for the judge and the test review", () => {
    writeFileSync(join(root, "config.yaml"), [`harness-model: ${opus}`, `coding-model: ${luna}`, `judge-model: ${sonnet}`].join("\n"));
    let config = readProjectConfig(root);
    expect(projectModels(config)).toEqual({ harness: { model: opus }, coding: { model: luna }, judge: { model: sonnet } });
    expect(roleModel(config, "test-reviewer")).toEqual({ model: sonnet });
    expect(roleModel(config, "explorer")).toBeUndefined();
    writeFileSync(join(root, "config.yaml"), [`harness-model: ${opus}`, `coding-model: ${luna}`, "models:", `  coding: ${sonnet}`, `  chat: ${lite}`].join("\n"));
    config = readProjectConfig(root);
    expect(projectModels(config).coding).toEqual({ model: sonnet });
    expect(projectModels(config).harness).toEqual({ model: lite });
  });

  it("lays a module's own models: over the project's, role by role - but never the chat's", () => {
    writeFileSync(join(root, "config.turri.yaml"), ["models:", `  default: { model: ${luna}, turn-limit: 120 }`, `  chat: ${opus}`].join("\n"));
    writeFileSync(join(root, "config.turri.backend.yaml"), ["models:", "  default: { thinking: high }", `  explorer: ${lite}`, `  chat: ${lite}`, "turn-limit: 200"].join("\n"));
    const config = readProjectConfig(root, "backend");
    expect(config.models).toEqual({ default: { model: luna, thinking: "high", turnLimit: 120 }, chat: { model: opus }, explorer: { model: lite } });
    expect(config.turnLimit).toBe(200);
  });
});

describe("a module's own config file", () => {
  /** cognio: a Python backend and a React frontend side by side, each with its own testing scripts. */
  beforeEach(() => {
    writeFileSync(join(root, "config.turri.yaml"), ["harness-model: anthropic/claude-opus-5-5", "coding-model: google/gemini-3.1-flash:low", "review: true"].join("\n"));
    writeFileSync(
      join(root, "config.turri.backend.yaml"),
      ["unittests-script: test_scripts/run_unittests_python.sh", "conformance-tests-script: test_scripts/run_conformance_tests_python.sh"].join("\n"),
    );
    writeFileSync(
      join(root, "config.turri.frontend.yaml"),
      [
        "unittests-script: test_scripts/run_unittests_typescript.sh",
        "coding-model:",
        "  thinking: high",
        "review: false",
        "harness-model: somebody/else",
        "module: frontend.plain",
      ].join("\n"),
    );
    writeFileSync(join(root, "backend.plain"), "***implementation reqs***\n\n- :Implementation: is Python.\n\n***functional specs***\n\n# serve\nServe.\n");
    writeFileSync(join(root, "frontend.plain"), "***implementation reqs***\n\n- :Implementation: is React.\n\n***functional specs***\n\n# show\nShow.\n");
  });

  it("is laid over config.turri.yaml for its module - a model it names taking what it leaves out from the project's - and a module with none is built with the project's file alone", async () => {
    const { configForSpec, moduleConfigsOf } = await import("../src/config.ts");
    expect(moduleConfigsOf(root)).toEqual(["backend", "frontend"]);
    const project = { harnessModel: { model: "anthropic/claude-opus-5-5" }, codingModel: { model: "google/gemini-3.1-flash", thinking: "low" }, review: true };
    expect(configForSpec(join(root, "app.plain"))).toEqual(project);
    expect(configForSpec(join(root, "backend.plain"))).toEqual({
      ...project,
      unittestsScript: "test_scripts/run_unittests_python.sh",
      conformanceTestsScript: "test_scripts/run_conformance_tests_python.sh",
    });
    // The conversation's model, and the module built when none is named, are the project's alone.
    expect(configForSpec(join(root, "frontend.plain"))).toEqual({
      harnessModel: { model: "anthropic/claude-opus-5-5" },
      codingModel: { model: "google/gemini-3.1-flash", thinking: "high" },
      review: false,
      unittestsScript: "test_scripts/run_unittests_typescript.sh",
    });
  });

  it("builds every module built on its module that has no file of its own, all the way up the requires chain", async () => {
    const { configForSpec, configModuleFor } = await import("../src/config.ts");
    writeFileSync(join(root, "backend_auth.plain"), "---\nrequires: [backend]\n---\n\n***functional specs***\n\n- Log in.\n");
    writeFileSync(join(root, "backend_billing.plain"), "---\nrequires: [backend_auth]\n---\n\n***functional specs***\n\n- Bill.\n");
    expect(configModuleFor(join(root, "backend_auth.plain"))).toBe("backend");
    expect(configModuleFor(join(root, "backend_billing.plain"))).toBe("backend");
    expect(configForSpec(join(root, "backend_billing.plain")).unittestsScript).toBe("test_scripts/run_unittests_python.sh");
    // Its own file wins over the one below.
    writeFileSync(join(root, "config.turri.backend_billing.yaml"), "review: false\n");
    expect(configModuleFor(join(root, "backend_billing.plain"))).toBe("backend_billing");
  });

  it("cannot be told when two of the modules a module requires have one - an error, as the parse says it", async () => {
    const { configForSpec, configModuleFor } = await import("../src/config.ts");
    const { checkPlainFile } = await import("../src/plain/check.ts");
    // A chain is one line: app on frontend, frontend on backend - each of them with a file of its own.
    writeFileSync(join(root, "frontend.plain"), "---\nrequires: [backend]\n---\n\n***implementation reqs***\n\n- :Implementation: is React.\n\n***functional specs***\n\n# show\nShow.\n");
    writeFileSync(join(root, "app.plain"), "---\nrequires: [frontend]\n---\n\n***implementation reqs***\n\n- :Implementation: is Python.\n\n***functional specs***\n\n# both\nBoth.\n");
    expect(() => configModuleFor(join(root, "app.plain"))).toThrow(/config\.turri\.frontend\.yaml, config\.turri\.backend\.yaml[\s\S]*Give app\.plain its own config\.turri\.app\.yaml/);
    // Read as anything reads the config, it is the project's alone; parsed, it is an error.
    expect(configForSpec(join(root, "app.plain")).unittestsScript).toBeUndefined();
    const check = checkPlainFile(join(root, "app.plain"));
    expect(check.ok).toBe(false);
    expect(check.error).toContain("which builds app.plain cannot be told");
    // Its own file settles it.
    writeFileSync(join(root, "config.turri.app.yaml"), "review: true\n");
    expect(configModuleFor(join(root, "app.plain"))).toBe("app");
  });

  it("is pinned to a pulse: what it runs reads the config it started with, whatever module is asked about", async () => {
    const { configForSpec, configModuleOf, pinnedConfigModule, withConfigModule } = await import("../src/config.ts");
    expect(pinnedConfigModule()).toBeUndefined();
    expect(configModuleOf(root)).toBeUndefined();
    await withConfigModule("frontend", async () => {
      await Promise.resolve();
      expect(configModuleOf(root)).toBe("frontend");
      expect(configForSpec(join(root, "backend.plain")).unittestsScript).toBe("test_scripts/run_unittests_typescript.sh");
    });
    expect(withConfigModule(undefined, () => configForSpec(join(root, "backend.plain")).unittestsScript)).toBeUndefined();
    // A module the folder has no file for is no module config there.
    expect(withConfigModule("mobile", () => configModuleOf(root))).toBeUndefined();
  });

  it("names the testing scripts its module is built with - and a module with none of its own says where to name them", async () => {
    const { mkdirSync } = await import("node:fs");
    const { projectDirOf } = await import("../src/regenerate/paths.ts");
    const { findTestScripts } = await import("../src/regenerate/test-scripts.ts");
    rmSync(join(root, "config.turri.yaml"));
    rmSync(join(root, "config.turri.backend.yaml"));
    writeFileSync(join(root, "config.turri.backend.yaml"), "unittests-script: test_scripts/run_unittests_python.sh\n");
    mkdirSync(join(root, "test_scripts"));
    for (const script of ["run_unittests_python.sh", "run_unittests_typescript.sh"]) writeFileSync(join(root, "test_scripts", script), "#!/bin/bash\n");
    // A module's file alone makes its folder a project.
    expect(projectDirOf(join(root, "backend.plain"))).toBe(root);
    expect(findTestScripts(root, join(root, "backend.plain")).unit).toBe(join(root, "test_scripts", "run_unittests_python.sh"));
    expect(findTestScripts(root, join(root, "frontend.plain")).unit).toBe(join(root, "test_scripts", "run_unittests_typescript.sh"));
    const app = findTestScripts(root, join(root, "app.plain"));
    expect(app.unit).toBeUndefined();
    expect(app.notes?.unit).toContain("config.turri.backend.yaml, config.turri.frontend.yaml");
    expect(app.notes?.unit).toContain("name its scripts in its own file");
  });
});

describe("config.yaml, before turri had a file of its own", () => {
  it("is read, with config.<module>.yaml as modules' own files, while the folder has no config.turri*.yaml - and never once it has", async () => {
    const { projectConfigFile, readProjectConfig, moduleConfigsOf } = await import("../src/config.ts");
    writeFileSync(join(root, "config.yaml"), "review: false\nunittests-script: run_unittests_python.sh\n");
    writeFileSync(join(root, "config.backend.yaml"), "review: true\n");
    expect(projectConfigFile(root)).toBe("config.yaml");
    expect(readProjectConfig(root).review).toBe(false);
    expect(moduleConfigsOf(root)).toEqual(["backend"]);
    expect(readProjectConfig(root, "backend").review).toBe(true);
    writeFileSync(join(root, "config.turri.yaml"), "mutation-testing: false\n");
    expect(projectConfigFile(root)).toBe("config.turri.yaml");
    expect(readProjectConfig(root)).toEqual({ mutationTesting: false });
    expect(moduleConfigsOf(root)).toEqual([]);
  });

  it("is copied to config.turri.yaml - each config.<module>.yaml to config.turri.<module>.yaml - before turri first writes a setting, and left as it was", async () => {
    const { readFileSync } = await import("node:fs");
    const { readProjectConfig, moduleConfigsOf } = await import("../src/config.ts");
    const { writeSetting } = await import("../src/config-edit.ts");
    writeFileSync(join(root, "config.yaml"), "# another tool's\nunittests-script: run_unittests_python.sh\n");
    writeFileSync(join(root, "config.backend.yaml"), "review: true\n");
    writeSetting(root, "review", false);
    expect(readFileSync(join(root, "config.yaml"), "utf8")).toBe("# another tool's\nunittests-script: run_unittests_python.sh\n");
    expect(readFileSync(join(root, "config.turri.yaml"), "utf8")).toContain("unittests-script: run_unittests_python.sh");
    expect(readFileSync(join(root, "config.turri.backend.yaml"), "utf8")).toBe("review: true\n");
    expect(readProjectConfig(root)).toEqual({ unittestsScript: "run_unittests_python.sh", review: false });
    expect(moduleConfigsOf(root)).toEqual(["backend"]);
  });
});

describe("the config, read again and again", () => {
  it("is read afresh once a file is edited or a module's file added - and each caller is given its own copy", () => {
    writeFileSync(join(root, "config.turri.yaml"), "coding-model: p/small\n");
    const first = readProjectConfig(root);
    expect(first.codingModel).toEqual({ model: "p/small" });
    first.codingModel = { model: "changed/by-a-caller" };
    expect(readProjectConfig(root).codingModel).toEqual({ model: "p/small" });
    writeFileSync(join(root, "config.turri.yaml"), "coding-model: p/smallest\n");
    expect(readProjectConfig(root).codingModel).toEqual({ model: "p/smallest" });
    expect(moduleConfigsOf(root)).toEqual([]);
    writeFileSync(join(root, "config.turri.web.yaml"), "coding-model: p/web\n");
    expect(moduleConfigsOf(root)).toEqual(["web"]);
    expect(readProjectConfig(root, "web").codingModel).toEqual({ model: "p/web" });
  });

  it("is read afresh after an edit to the same size within the same tick of the file system's clock", () => {
    const file = join(root, "config.turri.yaml");
    // Linux stamps a file to the tick of its clock, milliseconds apart: the edit has the stamp the first write had.
    const tick = new Date(Math.floor(Date.now() / 1000) * 1000 + 2000);
    writeFileSync(file, "coding-model: p/eu\n");
    utimesSync(file, tick, tick);
    expect(readProjectConfig(root).codingModel).toEqual({ model: "p/eu" });
    writeFileSync(file, "coding-model: p/jp\n");
    utimesSync(file, tick, tick);
    expect(readProjectConfig(root).codingModel).toEqual({ model: "p/jp" });
  });
});

describe("keys turri does not read", () => {
  it("are named, by file, for config.turri.yaml and each module's - a removed setting and a misspelt one - never config.yaml's", () => {
    writeFileSync(join(root, "config.turri.yaml"), "coding-model: p/small\ntest-advisor: true\nturn_limit: 3\n");
    writeFileSync(join(root, "config.turri.web.yaml"), "unittest-script: run.sh\n");
    writeFileSync(join(root, "config.yaml"), "another-tools-key: 1\n");
    expect(unknownConfigKeys(root)).toEqual([
      { file: "config.turri.web.yaml", keys: ["unittest-script"] },
      { file: "config.turri.yaml", keys: ["test-advisor"] },
    ]);
    expect(unknownConfigLines(root)[1]).toBe(
      "config.turri.yaml has a key turri does not read - test-advisor: no setting turri has, so it does nothing. Take it out, or see docs/config.md for the spelling.",
    );
  });

  it("are none in a config of turri's own keys", () => {
    writeFileSync(join(root, "config.turri.yaml"), "harness-model: p/big\ncoding-model: p/small\nconformance-tests: true\nmodels:\n  judge: p/big\n");
    expect(unknownConfigKeys(root)).toEqual([]);
  });
});
