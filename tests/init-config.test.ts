import { existsSync, mkdirSync, mkdtempSync, realpathSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { projectModels, readProjectConfig } from "@turri-dev/core/config";
import { main } from "../src/init-config-cli.ts";

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
