import { InteractiveMode } from "@earendil-works/pi-coding-agent";

/**
 * turri's /settings over pi's own. pi's interactive mode reads a bare `/settings` itself, before any extension command,
 * opens its own menu, warns that an extension's /settings conflicts with it and leaves that one out of the completions.
 * Here its menu opens turri's /settings instead - the extension command, with its completions and no warning - and
 * pi's own menu is the last entry of turri's (`openPiSettings`).
 *
 * pi has no hook for any of this: its class is patched, as chat-terminal.ts and pi-launch.ts patch others. A pi update
 * that changes it shows in tests/pi-settings.test.ts, which runs against the pi installed.
 */

/** What of pi's interactive mode this reaches, in plain JavaScript. */
interface SettingsScreen {
  showSettingsSelector(): void;
  getBuiltInCommandConflictDiagnostics(runner: unknown): Array<{ message: string }>;
  createBaseAutocompleteProvider(): { commands: Array<{ name: string }> };
  session: { prompt(text: string): Promise<void>; extensionRunner: { getCommand(name: string): unknown } };
}

/** The screen /settings was last typed on, and pi's own menu - set once turri takes /settings over. */
interface PiMenu {
  open: (screen: SettingsScreen) => void;
  screen?: SettingsScreen;
}
let piMenu: PiMenu | undefined;

/** Take pi's /settings over: once a process, every chat's screen. */
export function takeOverSettings(): void {
  if (piMenu !== undefined) return;
  const prototype = InteractiveMode.prototype as unknown as SettingsScreen;
  const own = prototype.showSettingsSelector;
  const conflicts = prototype.getBuiltInCommandConflictDiagnostics;
  const completions = prototype.createBaseAutocompleteProvider;
  const menu: PiMenu = { open: (screen) => own.call(screen) };
  piMenu = menu;
  // A bare /settings: turri's, when the extension has one - pi's menu otherwise, as it was.
  prototype.showSettingsSelector = function (this: SettingsScreen) {
    if (this.session.extensionRunner.getCommand("settings") === undefined) return own.call(this);
    menu.screen = this;
    void this.session.prompt("/settings");
  };
  prototype.getBuiltInCommandConflictDiagnostics = function (this: SettingsScreen, runner: unknown) {
    return conflicts.call(this, runner).filter((diagnostic) => !diagnostic.message.includes("'/settings'"));
  };
  // The completions: pi's /settings line gives way to turri's, which pi leaves out as a clash.
  prototype.createBaseAutocompleteProvider = function (this: SettingsScreen) {
    const provider = completions.call(this);
    const turri = this.session.extensionRunner.getCommand("settings") as { description?: string; getArgumentCompletions?: unknown } | undefined;
    if (turri === undefined) return provider;
    provider.commands = provider.commands.map((command) =>
      command.name === "settings" ? { name: "settings", description: turri.description, getArgumentCompletions: turri.getArgumentCompletions } : command,
    );
    return provider;
  };
}

/** Open pi's own settings menu on the screen /settings was typed on. False where there is none - a host, print mode. */
export function openPiSettings(): boolean {
  if (piMenu?.screen === undefined) return false;
  piMenu.open(piMenu.screen);
  return true;
}
