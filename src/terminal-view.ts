import { didNotPass } from "@turri-dev/core";
import type { TurriCore, TurriView } from "@turri-dev/core/terminal";
import { registerBanner } from "./banner.ts";
import { captureProgress } from "./capture-view.ts";
import { registerChats } from "./chat-commands.ts";
import { registerEntries } from "./entry-renderers.ts";
import { hookPeekKey, makePanel, registerPanelKey, terminalDialogs } from "./panel-view.ts";
import { openPiSettings } from "./pi-settings.ts";
import { skillProgress } from "./skill-progress.ts";

/** A session has one side panel across all its chats. Each chat registers its own keys and renderers. */
export function terminalView(): TurriView {
  let needsLooking: string | undefined;
  let panel: ReturnType<typeof makePanel> | undefined;
  const panelOf = (session: TurriCore) => panel ??= makePanel(session, () => {
    const id = needsLooking;
    needsLooking = undefined;
    return id;
  });
  return {
    chat(pi, { session, link }) {
      registerEntries(pi);
      registerBanner(pi, () => session.welcomeVisible(link.id));
      registerPanelKey(pi, panelOf(session));
    },
    chatCommands: (pi, { session }) => registerChats(pi, session),
    panel: panelOf,
    questions: { dialogs: terminalDialogs, whileAsking: hookPeekKey },
    pulseFinished(job) {
      if (job.status === "failed" || job.status === "stopped" || didNotPass(job)) needsLooking = job.id;
    },
    captureProgress, skillProgress, openPiSettings,
  };
}
