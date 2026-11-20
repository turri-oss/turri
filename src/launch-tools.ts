import { resolve } from "node:path";
import { defineTool, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { refuseTestPlainFile } from "./test-plain-files.ts";
import { launchText, type Launch, type LaunchTrack } from "./launch-track.ts";

/**
 * The chat's launch tool (docs/launch.md): it asks the launch track for a launch of a codebase's last commit and returns
 * at once - the launch agent works in the background, and the chat is told how it went once it ends. The harness does
 * the parts that must hold - exporting the commit, stopping what the last launch started, owning what this one starts -
 * and the agent the rest.
 */
export function launchTool(options: {
  cwd: string;
  track: LaunchTrack;
  /** The spec launch takes when it is given none: the project's module. */
  defaultPlainFile: () => string | undefined;
  /** The chat it is called in. */
  chat: () => string | undefined;
  /** The launch asked for ended - or the one that took its place: the chat is told how it went. */
  ended: (launch: Launch) => void;
  /** A newer launch took the place of the one asked for: the chat is told it hears that one's end instead. */
  replaced?: (launch: Launch, next: Launch) => void;
  /** Whether the call waits for the launch to end - pi's print, json and rpc modes, which end with the reply. Default: never. */
  wait?: (ctx: ExtensionContext) => boolean;
}) {
  return defineTool({
    name: "launch",
    label: "Launch",
    description:
      "Launch what is regenerated for the person to try, in the background: the last commit of the module on top of the " +
      "spec's requires chain, which holds the code of the ones below, exported to dist/<module>, and an agent that starts it " +
      "on this machine - or, with guidance, follows it from the host codebase: an integration a host application loads, " +
      "say, put in place with the host's scripts. Before you call it, ask yourself whether there is guidance for launching " +
      "this project - in what the person said, AGENTS.md, a skill - and pass it in full. It returns at once; you are told " +
      "where it runs, or why it did not come up, once it ends. It replaces what launches of the modules below it started, " +
      "and takes a port or anything else turri's launches of other modules hold that it needs - its summary says what it " +
      "stopped; guidance never tells it to leave one of those running. When what is launched is that code already, it does nothing " +
      "and says so. Under launch-after-pulse turri launches what each pulse lands itself: never call it for that.",
    promptSnippet: "launch the regenerated code for the person to try, in the background - as the project's guidance says, or from dist/<module>",
    parameters: Type.Object({
      plain_file: Type.Optional(Type.String({ description: "A .plain file of the module. Default: the project's module from config.turri.yaml." })),
      in_module: Type.Optional(Type.String({ description: "The codebase to take, when modules built on this one branch" })),
      again: Type.Optional(Type.Boolean({ description: "Launch even when its code is out already - only when the last launch did not leave it as the person needs it, or they want it launched some other way." })),
      guidance: Type.Optional(
        Type.String({ description: "The guidance for launching this project, whole, from wherever it is - the person, AGENTS.md, a skill: the scripts to run and in which order, where the code goes. Omit when there is none." }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const named = params.plain_file ?? options.defaultPlainFile();
      if (named === undefined) throw new Error("Which spec? config.turri.yaml names no module: pass plain_file.");
      const plainFile = resolve(options.cwd, named);
      refuseTestPlainFile(plainFile);
      const chat = options.chat();
      const { launch, already } = options.track.request({
        plainFile,
        ...(params.in_module !== undefined ? { inModule: params.in_module } : {}),
        ...(params.guidance !== undefined ? { guidance: params.guidance } : {}),
        ...(params.again === true ? { again: true } : {}),
        cause: chat !== undefined ? { chat } : {},
      });
      const details = { launch: launch.id, module: launch.codebase, commit: launch.short, already };
      if (already) {
        return {
          content: [{ type: "text" as const, text: `Out already: what runs of ${launch.codebase} is its code at ${launch.short} - nothing was done, and what runs is left running.${launchText(launch) !== "" ? `\n${launchText(launch)}` : ""}\nSay so in a line.` }],
          details,
        };
      }
      // Where the process ends with the reply, the call waits: a launch left running would end with it.
      if (ctx !== undefined && options.wait?.(ctx) === true) {
        const ended = await options.track.done(launch.id);
        const where = ended.status === "launched" ? `${ended.codebase} at ${ended.short} is launched` : ended.status === "stopped" ? `The launch of ${ended.codebase} was stopped` : `The launch of ${ended.codebase} at ${ended.short} did not come up`;
        return {
          content: [{ type: "text" as const, text: `${where} (${ended.id}).\n${launchText(ended)}\nTell the person where it runs, or why it did not come up.` }],
          details: { ...details, status: ended.status },
        };
      }
      void options.track.done(launch.id).then(options.ended, () => undefined);
      if (options.replaced !== undefined) void options.track.replaced(launch.id).then((next) => options.replaced!(launch, next), () => undefined);
      const behind = launch.status === "waiting" ? " - after the launch of it under way" : "";
      return {
        content: [{ type: "text" as const, text: `Launching ${launch.codebase} at ${launch.short} in the background (${launch.id})${behind}. You are told where it runs, or why it did not come up, once it ends: say so in a line, and start nothing for it.` }],
        details,
      };
    },
  });
}
