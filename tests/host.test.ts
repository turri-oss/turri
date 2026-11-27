import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("publishes the host entry, compiled, as @turri-dev/cli/host", () => {
  const manifest = JSON.parse(readFileSync("package.json", "utf8"));
  expect(manifest.exports["./host"]).toEqual({ "turri-source": "./src/host.ts", types: "./dist/host.d.ts", import: "./dist/host.js" });
});
