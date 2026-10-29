import { DEFINITIONS, FUNCTIONAL_REQUIREMENTS, NON_FUNCTIONAL_REQUIREMENTS, REQUIRED_FUNCTIONAL_SPECS, TEST_REQUIREMENTS } from "../plain/spec.ts";
import type { DiffWhere } from "./diff-view.ts";
import { diffFileTexts, resourceDiff, testPlainFileText, type SpecChange, type TestPlainPath } from "./spec-steps.ts";

/**
 * A job's change as its agent is given it, for the panels: the same items `describeSpecChange` writes into
 * `<spec change>` - what the job's functional specs use, from the module's own file and from the files it
 * imports and requires alike - laid out as a diff the panels already show (`diff-view.ts`). Each section is
 * a block under its header, each item as its file writes it - a functional spec under its `# <func-id>` heading -
 * so placed in the .plain files (`locateDiffLines`) every line is shown in the file it is written
 * in, with its line there: split by file and by block. A text diff of the module's file would show other
 * things - the lines around a change, the items no job takes yet - and leave out what an import adds.
 */

/** The sections in the order the agent is given them, then any other. */
const ORDER = [DEFINITIONS, NON_FUNCTIONAL_REQUIREMENTS, TEST_REQUIREMENTS, REQUIRED_FUNCTIONAL_SPECS, FUNCTIONAL_REQUIREMENTS];

/** A section's header as a .plain file writes it: a required module's functional specs are under its own `***functional specs***`. */
const heading = (section: string) => `***${section === REQUIRED_FUNCTIONAL_SPECS ? FUNCTIONAL_REQUIREMENTS : section}***`;

/** An item's lines as a .plain file writes them: a functional spec's `# <func-id>` heading over its text, anything else its text. */
function itemLines(serialized: string | undefined): string[] {
  if (serialized === undefined) return [];
  let item: unknown;
  try {
    item = JSON.parse(serialized);
  } catch {
    return serialized.split("\n");
  }
  if (typeof item === "string") return item.split("\n");
  const { id, markdown } = (item ?? {}) as { id?: string; markdown?: string };
  const lines = (markdown ?? JSON.stringify(item)).split("\n");
  return id !== undefined ? [`# ${id}`, ...lines] : lines;
}

/**
 * `changes` as a diff of `file` - the module's .plain file, which the diff names - section by section: a removed
 * item's lines taken out, an added one's put in, a changed one's both. A change to what a linked file holds
 * follows, as the step's own diff has it.
 */
export function changeDiff(changes: SpecChange[], file: string, testPlain?: TestPlainView): string {
  return laidOut(changes, file, false, testPlain).diff;
}

/** For a conformance job: the module, and where its functional specs' test plain files are, as the panels name them. */
export interface TestPlainView {
  module: string;
  pathOf: TestPlainPath;
}

/**
 * `changeDiff`, each section's items in the order they are written - by file, then by line - rather than in the
 * order the spec is read in, which puts a concept after those it uses: placed by `locate`, as the panels place it.
 */
export function changeDiffInFiles(changes: SpecChange[], file: string, locate: (diff: string) => DiffWhere, testPlain?: TestPlainView): { diff: string; where: DiffWhere } {
  const first = laidOut(changes, file, false, testPlain);
  const where = locate(first.diff);
  const placeOf = (change: SpecChange) => {
    const at = where[first.starts.get(change) ?? -1];
    return at === undefined ? undefined : { file: at.file, line: at.line };
  };
  const ordered = [...changes].sort((a, b) => {
    // Each section is laid out on its own: between two, any order that holds will do.
    if (a.section !== b.section) return a.section < b.section ? -1 : 1;
    const [x, y] = [placeOf(a), placeOf(b)];
    if (x === undefined || y === undefined) return a.position - b.position;
    return x.file === y.file ? x.line - y.line : (x.file === file ? -1 : y.file === file ? 1 : x.file.localeCompare(y.file));
  });
  const diff = laidOut(ordered, file, true, testPlain).diff;
  return { diff, where: locate(diff) };
}

/**
 * The diff, and the line each change starts on in it. `asGiven`: each section's items in the order given. `testPlain`: a
 * conformance job's - a functional spec whose scenarios changed has its test plain file's diff after the module's.
 */
function laidOut(changes: SpecChange[], file: string, asGiven = false, testPlain?: TestPlainView): { diff: string; starts: Map<SpecChange, number> } {
  const starts = new Map<SpecChange, number>();
  const sections = [...new Set(changes.map((change) => change.section))].sort(
    (a, b) => (ORDER.indexOf(a) === -1 ? ORDER.length : ORDER.indexOf(a)) - (ORDER.indexOf(b) === -1 ? ORDER.length : ORDER.indexOf(b)),
  );
  const lines = [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`];
  for (const section of sections) {
    const own = changes.filter((change) => change.section === section);
    if (!asGiven) own.sort((a, b) => a.position - b.position);
    const body: string[] = [];
    // Where this section's lines start in the diff: after the lines so far, its hunk header and its section header.
    const offset = lines.length + 2;
    for (const change of own) {
      const before = change.kind === "add" ? [] : itemLines(change.before);
      const after = change.kind === "remove" ? [] : itemLines(change.after);
      // Where it is found: its first line now, or - removed - its first line as it was.
      starts.set(change, offset + body.length + (change.kind === "change" && after.length > 0 ? before.length : 0));
      // Only what a file it links holds changed: the item as it is, the file's change after the spec's.
      if (change.kind === "change" && before.join("\n") === after.join("\n")) {
        body.push(...after.map((line) => ` ${line}`));
        continue;
      }
      body.push(...before.map((line) => `-${line}`), ...after.map((line) => `+${line}`));
    }
    if (body.length === 0) continue;
    lines.push("@@ @@", ` ${heading(section)}`, ...body);
  }
  return { diff: `${lines.join("\n")}\n${testPlain !== undefined ? testPlainDiffs(changes, testPlain) : ""}${resourceDiff(changes, file)}`, starts };
}

/**
 * Each test plain file a conformance job's changes touch, as git diffs it: the lines that changed, among the lines around
 * them - a functional spec with no scenarios has no file, so a new one is added whole and one whose scenarios all went is
 * taken out whole.
 */
function testPlainDiffs(changes: SpecChange[], testPlain: TestPlainView): string {
  const scenarioCarrier = (line: string | undefined) => {
    if (line === undefined) return undefined;
    try {
      const item = JSON.parse(line) as { id?: string; module?: string; conformance_tests?: unknown[]; acceptance_tests?: unknown[] };
      return item.id !== undefined && (item.conformance_tests !== undefined || item.acceptance_tests !== undefined) ? item : undefined;
    } catch {
      return undefined;
    }
  };
  return changes
    // A module below's functional specs too: the tip's conformance suite holds the chain's.
    .filter((change) => change.section === FUNCTIONAL_REQUIREMENTS || change.section === REQUIRED_FUNCTIONAL_SPECS)
    .flatMap((change) => {
      const [was, now] = [scenarioCarrier(change.kind === "add" ? undefined : change.before), scenarioCarrier(change.kind === "remove" ? undefined : change.after)];
      const funcId = now?.id ?? was?.id;
      if (funcId === undefined) return [];
      const module = now?.module ?? was?.module ?? testPlain.module;
      const fileOf = (carrier: typeof was) =>
        carrier !== undefined && (carrier.conformance_tests ?? []).length + (carrier.acceptance_tests ?? []).length > 0 ? testPlainFileText(module, carrier as never) : "";
      const diff = diffFileTexts(fileOf(was), fileOf(now), testPlain.pathOf(funcId, module));
      return diff === "" ? [] : [diff];
    })
    .join("");
}

/** The changes a job's agent works from: a code job's leave out the test reqs, which are the conformance job's. */
export function agentChanges(changes: SpecChange[], track: "code" | "conformance"): SpecChange[] {
  return track === "conformance" ? changes : changes.filter((change) => change.section !== TEST_REQUIREMENTS);
}
