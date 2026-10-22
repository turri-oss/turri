import { existsSync, mkdirSync, mkdtempSync, realpathSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_ROLES, CONFIG_KEYS, projectModels, readProjectConfig, ROLE_THINKING } from "../src/config.ts";
import {
  BEDROCK_REGIONS,
  bedrockAwsRegion,
  bedrockDefaultModels,
  bedrockMakers,
  bedrockMakerOf,
  bedrockModels,
  bedrockNeedsAwsRegion,
  bedrockPlaceOf,
  bedrockRegionOf,
  DEFAULTS, defaultParallel, initConfig, main, QUICK_START_CONFIG, quickStartConfig, VENDORS, vendorOf, withModels, type Vendor } from "../src/init-config.ts";
import { defaultParallelJobs } from "../src/regenerate/jobs.ts";
import { DEFAULT_COMPACT_AT, DEFAULT_TURN_LIMIT_MS } from "../src/pi.ts";
import { DEFAULT_LEDGER_KEEP_MB } from "../src/regenerate/ledger.ts";
import { MAX_LINES_PER_JOB, MAX_SPECS_PER_JOB } from "../src/regenerate/chunk-plan.ts";

// pi's catalogue is read from a folder of the test's own: never the real ~/.pi/agent, which reading it writes to.
let agentDir: string;
let previousAgentDir: string | undefined;
beforeAll(() => {
  agentDir = mkdtempSync(join(tmpdir(), "turri-init-config-pi-"));
  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
});
afterAll(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(agentDir, { recursive: true, force: true });
});

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "turri-init-config-")));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("turri init-config", () => {
  it("writes a config.turri.yaml with a strong model to talk to and a smaller one to write the code, as turri reads it", async () => {
    expect((await initConfig(dir)).written).toBe(true);
    expect(readFileSync(join(dir, "config.turri.yaml"), "utf8")).toBe(QUICK_START_CONFIG);
    const models = projectModels(readProjectConfig(dir));
    expect(models.harness?.model).toBe("anthropic/claude-opus-5-5");
    expect(models.coding?.model).toBe("google/gemini-3.1-flash-lite");
  });

  it("writes every other setting with the value turri uses for it, and the optional ones commented out - each read as written once uncommented", async () => {
    await initConfig(dir);
    const written = readFileSync(join(dir, "config.turri.yaml"), "utf8");
    expect(readProjectConfig(dir)).toMatchObject({
      conformanceTests: false,
      review: false,
      mutationTesting: true,
      allowToStopJobs: true,
      releaseAfterPulse: true,
      testingScriptsRunOn: "in-place",
      turnLimit: DEFAULTS.turnLimit,
      parallelJobs: defaultParallelJobs(),
      compactAt: DEFAULTS.compactAt,
      maxSpecsPerPulse: DEFAULTS.maxSpecsPerPulse,
      maxLinesPerPulse: DEFAULTS.maxLinesPerPulse,
      ledgerKeep: DEFAULTS.ledgerKeep,
      rulesOff: ["integration-embedded", "integration-embedded-testing", "integration-standalone"],
      toolchains: [],
    });
    // Commented out, the optional ones have no value.
    const config0 = readProjectConfig(dir);
    for (const key of ["module", "judgeModel", "models", "conformanceBudget", "unittestsScript", "conformanceTestsScript", "prepareEnvironmentScript"] as const) {
      expect(config0[key], key).toBeUndefined();
    }
    // agent-env with nothing in it is no agent-env.
    expect(config0.agentEnv).toBeUndefined();
    expect(written).not.toContain("unset");
    writeFileSync(join(dir, "config.turri.yaml"), written.replace(/^# (?=[a-z-]+:|  [a-z-]+:)/gm, ""));
    const config = readProjectConfig(dir);
    // agent-env is written out empty - its examples in its comment - so it alone has no value.
    for (const key of Object.keys(CONFIG_KEYS).filter((key) => key !== "agentEnv")) expect(config[key as keyof typeof config], key).toBeDefined();
    expect(Object.keys(config.models ?? {}).sort()).toEqual(["default", ...AGENT_ROLES].sort());
  });

  it("sets only the two models in a config.turri.yaml already there - everything else left as it was - unless told to write it all again", async () => {
    writeFileSync(join(dir, "config.turri.yaml"), "module: app.plain\nharness-model:\n  model: old/one\n  thinking: high\nconformance-tests: false\n");
    const result = await initConfig(dir, { vendor: "openai" });
    expect(result).toMatchObject({ written: true });
    expect(result.message).toContain("everything else in it left as it was");
    const text = readFileSync(join(dir, "config.turri.yaml"), "utf8");
    expect(text).toContain("module: app.plain");
    expect(text).toContain("conformance-tests: false");
    expect(text).not.toContain("old/one");
    const config = readProjectConfig(dir);
    expect(config.module).toBe("app.plain");
    expect(projectModels(config)).toMatchObject({ harness: { model: "openai/gpt-6-astra", thinking: "medium" }, coding: { model: "openai/gpt-6-luna", thinking: "low" } });
    expect((await initConfig(dir, { force: true })).written).toBe(true);
    expect(readFileSync(join(dir, "config.turri.yaml"), "utf8")).toBe(QUICK_START_CONFIG);
  });

  it("takes from another tool's config.yaml the keys turri reads too - each in its place in the quick start - and leaves the rest, and config.yaml, as they were", async () => {
    const other = [
      "template_dir: template",
      "prepare-environment-script: test_scripts/prepare_environment_java.sh",
      "unittests-script: test_scripts/run_unittests.sh",
      "conformance-tests-script: test_scripts/run_conformance_tests.sh",
      "verbose: true",
      "api: https://api.example.com",
      "coding-model: somebody/else",
      "",
    ].join("\n");
    writeFileSync(join(dir, "config.yaml"), other);
    const result = await initConfig(dir, { vendor: "openai" });
    expect(result.message).toContain("Took from config.yaml what turri reads too - prepare-environment-script, unittests-script, conformance-tests-script.");
    expect(result.message).toContain("Not taken, turri does not read them: template_dir, verbose, api.");
    expect(readFileSync(join(dir, "config.yaml"), "utf8")).toBe(other);
    const text = readFileSync(join(dir, "config.turri.yaml"), "utf8");
    // In its place: under its commented-out example, not at the end.
    expect(text.indexOf("unittests-script: test_scripts/run_unittests.sh")).toBeGreaterThan(text.indexOf("# unittests-script:"));
    expect(text).not.toContain("api:");
    expect(text).not.toContain("somebody/else");
    const config = readProjectConfig(dir);
    expect(config).toMatchObject({
      unittestsScript: "test_scripts/run_unittests.sh",
      conformanceTestsScript: "test_scripts/run_conformance_tests.sh",
      prepareEnvironmentScript: "test_scripts/prepare_environment_java.sh",
    });
    expect(projectModels(config).coding).toEqual({ model: "openai/gpt-6-luna", thinking: "low" });
  });

  it("takes a block - models:, agent-env: - whole, copies the old stacks' files to their new names, and takes nothing into a config.turri.yaml already there", async () => {
    writeFileSync(join(dir, "config.yaml"), "agent-env:\n  vars: [D365_TENANT_ID]\nreview: false\n");
    writeFileSync(join(dir, "config.backend.yaml"), "unittests-script: run_unittests_python.sh\n");
    await initConfig(dir, { vendor: "openai" });
    expect(readProjectConfig(dir)).toMatchObject({ agentEnv: { files: [], vars: ["D365_TENANT_ID"] }, review: false });
    expect(readFileSync(join(dir, "config.turri.backend.yaml"), "utf8")).toBe("unittests-script: run_unittests_python.sh\n");
    writeFileSync(join(dir, "config.yaml"), "conformance-tests: false\n");
    await initConfig(dir, { vendor: "openai" });
    // The file already there keeps its own conformance-tests, the quick start's.
    expect(readProjectConfig(dir).conformanceTests).toBe(false);
  });

  it("writes the values turri falls back to, so a setting written out does as one left out", async () => {
    expect(DEFAULTS.turnLimit * 1000).toBe(DEFAULT_TURN_LIMIT_MS);
    expect(DEFAULTS.compactAt).toBe(DEFAULT_COMPACT_AT);
    expect(DEFAULTS.maxSpecsPerPulse).toBe(MAX_SPECS_PER_JOB);
    expect(DEFAULTS.maxLinesPerPulse).toBe(MAX_LINES_PER_JOB);
    expect(DEFAULTS.ledgerKeep).toBe(DEFAULT_LEDGER_KEEP_MB);
    for (const cores of [1, 2, 7, 8, 32]) expect(defaultParallel(cores)).toBe(defaultParallelJobs(cores));
  });

  it("replaces a model key where it is, block and all, and puts one that is missing at the top", async () => {
    const lines: [string, string] = ["harness-model: a/b:medium", "coding-model: c/d:low"];
    expect(withModels("x: 1\nharness-model:\n  model: o/p\ny: 2\n", lines)).toBe("coding-model: c/d:low\nx: 1\nharness-model: a/b:medium\ny: 2\n");
  });

  it("fills in Amazon Bedrock's models for the maker and the region chosen - Opus and Haiku, or Astra and Luna - the coding one thinking low", async () => {
    expect(bedrockModels({ maker: "anthropic", region: "eu" })).toMatchObject({ harness: "amazon-bedrock/eu.anthropic.claude-opus-5-5", coding: "amazon-bedrock/eu.anthropic.claude-haiku-5-5" });
    expect(bedrockModels({ maker: "openai", region: "us" })).toMatchObject({ harness: "amazon-bedrock/us.openai.gpt-6-astra", coding: "amazon-bedrock/us.openai.gpt-6-luna" });
    const { message } = await initConfig(dir, { vendor: "amazon-bedrock", bedrock: { maker: "anthropic", region: "eu" } });
    expect(message).toContain("with Anthropic's models on Amazon Bedrock (eu)");
    expect(message).toContain("AWS_PROFILE");
    expect(message).toContain("AWS_BEARER_TOKEN_BEDROCK");
    expect(message).toContain("AWS_REGION=eu-central-1");
    expect(projectModels(readProjectConfig(dir))).toMatchObject({
      harness: { model: "amazon-bedrock/eu.anthropic.claude-opus-5-5", thinking: "medium" },
      coding: { model: "amazon-bedrock/eu.anthropic.claude-haiku-5-5", thinking: "low" },
    });
    // Only the regions each maker's models are served in.
    expect(BEDROCK_REGIONS.openai).toEqual(["global", "us"]);
    expect(bedrockRegionOf("openai", "eu")).toBeUndefined();
    expect(bedrockRegionOf("anthropic", "3")).toBe("eu");
    expect(bedrockMakerOf("2")).toBe("openai");
    expect(bedrockMakerOf("google")).toBeUndefined();
  });

  it("takes Amazon Bedrock's maker and region from --maker and --region without asking, and refuses a region the maker's models are not in", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(await main([dir, "--vendor", "bedrock", "--maker", "openai", "--region=us"])).toBe(0);
      expect(projectModels(readProjectConfig(dir)).coding?.model).toBe("amazon-bedrock/us.openai.gpt-6-luna");
      expect(await main([dir, "--vendor", "amazon-bedrock", "--maker", "openai", "--region", "eu"])).toBe(1);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("fills in the vendor's own models - each read as turri reads them, every role example its vendor's too", async () => {
    for (const vendor of Object.keys(VENDORS) as Vendor[]) {
      const sub = join(dir, vendor);
      mkdirSync(sub);
      await initConfig(sub, { vendor });
      const written = readFileSync(join(sub, "config.turri.yaml"), "utf8");
      expect(written).toBe(quickStartConfig(vendor));
      const models = projectModels(readProjectConfig(sub));
      expect(models.harness?.model, vendor).toBe(VENDORS[vendor].harness);
      expect(models.coding?.model, vendor).toBe(VENDORS[vendor].coding);
      // Uncommented, every model named is the vendor's - but for other, a mix of two.
      writeFileSync(join(sub, "config.turri.yaml"), written.replace(/^# (?=[a-z-]+:|  [a-z-]+:)/gm, ""));
      const named = Object.values(readProjectConfig(sub).models ?? {}).map((entry) => entry.model).filter((model) => model !== undefined);
      if (vendor !== "other") for (const model of named) expect(model!.split("/")[0], `${vendor}: ${model}`).toBe(vendor);
    }
    // Other is what turri wrote before it asked: a capable Anthropic model to talk to, a cheap Google one to code.
    expect(quickStartConfig("other")).toBe(QUICK_START_CONFIG);
  });

  it("shows how hard each role thinks unless a level is named - the work low, the judging medium - as turri runs them", async () => {
    await initConfig(dir, { vendor: "anthropic" });
    const written = readFileSync(join(dir, "config.turri.yaml"), "utf8");
    // The two models carry their level: the one you talk to medium, the coding one low - the judging on it medium.
    expect(written).toMatch(/^harness-model: anthropic\/claude-opus-5-5:medium +#/m);
    expect(written).toMatch(/^coding-model: anthropic\/claude-haiku-5-5:low +#/m);
    expect(written).toContain("The reviews and judges run on the\n# coding model but think medium");
    expect(projectModels(readProjectConfig(dir))).toMatchObject({ harness: { thinking: "medium" }, coding: { thinking: "low" } });
    expect(projectModels(readProjectConfig(dir)).judge).toEqual({ model: "anthropic/claude-haiku-5-5" });
    // The release follows steps: the coding model, thinking low.
    expect(written).toMatch(/^# {3}release: \{ model: anthropic\/claude-haiku-5-5, thinking: low \}/m);
    // Uncommented, each role thinks as turri has it think unset - so the file shows what applies.
    writeFileSync(join(dir, "config.turri.yaml"), written.replace(/^# (?=[a-z-]+:|  [a-z-]+:)/gm, ""));
    const models = readProjectConfig(dir).models ?? {};
    for (const [role, level] of Object.entries(ROLE_THINKING)) expect(models[role as keyof typeof models]?.thinking, role).toBe(level);
  });

  it("takes a vendor by its number in the list or its name, and nothing else", async () => {
    expect(vendorOf("1")).toBe("anthropic");
    expect(vendorOf(" OpenAI ")).toBe("openai");
    expect(vendorOf("3")).toBe("google");
    expect(vendorOf("4")).toBe("amazon-bedrock");
    expect(vendorOf("bedrock")).toBe("amazon-bedrock");
    expect(vendorOf("5")).toBe("other");
    expect(vendorOf("other")).toBe("other");
    expect(vendorOf("6")).toBeUndefined();
    expect(vendorOf("mistral")).toBeUndefined();
  });

  it("says in a few lines where it wrote the file, the two models, the key pi reads for the vendor or /login, and what to run next", async () => {
    const { message } = await initConfig(dir, { vendor: "openai" });
    expect(message).toContain(`✓ Wrote ${join(dir, "config.turri.yaml")}`);
    expect(message).toContain("with OpenAI's models");
    expect(message).toMatch(/you talk to +openai\/gpt-6-astra:medium/);
    expect(message).toMatch(/it codes +openai\/gpt-6-luna:low/);
    expect(message).toContain("export OPENAI_API_KEY=...");
    expect(message).toContain("type /login");
    expect(message).toContain(`turri reads this config when it starts in ${dir} or one below it.`);
    expect(message).toContain(`Then\n  cd ${dir}\n  turri doctor   checks the models answer with your credentials\n  turri`);
    // Written to a pipe, as here, it has no colours.
    expect(message).not.toContain("\x1b[");
    // Other names both keys, and that any provider pi supports will do.
    mkdirSync(join(dir, "mix"));
    const mix = (await initConfig(join(dir, "mix"))).message;
    expect(mix).toContain("ANTHROPIC_API_KEY");
    expect(mix).toContain("GEMINI_API_KEY");
    expect(mix).toContain("Another provider");
  });

  it("takes the vendor from --vendor without asking - in the current folder, or the one named, either way round", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const cwd = process.cwd();
    try {
      process.chdir(dir);
      expect(await main(["--vendor", "anthropic"])).toBe(0);
      expect(projectModels(readProjectConfig(dir)).coding?.model).toBe("anthropic/claude-haiku-5-5");
      mkdirSync(join(dir, "a"));
      mkdirSync(join(dir, "b"));
      expect(await main(["a", "--vendor=google"])).toBe(0);
      expect(projectModels(readProjectConfig(join(dir, "a"))).harness?.model).toBe("google/gemini-3.1-pro-preview");
      expect(await main(["--vendor", "openai", "b"])).toBe(0);
      expect(projectModels(readProjectConfig(join(dir, "b"))).harness?.model).toBe("openai/gpt-6-astra");
      expect(await main(["--vendor", "mistral", "b"])).toBe(1);
    } finally {
      process.chdir(cwd);
      vi.restoreAllMocks();
    }
  });
});

describe("turri init-config with the two models given", () => {
  const written = () => readFileSync(join(dir, "config.turri.yaml"), "utf8");

  it("writes them everywhere the vendor's own would be - a pair the presets do not have, the vendor, maker and geography read from them", async () => {
    const { written: wrote, message } = await initConfig(dir, { models: { harness: "amazon-bedrock/global.xai.grok-4.7", coding: "amazon-bedrock/global.xai.grok-4.6" } });
    expect(wrote).toBe(true);
    const text = written();
    expect(text).toMatch(/^harness-model: amazon-bedrock\/global\.xai\.grok-4\.7:medium +#/m);
    expect(text).toMatch(/^coding-model: amazon-bedrock\/global\.xai\.grok-4\.6:low +#/m);
    expect(text).toContain("# judge-model: amazon-bedrock/global.xai.grok-4.7:high");
    expect(text).toContain("#   default: amazon-bedrock/global.xai.grok-4.6");
    expect(text).not.toMatch(/claude|gemini|gpt/);
    expect(message).toContain("with xAI's models on Amazon Bedrock (global)");
    expect(message).toMatch(/you talk to +amazon-bedrock\/global\.xai\.grok-4\.7:medium/);
    expect(message).toMatch(/it codes +amazon-bedrock\/global\.xai\.grok-4\.6:low/);
    expect(message).toContain("AWS_REGION=us-east-1");
  });

  it("writes a pair the other way round from the preset - each where it belongs, never one for the other", async () => {
    await initConfig(dir, { vendor: "amazon-bedrock", models: { harness: "amazon-bedrock/us.openai.gpt-6-luna", coding: "amazon-bedrock/us.openai.gpt-6-astra" } });
    expect(projectModels(readProjectConfig(dir))).toMatchObject({
      harness: { model: "amazon-bedrock/us.openai.gpt-6-luna", thinking: "medium" },
      coding: { model: "amazon-bedrock/us.openai.gpt-6-astra", thinking: "low" },
    });
    const text = written();
    expect(text).toContain("#   default: amazon-bedrock/us.openai.gpt-6-astra");
    expect(text).toMatch(/^# {3}chat: amazon-bedrock\/us\.openai\.gpt-6-luna +#/m);
    expect(text).toMatch(/^# {3}planner: \{ model: amazon-bedrock\/us\.openai\.gpt-6-luna,/m);
    expect(text).toMatch(/^# {3}release: \{ model: amazon-bedrock\/us\.openai\.gpt-6-astra,/m);
    // The judging examples name the strong one: the harness model, none being given.
    expect(text).toMatch(/^# {3}judge: \{ model: amazon-bedrock\/us\.openai\.gpt-6-luna,/m);
  });

  it("writes the same file as the vendor's own when given the vendor's own models", async () => {
    for (const vendor of ["anthropic", "openai", "amazon-bedrock"] as const) {
      const [own, given] = [join(dir, `${vendor}-own`), join(dir, `${vendor}-given`)];
      mkdirSync(own);
      mkdirSync(given);
      await initConfig(own, { vendor });
      await initConfig(given, { models: VENDORS[vendor] });
      expect(readFileSync(join(given, "config.turri.yaml"), "utf8"), vendor).toBe(readFileSync(join(own, "config.turri.yaml"), "utf8"));
    }
  });

  it("refuses a model pi's catalogue does not have, or that is not a chat model, naming it and writing nothing", async () => {
    const unknown = await initConfig(dir, { models: { harness: "amazon-bedrock/global.xai.grok-9", coding: "amazon-bedrock/global.xai.grok-4.6" } });
    expect(unknown.written).toBe(false);
    expect(unknown.message).toContain("amazon-bedrock/global.xai.grok-9 is not in pi's model catalogue - did you mean amazon-bedrock/global.xai.grok-4.");
    expect(existsSync(join(dir, "config.turri.yaml"))).toBe(false);
    expect((await initConfig(dir, { models: { harness: "nobody/model", coding: "nobody/model" } })).message).toContain("pi knows no provider nobody");
    expect((await initConfig(dir, { models: { harness: "anthropic/claude-opus-5-5:high", coding: "anthropic/claude-haiku-5-5" } })).message).toContain("names a thinking level");
    expect((await initConfig(dir, { models: { harness: "cloudflare-workers-ai/@cf/cloudflare/clef", coding: "anthropic/claude-haiku-5-5" } })).message).toContain("not a chat model");
    expect((await initConfig(dir, { vendor: "openai", models: { harness: "anthropic/claude-opus-5-5", coding: "openai/gpt-6-luna" } })).message).toContain("is not OpenAI's");
    expect(existsSync(join(dir, "config.turri.yaml"))).toBe(false);
  });

  it("names the AWS region to set for a geography pi does not call in us-east-1 - Japan's, Australia's", async () => {
    for (const [geography, region] of [["jp", "ap-northeast-1"], ["au", "ap-southeast-2"]] as const) {
      const sub = join(dir, geography);
      mkdirSync(sub);
      const { message } = await initConfig(sub, { models: { harness: `amazon-bedrock/${geography}.anthropic.claude-opus-5-5`, coding: `amazon-bedrock/${geography}.anthropic.claude-haiku-5-5` } });
      expect(message).toContain(`with Anthropic's models on Amazon Bedrock (${geography})`);
      expect(message).toContain(`export AWS_REGION=${region}`);
      expect(message).toContain(`AWS_REGION has to be in ${geography}'s geography, as ${region} is`);
    }
    const global = (await initConfig(dir, { models: { harness: "amazon-bedrock/global.xai.grok-4.7", coding: "amazon-bedrock/global.xai.grok-4.6" } })).message;
    expect(global).not.toContain("has to be in");
  });

  it("has an AWS region for every geography pi's catalogue serves Bedrock's models in, and says which need AWS_REGION set", async () => {
    const { piModelCatalogue } = await import("../src/model-check.ts");
    const catalogue = await piModelCatalogue();
    const geographies = new Set(bedrockMakers(catalogue).flatMap((offer) => offer.regions));
    for (const geography of geographies) {
      if (bedrockNeedsAwsRegion(geography)) expect(bedrockAwsRegion(geography), geography).not.toBe("us-east-1");
    }
    expect([...geographies].filter((geography) => !bedrockNeedsAwsRegion(geography)).sort()).toEqual(["global", "in-region", "us"]);
    expect(bedrockAwsRegion("us-gov")).toBe("us-gov-west-1");
    expect(bedrockPlaceOf("amazon-bedrock/us-gov.openai.gpt-oss-120b-1:0")).toEqual({ geography: "us-gov", maker: "openai" });
    expect(bedrockPlaceOf("meta.llama4-maverick-17b-instruct-v1:0")).toEqual({ geography: "in-region", maker: "meta" });
  });

  it("offers turri's own pair where it has one, else the strongest that reasons to talk to and the cheapest costing a fifth of it to code", async () => {
    const { piModelCatalogue } = await import("../src/model-check.ts");
    const catalogue = await piModelCatalogue();
    expect(bedrockDefaultModels(catalogue, { maker: "anthropic", region: "eu" })).toEqual(bedrockModels({ maker: "anthropic", region: "eu" }));
    expect(bedrockDefaultModels(catalogue, { maker: "xai", region: "global" })).toEqual({
      harness: "amazon-bedrock/global.xai.grok-4.7",
      coding: "amazon-bedrock/global.xai.grok-4.7",
      strong: "amazon-bedrock/global.xai.grok-4.7",
    });
    expect(bedrockDefaultModels(catalogue, { maker: "xai", region: "eu" })).toBeUndefined();
    // Asked for a maker turri has no pair for, with no models, it writes the catalogue's.
    expect((await initConfig(dir, { vendor: "amazon-bedrock", bedrock: { maker: "xai", region: "global" } })).message).toContain("with xAI's models on Amazon Bedrock (global)");
    expect(projectModels(readProjectConfig(dir)).harness?.model).toBe("amazon-bedrock/global.xai.grok-4.7");
    expect((await initConfig(dir, { vendor: "amazon-bedrock", bedrock: { maker: "xai", region: "jp" } })).message).toContain("Amazon Bedrock serves xAI's models in global, us and in-region, not jp.");
    // The makers and geographies to choose from are the catalogue's.
    expect(bedrockMakerOf("xai", catalogue)).toBe("xai");
    expect(bedrockRegionOf("openai", "us-gov", catalogue)).toBe("us-gov");
  });

  it("takes the two models from --harness-model and --coding-model without asking", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(await main([dir, "--harness-model", "amazon-bedrock/global.xai.grok-4.7", "--coding-model=amazon-bedrock/global.xai.grok-4.6"])).toBe(0);
      expect(projectModels(readProjectConfig(dir)).coding?.model).toBe("amazon-bedrock/global.xai.grok-4.6");
      expect(await main([dir, "--harness-model", "amazon-bedrock/global.xai.grok-4.7"])).toBe(1);
      expect(await main([dir, "--vendor", "bedrock", "--maker", "xai", "--region", "us"])).toBe(0);
      expect(projectModels(readProjectConfig(dir)).harness?.model).toMatch(/^amazon-bedrock\/us\.xai\./);
      expect(await main([dir, "--harness-model", "openai/gpt-0", "--coding-model", "openai/gpt-6-luna"])).toBe(1);
      expect(error.mock.calls.flat().join("\n")).toContain("openai/gpt-0 is not in pi's model catalogue");
    } finally {
      vi.restoreAllMocks();
    }
  });
});
