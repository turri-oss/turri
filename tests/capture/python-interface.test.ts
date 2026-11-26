import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { writeCodebase } from "./fixture.ts";
import { buildMap } from "../../src/capture/map.ts";
import { pythonInterface } from "../../src/capture/python-interface.ts";

it.runIf(spawnSync("python3", ["-V"]).status === 0)("preserves explicit re-exports, tested submodule calls and result fields without importing the project", () => {
  const root = writeCodebase({
    "src/tiny/__init__.py": 'open("IMPORTED", "w").close()\nfrom .api import get as fetch\n__all__ = ["fetch"]\n',
    "src/tiny/api.py": 'from dataclasses import dataclass\n@dataclass\nclass Result:\n    value: int\n    @property\n    def number(self) -> int: return self.value\ndef get(key: str, *, limit: int = 2) -> Result: pass\ndef other() -> bool: pass\ndef internal(): pass\n',
    "tests/__init__.py": "",
    "tests/test_api.py": 'from tiny import api\ndef test_result(): assert api.other()\n',
  });
  try {
    const text = pythonInterface(buildMap(root), ["."]);
    expect(text).toContain("tiny.fetch(key: str, *, limit: int=2) -> Result");
    expect(text).toContain("tiny.api.other() -> bool");
    expect(text).toContain("tiny.api.Result - fields: value: int");
    expect(text).toContain("tiny.api.Result.number (property) -> int");
    expect(text).not.toContain("internal");
    expect(existsSync(join(root, "IMPORTED"))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
