import { modelOnly, type ModelChoice } from "../config.ts";

export type CaptureRole = "capture-exploration" | "capture-analysis" | "capture";

/** One set of defaults for init-config and capture, including headless captures with no project config. */
export function captureDefaults(harness?: string, coding?: string): Record<CaptureRole, ModelChoice> {
  const bedrock = process.env.AWS_BEARER_TOKEN_BEDROCK || process.env.AWS_PROFILE || process.env.CLAUDE_CODE_USE_BEDROCK === "1";
  const model = modelOnly(harness).model ?? modelOnly(coding).model ?? (bedrock ? "amazon-bedrock/global.anthropic.claude-opus-5-5" : "anthropic/claude-opus-5-5");
  // Keep the provider and Bedrock inference geography the person selected. Other vendors use their configured pair.
  const prefix = model.match(/^(anthropic\/|claude-code\/|amazon-bedrock\/(?:(?:global|us|eu|jp|au)\.)?anthropic\.)claude-/)?.[1];
  const fallback = modelOnly(coding).model ?? model;
  // The Japanese inference geography serves Sonnet 5, but not 5.5.
  const sonnet = prefix === "amazon-bedrock/jp.anthropic." ? "claude-sonnet-5" : "claude-sonnet-5-5";
  return {
    "capture-exploration": { model: prefix ? `${prefix}claude-haiku-5-5` : fallback, thinking: "low" },
    "capture-analysis": { model: prefix ? `${prefix}${sonnet}` : fallback, thinking: "low" },
    capture: { model: prefix ? `${prefix}claude-opus-5-5` : model, thinking: "medium" },
  };
}
