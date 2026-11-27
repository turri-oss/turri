import { bedrockRegionFor } from "@turri-dev/core/models";

/** What turri set AWS_REGION to, so it moves or takes back its own and never the person's - as the core marks it. */
const TURRI_AWS_REGION = "TURRI_AWS_REGION";

/**
 * AWS_REGION for a project's Bedrock models, as `bedrockRegionFor` says - for a command that calls models with no
 * session open (doctor, capture): a session sets it itself as it opens. Set only when the models need a region and the
 * person set none; done again, it moves or takes back what turri set before.
 *
 * core-gap: the core sets it for its own sessions (applyBedrockRegion) and gives only the reading: this is the setting,
 * as the core does it, until it is public.
 */
export function applyBedrockRegion(projectDir: string, options: { also?: string[]; env?: NodeJS.ProcessEnv } = {}): void {
  const env = options.env ?? process.env;
  let decided: ReturnType<typeof bedrockRegionFor>;
  try {
    decided = bedrockRegionFor(projectDir, { ...options, env });
  } catch {
    // A config that does not read is the model check's to say: nothing is set from it.
    return;
  }
  if (decided.source === "turri" && decided.region !== undefined) {
    env.AWS_REGION = decided.region;
    env[TURRI_AWS_REGION] = decided.region;
  } else if (decided.source !== "set" && env[TURRI_AWS_REGION] !== undefined) {
    // What turri set before is needed no more - or two regions are now: taken back, not guessed.
    if (env.AWS_REGION === env[TURRI_AWS_REGION]) delete env.AWS_REGION;
    delete env[TURRI_AWS_REGION];
  }
}
