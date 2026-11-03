import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newerThan, PACKAGE_NAME, removalOf, turrisOnPath, versionFindings } from "../src/turri-versions.ts";

// A machine with turris installed in several places, each an npm prefix - bin/turri linking into lib/node_modules - as
// a global install under each Node version is.
let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "turri-versions-")));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** turri `version` installed under the prefix `name`: its bin folder, for the PATH. */
function installed(name: string, version: string, options: { clone?: boolean } = {}): { bin: string; root: string } {
  const root = join(dir, name, "lib", "node_modules", "@turri-dev", "cli");
  mkdirSync(join(root, "bin"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: PACKAGE_NAME, version }));
  writeFileSync(join(root, "bin", "turri.mjs"), "#!/usr/bin/env node\n");
  chmodSync(join(root, "bin", "turri.mjs"), 0o755);
  if (options.clone === true) mkdirSync(join(root, ".git"));
  const bin = join(dir, name, "bin");
  mkdirSync(bin, { recursive: true });
  symlinkSync(join(root, "bin", "turri.mjs"), join(bin, "turri"));
  return { bin, root };
}

describe("turri's versions", () => {
  it("are compared by major, minor and patch - a release over its prereleases", () => {
    expect(newerThan("0.2.0", "0.1.27")).toBe(true);
    expect(newerThan("0.1.27", "0.2.0")).toBe(false);
    expect(newerThan("0.1.10", "0.1.9")).toBe(true);
    expect(newerThan("0.2.0", "0.2.0-next.abc")).toBe(true);
    expect(newerThan("0.1.28-next.abc", "0.1.27")).toBe(true);
    expect(newerThan("0.2.0", "0.2.0")).toBe(false);
  });
});

describe("the turris on the PATH", () => {
  it("are every one in the PATH's order, each with its version - the first the one that runs, and which is this one", () => {
    const old = installed("node-22", "0.1.24");
    const now = installed("node-24", "0.2.0");
    const found = turrisOnPath([old.bin, join(dir, "nothing-here"), now.bin].join(delimiter), now.root);
    expect(found.map((turri) => [turri.path, turri.version, turri.runs, turri.self])).toEqual([
      [join(old.bin, "turri"), "0.1.24", true, false],
      [join(now.bin, "turri"), "0.2.0", false, true],
    ]);
  });

  it("say an older one in front of a newer one: which hides which, each to take off the PATH, and how to run the newer one meanwhile", () => {
    const old = installed("node-22", "0.1.24");
    const now = installed("node-24", "0.2.0");
    const onPath = turrisOnPath([old.bin, now.bin].join(delimiter), old.root);
    // The old turri running - as the person who installed 0.2.0 and typed turri would have it.
    const [finding] = versionFindings({ onPath, self: { version: "0.1.24", clone: false, root: old.root } });
    expect(finding!.kind).toBe("shadowed");
    expect(finding!.text).toBe(`turri 0.2.0 is installed too, at ${join(now.bin, "turri")}, but this turri 0.1.24 comes first on your PATH - a bare \`turri\` runs the older one`);
    expect(finding!.short).toBe("turri 0.2.0 is installed, but this older turri 0.1.24 comes first on your PATH - turri doctor shows which, and how to fix it");
    expect(finding!.fixes[0]).toBe(`take ${join(old.bin, "turri")} (turri 0.1.24, this one) off the PATH: npm uninstall -g ${PACKAGE_NAME} --prefix ${join(dir, "node-22")}   (or delete ${join(old.bin, "turri")})`);
    expect(finding!.fixes).toContain("then `hash -r`, or a new terminal - the shell remembers where it last found turri");
    expect(finding!.fixes.at(-1)).toBe(`meanwhile, run the newer one by its path - ${join(now.bin, "turri")} - or npx ${PACKAGE_NAME}@latest`);
  });

  it("say when the newer one is run by its path while a bare turri runs an older one", () => {
    const old = installed("node-22", "0.1.24");
    const now = installed("node-24", "0.2.0");
    const onPath = turrisOnPath([old.bin, now.bin].join(delimiter), now.root);
    const findings = versionFindings({ onPath, self: { version: "0.2.0", clone: false, root: now.root } });
    expect(findings.map((finding) => finding.kind)).toEqual(["behind"]);
    expect(findings[0]!.short).toBe(`a bare turri runs an older turri, 0.1.24, from ${join(old.bin, "turri")} - turri doctor shows how to fix it`);
  });

  it("say nothing when the one that runs is the newest", () => {
    const now = installed("node-24", "0.2.0");
    const old = installed("node-22", "0.1.24");
    const onPath = turrisOnPath([now.bin, old.bin].join(delimiter), now.root);
    expect(versionFindings({ onPath, latest: "0.2.0", self: { version: "0.2.0", clone: false, root: now.root } })).toEqual([]);
  });

  it("say how each is taken off: by its nvm Node version, its linked clone, or its npm prefix", () => {
    expect(removalOf({ path: "/home/a/.nvm/versions/node/v22.19.0/bin/turri", clone: false, root: "/x" })).toBe(`nvm exec v22.19.0 npm uninstall -g ${PACKAGE_NAME}`);
    expect(removalOf({ path: "/usr/local/bin/turri", clone: true, root: "/home/a/turri" })).toBe(`npm unlink -g ${PACKAGE_NAME}   (it links a clone, /home/a/turri)`);
    expect(removalOf({ path: "/opt/old/bin/turri", clone: false, root: "/x" })).toBe(`npm uninstall -g ${PACKAGE_NAME} --prefix /opt/old   (or delete /opt/old/bin/turri)`);
  });
});

describe("a newer turri on npm", () => {
  it("is said, with the command that updates - and never to a turri run from a clone", () => {
    const now = installed("node-24", "0.2.0");
    const onPath = turrisOnPath(now.bin, now.root);
    const [finding] = versionFindings({ onPath, latest: "0.2.1", self: { version: "0.2.0", clone: false, root: now.root } });
    expect(finding).toMatchObject({ kind: "outdated", text: "turri 0.2.1 is out - this is turri 0.2.0", fixes: [`update: npm install -g ${PACKAGE_NAME}@latest`] });
    expect(finding!.short).toBe(`This turri, 0.2.0, is out of date: 0.2.1 is out. Upgrade: npm install -g ${PACKAGE_NAME}@latest`);
    expect(versionFindings({ onPath, latest: "0.2.1", self: { version: "0.1.1", clone: true, root: now.root } })).toEqual([]);
  });

  it("is not said when a newer turri than this is installed and only hidden: that is the finding, not an update", () => {
    const old = installed("node-22", "0.1.24");
    const now = installed("node-24", "0.2.0");
    const onPath = turrisOnPath([old.bin, now.bin].join(delimiter), old.root);
    expect(versionFindings({ onPath, latest: "0.2.0", self: { version: "0.1.24", clone: false, root: old.root } }).map((finding) => finding.kind)).toEqual(["shadowed"]);
  });
});

describe("the turris on the PATH on Windows", () => {
  /** turri `version` as npm installs it on Windows: three launchers in the prefix, the package beside them in node_modules. */
  function installedOnWindows(name: string, version: string): { prefix: string; root: string } {
    const prefix = join(dir, name);
    const root = join(prefix, "node_modules", "@turri-dev", "cli");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: PACKAGE_NAME, version }));
    for (const launcher of ["turri.cmd", "turri.ps1", "turri"]) writeFileSync(join(prefix, launcher), "@echo off\n");
    return { prefix, root };
  }

  it("are found through npm's launchers - one install once, though it has three - each with its version", () => {
    const old = installedOnWindows("nvm-v22", "0.1.24");
    const now = installedOnWindows("npm", "0.2.0");
    const found = turrisOnPath([old.prefix, now.prefix].join(delimiter), now.root, "win32");
    expect(found.map((turri) => [turri.path, turri.version, turri.runs, turri.self])).toEqual([
      [join(old.prefix, "turri.cmd"), "0.1.24", true, false],
      [join(now.prefix, "turri.cmd"), "0.2.0", false, true],
    ]);
  });

  it("are taken off with npm's prefix - the launchers' own folder - or under nvm for Windows by switching to its Node", () => {
    expect(removalOf({ path: "C:\\Users\\a\\AppData\\Roaming\\npm\\turri.cmd", clone: false, root: "x" }, "win32")).toBe(
      `npm uninstall -g ${PACKAGE_NAME} --prefix C:\\Users\\a\\AppData\\Roaming\\npm   (or delete C:\\Users\\a\\AppData\\Roaming\\npm\\turri.cmd)`,
    );
    expect(removalOf({ path: "C:\\Users\\a\\AppData\\Roaming\\nvm\\v22.19.0\\turri.cmd", clone: false, root: "x" }, "win32")).toBe(`nvm use v22.19.0, then npm uninstall -g ${PACKAGE_NAME}`);
  });
});
