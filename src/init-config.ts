import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism, homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { load as loadYaml } from "js-yaml";
import { adoptLegacyConfig, CONFIG_FILE, CONFIG_KEYS, LEGACY_CONFIG_FILE, ROLE_THINKING, type AgentRole } from "./config.ts";
import { withTopLevelValue } from "./config-edit.ts";
import { brand } from "./brand.ts";
import { closestModels, piModelCatalogue, type CatalogueModel, type ModelCatalogue } from "./model-check.ts";

/**
 * `turri init-config`: a project's first config.turri.yaml - the two models, a strong one to talk to and a smaller one to
 * write the code - so a new project starts with a choice that works rather than an empty file. It asks which vendor's
 * models you use and fills in theirs. Every other setting is written out with the value turri uses for it (DEFAULTS),
 * so the file says how the project is built; the optional ones, which have no value of their own - the testing
 * scripts, `module`, `judge-model`, `models` - are there commented out, with an example. docs/config.md has them all.
 *
 * Then it says what to do next: where the file is - turri reads it from that folder and the folders below it, nowhere
 * else - and how to sign in to the vendor so pi, which turri runs on, can reach the models.
 *
 * Amazon Bedrock serves many makers' models - Anthropic's, OpenAI's, xAI's, Meta's... - each in a geography, an inference
 * profile its id starts with (`global.`, `us.`, `eu.`, ...), or in the AWS region it is called in: it asks whose, where, and
 * which two, from pi's catalogue - turri's own pair offered where it has one. The two models can be given instead, any pair
 * pi's catalogue has, and are checked against it. A config.turri.yaml already there keeps everything but the two models; a
 * new one takes from a config.yaml beside it the keys turri reads too.
 */

/** A vendor whose models the quick start config is filled in with. */
export type Vendor = "anthropic" | "openai" | "google" | "amazon-bedrock" | "other";

/** Whose models Amazon Bedrock serves: the maker a model's id names after its geography - anthropic, openai, xai, meta... */
export type BedrockMaker = string;

/**
 * Amazon Bedrock's choice: the geography of the inference profile the models run in, and whose they are - read from the
 * models when they are given, Anthropic's when nothing says.
 */
export interface BedrockChoice {
  maker?: BedrockMaker;
  region: string;
}

/** The three models a config names: the one you talk to, the one that codes, and a strong one for the judging examples. */
export interface ModelSet {
  harness: string;
  coding: string;
  strong: string;
}

/** The two models given, full specs without a thinking level - `amazon-bedrock/global.xai.grok-4.7`; strong is harness unless named. */
export type ModelChoice = Omit<ModelSet, "strong"> & { strong?: string };

/** The makers turri has a pair of its own for on Bedrock. */
type PresetMaker = "anthropic" | "openai";

/** The geographies turri's own pair for each maker is served in - the first the default. Every other: bedrockMakers. */
export const BEDROCK_REGIONS: Record<PresetMaker, string[]> = {
  anthropic: ["global", "us", "eu", "jp", "au"],
  openai: ["global", "us"],
};

/** The geographies an inference profile's id starts with, in the order they are offered. */
export const BEDROCK_GEOGRAPHIES = ["global", "us", "eu", "jp", "au", "apac", "in", "ca", "us-gov"];

/** A Bedrock model whose id names no geography: served in the AWS region it is called in. */
export const BEDROCK_IN_REGION = "in-region";

/** An AWS region in each geography, for AWS_REGION: pi calls Bedrock there - us-east-1 when nothing names another. */
const AWS_REGION_IN: Record<string, string> = {
  global: "us-east-1",
  us: "us-east-1",
  eu: "eu-central-1",
  jp: "ap-northeast-1",
  au: "ap-southeast-2",
  apac: "ap-southeast-1",
  in: "ap-south-1",
  ca: "ca-central-1",
  "us-gov": "us-gov-west-1",
};

/** The AWS region to call a geography's models in - AWS_REGION's value. */
export function bedrockAwsRegion(geography: string): string {
  return AWS_REGION_IN[geography] ?? "us-east-1";
}

/**
 * Whether a geography's models need AWS_REGION set: every one but global, us and in-region, which pi's us-east-1 serves.
 * pi calls Bedrock in AWS_REGION, else - with an AWS_PROFILE - the profile's region, else us-east-1. It pins eu's
 * endpoint itself only with neither AWS_REGION nor AWS_PROFILE set, so eu needs it too.
 */
export function bedrockNeedsAwsRegion(geography: string): boolean {
  return !["global", "us", BEDROCK_IN_REGION].includes(geography);
}

/** Where a Bedrock model is served and whose it is, from its id or spec: `global.xai.grok-4.7` - global, xai; `meta.llama4` - in-region, meta. */
export function bedrockPlaceOf(model: string): { geography: string; maker: BedrockMaker } {
  const [first = "", second = ""] = model.replace(/^amazon-bedrock\//, "").split(".");
  return BEDROCK_GEOGRAPHIES.includes(first) ? { geography: first, maker: second } : { geography: BEDROCK_IN_REGION, maker: first };
}

/** A maker's name, as the messages and questions say it. */
const MAKER_LABELS: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  xai: "xAI",
  meta: "Meta",
  mistral: "Mistral",
  qwen: "Qwen",
  deepseek: "DeepSeek",
  amazon: "Amazon",
  moonshot: "Moonshot",
  moonshotai: "Moonshot AI",
  zai: "Z.ai",
  minimax: "MiniMax",
  nvidia: "NVIDIA",
  writer: "Writer",
};

/** A maker's - or a provider's - name, as the messages say it: xAI for xai; its id when turri has no name for it. */
export function makerLabel(maker: string): string {
  return MAKER_LABELS[maker] ?? maker;
}

/** A maker pi's catalogue serves on Bedrock, and the geographies it serves its chat models in - in the order they are offered. */
export interface BedrockOffer {
  maker: BedrockMaker;
  label: string;
  regions: string[];
}

/** Bedrock's chat models in pi's catalogue. */
const bedrockChat = (catalogue: ModelCatalogue) => catalogue.models("amazon-bedrock").filter((model) => model.type === "chat");

/** Every maker pi's catalogue serves on Bedrock - Anthropic and OpenAI first, the rest by name - with their geographies. */
export function bedrockMakers(catalogue: ModelCatalogue): BedrockOffer[] {
  const regions = new Map<string, Set<string>>();
  for (const model of bedrockChat(catalogue)) {
    const { geography, maker } = bedrockPlaceOf(model.id);
    if (maker === "") continue;
    regions.set(maker, (regions.get(maker) ?? new Set()).add(geography));
  }
  const order = [...BEDROCK_GEOGRAPHIES, BEDROCK_IN_REGION];
  const first = (maker: string) => (maker === "anthropic" ? 0 : maker === "openai" ? 1 : 2);
  return [...regions]
    .map(([maker, served]) => ({ maker, label: makerLabel(maker), regions: order.filter((region) => served.has(region)) }))
    .sort((a, b) => first(a.maker) - first(b.maker) || a.label.localeCompare(b.label));
}

/** A maker's chat models in a geography, as pi's catalogue has them on Bedrock. */
export function bedrockModelsIn(catalogue: ModelCatalogue, choice: Required<BedrockChoice>): CatalogueModel[] {
  return bedrockChat(catalogue).filter((model) => {
    const place = bedrockPlaceOf(model.id);
    return place.maker === choice.maker && place.geography === choice.region;
  });
}

/** Whether turri's own pair for the maker is served in the geography. */
function hasPreset(choice: BedrockChoice): choice is { maker?: PresetMaker; region: string } {
  const maker = choice.maker ?? BEDROCK_DEFAULT.maker;
  return (maker === "anthropic" || maker === "openai") && BEDROCK_REGIONS[maker].includes(choice.region);
}

/** turri's own pair on Bedrock for a maker in a geography: Opus 5.5 and Haiku 5.5, or GPT-6 Astra and Luna. */
export function bedrockModels(choice: { maker?: PresetMaker; region: string }): ModelSet {
  const at = (id: string) => `amazon-bedrock/${choice.region}.${id}`;
  return (choice.maker ?? "anthropic") === "anthropic"
    ? { harness: at("anthropic.claude-opus-5-5"), coding: at("anthropic.claude-haiku-5-5"), strong: at("anthropic.claude-opus-5-5") }
    : { harness: at("openai.gpt-6-astra"), coding: at("openai.gpt-6-luna"), strong: at("openai.gpt-6.1-sol") };
}

/**
 * The pair to offer for a maker in a geography: turri's own where it has one; else, from pi's catalogue, the strongest
 * that reasons to talk to - price standing in for strength - and the cheapest costing at least a fifth of it to code,
 * ties to the newest. Undefined when the catalogue has none of the maker's models there.
 */
export function bedrockDefaultModels(catalogue: ModelCatalogue, choice: BedrockChoice): ModelSet | undefined {
  if (hasPreset(choice)) return bedrockModels(choice);
  const models = bedrockModelsIn(catalogue, { maker: choice.maker ?? BEDROCK_DEFAULT.maker, region: choice.region });
  if (models.length === 0) return undefined;
  const price = (model: CatalogueModel) => model.cost.input + model.cost.output;
  const newest = (a: CatalogueModel, b: CatalogueModel) => b.id.localeCompare(a.id, undefined, { numeric: true });
  const reasoning = models.some((model) => model.reasoning) ? models.filter((model) => model.reasoning) : models;
  const talk = [...reasoning].sort((a, b) => price(b) - price(a) || newest(a, b))[0]!;
  const code = models.filter((model) => price(model) >= price(talk) / 5).sort((a, b) => price(a) - price(b) || newest(a, b))[0]!;
  const spec = (model: CatalogueModel) => `amazon-bedrock/${model.id}`;
  return { harness: spec(talk), coding: spec(code), strong: spec(talk) };
}

/** Bedrock's default: Anthropic's models, anywhere. */
export const BEDROCK_DEFAULT: Required<BedrockChoice> = { maker: "anthropic", region: "global" };

interface VendorPreset {
  label: string;
  /** The model you talk to: it writes the specs and plans the work. */
  harness: string;
  /** The smaller, cheaper one that writes the code. */
  coding: string;
  /** A strong model for the commented-out judge, reviewer and debugger examples. */
  strong: string;
  /** The environment variables pi reads the vendor's keys from - pi's own names (pi.dev, providers). */
  keys: Array<{ vendor: string; variable: string }>;
}

export const VENDORS: Record<Vendor, VendorPreset> = {
  anthropic: {
    label: "Anthropic",
    harness: "anthropic/claude-opus-5-5",
    coding: "anthropic/claude-haiku-5-5",
    strong: "anthropic/claude-sonnet-5-5",
    keys: [{ vendor: "Anthropic", variable: "ANTHROPIC_API_KEY" }],
  },
  openai: {
    label: "OpenAI",
    harness: "openai/gpt-6-astra",
    coding: "openai/gpt-6-luna",
    strong: "openai/gpt-6.1-sol",
    keys: [{ vendor: "OpenAI", variable: "OPENAI_API_KEY" }],
  },
  google: {
    label: "Google",
    harness: "google/gemini-3.1-pro-preview",
    coding: "google/gemini-3.1-flash-lite",
    strong: "google/gemini-3.1-pro-preview",
    keys: [{ vendor: "Google", variable: "GEMINI_API_KEY" }],
  },
  // Any maker's models on AWS - whose, where and which, is asked: this is the default, Anthropic's anywhere.
  "amazon-bedrock": {
    label: "Amazon Bedrock",
    ...bedrockModels({ maker: "anthropic", region: BEDROCK_DEFAULT.region }),
    keys: [{ vendor: "AWS", variable: "AWS_PROFILE" }],
  },
  // A mix - the strongest to talk to, a cheap one to code - and the starting point for any other provider pi supports.
  other: {
    label: "Other",
    harness: "anthropic/claude-opus-5-5",
    coding: "google/gemini-3.1-flash-lite",
    strong: "google/gemini-3.1-pro-preview",
    keys: [
      { vendor: "Anthropic", variable: "ANTHROPIC_API_KEY" },
      { vendor: "Google", variable: "GEMINI_API_KEY" },
    ],
  },
};

/** A config line's text, padded to where its comment starts - at least one space before it. */
const column = (text: string, width: number) => (text.length >= width ? `${text} ` : text.padEnd(width));

/** How hard the model you talk to thinks, as written: the conversation, the planner and the rest of its side. */
const HARNESS_THINKING = "medium";

/** A role's commented-out entry: its model, and the thinking it has unless one is named - as turri runs it unset. */
function role(name: AgentRole, model: string | undefined, comment: string): string {
  const fields = [...(model !== undefined ? [`model: ${model}`] : []), `thinking: ${ROLE_THINKING[name]}`].join(", ");
  return `${column(`#   ${name}: { ${fields} }`, 72)}# ${comment}`;
}

/** A vendor's three models - for Bedrock, turri's own pair for the maker and geography chosen. */
function modelsOf(vendor: Vendor, bedrock?: BedrockChoice): ModelSet {
  if (vendor !== "amazon-bedrock") return VENDORS[vendor];
  const choice = bedrock ?? BEDROCK_DEFAULT;
  if (!hasPreset(choice)) throw new Error(`turri has no pair of its own for ${choice.maker ?? BEDROCK_DEFAULT.maker}'s models on Bedrock (${choice.region}): name the two models`);
  return bedrockModels(choice);
}

/** The two model lines: the one you talk to thinking medium, the coding one low - their comments in one column. */
function modelLines(harness: string, coding: string): [string, string] {
  const width = Math.max(46, `harness-model: ${harness}:${HARNESS_THINKING}`.length + 2, `coding-model: ${coding}:${ROLE_THINKING.coding}`.length + 2);
  return [
    `${column(`harness-model: ${harness}:${HARNESS_THINKING}`, width)}# you talk to it: it writes the specs and plans the work`,
    `${column(`coding-model: ${coding}:${ROLE_THINKING.coding}`, width)}# it writes the code`,
  ];
}

/**
 * A config.turri.yaml with its two models set to these lines, and nothing else changed: each key's line - and the lines
 * indented under it, when it is written as a block - replaced where it is, or put at the top when it is not there.
 */
export function withModels(text: string, lines: [string, string]): string {
  let out = text.split("\n");
  const missing: string[] = [];
  for (const [key, line] of [["harness-model", lines[0]], ["coding-model", lines[1]]] as const) {
    const at = out.findIndex((entry) => entry.startsWith(`${key}:`));
    if (at === -1) {
      missing.push(line);
      continue;
    }
    let end = at + 1;
    while (end < out.length && /^\s+\S/.test(out[end]!)) end += 1;
    out = [...out.slice(0, at), line, ...out.slice(end)];
  }
  return [...missing, ...out].join("\n");
}

/**
 * What turri does with each setting the config leaves out, written into the quick start config so it says so. They
 * must stay what the code falls back to - tests/init-config.test.ts holds them to the constants they mirror.
 */
export const DEFAULTS = {
  review: false,
  mutationTesting: true,
  allowToStopJobs: true,
  releaseAfterPulse: true,
  sentinel: "ask",
  testAdvisor: true,
  testingScriptsRunOn: "in-place",
  turnLimit: 120,
  compactAt: 100000,
  maxSpecsPerPulse: 3,
  maxLinesPerPulse: 120,
  ledgerKeep: 100,
  debug: false,
  cacheKeep: 4096,
} as const;

/** How many pulses run at once without a setting: half this machine's cores, one to four - as regenerate/jobs.ts has it. */
export function defaultParallel(cores: number = availableParallelism()): number {
  return Math.min(4, Math.max(1, Math.floor(cores / 2)));
}

/** The quick start config.turri.yaml for a vendor's models - for Bedrock, the maker and geography chosen - or the models given. */
export function quickStartConfig(vendor: Vendor = "other", bedrock?: BedrockChoice, models?: ModelSet): string {
  const { harness, coding, strong } = models ?? modelsOf(vendor, bedrock);
  return [
    "# Any model pi supports works (https://pi.dev): a capable one to talk to, a smaller, cheaper one for the coding.",
    ...modelLines(harness, coding),
    "# The :level is how hard each thinks - off, minimal, low, medium, high, xhigh or max. The reviews and judges run on the",
    "# coding model but think medium, as models: below shows.",
    "",
    "# Every other setting is written out below with the value turri uses for it, so the file says how the project is",
    "# built: change one to change it. The optional ones, which have no value of their own, are commented out - uncomment",
    "# one to use it. docs/config.md has them all.",
    "",
    "# Whether the code and its tests are reviewed once they pass - two reviews at most, the second weighed by the arbiter.",
    `review: ${DEFAULTS.review}`,
    "",
    "# Whether the coding agent and the reviewer can put a bug in the code for one run of the unit tests (can_it_fail),",
    "# to see that a test catches it - on a copy of the code, or in place and put back after.",
    `mutation-testing: ${DEFAULTS.mutationTesting}`,
    "",
    "# Whether turri stops a running pulse the spec has moved on from. false: it lands, the change regenerated on top.",
    `allow-to-stop-jobs: ${DEFAULTS.allowToStopJobs}`,
    "",
    "# Whether every pulse that lands code releases it, as the project's release guidance says.",
    `release-after-pulse: ${DEFAULTS.releaseAfterPulse}`,
    "",
    "# Whether a chat of its own, the sentinel, checks every pulse that finishes - and, with release-after-pulse, tests what",
    "# was released - and tells you in the chat you are in when something needs you. ask: you are asked, with what it does,",
    "# before it first opens in a session; true: it opens without asking; false: none.",
    `sentinel: ${DEFAULTS.sentinel}`,
    "",
    "# Whether turri checks, in the background, each new or changed functional spec with no scenarios - could it fail",
    "# silently, be read two ways, cost a lot when wrong - and when it needs testing, writes its test reqs, conformance",
    "# testing script and scenarios itself. false: only the scenarios you ask for are written.",
    `test-advisor: ${DEFAULTS.testAdvisor}`,
    "",
    "# What the testing scripts run on: in-place - the code itself; copy - a fresh copy of it.",
    `testing-scripts-run-on: ${DEFAULTS.testingScriptsRunOn}`,
    "",
    "# Seconds each agent turn has, for every role without its own; 0 for none.",
    `turn-limit: ${DEFAULTS.turnLimit}`,
    "",
    "# How many pulses run at once, on modules that share nothing - half this machine's cores, one to four.",
    `parallel-jobs: ${defaultParallel()}`,
    "",
    "# Tokens of work an agent holds before it is compacted between turns; at least 1000.",
    `compact-at: ${DEFAULTS.compactAt}`,
    "",
    "# How big a pulse may be: the most functional specs the planner groups into one, and the most lines of spec - its",
    "# functional specs with the definitions they bring - before a group is split again.",
    `max-specs-per-pulse: ${DEFAULTS.maxSpecsPerPulse}`,
    `max-lines-per-pulse: ${DEFAULTS.maxLinesPerPulse}`,
    "",
    "# Rules left out of the spec-writing agents' prompts - the files of genome/rules/, without .md. The integration rules",
    "# are left out to start with: take one out of this list when this project writes an integration against a REST API.",
    "rules-off: [integration-embedded, integration-embedded-testing, integration-standalone]",
    "",
    "# Credentials the agents' commands need while they work: dotenv files by path, and variables from turri's",
    "# environment by name - files: [.env], vars: [MY_SERVICE_API_KEY]. Their values are masked in everything an agent is shown.",
    "agent-env:",
    "  files: []",
    "  vars: []",
    "",
    "# Folders of this machine an agent's commands may read beside the usual ones - a toolchain somewhere unusual: [/srv/zig].",
    "toolchains: []",
    "",
    "# Megabytes of the ledger - what turri did, as facts, in .turri/ledger, never committed - the project keeps; past it,",
    "# the oldest runs' are pruned. 0 keeps none.",
    `ledger-keep: ${DEFAULTS.ledgerKeep}`,
    "",
    "# Megabytes of package caches - npm's, pip's, Maven's... in plain_modules/.turri/cache - the project keeps; past it,",
    "# the least recently written are removed. 0 keeps none.",
    `cache-keep: ${DEFAULTS.cacheKeep}`,
    "",
    "# Whether turri keeps what it writes for debugging it: every agent's whole log and session, each pulse's log, the",
    "# test runs' outputs, the agents' temporary files. Off, only what turri reads to work is kept. TURRI_DEBUG=1 for one run.",
    `debug: ${DEFAULTS.debug}`,
    "",
    "# The testing scripts, by path from the project root - written here by the skill that writes them. One not named is",
    "# looked for at the root, then in test_scripts/. Each runs the static checks of what it tests - the formatter, the",
    "# linter, the type checker - with the tests, exiting 80 when the tests pass and only the checks do not. The prepare",
    "# script, optional, runs on the build before every conformance testing script run.",
    "# unittests-script: test_scripts/run_unittests_python.sh",
    "# conformance-tests-script: test_scripts/run_conformance_tests_python.sh",
    "# prepare-environment-script: test_scripts/prepare_environment_python.sh",
    "",
    "# Optional: the .plain file turri regenerate builds when none is named.",
    "# module: app.plain",
    "",
    "# Optional: the folder of the test plain files - a functional spec's conformance and acceptance scenarios - a folder",
    "# per module in it: tests/<module>/<func-id>.plain. Without it, tests.",
    "# test-dir: tests",
    "",
    "# Optional: the judge and test review of a conformance run, when not on coding-model. A model is provider/id,",
    "# provider/id:thinking, or { model, thinking } - thinking is off, minimal, low, medium, high, xhigh or max.",
    `# judge-model: ${strong}:high`,
    "",
    "# Optional: each agent role's own model, thinking and turn limit. Without it, every role runs on coding-model and the",
    "# conversation's side on harness-model, each thinking as written here. What an entry leaves out it takes from default.",
    "# models:",
    `#   default: ${coding}`,
    `${column(`#   chat: ${harness}`, 72)}# the conversation - as harness-model, which it wins over`,
    `${column(`#   sentinel: ${harness}`, 72)}# the sentinel: checks every finished pulse and tests the release`,
    role("planner", harness, "cuts the work into pulses"),
    role("diagnosis", harness, "looks into a pulse that failed for good"),
    role("release", coding, "turri release's agent, and release-after-pulse's"),
    `${column(`#   coding: { model: ${coding}, thinking: ${ROLE_THINKING.coding}, turn-limit: 180 }`, 72)}# as coding-model, which it wins over`,
    role("conformance", coding, "writes the conformance tests"),
    role("explorer", coding, "explores the code for a conformance run"),
    role("reviewer", undefined, "reviews the code and its unit tests"),
    role("test-reviewer", strong, "reviews the conformance tests"),
    role("judge", strong, "judges a failing conformance run - as judge-model, which it wins over"),
    role("arbiter", strong, "weighs a second review"),
    role("debugger", strong, "a fresh look at unit tests that keep failing the same way"),
    role("advisor", coding, "the test advisor: which functional specs need scenarios, and writing them"),
    "",
  ].join("\n");
}

/** The quick start config for the mix of vendors: what turri wrote before it asked. */
export const QUICK_START_CONFIG = quickStartConfig("other");

/** A vendor from what was typed: its number in the list, or its name. */
export function vendorOf(answer: string): Vendor | undefined {
  const typed = answer.trim().toLowerCase();
  const names = Object.keys(VENDORS) as Vendor[];
  const byNumber = /^\d+$/.test(typed) ? names[Number(typed) - 1] : undefined;
  if (typed === "bedrock" || typed === "aws") return "amazon-bedrock";
  return byNumber ?? names.find((name) => name === typed || VENDORS[name].label.toLowerCase() === typed);
}

/** The makers offered, as numbered: pi's catalogue's, or without it turri's two. */
function makersOffered(catalogue?: ModelCatalogue): BedrockOffer[] {
  return catalogue !== undefined
    ? bedrockMakers(catalogue)
    : (Object.keys(BEDROCK_REGIONS) as PresetMaker[]).map((maker) => ({ maker, label: makerLabel(maker), regions: BEDROCK_REGIONS[maker] }));
}

/** Bedrock's maker from what was typed: its number in the list - with no catalogue, 1 Anthropic, 2 OpenAI - or its name. */
export function bedrockMakerOf(answer: string, catalogue?: ModelCatalogue): BedrockMaker | undefined {
  const typed = answer.trim().toLowerCase();
  const offered = makersOffered(catalogue);
  const byNumber = /^\d+$/.test(typed) ? offered[Number(typed) - 1] : undefined;
  return (byNumber ?? offered.find((offer) => offer.maker === typed || offer.label.toLowerCase() === typed))?.maker;
}

/** A geography the maker's models are served in, from what was typed: its number in the list, or its name - pi's catalogue's, or without it turri's pair's. */
export function bedrockRegionOf(maker: BedrockMaker, answer: string, catalogue?: ModelCatalogue): string | undefined {
  const typed = answer.trim().toLowerCase();
  const regions = makersOffered(catalogue).find((offer) => offer.maker === maker)?.regions ?? [];
  return (/^\d+$/.test(typed) ? regions[Number(typed) - 1] : undefined) ?? regions.find((region) => region === typed);
}

/** The shell profile an exported key is kept in, for the shell this person uses. */
function shellProfile(): string {
  const shell = basename(process.env.SHELL ?? "");
  if (shell === "zsh") return "~/.zshrc";
  if (shell === "fish") return "~/.config/fish/config.fish";
  return "~/.bashrc";
}

/** How to sign in to the vendor's models, as pi takes them: a key in the environment, or /login - a few lines. */
function signInText(vendor: Vendor, bedrock?: BedrockChoice, models?: ModelSet): string[] {
  // Models given on another vendor's terms - other's, a provider of their own: the keys of the providers they name.
  const providers = models !== undefined && vendor === "other" ? [...new Set([models.harness, models.coding].map((model) => model.split("/")[0]!))] : [];
  const keys =
    providers.length > 0
      ? providers.flatMap((provider) => (provider in VENDORS && provider !== "other" && provider !== "amazon-bedrock" ? VENDORS[provider as Vendor].keys : [{ vendor: makerLabel(provider), variable: "" }]))
      : VENDORS[vendor].keys;
  const windows = process.platform === "win32";
  const set = (variable: string, value = "...") => brand.accent(windows ? `setx ${variable} "${value}"` : `export ${variable}=${value}`);
  // Bedrock's are several; a vendor's own key is one, or the mix's two.
  const several = vendor === "amazon-bedrock" || keys.length > 1;
  const keep = windows
    ? `setx keeps ${several ? "them" : "it"} for new terminals - open one before you run turri.`
    : `Add ${several ? "them" : "it"} to ${shellProfile()} to keep ${several ? "them" : "it"}.`;
  if (vendor === "amazon-bedrock") {
    const geography = (bedrock ?? BEDROCK_DEFAULT).region;
    const region = bedrockAwsRegion(geography);
    return [
      brand.bold("Sign in to AWS"),
      `  ${set("AWS_PROFILE")}   ${brand.muted("your profile (aws configure, or aws sso login)")}`,
      `  ${set("AWS_REGION", region)}`,
      `  ${brand.muted("or, instead of a profile, a Bedrock API key:")} ${set("AWS_BEARER_TOKEN_BEDROCK")}`,
      "",
      brand.muted(keep),
      ...(bedrockNeedsAwsRegion(geography)
        ? [brand.muted(`AWS_REGION has to be in ${geography}'s geography, as ${region} is: pi calls Bedrock in us-east-1 unless it - or the profile - names another.`)]
        : []),
      brand.muted("Your AWS account needs access to the models: Bedrock console, model access."),
    ];
  }
  return [
    brand.bold(`Sign in to ${keys.map((key) => key.vendor).join(" and ")}`),
    ...keys.map((key) => (key.variable !== "" ? `  ${set(key.variable)}` : `  ${brand.muted(`the key pi reads for ${key.vendor} - https://pi.dev`)}`)),
    "",
    brand.muted(`${keep} Or start turri and type /login.`),
    ...(vendor === "other" && models === undefined ? [brand.muted("Another provider: change the two models to any pi supports, and set its key - https://pi.dev.")] : []),
  ];
}

/** Names joined as a sentence says them: "a", "a and b", "a, b and c". */
const and = (names: string[]) => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

/**
 * Whose models these are, in the message - from the models written: "OpenAI's models", "a mix of models", "xAI's models
 * on Amazon Bedrock (global)", "Anthropic's and OpenAI's models" for a pair of two providers given.
 */
function whose(vendor: Vendor, models: ModelSet, given: boolean): string {
  const pair = [models.harness, models.coding];
  if (vendor === "amazon-bedrock") {
    const places = pair.map(bedrockPlaceOf);
    const makers = [...new Set(places.map((place) => `${makerLabel(place.maker)}'s`))];
    return `${and(makers)} models on Amazon Bedrock (${[...new Set(places.map((place) => place.geography))].join(", ")})`;
  }
  if (vendor !== "other") return `${VENDORS[vendor].label}'s models`;
  if (!given) return "a mix of models";
  return `${and([...new Set(pair.map((model) => `${makerLabel(model.split("/")[0]!)}'s`))])} models`;
}

/** The thinking levels a spec may end with - not part of a model given to init-config. */
const THINKING = /:(off|minimal|low|medium|high|xhigh|max)$/;

/** Why a model given cannot be written - or undefined when pi's catalogue has it as a chat model. */
function notInCatalogue(spec: string, catalogue: ModelCatalogue): string | undefined {
  const slash = spec.indexOf("/");
  if (slash <= 0) return `${spec} is not provider/model-id - amazon-bedrock/global.xai.grok-4.7, say.`;
  const [provider, id] = [spec.slice(0, slash), spec.slice(slash + 1)];
  const known = catalogue.models(provider);
  const model = known.find((entry) => entry.id === id);
  if (model === undefined) {
    if (THINKING.test(id) && known.some((entry) => entry.id === id.replace(THINKING, ""))) return `${spec} names a thinking level: give the model alone, ${spec.replace(THINKING, "")} - turri writes how hard each thinks.`;
    if (known.length === 0) return `${spec} is not in pi's model catalogue: pi knows no provider ${provider}.`;
    const close = closestModels(id, known.filter((entry) => entry.type === "chat").map((entry) => entry.id));
    return `${spec} is not in pi's model catalogue${close.length > 0 ? ` - did you mean ${close.map((other) => `${provider}/${other}`).join(", ")}?` : "."}`;
  }
  if (model.type !== "chat") return `${spec} is pi's ${model.type} model, not a chat model: turri's agents need one to talk to.`;
  return undefined;
}

/** Whose models a vendor's are: the provider its specs start with. */
const providerOf = (vendor: Vendor) => (vendor === "other" ? undefined : vendor);

/**
 * The models to write, and the vendor and Bedrock choice they are written for - or what is wrong with what was given:
 * models given, checked against pi's catalogue; a Bedrock maker or geography turri has no pair of its own for, the
 * catalogue's default pair; otherwise the vendor's own, as before, no catalogue read.
 */
async function chosenModels(options: InitConfigOptions): Promise<{ vendor: Vendor; bedrock?: BedrockChoice; models: ModelSet; given: boolean } | { problem: string }> {
  const catalogue = async () => options.catalogue ?? (await piModelCatalogue());
  if (options.models !== undefined) {
    const { harness, coding } = options.models;
    const models: ModelSet = { harness, coding, strong: options.models.strong ?? harness };
    const known = await catalogue();
    const problems = [...new Set([models.harness, models.coding, models.strong])].map((spec) => notInCatalogue(spec, known)).filter((problem) => problem !== undefined);
    if (problems.length > 0) return { problem: problems.join("\n") };
    const providers = [...new Set(Object.values(models).map((spec) => spec.split("/")[0]!))];
    const vendor = options.vendor ?? (providers.length === 1 && providers[0]! in VENDORS ? (providers[0] as Vendor) : "other");
    const wrong = [...new Set(Object.values(models))].filter((spec) => providerOf(vendor) !== undefined && spec.split("/")[0] !== providerOf(vendor));
    if (wrong.length > 0) return { problem: `${wrong.join(", ")} ${wrong.length === 1 ? "is not" : "are not"} ${VENDORS[vendor].label}'s: with vendor ${vendor}, every model is ${vendor}/... - or leave the vendor out.` };
    if (vendor !== "amazon-bedrock") return { vendor, models, given: true };
    const places = [models.harness, models.coding].map(bedrockPlaceOf);
    const region = options.bedrock?.region ?? places[0]!.geography;
    if (!places.some((place) => place.geography === region)) return { problem: `Neither model is served in ${region} on Bedrock: ${models.harness} and ${models.coding} are ${and([...new Set(places.map((place) => place.geography))])}'s.` };
    const maker = options.bedrock?.maker ?? places[0]!.maker;
    if (!places.some((place) => place.maker === maker)) return { problem: `Neither model is ${makerLabel(maker)}'s: ${models.harness} and ${models.coding}.` };
    return { vendor, bedrock: { maker, region }, models, given: true };
  }
  const vendor = options.vendor ?? "other";
  if (vendor !== "amazon-bedrock") return { vendor, models: modelsOf(vendor), given: false };
  const bedrock: Required<BedrockChoice> = { maker: options.bedrock?.maker ?? BEDROCK_DEFAULT.maker, region: options.bedrock?.region ?? BEDROCK_DEFAULT.region };
  if (hasPreset(bedrock)) return { vendor, bedrock, models: bedrockModels(bedrock), given: false };
  const known = await catalogue();
  const offer = bedrockMakers(known).find((entry) => entry.maker === bedrock.maker);
  if (offer === undefined) return { problem: `pi's catalogue has no models of ${makerLabel(bedrock.maker)}'s on Amazon Bedrock.` };
  const models = bedrockDefaultModels(known, bedrock);
  if (models === undefined) return { problem: `Amazon Bedrock serves ${offer.label}'s models in ${and(offer.regions)}, not ${bedrock.region}.` };
  return { vendor, bedrock, models, given: false };
}

/**
 * What a config.yaml in `folder` says that turri reads too - another tool's testing scripts, say - by turri's names
 * (`template_dir` read as `template-dir`), in the file's order; and the keys it leaves, turri reading none of them. The
 * two models are the vendor's, so they are not taken.
 */
export function sharedWithLegacy(folder: string): { carried: Array<[string, unknown]>; left: string[] } {
  const path = join(folder, LEGACY_CONFIG_FILE);
  if (!existsSync(path)) return { carried: [], left: [] };
  let raw: unknown;
  try {
    raw = loadYaml(readFileSync(path, "utf8"));
  } catch {
    return { carried: [], left: [] };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { carried: [], left: [] };
  const known = new Set<string>(Object.values(CONFIG_KEYS));
  const models = new Set<string>([CONFIG_KEYS.harnessModel, CONFIG_KEYS.codingModel, "model"]);
  const carried: Array<[string, unknown]> = [];
  const left: string[] = [];
  for (const [written, value] of Object.entries(raw as Record<string, unknown>)) {
    const key = written.replace(/_/g, "-");
    if (models.has(key) || value === null || value === undefined) continue;
    if (known.has(key)) carried.push([key, value]);
    else left.push(written);
  }
  return { carried, left };
}

export interface InitConfigOptions {
  /** Write the whole file again, not only the two models of one already there. */
  force?: boolean;
  /** Whose models: read from the models when they are given, other when nothing says. */
  vendor?: Vendor;
  /** On Amazon Bedrock: the geography, and whose models - read from the models when they are given. */
  bedrock?: BedrockChoice;
  /** The two models - any pair pi's catalogue has as chat models - in place of the vendor's own. */
  models?: ModelChoice;
  /** pi's catalogue, to check the models against - read from pi when it is needed and not given. */
  catalogue?: ModelCatalogue;
}

/**
 * Write the quick start config.turri.yaml in `dir`, with what a config.yaml beside it says that turri reads too. One already
 * there keeps everything but its two models, which are set to the vendor's - or the ones given - and `force` writes the
 * whole of it again. Says what it did; a model pi's catalogue does not have writes nothing and says so.
 */
export async function initConfig(dir: string, options: InitConfigOptions = {}): Promise<{ written: boolean; message: string }> {
  const chosen = await chosenModels(options);
  if ("problem" in chosen) return { written: false, message: chosen.problem };
  const { vendor, bedrock, models, given } = chosen;
  const folder = resolve(dir);
  // The old stacks' files, config.<stack>.yaml, copied to their new names; config.turri.yaml is written below.
  adoptLegacyConfig(folder, { projectFile: false });
  const path = join(folder, CONFIG_FILE);
  const existing = existsSync(path) && options.force !== true;
  const { harness, coding } = models;
  const lines = modelLines(harness, coding);
  // A new file takes what a config.yaml beside it - another tool's, say - says that turri reads too: its testing scripts, say.
  const shared = existing ? { carried: [], left: [] } : sharedWithLegacy(folder);
  const config = existing
    ? withModels(readFileSync(path, "utf8"), lines)
    : shared.carried.reduce((text, [key, value]) => withTopLevelValue(text, key, value), quickStartConfig(vendor, bedrock, models));
  writeFileSync(path, config);
  const here = resolve(process.cwd()) === folder;
  const [talk, code] = [harness, coding].map((model, at) => `${model}:${at === 0 ? HARNESS_THINKING : ROLE_THINKING.coding}`);
  return {
    written: true,
    message: [
      "",
      `${brand.success("✓")} ${existing ? `Set the two models in ${brand.bold(path)}` : `Wrote ${brand.bold(path)}`}`,
      `  ${brand.muted(`with ${whose(vendor, models, given)}${existing ? " - everything else in it left as it was (--force writes it all again)" : ""}`)}`,
      "",
      `  ${brand.muted("you talk to")}   ${talk}`,
      `  ${brand.muted("it codes")}      ${code}`,
      ...(shared.carried.length > 0
        ? [
            "",
            brand.muted(
              `Took from ${LEGACY_CONFIG_FILE} what turri reads too - ${shared.carried.map(([key]) => key).join(", ")}.` +
                (shared.left.length > 0 ? ` Not taken, turri does not read them: ${shared.left.join(", ")}.` : ""),
            ),
          ]
        : []),
      "",
      ...signInText(vendor, bedrock, given ? models : undefined),
      "",
      brand.bold("Then"),
      ...(here ? [] : [`  ${brand.accent(`cd ${folder}`)}`]),
      `  ${brand.accent("turri doctor")}   ${brand.muted("checks the models answer with your credentials")}`,
      `  ${brand.accent("turri")}`,
      "",
      brand.muted(`turri reads this config when it starts in ${here ? "this folder" : folder} or one below it.`),
      brand.muted(`Every other setting is in the file at its default - docs/config.md has them all.`),
      "",
    ].join("\n"),
  };
}

const USAGE = [
  "usage: turri init-config [--vendor anthropic|openai|google|amazon-bedrock|other] [--maker <maker>] [--region <geography>]",
  "                         [--harness-model <spec> --coding-model <spec> [--judge-model <spec>]] [--force] [folder]",
  "",
  "Write a quick start config.turri.yaml in the folder, the current one by default: the model you talk to and the one that",
  "writes the code, from the vendor you use. Asked when --vendor is not given and this is a terminal; otherwise other -",
  "a mix of Anthropic and Google, the starting point for any provider pi supports. On amazon-bedrock, --maker and",
  "--region say whose models and where - any maker and geography pi's catalogue has there (anthropic, openai, xai, meta,",
  "...; global, us, eu, jp, au, apac, in, ca, us-gov, or in-region) - asked when not given, then which two, turri's own",
  "pair or the catalogue's offered first. --harness-model and --coding-model name the two instead, as provider/model-id",
  "without a thinking level - amazon-bedrock/global.xai.grok-4.7 - any pi's catalogue has; --judge-model the strong one",
  "the judging examples name, the harness model unless given. The vendor, maker and region are read from them.",
  "A config.turri.yaml already there keeps everything but its two models; --force writes the whole of it again. A new",
  "one takes from a config.yaml beside it - another tool's, say - the keys turri reads too, its testing scripts say, and leaves",
  "config.yaml as it is.",
].join("\n");

/** Ask until the answer is one `read` takes. */
async function askUntil<T>(rl: ReturnType<typeof createInterface>, prompt: string, read: (answer: string) => T | undefined, again: string): Promise<T> {
  for (;;) {
    const chosen = read(await rl.question(prompt));
    if (chosen !== undefined) return chosen;
    console.log(again);
  }
}

/** A model's price, as the list of models shows it: dollars a million tokens in and out. */
const priced = (model: CatalogueModel) => `$${model.cost.input}/$${model.cost.output} a million tokens in/out${model.reasoning ? "" : ", no reasoning"}`;

/** What the choice of vendor asked: the vendor, and for Amazon Bedrock whose, where and which two. */
interface Asked {
  /** Left out with the models named: read from them. */
  vendor?: Vendor;
  bedrock?: BedrockChoice;
  models?: ModelChoice;
}

/**
 * Ask which vendor's models to use - a number or a name - and, for Amazon Bedrock, whose and where, from pi's catalogue,
 * then which two: the pair offered taken with Enter, or chosen from the maker's models there. What is given is not asked.
 */
async function askVendor(given: { vendor?: Vendor; maker?: BedrockMaker; region?: string }, catalogue: () => Promise<ModelCatalogue>): Promise<Asked> {
  const names = Object.keys(VENDORS) as Vendor[];
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  /** A question: a blank line before it, its choices numbered, each with what it is. */
  const ask = (question: string, choices: Array<[string, string]>) => {
    console.log(`\n${brand.bold(brand.accent(question))}`);
    const width = Math.max(...choices.map(([label]) => label.length)) + 3;
    choices.forEach(([label, what], index) => console.log(`  ${brand.accent(`${String(index + 1).padStart(String(choices.length).length)}`)}  ${label.padEnd(width)}${brand.muted(what)}`));
  };
  const choose = (count: number) => `\n${brand.muted(`Choose 1-${count}:`)} `;
  try {
    let vendor = given.vendor;
    if (vendor === undefined) {
      ask(
        "Which vendor's models do you use?",
        names.map((name) => {
          const { label, harness, coding } = VENDORS[name];
          const what =
            name === "amazon-bedrock"
              ? "Anthropic's, OpenAI's, xAI's, Meta's... models on AWS"
              : `${name === "other" ? "a mix - " : ""}${harness.split("/")[1]} to talk to, ${coding.split("/")[1]} to code`;
          return [label, what];
        }),
      );
      vendor = await askUntil(rl, choose(names.length), vendorOf, `Type a number from 1 to ${names.length}, or a vendor's name.`);
    }
    if (vendor !== "amazon-bedrock") return { vendor };
    const known = await catalogue();
    const makers = bedrockMakers(known);
    let maker = given.maker;
    if (maker === undefined) {
      ask(
        "Whose models, on Amazon Bedrock?",
        makers.map((offer) => {
          const own = offer.maker === "anthropic" || offer.maker === "openai" ? bedrockModels({ maker: offer.maker, region: "global" }) : undefined;
          return [offer.label, own !== undefined ? `${own.harness.split(".").slice(2).join(".")} to talk to, ${own.coding.split(".").slice(2).join(".")} to code` : offer.regions.join(", ")];
        }),
      );
      maker = await askUntil(rl, choose(makers.length), (answer) => bedrockMakerOf(answer, known), `Type a number from 1 to ${makers.length}, or a maker's name.`);
    }
    const regions = makers.find((offer) => offer.maker === maker)?.regions ?? [];
    let region = given.region !== undefined ? bedrockRegionOf(maker, given.region, known) : undefined;
    if (region === undefined) {
      ask(
        "Which region?",
        regions.map((entry) => [entry, entry === "global" ? "wherever Bedrock has room" : entry === BEDROCK_IN_REGION ? "the AWS region it is called in" : ""]),
      );
      region = await askUntil(rl, choose(regions.length), (answer) => bedrockRegionOf(maker!, answer, known), `Type a number from 1 to ${regions.length}, or one of ${regions.join(", ")}.`);
    }
    const bedrock = { maker, region };
    const offered = bedrockDefaultModels(known, bedrock);
    const models = bedrockModelsIn(known, bedrock);
    if (offered === undefined || models.length < 2) return { vendor, bedrock };
    const bare = (spec: string) => spec.replace(/^amazon-bedrock\//, "");
    console.log(`\n${brand.bold(brand.accent("Which models?"))}`);
    console.log(`  ${bare(offered.harness)} ${brand.muted("to talk to,")} ${bare(offered.coding)} ${brand.muted("to code")}`);
    const keep = (await rl.question(`\n${brand.muted("Enter takes them; c chooses others:")} `)).trim().toLowerCase();
    if (keep !== "c") return { vendor, bedrock };
    ask("The model you talk to - it writes the specs and plans the work", models.map((model) => [model.id, priced(model)]));
    const pick = (fallback: string) => (answer: string) => {
      const typed = answer.trim();
      if (typed === "") return fallback;
      const model = (/^\d+$/.test(typed) ? models[Number(typed) - 1] : undefined) ?? models.find((entry) => entry.id === typed);
      return model !== undefined ? `amazon-bedrock/${model.id}` : undefined;
    };
    const atOf = (spec: string) => models.findIndex((model) => `amazon-bedrock/${model.id}` === spec) + 1;
    const again = `Type a number from 1 to ${models.length}, or Enter for the one offered.`;
    const harness = await askUntil(rl, `\n${brand.muted(`Choose 1-${models.length}, Enter for ${atOf(offered.harness)}:`)} `, pick(offered.harness), again);
    ask("The model that writes the code - a smaller, cheaper one", models.map((model) => [model.id, priced(model)]));
    const coding = await askUntil(rl, `\n${brand.muted(`Choose 1-${models.length}, Enter for ${atOf(offered.coding)}:`)} `, pick(offered.coding), again);
    return { vendor, bedrock, models: { harness, coding, ...(harness === offered.harness ? { strong: offered.strong } : {}) } };
  } finally {
    rl.close();
  }
}

/** A flag's value: `--name value` or `--name=value`, and where the value was, to leave it out of the folder. */
function flagOf(args: string[], name: string): { value?: string; at: number[] } {
  const index = args.findIndex((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`));
  if (index === -1) return { at: [] };
  return args[index]!.includes("=") ? { value: args[index]!.slice(args[index]!.indexOf("=") + 1), at: [index] } : { value: args[index + 1], at: [index, index + 1] };
}

/** `turri init-config [--vendor <vendor>] [--maker <maker>] [--region <geography>] [--harness-model <spec> --coding-model <spec>] [--force] [folder]`. */
export async function main(args: string[]): Promise<number> {
  if (args.includes("-h") || args.includes("--help")) {
    console.log(USAGE);
    return 0;
  }
  const flags = {
    vendor: flagOf(args, "vendor"),
    maker: flagOf(args, "maker"),
    region: flagOf(args, "region"),
    harness: flagOf(args, "harness-model"),
    coding: flagOf(args, "coding-model"),
    judge: flagOf(args, "judge-model"),
  };
  const taken = new Set(Object.values(flags).flatMap((flag) => flag.at));
  const rest = args.filter((arg, index) => !arg.startsWith("-") && !taken.has(index));
  const folder = rest[0] ?? process.cwd();
  if (!existsSync(folder)) {
    console.error(`${folder} does not exist.`);
    return 1;
  }
  let vendor: Vendor | undefined;
  if (flags.vendor.value !== undefined) {
    vendor = vendorOf(flags.vendor.value);
    if (vendor === undefined) {
      console.error(`Not a vendor: ${flags.vendor.value}. One of ${Object.keys(VENDORS).join(", ")}.\n\n${USAGE}`);
      return 1;
    }
  }
  // pi's catalogue, read once and only when it is needed: models named, or a maker or region beyond turri's own pair.
  let read: ModelCatalogue | undefined;
  const catalogue = async () => (read ??= await piModelCatalogue());
  const [harness, coding, judge] = [flags.harness.value, flags.coding.value, flags.judge.value];
  if ((harness === undefined) !== (coding === undefined) || (judge !== undefined && harness === undefined)) {
    console.error(`Name both models - --harness-model and --coding-model - or neither.\n\n${USAGE}`);
    return 1;
  }
  const named: ModelChoice | undefined = harness !== undefined && coding !== undefined ? { harness, coding, ...(judge !== undefined ? { strong: judge } : {}) } : undefined;
  let maker: BedrockMaker | undefined;
  if (flags.maker.value !== undefined) {
    const typed = flags.maker.value.trim().toLowerCase();
    maker = bedrockMakerOf(typed, ["anthropic", "openai"].includes(typed) ? undefined : await catalogue());
    if (maker === undefined) {
      console.error(`Not a maker pi's catalogue has on Amazon Bedrock: ${flags.maker.value}. One of ${bedrockMakers(await catalogue()).map((offer) => offer.maker).join(", ")}.\n\n${USAGE}`);
      return 1;
    }
  }
  const region = flags.region.value?.trim().toLowerCase();
  if (region !== undefined && named === undefined) {
    const of = maker ?? BEDROCK_DEFAULT.maker;
    if (!hasPreset({ maker: of, region }) && bedrockRegionOf(of, region, await catalogue()) === undefined) {
      const regions = bedrockMakers(await catalogue()).find((offer) => offer.maker === of)?.regions ?? [];
      console.error(`Not a region ${makerLabel(of)}'s models run in on Bedrock: ${region}. One of ${regions.join(", ")}.`);
      return 1;
    }
  }
  const force = args.includes("--force");
  const asking = process.stdin.isTTY && process.stdout.isTTY && named === undefined;
  let chosen: Asked;
  try {
    chosen = await chooseVendor();
  } catch (error) {
    // Ctrl+C or Ctrl+D at a question: stopped, nothing written - not a crash.
    if ((error as { code?: string }).code === "ABORT_ERR") {
      console.log(`\n${brand.muted("Stopped - nothing written.")}`);
      return 1;
    }
    throw error;
  }
  async function chooseVendor(): Promise<Asked> {
    if (named !== undefined) {
      return {
        ...(vendor !== undefined ? { vendor } : {}),
        ...(maker !== undefined || region !== undefined ? { bedrock: { ...(maker !== undefined ? { maker } : {}), region: region ?? bedrockPlaceOf(named.harness).geography } } : {}),
        models: named,
      };
    }
    return asking && (vendor === undefined || (vendor === "amazon-bedrock" && (maker === undefined || region === undefined)))
      ? await askVendor({ ...(vendor !== undefined ? { vendor } : {}), ...(maker !== undefined ? { maker } : {}), ...(region !== undefined ? { region } : {}) }, catalogue)
      : {
          vendor: vendor ?? "other",
          ...(vendor === "amazon-bedrock" ? { bedrock: { maker: maker ?? BEDROCK_DEFAULT.maker, region: region ?? BEDROCK_DEFAULT.region } } : {}),
        };
  }
  const result = await initConfig(folder, {
    force,
    ...(chosen.vendor !== undefined ? { vendor: chosen.vendor } : {}),
    ...(chosen.bedrock !== undefined ? { bedrock: chosen.bedrock } : {}),
    ...(chosen.models !== undefined ? { models: chosen.models } : {}),
    ...(read !== undefined ? { catalogue: read } : {}),
  });
  (result.written ? console.log : console.error)(result.message);
  return result.written ? 0 : 1;
}
