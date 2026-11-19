import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerSettings, type LiveHooks } from "../src/settings.ts";
import { modelSpec, projectModels, readProjectConfig } from "../src/config.ts";
import { createJobRegistry } from "../src/regenerate/jobs.ts";

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "turri-settings-")));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** What the settings tool gives back. */
type ToolResult = { content: Array<{ text: string }> };

/** /settings and the settings tool registered on a stand-in pi, with a chat that answers its dialogs from `answers` in turn. */
function setUp(answers: string[] = []) {
  let command: { handler: (args: string, ctx: never) => Promise<void>; getArgumentCompletions?: (prefix: string) => unknown } | undefined;
  let tool: { execute: (id: string, params: unknown, signal: undefined, onUpdate: undefined, ctx: never) => Promise<ToolResult> } | undefined;
  const pi = {
    on: () => {},
    registerCommand: (name: string, options: typeof command) => {
      if (name === "settings") command = options;
    },
    registerTool: (options: typeof tool) => {
      tool = options;
    },
  };
  const said: string[] = [];
  const asked: Array<{ title: string; options?: string[] }> = [];
  const live: Array<[string, unknown]> = [];
  const hooks: LiveHooks = {
    chatModel: async (spec) => (live.push(["chat", spec]), `The conversation runs on ${spec} now.`),
    codingModel: () => (live.push(["coding", undefined]), "Chosen this session, and given way to the config: --coding-model x."),
    parallelJobs: (count) => (live.push(["parallel", count]), `Up to ${count} pulses run at once now.`),
  };
  registerSettings(pi as never, { cwd: dir, rules: () => ["concise-specs", "integrations"], chatSpec: () => modelSpec(projectModels(readProjectConfig(dir)).harness), live: hooks });
  const models = [
    { provider: "openai", id: "gpt-6-astra", name: "GPT-6 Astra" },
    { provider: "openai", id: "gpt-6-luna", name: "GPT-6 Luna" },
  ];
  const ctx = {
    hasUI: true,
    modelRegistry: { getAvailable: () => models, getAll: () => models, hasConfiguredAuth: () => true },
    ui: {
      notify: (message: string) => said.push(message),
      select: async (title: string, options: string[]) => (asked.push({ title, options }), answers.shift()),
      input: async (title: string) => (asked.push({ title }), answers.shift()),
    },
  };
  const call = async (params: { key?: string; value?: string; module?: string }) => (await tool!.execute("id", params, undefined, undefined, ctx as never)).content[0]!.text;
  return { run: (args: string) => command!.handler(args, ctx as never), complete: (prefix: string) => command!.getArgumentCompletions!(prefix), call, said, asked, live };
}

describe("/settings", () => {
  it("sets a setting given whole, in config.turri.yaml, and says when it takes effect", async () => {
    const { run, said } = setUp();
    await run("review false");
    expect(readFileSync(join(dir, "config.turri.yaml"), "utf8")).toBe("review: false\n");
    expect(said[0]).toBe("review: false - written to config.turri.yaml, in effect from the next pulse - one running now keeps what it started with.");
    await run("review unset");
    expect(readProjectConfig(dir).review).toBeUndefined();
    expect(said[1]).toContain("review unset - true");
  });

  it("copies the config.yaml turri read until now to config.turri.yaml before its first setting, and says so", async () => {
    writeFileSync(join(dir, "config.yaml"), "mutation-testing: false\n");
    const { run, said } = setUp();
    await run("review false");
    expect(readFileSync(join(dir, "config.yaml"), "utf8")).toBe("mutation-testing: false\n");
    expect(readFileSync(join(dir, "config.turri.yaml"), "utf8")).toBe("mutation-testing: false\nreview: false\n");
    expect(said[0]).toContain("config.yaml was copied to config.turri.yaml first");
  });

  it("lists every setting with what it is now, then asks for the value as the setting takes it", async () => {
    writeFileSync(join(dir, "config.yaml"), "review: false\n");
    const { run, asked, said } = setUp(["testing-scripts-run-on: (unset - in-place)", "copy"]);
    await run("");
    expect(asked[0]!.options).toContain("review: false");
    expect(asked[0]!.options!.at(-2)).toContain("models.<role>");
    expect(asked[0]!.options!.at(-1)).toContain("pi's own settings");
    expect(asked[1]!.options).toEqual(["in-place", "copy", "unset - in-place"]);
    expect(readProjectConfig(dir).testingScriptsRunOn).toBe("copy");
    expect(said[0]).toContain("in effect from the next test run");
  });

  it("switches the conversation's model now, offering the models this machine can reach and how hard it thinks", async () => {
    const { run, asked, live, said } = setUp(["openai/gpt-6-astra", "medium"]);
    await run("harness-model");
    expect(asked[0]!.options!.slice(0, 2)).toEqual(["openai/gpt-6-astra", "openai/gpt-6-luna"]);
    expect(projectModels(readProjectConfig(dir)).harness).toEqual({ model: "openai/gpt-6-astra", thinking: "medium" });
    expect(live).toEqual([["chat", "openai/gpt-6-astra:medium"]]);
    expect(said[0]).toContain("in effect now");
    expect(said[0]).toContain("The conversation runs on openai/gpt-6-astra:medium now.");
  });

  it("refuses a model this machine cannot reach, and writes nothing", async () => {
    const { run, said } = setUp();
    await run("coding-model acme/robot");
    expect(said[0]).toContain("acme/robot is not a model turri can reach here");
    expect(() => readFileSync(join(dir, "config.yaml"))).toThrow();
  });

  it("lets the coding model chosen this session give way, and changes how many pulses run at once now", async () => {
    const { run, live, said } = setUp();
    await run("models.coding openai/gpt-6-luna:low");
    expect(live[0]).toEqual(["coding", undefined]);
    expect(said[0]).toContain("given way to the config");
    await run("parallel-jobs 3");
    expect(live[1]).toEqual(["parallel", 3]);
    expect(said[1]).toContain("in effect now");
  });

  it("turns rules on and off one at a time, a tick on each left out, then done", async () => {
    const { run, asked } = setUp(["  integrations", "done"]);
    await run("rules-off");
    expect(asked[0]!.options).toEqual(["done", "  concise-specs", "  integrations", "unset - none"]);
    expect(asked[1]!.options).toContain("✓ integrations");
    expect(readProjectConfig(dir).rulesOff).toEqual(["integrations"]);
  });

  it("completes a setting's name, then the values it takes", () => {
    const { complete } = setUp();
    expect((complete("rev") as Array<{ value: string }>).map((item) => item.value)).toEqual(["review "]);
    expect((complete("review ") as Array<{ value: string }>).map((item) => item.value)).toEqual(["review true", "review false", "review unset"]);
    expect((complete("testing-scripts-run-on c") as Array<{ value: string }>).map((item) => item.value)).toEqual(["testing-scripts-run-on copy"]);
  });

  it("says when there is no such setting, and which it may have meant", async () => {
    const { run, said } = setUp();
    await run("reviews false");
    expect(said[0]).toBe("No setting reviews. /settings alone lists them.");
    await run("model false");
    expect(said[1]).toContain("Did you mean harness-model, coding-model, judge-model");
  });
});

describe("the settings tool", () => {
  it("sets the coding model by the name the user said it, checked as it is written, and says when it takes effect", async () => {
    const { call, live } = setUp();
    const said = await call({ key: "coding-model", value: "gpt 6 luna:high" });
    expect(readFileSync(join(dir, "config.turri.yaml"), "utf8")).toBe("coding-model: openai/gpt-6-luna:high\n");
    expect(said).toContain("written to config.turri.yaml, in effect from the next pulse");
    expect(live).toEqual([["coding", undefined]]);
  });

  it("asks which model was meant when a name fits several, and writes nothing", async () => {
    const { call } = setUp();
    await expect(call({ key: "coding-model", value: "gpt 6" })).rejects.toThrow(/Nothing was written[\s\S]*openai\/gpt-6-astra[\s\S]*openai\/gpt-6-luna/);
    expect(() => readFileSync(join(dir, "config.turri.yaml"))).toThrow();
  });

  it("refuses what is the user's alone - conformance tests, credentials, folders past the sandbox, the sentinel - and points to /settings", async () => {
    const { call } = setUp();
    for (const key of ["conformance-tests", "agent-env.vars", "toolchains", "sentinel", "rules-off", "ledger-keep"]) {
      await expect(call({ key, value: "true" })).rejects.toThrow(`/settings ${key}`);
    }
    expect(() => readFileSync(join(dir, "config.turri.yaml"))).toThrow();
  });

  it("writes into a module's own file when one is named, and refuses there what is the whole project's", async () => {
    writeFileSync(join(dir, "config.turri.yaml"), "review: true\n");
    const { call } = setUp();
    const said = await call({ key: "unittests-script", value: "test_scripts/run_unittests_python.sh", module: "backend.plain" });
    expect(readFileSync(join(dir, "config.turri.backend.yaml"), "utf8")).toBe("unittests-script: test_scripts/run_unittests_python.sh\n");
    expect(said).toContain("written to config.turri.backend.yaml");
    expect(said).toContain("backend.plain and every module built on it");
    await expect(call({ key: "parallel-jobs", value: "2", module: "backend" })).rejects.toThrow("the whole project's");
  });

  it("keeps a path inside the project", async () => {
    const { call } = setUp();
    await expect(call({ key: "base-folder", value: "../elsewhere" })).rejects.toThrow("inside the project");
    await expect(call({ key: "base-folder", value: "/etc" })).rejects.toThrow("inside the project");
  });

  it("says every setting and what each module's file sets over it, or one setting and what it takes", async () => {
    writeFileSync(join(dir, "config.turri.yaml"), "review: false\n");
    writeFileSync(join(dir, "config.turri.frontend.yaml"), "coding-model: openai/gpt-6-luna\n");
    const { call } = setUp();
    const all = await call({});
    expect(all).toContain("review: false");
    expect(all).toContain("conformance-tests: (unset - false) - the user's to change");
    expect(all).toContain("config.turri.frontend.yaml, over it for frontend.plain and the modules built on it: coding-model: openai/gpt-6-luna");
    const one = await call({ key: "coding-model" });
    expect(one).toContain("config.turri.yaml: unset; config.turri.frontend.yaml: openai/gpt-6-luna.");
  });
});

describe("the job registry's slots", () => {
  it("starts the pulses waiting for a slot once there are more slots", async () => {
    const jobs = createJobRegistry({ maxRunning: 1 });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    jobs.start({ kind: "regenerate", summary: "a", lanes: ["a"], run: async () => (await gate, { report: "" }) });
    const second = jobs.start({ kind: "regenerate", summary: "b", lanes: ["b"], run: async () => ({ report: "" }) });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(jobs.get(second.id)!.status).toBe("queued");
    jobs.setMaxRunning(2);
    await jobs.wait(second.id);
    expect(jobs.get(second.id)!.status).toBe("succeeded");
    release();
  });
});
