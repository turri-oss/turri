import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The test advisor's calls, scripted: each stub session answers through its one tool, by what its label says it is -
 * the classifier, the probe writer, a reader, the verifier.
 */
type StubSession = { tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }>; label: string; system?: string; role?: string };

/** What each call answers with, by the end of its label. */
let answers: Record<string, unknown> = {};
/** The labels of the calls made, in order, and each one's role and system prompt. */
const made: Array<{ label: string; role?: string; system?: string }> = [];

vi.mock("../../src/pi.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/pi.ts")>();
  return {
    ...actual,
    createExecutor: vi.fn(async (opts: { customTools: StubSession["tools"]; label: string; system?: string; role?: string }) => {
      made.push({ label: opts.label, role: opts.role, system: opts.system });
      return { tools: opts.customTools, label: opts.label, system: opts.system, dispose() {} };
    }),
    ask: vi.fn(async (session: StubSession) => {
      const key = Object.keys(answers).find((end) => session.label.endsWith(end));
      if (key !== undefined) await session.tools[0]!.execute("id", answers[key]);
      return "Done.";
    }),
  };
});

const { advise, classify, classificationOf, pickInputs, splitInputs, READERS } = await import("../../src/regenerate/test-advisor.ts");

const subject = { module: "shop", funcId: "apply-discount", text: "A :Basket: total over 100 gets 10% off.", moduleText: "***functional specs***\n\n# apply-discount\nA :Basket: total over 100 gets 10% off.\n", context: [] };
const options = { cwd: process.cwd(), model: "x/cheap" };

const no = { answer: false };
const probes = ["100", "100.01", "0", "-5", "1000000"];

beforeEach(() => {
  answers = {};
  made.length = 0;
});

describe("classifying a functional spec", () => {
  it("counts a yes without evidence as a no", () => {
    expect(classificationOf({ silent_failure: { answer: true, wrong_output: "  " }, divergence: no, revisited: no, cost: { answer: true } })).toEqual({ verdict: "no", questions: [] });
  });

  it("counts a divergence whose two readings are the same as a no", () => {
    const classification = classificationOf({ silent_failure: no, divergence: { answer: true, input: "100", reading_a: "No discount", reading_b: "no  discount" }, revisited: no, cost: no });
    expect(classification.verdict).toBe("no");
    expect(classification.divergence).toBeUndefined();
  });

  it("says no when only revisited is a yes", async () => {
    answers = { classifying: { silent_failure: no, divergence: no, revisited: { answer: true, would_change: "Tiers of discount later." }, cost: no } };
    const report = await advise(subject, options);
    expect(report).toEqual({ verdict: "no", questions: [{ question: "revisited", evidence: "Tiers of discount later." }], inputs: [] });
    // A no costs one call.
    expect(made.map((call) => call.label)).toEqual(["shop:apply-discount test advisor classifying"]);
    expect(made[0]!.role).toBe("advisor");
  });

  it("says yes on silent failure, divergence or cost, each with its evidence", async () => {
    answers = { classifying: { silent_failure: no, divergence: { answer: true, input: "100", reading_a: "100", reading_b: "90" }, revisited: no, cost: { answer: true, consequence: "Customers are overcharged." } } };
    expect(await classify(subject, options)).toEqual({
      verdict: "yes",
      questions: [
        { question: "divergence", evidence: "100 - one reading: 100; the other: 90" },
        { question: "cost", evidence: "Customers are overcharged." },
      ],
      divergence: { input: "100", readings: ["100", "90"] },
    });
  });

  it("fails when the classifier never answers", async () => {
    await expect(classify(subject, options)).rejects.toThrow("gave no answer");
  });
});

describe("picking the inputs", () => {
  const yes = { verdict: "yes" as const, questions: [{ question: "silent-failure" as const, evidence: "100 gives 90" }] };
  const predict = (outputs: string[]) => ({ predictions: outputs.map((output, index) => ({ input: index + 1, output })) });

  it("marks the inputs the readers agree on with their output, and the ones they split on with their readings", async () => {
    answers = {
      probes: { probes: probes.map((input) => ({ input })) },
      "literal reader": predict(["100", "90.009", "0", "an error", "900000"]),
      "edge-case hunter": predict(["90", "90.009", "0", "An  error", "900000"]),
      verifier: { inputs: [{ input: 1, reasonable: [1, 2] }] },
    };
    const inputs = await pickInputs(subject, yes, options);
    expect(inputs).toEqual([
      { input: "100", readings: ["100", "90"] },
      { input: "100.01", agreed: "90.009" },
      { input: "0", agreed: "0" },
      { input: "-5", agreed: "an error" },
      { input: "1000000", agreed: "900000" },
    ]);
  });

  it("spares the third reader when the first two already disagree, and asks it when they agree", async () => {
    answers = {
      probes: { probes: probes.map((input) => ({ input })) },
      "literal reader": predict(["100", "1", "0", "0", "900000"]),
      "edge-case hunter": predict(["90", "1", "0", "0", "900000"]),
      verifier: { inputs: [{ input: 1, reasonable: [1, 2] }] },
    };
    await pickInputs(subject, yes, options);
    expect(made.some((call) => call.label.endsWith(READERS[2]!.name))).toBe(false);

    made.length = 0;
    answers = {
      probes: { probes: probes.map((input) => ({ input })) },
      "literal reader": predict(["100", "1", "0", "0", "900000"]),
      "edge-case hunter": predict(["100", "1", "0", "0", "900000"]),
      "another domain's reader": predict(["90", "1", "0", "0", "900000"]),
      verifier: { inputs: [{ input: 1, reasonable: [1, 2] }] },
    };
    const inputs = await pickInputs(subject, yes, options);
    expect(made.filter((call) => READERS.some((reader) => call.label.endsWith(reader.name))).map((call) => call.system)).toEqual(READERS.map((reader) => reader.system));
    expect(inputs[0]).toEqual({ input: "100", readings: ["100", "90"] });
  });

  it("drops a reading the verifier finds unreasonable, an input left with one reading being an agreed one", async () => {
    answers = {
      probes: { probes: probes.map((input) => ({ input })) },
      "literal reader": predict(["100", "1", "0", "0", "900000"]),
      "edge-case hunter": predict(["90", "2", "0", "0", "900000"]),
      verifier: { inputs: [{ input: 1, reasonable: [2] }, { input: 2, reasonable: [] }] },
    };
    const inputs = await pickInputs(subject, yes, options);
    expect(inputs).toEqual([
      { input: "100", agreed: "90" },
      { input: "0", agreed: "0" },
      { input: "-5", agreed: "0" },
      { input: "1000000", agreed: "900000" },
    ]);
  });

  it("leaves out an input the functional spec does not settle, whether every reader or the verifier says so", async () => {
    answers = {
      probes: { probes: probes.map((input) => ({ input })) },
      "literal reader": predict(["unspecified", "Unspecified", "0", "0", "900000"]),
      "edge-case hunter": predict(["unspecified", "90.009", "0", "0", "900000"]),
      verifier: { inputs: [{ input: 1, reasonable: [1, 2] }] },
    };
    const inputs = await pickInputs(subject, yes, options);
    expect(inputs.map((input) => input.input)).toEqual(["0", "-5", "1000000"]);
  });

  it("tells a module below's readers the tip its scenarios are tested in", async () => {
    let task = "";
    const { createExecutor } = await import("../../src/pi.ts");
    vi.mocked(createExecutor).mockImplementationOnce(async (opts) => {
      task = (opts as { task: string }).task;
      return { tools: [], label: "x", dispose() {} } as never;
    });
    await classify({ ...subject, testedIn: { module: "checkout", text: "---\nrequires:\n  - shop\n---\n\n***functional specs***\n\n# pay\nPay for the :Basket:." } }, options).catch(() => undefined);
    expect(task).toContain('<module name="checkout">');
    expect(task).toContain("tested against the code of checkout, which is built on shop");
  });

  it("covers the divergence's input as a probe too", async () => {
    answers = {
      probes: { probes: probes.map((input) => ({ input })) },
      "literal reader": predict(["100", "1", "0", "0", "900000", "a"]),
      "edge-case hunter": predict(["100", "1", "0", "0", "900000", "a"]),
      "another domain's reader": predict(["100", "1", "0", "0", "900000", "a"]),
    };
    const inputs = await pickInputs(subject, { ...yes, divergence: { input: "100 EUR", readings: ["100", "90"] } }, options);
    expect(inputs.map((input) => input.input)).toEqual([...probes, "100 EUR"]);
  });

  it("finds a split by the union of the readers, never a majority", () => {
    expect([...splitInputs([["a", "x"], ["a", "x"], ["b", "x"]])]).toEqual([[0, ["a", "b"]]]);
  });
});
