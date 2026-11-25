import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { basename, dirname, join, posix } from "node:path";
import type { AssembledModule } from "./assemble.ts";
import { LOCK_FILES, type CodeMap } from "./map.ts";
import type { TrialBatch } from "./state.ts";

/**
 * The scenarios tried on the original, before the ***plain is written. They are what the regenerated code's conformance
 * tests check, written by agents that read the original's code and tests but never ran it - so a scenario can expect a
 * terminal its test will not give, a site on the internet, wrapping at a width nobody set, or a message the original never
 * prints. A coding agent then builds to it, or its module's conformance tests fail for good. So an agent with a shell on
 * a copy of the original runs each as its conformance test will, and corrects what the original does otherwise.
 */

/** The most scenarios one agent tries on the original: a module's are tried by as many agents as it takes, one after another. */
export const SCENARIOS_PER_TRIAL = 20;

/** A scenario as an agent is given it to try. */
export interface TrialScenario {
  funcId: string;
  scenarioId: string;
  kind: "conformance" | "acceptance";
  text: string;
}

/** A module's scenarios, in its order, so many an agent. */
export function trialBatches(module: AssembledModule, size: number = SCENARIOS_PER_TRIAL): TrialScenario[][] {
  const scenarios = module.features.flatMap((feature) =>
    feature.specs.flatMap((spec) => [
      ...spec.conformance.map((scenario): TrialScenario => ({ funcId: spec.funcId, scenarioId: scenario.id, kind: "conformance", text: scenario.text })),
      ...spec.acceptance.map((scenario): TrialScenario => ({ funcId: spec.funcId, scenarioId: scenario.id, kind: "acceptance", text: scenario.text })),
    ]),
  );
  const batches: TrialScenario[][] = [];
  for (let at = 0; at < scenarios.length; at += size) batches.push(scenarios.slice(at, at + size));
  return batches;
}

/** turri's own config files: a copy holding one would be a turri project of its own, read with its settings. */
function isTurriConfig(path: string): boolean {
  return /^config\.turri(\..+)?\.yaml$/.test(basename(path));
}

/**
 * A copy of the original codebase, for an agent to install and run without touching it: every file the map has - what
 * git tracks, none of what it ignores, so none of the dependencies installed - and the lock files beside its manifests,
 * which the map leaves out, so the copy installs the versions the original pins; but turri's own config files.
 */
export function copyOriginal(map: CodeMap, target: string): void {
  const copy = (path: string) => {
    const to = join(target, ...path.split("/"));
    mkdirSync(dirname(to), { recursive: true });
    try {
      copyFileSync(join(map.root, ...path.split("/")), to);
    } catch {
      /* gone since the map was made: nothing to copy */
    }
  };
  for (const file of map.files) if (!isTurriConfig(file.path)) copy(file.path);
  const manifestDirs = new Set(map.files.filter((file) => file.kind === "manifest").map((file) => posix.dirname(file.path)));
  for (const dir of manifestDirs) {
    for (const name of LOCK_FILES) {
      const path = dir === "." ? name : posix.join(dir, name);
      if (existsSync(join(map.root, ...path.split("/")))) copy(path);
    }
  }
}

/**
 * A module with what its scenarios' trials found applied: each scenario the original does otherwise corrected, each that
 * nothing outside can check removed, each functional spec the original contradicts corrected.
 */
export function applyTrials(module: AssembledModule, batches: TrialBatch[]): void {
  const specs = module.features.flatMap((feature) => feature.specs);
  for (const batch of batches) {
    if (!("results" in batch)) continue;
    for (const correction of batch.specs) {
      const spec = specs.find((candidate) => candidate.funcId === correction.funcId);
      if (spec !== undefined) spec.text = correction.text;
    }
    for (const result of batch.results) {
      const spec = specs.find((candidate) => candidate.funcId === result.funcId);
      if (spec === undefined) continue;
      if (result.outcome === "corrected" && result.text !== undefined) {
        for (const scenario of [...spec.conformance, ...spec.acceptance]) if (scenario.id === result.scenarioId) scenario.text = result.text;
      }
      if (result.outcome === "removed") {
        spec.conformance = spec.conformance.filter((scenario) => scenario.id !== result.scenarioId);
        spec.acceptance = spec.acceptance.filter((scenario) => scenario.id !== result.scenarioId);
      }
    }
  }
}

/** The test reqs the trials of some modules found a conformance test needs, each once, in the order they were found. */
export function trialTestReqs(batches: TrialBatch[]): string[] {
  return [...new Set(batches.flatMap((batch) => ("testReqs" in batch ? batch.testReqs : [])))];
}
