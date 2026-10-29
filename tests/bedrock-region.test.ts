import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyBedrockRegion, bedrockRegionFor, describeBedrockRegion, profileRegion, regionInGeography, TURRI_AWS_REGION } from "../src/bedrock-region.ts";
import * as host from "../src/host.ts";
import { checkBedrockRegion } from "../src/setup.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "turri-bedrock-region-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const models = (harness: string, coding: string, more = "") => writeFileSync(join(dir, "config.turri.yaml"), `harness-model: ${harness}\ncoding-model: ${coding}\n${more}`);
const eu = () => models("amazon-bedrock/eu.anthropic.claude-opus-5-5", "amazon-bedrock/eu.anthropic.claude-haiku-5-5");
/** An AWS config file naming a profile's region, read through AWS_CONFIG_FILE. */
const awsConfig = (text: string) => {
  const file = join(dir, "aws-config");
  writeFileSync(file, text);
  return file;
};

describe("the AWS region turri calls Bedrock in", () => {
  it("is set by turri when the models need one and none is set - and marked as turri's", () => {
    eu();
    const env: NodeJS.ProcessEnv = {};
    const decided = applyBedrockRegion(dir, { env });
    expect(decided).toMatchObject({ region: "eu-central-1", source: "turri", needs: { region: "eu-central-1", geography: "eu" } });
    expect(env.AWS_REGION).toBe("eu-central-1");
    expect(env[TURRI_AWS_REGION]).toBe("eu-central-1");
  });

  it("is the person's AWS_REGION when they set one, never overwritten - even one outside the models' geography, which is said", () => {
    eu();
    const env: NodeJS.ProcessEnv = { AWS_REGION: "us-west-2" };
    const decided = applyBedrockRegion(dir, { env });
    expect(decided).toMatchObject({ region: "us-west-2", source: "set" });
    expect(env.AWS_REGION).toBe("us-west-2");
    expect(env[TURRI_AWS_REGION]).toBeUndefined();
    expect(describeBedrockRegion(decided)).toContain("the models are served in eu: set it to a region there, eu-central-1, or unset it and turri sets it");
    expect(checkBedrockRegion(dir, env)).toEqual([expect.objectContaining({ level: "missing", name: "AWS region" })]);
  });

  it("is the person's AWS_DEFAULT_REGION too, with AWS_REGION left unset", () => {
    eu();
    const env: NodeJS.ProcessEnv = { AWS_DEFAULT_REGION: "eu-west-1" };
    expect(applyBedrockRegion(dir, { env })).toMatchObject({ region: "eu-west-1", source: "set" });
    expect(env.AWS_REGION).toBeUndefined();
  });

  it("is left to pi for global, us and in-region models, which its default serves - nothing set", () => {
    for (const [harness, coding] of [
      ["amazon-bedrock/global.xai.grok-4.7", "amazon-bedrock/global.xai.grok-4.6"],
      ["amazon-bedrock/us.openai.gpt-6-astra", "amazon-bedrock/us.openai.gpt-6-luna"],
      ["amazon-bedrock/meta.llama4-maverick-17b-instruct-v1:0", "amazon-bedrock/global.xai.grok-4.6"],
    ]) {
      models(harness!, coding!);
      const env: NodeJS.ProcessEnv = {};
      expect(applyBedrockRegion(dir, { env })).toMatchObject({ region: "us-east-1", source: "default" });
      expect(env.AWS_REGION).toBeUndefined();
    }
  });

  it("is said, not guessed, when the models need two regions: none is set, and one turri set before is taken back", () => {
    eu();
    const env: NodeJS.ProcessEnv = {};
    applyBedrockRegion(dir, { env });
    expect(env.AWS_REGION).toBe("eu-central-1");
    models("amazon-bedrock/eu.anthropic.claude-opus-5-5", "amazon-bedrock/jp.anthropic.claude-haiku-5-5");
    const decided = applyBedrockRegion(dir, { env });
    expect(decided.region).toBeUndefined();
    expect(decided.conflict).toEqual([
      { region: "eu-central-1", geography: "eu", models: ["amazon-bedrock/eu.anthropic.claude-opus-5-5"] },
      { region: "ap-northeast-1", geography: "jp", models: ["amazon-bedrock/jp.anthropic.claude-haiku-5-5"] },
    ]);
    expect(env.AWS_REGION).toBeUndefined();
    expect(env[TURRI_AWS_REGION]).toBeUndefined();
    expect(describeBedrockRegion(decided)).toContain("turri set none");
    expect(checkBedrockRegion(dir, env)).toEqual([expect.objectContaining({ level: "missing", detail: "the Bedrock models need two regions" })]);
  });

  it("moves with the models: turri's own is changed or taken back as they change, the person's never", () => {
    eu();
    const env: NodeJS.ProcessEnv = {};
    applyBedrockRegion(dir, { env });
    models("amazon-bedrock/jp.anthropic.claude-opus-5-5", "amazon-bedrock/jp.anthropic.claude-haiku-5-5");
    applyBedrockRegion(dir, { env });
    expect(env.AWS_REGION).toBe("ap-northeast-1");
    models("amazon-bedrock/global.xai.grok-4.7", "amazon-bedrock/global.xai.grok-4.6");
    applyBedrockRegion(dir, { env });
    expect(env.AWS_REGION).toBeUndefined();
    const person: NodeJS.ProcessEnv = { AWS_REGION: "ap-northeast-1" };
    applyBedrockRegion(dir, { env: person });
    expect(person.AWS_REGION).toBe("ap-northeast-1");
  });

  it("counts the models a call names besides the config's", () => {
    models("anthropic/claude-opus-5-5", "anthropic/claude-haiku-5-5");
    const env: NodeJS.ProcessEnv = {};
    expect(applyBedrockRegion(dir, { env }).models).toEqual([]);
    expect(applyBedrockRegion(dir, { env, also: ["amazon-bedrock/au.anthropic.claude-haiku-5-5"] })).toMatchObject({ region: "ap-southeast-2", source: "turri" });
    expect(env.AWS_REGION).toBe("ap-southeast-2");
  });

  it("is the AWS profile's when it is in the models' geography - and turri's over it when it is not", () => {
    eu();
    const file = awsConfig("[default]\nregion = us-east-1\n\n[profile work]\nregion = eu-west-1\n\n[profile home]\nregion = us-west-2\n");
    const work: NodeJS.ProcessEnv = { AWS_PROFILE: "work", AWS_CONFIG_FILE: file };
    expect(applyBedrockRegion(dir, { env: work })).toMatchObject({ region: "eu-west-1", source: "profile" });
    expect(work.AWS_REGION).toBeUndefined();
    const home: NodeJS.ProcessEnv = { AWS_PROFILE: "home", AWS_CONFIG_FILE: file };
    expect(applyBedrockRegion(dir, { env: home })).toMatchObject({ region: "eu-central-1", source: "turri" });
    expect(home.AWS_REGION).toBe("eu-central-1");
    expect(profileRegion("default", { AWS_CONFIG_FILE: file })).toBe("us-east-1");
    expect(profileRegion("nobody", { AWS_CONFIG_FILE: file })).toBeUndefined();
  });

  it("reads each stack's models too", () => {
    models("amazon-bedrock/global.xai.grok-4.7", "amazon-bedrock/global.xai.grok-4.6");
    writeFileSync(join(dir, "config.turri.backend.yaml"), "coding-model: amazon-bedrock/ca.anthropic.claude-haiku-5-5\n");
    expect(bedrockRegionFor(dir, { env: {} })).toMatchObject({ region: "ca-central-1", source: "turri" });
  });
});

describe("a region's geography", () => {
  it("is the regions Bedrock serves it from", () => {
    expect(regionInGeography("eu-west-3", "eu")).toBe(true);
    expect(regionInGeography("us-east-1", "eu")).toBe(false);
    expect(regionInGeography("ap-northeast-3", "jp")).toBe(true);
    expect(regionInGeography("ap-southeast-1", "jp")).toBe(false);
    expect(regionInGeography("ap-south-1", "apac")).toBe(true);
    expect(regionInGeography("us-gov-west-1", "us")).toBe(false);
    expect(regionInGeography("us-gov-east-1", "us-gov")).toBe(true);
  });
});

describe("the host's view of the region", () => {
  it("is exported, and reads what turri will do without setting anything", () => {
    eu();
    expect(typeof host.bedrockRegionFor).toBe("function");
    const env: NodeJS.ProcessEnv = {};
    expect(host.bedrockRegionFor(dir, { env })).toMatchObject({ region: "eu-central-1", source: "turri", models: ["amazon-bedrock/eu.anthropic.claude-opus-5-5", "amazon-bedrock/eu.anthropic.claude-haiku-5-5"] });
    expect(env.AWS_REGION).toBeUndefined();
    // Once turri set it, it is still turri's: the host sees the same answer.
    applyBedrockRegion(dir, { env });
    expect(host.bedrockRegionFor(dir, { env })).toMatchObject({ region: "eu-central-1", source: "turri" });
  });
});
