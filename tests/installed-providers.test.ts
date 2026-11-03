import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * A person's pi, in a folder of the test's own (PI_CODING_AGENT_DIR): its settings install one package - an extension
 * that registers a provider, as pi-claude-code registers `claude-code` - and note what turri's own extension guard saw.
 */
let agentDir: string;
let project: string;
let saved: string | undefined;

beforeAll(() => {
  saved = process.env.PI_CODING_AGENT_DIR;
  agentDir = mkdtempSync(join(tmpdir(), "turri-pi-agent-"));
  project = mkdtempSync(join(tmpdir(), "turri-installed-"));
  const extension = join(agentDir, "gateway-extension");
  mkdirSync(extension);
  writeFileSync(join(extension, "package.json"), JSON.stringify({ name: "gateway-extension", type: "module", pi: { extensions: ["./index.js"] } }));
  writeFileSync(
    join(extension, "index.js"),
    [
      "export default function (pi) {",
      "  globalThis.loadingProvidersSaw = process.env.TURRI_LOADING_PROVIDERS;",
      '  pi.registerProvider("company-gateway", {',
      '    name: "Company gateway", baseUrl: "http://localhost:9", apiKey: "secret", api: "openai-completions",',
      '    models: [{ id: "big-model", name: "Big model", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 8000 }],',
      "  });",
      "}",
    ].join("\n"),
  );
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [extension] }));
  process.env.PI_CODING_AGENT_DIR = agentDir;
});
afterAll(() => {
  if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = saved;
  rmSync(agentDir, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

const { forgetInstalledProviders, installedProviders, runtimeWithProviders, LOADING_PROVIDERS } = await import("../src/installed-providers.ts");
beforeEach(() => forgetInstalledProviders());

describe("the providers a person's installed pi extensions register", () => {
  it("are loaded as pi loads the extensions, once, the providers alone kept - turri's own extension told it is only that", async () => {
    const registry = await installedProviders(project);
    expect(registry?.getRegisteredProviderIds()).toEqual(["company-gateway"]);
    expect((globalThis as { loadingProvidersSaw?: string }).loadingProvidersSaw).toBe("1");
    expect(process.env[LOADING_PROVIDERS]).toBeUndefined();
    expect(await installedProviders(project)).toBe(registry);
  });

  it("are in the model runtime a command with no conversation has - its agents', doctor's model check and init-config's catalogue", async () => {
    const runtime = await runtimeWithProviders(await installedProviders(project));
    expect(runtime.getModels("company-gateway").map((model) => model.id)).toEqual(["big-model"]);
    const { piModelAccess, piModelCatalogue } = await import("../src/model-check.ts");
    expect((await piModelAccess()).known("company-gateway")).toEqual(["big-model"]);
    expect((await piModelCatalogue()).models("company-gateway")).toMatchObject([{ id: "big-model", type: "chat" }]);
  });

  it("are what turri's agents run on when no conversation gives them providers - a command run headless", async () => {
    const { refuseIfModelIsBlind, ModelCannotReadImagesError } = await import("../src/pi.ts");
    // Found among the installed providers: a model that reads text alone, refused images.
    await expect(refuseIfModelIsBlind("company-gateway/big-model", 1)).rejects.toBeInstanceOf(ModelCannotReadImagesError);
  });

  it("leave turri's extension, built into pi as an older turri installed it, a no-op while they load", async () => {
    const { default: extension } = await import("../src/extension.ts");
    process.env[LOADING_PROVIDERS] = "1";
    try {
      // It would start a session of its own - its ledger, its chats - and register every tool: here it touches nothing.
      expect(extension(new Proxy({}, { get: () => { throw new Error("touched pi"); } }) as never)).toBeUndefined();
    } finally {
      delete process.env[LOADING_PROVIDERS];
    }
  });
});
