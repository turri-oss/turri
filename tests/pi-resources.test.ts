import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader, getAgentDir } from "@earendil-works/pi-coding-agent";
import { quietBrandThemeOverrides } from "../src/pi-themes.ts";
import { CLI_ROOT } from "../src/cli-root.ts";

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "turri-resources-")));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

it("uses the project's brand themes quietly over the user's copies but reports a third-party clash", async () => {
  const agentDir = join(dir, "agent");
  const projectThemes = join(dir, ".pi", "themes");
  for (const folder of [projectThemes, join(agentDir, "themes")]) {
    mkdirSync(folder, { recursive: true });
    for (const name of ["turri-dark.json", "turri-light.json"]) copyFileSync(join(CLI_ROOT, ".pi", "themes", name), join(folder, name));
  }
  const other = join(dir, "third-party.json");
  copyFileSync(join(projectThemes, "turri-dark.json"), other);
  const pi = new DefaultResourceLoader({ cwd: dir, agentDir, noExtensions: true, additionalThemePaths: [other] });
  await pi.reload();
  const original = DefaultResourceLoader.prototype.getThemes;
  try {
    quietBrandThemeOverrides(dir, agentDir);
    const { themes, diagnostics } = pi.getThemes();
    expect(themes.map((theme) => theme.sourcePath).sort()).toEqual([join(projectThemes, "turri-dark.json"), join(projectThemes, "turri-light.json")]);
    expect(diagnostics.map((item) => item.collision?.loserPath)).toEqual([other]);
  } finally {
    DefaultResourceLoader.prototype.getThemes = original;
  }
});
