import { defineConfig } from "vitest/config";

export default defineConfig({
  // Vite resolves workspace links itself. Honour the same opt-in as Node, including in a test's child processes.
  ...(process.execArgv.includes("--conditions=turri-source") || process.env.NODE_OPTIONS?.includes("--conditions=turri-source")
    ? { ssr: { resolve: { conditions: ["turri-source", "node", "module", "development|production"] } } } : {}),
  test: {
    include: ["tests/**/*.test.ts"],
    // Some CLI tests start several separate Node processes.
    testTimeout: 60_000,
    setupFiles: ["tests/setup.ts"],
  },
});
