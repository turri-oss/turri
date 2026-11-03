import { ModelRegistry, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import { EXTENSION_PROVIDERS, installedProviders, runtimeWithProviders } from "./installed-providers.ts";
import { AGENT_ROLES, projectModels, roleModel, type ProjectConfig } from "./config.ts";

/**
 * Whether the models a project's config names answer, with the credentials this machine has - for any provider pi
 * supports. Each model the config uses (harness-model, coding-model, judge-model and every role under models:) is sent
 * one short request through pi's own model runtime, the one turri's agents use, so the credentials are found as they
 * will be when it builds: an API key in the environment, pi's /login, an AWS profile. A model pi does not know, a key
 * it rejects, an account without access to the model - each is said, with what to do about it.
 */

/** A model the config uses, and which of its settings name it. */
export interface UsedModel {
  spec: string;
  usedBy: string[];
  /** How hard it thinks, as the first setting naming it says - none written, as the agents run it: low at least. */
  thinking?: string;
}

/** Every model the config uses, each once, with the settings that name it - the two models first. */
export function modelsInUse(config: Pick<ProjectConfig, "harnessModel" | "codingModel" | "judgeModel" | "models">): UsedModel[] {
  const used = new Map<string, string[]>();
  const thinking = new Map<string, string>();
  const add = (choice: { model?: string; thinking?: string } | undefined, by: string) => {
    const spec = choice?.model;
    if (spec === undefined) return;
    used.set(spec, [...(used.get(spec) ?? []), by]);
    if (!thinking.has(spec) && choice?.thinking !== undefined) thinking.set(spec, choice.thinking);
  };
  const { harness, coding } = projectModels(config);
  add(harness, "harness-model");
  add(coding, "coding-model");
  add(config.judgeModel, "judge-model");
  // A role named under models: runs on its own model - or what it inherits, when its entry names only how it thinks.
  for (const role of AGENT_ROLES) {
    if (config.models?.[role] === undefined || role === "chat" || role === "coding") continue;
    add(roleModel(config, role), `models.${role}`);
  }
  add(config.models?.default, "models.default");
  return [...used].map(([spec, usedBy]) => ({ spec, usedBy: [...new Set(usedBy)], ...(thinking.has(spec) ? { thinking: thinking.get(spec)! } : {}) }));
}

export type ModelVerdict =
  | { ok: true; spec: string; usedBy: string[]; ms: number }
  | { ok: false; spec: string; usedBy: string[]; problem: string; fix: string };

/** What it takes to talk to a model: pi's runtime, or a stand-in for tests. */
export interface ModelAccess {
  /** The model, as pi knows it - undefined when it does not. */
  find(provider: string, id: string): unknown;
  /** Other models of the provider pi knows, to suggest from. */
  known(provider: string): string[];
  /** One short request, thinking as hard as `thinking` says: the error the provider gave, or nothing when it answered. */
  ask(model: unknown, thinking?: string): Promise<string | undefined>;
}

/**
 * pi's own model runtime: its catalogue with models.json's, pi's credentials - auth.json and the environment - and the
 * providers the person's installed pi extensions register (installed-providers.ts), as turri's agents have them.
 */
async function piRuntime(): Promise<ModelRuntime> {
  return runtimeWithProviders(await installedProviders());
}

/** A model in pi's catalogue: what turri chooses among, and checks a model it is given against. */
export interface CatalogueModel {
  provider: string;
  id: string;
  name: string;
  /** chat for a model turri's agents can talk to; pi's image and classifier models are in the catalogue too. */
  type: string;
  reasoning: boolean;
  /** Dollars a million tokens. */
  cost: { input: number; output: number };
}

/** pi's model catalogue, as turri's agents have it - its built-in models and models.json's. */
export interface ModelCatalogue {
  /** A provider's models, every type - none for a provider pi does not know. */
  models(provider: string): CatalogueModel[];
}

/** pi's catalogue, read once: no request, no model asked. */
export async function piModelCatalogue(): Promise<ModelCatalogue> {
  const runtime = await piRuntime();
  return {
    models: (provider) =>
      runtime.getAllModels(provider).map((model) => {
        const entry = model as { name?: string; type?: string; reasoning?: boolean; cost?: { input?: number; output?: number } };
        return {
          provider: model.provider,
          id: model.id,
          name: entry.name ?? model.id,
          type: entry.type ?? "chat",
          reasoning: entry.reasoning === true,
          cost: { input: entry.cost?.input ?? 0, output: entry.cost?.output ?? 0 },
        };
      }),
  };
}

/** The ids of `known` closest to `id`, at most three: the most of its words in common - claude, haiku - then the most of its characters in order. */
export function closestModels(id: string, known: string[]): string[] {
  const words = id.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word !== "");
  const score = (other: string) => {
    const theirs = other.toLowerCase().split(/[^a-z0-9]+/);
    return words.filter((word) => theirs.includes(word)).length * 100 + commonPrefix(id.toLowerCase(), other.toLowerCase());
  };
  const scored = known.map((other) => ({ other, score: score(other) })).filter((entry) => entry.score >= 100);
  // Only those sharing as many words as the best: claude-haiku-* for claude-haiku-9-9, not every claude.
  const most = Math.max(0, ...scored.map((entry) => Math.floor(entry.score / 100)));
  return scored
    .filter((entry) => Math.floor(entry.score / 100) === most)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((entry) => entry.other);
}

/** pi's own model runtime, with pi's credentials - auth.json, models.json and the environment - as turri's agents have them. */
export async function piModelAccess(): Promise<ModelAccess> {
  const runtime = await piRuntime();
  const registry = new ModelRegistry(runtime);
  return {
    find: (provider, id) => registry.find(provider, id),
    known: (provider) => runtime.getModels(provider).map((model) => model.id),
    async ask(model, thinking) {
      // As the agents ask it: thinking as the config says - some models refuse a request with none, Claude Code's among
      // them - with room for the thinking before the word.
      const reasoning = thinking !== undefined && thinking !== "off" && (model as { reasoning?: boolean }).reasoning === true ? thinking : undefined;
      try {
        const reply = await runtime.completeSimple(
          model as Parameters<typeof runtime.completeSimple>[0],
          { messages: [{ role: "user", content: "Reply with the one word: ok", timestamp: Date.now() }] },
          { maxTokens: reasoning !== undefined ? 2048 : 64, ...(reasoning !== undefined ? { reasoning: reasoning as never } : {}), signal: AbortSignal.timeout(60_000) },
        );
        return reply.stopReason === "error" || reply.stopReason === "aborted" ? (reply.errorMessage ?? `the request ended: ${reply.stopReason}`) : undefined;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
  };
}

/** The credentials pi reads for a provider, as its sign-in says them. */
function signIn(provider: string): string {
  const keys: Record<string, string> = {
    anthropic: "ANTHROPIC_API_KEY, or /login in turri",
    openai: "OPENAI_API_KEY, or /login in turri",
    google: "GEMINI_API_KEY",
    "amazon-bedrock": "AWS_PROFILE (aws configure, or aws sso login) or AWS_BEARER_TOKEN_BEDROCK",
    ...Object.fromEntries(Object.entries(EXTENSION_PROVIDERS).map(([id, provider]) => [id, provider.signIn])),
  };
  return keys[provider] ?? `the key pi reads for ${provider}, or /login in turri - https://pi.dev lists them`;
}

/**
 * What to do about a provider's error, from what it says. `region`: for Bedrock, the region it is called in and where
 * that comes from, as a line (bedrock-region.ts `describeBedrockRegion`) - turri sets it, so a person is not told to.
 */
export function fixFor(provider: string, problem: string, region?: string): string {
  const text = problem.toLowerCase();
  const where = region !== undefined ? ` - ${region}` : " - the region pi calls Bedrock in, which AWS_REGION, set, chooses";
  if (/access (to|denied).*model|don't have access|not authorized to (invoke|access)|model access|accessdenied/.test(text) && provider === "amazon-bedrock") {
    return `ask for access to this model in the Bedrock console, under model access, for its region${where}`;
  }
  if (/provider is not configured|no credentials|not logged in/.test(text)) return `sign in to ${provider}: ${signIn(provider)}`;
  if (/401|403|unauthori[sz]ed|forbidden|invalid.*(api key|x-api-key|token|credential)|credential|security token|could not load|unable to locate|expired|no api key|missing api key|authentication/.test(text)) {
    return `check the credentials pi reads for ${provider}: ${signIn(provider)}`;
  }
  if (/region|endpoint|enotfound|getaddrinfo/.test(text)) {
    return provider === "amazon-bedrock" ? `the model has to be served in the region it is called in${where}` : "check the network, and the provider's endpoint";
  }
  if (/not found|404|does not exist|unknown model|invalid model/.test(text)) return "the provider does not serve this model id: change it in config.turri.yaml";
  if (/429|rate|quota|overloaded|capacity/.test(text)) return "the provider is busy or the quota is used up: try again later";
  if (/timeout|timed out|aborted/.test(text)) return "the provider did not answer in time: check the network, then try again";
  return `see what the provider said; the credentials pi reads for ${provider}: ${signIn(provider)}`;
}

/** How many characters two names share from their start. */
function commonPrefix(a: string, b: string): number {
  let at = 0;
  while (at < a.length && at < b.length && a[at] === b[at]) at += 1;
  return at;
}

/** Each model the config uses, tried: answered, or what is wrong and what to do. One request a model. */
export async function checkModels(models: UsedModel[], access: ModelAccess, options: { bedrockRegion?: string } = {}): Promise<ModelVerdict[]> {
  return Promise.all(
    models.map(async ({ spec, usedBy, thinking }): Promise<ModelVerdict> => {
      const slash = spec.indexOf("/");
      if (slash === -1) return { ok: false, spec, usedBy, problem: "not provider/model-id", fix: "write it as provider/model-id - amazon-bedrock/global.openai.gpt-6-astra" };
      const [provider, id] = [spec.slice(0, slash), spec.slice(slash + 1)];
      const model = access.find(provider, id);
      if (model === undefined) {
        const known = access.known(provider);
        if (known.length === 0) {
          // A provider an extension brings: its extension is not installed - or, installed, not ready.
          const extension = EXTENSION_PROVIDERS[provider];
          if (extension !== undefined) return { ok: false, spec, usedBy, problem: `${provider} - ${extension.label} - is not there`, fix: `install its pi extension: ${extension.install} - with ${extension.signIn}` };
          return { ok: false, spec, usedBy, problem: `pi knows no provider ${provider}`, fix: "use a provider pi supports - https://pi.dev" };
        }
        const close = closestModels(id, known);
        return { ok: false, spec, usedBy, problem: `pi knows no model ${id} at ${provider}`, fix: close.length > 0 ? `did you mean ${close.map((other) => `${provider}/${other}`).join(", ")}?` : `change it in config.turri.yaml to a model pi knows at ${provider}` };
      }
      const started = Date.now();
      // How the agents run it: as the config says, else low - a role's own default is at least that.
      const problem = await access.ask(model, thinking ?? "low");
      if (problem === undefined) return { ok: true, spec, usedBy, ms: Date.now() - started };
      const said = problem.split("\n").find((line) => line.trim() !== "")?.trim().slice(0, 300) ?? problem;
      return { ok: false, spec, usedBy, problem: said, fix: fixFor(provider, problem, provider === "amazon-bedrock" ? options.bedrockRegion : undefined) };
    }),
  );
}
