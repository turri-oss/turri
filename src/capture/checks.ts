import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONCEPTS, extractConceptsFromSpecText } from "../plain/concepts.ts";
import { stronglyConnectedComponents } from "../plain/cycles.ts";
import { parseMarkdown, traverse } from "../plain/markdown.ts";
import { isStack, stdlibTemplates } from "../stdlib.ts";
import { covers, filesOf } from "./area.ts";
import { existsInMap, type CodeMap } from "./map.ts";
import { entrySurface, featureText, interfaceIn, namedExactly, namedIn, shownSurface } from "./interface.ts";
import type { CapturedFeature, CapturedSpec, Convention, Correction, Definition, FeatureOutline, GatheredModule, InterfaceEntry, InterfaceExclusion, InterfaceSurface, LeftOut, ModuleRewrite, Survey, TrialResult } from "./state.ts";

/**
 * What the harness checks of each answer a capture agent hands over, before it is kept: what would make ***plain that
 * does not parse, a path that is not there, a feature over its budget. Each problem is said so the agent can fix it.
 */

/** The most functional specs one feature is captured in. */
export const MAX_SPECS_PER_FEATURE = 8;
/**
 * The scenarios a feature may have in all: a few, and more the more the original tests it - one for each so many lines
 * of the original's tests in its files - up to a most. Scenarios go where the original's tests are densest.
 */
export const BASE_SCENARIOS = 8;
export const TEST_LINES_PER_SCENARIO = 50;
export const MAX_SCENARIOS_PER_FEATURE = 30;

/** The scenarios a feature may have, from the lines of the original's tests in its files. */
export function scenarioBudget(testLines: number): number {
  return Math.min(MAX_SCENARIOS_PER_FEATURE, BASE_SCENARIOS + Math.floor(testLines / TEST_LINES_PER_SCENARIO));
}
/** The longest a functional spec may be, in characters: a few short lines, never a page. */
export const MAX_SPEC_CHARS = 1500;
/** The most features one leaf is outlined into. */
export const MAX_FEATURES_PER_LEAF = 20;

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CONCEPT = /^:[A-Z][+\-.0-9A-Za-z_]*:$/;

export function isKebab(id: string): boolean {
  return KEBAB.test(id);
}

/** Every concept a text uses. */
export function conceptsIn(text: string): string[] {
  return [...new Set(extractConceptsFromSpecText(text))];
}

/** What is wrong with a piece of ***plain text, as a functional spec's body or a scenario's - its lines the parser would read as something else. */
function badLines(what: string, text: string): string[] {
  const problems: string[] = [];
  if (text.trim() === "") problems.push(`${what} is empty.`);
  if (/^#\s/m.test(text)) problems.push(`${what} has a line starting with "# ", which would start a new functional spec or scenario.`);
  if (/^\*\*\*/m.test(text)) problems.push(`${what} has a line starting with ***, which would start a section.`);
  return [...problems, ...links(what, text)];
}

/** What is wrong with a bullet: it is one line, and not empty. */
function badBullet(what: string, bullet: string): string[] {
  if (bullet.trim() === "") return [`${what} is empty.`];
  if (bullet.includes("\n")) return [`${what} is more than one line: one fact a bullet, on one line.`];
  if (bullet.startsWith("- ")) return [`${what} starts with "- ": give the bullet's text alone.`];
  return links(what, bullet);
}

/**
 * The links in a text, as Markdown reads them - `<https://...>`, `[text](target)` - each a problem: a link in ***plain
 * names a file of the project, linked to the module, and the parser refuses any other. A capture links no file.
 */
function links(what: string, text: string): string[] {
  return traverse(parseMarkdown(text), "link").map((link) => {
    const target = String(link.url ?? "");
    const start = link.position?.start.offset;
    const end = link.position?.end.offset;
    const written = start !== undefined && end !== undefined ? text.slice(start, end) : target;
    return `${what} has a link, ${written}, which ***plain refuses: its links name files of the project. Write the address as code instead: \`${target}\`.`;
  });
}

/** Concepts a text uses that are not among those it may use. */
function undefinedConcepts(what: string, text: string, known: Set<string>): string[] {
  const missing = conceptsIn(text).filter((concept) => !known.has(concept) && !DEFAULT_CONCEPTS.has(concept));
  return missing.length === 0 ? [] : [`${what} uses ${missing.join(", ")}, which ${missing.length === 1 ? "is" : "are"} not defined: use a concept you were given, or define it.`];
}

/** What is wrong with definitions: a concept named wrong, predefined, defined twice or among those given already, or a text that does not start with it. */
export function definitionProblems(definitions: Definition[], given: Set<string>): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const definition of definitions) {
    const concept = definition.concept;
    if (!CONCEPT.test(concept)) problems.push(`The concept "${concept}" is not a concept name: CamelCase between colons, :LikeThis:.`);
    else if (DEFAULT_CONCEPTS.has(concept)) problems.push(`${concept} is predefined: never define it.`);
    else if (given.has(concept)) problems.push(`${concept} is given already: use it, do not define it again.`);
    else if (seen.has(concept)) problems.push(`${concept} is defined twice.`);
    seen.add(concept);
    if (!definition.text.startsWith(concept)) problems.push(`The definition of ${concept} does not start with ${concept}.`);
    problems.push(...badBullet(`The definition of ${concept}`, definition.text));
  }
  return problems;
}

/**
 * Definitions that define each other round in a circle - `:Link:` uses `:LinkCode:`, whose definition uses `:Link:` -
 * which the parser refuses: one problem a circle, naming its concepts.
 */
export function definitionCycles(definitions: Definition[]): string[] {
  const defined = new Set(definitions.map((definition) => definition.concept));
  const graph = new Map<string, string[]>();
  for (const definition of definitions) {
    const used = conceptsIn(definition.text).filter((concept) => concept !== definition.concept && defined.has(concept));
    graph.set(definition.concept, [...(graph.get(definition.concept) ?? []), ...used]);
  }
  return stronglyConnectedComponents(graph)
    .filter((component) => component.size > 1)
    .map((component) => [...defined].filter((concept) => component.has(concept)))
    .map((component) => `The definitions of ${component.join(", ")} use each other in a circle, which ***plain refuses: define one without naming the other${component.length > 2 ? "s" : ""}.`);
}

function leftOutProblems(map: CodeMap, leftOut: LeftOut[], within: string[]): string[] {
  return leftOut.flatMap((item) => {
    if (!existsInMap(map, item.path)) return [`Left out ${item.path}: no such file or folder in the map.`];
    if (!within.some((path) => covers(path, item.path))) return [`Left out ${item.path}: not in your area.`];
    // The tests show what someone cared about: what scenarios are written from, never left behind.
    const files = filesOf(map, [item.path]);
    if (files.length > 0 && files.every((file) => file.kind === "test")) return [`Left out ${item.path}: it holds the original's tests, the evidence of what the software does - keep them with the code they test.`];
    return [];
  });
}

export function surveyProblems(map: CodeMap, survey: Survey): string[] {
  const problems: string[] = [];
  if (survey.parts.length === 0) problems.push("Name at least one part.");
  const stacks = new Map(stdlibTemplates().filter(isStack).map((template) => [template.name, template]));
  const names = new Set<string>();
  survey.parts.forEach((part, index) => {
    const what = `Part ${part.name || index + 1}`;
    if (!isKebab(part.name)) problems.push(`${what}: its name is not short kebab-case.`);
    if (names.has(part.name)) problems.push(`${what}: two parts have that name.`);
    names.add(part.name);
    if (part.paths.length === 0) problems.push(`${what}: name its folders and files.`);
    for (const path of part.paths) if (!existsInMap(map, path)) problems.push(`${what}: ${path} is no file or folder in the map.`);
    survey.parts.forEach((other, at) => {
      if (at <= index) return;
      for (const path of part.paths) for (const theirs of other.paths) if (covers(path, theirs) || covers(theirs, path)) problems.push(`Parts ${part.name} and ${other.name} share ${covers(path, theirs) ? theirs : path}: two parts never share a folder.`);
    });
    if (part.stdlibStack !== undefined) {
      const stack = stacks.get(part.stdlibStack);
      if (stack === undefined) problems.push(`${what}: ${part.stdlibStack} is not a stack of the standard library - name one the catalogue lists, or none.`);
      else if (part.stdlibConformance === true && stack.conformance === undefined) problems.push(`${what}: ${part.stdlibStack} has no conformance template.`);
    } else if (part.stdlibConformance === true) {
      problems.push(`${what}: stdlib_conformance needs a stdlib_stack.`);
    }
    if (part.stdlibStack === undefined && part.implementationReqs.length === 0) problems.push(`${what}: with no stdlib_stack, write its implementation_reqs - its language, framework and storage.`);
    problems.push(...conventionProblems(map, part.conventions ?? [], undefined).map((problem) => `${what}: ${problem}`));
    if (part.stdlibConformance !== true && part.testReqs.length === 0) problems.push(`${what}: with no conformance template, write its test_reqs - how its black-box tests run.`);
    const known = new Set(part.definitions.map((definition) => definition.concept));
    problems.push(...definitionProblems(part.definitions, new Set()).map((problem) => `${what}: ${problem}`));
    part.implementationReqs.forEach((req, at) => problems.push(...badBullet(`${what}: implementation req ${at + 1}`, req), ...undefinedConcepts(`${what}: implementation req ${at + 1}`, req, known)));
    part.testReqs.forEach((req, at) => problems.push(...badBullet(`${what}: test req ${at + 1}`, req), ...undefinedConcepts(`${what}: test req ${at + 1}`, req, known)));
    (part.conventions ?? []).forEach((convention, at) => problems.push(...undefinedConcepts(`${what}: convention ${at + 1}`, convention.text, known)));
    for (const definition of part.definitions) problems.push(...undefinedConcepts(`${what}: the definition of ${definition.concept}`, definition.text, known));
    problems.push(...definitionCycles(part.definitions).map((problem) => `${what}: ${problem}`));
  });
  problems.push(...leftOutProblems(map, survey.leftOut, ["."]));
  return problems;
}

/** The files of an area that the split placed nowhere: in no area, and not left out. */
export function unplaced(map: CodeMap, within: string[], areas: Array<{ paths: string[] }>, leftOut: LeftOut[]): string[] {
  const placed = [...areas.flatMap((area) => area.paths), ...leftOut.map((item) => item.path)];
  return filesOf(map, within)
    .filter((file) => !placed.some((path) => covers(path, file.path)))
    .map((file) => file.path);
}

export function splitProblems(map: CodeMap, within: string[], answer: { areas: Array<{ name: string; about: string; paths: string[] }>; leftOut: LeftOut[] }): string[] {
  const problems: string[] = [];
  const total = filesOf(map, within).length;
  if (answer.areas.length < 2) problems.push("Split it into at least two areas.");
  const names = new Set<string>();
  answer.areas.forEach((area, index) => {
    const what = `Area ${area.name || index + 1}`;
    if (!isKebab(area.name)) problems.push(`${what}: its name is not short kebab-case.`);
    if (names.has(area.name)) problems.push(`${what}: two areas have that name.`);
    names.add(area.name);
    if (area.paths.length === 0) problems.push(`${what}: name its folders and files.`);
    for (const path of area.paths) {
      if (!existsInMap(map, path)) problems.push(`${what}: ${path} is no file or folder in the map.`);
      else if (!within.some((mine) => covers(mine, path))) problems.push(`${what}: ${path} is not in your area.`);
    }
    const files = filesOf(map, area.paths).length;
    if (area.paths.length > 0 && files === 0) problems.push(`${what}: it holds no file.`);
    if (files >= total) problems.push(`${what}: it is the whole of your area - each area must be smaller.`);
    answer.areas.forEach((other, at) => {
      if (at <= index) return;
      for (const path of area.paths) for (const theirs of other.paths) if (covers(path, theirs) || covers(theirs, path)) problems.push(`Areas ${area.name} and ${other.name} share ${covers(path, theirs) ? theirs : path}: a path is in one area only.`);
    });
  });
  problems.push(...leftOutProblems(map, answer.leftOut, within));
  const missing = unplaced(map, within, answer.areas, answer.leftOut);
  if (missing.length > 0) problems.push(`These files are in no area and not left out - place each: ${missing.slice(0, 20).join(", ")}${missing.length > 20 ? `, and ${missing.length - 20} more` : ""}.`);
  return problems;
}

export function outlineProblems(map: CodeMap, within: string[], answer: { features: FeatureOutline[]; leftOut: LeftOut[] }): string[] {
  const problems: string[] = [];
  if (answer.features.length === 0) problems.push("Outline at least one feature.");
  if (answer.features.length > MAX_FEATURES_PER_LEAF) problems.push(`${answer.features.length} features is more than ${MAX_FEATURES_PER_LEAF}: merge the smallest into those they belong with.`);
  const names = new Set<string>();
  answer.features.forEach((feature, index) => {
    const what = `Feature ${feature.name || index + 1}`;
    if (!isKebab(feature.name)) problems.push(`${what}: its name is not short kebab-case.`);
    if (names.has(feature.name)) problems.push(`${what}: two features have that name.`);
    names.add(feature.name);
    if (feature.title === "") problems.push(`${what}: give it a title.`);
    if (feature.paths.length === 0) problems.push(`${what}: name where it is built.`);
    for (const path of feature.paths) {
      if (!existsInMap(map, path)) problems.push(`${what}: ${path} is no file or folder in the map.`);
      else if (!within.some((mine) => covers(mine, path))) problems.push(`${what}: ${path} is not in your area.`);
    }
  });
  problems.push(...leftOutProblems(map, answer.leftOut, within));
  return problems;
}

/**
 * What is wrong with conventions: one more than a line or empty, one that names no file deciding it or a file not in
 * the map, one using a concept that is not given - when the concepts are given.
 */
export function conventionProblems(map: CodeMap, conventions: Convention[], known: Set<string> | undefined): string[] {
  return conventions.flatMap((convention, at) => {
    const which = `convention ${at + 1}`;
    return [
      ...badBullet(which, convention.text),
      ...(convention.where.length === 0 ? [`${which}: name in where the files whose code decides it - a convention is settled from the code that does it.`] : []),
      ...convention.where.filter((path) => !existsInMap(map, path)).map((path) => `${which}: ${path} is no file or folder in the map.`),
      ...(known !== undefined ? undefinedConcepts(which, convention.text, known) : []),
    ];
  });
}

const INTERFACE_KINDS_TAKEN = new Set(["command", "argument", "option", "route", "env", "other"]);

/**
 * A text as the reference's literals are looked for in code: string literals joined across lines, escapes and
 * whitespace collapsed, case aside - so a help text split over three Python strings is still found.
 */
function lookedFor(text: string): string {
  return text
    .replace(/(["'])\s*\+?\s*\1/g, "")
    .replace(/\\n/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** The literals an entry claims the code has: its names, its choices, its default and the start of its help. */
function literalsOf(entry: InterfaceEntry): string[] {
  const name =
    entry.kind === "route"
      ? [entry.name.replace(/^[A-Z]+\s+/, "")]
      : entry.kind === "command"
        ? entry.name.split(/\s+/)
        : [entry.name];
  const value = entry.default?.trim();
  const help = entry.help !== undefined ? lookedFor(entry.help) : "";
  return [
    ...name,
    ...entry.aliases,
    ...entry.choices,
    ...(value !== undefined && value !== "" && !/^(none|null|undefined|nil)$/i.test(value) ? [value.replace(/^(["'`])(.*)\1$/, "$2")] : []),
    ...(help !== "" ? [help.slice(0, 60)] : []),
  ].filter((literal) => literal.trim() !== "");
}

/**
 * What is wrong with an agent's part of the interface reference - checked against the code, so nothing in it is guessed:
 * an entry with no kind or name, listed twice, whose `where` is no line of a file of the map, or one of whose literals -
 * a name, an alias, a choice, its default, its help - is not in the file it cites nor in those it names in `also`; an
 * exclusion with no why; and, of the interface the map found in the files it was given, any neither listed nor excluded.
 */
export function referenceProblems(map: CodeMap, root: string, given: string[], answer: { entries: InterfaceEntry[]; excluded: InterfaceExclusion[] }): string[] {
  const problems: string[] = [];
  const texts = new Map<string, string | undefined>();
  const read = (path: string): string | undefined => {
    if (!texts.has(path)) {
      try {
        texts.set(path, readFileSync(join(root, ...path.split("/")), "utf8"));
      } catch {
        texts.set(path, undefined);
      }
    }
    return texts.get(path);
  };
  const seen = new Set<string>();
  answer.entries.forEach((entry, at) => {
    const what = `Entry ${at + 1}, \`${entry.name || "(no name)"}\``;
    if (!INTERFACE_KINDS_TAKEN.has(entry.kind)) problems.push(`${what}: its kind is command, argument, option, route, env or other.`);
    if (entry.name.trim() === "") problems.push(`${what}: give its name, exactly as the code has it.`);
    const key = `${entry.kind} ${entry.command ?? ""} ${entry.name}`;
    if (seen.has(key)) problems.push(`${what}: listed twice.`);
    seen.add(key);
    const cited = /^(.+):(\d+)$/.exec(entry.where.trim());
    if (cited === null) {
      problems.push(`${what}: where is path:line - the file it is defined in, relative to the codebase, and the line.`);
      return;
    }
    const [, path, line] = cited as unknown as [string, string, string];
    const text = existsInMap(map, path) ? read(path) : undefined;
    if (text === undefined) {
      problems.push(`${what}: ${path} is no file in the map.`);
      return;
    }
    if (Number(line) < 1 || Number(line) > text.split("\n").length) problems.push(`${what}: ${path} has no line ${line}.`);
    const also = entry.also.filter((other) => {
      if (existsInMap(map, other) && read(other) !== undefined) return true;
      problems.push(`${what}: ${other}, in also, is no file in the map.`);
      return false;
    });
    const code = lookedFor([text, ...also.map((other) => read(other)!)].join("\n"));
    const missing = literalsOf(entry).filter((literal) => !code.includes(lookedFor(literal)));
    if (missing.length > 0) {
      problems.push(
        `${what}: ${missing.map((literal) => `\`${literal}\``).join(", ")} ${missing.length === 1 ? "is" : "are"} not in ${path}${also.length > 0 ? " or the files in also" : ""}. ` +
          "Give each exactly as the code has it - a help text word for word - and name in also the files where one is worked out: never one the code does not have.",
      );
    }
  });
  answer.excluded.forEach((item) => {
    if (item.why.trim() === "") problems.push(`Say why \`${item.name}\` is not the software's interface.`);
  });
  // What the map found in the files given: each listed, or excluded with why - the reference is whole.
  const listed = answer.entries.map((entry) => entrySurface(entry));
  const unlisted = interfaceIn(map, given).filter(
    (surface) => !listed.some((entry) => namedIn(surface, entry.name) || namedIn(surface, `${entry.name} ${entry.path}`)) && !answer.excluded.some((item) => namedExactly(surface, item.name)),
  );
  if (unlisted.length > 0) {
    problems.push(
      `Neither listed nor excluded, of what the map found in your files: ${unlisted.slice(0, 30).map(shownSurface).join(", ")}${unlisted.length > 30 ? `, and ${unlisted.length - 30} more` : ""}. ` +
        "List each - or exclude it, by name, with why, when it is not the software's interface.",
    );
  }
  return problems;
}

/**
 * What is wrong with a feature written for the interface no feature captured: a surface it was given that it neither
 * names in its ***plain nor drops, by name, with why.
 */
export function gapProblems(captured: CapturedFeature, surfaces: InterfaceSurface[]): string[] {
  const text = featureText(captured);
  const missing = surfaces.filter((surface) => !namedIn(surface, text) && !captured.dropped.some((line) => namedExactly(surface, line)));
  return missing.length === 0
    ? []
    : [`Neither captured nor dropped: ${missing.map(shownSurface).join(", ")}. Capture each exactly, by the name the code gives it - or, when it is not the software's interface, name it in dropped with why.`];
}

/**
 * What is wrong with the interface check's corrections: one to a functional spec or a scenario that is not there, a
 * text the parser would read as something else, a link, a concept not defined, a text past twice the most a functional
 * spec may be, a correction with no why.
 */
export function correctionProblems(corrections: Correction[], specs: Map<string, CapturedSpec>, known: Set<string>): string[] {
  return corrections.flatMap((correction) => {
    const spec = specs.get(correction.funcId);
    if (spec === undefined) return [`There is no functional spec ${correction.funcId} among those you were given.`];
    const what = correction.scenarioId !== undefined ? `The correction of ${correction.funcId}'s scenario ${correction.scenarioId}` : `The correction of ${correction.funcId}`;
    const problems: string[] = [];
    if (correction.scenarioId !== undefined && ![...spec.conformance, ...spec.acceptance].some((scenario) => scenario.id === correction.scenarioId)) problems.push(`${correction.funcId} has no scenario ${correction.scenarioId}.`);
    problems.push(...badLines(what, correction.text), ...undefinedConcepts(what, correction.text, known));
    if (correction.scenarioId === undefined && correction.text.length > 2 * MAX_SPEC_CHARS) problems.push(`${what} is ${correction.text.length} characters: correct what is wrong, and leave the rest as it was.`);
    if (correction.why.trim() === "") problems.push(`${what}: say why, from the code.`);
    return problems;
  });
}

/** A module as the checks of its trials see it: its functional specs by func-id, and the concepts it may use. */
export interface CheckedModule {
  specs: Map<string, CapturedSpec>;
  known: Set<string>;
}

/** A part's features as the check of their modules sees them: each one's functional specs, and the concepts the part may use. */
export interface GatheringGiven {
  /** Each feature's functional specs, by its key, in the order of the code. */
  features: Map<string, CapturedSpec[]>;
  known: Set<string>;
  /** Names a module may not take: the import modules'. */
  reserved: Set<string>;
  /** The most functional specs a module gathers from several areas holds - `MODULE_SPECS`; twice it, a module of any. */
  moduleSpecs: number;
}

/**
 * What is wrong with a part's features gathered into modules: a module with no name, a name that is not kebab-case, taken
 * twice or an import module's, no about or no feature; a feature in no module or in two, or not the part's; a module past
 * twice the most functional specs a module holds, or one module holding a part too large for one; one that needs a module
 * that is not the part's, itself, or one after it; a scenario rewritten that is not there, that the parser would read as
 * something else, that uses a concept the part does not have, or that says no why.
 */
export function moduleProblems(answer: { modules: GatheredModule[]; rewrites: ModuleRewrite[] }, given: GatheringGiven): string[] {
  const problems: string[] = [];
  const specsOf = (keys: string[]) => keys.reduce((sum, key) => sum + (given.features.get(key)?.length ?? 0), 0);
  const total = specsOf([...given.features.keys()]);
  if (answer.modules.length === 0) problems.push("Gather the features into at least one module.");
  if (answer.modules.length === 1 && total > given.moduleSpecs) {
    problems.push(`One module holding all ${total} functional specs is the code again, unread and regenerated whole on every change: gather them by concern.`);
  }
  const names = new Map<string, number>();
  const placed = new Set<string>();
  answer.modules.forEach((module, at) => {
    const what = `Module ${module.name || at + 1}`;
    if (!isKebab(module.name)) problems.push(`${what}: its name is not short kebab-case.`);
    else if (given.reserved.has(module.name)) problems.push(`${what}: ${module.name} is the name of an import module - name the concern.`);
    else if (names.has(module.name)) problems.push(`${what}: two modules have that name.`);
    names.set(module.name, at);
    problems.push(...badBullet(`${what}: its about`, module.about));
    if (module.features.length === 0) problems.push(`${what} holds no feature: give it its features, or leave it out.`);
    for (const key of module.features) {
      if (!given.features.has(key)) problems.push(`${what}: ${key} is no feature of the part - name each by its key, as listed.`);
      else if (placed.has(key)) problems.push(`${what}: ${key} is in another module too - a feature is in one module.`);
      placed.add(key);
    }
    const specs = specsOf(module.features);
    if (specs > 2 * given.moduleSpecs) problems.push(`${what} holds ${specs} functional specs, more than a person reads in one file: split it by concern.`);
  });
  const missing = [...given.features.keys()].filter((key) => !placed.has(key));
  if (missing.length > 0) problems.push(`Put every feature in a module: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} in none.`);
  answer.modules.forEach((module, at) => {
    for (const need of module.needs) {
      if (need === module.name) problems.push(`${module.name} needs itself: name only the modules before it.`);
      else if (!names.has(need)) problems.push(`${module.name} needs ${need}, which is none of the modules you gave.`);
      else if (names.get(need)! > at) problems.push(`${module.name} needs ${need}, which comes after it: put ${need} first - or, when ${need} needs ${module.name} too, rewrite the scenarios of one that need the other.`);
    }
  });
  for (const rewrite of answer.rewrites) {
    const specs = given.features.get(rewrite.feature);
    if (specs === undefined) {
      problems.push(`The rewrite of ${rewrite.funcId}'s scenario ${rewrite.scenarioId}: ${rewrite.feature || "(no feature)"} is no feature of the part.`);
      continue;
    }
    if (rewrite.scenarioId === "") {
      problems.push(`The rewrite of ${rewrite.feature}'s ${rewrite.funcId}: name the scenario it rewrites - scenarios are rewritten, never functional specs.`);
      continue;
    }
    const byId = new Map(specs.map((spec) => [spec.funcId, spec]));
    problems.push(...correctionProblems([{ funcId: rewrite.funcId, scenarioId: rewrite.scenarioId, text: rewrite.text, why: rewrite.why }], byId, given.known).map((problem) => `${rewrite.feature}: ${problem}`));
  }
  return problems;
}

const TRIAL_OUTCOMES = new Set(["held", "corrected", "removed", "untried"]);

/**
 * What is wrong with what an agent found trying scenarios on the original: a scenario it was given with no result, or
 * one it was not given; an outcome it may not give; a scenario held or corrected with nothing said of what it ran; a
 * corrected text the parser would read as something else, using a concept the module does not have, or the same as
 * before; a scenario corrected, removed or left untried with no why; a functional spec's correction, as the interface
 * check's are checked; a test req that is not one line.
 */
export function trialProblems(
  answer: { results: TrialResult[]; specs: Correction[]; testReqs: string[] },
  given: Array<{ funcId: string; scenarioId: string; text: string }>,
  module: CheckedModule,
): string[] {
  const problems: string[] = [];
  const byKey = new Map(given.map((scenario) => [`${scenario.funcId}/${scenario.scenarioId}`, scenario]));
  const seen = new Set<string>();
  for (const result of answer.results) {
    const key = `${result.funcId}/${result.scenarioId}`;
    const what = `Scenario ${result.scenarioId || "(no scenario-id)"} of ${result.funcId || "(no func-id)"}`;
    const scenario = byKey.get(key);
    if (scenario === undefined) {
      problems.push(`${what} is not among those you were given: name each by its func-id and scenario-id as listed.`);
      continue;
    }
    if (seen.has(key)) problems.push(`${what} has two results: give it one.`);
    seen.add(key);
    if (!TRIAL_OUTCOMES.has(result.outcome)) {
      problems.push(`${what}: its outcome is held, corrected, removed or untried.`);
      continue;
    }
    if ((result.outcome === "held" || result.outcome === "corrected") && result.ran.trim() === "") {
      problems.push(`${what}: say in ran what you ran against the original and what it answered - a scenario holds, or is corrected, on what the original did, never on reading its code.`);
    }
    if (result.outcome === "corrected") {
      const text = result.text ?? "";
      problems.push(...badLines(`${what}'s new text`, text), ...undefinedConcepts(`${what}'s new text`, text, module.known));
      if (text.trim() === scenario.text.trim()) problems.push(`${what} is corrected to the text it had: it held.`);
    }
    if (result.outcome !== "held" && (result.why ?? "").trim() === "") problems.push(`${what}: say why it was ${result.outcome === "untried" ? "not tried" : result.outcome}.`);
  }
  const missing = given.filter((scenario) => !seen.has(`${scenario.funcId}/${scenario.scenarioId}`));
  if (missing.length > 0) {
    const names = missing.slice(0, 20).map((scenario) => `${scenario.funcId}/${scenario.scenarioId}`);
    problems.push(`Try every scenario you were given - these have no result: ${names.join(", ")}${missing.length > 20 ? `, and ${missing.length - 20} more` : ""}.`);
  }
  problems.push(...correctionProblems(answer.specs, module.specs, module.known));
  // A test req is read for every scenario of every module: one that names a scenario or a functional spec is that
  // scenario's setup, which its own text says. Only ids of more than one word are looked for - one word is prose too -
  // and only kebab-case ones, as every id was checked to be when it was written.
  const ids = [...new Set([...given.flatMap((scenario) => [scenario.funcId, scenario.scenarioId]), ...module.specs.keys()])].filter((id) => id.includes("-") && isKebab(id));
  answer.testReqs.forEach((req, at) => {
    problems.push(...badBullet(`Test req ${at + 1}`, req), ...undefinedConcepts(`Test req ${at + 1}`, req, module.known));
    const named = ids.filter((id) => new RegExp(`(^|[^A-Za-z0-9_-])${id}($|[^A-Za-z0-9_-])`).test(req));
    if (named.length > 0) {
      problems.push(
        `Test req ${at + 1} names ${named.map((id) => `\`${id}\``).join(", ")}: what some scenarios need is set up in their own text - correct each to say it. A test req is what every conformance test of the part sets up.`,
      );
    }
  });
  return problems;
}

/** What is wrong with a captured feature, against the concepts it was given and the scenarios it may have. */
export function featureProblems(captured: CapturedFeature, givenDefinitions: Definition[], scenarioLimit: number = BASE_SCENARIOS, options: { mayBeEmpty?: boolean } = {}): string[] {
  const given = new Set(givenDefinitions.map((definition) => definition.concept));
  const problems: string[] = [];
  if (captured.specs.length === 0 && options.mayBeEmpty !== true) problems.push("Capture the feature in at least one functional spec.");
  if (captured.specs.length > MAX_SPECS_PER_FEATURE) problems.push(`${captured.specs.length} functional specs is more than ${MAX_SPECS_PER_FEATURE}: say less of what is obvious, or merge.`);
  const scenarios = captured.specs.reduce((sum, spec) => sum + spec.conformance.length + spec.acceptance.length, 0);
  if (scenarios > scenarioLimit) problems.push(`${scenarios} scenarios is more than your ${scenarioLimit}: keep those of the functional specs the original tests most, and those that can fail silently, be read two ways, or cost dearly when wrong.`);
  problems.push(...definitionProblems(captured.definitions, given));
  const known = new Set([...given, ...captured.definitions.map((definition) => definition.concept)]);
  for (const definition of captured.definitions) problems.push(...undefinedConcepts(`The definition of ${definition.concept}`, definition.text, known));
  if (captured.definitions.length > 0) problems.push(...definitionCycles([...givenDefinitions, ...captured.definitions]));
  const ids = new Set<string>();
  for (const spec of captured.specs) {
    const what = `Functional spec ${spec.funcId || "(no func-id)"}`;
    if (!isKebab(spec.funcId)) problems.push(`${what}: its func_id is not short kebab-case.`);
    if (ids.has(spec.funcId)) problems.push(`${what}: two functional specs have that func_id.`);
    ids.add(spec.funcId);
    problems.push(...badLines(what, spec.text), ...undefinedConcepts(what, spec.text, known));
    if (spec.text.length > MAX_SPEC_CHARS) problems.push(`${what} is ${spec.text.length} characters, more than ${MAX_SPEC_CHARS}: cut what is obvious, move edge cases to scenarios, or split it.`);
    const scenarioIds = new Set<string>();
    for (const scenario of [...spec.conformance, ...spec.acceptance]) {
      const which = `${what}, scenario ${scenario.id || "(no scenario-id)"}`;
      if (!isKebab(scenario.id)) problems.push(`${which}: its scenario_id is not short kebab-case.`);
      if (scenarioIds.has(scenario.id)) problems.push(`${which}: two of its scenarios have that scenario_id.`);
      scenarioIds.add(scenario.id);
      problems.push(...badLines(which, scenario.text), ...undefinedConcepts(which, scenario.text, known));
    }
  }
  return problems;
}

/**
 * What is wrong with a part's features divided: a feature given no owner line and not merged, or both; a key that is
 * no feature; a feature merged into nothing, into itself or into one that is merged too.
 */
export function divisionProblems(keys: string[], answer: { owns: Array<{ feature: string; owns: string }>; merged: Array<{ feature: string; into: string[]; why: string }> }): string[] {
  const problems: string[] = [];
  const known = new Set(keys);
  const owned = new Set<string>();
  const merged = new Set(answer.merged.map((item) => item.feature));
  for (const item of answer.owns) {
    if (!known.has(item.feature)) problems.push(`${item.feature} is no feature of the part: use the keys as listed.`);
    else if (owned.has(item.feature)) problems.push(`${item.feature} is given what it owns twice.`);
    else if (merged.has(item.feature)) problems.push(`${item.feature} is merged and given what it owns: a feature stays or is merged, not both.`);
    owned.add(item.feature);
    problems.push(...badBullet(`What ${item.feature} owns`, item.owns));
  }
  for (const item of answer.merged) {
    if (!known.has(item.feature)) problems.push(`${item.feature} is no feature of the part: use the keys as listed.`);
    if (item.into.length === 0) problems.push(`${item.feature} is merged into nothing: name the features that take its behaviour.`);
    for (const into of item.into) {
      if (into === item.feature) problems.push(`${item.feature} is merged into itself.`);
      else if (!known.has(into)) problems.push(`${item.feature} is merged into ${into}, which is no feature of the part.`);
      else if (merged.has(into)) problems.push(`${item.feature} is merged into ${into}, which is merged too: name the features its behaviour ends up in.`);
    }
    if (item.why.trim() === "") problems.push(`Say why ${item.feature} is merged.`);
  }
  const missing = keys.filter((key) => !owned.has(key) && !merged.has(key));
  if (missing.length > 0) problems.push(`Say what each feature owns, or merge it: ${missing.join(", ")}.`);
  if (merged.size >= keys.length) problems.push("Keep at least one feature.");
  return problems;
}

/**
 * What is wrong with reconciled concepts: one missing, a text that does not start with its concept or uses one it may
 * not, or definitions that - with the others of the part - use each other in a circle.
 */
export function reconciledProblems(answer: Definition[], asked: string[], known: Set<string>, others: Definition[] = []): string[] {
  const problems: string[] = [...definitionCycles([...others.filter((definition) => !asked.includes(definition.concept)), ...answer.filter((definition) => asked.includes(definition.concept))])];
  for (const concept of asked) {
    const given = answer.find((definition) => definition.concept === concept);
    if (given === undefined) {
      problems.push(`Give ${concept} a definition.`);
      continue;
    }
    if (!given.text.startsWith(concept)) problems.push(`The definition of ${concept} does not start with ${concept}.`);
    problems.push(...badBullet(`The definition of ${concept}`, given.text), ...undefinedConcepts(`The definition of ${concept}`, given.text, known));
  }
  return problems;
}

/** What is wrong with one edit of the readability pass. */
export function editProblems(funcId: string, edited: string, original: string | undefined, known: Set<string>): string[] {
  if (original === undefined) return [`There is no functional spec ${funcId} in the module.`];
  const what = `The new text of ${funcId}`;
  const problems = [...badLines(what, edited), ...undefinedConcepts(what, edited, known)];
  if (edited.length > Math.max(original.length * 1.2, original.length + 80)) problems.push(`${what} is longer than the original: a rewrite for readability says the same in fewer words.`);
  return problems;
}
