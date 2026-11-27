import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { Turri } from "@turri-dev/core";

/**
 * turri as a pi extension, for pi to load itself: `turri` builds the session's own extension into pi (pi-launch.ts), and
 * this file is what pi loads when it is given turri's file - an older turri wrote one into every pi. It is the session
 * pi-launch.ts opened in this process, found on the process rather than in this module: pi loads an extension's file
 * through its own loader, which may give it a module of its own.
 *
 * With no session in the process - a plain pi, or the core reading the person's extensions for their providers - it is
 * nothing: turri starts with `turri`, and a plain pi stays pi.
 */

const SESSION = Symbol.for("@turri-dev/cli/session");

/** The session pi-launch.ts opened in this process, for an extension pi loads itself. */
export function setProcessTurri(turri: Turri): void {
  (globalThis as Record<symbol, unknown>)[SESSION] = turri;
}

const extension: ExtensionFactory = (pi) => {
  const turri = (globalThis as Record<symbol, Turri | undefined>)[SESSION];
  return turri?.extension(pi);
};
export default extension;
