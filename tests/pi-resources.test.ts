import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader, getAgentDir } from "@earendil-works/pi-coding-agent";
import { subAgentResources } from "../src/pi.ts";
import { quietBrandThemeOverrides } from "../src/pi-themes.ts";
import { PACKAGE_ROOT } from "../src/environment.ts";

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "turri-resources-")));
  // A skill of the project's, where pi looks for one.
  mkdirSync(join(dir, ".pi", "skills", "deploy-it"), { recursive: true });
  writeFileSync(join(dir, ".pi", "skills", "deploy-it", "SKILL.md"), "---\nname: deploy-it\ndescription: Deploy the app to production.\n---\n\nDeploy it.\n");
  writeFileSync(join(dir, "AGENTS.md"), "This project deploys on Fridays.\n");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

it("uses the project's brand themes quietly over the user's copies but reports a third-party clash", async () => {
  const agentDir = join(dir, "agent");
  const projectThemes = join(dir, ".pi", "themes");
  for (const folder of [projectThemes, join(agentDir, "themes")]) {
    mkdirSync(folder, { recursive: true });
    for (const name of ["turri-dark.json", "turri-light.json"]) copyFileSync(join(PACKAGE_ROOT, ".pi", "themes", name), join(folder, name));
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

describe("what an agent turri starts is given of pi's resources", () => {
  it("is none of pi's skills and none of the project's context files - which pi would give the conversation", async () => {
    const pi = new DefaultResourceLoader({ cwd: dir, agentDir: getAgentDir(), noExtensions: true });
    await pi.reload();
    expect(pi.getSkills().skills.map((skill) => skill.name)).toContain("deploy-it");

    const agent = await subAgentResources(dir, false);
    expect(agent.getSkills().skills).toEqual([]);
    expect(JSON.stringify(agent.getAgentsFiles?.() ?? [])).not.toContain("deploys on Fridays");
  });
});
