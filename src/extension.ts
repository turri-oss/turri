import "./terminal-images.ts";
import "./cli-root.ts";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createTurriCore, LOADING_PROVIDERS, processSession } from "@turri-dev/core/terminal";
import { terminalView } from "./terminal-view.ts";

export function cliSession(persist = false) {
  return processSession(() => createTurriCore({}, { persist, view: terminalView() }));
}

// pi may load this file itself (pi -e or an older global install). Provider discovery alone needs no session.
const extension: ExtensionFactory = (pi) => process.env[LOADING_PROVIDERS] === "1" ? undefined : cliSession().extension(pi);
export default extension;
