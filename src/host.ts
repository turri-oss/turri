/**
 * turri for a host that runs it itself - a desktop app, an editor - imported as `@turri-dev/cli/host`: the
 * conversation as pi's extension, with the host told of its jobs and asking its questions (createTurriExtension), and
 * what a host shows beside it - a spec parsed, checked and coloured, how far each functional spec is built, the work a
 * spec change would plan. It is turri's own code, as the terminal runs it; a 0.x release may change any of it.
 */

// The conversation.
export { createTurriExtension, type TurriHost } from "./extension.ts";
export type { AskUserIO } from "./ask.ts";
/** pi itself, as turri's extension is built against it: a host makes its session with this one, not another copy. */
export * as pi from "@earendil-works/pi-coding-agent";

// The project and its settings.
export { configForSpec, debugMode, hasProjectConfig, modelSpec, projectModels, readProjectConfig, stacksOf, type ProjectConfig } from "./config.ts";
export { MODULES_DIR, projectDirOf, resolveTemplateDirs } from "./regenerate/paths.ts";
// A project's first config.turri.yaml, as `turri init-config` writes it - the vendor whose models it takes chosen by the host.
export { BEDROCK_DEFAULT, BEDROCK_REGIONS, bedrockModels, initConfig, VENDORS, type BedrockChoice, type Vendor } from "./init-config.ts";

// A spec: parsed, checked, coloured.
export { checkPlainFile, type CheckResult } from "./plain/check.ts";
export { plainFileParser } from "./plain/parser.ts";
export { FUNCTIONAL_REQUIREMENTS, iterateFunctionalSpecs } from "./plain/spec.ts";
export { highlightLines, roleOf, type PlainRole } from "./plain/highlight.ts";

// The work: what is built, what is left, and the jobs that build it.
export { createWorkLoop, describeModules, functionalityCompletion, promptOf, type DriftReport, type ModuleStatus, type WorkLoop } from "./regenerate/loop.ts";
export { createJobRegistry, defaultParallelJobs, type Job, type JobRegistry } from "./regenerate/jobs.ts";
export { describeTurnIncident, onModelEvent, type TranscriptEntry } from "./regenerate/activity.ts";
export { sweepOrphanedGroups } from "./regenerate/shell.ts";

// What turri did, as facts: the ledger, heard live and read back - this session's pulses and every earlier one's.
export { ledgerDir, onLedgerEvent, readLedger, type AgentRef, type LedgerEntry, type LedgerEvent, type LedgerKind, type LedgerQuery } from "./regenerate/ledger.ts";
export { asJob, describePulseView, describeRuns, earlierPulses, ledgerProjects, pulseView, runViews, type PulseView, type RunView } from "./regenerate/ledger-view.ts";
