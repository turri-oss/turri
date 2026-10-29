import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ask, BEGIN, createExecutor } from "../pi.ts";
import type { AdvisorAnswer, AdvisorInput, AdvisorQuestion, AdvisorReport } from "./advisor-records.ts";

/**
 * The test advisor's judgement of one functional spec: does it need explicit testing scenarios, and if so, which inputs
 * should they cover (docs/test-advisor.md). Every step is a plain model call on `models.advisor`, answered through one
 * tool and checked in code, as the planner's grouping agent is - none is a skill, and none can touch the project.
 *
 * - **Classify:** four questions, each yes carrying its evidence - a wrong output that looks right (silent failure), an
 *   input two reasonable readings answer differently (divergence), what would change (revisited), the consequence of a
 *   bug (cost). A yes whose evidence is empty or malformed counts as no. Silent failure, divergence or cost make the
 *   verdict yes; revisited alone does not - the unit tests are the regression protection.
 * - **On a yes, pick the inputs:** one call writes 1-10 boundary probes (and the divergence's input), readers that
 *   differ only by their system prompt each predict every probe's output, code compares them, and any disagreement is a
 *   candidate - the union, never a majority. The third reader is spared when the first two already disagree. One last
 *   call keeps, of each candidate, the readings a reasonable person could hold.
 */

/** The functional spec the advisor looks at, and what it reads it with. */
export interface AdvisorSubject {
  module: string;
  funcId: string;
  /** The functional spec's text. */
  text: string;
  /** The module's .plain file, whole: its definitions, its reqs, the functional specs around it. */
  moduleText: string;
  /** The project's own words on what matters: its AGENTS.md, the steering given in the conversation. */
  context: string[];
  /** A module below's: the tip its scenarios are tested in - built on it, its own functional specs beside it. */
  testedIn?: { module: string; text: string };
}

export interface AdvisorCallOptions {
  /** Where the calls run: the project. */
  cwd: string;
  /** The advisor's model (advisorModel) - the `advisor` role's config is laid over it as for any agent. */
  model?: string;
}

/** The classification: the verdict, the questions that were a yes with their evidence, and the divergence's input. */
export interface Classification {
  verdict: "yes" | "no";
  questions: AdvisorAnswer[];
  divergence?: { input: string; readings: [string, string] };
}

/** How many times a call that did not answer, or answered what does not hold, is asked again. */
const RETRIES = 2;

/** The fewest and most probes a functional spec is given. */
export const MIN_PROBES = 1;
export const MAX_PROBES = 10;

/** What a reader answers for an input the functional spec does not settle: a scenario on it would pin a guess. */
export const UNSPECIFIED = "unspecified";

/** The readers: the same task, decorrelated by their system prompts alone. */
export const READERS: ReadonlyArray<{ name: string; system: string }> = [
  {
    name: "literal reader",
    system:
      "You read a functional spec literally: you predict exactly what its words say, and nothing they do not. Where the words are silent, you take the narrowest reading they allow.",
  },
  {
    name: "edge-case hunter",
    system:
      "You read a functional spec as a tester hunting for edge cases: empty and huge values, limits, duplicates, order, rounding, time zones, missing data. You predict what a careful implementation would do at each edge.",
  },
  {
    name: "another domain's reader",
    system:
      "You read a functional spec as someone from another domain would - a different field, a different country, a different habit of mind - bringing the conventions that domain takes for granted. You predict what you would expect the output to be.",
  },
];

/** Ask one call, and ask again with what was wrong, until it holds or the retries are spent. */
async function askAdvisor<A>(options: {
  cwd: string;
  model?: string;
  label: string;
  task: string;
  system?: string;
  tool: (take: (answer: A) => void) => ToolDefinition;
  check: (answer: A) => string[];
}): Promise<A | undefined> {
  let answer: A | undefined;
  const tool = options.tool((given) => (answer = given));
  const session = await createExecutor({
    cwd: options.cwd,
    customTools: [tool],
    tools: [tool.name],
    model: options.model,
    label: options.label,
    role: "advisor",
    task: options.task,
    ...(options.system !== undefined ? { system: options.system } : {}),
    budget: { calls: 4, finish: [tool.name] },
  });
  try {
    await ask(session, BEGIN);
    for (let again = 0; again < RETRIES; again += 1) {
      if (answer !== undefined && options.check(answer).length === 0) return answer;
      const problems = answer === undefined ? [`You did not call ${tool.name}.`] : options.check(answer);
      answer = undefined;
      await ask(session, `That does not hold:\n- ${problems.join("\n- ")}\n\nCall ${tool.name} again, with it fixed.`);
    }
    return answer !== undefined && options.check(answer).length === 0 ? answer : undefined;
  } finally {
    session.dispose();
  }
}

/** Text compared as the readers' outputs are: whitespace collapsed, case left aside. */
export function normalised(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

/** What every call is given: the functional spec, its module, and the project's own words on what matters. */
function subjectBlock(subject: AdvisorSubject): string[] {
  return [
    `<functional_spec module="${subject.module}" func_id="${subject.funcId}">`,
    subject.text.trim(),
    "</functional_spec>",
    "",
    `<module name="${subject.module}">`,
    subject.moduleText.trim(),
    "</module>",
    ...(subject.testedIn !== undefined
      ? [
          "",
          `Its scenarios are tested against the code of ${subject.testedIn.module}, which is built on ${subject.module}: what a command`,
          `or a listing shows there includes ${subject.testedIn.module}'s own functional specs.`,
          `<module name="${subject.testedIn.module}">`,
          subject.testedIn.text.trim(),
          "</module>",
        ]
      : []),
    ...(subject.context.length > 0 ? ["", "<the project's own words on what matters>", ...subject.context.map((text) => text.trim()), "</the project's own words on what matters>"] : []),
  ];
}

const stringOf = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

type ClassificationAnswer = {
  silent_failure: { answer: boolean; wrong_output?: string };
  divergence: { answer: boolean; input?: string; reading_a?: string; reading_b?: string };
  revisited: { answer: boolean; would_change?: string };
  cost: { answer: boolean; consequence?: string };
};

/**
 * The classification, from the call's answer: each yes kept only with its evidence - a yes without it, or with it
 * malformed (two readings that are the same), is a no. The verdict is yes on silent failure, divergence or cost.
 */
export function classificationOf(answer: ClassificationAnswer): Classification {
  const questions: AdvisorAnswer[] = [];
  const add = (question: AdvisorQuestion, yes: boolean, evidence: string) => {
    if (yes && evidence !== "") questions.push({ question, evidence });
  };
  add("silent-failure", answer.silent_failure?.answer === true, stringOf(answer.silent_failure?.wrong_output));
  const input = stringOf(answer.divergence?.input);
  const a = stringOf(answer.divergence?.reading_a);
  const b = stringOf(answer.divergence?.reading_b);
  const diverges = answer.divergence?.answer === true && input !== "" && a !== "" && b !== "" && normalised(a) !== normalised(b);
  add("divergence", diverges, diverges ? `${input} - one reading: ${a}; the other: ${b}` : "");
  add("revisited", answer.revisited?.answer === true, stringOf(answer.revisited?.would_change));
  add("cost", answer.cost?.answer === true, stringOf(answer.cost?.consequence));
  const decisive = questions.some((answered) => answered.question !== "revisited");
  return { verdict: decisive ? "yes" : "no", questions, ...(diverges ? { divergence: { input, readings: [a, b] } } : {}) };
}

function classifyPrompt(subject: AdvisorSubject): string {
  return [
    "You decide whether one functional spec of a ***plain module needs explicit testing scenarios: black-box tests written",
    "from scenarios, beside the unit tests its coding agent writes anyway. Not everything should be tested this way - only",
    "functionality where a wrong implementation would go unnoticed, where readers would disagree, or where a bug is costly.",
    "",
    ...subjectBlock(subject),
    "",
    "Answer four questions about the functional spec. Each yes needs concrete evidence; without it, answer no.",
    "1. silent_failure: could an incorrect implementation give output that looks plausible but is wrong? Evidence: one such",
    "   wrong output, concretely - the input and the wrong output it would give.",
    "2. divergence: is there an input for which two reasonable readings of the text give different outputs? Evidence: the",
    "   input, and the output under each reading.",
    "3. revisited: is this functionality likely to be changed or built on later? Evidence: what would change.",
    "4. cost: would a bug in it cause financial loss, security exposure, data loss, or harm to users' trust? Evidence: the",
    "   consequence.",
    "",
    "Judge only this functional spec, from what the module and the project say. Do not answer yes to be safe: a yes",
    "starts work, and a functional spec with nothing at stake is better left to its unit tests.",
    "Call submit_classification once.",
  ].join("\n");
}

/** Classify a functional spec: one call, four evidence-backed questions. Throws when the call gives no answer. */
export async function classify(subject: AdvisorSubject, options: AdvisorCallOptions): Promise<Classification> {
  const answer = await askAdvisor<ClassificationAnswer>({
    cwd: options.cwd,
    model: options.model,
    label: `${subject.module}:${subject.funcId} test advisor classifying`,
    task: classifyPrompt(subject),
    check: () => [],
    tool: (take) =>
      defineTool({
        name: "submit_classification",
        label: "Submit the classification",
        description: "The four answers, each yes with its evidence.",
        parameters: Type.Object({
          silent_failure: Type.Object({ answer: Type.Boolean(), wrong_output: Type.Optional(Type.String({ description: "An input, and the plausible but wrong output an incorrect implementation would give." })) }),
          divergence: Type.Object({
            answer: Type.Boolean(),
            input: Type.Optional(Type.String({ description: "The input two reasonable readings disagree on." })),
            reading_a: Type.Optional(Type.String({ description: "The output under one reading." })),
            reading_b: Type.Optional(Type.String({ description: "The output under the other." })),
          }),
          revisited: Type.Object({ answer: Type.Boolean(), would_change: Type.Optional(Type.String({ description: "What would change, or be built on it." })) }),
          cost: Type.Object({ answer: Type.Boolean(), consequence: Type.Optional(Type.String({ description: "What a bug would cost, and whom." })) }),
        }),
        async execute(_id, params) {
          take(params as ClassificationAnswer);
          return { content: [{ type: "text" as const, text: "Recorded." }], details: {}, terminate: true };
        },
      }) as ToolDefinition,
  });
  if (answer === undefined) throw new Error("the classification call gave no answer");
  return classificationOf(answer);
}

function probesPrompt(subject: AdvisorSubject, classification: Classification): string {
  return [
    "This functional spec needs explicit testing scenarios. Pick the inputs they should cover.",
    "",
    ...subjectBlock(subject),
    "",
    "<why it needs them>",
    ...classification.questions.map((answered) => `- ${answered.question}: ${answered.evidence}`),
    "</why it needs them>",
    "",
    `Write the probes - as many as the functional spec has real boundaries, ${MIN_PROBES} to ${MAX_PROBES}, one when it has a single input:`,
    "concrete inputs at the boundaries of what the functional spec says - limits, empty and missing values, duplicates,",
    "order, the cases its wording leaves open - each one an input a black-box test can give through the interface the",
    "functional spec names. Concrete values, never descriptions (\"a long name\").",
    "Only inputs whose output the functional spec bears on: never a command, flag, alias or option it does not name, and",
    "never one that exercises another functional spec of the module instead - a test of what it does not say would pin a guess.",
    "Never pad to reach a number: an input that tests nothing new is noise in the scenarios. Do not say what the output",
    "should be. Call submit_probes once.",
  ].join("\n");
}

/** The probes: 1-10 boundary inputs, and the divergence's input when the classification found one. */
async function probes(subject: AdvisorSubject, classification: Classification, options: AdvisorCallOptions): Promise<string[]> {
  const answer = await askAdvisor<{ probes: Array<{ input: string }> }>({
    cwd: options.cwd,
    model: options.model,
    label: `${subject.module}:${subject.funcId} test advisor probes`,
    task: probesPrompt(subject, classification),
    check: (given) => {
      const inputs = given.probes.map((probe) => stringOf(probe.input)).filter((input) => input !== "");
      return inputs.length < MIN_PROBES || inputs.length > MAX_PROBES ? [`Give ${MIN_PROBES} to ${MAX_PROBES} probes, each a concrete input; you gave ${inputs.length}.`] : [];
    },
    tool: (take) =>
      defineTool({
        name: "submit_probes",
        label: "Submit the probes",
        description: `${MIN_PROBES} to ${MAX_PROBES} concrete boundary inputs.`,
        parameters: Type.Object({ probes: Type.Array(Type.Object({ input: Type.String() })) }),
        async execute(_id, params) {
          take(params as { probes: Array<{ input: string }> });
          return { content: [{ type: "text" as const, text: "Recorded." }], details: {}, terminate: true };
        },
      }) as ToolDefinition,
  });
  if (answer === undefined) throw new Error("the probes call gave no probes");
  const inputs: string[] = [];
  const add = (input: string) => {
    if (input !== "" && !inputs.some((known) => normalised(known) === normalised(input))) inputs.push(input);
  };
  for (const probe of answer.probes) add(stringOf(probe.input));
  if (classification.divergence !== undefined) add(classification.divergence.input);
  return inputs;
}

function readerPrompt(subject: AdvisorSubject, inputs: string[]): string {
  return [
    "Predict what an implementation of this functional spec outputs for each input below.",
    "",
    ...subjectBlock(subject),
    "",
    "<inputs>",
    ...inputs.map((input, index) => `${index + 1}. ${input}`),
    "</inputs>",
    "",
    "For every input, by its number, give the output you expect - concrete, as a test would check it, in a line. Where",
    "the functional spec leaves it open, give the output your reading of it leads to. Where it says nothing that bears on",
    `the input at all - a command or an option it does not name - answer exactly ${UNSPECIFIED}. Call submit_predictions once.`,
  ].join("\n");
}

/** One reader's predictions, by probe - or nothing when it gave none that hold. */
async function predictions(subject: AdvisorSubject, inputs: string[], reader: (typeof READERS)[number], options: AdvisorCallOptions): Promise<string[] | undefined> {
  const answer = await askAdvisor<{ predictions: Array<{ input: number; output: string }> }>({
    cwd: options.cwd,
    model: options.model,
    label: `${subject.module}:${subject.funcId} test advisor ${reader.name}`,
    task: readerPrompt(subject, inputs),
    system: reader.system,
    check: (given) => {
      const missing = inputs.flatMap((_input, index) => (given.predictions.filter((prediction) => prediction.input === index + 1 && stringOf(prediction.output) !== "").length === 1 ? [] : [index + 1]));
      return missing.length > 0 ? [`Give exactly one output for every input; not for: ${missing.join(", ")}.`] : [];
    },
    tool: (take) =>
      defineTool({
        name: "submit_predictions",
        label: "Submit the predictions",
        description: "The output expected for every input, by its number.",
        parameters: Type.Object({ predictions: Type.Array(Type.Object({ input: Type.Number(), output: Type.String() })) }),
        async execute(_id, params) {
          take(params as { predictions: Array<{ input: number; output: string }> });
          return { content: [{ type: "text" as const, text: "Recorded." }], details: {}, terminate: true };
        },
      }) as ToolDefinition,
  });
  if (answer === undefined) return undefined;
  return inputs.map((_input, index) => stringOf(answer.predictions.find((prediction) => prediction.input === index + 1)?.output));
}

/**
 * The inputs the readers split on - every probe where any two predictions differ once normalised: the union, never a
 * majority - each with its distinct readings, in the order the readers gave them.
 */
export function splitInputs(readings: string[][]): Map<number, string[]> {
  const split = new Map<number, string[]>();
  const count = readings[0]?.length ?? 0;
  for (let index = 0; index < count; index += 1) {
    const distinct: string[] = [];
    for (const reader of readings) {
      const output = reader[index] ?? "";
      if (!distinct.some((known) => normalised(known) === normalised(output))) distinct.push(output);
    }
    if (distinct.length > 1) split.set(index, distinct);
  }
  return split;
}

function verifyPrompt(subject: AdvisorSubject, candidates: Array<{ input: string; readings: string[] }>): string {
  return [
    "Readers of this functional spec disagreed on the outputs of some inputs. For each, say which readings a reasonable",
    "person could hold, given the functional spec, its module and the project.",
    "",
    ...subjectBlock(subject),
    "",
    "<disagreements>",
    ...candidates.flatMap((candidate, index) => [`${index + 1}. input: ${candidate.input}`, ...candidate.readings.map((reading, at) => `   reading ${at + 1}: ${reading}`)]),
    "</disagreements>",
    "",
    "For every disagreement, by its number, list the numbers of the readings a reasonable person could hold. Leave out a",
    `reading only a misreading or a mistake leads to. A reading of ${UNSPECIFIED} holds when the functional spec says nothing`,
    "that settles the input. Call submit_verification once.",
  ].join("\n");
}

/** Of each candidate, the readings a reasonable person could hold - or nothing when the call gave no answer that holds. */
async function verify(subject: AdvisorSubject, candidates: Array<{ input: string; readings: string[] }>, options: AdvisorCallOptions): Promise<string[][] | undefined> {
  const answer = await askAdvisor<{ inputs: Array<{ input: number; reasonable: number[] }> }>({
    cwd: options.cwd,
    model: options.model,
    label: `${subject.module}:${subject.funcId} test advisor verifier`,
    task: verifyPrompt(subject, candidates),
    check: (given) => {
      const problems: string[] = [];
      candidates.forEach((candidate, index) => {
        const said = given.inputs.filter((item) => item.input === index + 1);
        if (said.length !== 1) problems.push(`Say once which readings of disagreement ${index + 1} hold.`);
        else if (said[0]!.reasonable.some((number) => !Number.isInteger(number) || number < 1 || number > candidate.readings.length)) problems.push(`Disagreement ${index + 1} has readings 1 to ${candidate.readings.length} only.`);
      });
      return problems;
    },
    tool: (take) =>
      defineTool({
        name: "submit_verification",
        label: "Submit the verification",
        description: "For every disagreement, by its number, the numbers of the readings a reasonable person could hold.",
        parameters: Type.Object({ inputs: Type.Array(Type.Object({ input: Type.Number(), reasonable: Type.Array(Type.Number()) })) }),
        async execute(_id, params) {
          take(params as { inputs: Array<{ input: number; reasonable: number[] }> });
          return { content: [{ type: "text" as const, text: "Recorded." }], details: {}, terminate: true };
        },
      }) as ToolDefinition,
  });
  if (answer === undefined) return undefined;
  return candidates.map((candidate, index) => {
    const reasonable = answer.inputs.find((item) => item.input === index + 1)?.reasonable ?? [];
    return candidate.readings.filter((_reading, at) => reasonable.includes(at + 1));
  });
}

/**
 * Pick the inputs a functional spec's scenarios should cover: the probes, the readers' predictions of them, the
 * disagreements in code, and the verifier's word on each. An input the readers agree on comes with their output; one
 * they split on, with every reading the verifier kept - a single reading left is an agreed one, and none left drops it.
 */
export async function pickInputs(subject: AdvisorSubject, classification: Classification, options: AdvisorCallOptions): Promise<AdvisorInput[]> {
  const inputs = await probes(subject, classification, options);
  // Two readers first; the third only when they agree on every probe - a disagreement already found is enough.
  const first = await Promise.all(READERS.slice(0, 2).map((reader) => predictions(subject, inputs, reader, options)));
  const readings = first.filter((reading): reading is string[] => reading !== undefined);
  if (readings.length === 0 || splitInputs(readings).size === 0) {
    for (const reader of READERS.slice(2)) {
      const more = await predictions(subject, inputs, reader, options);
      if (more !== undefined) readings.push(more);
    }
  }
  if (readings.length === 0) throw new Error("no reader predicted the probes' outputs");
  const split = splitInputs(readings);
  const candidates = [...split].map(([index, distinct]) => ({ index, input: inputs[index]!, readings: distinct }));
  // Without the verifier's word, every reading stands: a split left unsettled is the writer's to settle.
  const kept = candidates.length > 0 ? ((await verify(subject, candidates, options)) ?? candidates.map((candidate) => candidate.readings)) : [];
  const out: AdvisorInput[] = [];
  inputs.forEach((input, index) => {
    const at = candidates.findIndex((candidate) => candidate.index === index);
    // An input the functional spec does not settle is left out: a scenario on it would pin a guess.
    if (at === -1) {
      if (normalised(readings[0]![index]!) !== UNSPECIFIED) out.push({ input, agreed: readings[0]![index]! });
      return;
    }
    const held = kept[at] ?? [];
    if (held.some((reading) => normalised(reading) === UNSPECIFIED)) return;
    if (held.length > 1) out.push({ input, readings: held });
    else if (held.length === 1) out.push({ input, agreed: held[0]! });
  });
  return out;
}

function testReqsPrompt(tip: { module: string; text: string }, context: string[]): string {
  return [
    `The module ${tip.module} is about to get its first conformance tests, and has no ***test reqs***: they say how its`,
    ":ConformanceTests: are written and run. Its stack has no conformance template in the standard library, so write them.",
    "",
    `<module name="${tip.module}">`,
    tip.text.trim(),
    "</module>",
    ...(context.length > 0 ? ["", "<the project's own words on what matters>", ...context.map((text) => text.trim()), "</the project's own words on what matters>"] : []),
    "",
    "Write 2 to 6 test reqs, each one line about :ConformanceTests: - the test framework of the module's language, how the",
    "tests reach the built code (they never import it: they run it, call it over its interface, or read what it writes),",
    "how they start and stop what they test, and how they are run. Each names :ConformanceTests:, says one thing, and adds",
    "nothing the module already says. No scenario, and no link to a script. Call submit_test_reqs once.",
  ].join("\n");
}

/** The fewest and most test reqs written for a module with none. */
const TEST_REQS = { min: 2, max: 6 };

/**
 * A module's ***test reqs***, written for one whose stack has no conformance template: one call, each req a line about
 * :ConformanceTests:. Throws when the call gives none that hold.
 */
export async function writeTestReqs(tip: { module: string; text: string }, context: string[], options: AdvisorCallOptions): Promise<string[]> {
  const answer = await askAdvisor<{ reqs: string[] }>({
    cwd: options.cwd,
    model: options.model,
    label: `${tip.module} test advisor test reqs`,
    task: testReqsPrompt(tip, context),
    check: (given) => {
      const reqs = given.reqs.map(stringOf).filter((req) => req !== "");
      const problems: string[] = [];
      if (reqs.length < TEST_REQS.min || reqs.length > TEST_REQS.max) problems.push(`Write ${TEST_REQS.min} to ${TEST_REQS.max} test reqs; you wrote ${reqs.length}.`);
      for (const req of reqs) {
        if (!req.includes(":ConformanceTests:")) problems.push(`Name :ConformanceTests: in every test req: "${req}" does not.`);
        if (req.includes("\n")) problems.push(`Each test req is one line: "${req.split("\n")[0]}..." is not.`);
      }
      return problems;
    },
    tool: (take) =>
      defineTool({
        name: "submit_test_reqs",
        label: "Submit the test reqs",
        description: `${TEST_REQS.min} to ${TEST_REQS.max} test reqs, each one line about :ConformanceTests:, without its leading "- ".`,
        parameters: Type.Object({ reqs: Type.Array(Type.String()) }),
        async execute(_id, params) {
          take(params as { reqs: string[] });
          return { content: [{ type: "text" as const, text: "Recorded." }], details: {}, terminate: true };
        },
      }) as ToolDefinition,
  });
  if (answer === undefined) throw new Error("the test reqs call gave none that hold");
  return answer.reqs.map(stringOf).filter((req) => req !== "").map((req) => req.replace(/^-\s+/, ""));
}

/** The whole judgement: classify, and on a yes pick the inputs. Throws when a call that cannot be done without fails. */
export async function advise(subject: AdvisorSubject, options: AdvisorCallOptions): Promise<AdvisorReport> {
  const classification = await classify(subject, options);
  if (classification.verdict === "no") return { verdict: "no", questions: classification.questions, inputs: [] };
  return { verdict: "yes", questions: classification.questions, inputs: await pickInputs(subject, classification, options) };
}
