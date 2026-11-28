// Develop against an unpublished core without changing either checkout's manifest or lockfile.
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const core = realpathSync(resolve(root, process.argv[2] ?? "../turri-core"));
const pkg = JSON.parse(readFileSync(join(core, "package.json"), "utf8"));
if (pkg.name !== "@turri-dev/core" || !pkg.exports["./project"]) throw new Error(`Expected a core clone with the entries by domain (@turri-dev/core/project) at ${core}`);
// Use the clone's installed pi and pi-tui here too: both packages patch/read these exact classes.
const peers = ["pi-coding-agent", "pi-tui"].map((name) => realpathSync(join(core, "node_modules", "@earendil-works", name)));
execFileSync(process.execPath, [process.env.npm_execpath, "install", "--no-save", "--package-lock=false", "--install-links=false", core, ...peers], { cwd: root, stdio: "inherit" });
console.log("Core linked. Start the CLI with NODE_OPTIONS=--conditions=turri-source to run both checkouts unbuilt.");
