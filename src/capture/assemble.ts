import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_FILE, CONFIG_KEYS } from "../config.ts";
import { withSetting } from "../config-edit.ts";
import { startingConfig } from "./config.ts";
import { referenceOf, referencePath, renderReference } from "./interface.ts";
import { moduleConfigFile } from "../config.ts";
import { conformanceOf } from "../stdlib.ts";
import { covers } from "./area.ts";
import { conceptsIn } from "./checks.ts";
import { applyTrials, trialTestReqs } from "./trial.ts";
import type { CodeMap } from "./map.ts";
import type { AreaState, CapturedSpec, CaptureState, Definition, FeatureOutline, Part, PartModules } from "./state.ts";

/**
 * What a capture's answers become: for each part, an import module in `template/` with what every module of the part
 * shares - the stack, the test reqs, the concepts used across modules - and its modules, each a concern of its own, in
 * the order they are built, each requiring the one before it: as its features were gathered, else as the code's areas
 * make them; the functional specs of each module feature by feature, a comment line naming each feature; a test plain
 * file for every functional spec with scenarios. Pure until `writeCapture` puts it on disk.
 */

export interface ModuleFeature {
  key: string;
  title: string;
  specs: CapturedSpec[];
}

export interface AssembledModule {
  name: string;
  part: string;
  about: string;
  requires?: string;
  shared: string;
  definitions: Definition[];
  features: ModuleFeature[];
}

export interface SharedModule {
  name: string;
  part: string;
  about: string;
  imports: string[];
  definitions: Definition[];
  implementationReqs: string[];
  testReqs: string[];
}

export interface ConceptConflict {
  part: string;
  concept: string;
  texts: string[];
  /** Functional specs that use it, as `module:func-id` and their text. */
  uses: Array<{ where: string; text: string }>;
}

export interface Assembly {
  shared: SharedModule[];
  modules: AssembledModule[];
  /** Concepts defined twice in different words with no reconciled text yet. */
  conflicts: ConceptConflict[];
}

/** A part's leaf areas in build order: the part's area, then each split's areas in their order. */
export function leavesOf(state: CaptureState, part: string): AreaState[] {
  const leaves: AreaState[] = [];
  const visit = (id: string) => {
    const area = state.areas[id];
    if (area === undefined || area.failed !== undefined) return;
    if (area.children !== undefined) for (const child of area.children) visit(child);
    else if (area.features !== undefined) leaves.push(area);
  };
  visit(part);
  return leaves;
}

export function featureKey(area: string, feature: string): string {
  return `${area}#${feature}`;
}

/** Whether the division merged a feature into others: it is never written, its behaviour theirs. */
export function isMerged(state: CaptureState, key: string): boolean {
  return Object.values(state.divided ?? {}).some((division) => division.merged[key] !== undefined);
}

/** A feature as its area's outline gave it, by key. */
export function outlinedFeature(state: CaptureState, key: string): FeatureOutline | undefined {
  const at = key.lastIndexOf("#");
  return state.areas[key.slice(0, at)]?.features?.find((feature) => feature.name === key.slice(at + 1));
}

/** The features the division merged into a feature, by key, with why. */
export function mergedInto(state: CaptureState, key: string): Array<{ key: string; why: string }> {
  return Object.values(state.divided ?? {}).flatMap((division) => Object.entries(division.merged).filter(([, merged]) => merged.into.includes(key)).map(([from, merged]) => ({ key: from, why: merged.why })));
}

/** Where a feature is built: its outline's paths, and those of the features the division merged into it. */
export function featurePaths(state: CaptureState, key: string): string[] {
  return [...new Set([...(outlinedFeature(state, key)?.paths ?? []), ...mergedInto(state, key).flatMap((from) => outlinedFeature(state, from.key)?.paths ?? [])])];
}

/** A part's features in build order, each with its leaf - those merged left out unless asked for. */
export function featuresOf(state: CaptureState, part: string, options: { merged?: boolean } = {}): Array<{ key: string; leaf: AreaState; feature: FeatureOutline }> {
  return leavesOf(state, part).flatMap((leaf) =>
    (leaf.features ?? []).map((feature) => ({ key: featureKey(leaf.id, feature.name), leaf, feature })).filter((item) => options.merged === true || !isMerged(state, item.key)),
  );
}

/**
 * The most functional specs a module holds when an area's leaves are gathered into it: past this, its areas are modules
 * of their own. Splitting is about what one agent can see; a module is about what a person reads in one file.
 */
export const MODULE_SPECS = 40;

/** One module's worth of leaves: an area whose captured functional specs, all its leaves together, fit in one module. */
interface ModuleGroup {
  area: AreaState;
  leaves: AreaState[];
}

function specsUnder(state: CaptureState, leaves: AreaState[]): number {
  return leaves.reduce((sum, leaf) => sum + (leaf.features ?? []).reduce((inner, feature) => inner + (state.features[featureKey(leaf.id, feature.name)]?.captured?.specs.length ?? 0), 0), 0);
}

/**
 * A part's modules, in build order: an area whose leaves hold `MODULE_SPECS` functional specs or fewer is one module,
 * named after it; a larger one is its areas' modules, each worked out the same way. A small codebase split for its
 * agents' sake is still one module.
 */
export function moduleGroups(state: CaptureState, part: string, moduleSpecs: number = MODULE_SPECS): ModuleGroup[] {
  const leavesUnder = (id: string): AreaState[] => {
    const area = state.areas[id];
    if (area === undefined || area.failed !== undefined) return [];
    if (area.children !== undefined) return area.children.flatMap(leavesUnder);
    return area.features !== undefined ? [area] : [];
  };
  const groups = (id: string): ModuleGroup[] => {
    const area = state.areas[id];
    if (area === undefined || area.failed !== undefined) return [];
    const leaves = leavesUnder(id);
    if (area.children === undefined || specsUnder(state, leaves) <= moduleSpecs) return leaves.length > 0 ? [{ area, leaves }] : [];
    return area.children.flatMap(groups);
  };
  return groups(part);
}

/** A name not among those taken: the name itself, or with -2, -3, ... */
function unique(name: string, taken: Set<string>): string {
  let candidate = name;
  for (let n = 2; taken.has(candidate); n += 1) candidate = `${name}-${n}`;
  taken.add(candidate);
  return candidate;
}

/** The name of a part's import module. */
export function sharedName(part: string): string {
  return `${part}-shared`;
}

/**
 * The capture's answers as modules. `trials: false` leaves out what trying the scenarios on the original found: the
 * scenarios as they were before it, which is what it tries.
 */
export function assemble(state: CaptureState, moduleSpecs: number = MODULE_SPECS, options: { trials?: boolean } = {}): Assembly {
  const parts = state.survey?.parts ?? [];
  const taken = new Set(parts.map((part) => sharedName(part.name)));
  const shared: SharedModule[] = [];
  const modules: AssembledModule[] = [];
  const conflicts: ConceptConflict[] = [];
  for (const part of parts) {
    const gathered = state.gathered?.[part.name];
    const partModules = chained(gathered !== undefined && gathered.failed === undefined ? gatheredModules(state, part.name, gathered, taken) : areaModules(state, part.name, moduleSpecs, taken));
    const placed = placeConcepts(state, part, partModules);
    conflicts.push(...placed.conflicts);
    shared.push({
      name: sharedName(part.name),
      part: part.name,
      about: part.about,
      imports: part.stdlibStack !== undefined ? [part.stdlibStack, ...(part.stdlibConformance === true ? [conformanceOf(part.stdlibStack)] : [])] : [],
      definitions: placed.shared,
      // The conventions every feature follows are the part's to keep, as the stack's own are the stack's.
      implementationReqs: [...part.implementationReqs, ...(part.conventions ?? []).map((convention) => convention.text)],
      testReqs: part.testReqs,
    });
    modules.push(...partModules);
  }
  // The readability pass's new texts, where it rewrote a functional spec; the interface check's corrections over them;
  // and last what trying the scenarios on the original found.
  for (const module of modules) {
    const specs = module.features.flatMap((feature) => feature.specs);
    const edits = state.edits[module.name] ?? {};
    for (const spec of specs) if (edits[spec.funcId] !== undefined) spec.text = edits[spec.funcId]!;
    for (const correction of state.corrections?.[module.name] ?? []) {
      const spec = specs.find((candidate) => candidate.funcId === correction.funcId);
      if (spec === undefined) continue;
      if (correction.scenarioId === undefined) spec.text = correction.text;
      else for (const scenario of [...spec.conformance, ...spec.acceptance]) if (scenario.id === correction.scenarioId) scenario.text = correction.text;
    }
    if (options.trials !== false) applyTrials(module, Object.values(state.trials?.[module.name] ?? {}));
  }
  // What a conformance test must set up for the original to act as the scenarios say: the part's test reqs, for every module.
  if (options.trials !== false) {
    for (const module of shared) {
      const found = trialTestReqs(modules.filter((candidate) => candidate.shared === module.name).flatMap((candidate) => Object.values(state.trials?.[candidate.name] ?? {})));
      module.testReqs = [...module.testReqs, ...found.filter((req) => !module.testReqs.includes(req))];
    }
  }
  return { shared, modules, conflicts };
}

/** A part's modules as the code's areas make them, in the order of their code: `moduleGroups`, each named after its area. */
export function areaModules(state: CaptureState, part: string, moduleSpecs: number, taken: Set<string>): AssembledModule[] {
  return moduleGroups(state, part, moduleSpecs).flatMap((group) => {
    const features = group.leaves.flatMap((leaf) => (leaf.features ?? []).flatMap((feature) => moduleFeature(state, leaf, feature)));
    return features.length === 0 ? [] : [{ name: unique(group.area.name, taken), part, about: group.area.about, shared: sharedName(part), definitions: [], features: withUniqueIds(features) }];
  });
}

/**
 * A part's modules as its features were gathered, by concern, in the order they are built. A feature no module took -
 * written after they were gathered - goes with the features of its area, else to the last module.
 */
function gatheredModules(state: CaptureState, part: string, gathered: PartModules, taken: Set<string>): AssembledModule[] {
  const features = new Map(leavesOf(state, part).flatMap((leaf) => (leaf.features ?? []).flatMap((feature) => moduleFeature(state, leaf, feature))).map((feature) => [feature.key, feature]));
  const placed = new Set<string>();
  const modules = gathered.modules.map((module) => ({
    module,
    features: module.features.flatMap((key) => {
      const feature = features.get(key);
      if (feature === undefined || placed.has(key)) return [];
      placed.add(key);
      return [feature];
    }),
  }));
  for (const [key, feature] of features) {
    if (placed.has(key)) continue;
    const area = key.slice(0, key.lastIndexOf("#"));
    (modules.find((candidate) => candidate.features.some((other) => other.key.startsWith(`${area}#`))) ?? modules.at(-1))?.features.push(feature);
  }
  return modules
    .filter((candidate) => candidate.features.length > 0)
    .map(({ module, features: own }) => ({ name: unique(module.name, taken), part, about: module.about, shared: sharedName(part), definitions: [], features: withUniqueIds(own) }));
}

/** A part's modules chained in the order given, each requiring the one before it. */
function chained(modules: AssembledModule[]): AssembledModule[] {
  return modules.map((module, index) => (index === 0 ? module : { ...module, requires: modules[index - 1]!.name }));
}

function moduleFeature(state: CaptureState, leaf: AreaState, feature: FeatureOutline): ModuleFeature[] {
  const key = featureKey(leaf.id, feature.name);
  const captured = state.features[key]?.captured;
  if (captured === undefined || captured.specs.length === 0) return [];
  // The scenarios the gathering rewrote to need only the modules before their own.
  const gathered = state.gathered?.[leaf.part];
  const rewrites = gathered?.failed === undefined ? (gathered?.rewrites ?? []).filter((rewrite) => rewrite.feature === key) : [];
  const text = (funcId: string, scenario: { id: string; text: string }) => rewrites.find((rewrite) => rewrite.funcId === funcId && rewrite.scenarioId === scenario.id)?.text ?? scenario.text;
  // Copied down to each scenario: what is applied over them - the readability pass, the interface check - never reaches the state.
  return [
    {
      key,
      title: feature.title,
      specs: captured.specs.map((spec) => ({
        ...spec,
        conformance: spec.conformance.map((scenario) => ({ ...scenario, text: text(spec.funcId, scenario) })),
        acceptance: spec.acceptance.map((scenario) => ({ ...scenario, text: text(spec.funcId, scenario) })),
      })),
    },
  ];
}

/** Func-ids made unique in their module: a second `add-item` is `add-item-2`. */
function withUniqueIds(features: ModuleFeature[]): ModuleFeature[] {
  const taken = new Set<string>();
  return features.map((feature) => ({ ...feature, specs: feature.specs.map((spec) => ({ ...spec, funcId: unique(spec.funcId, taken) })) }));
}

/** Every text of a module that can use a concept: its functional specs and their scenarios. */
function moduleTexts(module: AssembledModule): string[] {
  return module.features.flatMap((feature) => feature.specs.flatMap((spec) => [spec.text, ...spec.conformance.map((s) => s.text), ...spec.acceptance.map((s) => s.text)]));
}

/**
 * Where each concept the feature writers defined goes: a concept defined in one module and used only there stays in it;
 * one defined in several modules, or used in one it is not defined in, goes to the part's import module - with every
 * concept its definition uses, so the import module never uses a concept it cannot see. A concept defined in different
 * words is a conflict, until it is reconciled.
 */
function placeConcepts(state: CaptureState, part: Part, modules: AssembledModule[]): { shared: Definition[]; conflicts: ConceptConflict[] } {
  const core = new Set(part.definitions.map((definition) => definition.concept));
  const defined = new Map<string, Array<{ module: string; text: string }>>();
  for (const module of modules) {
    for (const feature of module.features) {
      for (const definition of state.features[feature.key]?.captured?.definitions ?? []) {
        if (core.has(definition.concept)) continue;
        const variants = defined.get(definition.concept) ?? [];
        variants.push({ module: module.name, text: definition.text });
        defined.set(definition.concept, variants);
      }
    }
  }
  const uses = new Map<string, Set<string>>();
  const used = (concept: string, module: string) => uses.set(concept, (uses.get(concept) ?? new Set()).add(module));
  for (const module of modules) for (const concept of moduleTexts(module).flatMap(conceptsIn)) used(concept, module.name);
  // A definition uses concepts too, in the module it is defined in.
  for (const [concept, variants] of defined) for (const variant of variants) for (const other of conceptsIn(variant.text)) if (other !== concept) used(other, variant.module);
  const reconciled = state.reconciled[part.name] ?? {};
  const chosen = (concept: string) => reconciled[concept] ?? defined.get(concept)![0]!.text;

  const sharedSet = new Set<string>();
  for (const [concept, variants] of defined) {
    const definedIn = new Set(variants.map((variant) => variant.module));
    const usedIn = uses.get(concept) ?? new Set();
    if (definedIn.size > 1 || [...usedIn].some((module) => !definedIn.has(module))) sharedSet.add(concept);
  }
  // A shared concept's definition uses only what the import module sees - every variant's, before they are reconciled.
  for (let grew = true; grew; ) {
    grew = false;
    for (const concept of [...sharedSet]) {
      for (const text of reconciled[concept] !== undefined ? [reconciled[concept]!] : defined.get(concept)!.map((variant) => variant.text)) {
        for (const used of conceptsIn(text)) {
          if (defined.has(used) && !sharedSet.has(used)) {
            sharedSet.add(used);
            grew = true;
          }
        }
      }
    }
  }
  const conflicts: ConceptConflict[] = [];
  for (const [concept, variants] of defined) {
    const texts = [...new Set(variants.map((variant) => variant.text))];
    if (texts.length < 2 || reconciled[concept] !== undefined) continue;
    conflicts.push({
      part: part.name,
      concept,
      texts,
      uses: modules.flatMap((module) =>
        module.features.flatMap((feature) => feature.specs.filter((spec) => conceptsIn(spec.text).includes(concept)).map((spec) => ({ where: `${module.name}:${spec.funcId}`, text: spec.text }))),
      ),
    });
  }

  for (const module of modules) {
    const own = [...defined].filter(([concept, variants]) => !sharedSet.has(concept) && variants.some((variant) => variant.module === module.name)).map(([concept]) => ({ concept, text: chosen(concept) }));
    module.definitions = inDefinitionOrder(own);
  }
  const shared = [...part.definitions, ...inDefinitionOrder([...sharedSet].map((concept) => ({ concept, text: chosen(concept) })))];
  return { shared: inDefinitionOrder(shared), conflicts };
}

/** Definitions with each after the concepts its text uses, where they are among them; otherwise in the order given. */
export function inDefinitionOrder(definitions: Definition[]): Definition[] {
  const byConcept = new Map(definitions.map((definition) => [definition.concept, definition]));
  const placed: Definition[] = [];
  const done = new Set<string>();
  const visiting = new Set<string>();
  const visit = (definition: Definition) => {
    if (done.has(definition.concept) || visiting.has(definition.concept)) return;
    visiting.add(definition.concept);
    for (const used of conceptsIn(definition.text)) {
      const dependency = byConcept.get(used);
      if (dependency !== undefined && used !== definition.concept) visit(dependency);
    }
    visiting.delete(definition.concept);
    done.add(definition.concept);
    placed.push(definition);
  };
  for (const definition of definitions) visit(definition);
  return placed;
}

/** A YAML scalar that reads back as the text, whatever it holds. */
function yamlText(text: string): string {
  return JSON.stringify(text.replace(/\s+/g, " ").trim());
}

function section(title: string, bullets: string[]): string[] {
  return bullets.length === 0 ? [] : [`***${title}***`, "", ...bullets.map((bullet) => `- ${bullet}`), ""];
}

function frontmatter(fields: Array<[string, string[] | string | undefined]>): string[] {
  const lines = ["---"];
  for (const [key, value] of fields) {
    if (value === undefined || (Array.isArray(value) && value.length === 0)) continue;
    if (Array.isArray(value)) lines.push(`${key}:`, ...value.map((item) => `  - ${item}`));
    else lines.push(`${key}: ${yamlText(value)}`);
  }
  lines.push("---", "");
  return lines;
}

export function renderShared(module: SharedModule): string {
  return [
    ...frontmatter([
      ["import", module.imports],
      ["description", `What every module of ${module.part} shares: ${module.about}`],
    ]),
    ...section("definitions", module.definitions.map((definition) => definition.text)),
    ...section("implementation reqs", module.implementationReqs),
    ...section("test reqs", module.testReqs),
  ]
    .join("\n")
    .trimEnd()
    .concat("\n");
}

export function renderModule(module: AssembledModule): string {
  const specs = module.features.flatMap((feature) => feature.specs.flatMap((spec) => [`# ${spec.funcId}`, spec.text.trim(), ""]));
  return [
    ...frontmatter([
      ["import", [module.shared]],
      ["requires", module.requires !== undefined ? [module.requires] : undefined],
      ["description", module.about],
    ]),
    ...section("definitions", module.definitions.map((definition) => definition.text)),
    "***functional specs***",
    "",
    ...specs,
  ]
    .join("\n")
    .trimEnd()
    .concat("\n");
}

export function renderTestPlainFile(module: string, spec: CapturedSpec): string | undefined {
  if (spec.conformance.length === 0 && spec.acceptance.length === 0) return undefined;
  const scenarios = (title: string, list: CapturedSpec["conformance"]) => (list.length === 0 ? [] : [`***${title}***`, "", ...list.flatMap((scenario) => [`# ${scenario.id}`, scenario.text.trim(), ""])]);
  return ["---", `module: ${module}`, `func_id: ${spec.funcId}`, "---", "", ...scenarios("conformance tests", spec.conformance), ...scenarios("acceptance tests", spec.acceptance)].join("\n").trimEnd().concat("\n");
}

/** The files a capture writes, by path relative to its folder: the modules, the import modules, the test plain files. */
export function captureFiles(assembly: Assembly): Map<string, string> {
  const files = new Map<string, string>();
  for (const module of assembly.shared) files.set(`template/${module.name}.plain`, renderShared(module));
  for (const module of assembly.modules) {
    files.set(`${module.name}.plain`, renderModule(module));
    for (const feature of module.features) {
      for (const spec of feature.specs) {
        const text = renderTestPlainFile(module.name, spec);
        if (text !== undefined) files.set(`tests/${module.name}/${spec.funcId}.plain`, text);
      }
    }
  }
  return files;
}

/** The asset files capture copies into `assets/`: images, fonts and media of the parts, none of what is left out. */
export function assetsToCopy(map: CodeMap, state: CaptureState): string[] {
  const parts = state.survey?.parts ?? [];
  const leftOut = [...(state.survey?.leftOut ?? []), ...Object.values(state.areas).flatMap((area) => area.leftOut ?? [])];
  return map.files
    .filter((file) => file.kind === "asset")
    .filter((file) => parts.some((part) => part.paths.some((path) => covers(path, file.path))))
    .filter((file) => !leftOut.some((item) => covers(item.path, file.path)))
    .map((file) => file.path);
}

/**
 * The project's config, over what it holds already - the config in use it started as (`capture/config.ts`): conformance
 * tests on, the assets as the base folder, the models when they were named. A capture started before it held one starts
 * from nothing.
 */
export function configText(existing: string, options: { assets: boolean; harnessModel?: string; codingModel?: string }): string {
  const from = existing.trim() === "" ? startingConfig(undefined, options) : existing;
  return withSetting(withSetting(from, CONFIG_KEYS.conformanceTests, true), CONFIG_KEYS.baseFolder, options.assets ? "assets" : undefined);
}

/** Put a capture on disk: its ***plain, its config, the assets copied, and what keeps the regenerated code's histories out of the repo. */
export function writeCapture(plainDir: string, map: CodeMap, state: CaptureState, assembly: Assembly, models: { harnessModel?: string; codingModel?: string }): string[] {
  const written: string[] = [];
  const put = (path: string, text: string) => {
    const file = join(plainDir, ...path.split("/"));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
    written.push(path);
  };
  for (const [path, text] of captureFiles(assembly)) put(path, text);
  const assets = assetsToCopy(map, state);
  for (const path of assets) {
    const target = join(plainDir, "assets", ...path.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(map.root, ...path.split("/")), target);
  }
  // Each part's interface reference, which its interface concept links: exact where the ***plain is prose.
  for (const part of state.survey?.parts ?? []) {
    const { entries } = referenceOf(state, part.name);
    if (entries.length > 0) put(referencePath(part.name), renderReference(part.name, entries));
  }
  const config = join(plainDir, CONFIG_FILE);
  put(CONFIG_FILE, configText(existsSync(config) ? readFileSync(config, "utf8") : "", { assets: assets.length > 0, ...models }));
  // A part of its own: its testing scripts go in a config file of its own, on its first module, which the rest of its chain reads.
  if ((state.survey?.parts.length ?? 0) > 1) {
    for (const part of state.survey!.parts) {
      const first = assembly.modules.find((module) => module.part === part.name);
      if (first === undefined) continue;
      const file = moduleConfigFile(first.name);
      if (!existsSync(join(plainDir, file))) put(file, `# ${part.name}: ${part.about.replace(/\s+/g, " ")} - its settings over ${CONFIG_FILE}, its testing scripts above all.\n`);
    }
  }
  if (!existsSync(join(plainDir, ".gitignore"))) put(".gitignore", "plain_modules/**/.plaingit/\n");
  return written;
}
