import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MarshalledPlainSource } from "../../src/plain/spec.ts";
import { codeTree, conformanceTarget, isOldRecord, notBuilt, readRecord, RECORD_FILE, writeCodeRecord, writeTestsRecord } from "../../src/regenerate/records.ts";
import { casesOf, codeWork, conceptsUsed, conformanceWork, stillWanted, whyNotWanted } from "../../src/regenerate/drift.ts";
import { REGENERATE_AGAIN } from "../../src/regenerate/records.ts";

/** A functional spec as the parser gives it: its func-id, its body, and its scenarios - acceptance ones here. */
const spec = (id: string, markdown: string, tests: string[] = []) => ({
  id,
  markdown,
  linked_resources: [],
  conformance_tests: [],
  acceptance_tests: tests.map((text, index) => ({ id: `${id}-${index + 1}`, text, linked_resources: [] })),
});
const scenario = (id: string, text: string) => ({ id, text, linked_resources: [] });
/** Functional specs of the codebase's own, by func-id, as notBuilt takes and gives them. */
const refs = (funcIds: string[]) => funcIds.map((funcId) => ({ funcId }));
const item = (markdown: string) => ({ markdown });

/** A small spec: two concepts, one using the other, and three functional specs. */
const shop = (overrides: Partial<Record<string, unknown>> = {}): MarshalledPlainSource =>
  ({
    definitions: [item("- :Price: is the net amount of an :Order:."), item("- :Order: is what a :Customer: buys."), item("- :Customer: is a person with an account.")],
    "implementation reqs": [item("- :Implementation: is Python.")],
    "test reqs": [item("- :ConformanceTests: use pytest.")],
    "functional specs": [
      spec("sign-up", "A :Customer: signs up.", ["Signing up twice fails."]),
      { ...spec("place-order", "A :Customer: places an :Order:."), conformance_tests: [scenario("refused", "An :Order: of nothing is refused.")] },
      spec("show-price", "The :Price: of an :Order: is shown.", ["A price of 10 shows as 10.00."]),
    ],
    ...overrides,
  }) as MarshalledPlainSource;

const fs = (tree: MarshalledPlainSource) => tree["functional specs"] as Array<{ id: string; markdown: string; acceptance_tests?: unknown }>;

describe("the code record", () => {
  it("holds the spec without its test reqs and without the scenarios of the functional specs", () => {
    const tree = codeTree(shop());
    expect(tree["test reqs"]).toBeUndefined();
    expect(fs(tree).every((entry) => entry.acceptance_tests === undefined)).toBe(true);
    expect(fs(tree).map((entry) => entry.markdown)).toEqual(fs(shop()).map((entry) => entry.markdown));
    expect(tree.definitions).toEqual(shop().definitions);
  });

  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "turri-records-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("is written as the code sees the spec, and read back from the file when there is no history", () => {
    writeCodeRecord(join(dir, "code"), shop());
    const written = JSON.parse(readFileSync(join(dir, "code", RECORD_FILE), "utf8")) as MarshalledPlainSource;
    expect(written["test reqs"]).toBeUndefined();
    expect(readRecord(join(dir, "code"))).toEqual(codeTree(shop()));
  });

  it("reads as nothing when there is none", () => {
    expect(readRecord(join(dir, "code"))).toBeNull();
  });

  it("reads a record of the layout before as an old record, which nothing is built on", () => {
    const stored = { version: 2, module: "shop", "functional specs": [{ module: "shop", frid: "1", spec: "- A :Customer: signs up.", unitTests: "passed" }] };
    mkdirSync(join(dir, "code"), { recursive: true });
    writeFileSync(join(dir, "code", RECORD_FILE), JSON.stringify(stored));
    expect(isOldRecord(readRecord(join(dir, "code")))).toBe(true);
  });

  it("reads the first layout of all, a snapshot a functionality, as an old record", () => {
    const stored = { module: "shop", functionalities: { a: { frid: "1", unitTests: "passed", specifications: { "functional specs": ["- A :Customer: signs up."] } } } };
    mkdirSync(join(dir, "code"), { recursive: true });
    writeFileSync(join(dir, "code", RECORD_FILE), JSON.stringify(stored));
    expect(isOldRecord(readRecord(join(dir, "code")))).toBe(true);
  });

  it("reads a record that is no tree - not JSON, a list, nothing - as no record", () => {
    for (const text of ["not json", "[1, 2]", "null"]) {
      mkdirSync(join(dir, "code"), { recursive: true });
      writeFileSync(join(dir, "code", RECORD_FILE), text);
      expect(readRecord(join(dir, "code")), text).toBeNull();
    }
  });

  it("keeps the tests record in the tests folder as it is given", () => {
    const target = conformanceTarget(codeTree(shop()), null, shop());
    writeTestsRecord(join(dir, "tests"), target);
    expect(readRecord(join(dir, "tests"))).toEqual(target);
  });
});

describe("what is not built yet, for the conformance tests", () => {
  const built = codeTree(shop());

  it("is nothing for functional specs the code record has as the spec has them", () => {
    expect(notBuilt(built, shop(), refs(["sign-up", "place-order", "show-price"]))).toEqual(refs([]));
  });

  it("is a functional spec the code record does not have, or has built from other text", () => {
    const now = shop({ "functional specs": [...fs(shop()), spec("cancel-order", "A :Customer: cancels an :Order:.")] });
    fs(now)[1]!.markdown = "A :Customer: places an :Order: and pays for it.";
    expect(notBuilt(built, now, refs(["sign-up", "place-order", "show-price", "cancel-order"]))).toEqual(refs(["place-order", "cancel-order"]));
    expect(notBuilt(null, shop(), refs(["sign-up"]))).toEqual(refs(["sign-up"]));
  });

  it("reads the functional specs of what conformance tests are written for by their func-id, not their place", () => {
    const tested = { "functional specs": [spec("show-price", "The :Price: of an :Order: is shown.")] } as MarshalledPlainSource;
    expect(notBuilt(built, tested, refs(["show-price"]))).toEqual(refs([]));
    expect(notBuilt(built, tested, refs(["sign-up"]))).toEqual(refs(["sign-up"]));
  });

  it("ignores space around a functional spec's text", () => {
    const now = shop();
    fs(now)[0]!.markdown = "  A :Customer: signs up.  ";
    expect(notBuilt(built, now, refs(["sign-up"]))).toEqual(refs([]));
  });
});

describe("the code work", () => {
  it("is everything the spec has when nothing is built - but not its test reqs or scenarios", () => {
    const work = codeWork(null, shop());
    expect(work.some((change) => change.section === "test reqs")).toBe(false);
    expect(work.filter((change) => change.section === "functional specs")).toHaveLength(3);
    expect(work.every((change) => !(change.after ?? "").includes("acceptance_tests"))).toBe(true);
  });

  it("is nothing once the code is built from the spec, whatever its test reqs and scenarios say", () => {
    const record = codeTree(shop());
    const changed = shop({ "test reqs": [item("- :ConformanceTests: use unittest.")] });
    fs(changed)[0]!.acceptance_tests = [scenario("no-email", "Signing up with no email fails.")];
    expect(codeWork(record, changed)).toEqual([]);
  });

  it("is the one functional spec changed, when only it changed", () => {
    const now = shop();
    fs(now)[1]!.markdown = "A :Customer: places an :Order: of one or more items.";
    const work = codeWork(codeTree(shop()), now);
    expect(work).toHaveLength(1);
    expect(work[0]).toMatchObject({ section: "functional specs", kind: "change" });
  });

  it("is a functional spec changed, not one taken out and another added, when its func-id stays - however little of its text does", () => {
    const now = shop();
    fs(now)[1]!.markdown = "Orders are taken at the counter.";
    const work = codeWork(codeTree(shop()), now);
    expect(work.map((change) => change.kind)).toEqual(["change"]);
  });
});

describe("the conformance work", () => {
  it("is every functional spec the code is built from, with its scenarios and the test reqs, when none is tested", () => {
    const work = conformanceWork(null, codeTree(shop()), shop());
    const specs = work.filter((change) => change.section === "functional specs");
    expect(specs).toHaveLength(3);
    expect(specs[0]!.after).toContain("Signing up twice fails.");
    expect(work.some((change) => change.section === "test reqs")).toBe(true);
  });

  it("holds only the functional specs with scenarios - one with an empty test plain file is not tested", () => {
    const now = shop();
    fs(now)[1]!.conformance_tests = [];
    expect(fs(conformanceTarget(codeTree(shop()), null, now)).map((entry) => entry.id)).toEqual(["sign-up", "show-price"]);
  });

  it("takes out the tests of a functional spec whose scenarios were all taken out, as a delete of its tests alone", () => {
    const tested = conformanceTarget(codeTree(shop()), null, shop());
    const now = shop();
    fs(now)[2]!.acceptance_tests = [];
    expect(codeWork(codeTree(shop()), now)).toEqual([]);
    const cases = casesOf(tested, conformanceWork(tested, codeTree(shop()), now));
    expect(cases.delete.map((entry) => entry.funcId)).toEqual(["show-price"]);
    expect([...cases.add, ...cases.patch, ...cases.again]).toEqual([]);
  });

  it("never goes ahead of the code: a functional spec not built yet has no conformance work", () => {
    const code = codeTree(shop({ "functional specs": fs(shop()).slice(0, 2) }));
    expect(fs(conformanceTarget(code, null, shop())).map((entry) => entry.id)).toEqual(["sign-up", "place-order"]);
  });

  it("waits for the code: a functional spec changed in the spec but not yet in the code keeps the tests it has", () => {
    const tested = conformanceTarget(codeTree(shop()), null, shop());
    const now = shop();
    fs(now)[1]!.markdown = "A :Customer: places an :Order: of one or more items.";
    // The code record is still the old one: the change is not built.
    expect(conformanceWork(tested, codeTree(shop()), now)).toEqual([]);
    // Once the code lands, the tests follow.
    const work = conformanceWork(tested, codeTree(now), now);
    expect(work).toHaveLength(1);
    expect(work[0]).toMatchObject({ section: "functional specs", kind: "change" });
  });

  it("keeps the tests of a functional spec regenerated again while its code regenerates, then writes them again for the new code", () => {
    const tested = conformanceTarget(codeTree(shop()), null, shop());
    const marked = (tree: MarshalledPlainSource) => ({ ...tree, "functional specs": fs(tree).map((entry, index) => (index === 1 ? { ...entry, [REGENERATE_AGAIN]: true } : entry)) });
    const testsMarked = marked(tested);
    // While the code is marked, the tests are what they are: conformance follows the code.
    expect(conformanceWork(testsMarked, marked(codeTree(shop())), shop())).toEqual([]);
    // The new code landed - its text the same: the tests were written against the code it replaced, and are work again.
    const work = conformanceWork(testsMarked, codeTree(shop()), shop());
    expect(work).toHaveLength(1);
    expect(casesOf(testsMarked, work).again.map((entry) => entry.funcId)).toEqual(["place-order"]);
  });

  it("is an acceptance scenario changed alone, with no code work for it", () => {
    const tested = conformanceTarget(codeTree(shop()), null, shop());
    const now = shop();
    fs(now)[2]!.acceptance_tests = [scenario("show-price-1", "A price of 10 shows as 10.00 EUR.")];
    expect(codeWork(codeTree(shop()), now)).toEqual([]);
    expect(conformanceWork(tested, codeTree(shop()), now)).toHaveLength(1);
  });
});

describe("a job's cases", () => {
  it("is fresh and adds every functional spec, for a first build of a module that requires none", () => {
    const cases = casesOf({}, codeWork(null, shop()), { fresh: true });
    expect(cases.fresh).toBe(true);
    expect(cases.add.map((entry) => entry.funcId)).toEqual(["sign-up", "place-order", "show-price"]);
    expect(cases.mechanical).toBe(false);
  });

  it("adds a functional spec appended to what is built", () => {
    const built = codeTree(shop());
    const now = shop({ "functional specs": [...fs(shop()), spec("cancel-order", "A :Customer: cancels an :Order:.")] });
    const cases = casesOf(built, codeWork(built, now));
    expect(cases.add).toEqual([{ funcId: "cancel-order", text: "A :Customer: cancels an :Order:." }]);
    expect(cases.patch).toEqual([]);
  });

  it("adds a functional spec put in among those built, and touches none of them", () => {
    const built = codeTree(shop());
    const now = shop({ "functional specs": [fs(shop())[0]!, spec("cancel-order", "A :Customer: cancels an :Order:."), fs(shop())[1]!, fs(shop())[2]!] });
    const cases = casesOf(built, codeWork(built, now));
    expect(cases).toMatchObject({ patch: [], delete: [] });
    expect(cases.add.map((entry) => entry.funcId)).toEqual(["cancel-order"]);
  });

  it("deletes a functional spec taken out, by its func-id", () => {
    const built = codeTree(shop());
    const now = shop({ "functional specs": [fs(shop())[0]!, fs(shop())[2]!] });
    const cases = casesOf(built, codeWork(built, now));
    expect(cases.delete).toEqual([{ funcId: "place-order", text: "A :Customer: places an :Order:." }]);
  });

  it("takes a functional spec moved, its text as it was, for none of add, patch or delete", () => {
    const built = codeTree(shop());
    const now = shop({ "functional specs": [fs(shop())[2]!, fs(shop())[0]!, fs(shop())[1]!] });
    const work = codeWork(built, now);
    expect(work.length).toBeGreaterThan(0);
    expect(casesOf(built, work)).toMatchObject({ add: [], patch: [], delete: [], again: [], mechanical: true });
  });

  it("patches a functional spec moved and changed at once, by its func-id", () => {
    const built = codeTree(shop());
    const now = shop({ "functional specs": [{ ...fs(shop())[2]!, markdown: "The :Price: of an :Order: is shown, with tax." }, fs(shop())[0]!, fs(shop())[1]!] });
    const cases = casesOf(built, codeWork(built, now));
    expect(cases).toMatchObject({ add: [], delete: [] });
    expect(cases.patch.map((entry) => entry.funcId)).toEqual(["show-price"]);
  });

  it("takes a functional spec whose func-id changed for one deleted and one added", () => {
    const built = codeTree(shop());
    const now = shop({ "functional specs": [fs(shop())[0]!, { ...fs(shop())[1]!, id: "order" }, fs(shop())[2]!] });
    const cases = casesOf(built, codeWork(built, now));
    expect(cases.delete.map((entry) => entry.funcId)).toEqual(["place-order"]);
    expect(cases.add.map((entry) => entry.funcId)).toEqual(["order"]);
    expect(cases.patch).toEqual([]);
  });

  it("gives one edit that adds, patches and deletes functional specs at once all three cases", () => {
    const built = codeTree(shop());
    const now = shop({
      "functional specs": [{ ...fs(shop())[0]!, markdown: "A :Customer: signs up with an email." }, fs(shop())[2]!, spec("cancel-order", "A :Customer: cancels an :Order:.")],
    });
    const cases = casesOf(built, codeWork(built, now));
    expect(cases.add.map((entry) => entry.funcId)).toEqual(["cancel-order"]);
    expect(cases.patch.map((entry) => entry.funcId)).toEqual(["sign-up"]);
    expect(cases.delete.map((entry) => entry.funcId)).toEqual(["place-order"]);
    expect(cases.mechanical).toBe(false);
  });

  it("patches every functional spec that uses a concept whose definition changed, directly or through another concept", () => {
    const built = codeTree(shop());
    const now = shop({ definitions: [item("- :Price: is the net amount of an :Order:."), item("- :Order: is what a :Customer: buys, with at least one item."), item("- :Customer: is a person with an account.")] });
    const priceOnly = (tree: MarshalledPlainSource) => ({ ...tree, "functional specs": [...fs(tree).slice(0, 2), spec("show-price", "The :Price: is shown.")] }) as MarshalledPlainSource;
    const cases = casesOf(priceOnly(built), codeWork(priceOnly(built), priceOnly(now)));
    // place-order names :Order:; show-price names only :Price:, whose definition names :Order:. sign-up names only :Customer:.
    expect(cases.patch.map((entry) => entry.funcId)).toEqual(["place-order", "show-price"]);
    expect(cases.mechanical).toBe(false);
  });

  it("regenerates again a functional spec marked to - not a change to it, whatever else changed in its text - and nothing else", () => {
    const built = codeTree(shop());
    const marked = { ...built, "functional specs": fs(built).map((entry, index) => (index === 1 ? { ...entry, [REGENERATE_AGAIN]: true } : entry)) } as MarshalledPlainSource;
    const cases = casesOf(marked, codeWork(marked, shop()));
    expect(cases).toMatchObject({ add: [], patch: [], delete: [], mechanical: false });
    expect(cases.again.map((entry) => entry.funcId)).toEqual(["place-order"]);
    // Regenerated again as it reads now: its text changed as well, it is still regenerated again, not patched.
    const reworded = { ...shop(), "functional specs": fs(shop()).map((entry, index) => (index === 1 ? { ...entry, markdown: `${entry.markdown} Twice.` } : entry)) } as MarshalledPlainSource;
    expect(casesOf(marked, codeWork(marked, reworded)).again.map((entry) => entry.funcId)).toEqual(["place-order"]);
  });

  it("is mechanical when only an implementation req changed", () => {
    const built = codeTree(shop());
    const now = shop({ "implementation reqs": [item("- :Implementation: is Python 3.13.")] });
    const cases = casesOf(built, codeWork(built, now));
    expect(cases).toMatchObject({ add: [], patch: [], delete: [], mechanical: true });
  });

  it("is mechanical for the conformance tests when only the test reqs changed", () => {
    const tested = conformanceTarget(codeTree(shop()), null, shop());
    const now = shop({ "test reqs": [item("- :ConformanceTests: use pytest, one file per functional spec.")] });
    const cases = casesOf(tested, conformanceWork(tested, codeTree(shop()), now));
    expect(cases.mechanical).toBe(true);
  });

  it("patches a functional spec's conformance tests when only its scenarios changed, by its func-id", () => {
    const tested = conformanceTarget(codeTree(shop()), null, shop());
    const now = shop();
    fs(now)[2]!.acceptance_tests = [scenario("show-price-1", "A price of 10 shows as 10.00 EUR.")];
    const cases = casesOf(tested, conformanceWork(tested, codeTree(shop()), now));
    expect(cases.patch.map((entry) => entry.funcId)).toEqual(["show-price"]);
  });

  describe("of the conformance tests, scenario by scenario", () => {
    const tested = conformanceTarget(codeTree(shop()), null, shop());
    const casesFor = (now: MarshalledPlainSource, code = codeTree(shop())) => casesOf(tested, conformanceWork(tested, code, now), { module: "shop" });
    const ids = (scenarios: Array<{ kind: string; id: string }>) => scenarios.map((entry) => `${entry.kind} ${entry.id}`);

    it("lists each scenario added, changed, removed or unchanged, by scenario-id, across the functional specs it touches", () => {
      const now = shop();
      fs(now)[0]!.acceptance_tests = [scenario("sign-up-1", "Signing up twice fails, and says why."), scenario("no-email", "Signing up with no email fails.")];
      fs(now)[1]!.conformance_tests = [];
      fs(now)[1]!.acceptance_tests = [scenario("kept", "An order is kept.")];
      const cases = casesFor(now);
      expect(cases.scenarios!.map((spec) => [spec.funcId, ids(spec.added), ids(spec.changed), ids(spec.removed), ids(spec.unchanged), spec.codeChanged])).toEqual([
        ["sign-up", ["acceptance no-email"], ["acceptance sign-up-1"], [], [], undefined],
        ["place-order", ["acceptance kept"], [], ["conformance refused"], [], undefined],
      ]);
    });

    it("takes a scenario moved between conformance and acceptance, or given another scenario-id, for one removed and one added", () => {
      const now = shop();
      fs(now)[1]!.conformance_tests = [];
      fs(now)[1]!.acceptance_tests = [scenario("refused", "An :Order: of nothing is refused.")];
      fs(now)[2]!.acceptance_tests = [scenario("two-places", "A price of 10 shows as 10.00.")];
      const [placeOrder, showPrice] = casesFor(now).scenarios!;
      expect([ids(placeOrder!.added), ids(placeOrder!.removed)]).toEqual([["acceptance refused"], ["conformance refused"]]);
      expect([ids(showPrice!.added), ids(showPrice!.removed)]).toEqual([["acceptance two-places"], ["acceptance show-price-1"]]);
    });

    it("says the code changed under the unchanged scenarios of a functional spec whose text changed, regenerated again or whose concept changed", () => {
      const reworded = shop();
      fs(reworded)[0]!.markdown = "A :Customer: signs up with an email.";
      expect(casesFor(reworded, codeTree(reworded)).scenarios).toEqual([
        expect.objectContaining({ funcId: "sign-up", unchanged: [{ kind: "acceptance", id: "sign-up-1", text: "Signing up twice fails." }], codeChanged: "text" }),
      ]);
      const redefined = shop({ definitions: [item("- :Price: is the gross amount of an :Order:."), item("- :Order: is what a :Customer: buys."), item("- :Customer: is a person with an account.")] });
      expect(casesFor(redefined, codeTree(redefined)).scenarios!.map((spec) => [spec.funcId, spec.codeChanged])).toEqual([["show-price", "concept"]]);
      const marked = { ...tested, "functional specs": fs(tested).map((entry, index) => (index === 1 ? { ...entry, [REGENERATE_AGAIN]: true } : entry)) } as MarshalledPlainSource;
      expect(casesOf(marked, conformanceWork(marked, codeTree(shop()), shop())).scenarios!.map((spec) => [spec.funcId, spec.codeChanged, ids(spec.unchanged)])).toEqual([
        ["place-order", "again", ["conformance refused"]],
      ]);
    });

    it("lists a functional spec taken out with every scenario removed, and gives a code job none", () => {
      const now = shop({ "functional specs": fs(shop()).slice(0, 2) });
      expect(casesFor(now, codeTree(now)).scenarios!.map((spec) => [spec.funcId, ids(spec.removed)])).toEqual([["show-price", ["acceptance show-price-1"]]]);
      expect(casesOf(codeTree(shop()), codeWork(codeTree(shop()), now)).scenarios).toBeUndefined();
    });
  });

  it("gives every functional spec it touches the module whose codebase it is", () => {
    const built = codeTree(shop());
    const now = shop({ "functional specs": [...fs(shop()), spec("cancel-order", "A :Customer: cancels an :Order:.")] });
    expect(casesOf(built, codeWork(built, now), { module: "shop" }).add).toEqual([{ funcId: "cancel-order", text: "A :Customer: cancels an :Order:.", module: "shop" }]);
  });

  it("names a functional spec by its func-id, wherever it is", () => {
    const now = { "functional specs": [spec("say-hello", "Say hello.")] } as MarshalledPlainSource;
    expect(casesOf({}, codeWork(null, now)).add.map((entry) => entry.funcId)).toEqual(["say-hello"]);
  });

  it("regenerates again a functional spec of a module below marked to, by that module and its func-id", () => {
    const required = (marked: boolean) =>
      ({ "required functional specs": [{ module: "base", id: "sign-in", markdown: "A :Customer: signs in.", ...(marked ? { [REGENERATE_AGAIN]: true } : {}) }] }) as MarshalledPlainSource;
    const cases = casesOf(required(true), codeWork(required(true), required(false)), { module: "shop" });
    expect(cases.again).toEqual([{ funcId: "sign-in", text: "A :Customer: signs in.", module: "base" }]);
  });

  describe("of the functional specs of a module below, built in the tip", () => {
    const below = (specs: Array<{ id: string; markdown: string }>) => specs.map((entry) => ({ module: "base", ...entry, linked_resources: [] }));
    const tip = (specs: Array<{ id: string; markdown: string }>, definitions = [item("- :Customer: is a person with an account.")]) =>
      ({ definitions, "functional specs": [spec("place-order", "A :Customer: places an order.")], "required functional specs": below(specs) }) as MarshalledPlainSource;
    const signUp = { id: "sign-up", markdown: "A :Customer: signs up." };
    const signIn = { id: "sign-in", markdown: "A :Customer: signs in." };

    it("adds, patches and deletes them as the tip's own are, each by its module and func-id - never mechanical", () => {
      const built = codeTree(tip([signUp, signIn]));
      const now = codeTree(tip([{ ...signUp, markdown: "A :Customer: signs up with an email." }, { id: "sign-out", markdown: "A :Customer: signs out." }]));
      const cases = casesOf(built, codeWork(built, now), { module: "shop" });
      expect(cases.add).toEqual([{ funcId: "sign-out", text: "A :Customer: signs out.", module: "base" }]);
      expect(cases.patch).toEqual([{ funcId: "sign-up", text: "A :Customer: signs up with an email.", module: "base" }]);
      expect(cases.delete).toEqual([{ funcId: "sign-in", text: "A :Customer: signs in.", module: "base" }]);
      expect(cases.mechanical).toBe(false);
    });

    it("is mechanical only when no functional spec of any module of the chain is touched", () => {
      const built = codeTree(tip([signUp]));
      const cases = casesOf(built, codeWork(built, { ...tip([signUp]), "implementation reqs": [item("- :Implementation: is Python.")] }), { module: "shop" });
      expect(cases.mechanical).toBe(true);
    });

    it("patches an inherited functional spec that uses a concept redefined, before the tip's own", () => {
      const built = codeTree(tip([signUp, { id: "list-plans", markdown: "Every plan is listed." }]));
      const now = codeTree(tip([signUp, { id: "list-plans", markdown: "Every plan is listed." }], [item("- :Customer: is a person with a verified account.")]));
      const cases = casesOf(built, codeWork(built, now), { module: "shop" });
      expect(cases.patch).toEqual([
        { funcId: "sign-up", text: "A :Customer: signs up.", module: "base" },
        { funcId: "place-order", text: "A :Customer: places an order.", module: "shop" },
      ]);
    });
  });

  it("patches a functional spec once when it changed and a concept it uses did too, all of them in order", () => {
    const built = codeTree(shop());
    const now = shop({
      definitions: [item("- :Price: is the net amount of an :Order:."), item("- :Order: is what a :Customer: buys."), item("- :Customer: is a person with a verified account.")],
    });
    fs(now)[2]!.markdown = "The :Price: of an :Order: is shown, with tax.";
    // show-price changed itself; all three use :Customer: - show-price through :Price: and :Order:.
    expect(casesOf(built, codeWork(built, now)).patch.map((entry) => entry.funcId)).toEqual(["sign-up", "place-order", "show-price"]);
  });

  it("patches a functional spec that uses any one of the concepts redefined, not only one that uses them all", () => {
    const built = codeTree(shop());
    const now = shop({
      definitions: [item("- :Price: is the gross amount of an :Order:."), item("- :Order: is what a :Customer: buys."), item("- :Customer: is a person with a verified account.")],
    });
    // sign-up uses :Customer: alone, not :Price:.
    expect(casesOf(built, codeWork(built, now)).patch.map((entry) => entry.funcId)).toContain("sign-up");
  });

  it("patches its own functional spec for a concept redefined, though one of a module below with that func-id is regenerated again", () => {
    const tree = (marked: boolean, customer: string) =>
      ({
        definitions: [item(`- :Customer: is ${customer}.`)],
        "functional specs": [spec("sign-up", "A :Customer: signs up."), spec("sign-in", "A :Customer: signs in.")],
        "required functional specs": [{ module: "base", id: "sign-in", markdown: "Accounts are kept.", ...(marked ? { [REGENERATE_AGAIN]: true } : {}) }],
      }) as MarshalledPlainSource;
    const cases = casesOf(tree(true, "a person"), codeWork(tree(true, "a person"), tree(false, "a person with an account")), { module: "shop" });
    expect(cases.again).toEqual([{ funcId: "sign-in", text: "Accounts are kept.", module: "base" }]);
    expect(cases.patch.map((entry) => entry.funcId)).toEqual(["sign-up", "sign-in"]);
  });

  it("is not mechanical when it only takes a functional spec out", () => {
    const built = codeTree(shop());
    const now = shop({ "functional specs": fs(shop()).slice(0, 2) });
    expect(casesOf(built, codeWork(built, now)).mechanical).toBe(false);
  });

  it("follows concepts through their definitions, and stops at a cycle", () => {
    const definitions = [item("- :A: is part of a :B:."), item("- :B: holds an :A:."), item("- :C: is on its own.")];
    expect([...conceptsUsed("- Every :A: is shown.", definitions)].sort()).toEqual([":A:", ":B:"]);
  });
});

describe("the stop rule", () => {
  it("lets a running job finish while the spec still wants everything it makes", () => {
    const built = codeTree(shop({ "functional specs": fs(shop()).slice(0, 2) }));
    const running = codeWork(built, shop());
    const now = shop({ "functional specs": [...fs(shop()), spec("cancel-order", "A :Customer: cancels an :Order:.")] });
    expect(stillWanted(running, codeWork(built, now))).toBe(true);
  });

  /** A change, as the stop rule compares them. */
  const made = (section: string, kind: "add" | "remove" | "change", before?: string, after?: string, position = 1) =>
    ({ id: `${section}-${position}`, section, kind, position, ...(before !== undefined ? { before } : {}), ...(after !== undefined ? { after } : {}) }) as never;
  const line = (markdown: string, extra: object = {}) => JSON.stringify({ markdown, ...extra });

  it("wants a change only once: a job that makes it twice, where the spec makes it once, is stopped", () => {
    const add = made("functional specs", "add", undefined, line("Say hello.", { id: "say-hello" }));
    expect(stillWanted([add, add], [add])).toBe(false);
    expect(stillWanted([add], [add, add])).toBe(true);
  });

  it("tells changes apart by their section, their kind and their text before and after alike", () => {
    const mine = made("definitions", "change", line("- :A: is a letter."), line("- :A: is a capital letter."));
    expect(stillWanted([mine], [mine])).toBe(true);
    expect(stillWanted([mine], [made("implementation reqs", "change", line("- :A: is a letter."), line("- :A: is a capital letter."))])).toBe(false);
    expect(stillWanted([mine], [made("definitions", "add", line("- :A: is a letter."), line("- :A: is a capital letter."))])).toBe(false);
    expect(stillWanted([mine], [made("definitions", "change", line("- :A: is a vowel."), line("- :A: is a capital letter."))])).toBe(false);
    expect(stillWanted([mine], [made("definitions", "change", line("- :A: is a letter."), line("- :A: is a small letter."))])).toBe(false);
  });

  it("says why it is stopped: the items that read otherwise now, by section and place, or the files that hold something else", () => {
    const mine = made("functional specs", "add", undefined, line("Say hello.", { id: "say-hello" }), 3);
    const other = made("functional specs", "add", undefined, line("Say hello loudly.", { id: "say-hello" }), 3);
    expect(whyNotWanted([mine], [other])).toBe("functional specs 3 reads otherwise now");
    const two = [mine, made("definitions", "change", line("- :A: is a letter."), line("- :A: is a vowel."), 1)];
    expect(whyNotWanted(two, [other])).toBe("functional specs 3, definitions 1 read otherwise now");
    const linked = (digest: string) => line("- :Api: is the API.", { linked_resources: [{ target: "api.yaml", digest }] });
    const resource = made("definitions", "change", line("- :Api: is the API."), linked("aaa"), 2);
    expect(whyNotWanted([resource], [made("definitions", "change", line("- :Api: is the API."), linked("bbb"), 2)])).toBe("api.yaml holds something else now");
    expect(whyNotWanted([mine], [mine])).toBe("the spec it was building from changed");
  });

  it("stops a running job once the spec no longer wants something it makes", () => {
    const built = codeTree(shop({ "functional specs": fs(shop()).slice(0, 2) }));
    const running = codeWork(built, shop());
    const now = shop();
    fs(now)[2]!.markdown = "The :Price: of an :Order: is shown, with tax.";
    expect(stillWanted(running, codeWork(built, now))).toBe(false);
  });
});
