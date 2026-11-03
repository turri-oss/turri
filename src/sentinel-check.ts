import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { PLAIN_SOURCE_FILE_EXTENSION, withParseCache } from "./plain/parser.ts";
import { ACCEPTANCE_TESTS, CONFORMANCE_TESTS, FUNCTIONAL_REQUIREMENTS, REQUIRED_FUNCTIONAL_SPECS } from "./plain/spec.ts";
import { chainSpec, codebaseCompletion } from "./regenerate/loop.ts";
import { builtTips, isImportModule, projectPlainFiles, resolveRequiresChain, type ChainEntry } from "./regenerate/requires.ts";
import type { SentinelCheck } from "./notice.ts";

/**
 * A check a host asks the sentinel for (docs/sentinel.md): functional specs of one module, tested in the module's release -
 * its own codebase's last commit, which holds the code of every module its requires chain builds on. Refused before it is
 * queued when there is nothing to test: a module that is not there or does not parse, a func-id it does not have, one
 * not built in its codebase as its ***plain has it now.
 */

export interface CheckRequest {
  /** The module, by name: its .plain file's, in the project's folder. */
  module: string;
  /**
   * The functional specs to test, each `module:func-id` - of the module, or of any module its requires chain builds on,
   * whose code its release holds. A bare func-id is the module's own.
   */
  funcIds: string[];
}

/** A host's check, found good to queue - or why not, saying which. */
export function prepareCheck(project: string, request: CheckRequest): SentinelCheck | { refused: string } {
  return withParseCache(() => {
    const name = (request.module ?? "").trim();
    const file = projectPlainFiles(project).find((path) => basename(path, PLAIN_SOURCE_FILE_EXTENSION) === name);
    if (name === "" || file === undefined) return { refused: `There is no module ${name === "" ? "named" : name} in the project: no .plain file of its folder is ${name || "<module>"}.plain.` };
    if (isImportModule(file)) return { refused: `${name} is an import module: it has no codebase of its own to release. Check a module that imports it.` };
    let chain: ChainEntry[];
    try {
      chain = resolveRequiresChain(file, [], undefined, { allowNoFunctionalities: true });
    } catch (error) {
      return { refused: `${name} does not parse: ${error instanceof Error ? error.message : String(error)}` };
    }
    const tip = chain.at(-1)!;
    const asked = [...new Set((request.funcIds ?? []).map((funcId) => funcId.trim()).filter((funcId) => funcId !== ""))];
    if (asked.length === 0) return { refused: `Name at least one of ${whose(name)} functional specs to check, by func-id.` };

    // Each as the module and func-id it is - `module:func-id`, a bare func-id the module's own.
    const named = asked.map((funcId) => {
      const colon = funcId.indexOf(":");
      const module = colon === -1 ? name : funcId.slice(0, colon).trim();
      const id = colon === -1 ? funcId : funcId.slice(colon + 1).trim();
      return { module, id, label: `${module}:${id}` };
    });
    // Only what its release holds: the module and the modules its requires chain builds on.
    const inChain = new Map(chain.map((entry) => [entry.moduleName, entry]));
    const outside = named.filter(({ module }) => !inChain.has(module));
    if (outside.length > 0) {
      const below = chain.slice(0, -1).map((entry) => entry.moduleName);
      return {
        refused:
          `Not in ${whose(name)} release: ${outside.map((spec) => spec.label).join(", ")} - ${[...new Set(outside.map((spec) => spec.module))].join(", ")} ${new Set(outside.map((spec) => spec.module)).size === 1 ? "is" : "are"} not ${name} or a module its requires chain builds on` +
          `${below.length > 0 ? ` (${below.join(", ")})` : ` - it builds on none`}.`,
      };
    }
    const unknown = named.filter(({ module, id }) => !inChain.get(module)!.funcIds.includes(id));
    if (unknown.length > 0) return { refused: `No such functional spec: ${unknown.map((spec) => `${spec.module} has no ${spec.id}`).join("; ")}.` };

    // Built in its own codebase, as its ***plain has it now: its record, as last committed, holds it.
    const completion = codebaseCompletion(chain);
    const incomplete = new Set(completion.codebase === tip.buildDir ? completion.modules.flatMap((module) => module.incomplete.map((id) => `${module.module}\0${id}`)) : named.map(({ module, id }) => `${module}\0${id}`));
    const notBuilt = named.filter(({ module, id }) => incomplete.has(`${module}\0${id}`));
    if (notBuilt.length > 0) {
      const above = builtTips(file).map((built) => built.at(-1)!.moduleName).filter((module) => module !== name);
      return {
        refused:
          `Not built in ${whose(name)} codebase as its ***plain has ${notBuilt.length === 1 ? "it" : "them"} now: ${notBuilt.map((spec) => spec.label).join(", ")}.` +
          (above.length > 0 ? ` ${whose(name)} code is built on in ${above.join(" and ")}'s codebase: check ${above.length === 1 ? above[0] : "one of them"}, naming ${notBuilt.length === 1 ? "it" : "them"} as ${name}:<func-id>.` : ""),
      };
    }
    return { id: randomUUID().slice(0, 8), module: name, plainFile: file, funcIds: named.map((spec) => spec.label), at: new Date().toISOString() };
  });
}

/** A module's, in words: predators', app's. */
const whose = (name: string) => (name.endsWith("s") ? `${name}'` : `${name}'s`);

/** A functional spec of a check, as turri reads it now: what it says, and its scenarios. */
export interface CheckedSpec {
  /** As the check names it: `module:func-id`. */
  funcId: string;
  text: string;
  conformance: Array<{ id: string; text: string }>;
  acceptance: Array<{ id: string; text: string }>;
}

/** The check's functional specs as the module's ***plain has them now, with their scenarios - in the brief. */
export function checkedSpecs(check: SentinelCheck): CheckedSpec[] {
  const tree = chainSpec(resolveRequiresChain(check.plainFile, [], undefined, { allowNoFunctionalities: true })).tree;
  type Item = { id?: string; markdown?: string; module?: string; [CONFORMANCE_TESTS]?: Array<{ id?: string; text?: string }>; [ACCEPTANCE_TESTS]?: Array<{ id?: string; text?: string }> };
  const own = (tree[FUNCTIONAL_REQUIREMENTS] as Item[] | undefined) ?? [];
  const inherited = (tree[REQUIRED_FUNCTIONAL_SPECS] as Item[] | undefined) ?? [];
  const scenarios = (list: Item[typeof CONFORMANCE_TESTS]) => (list ?? []).map((scenario) => ({ id: String(scenario.id ?? ""), text: String(scenario.text ?? "").trim() }));
  return check.funcIds.flatMap((funcId) => {
    const colon = funcId.indexOf(":");
    const module = colon === -1 ? check.module : funcId.slice(0, colon);
    const id = colon === -1 ? funcId : funcId.slice(colon + 1);
    const item = module === check.module ? own.find((each) => each.id === id) : inherited.find((each) => each.module === module && each.id === id);
    if (item === undefined) return [];
    return [{ funcId, text: String(item.markdown ?? "").trim(), conformance: scenarios(item[CONFORMANCE_TESTS]), acceptance: scenarios(item[ACCEPTANCE_TESTS]) }];
  });
}
