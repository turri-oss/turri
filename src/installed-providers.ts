import { join } from "node:path";
import { createAgentSessionServices, getAgentDir, ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";

/**
 * The model providers the person's pi extensions register - a Claude subscription through Claude Code
 * (pi-claude-code, `claude-code`), a company's own gateway - wherever turri needs a model and no conversation has them.
 *
 * In a chat, pi loads the person's installed pi packages itself, and turri's agents take the providers from the
 * conversation's model registry (pi.ts `inheritProviders`). A command with no conversation - `turri regenerate`,
 * `turri change-plain`, doctor's model check, init-config - has none: here they are loaded the way pi loads them, once a
 * process, and only the providers they register are kept. turri's own extension, when an older turri installed it into
 * every pi, is loaded as nothing meanwhile (`LOADING_PROVIDERS`): it would start a session of its own.
 */

/** Set while the person's extensions are loaded for their providers: turri's own extension does nothing then. */
export const LOADING_PROVIDERS = "TURRI_LOADING_PROVIDERS";

/**
 * pi's own providers that come from an extension rather than with pi: what installs each, and how it is signed in to - for
 * doctor and init-config to say when a config names one that is not there.
 */
export const EXTENSION_PROVIDERS: Record<string, { label: string; install: string; signIn: string }> = {
  "claude-code": {
    label: "Claude subscription (Claude Code)",
    install: "pi install https://github.com/earendil-works/pi-claude-code",
    signIn: "Claude Code installed (npm install -g @anthropic-ai/claude-code) and signed in to your Claude Pro or Max subscription: claude auth login",
  },
};

const loaded = new Map<string, Promise<ModelRegistry | undefined>>();

/**
 * The providers the person's installed pi extensions register, for `cwd` - its project's pi settings with the person's
 * own - loaded once. Undefined when none could be loaded: pi's built-in providers and models.json are what there is.
 */
export function installedProviders(cwd: string = process.cwd()): Promise<ModelRegistry | undefined> {
  let found = loaded.get(cwd);
  if (found === undefined) {
    found = load(cwd);
    loaded.set(cwd, found);
  }
  return found;
}

async function load(cwd: string): Promise<ModelRegistry | undefined> {
  const before = process.env[LOADING_PROVIDERS];
  process.env[LOADING_PROVIDERS] = "1";
  try {
    // Only the extensions: no skills, prompts, themes or context files are read for this.
    const { modelRuntime } = await createAgentSessionServices({
      cwd,
      resourceLoaderOptions: { noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true },
    });
    const registry = new ModelRegistry(modelRuntime);
    return registry.getRegisteredProviderIds().length > 0 ? registry : undefined;
  } catch {
    return undefined;
  } finally {
    if (before === undefined) delete process.env[LOADING_PROVIDERS];
    else process.env[LOADING_PROVIDERS] = before;
  }
}

/**
 * pi's model runtime as turri's agents have it with no conversation: pi's providers, models.json and auth.json, and the
 * providers the person's installed pi extensions register - for a host that signs in or lists models before a chat is
 * open, whose own `ModelRuntime.create()` would have none of an extension's (`claude-code`, say).
 */
export async function installedModelRuntime(cwd: string = process.cwd()): Promise<ModelRuntime> {
  return runtimeWithProviders(await installedProviders(cwd));
}

/** For tests: forget what was loaded. */
export function forgetInstalledProviders(): void {
  loaded.clear();
}

/**
 * pi's model runtime - its catalogue, models.json and its credentials - with `source`'s providers registered in it: a
 * conversation's, or the person's installed ones. Its models are listed as the registrations land.
 */
export async function runtimeWithProviders(source: ModelRegistry | undefined): Promise<ModelRuntime> {
  const agentDir = getAgentDir();
  const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
  if (source === undefined) return runtime;
  const registry = new ModelRegistry(runtime);
  for (const id of source.getRegisteredProviderIds()) {
    const native = source.getRegisteredNativeProvider(id);
    const config = source.getRegisteredProviderConfig(id);
    try {
      if (native !== undefined) registry.registerProvider(native);
      else if (config !== undefined) registry.registerProvider(id, config);
    } catch {
      // One provider that will not register leaves the others, and pi's own, usable.
    }
  }
  await runtime.refresh({ allowNetwork: false });
  return runtime;
}
