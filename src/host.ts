/**
 * turri for a host that runs it itself - a desktop app, an editor - imported as `@turri-dev/cli/host`: the session and
 * its chats, with the host told of its jobs and asking its questions (createTurri), and
 * what a host shows beside it - a spec parsed, checked and coloured, its concepts and links, the standard library, how
 * far each functional spec is built, the work a spec change would plan. It is turri's own code, as the terminal runs it; a 0.x release may change any of it.
 */

// The session and its chats.
export { createTurri, type Turri, type TurriOptions } from "./host-session.ts";
export { MAX_CHATS, type ChatInfo, type ChatStatus, type TurriHost } from "./chats.ts";
export type { AskUserIO } from "./ask.ts";
/** pi itself, as turri is built against it: a host's own extensions and UI are made with this one, not another copy. */
export * as pi from "@earendil-works/pi-coding-agent";

// The project and its settings.
export { configForSpec, debugMode, hasProjectConfig, modelSpec, projectModels, readProjectConfig, stacksOf, type ProjectConfig } from "./config.ts";
export { MODULES_DIR, projectDirOf, resolveTemplateDirs } from "./regenerate/paths.ts";
// Every setting of config.turri.yaml as /turri-config knows it - what it takes, what it is unset, when a change takes
// effect - and what the file has now: for a host that shows them all, changing each through /turri-config.
export { configSettings, currentValue, EFFECT_TEXT, overriddenBy, readConfigText, type Effect, type Setting, type SettingKind } from "./config-edit.ts";
// A project's first config.turri.yaml, as `turri init-config` writes it - the vendor, or the two models themselves, chosen by the host.
export {
  BEDROCK_DEFAULT,
  BEDROCK_GEOGRAPHIES,
  BEDROCK_IN_REGION,
  BEDROCK_REGIONS,
  bedrockAwsRegion,
  bedrockDefaultModels,
  bedrockMakers,
  bedrockModels,
  bedrockModelsIn,
  bedrockNeedsAwsRegion,
  bedrockPlaceOf,
  initConfig,
  makerLabel,
  VENDORS,
  type BedrockChoice,
  type BedrockMaker,
  type BedrockOffer,
  type InitConfigOptions,
  type ModelChoice,
  type ModelSet,
  type Vendor,
} from "./init-config.ts";
// pi's model catalogue, read without a request: what initConfig checks the models given against, and what a host offers.
export { piModelCatalogue, type CatalogueModel, type ModelCatalogue } from "./model-check.ts";

// Whether this machine, and a project on it, is ready for turri - as `turri doctor` checks it, printing nothing.
export { doctor, type Check, type DoctorOptions, type Level } from "./setup.ts";

// A spec: parsed, checked, coloured.
export { checkPlainFile, type CheckResult } from "./plain/check.ts";
export { plainFileParser } from "./plain/parser.ts";
export { FUNCTIONAL_REQUIREMENTS, iterateFunctionalSpecs } from "./plain/spec.ts";
export { highlightLines, roleOf, type PlainRole } from "./plain/highlight.ts";
// Its concepts: those a module can name, with what each is and where it is defined, and those written in a piece of text.
export { conceptsOf, type ModuleConcept } from "./plain/module-concepts.ts";
export { conceptBeingTyped, findConcepts } from "./plain/concepts.ts";
// A project's ***plain as a graph: its modules and their links both ways, each item of their sections, the concepts
// each names and where each is defined.
export { plainGraph, type PlainConceptNode, type PlainGraph, type PlainItemNode, type PlainLink, type PlainModuleNode, type PlainSection } from "./plain/graph.ts";
// The standard library: every template, what it is, what it imports, and its conformance template or stack.
export { isStack, STDLIB_KINDS, stdlibTemplates, type StdlibKind, type StdlibTemplate } from "./stdlib.ts";

// The work: what is built, what is left, and the jobs that build it.
export { createWorkLoop, describeModules, functionalityCompletion, promptOf, type DriftReport, type ModuleStatus, type WorkLoop } from "./regenerate/loop.ts";
export { createJobRegistry, defaultParallelJobs, type Job, type JobRegistry } from "./regenerate/jobs.ts";
export { describeTurnIncident, onModelEvent, type TranscriptEntry } from "./regenerate/activity.ts";
export { sweepOrphanedGroups } from "./regenerate/shell.ts";

// What turri did, as facts: the ledger, heard live and read back - this session's pulses and every earlier one's.
export { ledgerDir, onLedgerEvent, readLedger, type AgentRef, type LedgerEntry, type LedgerEvent, type LedgerKind, type LedgerQuery } from "./regenerate/ledger.ts";
export { asJob, describePulseView, describeRuns, earlierPulses, ledgerProjects, pulseView, runViews, type PulseView, type RunView } from "./regenerate/ledger-view.ts";
