import { resolve } from "node:path";
import type { ScriptKind } from "./test-scripts.ts";

/**
 * The testing scripts being written in the background - by a skill run cultivate started (docs/skills-and-gates.md): while
 * one is, the work loop holds the modules that need it, rather than fail their pulses for the script they lack, and it
 * looks at them again once the run ends. On `globalThis`, as the chat's scope is: pi's own loader may load this file twice.
 */
export interface ScriptBeingWritten {
  /** The project's folder. */
  project: string;
  kind: ScriptKind;
  /** The stack it is written for, when the run was for one. */
  stack?: string;
}

interface Writing {
  runs: Set<ScriptBeingWritten>;
  ended: Set<() => void>;
}

const KEY = Symbol.for("turri.scriptsBeingWritten");
const writing = (): Writing => ((globalThis as Record<symbol, Writing | undefined>)[KEY] ??= { runs: new Set(), ended: new Set() });

/** A script being written from now: what it returns says it is no longer, written or not. */
export function writingScript(run: ScriptBeingWritten): () => void {
  const entry = { ...run, project: resolve(run.project) };
  writing().runs.add(entry);
  return () => {
    if (!writing().runs.delete(entry)) return;
    for (const listener of [...writing().ended]) {
      try {
        listener();
      } catch {
        /* what listens never stops the run's end */
      }
    }
  };
}

/** Whether a script of this kind is being written for a module of this project on this stack - one written for no stack is anyone's. */
export function scriptBeingWritten(project: string, kind: ScriptKind, stack?: string): boolean {
  const folder = resolve(project);
  return [...writing().runs].some((run) => run.project === folder && run.kind === kind && (run.stack === undefined || stack === undefined || run.stack === stack));
}

/** Told each time a run writing a script ends. Returns what stops it. */
export function onScriptRunEnded(listener: () => void): () => void {
  writing().ended.add(listener);
  return () => writing().ended.delete(listener);
}
