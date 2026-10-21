import { join } from "node:path";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { projectDirOf } from "./regenerate/paths.ts";
import { describeChecks, doctor, verdictOf } from "./setup.ts";

type AnyTool = ToolDefinition<any, any, any>;

/**
 * doctor: `turri doctor`'s checks from inside the conversation - this machine, and the project the conversation is in -
 * against turri's own environment, the one its pulses run with, not the agent's shell's. Changes nothing; asks the
 * project's models only when told to, a request a model.
 */
export function doctorTool(options: { cwd: string }): AnyTool {
  return defineTool({
    name: "doctor",
    label: "Doctor",
    description:
      "Whether this machine and this project are ready for turri, as turri doctor checks it: Node, bash, git, which OS " +
      "sandbox is up under the agents' commands, whether a model provider has credentials, the toolchains the modules' " +
      "implementation reqs name and what the testing scripts run that this machine lacks - against the PATH turri's pulses " +
      "run with. With models: true, each model config.turri.yaml names is asked for a word with this machine's credentials - " +
      "a request a model, which costs money. Changes nothing.",
    promptSnippet: "doctor: turri's self check - this machine and project, ready or what to fix",
    promptGuidelines: [
      "Use doctor, not `turri doctor` in the shell, to check whether this machine and project are ready - when the person asks, when a pulse fails for a missing toolchain or command, or before the first build on a machine. Ask the models (models: true) only when the person asks, or a model fails to answer: it costs a request a model.",
    ],
    parameters: Type.Object({
      models: Type.Optional(Type.Boolean({ description: "Ask each model the project's config names for a word - one paid request a model. Default false" })),
    }),
    async execute(_id, params) {
      const checks = await doctor({ dir: projectDirOf(join(options.cwd, "session.plain")), models: params.models === true });
      const verdict = verdictOf(checks);
      return { content: [{ type: "text" as const, text: describeChecks(checks) }], details: { ready: verdict.ready, limited: verdict.limited } };
    },
  });
}
