import { testEvidence } from "./area.ts";
import type { Assembly } from "./assemble.ts";
import { featureKey, featurePaths } from "./assemble.ts";
import { droppedBecause, interfaceConcept, interfaceGaps, referenceOf, referencePath, shownSurface } from "./interface.ts";
import type { CodeMap } from "./map.ts";
import type { CaptureState } from "./state.ts";
import type { CheckResult } from "../plain/check.ts";
import { testingScriptSkill, type ScriptKind } from "../regenerate/test-scripts.ts";

/**
 * What a capture tells the person, in place of the questions it never asked: what it wrote, what it decided, what it
 * left out and why, what it could not capture, and what it was unsure of - then what to do next. Written to
 * `<plain>/.turri/capture/report.md`; its first lines are the summary the chat and the command line show.
 */

export interface ReportInput {
  root: string;
  plainDir: string;
  map: CodeMap;
  state: CaptureState;
  assembly: Assembly;
  checks: CheckResult[];
}

export function counts(assembly: Assembly): { modules: number; specs: number; scenarios: number; withScenarios: number } {
  const specs = assembly.modules.flatMap((module) => module.features.flatMap((feature) => feature.specs));
  return {
    modules: assembly.modules.length,
    specs: specs.length,
    scenarios: specs.reduce((sum, spec) => sum + spec.conformance.length + spec.acceptance.length, 0),
    withScenarios: specs.filter((spec) => spec.conformance.length + spec.acceptance.length > 0).length,
  };
}

/** What could not be captured: areas, and features of areas that were outlined. */
export function uncaptured(state: CaptureState): string[] {
  const failedAreas = Object.values(state.areas)
    .filter((area) => area.failed !== undefined)
    .map((area) => `area ${area.id} (${area.paths.join(", ")}): ${area.failed}`);
  const failedFeatures = Object.values(state.areas).flatMap((area) =>
    (area.features ?? []).flatMap((feature) => {
      const result = state.features[featureKey(area.id, feature.name)];
      return result?.failed !== undefined ? [`feature ${feature.name} of ${area.id} (${feature.paths.join(", ")}): ${result.failed}`] : [];
    }),
  );
  return [...failedAreas, ...failedFeatures];
}

/**
 * The interface of the code its ***plain names nowhere, each with why a writer dropped it when one did: an option, a
 * command, a route, a screen or an environment variable a user could reach in the original and not in what is
 * regenerated, unless the ***plain says it in other words.
 */
export function gapLines(map: CodeMap, state: CaptureState, assembly: Assembly): Array<{ line: string; dropped: boolean }> {
  return interfaceGaps(map, state, assembly).map((surface) => {
    const why = droppedBecause(state, surface);
    return { line: `${shownSurface(surface)}${why !== undefined ? ` - dropped: ${why}` : ""}`, dropped: why !== undefined };
  });
}

/** The conventions every feature of a part follows, as the survey settled them, with the files that decide each. */
export function conventionLines(state: CaptureState): string[] {
  return (state.survey?.parts ?? []).flatMap((part) => (part.conventions ?? []).map((convention) => `${part.name}: ${convention.text} (decided in ${convention.where.join(", ")})`));
}

/** Each part's interface reference: where it is, what it holds, what was excluded and why, and what could not be taken. */
export function referenceLines(state: CaptureState): string[] {
  return (state.survey?.parts ?? []).flatMap((part) => {
    const { entries, excluded, failed } = referenceOf(state, part.name);
    const count = (kind: string, noun: string, plural = `${noun}s`) => {
      const n = entries.filter((entry) => entry.kind === kind).length;
      return n === 0 ? [] : [`${n} ${n === 1 ? noun : plural}`];
    };
    const held = [...count("command", "command"), ...count("argument", "argument"), ...count("option", "option"), ...count("route", "route"), ...count("env", "environment variable"), ...count("other", "other piece", "other pieces")];
    return [
      ...(entries.length > 0 || state.pythonInterfaces?.[part.name] ? [`${part.name}: \`${referencePath(part.name)}\`, linked by ${interfaceConcept(part.name)} - ${[...held, ...(state.pythonInterfaces?.[part.name] ? ["public Python imports and signatures"] : [])].join(", ")}`] : [`${part.name}: no interface reference - the writers took its interface from the map alone`]),
      ...excluded.map((item) => `${part.name}: \`${item.name}\` (${item.path}) left out of it - ${item.why}`),
      ...Object.values(state.interfaces?.[part.name] ?? {}).flatMap((batch) =>
        "entries" in batch && batch.checked !== undefined
          ? "failed" in batch.checked
            ? [`${part.name}: not checked against the code - ${batch.checked.failed} It is as it was taken: check it first.`]
            : batch.checked.changes.map((change) => `${part.name}: checked against the code - ${change}`)
          : [],
      ),
      ...failed.map((why) => `${part.name}: not taken from ${why} - the writers took that interface from the map alone`),
    ];
  });
}

/** What the check of the conventions against the code changed, and where it did not hold. */
export function conventionCheckLines(state: CaptureState): string[] {
  return Object.entries(state.conventionsChecked ?? {}).flatMap(([part, checked]) => [
    ...checked.changes.map((change) => `${part}: ${change}`),
    ...(checked.failed !== undefined ? [`${part}: not checked - ${checked.failed} The conventions are as the survey settled them: check them first.`] : []),
  ]);
}

/** What the check of each module's interface against the code corrected, and why. */
export function correctionLines(state: CaptureState): string[] {
  return Object.entries(state.corrections ?? {}).flatMap(([module, corrections]) => corrections.map((correction) => `${module}:${correction.funcId}${correction.scenarioId !== undefined ? `, scenario ${correction.scenarioId}` : ""} - ${correction.why}`));
}

/**
 * Each part's features as they were gathered into modules: the modules in the order they are built, what each needs of
 * those before it, the scenarios rewritten to need only those before their own, and the parts whose features could not be
 * gathered.
 */
export function gatheredLines(state: CaptureState): string[] {
  return Object.entries(state.gathered ?? {}).flatMap(([part, gathered]) =>
    gathered.failed !== undefined
      ? [`${part}: ${gathered.failed} Its modules are as the code's areas make them, in the order of their code: check that each is a concern of its own and that its scenarios need only the modules before it.`]
      : [
          `${part}: ${gathered.modules.map((module) => module.name).join(", ")}`,
          ...gathered.modules.filter((module) => module.needs.length > 0).map((module) => `${module.name} needs ${module.needs.join(", ")}`),
          ...gathered.rewrites.map((rewrite) => `${rewrite.feature}: ${rewrite.funcId}, scenario ${rewrite.scenarioId} - rewritten: ${rewrite.why}`),
        ],
  );
}

/** How many scenarios were tried on the original, and how many held as written. */
export function trialCounts(state: CaptureState): { tried: number; held: number; corrected: number; removed: number; untried: number; failed: number } {
  const counts = { tried: 0, held: 0, corrected: 0, removed: 0, untried: 0, failed: 0 };
  for (const batches of Object.values(state.trials ?? {})) {
    for (const batch of Object.values(batches)) {
      if (!("results" in batch)) {
        counts.failed += 1;
        continue;
      }
      for (const result of batch.results) {
        counts[result.outcome] += 1;
        if (result.outcome !== "untried") counts.tried += 1;
      }
    }
  }
  return counts;
}

/**
 * What trying the scenarios on the original found: each scenario corrected to what the original does, removed, or not
 * tried, with why; each functional spec it corrected; what it added to the test reqs; and the agents that never held.
 */
export function trialLines(state: CaptureState): string[] {
  return Object.entries(state.trials ?? {}).flatMap(([module, batches]) =>
    Object.entries(batches).flatMap(([key, batch]) =>
      "failed" in batch
        ? [`${module}: the scenarios of its agent ${key} were not tried - ${batch.failed} They are as written: try them first.`]
        : [
            ...batch.results.filter((result) => result.outcome !== "held").map((result) => `${module}:${result.funcId}, scenario ${result.scenarioId} - ${result.outcome === "untried" ? "not tried" : result.outcome}: ${result.why ?? ""}`),
            ...batch.specs.map((correction) => `${module}:${correction.funcId} - corrected: ${correction.why}`),
            ...batch.testReqs.map((req) => `${module}: added to the test reqs - ${req}`),
          ],
    ),
  );
}

/** What the division did: the features merged into others, and the parts it could not divide. */
export function divisionLines(state: CaptureState): string[] {
  return Object.entries(state.divided ?? {}).flatMap(([part, division]) => [
    ...Object.entries(division.merged).map(([key, merged]) => `${key} - merged into ${merged.into.join(", ")}: ${merged.why}`),
    ...(division.failed !== undefined ? [`${part}: ${division.failed} Each feature owns what it was outlined for.`] : []),
  ]);
}

/** Features captured with no scenario although the original tests them in their files: nothing checks what they do. */
export function untestedLines(map: CodeMap, state: CaptureState): string[] {
  return Object.values(state.features).flatMap((feature) => {
    const specs = feature.captured?.specs;
    if (specs === undefined || specs.some((spec) => spec.conformance.length + spec.acceptance.length > 0)) return [];
    const evidence = testEvidence(map, featurePaths(state, feature.key));
    return evidence.length === 0 ? [] : [`${feature.key} - ${evidence.map((file) => `${file.path} (${file.lines} lines)`).join(", ")}`];
  });
}

/** A count with its noun, one or many: "1 feature", "3 features". */
function some(count: number, noun: string, plural = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : plural}`;
}

function list(items: string[], none: string): string[] {
  return items.length === 0 ? [none, ""] : [...items.map((item) => `- ${item}`), ""];
}

/** The summary: a line or two the chat and the command line show. */
export function summaryOf(input: { plainDir: string; map: CodeMap; assembly: Assembly; state: CaptureState; checks: CheckResult[] }): string {
  const { modules, specs, scenarios } = counts(input.assembly);
  const unnamed = gapLines(input.map, input.state, input.assembly).filter((gap) => !gap.dropped).length;
  const missing = uncaptured(input.state).length;
  const failing = input.checks.filter((check) => !check.ok).length;
  const scripts = Object.values(input.state.scripts ?? {});
  const unwritten = scripts.filter((script) => "failed" in script).length;
  const trials = trialCounts(input.state);
  return [
    `Captured ${some(specs, "functional spec")} in ${some(modules, "module")}, with ${some(scenarios, "scenario")}${scripts.length > 0 && unwritten === 0 ? " and its testing scripts" : ""}, into ${input.plainDir}.`,
    ...(trials.tried > 0
      ? [`${trials.held} of the ${some(trials.tried, "scenario")} tried on the original held as written${trials.corrected > 0 ? `, ${trials.corrected} corrected to what it does` : ""}${trials.removed > 0 ? `, ${trials.removed} removed` : ""}.`]
      : []),
    ...(trials.untried + trials.failed > 0 ? ["Some scenarios could not be tried on the original - the report says which."] : []),
    ...(missing > 0 ? [`${missing === 1 ? "1 area or feature" : `${missing} areas or features`} could not be captured - the report says which.`] : []),
    ...(failing > 0 ? [`${failing === 1 ? "1 module does" : `${failing} modules do`} not parse - the report has the parser's message.`] : []),
    ...(unnamed > 0 ? [`${unnamed === 1 ? "1 option, command, route or variable of the code's interface is" : `${unnamed} options, commands, routes or variables of the code's interface are`} named nowhere in the ***plain - the report lists them.`] : []),
    ...(unwritten > 0 ? [`${unwritten === 1 ? "1 testing script was" : `${unwritten} testing scripts were`} not written - the report says why.`] : []),
  ].join(" ");
}

/** Each part's testing scripts, as the report lists them: where each is, or why there is none and what to ask for. */
function scriptLines(state: CaptureState): string[] {
  return Object.entries(state.scripts ?? {}).map(([key, outcome]) => {
    const [part, kind] = key.split(":") as [string, ScriptKind];
    const { skill, what } = testingScriptSkill(kind);
    return "written" in outcome ? `${part}, the ${what}: \`${outcome.written}\`${outcome.finding ? ` - ${outcome.finding}` : ""}` : `${part}, the ${what}: not written - ${outcome.failed}. Ask turri for it: \`${skill}\`.`;
  });
}

export function renderReport(input: ReportInput): string {
  const { state, assembly, map } = input;
  const survey = state.survey;
  // The survey and a split may both leave a path out: said once.
  const leftOut = [...new Map([...(survey?.leftOut ?? []), ...Object.values(state.areas).flatMap((area) => area.leftOut ?? [])].map((item) => [item.path, item] as const)).values()];
  const features = Object.values(state.features).flatMap((feature) => (feature.captured !== undefined ? [{ key: feature.key, captured: feature.captured }] : []));
  const perFeature = (pick: (captured: (typeof features)[number]["captured"]) => string[]) => features.flatMap(({ key, captured }) => pick(captured).map((line) => `${key}: ${line}`));
  const failing = input.checks.filter((check) => !check.ok);
  return [
    "# Capture report",
    "",
    summaryOf(input),
    "",
    `The codebase: ${input.root} - ${map.files.length} files. Started ${state.started}${state.finished !== undefined ? `, finished ${state.finished}` : ""}.`,
    ...(state.plan !== undefined ? [`Pipeline: ${state.plan.kind} - ${state.plan.reason}.`] : []),
    "",
    "## What was written",
    "",
    ...assembly.shared.map((module) => `- \`template/${module.name}.plain\` - what every module of ${module.part} shares${module.imports.length > 0 ? `, on ${module.imports.join(" and ")}` : ""}: ${some(module.definitions.length, "concept")}, ${some(module.implementationReqs.length, "implementation req")}, ${some(module.testReqs.length, "test req")}`),
    ...assembly.modules.map((module) => {
      const specs = module.features.flatMap((feature) => feature.specs);
      const tested = specs.filter((spec) => spec.conformance.length + spec.acceptance.length > 0).length;
      return `- \`${module.name}.plain\`${module.requires !== undefined ? ` (requires ${module.requires})` : ""} - ${module.about}: ${some(module.features.length, "feature")}, ${some(specs.length, "functional spec")}, ${tested} with scenarios`;
    }),
    "",
    "## Conventions",
    "",
    "What every feature follows, settled once from the code that decides it: wrong here, wrong everywhere.",
    "",
    ...list(conventionLines(state), "None settled."),
    "Checked against the code before any feature was written - what the check changed:",
    "",
    ...list(conventionCheckLines(state), "Nothing: every convention held."),
    "## The interface reference",
    "",
    "Every command, argument, option, route and environment variable, taken from the code as data - each name, what it takes, its choices, its default and its help checked against the code it cites - and kept as a linked resource every functional spec about it carries: exact where the ***plain is prose.",
    "",
    ...list(referenceLines(state), "None taken."),
    "## The interface checked against the code",
    "",
    "Every interface fact of each module - options, commands, routes, fields, messages, exit codes - checked against the code that decides it, once its ***plain read well. What was corrected, and why:",
    "",
    ...list(correctionLines(state), "Nothing: the interface held."),
    "## The scenarios tried on the original",
    "",
    "Each scenario run against a copy of the original as its conformance test will run it, before the ***plain was written: what the original does otherwise corrected to what it does, what nothing outside can check removed, and what a test must set up added to the test reqs.",
    "",
    ...list(trialLines(state), Object.keys(state.trials ?? {}).length > 0 ? "Every scenario held as written." : "None tried."),
    "## Modules by concern, in build order",
    "",
    "Each module a concern of its own, built on those before it, its scenarios run as soon as it is: the modules, what each needs, and the scenarios rewritten to need only the modules before their own.",
    "",
    ...list(gatheredLines(state), "One feature a part: nothing to gather."),
    "## Features divided",
    "",
    "Each behaviour is one feature's: a feature whose behaviour others own was merged into them, and not written.",
    "",
    ...list(divisionLines(state), "No feature was merged."),
    "## Testing scripts",
    "",
    ...list(scriptLines(state), "None written."),
    "## The parser's check",
    "",
    ...(failing.length === 0 ? ["Every module parses.", ""] : [...failing.map((check) => `- ${check.file}: ${check.error ?? check.problems?.join("; ") ?? "fails"}`), ""]),
    "## Could not be captured",
    "",
    ...list(uncaptured(state), "Nothing: every area and feature was captured."),
    "## Tested by the original, with no scenario",
    "",
    "Features the original's tests cover in their files that were captured with no scenario: nothing checks what is regenerated for them until scenarios are written.",
    "",
    ...list(untestedLines(map, state), "None."),
    "## The interface named nowhere in the ***plain",
    "",
    "Options, commands, routes, screens and environment variables of the code the capture took that its ***plain never names: a user or a client could call them in the original, and will not find them in what is regenerated - unless the ***plain says them in other words. Those a writer judged not the software's interface say why.",
    "",
    ...list(gapLines(map, state, assembly).map((gap) => gap.line), "None: the ***plain names every one."),
    "## Left out",
    "",
    ...list(leftOut.map((item) => `${item.path} - ${item.why}`), "Nothing."),
    "## Assumptions",
    "",
    ...list([...(survey?.assumptions ?? []), ...perFeature((captured) => captured.assumptions)], "None."),
    "## Uncertain",
    "",
    ...list(perFeature((captured) => captured.uncertain), "Nothing."),
    "## Dropped as incidental",
    "",
    ...list(perFeature((captured) => captured.dropped), "Nothing."),
    "## Next",
    "",
    "- Read the ***plain: it is the source of truth from now on. Change what reads wrong as any ***plain change.",
    Object.values(state.scripts ?? {}).some((script) => "failed" in script) || Object.keys(state.scripts ?? {}).length === 0
      ? "- Ask turri for the testing scripts not written above, then regenerate it - every module, from the first: `/regenerate`. Conformance tests are on."
      : "- Regenerate it - every module, from the first: `/regenerate`. Its testing scripts are written, and conformance tests are on.",
    "- Close the gap by hand: run the original's own tests, or the conformance tests written from the scenarios, against what is regenerated, and capture what is missing as ***plain changes.",
    "",
  ].join("\n");
}
