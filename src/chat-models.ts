import type { SessionOverrides } from "@turri-dev/core";

/**
 * The two models of `turri`, from its arguments, as the session's overrides - read as config.turri.yaml's keys while it
 * is open.
 *
 * The harness model is the one the person talks to: the core puts every chat on harness-model as it starts, and again as
 * it changes. `--harness-model` names it for this run - and so does pi's own `--model`, a model named for the chat: kept
 * for pi too, which starts on it. The coding model is the one every pulse runs on: `--coding-model`. Neither is pi's, so
 * both are taken out of pi's arguments. Either can still be changed in the conversation: pi's /model, and /settings.
 */

/** Take a `--name value` or `--name=value` out of the arguments: its value, and the rest. The last one wins. */
export function takeOption(args: string[], name: string): { value?: string; rest: string[] } {
  const rest: string[] = [];
  let value: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === name && i + 1 < args.length) value = args[++i];
    else if (arg.startsWith(`${name}=`)) value = arg.slice(name.length + 1);
    else rest.push(arg);
  }
  return { value, rest };
}

/** pi's arguments, without turri's own, and the models they name as the session's overrides. */
export function chatModels(args: string[]): { piArgs: string[]; overrides: SessionOverrides } {
  const coding = takeOption(args, "--coding-model");
  const harness = takeOption(coding.rest, "--harness-model");
  const piArgs = harness.rest;
  // pi's own --model, for the chat: the harness model it runs on, unless --harness-model says another.
  const chatModel = harness.value ?? takeOption(piArgs, "--model").value;
  return {
    piArgs,
    overrides: {
      ...(chatModel !== undefined ? { harnessModel: chatModel } : {}),
      ...(coding.value !== undefined ? { codingModel: coding.value } : {}),
    },
  };
}
