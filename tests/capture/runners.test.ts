import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readProjectConfig } from "../../src/config.ts";
import { buildMap } from "../../src/capture/map.ts";
import { reuseRunner, runnerChoices } from "../../src/capture/runners.ts";
import type { Part } from "../../src/capture/state.ts";

let root: string;
let plain: string;
const part: Part = { name: "app", about: "CLI", paths: ["."], implementationReqs: [], testReqs: [], definitions: [], runners: runnerChoices({ unit: "pytest", conformance: "bats", build_dir_env: "APP_DIR", python_env: "PYTHON" }) };
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "turri-runners-"));
  plain = join(root, "plain");
  mkdirSync(plain);
  for (const [file, text] of Object.entries({ "app.py": "print(1)", "requirements.txt": "pytest", "test_app.py": "def test_app(): pass", "cli.bats": '@test "works" { true; }' })) writeFileSync(join(root, file), text);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("capture's reusable runners", () => {
  it("registers independent pytest and Bats runners and preserves the project's invocation variables", () => {
    const map = buildMap(root);
    const namedFiles = { ...part, paths: ["app.py", "test_app.py", "cli.bats"] };
    expect(reuseRunner(plain, map, namedFiles, "unit")).toHaveProperty("written", "test_scripts/run_unittests_python.sh");
    expect(reuseRunner(plain, map, namedFiles, "conformance")).toHaveProperty("written", "test_scripts/run_conformance_tests_bats.sh");
    const config = readProjectConfig(plain);
    expect(config.unittestsScript).toBe("test_scripts/run_unittests_python.sh");
    expect(readFileSync(join(plain, config.conformanceTestsScript!), "utf8")).toContain("mode='bats'; build_var='APP_DIR'; python_var='PYTHON'");
  });

  it("leaves unselected, unsupported and ambiguous setups to the writer", () => {
    expect(reuseRunner(plain, buildMap(root), { ...part, runners: runnerChoices({ conformance: "bats", python_env: "a; exit 0" }) }, "conformance")).toBeUndefined();
    expect(reuseRunner(plain, buildMap(root), { ...part, runners: undefined }, "unit")).toBeUndefined();
    writeFileSync(join(root, "pyproject.toml"), "[tool.pytest.ini_options]\n");
    expect(reuseRunner(plain, buildMap(root), part, "unit")).toBeUndefined();
    expect(existsSync(join(plain, "test_scripts"))).toBe(false);
  });

  it("installs a selected PEP 621 project with its console scripts and uses the manifest's black/isort/flake8 checkers", () => {
    writeFileSync(join(root, "pyproject.toml"), '[build-system]\nbuild-backend = "hatchling.build"\n[project]\nname = "example"\n[project.optional-dependencies]\ndev = ["pytest", "black", "isort", "flake8", "mypy"]\n[tool.black]\nline-length = 100\n[tool.isort]\nprofile = "black"\n');
    const result = reuseRunner(plain, buildMap(root), { ...part, runners: { conformance: "pytest" } }, "conformance");
    expect(result).toHaveProperty("written");
    const body = readFileSync(join(plain, "test_scripts/run_conformance_tests_pytest.sh"), "utf8");
    expect(body).toContain("'.[dev]'");
    expect(body).toContain("if [[ 'black' == black ]]");
    expect(body).not.toMatch(/@(?:MODE|CHECKS|INSTALL|EXTRA)@/);
  });
});
