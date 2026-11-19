import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { openPiSettings, takeOverSettings } from "../src/pi-settings.ts";

/** A stand-in of pi's screen: the session it prompts, its extension commands, and pi's own selector. */
function screen(withTurri = true) {
  const prompted: string[] = [];
  const showSelector = vi.fn();
  const commands = withTurri ? [{ name: "settings", invocationName: "settings", description: "turri's", sourceInfo: { path: "turri" } }] : [];
  return {
    prompted,
    showSelector,
    self: {
      showSelector,
      session: {
        prompt: async (text: string) => void prompted.push(text),
        extensionRunner: {
          getCommand: (name: string) => commands.find((command) => command.name === name),
          getRegisteredCommands: () => commands,
        },
      },
    },
  };
}

describe("turri's /settings over pi's own", () => {
  // Against the pi installed: a pi update that renames what is patched fails here first.
  const prototype = InteractiveMode.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;

  it("finds what it patches on pi's interactive mode", () => {
    for (const method of ["showSettingsSelector", "getBuiltInCommandConflictDiagnostics", "createBaseAutocompleteProvider"]) expect(typeof prototype[method]).toBe("function");
  });

  it("opens turri's /settings for a bare /settings, without pi's warning of a clash - and pi's own menu from it", () => {
    takeOverSettings();
    const { self, prompted, showSelector } = screen();
    prototype.showSettingsSelector!.call(self);
    expect(prompted).toEqual(["/settings"]);
    expect(showSelector).not.toHaveBeenCalled();
    expect(prototype.getBuiltInCommandConflictDiagnostics!.call(self, self.session.extensionRunner)).toEqual([]);
    expect(openPiSettings()).toBe(true);
    expect(showSelector).toHaveBeenCalledTimes(1);
  });

  it("leaves pi's menu as it was where turri has no /settings", () => {
    takeOverSettings();
    const { self, prompted, showSelector } = screen(false);
    prototype.showSettingsSelector!.call(self);
    expect(prompted).toEqual([]);
    expect(showSelector).toHaveBeenCalledTimes(1);
  });
});
