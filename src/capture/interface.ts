import { covers, filesOf } from "./area.ts";
import type { Assembly } from "./assemble.ts";
import { INTERFACE_KINDS, type CodeMap } from "./map.ts";
import type { CapturedFeature, CaptureState, InterfaceEntry, InterfaceExclusion, InterfaceSurface } from "./state.ts";

/**
 * The software's interface, as capture holds it: what a user, a client or a script calls by name - its commands,
 * arguments, options, routes, screens and the environment variables it reads - is the contract the regenerated code must
 * keep, call for call, never guessed, never left out as obvious. It is taken from the code as data - each entry's
 * literals checked against the code it cites (checks.ts) - and written as each part's interface reference, a linked
 * resource that every functional spec about it carries through the part's interface concept: exact where prose would
 * paraphrase. The ***plain is then matched against it: what no functional spec names goes to a writer of its own, and
 * what still is not named is reported.
 */

/** A piece of the interface by its kind and name: a map's surface, or an entry of the reference. */
interface Named {
  kind: string;
  name: string;
}

/** A segment of a route's path that is a parameter, however its framework writes one: `<int:id>`, `{id}`, `:id`, `[id]`, `*`, a regex group. */
const PARAMETER = /[<{([:*]/;

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A route's or a screen's path, its method or Rails' `resources` taken off. */
function pathOf(name: string): string {
  return name.startsWith("resources ") ? `/${name.slice("resources ".length)}` : name.replace(/^[A-Z]+\s+/, "");
}

/**
 * How ***plain names a piece of the interface: an option, a command, an argument or an environment variable as a token of
 * its own (`--proxy`, not `--proxy-all`; an option with a long form by it); a route or a screen by its path, whatever its
 * method, under any prefix (a blueprint's `/api`), its parameters written any way (`/notes/<int:id>` is named by
 * `/notes/{id}` and by `/notes/42`), and not by a longer path alone.
 */
function namePattern(named: Named): RegExp {
  if (named.kind === "option") {
    const forms = named.name.split(/[\s,]+/).filter((form) => form.startsWith("-"));
    const long = forms.find((form) => form.startsWith("--")) ?? forms[0] ?? named.name;
    return new RegExp(`(?<![\\w-])${escaped(long)}(?![\\w-])`);
  }
  if (named.kind !== "route" && named.kind !== "screen") return new RegExp(`(?<![\\w-])${escaped(named.name)}(?![\\w-])`);
  const segments = pathOf(named.name).split("/").filter((segment) => segment !== "");
  if (segments.length === 0) return /(?<![\w.-])\/(?![\w/{<:*[-])/;
  const pattern = segments.map((segment) => (PARAMETER.test(segment) ? "[^/\\s`'\")]+" : escaped(segment))).join("/");
  // Anything may come before it - a prefix's segment, a host - but nothing that makes the path longer after it.
  return new RegExp(`/${pattern}/?(?![\\w/{<:*[-])`);
}

/** Whether ***plain text names a piece of the interface. */
export function namedIn(named: Named, text: string): boolean {
  return namePattern(named).test(text);
}

/**
 * Whether a line names a piece of the interface by the very name the code gives it - an option by one of its names, a
 * route or a screen by its path as written, parameters and all: how a writer says which it dropped. Looser, a parameter
 * would match any value, and a dropped `/notes/raw` would answer for `/notes/<int:id>`.
 */
export function namedExactly(named: Named, line: string): boolean {
  if (named.kind === "option") return named.name.split(/[\s,]+/).some((form) => form.startsWith("-") && new RegExp(`(?<![\\w-])${escaped(form)}(?![\\w-])`).test(line));
  if (named.kind === "route" || named.kind === "screen") return line.includes(pathOf(named.name));
  return namedIn(named, line);
}

const KIND_WORDS: Record<string, string> = { env: "environment variable" };

/** A piece of the interface as a person and an agent read it: `--proxy` (option, httpie/cli/definition.py). */
export function shownSurface(surface: InterfaceSurface): string {
  return `\`${surface.name}\` (${KIND_WORDS[surface.kind] ?? surface.kind}, ${surface.path})`;
}

/** The interface the map found among some paths - neither tests nor what is left out - surface by surface. */
export function interfaceIn(map: CodeMap, paths: string[], leftOut: string[] = []): InterfaceSurface[] {
  return filesOf(map, paths)
    .filter((file) => file.kind !== "test" && !leftOut.some((path) => covers(path, file.path)))
    .flatMap((file) => {
      const seen = new Set<string>();
      return file.surfaces
        .filter((surface) => INTERFACE_KINDS.has(surface.kind) && !seen.has(`${surface.kind} ${surface.name}`) && seen.add(`${surface.kind} ${surface.name}`))
        .map((surface) => ({ path: file.path, kind: surface.kind, name: surface.name }));
    });
}

/** Everything the survey and the splits and outlines left out, by path. */
export function leftOutPaths(state: CaptureState): string[] {
  return [...(state.survey?.leftOut ?? []), ...Object.values(state.areas).flatMap((area) => area.leftOut ?? [])].map((item) => item.path);
}

/** The file an entry is defined in: its `where`, the line taken off. */
export function entryFile(entry: Pick<InterfaceEntry, "where">): string {
  return entry.where.replace(/:\d+$/, "");
}

/** An entry as a piece of the interface to name: an option by all its names, so the long one is looked for. */
export function entrySurface(entry: InterfaceEntry): InterfaceSurface {
  return { path: entryFile(entry), kind: entry.kind, name: entry.kind === "option" ? [entry.name, ...entry.aliases].join(", ") : entry.name };
}

/** A part's interface reference as its agents took it: every entry, every exclusion, and the batches that failed. */
export function referenceOf(state: CaptureState, part: string): { entries: InterfaceEntry[]; excluded: InterfaceExclusion[]; failed: string[] } {
  const batches = Object.entries(state.interfaces?.[part] ?? {});
  return {
    entries: batches.flatMap(([, batch]) => ("entries" in batch ? batch.entries : [])),
    excluded: batches.flatMap(([, batch]) => ("excluded" in batch ? batch.excluded : [])),
    failed: batches.flatMap(([files, batch]) => ("failed" in batch ? [`${files}: ${batch.failed}`] : [])),
  };
}

/** The entries defined in some paths - where they are, or where their literals come from. */
export function entriesIn(entries: InterfaceEntry[], paths: string[]): InterfaceEntry[] {
  return entries.filter((entry) => [entryFile(entry), ...entry.also].some((file) => paths.some((path) => covers(path, file))));
}

/** Where a part's interface reference is, in the captured project - as the ***plain links it. */
export function referencePath(part: string): string {
  return `resources/interface/${part}.md`;
}

/** The concept a part's interface goes by - `:HttpieInterface:` - its definition linking the reference. */
export function interfaceConcept(part: string): string {
  const words = part.split(/[^A-Za-z0-9]+/).filter((word) => word !== "");
  return `:${words.map((word) => word[0]!.toUpperCase() + word.slice(1)).join("")}Interface:`;
}

/** The definition of a part's interface concept: what it is, and the reference that holds it exactly. */
export function interfaceDefinition(part: string): string {
  return (
    `${interfaceConcept(part)} is every command, argument, option, route and environment variable of ${part} a user, a client or a script calls, ` +
    `each exactly as [its interface reference](${referencePath(part)}) lists it: every name it has, what it takes, its choices, its default and its help.`
  );
}

const quoted = (value: string) => `\`${value}\``;

/** One entry of the reference, as a line and the lines under it. */
function entryLines(entry: InterfaceEntry): string[] {
  const facts = [
    ...(entry.aliases.length > 0 ? [`also ${entry.aliases.map(quoted).join(", ")}`] : []),
    ...(entry.takes !== undefined ? [`takes ${quoted(entry.takes)}`] : []),
    ...(entry.choices.length > 0 ? [`one of ${entry.choices.map(quoted).join(", ")}`] : []),
    ...(entry.default !== undefined ? [`default ${quoted(entry.default)}`] : []),
    ...(entry.repeatable === true ? ["repeatable"] : []),
    ...(entry.required === true ? ["required"] : []),
    ...(entry.hidden === true ? ["hidden from its help"] : []),
  ];
  return [
    `- ${quoted(entry.name)}${facts.length > 0 ? ` - ${facts.join("; ")}` : ""}`,
    ...(entry.help !== undefined && entry.help.trim() !== "" ? [`  - help: ${entry.help.replace(/\s+/g, " ").trim()}`] : []),
    ...entry.details.map((detail) => `  - ${detail}`),
  ];
}

/**
 * A part's interface reference, as the captured project keeps it: every command with its arguments and options, every
 * route, every environment variable - exhaustive, since nobody reads it as prose, and exact, each literal as the code has it.
 */
export function renderReference(part: string, entries: InterfaceEntry[]): string {
  const of = (kind: string) => entries.filter((entry) => entry.kind === kind);
  const commands = [...new Set([...of("command").map((entry) => entry.name), ...entries.filter((entry) => entry.command !== undefined).map((entry) => entry.command!)])];
  const lines: string[] = [
    `# The interface of ${part}`,
    "",
    "Every command, argument, option, route and environment variable a user, a client or a script calls - exactly as the original defines them, taken from its code: every name, what each takes, its choices, its default and its help, word for word. What each does is in the ***plain's functional specs.",
    "",
  ];
  for (const command of commands) {
    const own = of("command").find((entry) => entry.name === command);
    const args = of("argument").filter((entry) => entry.command === command);
    const options = of("option").filter((entry) => entry.command === command);
    lines.push(`## ${quoted(command)}`, "", ...(own !== undefined ? [...entryLines(own).slice(1).map((line) => line.replace(/^ {2}- /, "")), ""] : []));
    if (args.length > 0) lines.push("### Arguments", "", ...args.flatMap(entryLines), "");
    if (options.length > 0) lines.push("### Options", "", ...options.flatMap(entryLines), "");
  }
  const loose = entries.filter((entry) => (entry.kind === "argument" || entry.kind === "option") && entry.command === undefined);
  if (loose.length > 0) lines.push("## Arguments and options", "", ...loose.flatMap(entryLines), "");
  if (of("route").length > 0) lines.push("## Routes", "", ...of("route").flatMap(entryLines), "");
  if (of("env").length > 0) lines.push("## Environment variables", "", ...of("env").flatMap(entryLines), "");
  if (of("other").length > 0) lines.push("## Other", "", ...of("other").flatMap(entryLines), "");
  return `${lines.join("\n").trimEnd()}\n`;
}

/** Every text of a part's ***plain: its import module's, and each module's definitions, functional specs and scenarios. */
export function plainTextOf(assembly: Assembly, part: string): string {
  const shared = assembly.shared.filter((module) => module.part === part).flatMap((module) => [...module.definitions.map((definition) => definition.text), ...module.implementationReqs, ...module.testReqs]);
  const modules = assembly.modules
    .filter((module) => module.part === part)
    .flatMap((module) => [
      ...module.definitions.map((definition) => definition.text),
      ...module.features.flatMap((feature) => feature.specs.flatMap((spec) => [spec.text, ...spec.conformance.map((scenario) => scenario.text), ...spec.acceptance.map((scenario) => scenario.text)])),
    ]);
  return [...shared, ...modules].join("\n");
}

/**
 * The interface the part's ***plain names nowhere: of its reference, when its agents took one - its entries - else of
 * what the map found in its files, neither tests nor left out. What a user or a client could call in the original and
 * would not find in what is regenerated, unless the ***plain says it in other words.
 */
export function interfaceGaps(map: CodeMap, state: CaptureState, assembly: Assembly): Array<InterfaceSurface & { part: string }> {
  const leftOut = leftOutPaths(state);
  return (state.survey?.parts ?? []).flatMap((part) => {
    const text = plainTextOf(assembly, part.name);
    const { entries } = referenceOf(state, part.name);
    const surfaces = entries.length > 0 ? entries.map(entrySurface) : interfaceIn(map, part.paths, leftOut);
    return surfaces.filter((surface) => !namedIn(surface, text)).map((surface) => ({ ...surface, part: part.name }));
  });
}

/** The options a text names that the reference does not have: an interface written that the code does not define. */
export function optionsNotInReference(text: string, entries: InterfaceEntry[]): string[] {
  const known = new Set(entries.flatMap((entry) => [entry.name, ...entry.aliases]));
  const named = [...text.matchAll(/(?<![\w-])(--[a-z][\w-]*)/g)].map((match) => match[1]!);
  return [...new Set(named.filter((option) => !known.has(option)))];
}

/** Every text a captured feature gives the ***plain: its functional specs, their scenarios and its definitions. */
export function featureText(captured: CapturedFeature): string {
  return [...captured.definitions.map((definition) => definition.text), ...captured.specs.flatMap((spec) => [spec.text, ...spec.conformance.map((scenario) => scenario.text), ...spec.acceptance.map((scenario) => scenario.text)])].join("\n");
}

/** Why a piece of the interface was dropped, as a writer said it - a line of its `dropped` that names it - if one did. */
export function droppedBecause(state: CaptureState, named: Named): string | undefined {
  for (const feature of Object.values(state.features)) {
    const line = feature.captured?.dropped.find((dropped) => namedExactly(named, dropped));
    if (line !== undefined) return line;
  }
  return undefined;
}

