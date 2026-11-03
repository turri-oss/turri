import { accessSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, resolve, win32 } from "node:path";
import { AGENT_DIR, PACKAGE_ROOT, turriIdentity } from "./environment.ts";

/**
 * Which turri runs, which is newest, and which others are on this machine - so a person who installed a new turri and
 * is still running an old one is told so, and how to fix it, where they look: the banner as turri starts (from what the
 * last check found, never waiting on the network), and `turri --version` and `turri doctor` (asking npm then and there).
 * A turri run from a clone is the developer's: it is never told to update.
 */

export const PACKAGE_NAME = "@turri-dev/cli";
const INSTALL = `npm install -g ${PACKAGE_NAME}@latest`;
/** Where the newest version npm has is kept between starts. */
const CACHE = join(AGENT_DIR, "turri-latest.json");
/** How long what npm said is trusted before the banner asks again, in the background. */
const STALE_MS = 6 * 60 * 60 * 1000;

/** The check is off in turri's own tests, and when TURRI_UPDATE_CHECK=off. */
const checkOff = () => process.env.TURRI_UPDATE_CHECK === "off";

/** Whether version `a` is newer than `b`: major, minor, patch - and a release over a prerelease of the same. */
export function newerThan(a: string, b: string): boolean {
  const parse = (version: string) => {
    const [core = "", pre] = version.split("-", 2);
    return { parts: core.split(".").map((part) => Number.parseInt(part, 10) || 0), pre: pre !== undefined };
  };
  const [x, y] = [parse(a), parse(b)];
  for (let at = 0; at < 3; at += 1) {
    if ((x.parts[at] ?? 0) !== (y.parts[at] ?? 0)) return (x.parts[at] ?? 0) > (y.parts[at] ?? 0);
  }
  return !x.pre && y.pre;
}

/** The newest version npm had when it was last asked, and when - nothing when it never was. */
export function latestKnown(): { version: string; checkedAt: number } | undefined {
  try {
    const cached = JSON.parse(readFileSync(CACHE, "utf8")) as { version?: unknown; checkedAt?: unknown };
    return typeof cached.version === "string" && typeof cached.checkedAt === "number" ? { version: cached.version, checkedAt: cached.checkedAt } : undefined;
  } catch {
    return undefined;
  }
}

/** The newest version npm has now, kept for the next start - nothing when npm does not answer in time. */
export async function fetchLatest(timeoutMs = 3000): Promise<string | undefined> {
  if (checkOff()) return undefined;
  try {
    const response = await fetch(`https://registry.npmjs.org/${PACKAGE_NAME.replace("/", "%2F")}/latest`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return undefined;
    const version = ((await response.json()) as { version?: unknown }).version;
    if (typeof version !== "string") return undefined;
    try {
      mkdirSync(dirname(CACHE), { recursive: true });
      writeFileSync(CACHE, `${JSON.stringify({ version, checkedAt: Date.now() })}\n`);
    } catch {
      /* not kept: asked again next time */
    }
    return version;
  } catch {
    return undefined;
  }
}

/**
 * Ask npm again in the background when what it said last is old: what it says now, once it answers - undefined when it
 * was not asked, or did not answer. Never waited for by what starts turri.
 */
export function refreshLatestLater(): Promise<string | undefined> {
  if (checkOff()) return Promise.resolve(undefined);
  const known = latestKnown();
  if (known !== undefined && Date.now() - known.checkedAt < STALE_MS) return Promise.resolve(undefined);
  return fetchLatest().catch(() => undefined);
}

/** A turri on this machine's PATH. */
export interface TurriOnPath {
  /** The command, as the PATH has it. */
  path: string;
  /** The package it runs. */
  root: string;
  version?: string;
  /** Run from a clone - npm link, or a script pointing into one. */
  clone: boolean;
  /** The one a bare `turri` runs: the first on the PATH. */
  runs: boolean;
  /** The one running now. */
  self: boolean;
}

/** Whether a command is a link - npm's on macOS and Linux - rather than a launcher file. */
const isLink = (command: string) => {
  try {
    return lstatSync(command).isSymbolicLink();
  } catch {
    return false;
  }
};

/** The package a turri command runs: up from where it really is, to the folder whose package.json is turri's. */
function packageOf(command: string): string | undefined {
  // Beside its command, where npm puts it when the command is a launcher rather than a link: <prefix>/node_modules on
  // Windows, <prefix>/lib/node_modules elsewhere.
  for (const beside of [join(dirname(command), "node_modules", "@turri-dev", "cli"), join(dirname(command), "..", "lib", "node_modules", "@turri-dev", "cli")]) {
    try {
      if ((JSON.parse(readFileSync(join(beside, "package.json"), "utf8")) as { name?: unknown }).name === PACKAGE_NAME && !isLink(command)) return resolve(beside);
    } catch {
      /* not there */
    }
  }
  let dir: string;
  try {
    dir = dirname(realpathSync(command));
  } catch {
    return undefined;
  }
  for (let at = 0; at < 6; at += 1) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: unknown };
      if (pkg.name === PACKAGE_NAME) return dir;
    } catch {
      /* not here: up */
    }
    const up = dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
  return undefined;
}

/** Every turri on the PATH, in its order - the first is what a bare `turri` runs. */
export function turrisOnPath(path: string = process.env.PATH ?? "", self: string = PACKAGE_ROOT, platform: NodeJS.Platform = process.platform): TurriOnPath[] {
  // On Windows npm writes three launchers for one install - turri.cmd, turri.ps1, turri - side by side: one is taken.
  const names = platform === "win32" ? ["turri.cmd", "turri.ps1", "turri"] : ["turri"];
  const found: TurriOnPath[] = [];
  const seen = new Set<string>();
  for (const dir of path.split(delimiter).filter((entry) => entry !== "")) {
    for (const name of names) {
      const command = join(dir, name);
      if (seen.has(command)) continue;
      try {
        if (!statSync(command).isFile()) continue;
        // Windows has no execute bit: a launcher there is a file.
        if (platform !== "win32") accessSync(command, constants.X_OK);
      } catch {
        continue;
      }
      seen.add(command);
      const root = packageOf(command);
      if (root === undefined) continue;
      if (platform === "win32" && found.some((turri) => dirname(turri.path) === dir)) continue;
      let version: string | undefined;
      try {
        version = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: string }).version;
      } catch {
        version = undefined;
      }
      found.push({ path: command, root, ...(version !== undefined ? { version } : {}), clone: existsSync(join(root, ".git")), runs: found.length === 0, self: resolve(root) === resolve(self) });
    }
  }
  return found;
}

/** How to take a turri off the PATH, by where it is: another Node version of nvm, a linked clone, or an npm prefix. */
export function removalOf(turri: Pick<TurriOnPath, "path" | "clone" | "root">, platform: NodeJS.Platform = process.platform): string {
  const nvm = /[/\\]\.nvm[/\\]versions[/\\]node[/\\](v[^/\\]+)[/\\]bin[/\\]turri/.exec(turri.path);
  if (nvm !== null) return `nvm exec ${nvm[1]} npm uninstall -g ${PACKAGE_NAME}`;
  // nvm for Windows keeps each Node version in a folder of its own: switched to it, npm uninstalls from there.
  const nvmWindows = /[/\\]nvm[/\\](v?\d+\.\d+\.\d+)[/\\]turri/i.exec(turri.path);
  if (nvmWindows !== null) return `nvm use ${nvmWindows[1]}, then npm uninstall -g ${PACKAGE_NAME}`;
  if (turri.clone) return `npm unlink -g ${PACKAGE_NAME}   (it links a clone, ${turri.root})`;
  // npm's prefix: the launcher's own folder on Windows, the folder above bin elsewhere.
  const prefix = platform === "win32" ? win32.dirname(turri.path) : dirname(dirname(turri.path));
  return `npm uninstall -g ${PACKAGE_NAME} --prefix ${prefix}   (or delete ${turri.path})`;
}

/** What is wrong with the turri running, and what to do: each a line, with its fixes. */
export interface VersionFinding {
  /** Updating is all it needs. */
  kind: "outdated" | "shadowed" | "behind";
  text: string;
  /** The same, as the banner says it in a line: what is newer, and what to run. */
  short: string;
  fixes: string[];
}

/**
 * What the turri running, the newest npm has (`latest`, when known) and the turris on the PATH say together: nothing when
 * all is well. A turri from a clone is told nothing of npm's.
 */
export function versionFindings(options: { latest?: string; onPath?: TurriOnPath[]; self?: { version?: string; clone: boolean; root: string } } = {}): VersionFinding[] {
  const identity = options.self ?? (() => {
    const own = turriIdentity();
    return { ...(own.version !== null ? { version: own.version } : {}), clone: own.git_commit !== null, root: PACKAGE_ROOT };
  })();
  const onPath = options.onPath ?? turrisOnPath();
  const findings: VersionFinding[] = [];
  // A newer turri installed than the one running, behind it on the PATH: the person installed it, and runs the old one.
  const newest = onPath.filter((turri) => !turri.clone && turri.version !== undefined).sort((a, b) => (newerThan(a.version!, b.version!) ? -1 : 1))[0];
  const runs = onPath.find((turri) => turri.runs);
  if (!identity.clone && identity.version !== undefined && newest !== undefined && newest.version !== undefined && newerThan(newest.version, identity.version) && !newest.self) {
    // Every turri in front of the newest one: a bare `turri` finds each before it.
    const inFront = onPath.slice(0, onPath.indexOf(newest));
    findings.push({
      kind: "shadowed",
      text: `turri ${newest.version} is installed too, at ${newest.path}, but ${runs?.self === true ? `this turri ${identity.version} comes first on your PATH` : `turri ${runs?.version ?? identity.version} comes before it on your PATH`} - a bare \`turri\` runs the older one`,
      short: `turri ${newest.version} is installed, but this older turri ${identity.version} comes first on your PATH - turri doctor shows which, and how to fix it`,
      fixes: [
        ...inFront.map((turri) => `take ${turri.path} (turri ${turri.version ?? "?"}${turri.self ? ", this one" : ""}) off the PATH: ${removalOf(turri)}`),
        process.platform === "win32" ? "then open a new terminal" : "then `hash -r`, or a new terminal - the shell remembers where it last found turri",
        `meanwhile, run the newer one by its path - ${newest.path} - or npx ${PACKAGE_NAME}@latest`,
      ],
    });
  }
  // A newer turri on npm than the newest here.
  const here = newest?.version !== undefined && identity.version !== undefined && newerThan(newest.version, identity.version) ? newest.version : identity.version;
  if (!identity.clone && options.latest !== undefined && here !== undefined && newerThan(options.latest, here)) {
    findings.push({ kind: "outdated", text: `turri ${options.latest} is out - this is turri ${identity.version}`, short: `This turri, ${identity.version}, is out of date: ${options.latest} is out. Upgrade: ${INSTALL}`, fixes: [`update: ${INSTALL}`] });
  }
  // The turri a bare `turri` runs is not this one, and older: it is run by its whole path, the old one in front.
  if (runs !== undefined && !runs.self && !runs.clone && runs.version !== undefined && identity.version !== undefined && newerThan(identity.version, runs.version) && findings.every((finding) => finding.kind !== "shadowed")) {
    findings.push({
      kind: "behind",
      text: `a bare \`turri\` runs ${runs.path}, turri ${runs.version} - older than this turri ${identity.version}`,
      short: `a bare turri runs an older turri, ${runs.version}, from ${runs.path} - turri doctor shows how to fix it`,
      fixes: [`take it off the PATH: ${removalOf(runs)}`, process.platform === "win32" ? "then open a new terminal" : "then `hash -r`, or a new terminal"],
    });
  }
  return findings;
}

/** `turri --version`: the version line, then where this turri is, what npm has - asked now - and every turri on the PATH. */
export async function describeVersion(versionLine: string): Promise<string> {
  const own = turriIdentity();
  const onPath = turrisOnPath();
  const latest = own.git_commit === null ? await fetchLatest() : undefined;
  const lines = [versionLine, `  this turri:      ${PACKAGE_ROOT}`];
  if (own.git_commit === null) {
    lines.push(
      latest === undefined
        ? "  newest on npm:   not known - npm did not answer"
        : `  newest on npm:   ${latest}${own.version !== null && !newerThan(latest, own.version) ? " - this is it" : ""}`,
    );
  }
  if (onPath.length > 0) {
    lines.push("  turri on PATH:");
    for (const turri of onPath) {
      const marks = [turri.runs ? "runs" : "hidden", ...(turri.self ? ["this one"] : []), ...(turri.clone ? ["a clone"] : [])].join(", ");
      lines.push(`    ${turri.path}  turri ${turri.version ?? "?"}  (${marks})`);
    }
  } else {
    lines.push("  turri on PATH:   none - this one was run by its path");
  }
  const findings = versionFindings({ ...(latest !== undefined ? { latest } : {}), onPath, self: { ...(own.version !== null ? { version: own.version } : {}), clone: own.git_commit !== null, root: PACKAGE_ROOT } });
  for (const finding of findings) lines.push("", `! ${finding.text}`, ...finding.fixes.map((fix) => `  → ${fix}`));
  return lines.join("\n");
}

/**
 * What the banner says as turri starts: a line a finding, short - what is newer and what to run - from what npm said at
 * the last check and the turris on the PATH, never waiting on the network; the check for next time started behind it.
 */
export function bannerWarnings(): { lines: string[]; later: Promise<string | undefined> } {
  if (checkOff()) return { lines: [], later: Promise.resolve(undefined) };
  let findings: VersionFinding[];
  try {
    const latest = latestKnown()?.version;
    findings = versionFindings(latest !== undefined ? { latest } : {});
  } catch {
    findings = [];
  }
  const lines = findings.map((finding) => finding.short);
  // What npm says now, once it answers: a turri newer than the banner knew of is said then, in the same chat.
  const later = refreshLatestLater().then((latest) => {
    if (latest === undefined) return undefined;
    try {
      const outdated = versionFindings({ latest }).find((finding) => finding.kind === "outdated");
      return outdated !== undefined && !lines.includes(outdated.short) ? outdated.short : undefined;
    } catch {
      return undefined;
    }
  });
  return { lines, later };
}
