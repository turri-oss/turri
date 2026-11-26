import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import { PACKAGE_ROOT } from "../environment.ts";
import { writeSetting } from "../config-edit.ts";
import { filesOf } from "./area.ts";
import type { CodeMap } from "./map.ts";
import type { Part, ScriptOutcome } from "./state.ts";
import type { ScriptKind } from "../regenerate/test-scripts.ts";

/** These substitutions are identifiers, never shell code. Keep the runner's own environment out of reach. */
function binding(value: unknown): value is string | undefined {
  return value === undefined || (typeof value === "string" && /^(?:PYTHON|[A-Z][A-Z0-9_]*_(?:DIR|ROOT|FOLDER|PYTHON|INTERPRETER))$/.test(value) && !/^(?:BASH|TMP|LD_|DYLD_|BATS_|GIT_|PYTHON[A-Z_])/.test(value));
}

export function runnerChoices(value: unknown): Part["runners"] {
  if (value === null || typeof value !== "object") return undefined;
  const { unit, conformance, build_dir_env, python_env } = value as Record<string, unknown>;
  const buildDirEnv = build_dir_env === "" ? undefined : build_dir_env;
  const pythonEnv = python_env === "" ? undefined : python_env;
  const runners: NonNullable<Part["runners"]> = {};
  if (unit === "pytest") runners.unit = unit;
  if ((conformance === "bats" || conformance === "pytest") && binding(buildDirEnv) && binding(pythonEnv) && (!buildDirEnv || buildDirEnv !== pythonEnv)) {
    Object.assign(runners, { conformance, buildDirEnv, pythonEnv });
  }
  return runners;
}

/** A surveyed match plus evidence on disk. Anything else uses the normal script-writing skill. */
export function reuseRunner(plainDir: string, map: CodeMap, part: Part, kind: ScriptKind, configModule?: string): ScriptOutcome | undefined {
  const choice = part.runners?.[kind];
  if (!choice || configModule) return undefined;
  const files = filesOf(map, part.paths);
  // The survey can list a single part's packages rather than ".". Its dependency manifest still belongs to the root.
  const pyproject = map.files.some(f => f.path === "pyproject.toml");
  const manifest = pyproject ? readFileSync(join(map.root, "pyproject.toml"), "utf8") : "";
  // A standard pip-installable PEP 621 package with pytest, no custom build/test plugins. A pytest.ini in the
  // *external* suite only sets discovery for that suite and does not change the package installation.
  const packaged = pyproject && choice === "pytest" && /^\[project\]\s*$/m.test(manifest) && /^\[build-system\]\s*$/m.test(manifest) && /^build-backend\s*=\s*["'](?:hatchling\.build|setuptools\.build_meta|flit_core\.buildapi)["']/m.test(manifest) && !/^(?:backend-path|addopts|required_plugins|dynamic)\s*=/m.test(manifest);
  if (pyproject ? !packaged : !map.files.some((f) => f.path === "requirements.txt")) return undefined;
  if (map.files.some((f) => /^(?:setup\.(?:cfg|py)|tox\.ini|pytest\.ini|Pipfile|environment\.ya?ml)$/.test(f.path))) return undefined;
  if (choice === "bats" ? !files.some((f) => f.path.endsWith(".bats")) : !files.some((f) => f.kind === "test" && f.path.endsWith(".py"))) return undefined;
  const name = kind === "unit" ? "run_unittests_python.sh" : `run_conformance_tests_${choice}.sh`;
  const relative = posix.join("test_scripts", name);
  const dest = join(plainDir, "test_scripts", name);
  if (existsSync(dest)) return undefined;
  const template = readFileSync(join(PACKAGE_ROOT, "genome", "capture", "runners", "python-requirements.sh"), "utf8");
  const { buildDirEnv, pythonEnv } = part.runners!;
  if (!binding(buildDirEnv) || !binding(pythonEnv)) return undefined;
  const dev = manifest.split(/^\[project\.optional-dependencies\][ \t]*$/m)[1]?.split(/^\[/m)[0] ?? "";
  const packageExtra = packaged && /^dev\s*=/m.test(dev) ? ".[dev]" : ".";
  const black = packaged && /^\[tool\.black\]/m.test(manifest) && /^\[tool\.isort\]/m.test(manifest) && ["black", "flake8", "isort", "mypy"].every(tool => dev.includes(`"${tool}`));
  const body = template.replace("@MODE@", kind === "unit" ? "unit" : choice).replace("@BUILD_VAR@", buildDirEnv ?? "").replace("@PYTHON_VAR@", pythonEnv ?? "").replace("@INSTALL@", packaged ? "package" : "requirements").replace("@EXTRA@", packageExtra).replaceAll("@CHECKS@", black ? "black" : "ruff");
  mkdirSync(join(plainDir, "test_scripts"), { recursive: true });
  writeFileSync(dest, body, { mode: 0o755, flag: "wx" });
  writeSetting(plainDir, kind === "unit" ? "unittests-script" : "conformance-tests-script", relative);
  return { written: relative, finding: `Reused the Python ${packaged ? "pyproject.toml" : "requirements.txt"} / ${choice} runner.` };
}
