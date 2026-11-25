import { join, relative } from "node:path";
import { DefaultResourceLoader, getAgentDir, type ResourceDiagnostic } from "@earendil-works/pi-coding-agent";
import { PACKAGE_ROOT, themeFiles } from "./environment.ts";

/** pi already picks the project's theme over the user's, then turri's bundled fallback. In the chat these copies
 * of a brand theme are expected; a broken file or a clash with a theme from elsewhere is still worth showing. */
export function quietBrandThemeOverrides(cwd = process.cwd(), agentDir = getAgentDir()): void {
  const directories = [join(cwd, ".pi", "themes"), join(agentDir, "themes"), join(PACKAGE_ROOT, ".pi", "themes")];
  const files = new Set(themeFiles());
  const expected = ({ type, collision }: ResourceDiagnostic) => {
    if (type !== "collision" || collision?.resourceType !== "theme") return false;
    const file = `${collision.name}.json`;
    const isCopy = (path: string) => directories.some((dir) => relative(dir, path) === file);
    return files.has(file) && isCopy(collision.winnerPath) && isCopy(collision.loserPath);
  };
  const getThemes = DefaultResourceLoader.prototype.getThemes;
  DefaultResourceLoader.prototype.getThemes = function () {
    const { themes, diagnostics } = getThemes.call(this);
    return { themes, diagnostics: diagnostics.filter((item) => !expected(item)) };
  };
}
