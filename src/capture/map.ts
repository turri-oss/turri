import { spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { posix } from "node:path";
import { isWithin, slashed } from "../regenerate/paths.ts";

/**
 * The map of a codebase capture works from, built with no model: every file it holds, what kind each is, its size, the
 * surfaces it shows - routes, commands, screens, tables, test names, exports - and which of the codebase's files it
 * imports. Linear in the code, but cheap: patterns, never tokens. No agent reads the codebase whole; each is shown a part
 * of this map, folded to fit its budget (area.ts), and looks at the code only to follow a surface.
 */

/** What a file is to capture. */
export type FileKind = "source" | "test" | "doc" | "asset" | "contract" | "manifest" | "other";

/** What a surface is: what a user or a client can reach, or what shows what the code does. */
export type SurfaceKind = "route" | "command" | "option" | "screen" | "env" | "table" | "test" | "export";

/**
 * The surfaces that are the software's interface - what a user, a client or a script calls by name: its routes, commands,
 * options, screens and the environment variables it reads. Capture names every one in its ***plain, or says why not.
 */
export const INTERFACE_KINDS: ReadonlySet<SurfaceKind> = new Set(["route", "command", "option", "screen", "env"]);

export interface Surface {
  kind: SurfaceKind;
  /** `GET /todos`, `add`, `-v, --verbose`, `/settings`, `TODO_DB`, `todos`, `test_add_todo`, `createTodo`. */
  name: string;
}

export interface MapFile {
  /** Relative to the codebase, with `/` on every OS. */
  path: string;
  kind: FileKind;
  lines: number;
  /** Size on disk for a readable text file. */
  bytes?: number;
  surfaces: Surface[];
  /** The codebase's files it imports, as paths like its own. */
  imports: string[];
}

export interface CodeMap {
  root: string;
  files: MapFile[];
}

/** Folders never part of what is captured: dependencies, caches, histories, build output, turri's own. */
const SKIPPED_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".tox",
  ".nox",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turri",
  ".plaingit",
  "plain_modules",
  ".gradle",
  ".idea",
  ".vscode",
  "target",
  "coverage",
]);

/** Lock files: the versions the dependencies are pinned to, which say nothing about what the software does. */
export const LOCK_FILES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "poetry.lock",
  "uv.lock",
  "Pipfile.lock",
  "go.sum",
  "Cargo.lock",
  "composer.lock",
  "Gemfile.lock",
]);

/** Files that say nothing about what the software does: lock files and the like. */
const SKIPPED_FILES = new Set([...LOCK_FILES, ".DS_Store"]);

const SOURCE_EXTENSIONS = new Set([
  "py", "js", "jsx", "ts", "tsx", "mjs", "cjs", "mts", "cts", "go", "rs", "java", "kt", "kts", "scala", "rb", "php", "cs", "fs",
  "swift", "c", "h", "cc", "cpp", "hpp", "m", "mm", "ex", "exs", "erl", "clj", "cljs", "dart", "lua", "vue", "svelte", "astro",
  "html", "htm", "jinja", "jinja2", "j2", "hbs", "handlebars", "ejs", "erb", "twig", "css", "scss", "sass", "less", "sql", "sh",
  "bash", "zsh", "ps1", "r", "jl", "elm", "hs", "ml", "zig", "nim",
]);

const DOC_EXTENSIONS = new Set(["md", "mdx", "rst", "adoc", "txt"]);

const ASSET_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "svg", "webp", "ico", "bmp", "avif", "tif", "tiff", "woff", "woff2", "ttf", "otf", "eot", "mp3",
  "wav", "ogg", "flac", "m4a", "mp4", "webm", "mov", "avi",
]);

const MANIFEST_FILES = new Set([
  "package.json", "pyproject.toml", "setup.py", "setup.cfg", "Pipfile", "go.mod", "Cargo.toml", "pom.xml", "build.gradle",
  "build.gradle.kts", "settings.gradle", "settings.gradle.kts", "Gemfile", "composer.json", "mix.exs", "deno.json", "Dockerfile",
  "docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml", "Makefile", "tsconfig.json", "vite.config.ts",
  "vite.config.js", "next.config.js", "next.config.mjs", "angular.json", "manage.py",
]);

/** The folders tests live in, by name. */
const TEST_DIRS = new Set(["test", "tests", "__tests__", "spec", "specs", "e2e", "cypress", "playwright", "integration_tests"]);

const TEST_FILE = /(^test_.*\.py$)|(_test\.(py|go)$)|(\.(test|spec)\.[cm]?[jt]sx?$)|(Tests?\.(java|kt|cs)$)|(_spec\.rb$)|(^conftest\.py$)/;

/** A file larger than this has its lines counted, and no surfaces looked for: generated, minified or data. */
const MAX_SCANNED_BYTES = 512 * 1024;

/**
 * How many tests, exports or tables a file keeps: enough to show what it does, never a generated file's thousands. Its
 * interface is kept whole - a file defining seventy options has seventy - since capture checks every one.
 */
const MAX_SURFACES_PER_KIND = 60;

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/** What kind of file a path is, by its name and folders alone. */
export function kindOf(path: string): FileKind {
  const parts = path.split("/");
  const name = parts.at(-1)!;
  const extension = extensionOf(name);
  if (MANIFEST_FILES.has(name) || /^requirements.*\.txt$/.test(name) || /\.(csproj|sln|cabal|gemspec)$/.test(name)) return "manifest";
  if (ASSET_EXTENSIONS.has(extension)) return "asset";
  if (isContract(path, name, extension)) return "contract";
  if (TEST_FILE.test(name) || parts.slice(0, -1).some((part) => TEST_DIRS.has(part))) return SOURCE_EXTENSIONS.has(extension) ? "test" : "other";
  if (SOURCE_EXTENSIONS.has(extension)) return "source";
  if (DOC_EXTENSIONS.has(extension)) return "doc";
  return "other";
}

function isContract(path: string, name: string, extension: string): boolean {
  if (/^(openapi|swagger)[^/]*\.(ya?ml|json)$/i.test(name)) return true;
  if (["graphql", "gql", "proto", "avsc", "prisma"].includes(extension)) return true;
  if (/\.schema\.json$/i.test(name)) return true;
  if (extension === "sql" && path.split("/").some((part) => /^(migrations?|schema|db)$/i.test(part))) return true;
  if (/^schema\.sql$/i.test(name)) return true;
  return false;
}

/** The files of a codebase: what git sees - tracked, and untracked but not ignored - in a repo; every file but the skipped ones elsewhere. */
export function listFiles(root: string, exclude: string[] = []): string[] {
  const excluded = exclude.map((path) => resolve(path));
  const kept = (path: string) => {
    const parts = path.split("/");
    if (parts.slice(0, -1).some((part) => SKIPPED_DIRS.has(part)) || SKIPPED_FILES.has(parts.at(-1)!)) return false;
    const absolute = join(root, ...parts);
    return !excluded.some((dir) => isWithin(absolute, dir));
  };
  const fromGit = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (fromGit.status === 0) {
    return [...new Set(fromGit.stdout.split("\0").filter((path) => path !== ""))]
      .filter(kept)
      .filter((path) => {
        try {
          return statSync(join(root, ...path.split("/"))).isFile();
        } catch {
          // Deleted, and not yet committed as deleted.
          return false;
        }
      })
      .sort();
  }
  const found: string[] = [];
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name) && !excluded.some((skip) => isWithin(path, skip))) walk(path);
      } else if (entry.isFile()) {
        found.push(slashed(relative(root, path)));
      }
    }
  };
  walk(root);
  return found.filter(kept).sort();
}

/** Whether a file's start holds a NUL byte - binary, however it is named. */
function looksBinary(path: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.alloc(8000);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, read).includes(0);
  } catch {
    return true;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function countLines(text: string): number {
  if (text === "") return 0;
  let lines = 1;
  for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) lines += 1;
  return text.endsWith("\n") ? lines - 1 : lines;
}

/** Build the map of the codebase at `root`, leaving out what `exclude` names - capture's own output above all. */
export function buildMap(root: string, options: { exclude?: string[] } = {}): CodeMap {
  const absoluteRoot = resolve(root);
  const paths = withoutPlainProjects(listFiles(absoluteRoot, options.exclude ?? []));
  const texts = new Map<string, string>();
  const files: MapFile[] = paths.map((path) => {
    const kind = kindOf(path);
    const disk = join(absoluteRoot, ...path.split("/"));
    if (kind === "asset") return { path, kind, lines: 0, surfaces: [], imports: [] };
    let size = 0;
    try {
      size = statSync(disk).size;
    } catch {
      return { path, kind, lines: 0, surfaces: [], imports: [] };
    }
    if (looksBinary(disk)) return { path, kind: "other" as const, lines: 0, surfaces: [], imports: [] };
    let text = "";
    try {
      text = readFileSync(disk, "utf8");
    } catch {
      return { path, kind, lines: 0, surfaces: [], imports: [] };
    }
    const lines = countLines(text);
    if (size <= MAX_SCANNED_BYTES && (kind === "source" || kind === "test" || kind === "contract")) texts.set(path, text);
    return { path, kind, lines, bytes: size, surfaces: [], imports: [] };
  });
  const resolver = importResolver(absoluteRoot, paths);
  for (const file of files) {
    const text = texts.get(file.path);
    if (text === undefined) continue;
    file.surfaces = surfacesOf(file.path, text, file.kind);
    file.imports = resolver(file.path, text).filter((target) => target !== file.path);
  }
  // File-routed frameworks: the route is the file's own path.
  for (const file of files) {
    const route = fileRoute(file.path);
    if (route !== undefined && !file.surfaces.some((surface) => surface.kind === "screen" && surface.name === route)) file.surfaces.unshift({ kind: "screen", name: route });
  }
  return { root: absoluteRoot, files };
}

/**
 * The files outside the turri projects in the codebase - a folder with a `config.turri.yaml` or a module's own file,
 * an earlier capture's: its ***plain is not the code, and capture never reads what it wrote itself.
 */
export function withoutPlainProjects(paths: string[]): string[] {
  const projects = paths.filter((path) => /^config\.turri(\.[^/]+)?\.yaml$/.test(posix.basename(path)) && path.includes("/")).map((path) => posix.dirname(path));
  return paths.filter((path) => !projects.some((project) => path.startsWith(`${project}/`)));
}

/** A page of Next.js, Nuxt, SvelteKit or Astro, whose route is where the file is. */
export function fileRoute(path: string): string | undefined {
  const pages = /(?:^|\/)(?:src\/)?pages\/(.+)\.(?:tsx|jsx|ts|js|vue|astro|md|mdx)$/.exec(path);
  if (pages !== null) {
    const route = pages[1]!.replace(/(^|\/)index$/, "");
    // The app's frame and its API routes are not pages anyone visits.
    if (/(^|\/)_(app|document|error)$/.test(route) || pages[1]!.startsWith("api/")) return undefined;
    return `/${route}`;
  }
  const app = /(?:^|\/)(?:src\/)?app\/(?:(.+)\/)?page\.(?:tsx|jsx|ts|js|mdx)$/.exec(path);
  if (app !== null) return `/${(app[1] ?? "").split("/").filter((part) => !/^\(.*\)$/.test(part)).join("/")}`;
  const svelte = /(?:^|\/)src\/routes\/(?:(.+)\/)?\+page\.svelte$/.exec(path);
  if (svelte !== null) return `/${(svelte[1] ?? "").split("/").filter((part) => !/^\(.*\)$/.test(part)).join("/")}`;
  return undefined;
}

interface Pattern {
  kind: SurfaceKind;
  /** Global, line-anchored where it needs to be; the name is built from its groups. */
  regex: RegExp;
  name: (match: RegExpExecArray) => string | undefined;
  /** Only in files whose extension is one of these. */
  extensions?: string[];
  /** Only in files of these kinds. */
  kinds?: FileKind[];
}

const PY = ["py"];
const JS = ["js", "jsx", "ts", "tsx", "mjs", "cjs", "mts", "cts", "vue", "svelte"];
const HTTP_METHODS = "get|post|put|patch|delete|head|options|all";

const upper = (text: string | undefined) => (text ?? "").toUpperCase();

/** An option's names as its definition lists them, quotes gone: `"-v", "--verbose"` is `-v, --verbose`. */
const optionNames = (list: string | undefined) => (list ?? "").split(",").map((name) => name.trim().replace(/^["']|["']$/g, "")).join(", ");

const PATTERNS: Pattern[] = [
  // Flask, FastAPI, Starlette, Sanic, aiohttp - a decorator with the path.
  {
    kind: "route",
    regex: /@[\w.]+\.(route|get|post|put|patch|delete|head|options|websocket|api_route)\(\s*f?["']([^"']*)["']([^\n]*)/g,
    extensions: PY,
    name: (m) => {
      const methods = /methods\s*=\s*[[(]([^\])]*)[\])]/.exec(m[3] ?? "")?.[1];
      const method = m[1] === "route" || m[1] === "api_route" ? (methods !== undefined ? methods.replace(/["'\s]/g, "").toUpperCase() : "GET") : upper(m[1]);
      return `${method} ${m[2]}`;
    },
  },
  // Django.
  { kind: "route", regex: /\b(?:re_)?path\(\s*r?["']([^"']*)["']/g, extensions: PY, name: (m) => `/${m[1]!.replace(/^\^|\$$/g, "")}` },
  // Express, Fastify, Koa, Hono.
  {
    kind: "route",
    regex: new RegExp(`\\b(?:app|router|server|api|fastify|routes|r)\\.(${HTTP_METHODS})\\(\\s*["'\`]([^"'\`]+)["'\`]`, "g"),
    extensions: JS,
    name: (m) => `${upper(m[1])} ${m[2]}`,
  },
  // NestJS.
  { kind: "route", regex: /@(Get|Post|Put|Patch|Delete|All)\(\s*(?:["'`]([^"'`]*)["'`])?\s*\)/g, extensions: ["ts", "js"], name: (m) => `${upper(m[1])} ${m[2] ?? ""}`.trim() },
  // Spring.
  {
    kind: "route",
    regex: /@(Get|Post|Put|Patch|Delete|Request)Mapping\(\s*(?:value\s*=\s*|path\s*=\s*)?\{?\s*"([^"]*)"/g,
    extensions: ["java", "kt"],
    name: (m) => `${m[1] === "Request" ? "ANY" : upper(m[1])} ${m[2]}`,
  },
  // Go: net/http, gin, echo, chi, fiber.
  { kind: "route", regex: /\.(?:HandleFunc|Handle)\(\s*"([^"]+)"/g, extensions: ["go"], name: (m) => m[1] },
  { kind: "route", regex: /\.(GET|POST|PUT|PATCH|DELETE|Get|Post|Put|Patch|Delete)\(\s*"([^"]+)"/g, extensions: ["go"], name: (m) => `${upper(m[1])} ${m[2]}` },
  // Rails.
  { kind: "route", regex: /^\s*(get|post|put|patch|delete)\s+["']([^"']+)["']/gm, extensions: ["rb"], name: (m) => `${upper(m[1])} ${m[2]}` },
  { kind: "route", regex: /^\s*resources?\s+:(\w+)/gm, extensions: ["rb"], name: (m) => `resources ${m[1]}` },
  // axum, actix.
  { kind: "route", regex: /\.route\(\s*"([^"]+)"\s*,\s*(get|post|put|patch|delete)/g, extensions: ["rs"], name: (m) => `${upper(m[2])} ${m[1]}` },
  { kind: "route", regex: /#\[(get|post|put|patch|delete)\(\s*"([^"]+)"/g, extensions: ["rs"], name: (m) => `${upper(m[1])} ${m[2]}` },
  // Commands: click, typer, argparse, cobra, commander, yargs, picocli, clap.
  {
    kind: "command",
    regex: /@[\w.]*command\(\s*(?:name\s*=\s*)?(?:["']([^"']+)["'])?[^\n]*\n(?:\s*@[^\n]*\n)*\s*(?:async\s+)?def\s+(\w+)/g,
    extensions: PY,
    name: (m) => m[1] ?? m[2]!.replace(/_/g, "-"),
  },
  { kind: "command", regex: /add_parser\(\s*["']([^"']+)["']/g, extensions: PY, name: (m) => m[1] },
  // An option with every name it has: `add_argument("-v", "--verbose", ...)` is `-v, --verbose`.
  { kind: "option", regex: /add_argument\(\s*((?:["']--?[\w-]+["']\s*,\s*)*["']--?[\w-]+["'])/g, extensions: PY, name: (m) => optionNames(m[1]) },
  { kind: "option", regex: /@click\.option\(\s*((?:["']--?[\w-]+["']\s*,\s*)*["']--?[\w-]+["'])/g, extensions: PY, name: (m) => optionNames(m[1]) },
  { kind: "command", regex: /\bUse:\s*"([^"\s]+)/g, extensions: ["go"], name: (m) => m[1] },
  { kind: "command", regex: /\.command\(\s*["'`]([^"'`\s<[]+)/g, extensions: JS, name: (m) => m[1] },
  { kind: "option", regex: /\.(?:option|requiredOption)\(\s*["'`]((?:-\w,\s*)?--?[\w-]+)/g, extensions: JS, name: (m) => m[1] },
  { kind: "command", regex: /@Command\(\s*name\s*=\s*"([^"]+)"/g, extensions: ["java", "kt"], name: (m) => m[1] },
  { kind: "command", regex: /(?:Command::new|SubCommand::with_name)\(\s*"([^"]+)"/g, extensions: ["rs"], name: (m) => m[1] },
  // Environment variables read, by name in capitals.
  { kind: "env", regex: /\b(?:os\.)?(?:environ\.get|getenv|environ\.setdefault)\(\s*["']([A-Z][A-Z0-9_]*)["']/g, extensions: PY, kinds: ["source"], name: (m) => m[1] },
  { kind: "env", regex: /\b(?:os\.)?environ\[\s*["']([A-Z][A-Z0-9_]*)["']\s*\]/g, extensions: PY, kinds: ["source"], name: (m) => m[1] },
  { kind: "env", regex: /\bprocess\.env(?:\.([A-Z][A-Z0-9_]*)\b|\[\s*["'`]([A-Z][A-Z0-9_]*)["'`]\s*\])/g, extensions: JS, kinds: ["source"], name: (m) => m[1] ?? m[2] },
  { kind: "env", regex: /\bos\.(?:Getenv|LookupEnv)\(\s*"([A-Z][A-Z0-9_]*)"/g, extensions: ["go"], kinds: ["source"], name: (m) => m[1] },
  { kind: "env", regex: /\benv::var(?:_os)?\(\s*"([A-Z][A-Z0-9_]*)"/g, extensions: ["rs"], kinds: ["source"], name: (m) => m[1] },
  { kind: "env", regex: /\bSystem\.getenv\(\s*"([A-Z][A-Z0-9_]*)"/g, extensions: ["java", "kt"], kinds: ["source"], name: (m) => m[1] },
  { kind: "env", regex: /\bENV(?:\[\s*|\.fetch\(\s*)["']([A-Z][A-Z0-9_]*)["']/g, extensions: ["rb"], kinds: ["source"], name: (m) => m[1] },
  // An environment variable named by a constant - `ENV_HTTPIE_CONFIG_DIR = 'HTTPIE_CONFIG_DIR'` - and read through it.
  { kind: "env", regex: /^\s*(?:export\s+)?(?:const\s+|let\s+|var\s+|static\s+final\s+String\s+|pub\s+const\s+)?(?:\w*_)?ENV(?:_\w+)?(?:\s*:\s*\w+)?\s*:?=\s*["']([A-Z][A-Z0-9]*_[A-Z0-9_]+)["']/gm, kinds: ["source"], name: (m) => m[1] },
  // Screens: React Router, Vue Router, Angular.
  { kind: "screen", regex: /<Route\b[^>]*\bpath=\{?["'`]([^"'`]+)["'`]/g, extensions: JS, name: (m) => m[1] },
  { kind: "screen", regex: /\bpath:\s*["'`](\/?[\w\-/:*.]*)["'`]\s*,\s*(?:component|element|loadComponent|loadChildren|children|name|redirectTo|lazy)/g, extensions: JS, name: (m) => (m[1]!.startsWith("/") ? m[1] : `/${m[1]}`) },
  // Tables and models.
  { kind: "table", regex: /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"[]?(?:\w+\.)?(\w+)/gi, name: (m) => m[1] },
  { kind: "table", regex: /__tablename__\s*=\s*["'](\w+)["']/g, extensions: PY, name: (m) => m[1] },
  { kind: "table", regex: /^class\s+(\w+)\((?:[\w.]*\bBase|db\.Model|SQLModel|models\.Model|Document|Model)\b[^)]*\)/gm, extensions: PY, name: (m) => m[1] },
  { kind: "table", regex: /^model\s+(\w+)\s*\{/gm, extensions: ["prisma"], name: (m) => m[1] },
  { kind: "table", regex: /@Entity\b[^\n]*\n(?:\s*@[^\n]*\n)*\s*(?:export\s+)?(?:public\s+)?class\s+(\w+)/g, extensions: ["ts", "java", "kt"], name: (m) => m[1] },
  { kind: "table", regex: /\bmodel\(\s*["'](\w+)["']\s*,/g, extensions: JS, name: (m) => m[1] },
  { kind: "table", regex: /^type\s+(\w+)\s+struct\s*\{[^}]*gorm/gm, extensions: ["go"], name: (m) => m[1] },
  // Test names.
  { kind: "test", regex: /^\s*(?:async\s+)?def\s+(test_\w+)/gm, extensions: PY, kinds: ["test"], name: (m) => m[1] },
  { kind: "test", regex: /\b(?:it|test)(?:\.(?:only|skip|each\([^)]*\)))?\(\s*["'`]([^"'`]+)["'`]/g, extensions: JS, kinds: ["test"], name: (m) => m[1] },
  { kind: "test", regex: /^func\s+(Test\w+)\(/gm, extensions: ["go"], kinds: ["test"], name: (m) => m[1] },
  { kind: "test", regex: /@Test\b[^\n]*\n(?:\s*@[^\n]*\n)*\s*(?:public\s+)?(?:void|fun)\s+(\w+)/g, extensions: ["java", "kt"], kinds: ["test"], name: (m) => m[1] },
  { kind: "test", regex: /#\[(?:tokio::)?test\][^\n]*\n\s*(?:async\s+)?fn\s+(\w+)/g, extensions: ["rs"], name: (m) => m[1] },
  { kind: "test", regex: /^\s*it\s+["']([^"']+)["']/gm, extensions: ["rb"], kinds: ["test"], name: (m) => m[1] },
  // Exports: what a library offers.
  { kind: "export", regex: /^export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|const|let|interface|type|enum)\s+(\w+)/gm, extensions: JS, kinds: ["source"], name: (m) => m[1] },
  { kind: "export", regex: /^(?:async\s+)?def\s+([a-zA-Z]\w*)\s*\(|^class\s+([A-Z]\w*)/gm, extensions: PY, kinds: ["source"], name: (m) => m[1] ?? m[2] },
  { kind: "export", regex: /^func\s+(?:\([^)]*\)\s*)?([A-Z]\w*)|^type\s+([A-Z]\w*)/gm, extensions: ["go"], kinds: ["source"], name: (m) => m[1] ?? m[2] },
  { kind: "export", regex: /^pub\s+(?:async\s+)?(?:fn|struct|enum|trait)\s+(\w+)/gm, extensions: ["rs"], kinds: ["source"], name: (m) => m[1] },
  { kind: "export", regex: /^public\s+(?:final\s+|abstract\s+)?(?:class|interface|enum|record)\s+(\w+)/gm, extensions: ["java"], kinds: ["source"], name: (m) => m[1] },
];

/** The surfaces a file shows, by the patterns that apply to it - each kind kept to a few dozen. */
export function surfacesOf(path: string, text: string, kind: FileKind): Surface[] {
  const extension = extensionOf(path.split("/").at(-1)!);
  const found: Surface[] = [];
  const seen = new Set<string>();
  const counts = new Map<SurfaceKind, number>();
  for (const pattern of PATTERNS) {
    if (pattern.extensions !== undefined && !pattern.extensions.includes(extension)) continue;
    if (pattern.kinds !== undefined && !pattern.kinds.includes(kind)) continue;
    // A table pattern written for SQL applies to SQL files, and to source that embeds it.
    pattern.regex.lastIndex = 0;
    for (let match = pattern.regex.exec(text); match !== null; match = pattern.regex.exec(text)) {
      if (match[0] === "") pattern.regex.lastIndex += 1;
      const name = pattern.name(match)?.trim();
      if (name === undefined || name === "") continue;
      const key = `${pattern.kind} ${name}`;
      if (seen.has(key)) continue;
      const count = counts.get(pattern.kind) ?? 0;
      if (count >= MAX_SURFACES_PER_KIND && !INTERFACE_KINDS.has(pattern.kind)) continue;
      seen.add(key);
      counts.set(pattern.kind, count + 1);
      found.push({ kind: pattern.kind, name });
    }
  }
  // A source file with routes, commands, options or screens: what it exports is how they are built, not what it offers.
  if (found.some((surface) => INTERFACE_KINDS.has(surface.kind) && surface.kind !== "env")) return found.filter((surface) => surface.kind !== "export");
  return found;
}

/**
 * What resolves a file's imports to the codebase's own files - relative ones in JavaScript, Python's modules, Go's
 * packages under go.mod's module, Java's packages, Rust's crate paths. Best effort: what it cannot place is left out,
 * and an import of a library is not the codebase's.
 */
function importResolver(root: string, paths: string[]): (path: string, text: string) => string[] {
  const all = new Set(paths);
  const dirs = new Set<string>();
  for (const path of paths) for (let dir = posix.dirname(path); dir !== "."; dir = posix.dirname(dir)) dirs.add(dir);

  // Python: a module by its dotted name, from the root and from each folder that holds packages (src/ and the like).
  const pythonModules = new Map<string, string>();
  for (const path of paths.filter((path) => path.endsWith(".py"))) {
    const dotted = path.replace(/\.py$/, "").replace(/\/__init__$/, "").split("/");
    for (let start = 0; start < dotted.length; start += 1) {
      const name = dotted.slice(start).join(".");
      if (!pythonModules.has(name)) pythonModules.set(name, path);
    }
  }
  // Go: the module path go.mod declares.
  let goModule: string | undefined;
  try {
    goModule = /^module\s+(\S+)/m.exec(readFileSync(join(root, "go.mod"), "utf8"))?.[1];
  } catch {
    goModule = undefined;
  }
  // Java and Kotlin: a package by the folder it is in.
  const packageDirs = new Map<string, string>();
  for (const dir of dirs) {
    const parts = dir.split("/");
    for (let start = 0; start < parts.length; start += 1) {
      const name = parts.slice(start).join(".");
      if (!packageDirs.has(name)) packageDirs.set(name, dir);
    }
  }
  const filesIn = (dir: string) => paths.filter((path) => posix.dirname(path) === dir);

  const resolveRelative = (from: string, target: string): string | undefined => {
    const base = target.startsWith("@/") ? posix.join(dirs.has("src") ? "src" : ".", target.slice(2)) : posix.join(posix.dirname(from), target);
    const normal = posix.normalize(base);
    const candidates = [normal, ...["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "vue", "svelte", "json"].flatMap((ext) => [`${normal}.${ext}`, `${normal}/index.${ext}`])];
    // TypeScript written with .js imports of .ts files.
    if (/\.js$/.test(normal)) candidates.push(normal.replace(/\.js$/, ".ts"), normal.replace(/\.js$/, ".tsx"));
    return candidates.find((candidate) => all.has(candidate));
  };

  return (path, text) => {
    const found = new Set<string>();
    const extension = extensionOf(path);
    if (JS.includes(extension)) {
      for (const match of text.matchAll(/(?:from\s+|require\(\s*|import\(\s*|import\s+)["'`]((?:\.{1,2}\/|@\/)[^"'`]+)["'`]/g)) {
        const target = resolveRelative(path, match[1]!);
        if (target !== undefined) found.add(target);
      }
    } else if (extension === "py") {
      // `from x import a, b` on one line, or `from x import (a,\n b)` over several - never into the next line's import.
      for (const match of text.matchAll(/^[ \t]*from[ \t]+(\.*)([\w.]*)[ \t]+import[ \t]+(\([^)]*\)|[\w, \t*]+)|^[ \t]*import[ \t]+([\w.]+)/gm)) {
        let name: string;
        if (match[4] !== undefined) {
          name = match[4];
        } else if (match[1] !== "") {
          // Relative: from the file's own package up.
          const levels = match[1]!.length;
          const pkg = posix.dirname(path).split("/").filter((part) => part !== ".");
          const base = pkg.slice(0, Math.max(0, pkg.length - (levels - 1)));
          name = [...base, ...(match[2] !== "" ? match[2]!.split(".") : [])].join(".");
        } else {
          name = match[2]!;
        }
        // The longest dotted prefix that is one of the codebase's modules.
        const parts = name.split(".");
        for (let end = parts.length; end > 0; end -= 1) {
          const module = pythonModules.get(parts.slice(0, end).join("."));
          if (module !== undefined) {
            found.add(module);
            break;
          }
        }
        // `from pkg import module`: each name may be a module of the package.
        if (match[3] !== undefined) {
          for (const imported of match[3].replace(/[()]/g, "").split(",").map((name) => name.trim().split(/\s+/)[0]!)) {
            const module = pythonModules.get(`${name}.${imported}`);
            if (module !== undefined) found.add(module);
          }
        }
      }
    } else if (extension === "go" && goModule !== undefined) {
      for (const match of text.matchAll(/"([^"\s]+)"/g)) {
        const target = match[1]!;
        if (!target.startsWith(`${goModule}/`)) continue;
        const dir = target.slice(goModule.length + 1);
        for (const file of filesIn(dir)) if (file.endsWith(".go")) found.add(file);
      }
    } else if (extension === "java" || extension === "kt") {
      for (const match of text.matchAll(/^import\s+(?:static\s+)?([\w.]+?)(?:\.\*|\.[A-Z]\w*)*\s*;?$/gm)) {
        const dir = packageDirs.get(match[1]!);
        if (dir === undefined) continue;
        const className = /\.([A-Z]\w*)/.exec(match[0])?.[1];
        const files = filesIn(dir).filter((file) => className === undefined || posix.basename(file).startsWith(`${className}.`));
        for (const file of files) found.add(file);
      }
    } else if (extension === "rs") {
      for (const match of text.matchAll(/\buse\s+crate::(\w+)/g)) {
        const srcDir = path.includes("/") ? path.slice(0, path.indexOf("/")) : ".";
        for (const candidate of [posix.join(srcDir, `${match[1]}.rs`), posix.join(srcDir, match[1]!, "mod.rs")]) if (all.has(candidate)) found.add(candidate);
      }
    }
    return [...found].sort();
  };
}

/** Whether the map has a file or folder at a path - `.` being the whole codebase. */
export function existsInMap(map: CodeMap, path: string): boolean {
  if (path === "." || path === "") return true;
  return map.files.some((file) => file.path === path || file.path.startsWith(`${path}/`));
}

/** Whether a folder named on the codebase's disk is there - for paths an agent gives that the map leaves out. */
export function existsOnDisk(map: CodeMap, path: string): boolean {
  return existsSync(join(map.root, ...path.split("/")));
}
