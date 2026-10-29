import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readProjectConfig, stacksOf } from "./config.ts";
import { bedrockAwsRegion, bedrockNeedsAwsRegion, bedrockPlaceOf } from "./init-config.ts";
import { modelsInUse } from "./model-check.ts";

/**
 * The AWS region turri's Bedrock models are called in. pi calls Bedrock in AWS_REGION, else AWS_DEFAULT_REGION, else -
 * with an AWS_PROFILE - the profile's region, else the region of the model's endpoint in its catalogue, us-east-1
 * (pi-ai's bedrock-converse-stream.js). A model served in a geography that needs a region of its own - eu, jp, au, apac,
 * in, ca, us-gov - answers only when it is called in a region of that geography, so turri sets AWS_REGION itself, in
 * its own process, before any model is called: the terminal's chat, every command and a host's session alike. A region
 * the person set is never touched. The environment is the lever: pi's per-call `region` is not reachable from the
 * sessions pi makes itself - the chat's - so one region serves every model, and models that need two are said, not
 * guessed between.
 */

/** Where the region pi calls Bedrock in comes from. */
export type BedrockRegionSource =
  /** AWS_REGION or AWS_DEFAULT_REGION, set by the person. */
  | "set"
  /** AWS_REGION, set by turri for the geography the models need. */
  | "turri"
  /** The region of the AWS_PROFILE's profile. */
  | "profile"
  /** Nothing names one: pi's default, us-east-1. */
  | "default";

/** What turri does about the AWS region a project's Bedrock models are called in. */
export interface BedrockRegion {
  /** The region pi calls Bedrock in - undefined when the models need two regions and nothing names one, or the project uses no Bedrock model. */
  region?: string;
  source: BedrockRegionSource;
  /** The Bedrock models the project uses, each once. */
  models: string[];
  /** The region the models need, and its geography - when they need one, and one only. */
  needs?: { region: string; geography: string };
  /**
   * The models need more than one region: one AWS_REGION serves every model, so turri sets none, and says which model
   * needs which.
   */
  conflict?: Array<{ region: string; geography: string; models: string[] }>;
}

/** The variable turri marks its own AWS_REGION with, so the pi it starts - and a reload - tells it from the person's. */
export const TURRI_AWS_REGION = "TURRI_AWS_REGION";

/** pi's region when nothing names one. */
const DEFAULT_REGION = "us-east-1";

/** Whether a region is in a geography: one of the regions Bedrock serves that geography's inference profiles from. */
export function regionInGeography(region: string, geography: string): boolean {
  const exact: Record<string, string[]> = {
    jp: ["ap-northeast-1", "ap-northeast-3"],
    au: ["ap-southeast-2", "ap-southeast-4"],
    in: ["ap-south-1", "ap-south-2"],
  };
  if (exact[geography] !== undefined) return exact[geography]!.includes(region);
  const prefix: Record<string, string> = { eu: "eu-", apac: "ap-", ca: "ca-", "us-gov": "us-gov-", us: "us-" };
  if (prefix[geography] !== undefined) return region.startsWith(prefix[geography]!) && (geography !== "us" || !region.startsWith("us-gov-"));
  // global and in-region: any region serves them.
  return true;
}

/** The region an AWS profile names, from AWS_CONFIG_FILE or ~/.aws/config - undefined when it names none, or the file cannot be read. */
export function profileRegion(profile: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const file = env.AWS_CONFIG_FILE?.trim() || join(homedir(), ".aws", "config");
  if (!existsSync(file)) return undefined;
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  const wanted = profile === "default" ? ["default", "profile default"] : [`profile ${profile}`];
  let inside = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const section = /^\[\s*(.+?)\s*\]$/.exec(line);
    if (section !== null) {
      inside = wanted.includes(section[1]!.replace(/\s+/g, " "));
      continue;
    }
    if (!inside) continue;
    const setting = /^region\s*=\s*(\S+)/.exec(line);
    if (setting !== null) return setting[1];
  }
  return undefined;
}

/** The Bedrock models a project uses: every model its config names - each stack's too - and those given. */
function bedrockModels(projectDir: string, also: string[]): string[] {
  const configs = [readProjectConfig(projectDir), ...stacksOf(projectDir).map((stack) => readProjectConfig(projectDir, stack))];
  const specs = [...configs.flatMap((config) => modelsInUse(config).map((used) => used.spec)), ...also];
  return [...new Set(specs.filter((spec) => spec.startsWith("amazon-bedrock/")))];
}

/**
 * What turri does about the AWS region for a project, from the environment as it is - reading it, setting nothing.
 * `also`: models used besides the config's - named on the command line, chosen in this session.
 */
export function bedrockRegionFor(projectDir: string, options: { also?: string[]; env?: NodeJS.ProcessEnv } = {}): BedrockRegion {
  const env = options.env ?? process.env;
  const models = bedrockModels(projectDir, options.also ?? []);
  // The regions the models need, by region: a model served in global, us or in-region needs none.
  const needed = new Map<string, { geography: string; models: string[] }>();
  for (const model of models) {
    const { geography } = bedrockPlaceOf(model);
    if (!bedrockNeedsAwsRegion(geography)) continue;
    const region = bedrockAwsRegion(geography);
    needed.set(region, { geography, models: [...(needed.get(region)?.models ?? []), model] });
  }
  const conflict = needed.size > 1 ? [...needed].map(([region, { geography, models }]) => ({ region, geography, models })) : undefined;
  const [only] = needed.size === 1 ? [...needed] : [];
  const needs = only !== undefined ? { region: only[0], geography: only[1].geography } : undefined;
  const withConflict = { ...(conflict !== undefined ? { conflict } : {}), ...(needs !== undefined ? { needs } : {}) };

  // The person's region wins, always; turri's own is worked out again.
  const ours = env[TURRI_AWS_REGION];
  const set = env.AWS_REGION?.trim() || env.AWS_DEFAULT_REGION?.trim();
  if (set !== undefined && set !== "" && !(ours !== undefined && env.AWS_REGION === ours)) return { region: set, source: "set", models, ...withConflict };

  const profile = env.AWS_PROFILE?.trim();
  const fromProfile = profile !== undefined && profile !== "" ? profileRegion(profile, env) : undefined;
  // One region needed: the profile's, when it is in that geography; otherwise turri's.
  if (needs !== undefined) {
    if (fromProfile !== undefined && regionInGeography(fromProfile, needs.geography)) return { region: fromProfile, source: "profile", models, needs };
    return { region: needs.region, source: "turri", models, needs };
  }
  // None needed, or two: pi goes by the profile, or its default - with two, which is not one of them for every model.
  if (fromProfile !== undefined) return { region: fromProfile, source: "profile", models, ...withConflict };
  return { ...(models.length > 0 && conflict === undefined ? { region: DEFAULT_REGION } : {}), source: "default", models, ...withConflict };
}

/**
 * Set AWS_REGION for a project's Bedrock models, as `bedrockRegionFor` says: when they need a region and the person
 * set none. Done again when the models change, it moves or takes back what turri set before, never the person's.
 */
export function applyBedrockRegion(projectDir: string, options: { also?: string[]; env?: NodeJS.ProcessEnv } = {}): BedrockRegion {
  const env = options.env ?? process.env;
  let decided: BedrockRegion;
  try {
    decided = bedrockRegionFor(projectDir, { ...options, env });
  } catch {
    // A config that does not read is the model check's to say: nothing is set from it.
    return { source: "default", models: [] };
  }
  if (decided.source === "turri" && decided.region !== undefined) {
    env.AWS_REGION = decided.region;
    env[TURRI_AWS_REGION] = decided.region;
  } else if (decided.source !== "set" && env[TURRI_AWS_REGION] !== undefined) {
    // What turri set before is needed no more - or two regions are now: taken back, not guessed.
    if (env.AWS_REGION === env[TURRI_AWS_REGION]) delete env.AWS_REGION;
    delete env[TURRI_AWS_REGION];
  }
  return decided;
}

/** A line on the region, for a model check: what turri set and how to override it - or the conflict it would not guess. */
export function describeBedrockRegion(decided: BedrockRegion): string | undefined {
  if (decided.conflict !== undefined) {
    const needs = decided.conflict.map((each) => `${each.models.join(", ")} need${each.models.length === 1 ? "s" : ""} ${each.region} (${each.geography})`).join("; ");
    return `the Bedrock models need two AWS regions - ${needs} - and one AWS_REGION serves every model: turri set none. Use models of one geography, or global ones.`;
  }
  if (decided.region === undefined) return undefined;
  if (decided.source === "turri") return `turri calls Bedrock in ${decided.region}, the region the models' geography needs - AWS_REGION, set, overrides it`;
  if (decided.source === "set") {
    const outside = decided.needs !== undefined && !regionInGeography(decided.region, decided.needs.geography);
    return outside
      ? `pi calls Bedrock in ${decided.region}, set in AWS_REGION or AWS_DEFAULT_REGION - but the models are served in ${decided.needs!.geography}: set it to a region there, ${decided.needs!.region}, or unset it and turri sets it`
      : `pi calls Bedrock in ${decided.region}, set in AWS_REGION or AWS_DEFAULT_REGION - the models have to be served there`;
  }
  if (decided.source === "profile") return `pi calls Bedrock in ${decided.region}, the AWS profile's region - AWS_REGION, set, overrides it`;
  return `pi calls Bedrock in ${decided.region}, its default - AWS_REGION, set, overrides it`;
}
