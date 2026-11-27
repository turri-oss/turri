import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFINITIONS, FUNCTIONAL_REQUIREMENTS, NON_FUNCTIONAL_REQUIREMENTS, TEST_REQUIREMENTS } from "@turri-dev/core/plain";
import { createSpecMapSource, focusOf, lineDiff, markSpecMap, pageItems, rungOf, type MapPage, type MapItem, type MarkedPage } from "@turri-dev/core/terminal";
type MarshalledPlainSource = Parameters<typeof pageItems>[0]["spec"];
type MapPlan = Parameters<typeof markSpecMap>[1];
type MapCodebase = MapPlan["codebases"][number];
type MapPulse = MapCodebase["pulses"][number];
import { createSidePanel } from "../../src/regenerate/side-panel.ts";
import { createSpecMapState, columnHeadings, legendLines, specMapHeader, specMapLines, switchTab, tabBar, wordDiff } from "../../src/regenerate/spec-map-view.ts";
import type { TranscriptStyle } from "../../src/regenerate/transcript-view.ts";
import { PLAIN_PAINT } from "../../src/regenerate/diff-view.ts";

let dir: string;
let cwd: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "turri-spec-map-"));
  cwd = process.cwd();
  process.chdir(dir);
  writeFileSync(join(dir, "config.yaml"), "conformance-tests: true\n");
});
afterEach(() => {
  process.chdir(cwd);
  rmSync(dir, { recursive: true, force: true });
});

const item = (markdown: string) => ({ markdown });
/** A functional spec's func-id from its text: its first words but the filler - "A user can log in." is `log-in`. */
const funcIdOf = (text: string) =>
  text.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((word) => word !== "" && !["a", "an", "the", "user", "can"].includes(word)).slice(0, 2).join("-");
/** A tree of the sections given; a functional spec is its text - its func-id taken from it - or [func-id, text]. */
const tree = (sections: Record<string, Array<string | [string, string]>>): MarshalledPlainSource =>
  Object.fromEntries(
    Object.entries(sections).map(([key, items]) => [
      key,
      items.map((entry) => (key === FUNCTIONAL_REQUIREMENTS ? (typeof entry === "string" ? { id: funcIdOf(entry), markdown: entry } : { id: entry[0], markdown: entry[1] }) : item(entry as string))),
    ]),
  );
const id = (text: string) => text;
/** A style that shows what is struck, added and removed as text. */
const style: TranscriptStyle = {
  heading: id,
  muted: id,
  accent: id,
  error: id,
  success: id,
  warning: id,
  added: (text) => `{+${text}+}`,
  removed: (text) => `[-${text.replace(/\x1b\[\d+m/g, "")}-]`,
};
const noPlan: MapPlan = { files: [], codebases: [] };

/** The page of one module built from `record`, its spec now `spec`. */
function page(spec: MarshalledPlainSource, record: MarshalledPlainSource | null, tested?: MarshalledPlainSource): MapPage {
  return { module: "app", plainFile: join(dir, "app.plain"), buildDir: join(dir, "code"), imports: [], items: pageItems({ module: "app", own: true, spec, record, tested: tested ?? null }) };
}

/** A pulse that regenerates the items given: from their record lines to their lines now. */
function pulseOf(items: MapItem[], number: number, running: boolean, title = `pulse ${number}`): MapPulse {
  const lines = (pick: (entry: MapItem) => string | undefined) => `["${FUNCTIONAL_REQUIREMENTS}"]\n${items.map(pick).filter((line) => line !== undefined).join("\n")}\n`;
  return { number, title, track: "code", running, rowId: running ? `job${number}` : `planned-app-${number}`, before: lines((entry) => entry.wasLine), after: lines((entry) => entry.line) };
}

const codebase = (first: MapPage, rest: Partial<MapCodebase> = {}): MapCodebase => ({ module: "app", plainFile: first.plainFile, buildDir: first.buildDir, pulses: [], conformance: true, ...rest });

describe("the regeneration drawn", () => {
  it("strikes a ghost through, word-diffs a changed first line, and shows only the sub-bullet that changed under a changed item", () => {
    const first = page(
      tree({ [FUNCTIONAL_REQUIREMENTS]: ["- Register a user.\n  - The response is 201.\n  - Emails are lowercased.", "- Log in."] }),
      tree({ [FUNCTIONAL_REQUIREMENTS]: ["- Register a user.\n  - The response is 200.\n  - Emails are lowercased.", "- Search for users by name."] }),
    );
    const [marked] = markSpecMap([first], noPlan);
    const { lines } = specMapLines([marked!], createSpecMapState(), 100, style);
    const text = lines.join("\n");
    expect(text).toContain("- Register a user.");
    expect(text).toContain("  - The response is [-200.-]{+201.+}");
    expect(text).not.toContain("Emails are lowercased");
    expect(text).toContain("[-- Search for users by name.-]");
    expect(lines.find((line) => line.includes("# search-for"))).toMatch(/^ +− /);
  });

  it("wraps an item too long for the width, its lines after the first hanging past the bullet, never cutting it short", () => {
    const long = "- :UserAdmin: is the local administration entry point whose successful provisioning output follows `[resource]user-created.schema.json` exactly.";
    const first = page(tree({ [DEFINITIONS]: [long] }), tree({ [DEFINITIONS]: [long] }));
    const [marked] = markSpecMap([first], noPlan);
    const lines = specMapLines([marked!], createSpecMapState(), 60, style).lines;
    const at = lines.findIndex((line) => line.includes(":UserAdmin:"));
    const rows = lines.slice(at).filter((line) => line.includes("│"));
    expect(lines.join("\n")).not.toContain("…");
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) expect(row.length).toBeLessThanOrEqual(60);
    // Each line after the first starts under the text, past "- ".
    expect(rows[1]).toMatch(/^ {8}│ {3}\S/);
    expect(rows.map((row) => row.slice(row.indexOf("│") + 2).trim()).join(" ")).toBe(long);
  });

  it("opens an item to the rest of its text and its acceptance tests - where it stands is beside its mark, not repeated under it", () => {
    const first = page(
      tree({ [DEFINITIONS]: ["- :User: is a person."], [FUNCTIONAL_REQUIREMENTS]: ["- A :User: can register.\n  - The response is 201.", "- A :User: can log in."] }),
      tree({ [DEFINITIONS]: ["- :User: is a person."], [FUNCTIONAL_REQUIREMENTS]: ["- A :User: can log in."] }),
      tree({ [FUNCTIONAL_REQUIREMENTS]: ["- A :User: can log in."] }),
    );
    const register = first.items.find((entry) => entry.text.startsWith("- A :User: can register"))!;
    const [marked] = markSpecMap([first], { files: [], codebases: [codebase(first, { pulses: [pulseOf([register], 2, false, "registration")] })] });
    const state = createSpecMapState();
    for (const entry of marked!.items) state.open.add(`${marked!.plainFile}\n${entry.key}`);
    const lines = specMapLines([marked!], state, 120, style).lines;
    const text = lines.join("\n");
    expect(text).not.toMatch(/│ [◇○◆] /);
    // Nor what its first line was: the word diff on the row says it.
    expect(text).not.toContain("was:");
    expect(text).not.toContain("not regenerated yet");
    // A changed item's lines that did not change are the spec's, as any: not dimmed.
    const changed = page(
      tree({ [FUNCTIONAL_REQUIREMENTS]: ["- Read the contacts.\n  - Active contacts first.\n  - In the order received."] }),
      tree({ [FUNCTIONAL_REQUIREMENTS]: ["- Read the contacts.\n  - Archived contacts are not read.\n  - In the order received."] }),
    );
    const [markedChange] = markSpecMap([changed], noPlan);
    const openChange = createSpecMapState();
    for (const entry of markedChange!.items) openChange.open.add(`${markedChange!.plainFile}\n${entry.key}`);
    const shownChange = specMapLines([markedChange!], openChange, 120, { ...style, muted: (t: string) => `<dim>${t}</dim>` }).lines.join("\n");
    expect(shownChange).toContain("│   - In the order received.");
    expect(shownChange).not.toContain("<dim>  - In the order received.</dim>");
    expect(text).toContain("  - The response is 201.");
    expect(text).not.toContain("used by");
  });

  it("opens a functional spec's scenarios as its test plain file has them - each kind under a heading drawn as a section's, each scenario under its id - and says nothing of tests where it has none", () => {
    const spec: MarshalledPlainSource = {
      [FUNCTIONAL_REQUIREMENTS]: [{ id: "patch", markdown: "Patch the records.\n- Lookups first.", conformance_tests: [{ id: "patches", text: "A record is patched." }], acceptance_tests: [{ id: "lookup", text: "A lookup becomes an `@odata.bind` entry." }, { id: "empty-record", text: "An empty record patches nothing." }] }],
    } as MarshalledPlainSource;
    const [marked] = markSpecMap([page(spec, spec)], noPlan);
    const state = createSpecMapState();
    for (const entry of marked!.items) state.open.add(`${marked!.plainFile}\n${entry.key}`);
    const painted: TranscriptStyle = { ...style, diff: { ...PLAIN_PAINT, syntax: (role, text) => (role === "section" ? `<section>${text}</section>` : text) } };
    const lines = specMapLines([marked!], state, 120, painted).lines;
    const row = lines.findIndex((line) => line.includes("# patch"));
    expect(lines[row]).toMatch(/│ # patch$/);
    expect(lines[row + 1]).toBe("        │ Patch the records.");
    expect(lines.join("\n")).not.toContain("not conform");
    const conformance = lines.findIndex((line) => line.includes("conformance tests"));
    expect(lines[conformance - 1]!.trimEnd()).toMatch(/│$/);
    // Each kind's heading and its scenarios indented under the functional spec, a blank line after each scenario.
    expect(lines.slice(conformance, conformance + 4)).toEqual(["        │   <section>***conformance tests***</section>", "        │   # patches", "        │   A record is patched.", "        │"]);
    const heading = lines.findIndex((line) => line.includes("acceptance tests"));
    expect(lines[heading]).toBe("        │   <section>***acceptance tests***</section>");
    expect(lines[heading - 1]).toBe("        │");
    expect(lines[heading - 2]).not.toBe("        │");
    expect(lines.slice(heading + 1, heading + 7)).toEqual(["        │   # lookup", "        │   A lookup becomes an `@odata.bind` entry.", "        │", "        │   # empty-record", "        │   An empty record patches nothing.", "        │"]);
  });

  it("shows the files a module imports under its own text, each closed until opened - the module it requires is a tab of its own", () => {
    const items: MapItem[] = [
      { key: "a", section: FUNCTIONAL_REQUIREMENTS, state: "built", text: "- Say hello.", scenarios: { conformance: [], acceptance: [] } },
      { key: "b", section: NON_FUNCTIONAL_REQUIREMENTS, state: "built", text: "- Use Python 3.12.", scenarios: { conformance: [], acceptance: [] }, file: "stdlib/lang/python" },
      { key: "c", section: NON_FUNCTIONAL_REQUIREMENTS, state: "changed", text: "- Use FastAPI.", was: "- Use Flask.", scenarios: { conformance: [], acceptance: [] }, file: "stdlib/backend/python-fastapi" },
    ];
    const top: MapPage = { module: "top", plainFile: join(dir, "top.plain"), buildDir: "", imports: ["stdlib/lang/python", "stdlib/backend/python-fastapi"], items, requires: "base" };
    const base: MapPage = { module: "base", plainFile: join(dir, "base.plain"), buildDir: "", imports: [], items: [{ key: "d", section: FUNCTIONAL_REQUIREMENTS, state: "built", text: "- Store a value.", scenarios: { conformance: [], acceptance: [] } }] };
    const marked = markSpecMap([base, top], { files: [], codebases: [codebase(base)] });
    const state = createSpecMapState();
    const text = specMapLines(marked, state, 100, style).lines.join("\n");
    // The module asked for is shown; the one it requires is not drawn under it.
    expect(text).toContain("- Say hello.");
    expect(text).toContain("imported (2)");
    expect(text).toContain("▸ from stdlib/lang/python · 1 req · all built");
    expect(text).toContain("▸ from stdlib/backend/python-fastapi · 1 req · 1 changing");
    expect(text).not.toContain("Use FastAPI");
    expect(text).not.toContain("required (");
    expect(text).not.toContain("- Store a value.");
    // Opened, an import block shows its items, word by word where they changed.
    state.imports.set(`${top.plainFile}\nstdlib/backend/python-fastapi`, true);
    expect(specMapLines(marked, state, 100, style).lines.join("\n")).toContain("- Use [-Flask.-]{+FastAPI.+}");
    // ← goes to the module it requires.
    switchTab(marked, state, -1);
    expect(specMapLines(marked, state, 100, style).lines.join("\n")).toContain("- Store a value.");
  });

  it("has a tab a module of the chain, in its order, the one shown marked - fitted to the width around it, the rest counted", () => {
    const module = (name: string, requires?: string): MapPage => ({
      module: name,
      plainFile: join(dir, `${name}.plain`),
      buildDir: join(dir, name),
      imports: [],
      items: [{ key: name, section: FUNCTIONAL_REQUIREMENTS, state: "new", text: `- ${name} works.`, scenarios: { conformance: [], acceptance: [] } }],
      ...(requires !== undefined ? { requires } : {}),
    });
    const names = ["version_api", "function_executor", "http_client", "auth", "utils", "listing", "restore_api"];
    const pages = names.map((name, index) => module(name, index > 0 ? names[index - 1] : undefined));
    const marked = markSpecMap(pages, { files: [], codebases: [codebase(pages[0]!)] });
    const shown = marked.find((page) => page.module === "auth")!;
    expect(tabBar(marked, shown, 200, style, 0).line).toBe("version_api  function_executor  http_client  [auth]  utils  listing  restore_api");
    const { line: narrow } = tabBar(marked, shown, 40, style, 0);
    expect(narrow).toContain("[auth]");
    expect(narrow).toMatch(/^‹ \d+ {2}.*\[auth\].* \d+ ›$/);
    expect(narrow.length).toBeLessThanOrEqual(40);
    // A chain of many modules draws only the one shown, not each nested in the next.
    const lines = specMapLines(marked, createSpecMapState(), 120, style).lines.join("\n");
    const focus = focusOf(marked)!;
    expect(lines).toContain(`- ${focus.module} works.`);
    expect(names.filter((name) => name !== focus.module).some((name) => lines.includes(`- ${name} works.`))).toBe(false);
  });

  it("heads the map with its count and status, and its two columns with status and the module's file", () => {
    const top = markSpecMap([{ ...page(tree({ [FUNCTIONAL_REQUIREMENTS]: ["- Two.", "- Three."] }), tree({ [FUNCTIONAL_REQUIREMENTS]: ["- Two."] })), module: "top", plainFile: join(dir, "top.plain") }], noPlan)[0]!;
    const head = specMapHeader(top, 160, style);
    expect(head).not.toContain("top.plain");
    expect(columnHeadings(top, 160, style)).toEqual([" status │ top.plain", "        │"]);
    expect(head).toContain("1 of 2 functionalities built · not asked to build - regenerate plans it");
  });

  it("opens the module regenerating now, and the one asked for, before the others", () => {
    const base = { ...page(tree({ [FUNCTIONAL_REQUIREMENTS]: ["- One."] }), null), module: "base", plainFile: join(dir, "base.plain") };
    const top = { ...page(tree({ [FUNCTIONAL_REQUIREMENTS]: ["- Two."] }), null), module: "top", plainFile: join(dir, "top.plain") };
    // The chain's codebase is asked for: the module at its top is in focus.
    const asked = markSpecMap([base, top], { files: [], codebases: [codebase(base)] });
    expect(focusOf(asked)?.module).toBe("top");
    // A pulse regenerates the module below: that one is.
    const one = base.items[0]!;
    const regenerating = markSpecMap([base, top], { files: [], codebases: [codebase(base, { pulses: [pulseOf([one], 1, true)] })] });
    expect(focusOf(regenerating)?.module).toBe("base");
  });

  it("highlights the spec as plyn does - its section headings, concepts and literals - the words a diff keeps too", () => {
    const paint = { ...PLAIN_PAINT, syntax: (role: string, text: string) => `<${role}>${text}</${role}>` };
    const first = page(
      tree({ [FUNCTIONAL_REQUIREMENTS]: ["- A :User: can log in via `POST /auth/login`.", ["log-out", "- A :User: can sign out via `POST /auth/logout`."]] }),
      tree({ [FUNCTIONAL_REQUIREMENTS]: ["- A :User: can log in via `POST /auth/login`.", ["log-out", "- A :User: can log out via `POST /auth/logout`."]] }),
    );
    const [marked] = markSpecMap([first], noPlan);
    const text = specMapLines([marked!], createSpecMapState(), 300, { ...style, diff: paint }).lines.join("\n");
    expect(text).toContain("<section>***functional specs***</section>");
    expect(text).toContain("<bullet>-</bullet> A <concept>:User:</concept> can log in via <literal>`POST /auth/login`</literal>.");
    expect(text).toContain("A <concept>:User:</concept> can [-log-]{+sign+} out via <literal>`POST /auth/logout`</literal>.");
  });

  it("diffs a line word by word and an item line by line", () => {
    expect(wordDiff("3 to 30 characters", "3 to 20 characters", style)).toBe("3 to [-30-]{+20+} characters");
    expect(lineDiff("a\nb\nc", "a\nB\nc")).toEqual([{ was: "a", now: "a" }, { was: "b", now: "B" }, { was: "c", now: "c" }]);
  });
});

describe("the side panel's two views", () => {
  const job = (id: string) => ({ id, kind: "regenerate", summary: "app.plain log in", module: "app", status: "running" as const, sequence: 1, queuedAt: 0, startedAt: Date.now(), waitingOn: [], tail: "", activity: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, agents: [], transcript: [] });

  /** Drive the panel by what is actually on screen, including the dock's coordinate translation. */
  function clickLabel(panel: ReturnType<typeof createSidePanel>, text: string, width: number) {
    const lines = panel.render(width);
    const y = lines.findIndex((line) => line.includes(text));
    expect(y, `visible label: ${text}`).toBeGreaterThanOrEqual(0);
    const x = lines[y]!.indexOf(text);
    for (const type of ["press", "click"] as const) {
      panel.handleMouse({ type, button: "left", x, y, screenX: x + width + 2, screenY: y + 1, width, height: lines.length, shift: false, alt: false, ctrl: false });
    }
    return panel.render(width);
  }

  it("opens a spec on a wrapped summary after scrolling, and leaves keyboard navigation on that spec", () => {
    const first = page(tree({ [FUNCTIONAL_REQUIREMENTS]: [
      ...Array.from({ length: 12 }, (_, i): [string, string] => [`above-${i}`, `Earlier spec ${i}.`]),
      ["follow-link", "Follow the link and send the visitor to its saved destination.\nKeep the original query."],
    ] }), null);
    const mapState = createSpecMapState();
    const panel = createSidePanel({ jobs: () => [], map: () => markSpecMap([first], noPlan), mapState, rows: () => 25, style, key: "ctrl+h", back() {}, close() {} });
    panel.render(40);
    panel.handleInput("G");
    panel.render(40);
    panel.handleMouse({ type: "wheel", button: "none", x: 10, y: 15, width: 40, height: 25, screenX: 54, screenY: 16, wheelDelta: 8, shift: false, alt: false, ctrl: false });
    expect(mapState.top).toBeGreaterThan(0);
    clickLabel(panel, "destination.", 40);
    expect(mapState.open.has(mapState.cursorKey!)).toBe(true);
    expect(panel.render(40).find((line) => line.startsWith("›"))).toContain("# follow-link");
    panel.handleInput("\r");
    expect(mapState.open.size).toBe(0);
  });

  it("toggles an imported file and switches to another module by clicking its name", () => {
    const first = page(tree({ [FUNCTIONAL_REQUIREMENTS]: ["Say hello."] }), null);
    const lib = "stdlib/lang/python";
    const base = { ...first, module: "base", plainFile: join(dir, "base.plain") };
    const upper = { ...first, requires: "base", imports: [lib], items: [...first.items, { ...first.items[0]!, file: lib, key: "req", text: "Use Python." }] };
    const marked = markSpecMap([base, upper], { files: [], codebases: [codebase(base)] });
    const panel = createSidePanel({ jobs: () => [], map: () => marked, rows: () => 40, style, key: "ctrl+h", back() {}, close() {} });
    expect(clickLabel(panel, `▸ from ${lib}`, 90).join("\n")).toContain("Use Python.");
    expect(clickLabel(panel, `▾ from ${lib}`, 90).join("\n")).not.toContain("Use Python.");
    expect(clickLabel(panel, "base  [app]", 90).join("\n")).toContain("status │ base.plain");
  });

  it("opens pulse sections, pulses and diff files by clicking their labels", () => {
    const jobs = [{ ...job("done"), status: "succeeded" as const, diff: "--- a/app.plain\n+++ b/app.plain\n@@ -1 +1,2 @@\n+- Keep the query.\n" }];
    const panel = createSidePanel({ jobs: () => jobs, rows: () => 35, style, key: "ctrl+h", back() {}, close() {} });
    expect(clickLabel(panel, "finished (1)", 70).join("\n")).toContain("app regenerate");
    expect(clickLabel(panel, "app regenerate", 70).join("\n")).toContain("Keep the query.");
    expect(clickLabel(panel, "app.plain", 70).join("\n")).not.toContain("Keep the query.");
    expect(clickLabel(panel, "app.plain", 70).join("\n")).toContain("Keep the query.");
  });

  it("opens either view from its tab even with no spec, and clicking the selected tab keeps that view", () => {
    let closed = 0;
    let highlighted = "";
    const panel = createSidePanel({ jobs: () => [], map: () => [], rows: () => 20, style, key: "ctrl+h", back() {}, close() { closed++; }, tabLabel(text, active) { if (active) highlighted = text; return text; } });
    const click = (x: number) => {
      for (const type of ["press", "click"] as const) panel.handleMouse({ type, button: "left", x, y: 0, screenX: 72 + x, screenY: 1, width: 68, height: 20, shift: false, alt: false, ctrl: false });
    };
    const [tabs] = panel.render(68);
    expect(tabs).toMatch(/^ \*\*\*plain {3}pulses +× close $/);
    expect(highlighted).toBe(" ***plain ");
    click(tabs!.indexOf("pulses"));
    expect(panel.render(68)[0]).toBe(tabs);
    expect(highlighted).toBe(" pulses ");
    expect(panel.render(68).slice(1, 3)).toEqual(["", "pulses"]);
    click(tabs!.indexOf("pulses"));
    expect(panel.render(68)[2]).toBe("pulses");
    click(tabs!.indexOf("plain"));
    expect(panel.render(68).join("\n")).toContain("No .plain file to map");
    expect(closed).toBe(0);
    click(tabs!.indexOf("close"));
    expect(closed).toBe(1);
  });

  it("opens on regen, and p goes to the pulse regenerating the item under the cursor and back to the item", () => {
    const first = page(tree({ [FUNCTIONAL_REQUIREMENTS]: ["- Register.", "- Log in."] }), tree({ [FUNCTIONAL_REQUIREMENTS]: ["- Register."] }));
    const login = first.items.find((entry) => entry.text === "- Log in.")!;
    const marked = markSpecMap([first], { files: [], codebases: [codebase(first, { pulses: [pulseOf([login], 1, true)] })] });
    const panel = createSidePanel({ jobs: () => [job("job1")], map: () => marked, rows: () => 20, style, back() {}, close() {}, key: "ctrl+h" });
    const [, gap, title] = panel.render(100);
    expect(gap).toBe("");
    expect(title).toContain("regen");
    panel.handleInput("\x1b[B");
    panel.handleInput("\x1b[B");
    panel.handleInput("p");
    const pulses = panel.render(100);
    expect(pulses[2]).toMatch(/^pulses/);
    // A line of space under the rule, before the first section.
    const rule = pulses.findIndex((line) => /^─+$/.test(line));
    expect(pulses[rule + 1]).toBe("");
    expect(pulses[rule + 2]).toMatch(/running \(\d+\)/);
    expect(pulses.find((line) => line.startsWith("›"))).toContain("app regenerate");
    panel.handleInput("p");
    const map = panel.render(100);
    expect(map.find((line) => line.startsWith("›"))).toContain("# log-in");
  });

  it("draws one mark a row on the ladder - planned, working, regenerated, validating, conform - the same whatever the config says of conformance tests, named in the legend in the corner", () => {
    const first = page(
      tree({ [DEFINITIONS]: ["- :User: is a person."], [FUNCTIONAL_REQUIREMENTS]: ["- Register.", "- Log in.", "- Log out.", "- Search."] }),
      tree({ [DEFINITIONS]: ["- :User: is a person."], [FUNCTIONAL_REQUIREMENTS]: ["- Register.", "- Log in.", "- Log out."] }),
      tree({ [FUNCTIONAL_REQUIREMENTS]: ["- Register."] }),
    );
    const rungs = (conformance: boolean) => markSpecMap([{ ...first, conformance }], noPlan)[0]!.items.map((entry) => [entry.text, rungOf(entry)]);
    expect(rungs(true)).toEqual([
      ["- :User: is a person.", "regenerated"],
      ["- Register.", "conform"],
      ["- Log in.", "regenerated"],
      ["- Log out.", "regenerated"],
      ["- Search.", "toRegenerate"],
    ]);
    expect(rungs(false)).toEqual(rungs(true));
    const [marked] = markSpecMap([first], noPlan);
    const lines = specMapLines([marked!], createSpecMapState(), 100, style).lines;
    // A mark alone, under the status column's heading.
    expect(lines.find((line) => line.includes("# register"))).toMatch(/^[ ›] {2}◆ {4}│ # register/);
    expect(lines.find((line) => line.includes("# log-in"))).toMatch(/^[ ›] {2}◇ {4}│ # log-in/);
    expect(lines.find((line) => line.includes("# search"))).toMatch(/^[ ›] {2}○ {4}│ # search/);
    // A line of space between one functional spec and the next, as the file writes them.
    const logIn = lines.findIndex((line) => line.includes("# log-in"));
    expect(lines[logIn - 1]).toBe("        │");
    expect(lines[logIn - 2]).toMatch(/│ \S/);
    // A functional spec with no scenarios says nothing of it on its row: its mark says where it stands.
    expect(lines.find((line) => line.includes("# log-in"))!.trimEnd()).toMatch(/# log-in$/);
    // The legend: up the ladder, every rung whatever the page has - to take out only where something is.
    expect(legendLines(marked!, style)).toEqual(["○ planned", "⠋ working", "◇ regenerated", "⠋ validating", "◆ conform", "! needs you"]);
    const panel = createSidePanel({ jobs: () => [], map: () => [marked!], rows: () => 20, style, back() {}, close() {}, key: "ctrl+h" });
    const drawn = panel.render(100);
    // In the upper right corner, beside the title and the keys - the keys at the top, where they are seen first.
    const plain = drawn.slice(2).map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());
    // Validating spins in the green of the rungs it is between, working in the accent: told apart at a glance.
    const painted = legendLines(marked!, { ...style, accent: (text: string) => `<accent>${text}`, success: (text: string) => `<green>${text}` });
    expect(painted[1]).toBe("<accent>⠋ working");
    expect(painted[3]).toBe("<green>⠋ validating");
    const legend = ["○ planned", "⠋ working", "◇ regenerated", "⠋ validating", "◆ conform", "! needs you"];
    // A box in the upper right corner, the panel's first lines beside it.
    expect(plain[0]).toMatch(/ ┌─+┐$/);
    expect(plain.slice(1, 7).map((line) => line.slice(line.lastIndexOf("│ ", line.length - 2) + 2, -1).trim())).toEqual(legend);
    expect(plain[7]).toMatch(/ └─+┘$/);
    // The top line wraps beside it, never cut short; the keys under it - at the top, where they are seen first - and
    // the rule straight under them, stopping short of the box.
    expect(plain.join("\n")).not.toContain("...");
    const rule = plain.findIndex((line) => /^─+ +│/.test(line));
    expect(plain.slice(0, rule).join(" ")).toContain("↑↓ move");
    // A line of space under the title, and under the rule.
    const blankBeside = (line: string) => line.split(/[│┌└]/)[0]!.trim() === "";
    expect(blankBeside(plain[plain.findIndex((line) => line.startsWith("↑↓ move")) - 1]!)).toBe(true);
    expect(blankBeside(plain[rule + 1]!)).toBe(true);
    expect(plain[rule + 2]).toMatch(/^ status │ app\.plain/);
  });

  it("hands a module that needs the person to the chat on d, and offers the key only then", () => {
    const first = page(tree({ [FUNCTIONAL_REQUIREMENTS]: ["- Register.", "- Log in."] }), tree({ [FUNCTIONAL_REQUIREMENTS]: ["- Register."] }));
    const login = first.items.find((entry) => entry.text === "- Log in.")!;
    const failed = pulseOf([login], 3, false);
    const stuck = markSpecMap([first], { files: [], codebases: [codebase(first, { stuck: { why: "pulse abc did not land", pulse: { number: 3, before: failed.before, after: failed.after } } })] });
    const discussed: string[] = [];
    let marked = markSpecMap([first], noPlan);
    const panel = createSidePanel({ jobs: () => [], map: () => marked, rows: () => 20, style, back() {}, close() {}, key: "ctrl+h", discuss: (shown) => discussed.push(shown.status) });
    expect(panel.render(100).join("\n")).not.toContain("d talk it through");
    panel.handleInput("d");
    expect(discussed).toEqual([]);
    marked = stuck;
    const lines = panel.render(100);
    expect(lines[2]).toContain("! needs you");
    expect(lines[4]).toMatch(/^d talk it through in the chat · /);
    panel.handleInput("d");
    expect(discussed).toEqual(["pulse 3 didn't land"]);
  });

  it("shows what failed when the map cannot be drawn, rather than throwing - a frame that throws freezes the screen", () => {
    const panel = createSidePanel({ jobs: () => [], map: () => { throw new Error("the plan could not be read"); }, rows: () => 20, style, back() {}, close() {}, key: "ctrl+h" });
    const lines = panel.render(100);
    expect(lines).toHaveLength(20);
    expect(lines.find((line) => line.includes("could not be drawn"))).toContain("could not be drawn: Error: the plan could not be read");
    expect(lines[4]).toContain("p the other view · esc or ctrl+h back to the chat");
    panel.handleInput("p");
    expect(panel.render(100)[2]).toMatch(/^pulses/);
  });

  it("reads a plan that fails as a page saying so", () => {
    writeFileSync(join(dir, "app.plain"), "***implementation reqs***\n\n- Use Python.\n\n***functional specs***\n\n# say-hello\nSay hello.\n");
    const source = createSpecMapSource({ files: () => [join(dir, "app.plain")], plan: () => { throw new Error("no plan"); } });
    expect(source.read()[0]).toMatchObject({ status: "the map could not be read: no plan", stuck: true });
  });

  it("goes from one module's tab to the next with ←→, follows the module regenerating until another tab is chosen, and opens an item with enter", () => {
    const base = { ...page(tree({ [FUNCTIONAL_REQUIREMENTS]: ["- One."] }), null), module: "base", plainFile: join(dir, "base.plain") };
    const top = { ...page(tree({ [FUNCTIONAL_REQUIREMENTS]: ["- Two."] }), null), module: "top", plainFile: join(dir, "top.plain"), requires: "base" };
    let marked = markSpecMap([base, top], { files: [], codebases: [codebase(base)] });
    const panel = createSidePanel({ jobs: () => [], map: () => marked, rows: () => 20, style, back() {}, close() {}, key: "ctrl+h" });
    // The module asked for is shown, its tab marked, the other beside it.
    let lines = panel.render(100);
    const heading = () => lines.find((line) => line.startsWith(" status │"))?.split("  ")[0];
    expect(heading()).toBe(" status │ top.plain");
    expect(lines[3]).toMatch(/^base {2}\[top\] /);
    expect(lines.join("\n")).toContain("- Two.");
    expect(lines.join("\n")).not.toContain("- One.");
    // ← to the module it is built on.
    panel.handleInput("\x1b[D");
    lines = panel.render(100);
    expect(heading()).toBe(" status │ base.plain");
    expect(lines[3]).toMatch(/^\[base\] {2}top /);
    expect(lines.join("\n")).toContain("- One.");
    // Enter opens the item under the cursor.
    panel.handleInput("\r");
    expect(panel.render(100).length).toBe(20);
    // Another module starts regenerating: the tab chosen gives way, and it is shown.
    const two = top.items[0]!;
    marked = markSpecMap([base, top], { files: [], codebases: [codebase(base, { pulses: [pulseOf([two], 1, true)] })] });
    // The top line wraps beside the legend as long as it needs to: the tabs are on the line after it.
    expect(panel.render(100).find((line) => line.startsWith("base"))).toMatch(/^base {2}\[\S+ top\] /);
  });
});
