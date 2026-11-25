import { posix } from "node:path";
import type { CodeMap, FileKind, MapFile, Surface, SurfaceKind } from "./map.ts";

/**
 * An area of the codebase: some of its folders and files, named. Capture splits the codebase into areas until each fits
 * one agent's budget (capture.ts); an area that fits is outlined into features. What an agent is shown of an area is
 * its part of the map, folded to fit a budget of characters - never the code.
 */
export interface Area {
  /** Unique in the run: the names from the part down, joined by `/`. */
  id: string;
  /** Short kebab-case, from what the area does. */
  name: string;
  /** What it does, in a line. */
  about: string;
  /** Its folders and files, relative to the codebase with `/` - `.` for the whole of it. */
  paths: string[];
}

/** Whether a file is in a folder or is the file a path names. */
export function covers(path: string, file: string): boolean {
  return path === "." || path === "" || file === path || file.startsWith(`${path}/`);
}

/** The files of an area. */
export function filesOf(map: CodeMap, paths: string[]): MapFile[] {
  return map.files.filter((file) => paths.some((path) => covers(path, file.path)));
}

/** How many lines an area's files hold - its size, as far as capture is concerned. Assets count for nothing. */
export function linesOf(files: MapFile[]): number {
  return files.reduce((sum, file) => sum + file.lines, 0);
}

/** A test file of the original, as evidence of what it does: its lines and the tests the map named in it. */
export interface TestEvidence {
  path: string;
  lines: number;
  tests: string[];
}

/** The original's tests among some paths: the test files holding at least one test the map found, largest first. */
export function testEvidence(map: CodeMap, paths: string[]): TestEvidence[] {
  return filesOf(map, paths)
    .filter((file) => file.kind === "test")
    .map((file) => ({ path: file.path, lines: file.lines, tests: file.surfaces.filter((surface) => surface.kind === "test").map((surface) => surface.name) }))
    .filter((file) => file.tests.length > 0)
    .sort((a, b) => b.lines - a.lines);
}

/** One of the folders and files an area divides into. */
export interface Entry {
  path: string;
  dir: boolean;
  files: MapFile[];
}

/**
 * What an area divides into, for an agent to split it: a single folder's folders and files - going down through a
 * folder that holds a single folder and nothing else - or the area's own paths, when it has several.
 */
export function entriesOf(map: CodeMap, paths: string[]): Entry[] {
  const files = filesOf(map, paths);
  const isDir = (path: string) => path === "." || files.some((file) => file.path.startsWith(`${path === "." ? "" : `${path}/`}`) && file.path !== path);
  if (paths.length === 1 && isDir(paths[0]!)) {
    let dir = paths[0]!;
    for (;;) {
      const children = childrenOf(files, dir);
      if (children.length === 1 && children[0]!.dir) {
        dir = children[0]!.path;
        continue;
      }
      return children;
    }
  }
  return paths.map((path) => ({ path, dir: isDir(path), files: filesOf(map, [path]) }));
}

function childrenOf(files: MapFile[], dir: string): Entry[] {
  const prefix = dir === "." || dir === "" ? "" : `${dir}/`;
  const byChild = new Map<string, Entry>();
  for (const file of files) {
    if (!file.path.startsWith(prefix)) continue;
    const rest = file.path.slice(prefix.length);
    const slash = rest.indexOf("/");
    const path = slash === -1 ? file.path : `${prefix}${rest.slice(0, slash)}`;
    const entry = byChild.get(path) ?? { path, dir: slash !== -1, files: [] };
    entry.files.push(file);
    byChild.set(path, entry);
  }
  return [...byChild.values()].sort((a, b) => (a.dir === b.dir ? a.path.localeCompare(b.path) : a.dir ? -1 : 1));
}

const SURFACE_LABELS: Array<[SurfaceKind, string]> = [
  ["route", "routes"],
  ["command", "commands"],
  ["option", "options"],
  ["screen", "screens"],
  ["env", "environment variables"],
  ["table", "tables"],
  ["test", "tests"],
  ["export", "exports"],
];

const KIND_LABELS: Array<[FileKind, string]> = [
  ["source", "source"],
  ["test", "test"],
  ["contract", "contract"],
  ["doc", "doc"],
  ["manifest", "manifest"],
  ["asset", "asset"],
  ["other", "other"],
];

/** A line of surfaces: each kind with as many names as `sample` allows and how many more there are. */
function surfaceLine(surfaces: Surface[], sample: number): string {
  const parts: string[] = [];
  for (const [kind, label] of SURFACE_LABELS) {
    const names = [...new Set(surfaces.filter((surface) => surface.kind === kind).map((surface) => surface.name))];
    if (names.length === 0) continue;
    if (sample === 0) {
      parts.push(`${names.length} ${label}`);
      continue;
    }
    const shown = names.slice(0, sample).join(", ");
    parts.push(`${label}: ${shown}${names.length > sample ? ` (+${names.length - sample})` : ""}`);
  }
  return parts.join("; ");
}

function kindCounts(files: MapFile[]): string {
  return KIND_LABELS.map(([kind, label]) => [files.filter((file) => file.kind === kind).length, label] as const)
    .filter(([count]) => count > 0)
    .map(([count, label]) => `${count} ${label}`)
    .join(", ");
}

function entryLine(entry: Entry, sample: number, indent: string): string {
  const surfaces = surfaceLine(entry.files.flatMap((file) => file.surfaces), sample);
  if (entry.dir) {
    return `${indent}${entry.path}/ - ${entry.files.length} files (${kindCounts(entry.files)}), ${linesOf(entry.files)} lines${surfaces !== "" ? ` - ${surfaces}` : ""}`;
  }
  const file = entry.files[0];
  return `${indent}${entry.path} - ${file?.kind ?? "file"}, ${file?.lines ?? 0} lines${surfaces !== "" ? ` - ${surfaces}` : ""}`;
}

/**
 * An area's part of the map as text, folded to fit `budget` characters: as deep and with as many surface names as fit -
 * down to its entries with counts alone, and past that only the first entries, the rest counted.
 */
export function renderArea(map: CodeMap, paths: string[], budget: number): string {
  const files = filesOf(map, paths);
  const header = `${paths.map((path) => (path === "." ? "the whole codebase" : path)).join(", ")} - ${files.length} files (${kindCounts(files)}), ${linesOf(files)} lines`;
  const entries = entriesOf(map, paths);
  const attempts: Array<{ depth: number; sample: number }> = [
    { depth: 3, sample: 12 },
    { depth: 2, sample: 12 },
    { depth: 2, sample: 6 },
    { depth: 1, sample: 8 },
    { depth: 1, sample: 3 },
    { depth: 1, sample: 0 },
  ];
  for (const { depth, sample } of attempts) {
    const text = [header, "", ...renderEntries(map, entries, depth, sample, "")].join("\n");
    if (text.length <= budget) return text;
  }
  // Too many entries even counted: the first that fit, and the rest summed up.
  const lines = [header, ""];
  let used = lines.join("\n").length;
  let shown = 0;
  for (const entry of entries) {
    const line = entryLine(entry, 0, "");
    if (used + line.length + 1 > budget - 120) break;
    lines.push(line);
    used += line.length + 1;
    shown += 1;
  }
  const rest = entries.slice(shown);
  if (rest.length > 0) lines.push(`... and ${rest.length} more entries - ${rest.reduce((sum, entry) => sum + entry.files.length, 0)} files, ${linesOf(rest.flatMap((entry) => entry.files))} lines`);
  return lines.join("\n");
}

function renderEntries(map: CodeMap, entries: Entry[], depth: number, sample: number, indent: string): string[] {
  return entries.flatMap((entry) => {
    const line = entryLine(entry, sample, indent);
    if (!entry.dir || depth <= 1) return [line];
    return [line, ...renderEntries(map, childrenOf(entry.files, entry.path), depth - 1, sample, `${indent}  `)];
  });
}

/**
 * Areas in build order: an area whose files import another's comes after it - a topological order of the folders'
 * import graph - with the order they were given kept where nothing says otherwise. A cycle is broken where the given
 * order puts its first area.
 */
export function buildOrder<T extends { paths: string[] }>(map: CodeMap, areas: T[]): T[] {
  const owner = new Map<string, number>();
  areas.forEach((area, index) => {
    for (const file of filesOf(map, area.paths)) if (!owner.has(file.path)) owner.set(file.path, index);
  });
  const dependsOn = areas.map(() => new Set<number>());
  for (const file of map.files) {
    const from = owner.get(file.path);
    if (from === undefined) continue;
    for (const target of file.imports) {
      const to = owner.get(target);
      if (to !== undefined && to !== from) dependsOn[from]!.add(to);
    }
  }
  const placed: number[] = [];
  const done = new Set<number>();
  while (placed.length < areas.length) {
    const ready = areas.findIndex((_, index) => !done.has(index) && [...dependsOn[index]!].every((dep) => done.has(dep)));
    const next = ready !== -1 ? ready : areas.findIndex((_, index) => !done.has(index));
    placed.push(next);
    done.add(next);
  }
  return placed.map((index) => areas[index]!);
}

/** A name for a path, as an area would be named: its last part, kebab-case. */
export function nameOfPath(path: string): string {
  const base = path === "." || path === "" ? "app" : posix.basename(path).replace(/\.[^.]+$/, "");
  return kebab(base) || "app";
}

/** Text as kebab-case: lowercase letters, digits and single hyphens. */
export function kebab(text: string): string {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
