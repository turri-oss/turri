// No test waits out a provider that is failing: the harness retries at once.
process.env.TURRI_PROVIDER_RETRY_DELAY ??= "0";
// Nor does a test that loads the conversation or a headless run write a ledger into the folder it runs from: the
// ledger's own tests start it themselves.
process.env.TURRI_LEDGER ??= "off";
import { afterAll } from "vitest";
import { killAllGroups } from "../src/regenerate/shell.ts";

// Whatever a test file's commands left running on this machine is killed when it finishes: a worker is ended by a
// signal, and what it started would otherwise outlive it.
afterAll(() => {
  killAllGroups();
});
