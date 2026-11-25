import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildOrder, entriesOf, filesOf, linesOf, renderArea } from "../../src/capture/area.ts";
import { buildMap, fileRoute, kindOf, surfacesOf } from "../../src/capture/map.ts";
import { NOTES_APP, writeCodebase } from "./fixture.ts";

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function codebase(files = NOTES_APP, options: { git?: boolean } = {}): string {
  const root = writeCodebase(files, options);
  made.push(root);
  return root;
}

describe("the map of a codebase", () => {
  it("tells each file's kind by its name and folders", () => {
    expect(kindOf("app/routes.py")).toBe("source");
    expect(kindOf("tests/test_notes.py")).toBe("test");
    expect(kindOf("src/list.test.ts")).toBe("test");
    expect(kindOf("app/static/logo.png")).toBe("asset");
    expect(kindOf("requirements.txt")).toBe("manifest");
    expect(kindOf("docs/openapi.yaml")).toBe("contract");
    expect(kindOf("db/migrations/001_init.sql")).toBe("contract");
    expect(kindOf("README.md")).toBe("doc");
  });

  it("finds routes, tables and test names, and the codebase's own imports", () => {
    const map = buildMap(codebase());
    const file = (path: string) => map.files.find((candidate) => candidate.path === path)!;
    expect(file("app/routes.py").surfaces).toEqual(expect.arrayContaining([{ kind: "route", name: "POST /notes" }, { kind: "route", name: "GET /notes" }]));
    expect(file("app/models.py").surfaces).toEqual(expect.arrayContaining([{ kind: "table", name: "notes" }, { kind: "table", name: "Note" }]));
    expect(file("tests/test_notes.py").surfaces).toEqual([{ kind: "test", name: "test_add_note" }, { kind: "test", name: "test_list_notes" }]);
    expect(file("app/routes.py").imports).toEqual(["app/models.py"]);
    expect(file("app/__init__.py").imports).toEqual(["app/routes.py"]);
    expect(file("app/static/logo.png")).toMatchObject({ kind: "asset", lines: 0 });
  });

  it("finds the routes of Express, the commands of click and the screens of a file-routed app", () => {
    expect(surfacesOf("src/server.ts", 'router.post("/orders", create);\napp.get(`/orders/:id`, show);', "source")).toEqual([
      { kind: "route", name: "POST /orders" },
      { kind: "route", name: "GET /orders/:id" },
    ]);
    expect(surfacesOf("cli.py", '@cli.command()\n@click.option("--force")\ndef sync_all():\n    pass\n', "source")).toEqual(
      expect.arrayContaining([{ kind: "command", name: "sync-all" }, { kind: "option", name: "--force" }]),
    );
    expect(fileRoute("app/settings/page.tsx")).toBe("/settings");
    expect(fileRoute("src/pages/index.tsx")).toBe("/");
    expect(fileRoute("pages/_app.tsx")).toBeUndefined();
  });

  it("finds an option by every name it has, the environment variables read, and keeps the whole interface of a file", () => {
    expect(surfacesOf("cli.py", 'p.add_argument("-v", "--verbose", action="store_true")\np.add_argument("url")\n@click.option("--dry-run", "-n")\n', "source")).toEqual([
      { kind: "option", name: "-v, --verbose" },
      { kind: "option", name: "--dry-run, -n" },
    ]);
    expect(surfacesOf("config.py", 'import os\nhome = os.environ.get("HTTPIE_CONFIG_DIR")\nx = os.environ["XDG_CONFIG_HOME"]\ny = getenv("APPDATA")\n', "source")).toEqual([
      { kind: "env", name: "HTTPIE_CONFIG_DIR" },
      { kind: "env", name: "APPDATA" },
      { kind: "env", name: "XDG_CONFIG_HOME" },
    ]);
    expect(surfacesOf("src/env.ts", "const port = process.env.PORT; const key = process.env[\"API_KEY\"];", "source")).toEqual([
      { kind: "env", name: "PORT" },
      { kind: "env", name: "API_KEY" },
    ]);
    // Seventy options in one file are seventy: capture checks every one. Its tests are still a sample.
    const options = Array.from({ length: 70 }, (_, at) => `p.add_argument("--option-${at}")`).join("\n");
    expect(surfacesOf("definition.py", options, "source").filter((surface) => surface.kind === "option")).toHaveLength(70);
    const tests = Array.from({ length: 70 }, (_, at) => `def test_${at}():\n    pass`).join("\n");
    expect(surfacesOf("test_cli.py", tests, "test")).toHaveLength(60);
  });

  it("leaves out its own output, other turri projects, dependencies and what git ignores", () => {
    const root = codebase(NOTES_APP, { git: true });
    mkdirSync(join(root, "plain"), { recursive: true });
    writeFileSync(join(root, "plain", "notes.plain"), "***functional specs***\n");
    mkdirSync(join(root, "node_modules", "left"), { recursive: true });
    writeFileSync(join(root, "node_modules", "left", "index.js"), "module.exports = 1;\n");
    writeFileSync(join(root, ".gitignore"), "*.log\n");
    writeFileSync(join(root, "debug.log"), "noise\n");
    // An earlier capture, moved aside: a turri project, not the code.
    mkdirSync(join(root, "plain-before"));
    writeFileSync(join(root, "plain-before", "config.turri.yaml"), "conformance-tests: true\n");
    writeFileSync(join(root, "plain-before", "notes.plain"), "***functional specs***\n");
    const paths = buildMap(root, { exclude: [join(root, "plain")] }).files.map((file) => file.path);
    expect(paths).toContain("app/routes.py");
    expect(paths.some((path) => path.startsWith("plain/") || path.startsWith("plain-before/") || path.startsWith("node_modules/") || path === "debug.log")).toBe(false);
  });
});

describe("an area of the map", () => {
  it("divides into the folders and files of its one folder", () => {
    const map = buildMap(codebase());
    expect(entriesOf(map, ["."]).map((entry) => entry.path)).toEqual(["app", "tests", "README.md", "requirements.txt"]);
    expect(entriesOf(map, ["app/routes.py", "tests"]).map((entry) => entry.path)).toEqual(["app/routes.py", "tests"]);
  });

  it("is folded to fit the budget it is given, down to counts", () => {
    const map = buildMap(codebase());
    const full = renderArea(map, ["."], 10_000);
    expect(full).toContain("POST /notes");
    expect(full).toContain("app/routes.py");
    const folded = renderArea(map, ["."], 300);
    expect(folded.length).toBeLessThanOrEqual(300);
    expect(folded).toContain("app/");
    expect(folded).toContain("2 routes");
    expect(folded).not.toContain("POST /notes");
  });

  it("is put after the areas it imports from", () => {
    const map = buildMap(codebase());
    const ordered = buildOrder(map, [
      { name: "api", paths: ["app/routes.py", "app/__init__.py"] },
      { name: "storage", paths: ["app/models.py"] },
    ]);
    expect(ordered.map((area) => area.name)).toEqual(["storage", "api"]);
    expect(linesOf(filesOf(map, ["app/models.py"]))).toBe(7);
  });
});
