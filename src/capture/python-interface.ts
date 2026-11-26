import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { PACKAGE_ROOT } from "../environment.ts";
import type { CodeMap } from "./map.ts";
import { filesOf } from "./area.ts";

/** Literal import names, callable signatures and result fields, taken from syntax without importing the original. */
export function pythonInterface(map: CodeMap, paths: string[]): string | undefined {
  const files = filesOf(map, paths).filter(f => f.path.endsWith(".py"));
  if (!files.some(f => f.path.endsWith("/__init__.py"))) return undefined;
  const script = join(PACKAGE_ROOT, "genome", "capture", "python-interface.py");
  for (const bin of ["python3", "python"]) {
    const result = spawnSync(bin, ["-I", "-S", script], { cwd: map.root, input: JSON.stringify(files.map(f => f.path)), encoding: "utf8", timeout: 15000, maxBuffer: 2 * 1024 * 1024 });
    if (result.status === 0) return result.stdout.trim() || undefined;
  }
  return undefined;
}
