// Exercise the published CLI and the old desktop import from outside either checkout.
// Before core is published, pass its checkout to install a local tarball of the same version instead.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = process.cwd();
const dir = mkdtempSync(join(tmpdir(), "turri-packed-cli-"));
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
const npm = (cwd, ...args) => execFileSync(process.execPath, [process.env.npm_execpath, ...args], { cwd, encoding: "utf8" });
const pack = (cwd) => JSON.parse(npm(cwd, "pack", "--json", "--pack-destination", dir))[0];
try {
  const consumer = { name: "cli-consumer", version: "0.0.0", private: true, type: "module", dependencies: {} };
  // Keep the CLI's tested resolutions, replacing just the packages we build here.
  const local = (archive, deps) => {
    const { name, filename, integrity, version } = archive;
    const resolved = `file:./${filename}`;
    consumer.dependencies[name] = resolved;
    lock.packages[`node_modules/${name}`] = { ...deps, version, resolved, integrity };
  };
  if (process.argv[2]) {
    const core = pack(resolve(process.argv[2]));
    assert.equal(core.name, "@turri-dev/core");
    assert.equal(core.version, pkg.dependencies[core.name]);
    local(core, lock.packages[`node_modules/${core.name}`]);
  }
  const cli = pack(root);
  const files = new Set(cli.files.map(({ path }) => path));
  for (const required of ["bin/turri.mjs", "dist/extension.js", "dist/cli.js", "dist/host.js", "dist/host.d.ts", ".pi/themes/turri-dark.json"]) assert.ok(files.has(required), required);
  for (const file of files) assert.doesNotMatch(file, /^(src|genome|stdlib)\/|^dist\/(plain\/|regenerate\/loop\.js)/);
  local(cli, { bin: pkg.bin, dependencies: pkg.dependencies, engines: pkg.engines });
  lock.name = consumer.name;
  lock.version = consumer.version;
  lock.packages[""] = consumer;
  writeFileSync(join(dir, "package.json"), JSON.stringify(consumer));
  writeFileSync(join(dir, "package-lock.json"), JSON.stringify(lock));
  npm(dir, "ci", "--prefer-offline", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund");

  // Node's plain import condition, no developer's provider credentials or project extensions.
  const home = join(dir, "home");
  mkdirSync(home);
  const env = { ...process.env, NODE_OPTIONS: "", HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: join(home, "agent"), TURRI_UPDATE_CHECK: "off", TURRI_LEDGER: "off", TMPDIR: home, TMP: home, TEMP: home };
  const node = (...args) => execFileSync(process.execPath, args, { cwd: dir, env, encoding: "utf8", timeout: 60_000 });
  const bin = join(dir, "node_modules", "@turri-dev", "cli", "bin", "turri.mjs");
  const run = (...args) => node(bin, ...args);
  writeFileSync(join(dir, "app.plain"), "---\nimport:\n  - stdlib/cli/go-cobra\n---\n\n***functional specs***\n\n# greet\nSay hello.\n");
  assert.ok(run("--version").includes(join(dir, "node_modules", "@turri-dev", "cli")));
  assert.ok(JSON.parse(run("parse", "app.plain", "--json"))[0].ok);
  assert.ok(run("drift", "app.plain").includes("app"));
  assert.match(run("regenerate", "--help"), /--dry-run/);
  assert.match(run("conform", "--help"), /--from-scratch/);
  assert.match(run("init-config", "--vendor=other"), /Wrote/);
  // Unknown models exercise the planner's deterministic fallback without contacting a provider.
  writeFileSync(join(dir, "config.turri.yaml"), "harness-model: missing/planner\ncoding-model: missing/coder\nunittests-script: run_unittests.sh\nsentinel: false\n");
  writeFileSync(join(dir, "run_unittests.sh"), "#!/bin/bash\nexit 0\n");
  const preview = run("regenerate", "app.plain", "--dry-run", "--report", "run.json", "--build-dir", "out");
  assert.match(preview, /planned, nothing started/);
  assert.match(preview, /<testing scripts>/);
  for (const path of ["run.json", "out"]) assert.equal(existsSync(join(dir, path)), false);

  copyFileSync(join(root, "tests", "packed-host.mts"), join(dir, "packed-host.mts"));
  node(resolve("node_modules/typescript/bin/tsc"), "--noEmit", "--strict", "--skipLibCheck", "--module", "NodeNext", "--target", "ES2023", "packed-host.mts");
  node("packed-host.mts");
  console.log("Packed CLI: command dispatch, core resources, declarations, desktop session and shared pi passed.");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
