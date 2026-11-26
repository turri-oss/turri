import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { correctionProblems, divisionProblems, editProblems, featureProblems, gapProblems, moduleProblems, referenceProblems, scenarioBudget, splitProblems, surveyProblems, trialProblems } from "../../src/capture/checks.ts";
import { buildMap } from "../../src/capture/map.ts";
import type { CapturedFeature, InterfaceEntry, Survey } from "../../src/capture/state.ts";
import { writeCodebase } from "./fixture.ts";
import { capturedText } from "../../src/capture/assemble.ts";
import { createEnvironment } from "../../src/plain/liquid.ts";

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function map() {
  const root = writeCodebase();
  made.push(root);
  return buildMap(root);
}

const part = { name: "notes", about: "notes", paths: ["."], stdlibStack: "stdlib/backend/python-flask", stdlibConformance: true, implementationReqs: [], testReqs: [], definitions: [{ concept: ":Note:", text: ":Note: is a short text." }] };

describe("what capture checks of an answer", () => {
  it("keeps literal Liquid examples readable and round-trips them rather than executing them", () => {
    const liquid = createEnvironment({ strictVariables: true, loadTemplateSource: () => { throw new Error("a captured example is not an import"); } });
    for (const sample of ["`{% assign %}` then `{{ name }}`", "`{% include 'example' %}`", "literal {% raw %} and {% endraw %}", "open {{\non the next line }}", "plain text"]) {
      expect(liquid.parseAndRenderSync(capturedText(sample))).toBe(sample);
    }
  });
  it("refuses a survey that leaves the original's tests out, names a stack the library lacks, or uses a concept it never defines", () => {
    const survey: Survey = {
      parts: [{ ...part, stdlibStack: "stdlib/backend/python-bottle", implementationReqs: [":Implementation: keeps every :Memo: in SQLite."] }],
      leftOut: [{ path: "tests", why: "unit tests" }],
      assumptions: [],
    };
    const problems = surveyProblems(map(), survey).join("\n");
    expect(problems).toContain("Left out tests: it holds the original's tests");
    expect(problems).toContain("stdlib/backend/python-bottle is not a stack of the standard library");
    expect(problems).toContain(":Memo:, which is not defined");
    expect(surveyProblems(map(), { parts: [part], leftOut: [{ path: "README.md", why: "docs" }], assumptions: [] })).toEqual([]);
  });

  it("refuses a convention not settled from the code - no file named, or one not in the map - and one that uses a concept it never defines", () => {
    const conventions = [
      { text: "A usage error prints the usage and the message to standard error and exits with 1.", where: [] },
      { text: "An error answers a :Problem: body.", where: ["app/errors.py"] },
      { text: "A request with no text answers 400.", where: ["app/routes.py"] },
    ];
    const problems = surveyProblems(map(), { parts: [{ ...part, conventions }], leftOut: [], assumptions: [] });
    expect(problems).toEqual([
      "Part notes: convention 1: name in where the files whose code decides it - a convention is settled from the code that does it.",
      "Part notes: convention 2: app/errors.py is no file or folder in the map.",
      "Part notes: convention 2 uses :Problem:, which is not defined: use a concept you were given, or define it.",
    ]);
  });

  it("gives a feature more scenarios the more lines of the original's tests it has, up to a most", () => {
    expect([scenarioBudget(0), scenarioBudget(49), scenarioBudget(583), scenarioBudget(5000)]).toEqual([8, 8, 19, 30]);
    const scenario = (at: number) => ({ id: `case-${at}`, text: "Adding a :Note: answers 201." });
    const captured: CapturedFeature = { specs: [{ funcId: "add-note", text: "A :Note: can be added.", conformance: Array.from({ length: 10 }, (_, at) => scenario(at)), acceptance: [] }], definitions: [], assumptions: [], uncertain: [], dropped: [] };
    expect(featureProblems(captured, [{ concept: ":Note:", text: ":Note: is a short text." }])).toEqual([
      "10 scenarios is more than your 8: keep those of the functional specs the original tests most, and those that can fail silently, be read two ways, or cost dearly when wrong.",
    ]);
    expect(featureProblems(captured, [{ concept: ":Note:", text: ":Note: is a short text." }], scenarioBudget(150))).toEqual([]);
  });

  it("refuses a division that leaves a feature with no owner line, merges one into itself, into another merged one or into nothing", () => {
    const keys = ["cli/args#auth-options", "cli/args#urls", "net/auth#basic-auth", "net/auth#digest"];
    expect(
      divisionProblems(keys, {
        owns: [
          { feature: "cli/args#urls", owns: "URLs and their defaults." },
          { feature: "net/auth#basic-auth", owns: "--auth, --auth-type and how credentials are sent." },
        ],
        merged: [{ feature: "cli/args#auth-options", into: ["net/auth#basic-auth"], why: "the options of what basic-auth does" }],
      }),
    ).toEqual(["Say what each feature owns, or merge it: net/auth#digest."]);
    expect(
      divisionProblems(keys, {
        owns: [{ feature: "net/auth#nope", owns: "x" }],
        merged: [
          { feature: "cli/args#auth-options", into: ["cli/args#auth-options"], why: "x" },
          { feature: "cli/args#urls", into: ["cli/args#auth-options"], why: "x" },
          { feature: "net/auth#digest", into: [], why: "" },
        ],
      }),
    ).toEqual([
      "net/auth#nope is no feature of the part: use the keys as listed.",
      "cli/args#auth-options is merged into itself.",
      "cli/args#urls is merged into cli/args#auth-options, which is merged too: name the features its behaviour ends up in.",
      "net/auth#digest is merged into nothing: name the features that take its behaviour.",
      "Say why net/auth#digest is merged.",
      "Say what each feature owns, or merge it: net/auth#basic-auth.",
    ]);
  });

  it("refuses a split that leaves files nowhere or makes an area as large as the whole", () => {
    const problems = splitProblems(map(), ["."], { areas: [{ name: "all", about: "", paths: ["."] }, { name: "api", about: "", paths: ["app/routes.py"] }], leftOut: [] }).join("\n");
    expect(problems).toContain("it is the whole of your area");
    expect(problems).toContain("share app/routes.py");
    expect(splitProblems(map(), ["app"], { areas: [{ name: "api", about: "", paths: ["app/routes.py"] }, { name: "storage", about: "", paths: ["app/models.py"] }], leftOut: [] }).join("\n")).toContain(
      "These files are in no area and not left out - place each: app/__init__.py, app/static/logo.png",
    );
  });

  it("refuses a feature past its budget, with a heading in its text or a concept it does not define", () => {
    const spec = (funcId: string, text: string) => ({ funcId, text, conformance: [], acceptance: [] });
    const captured: CapturedFeature = {
      specs: [spec("add-note", "A :User: adds a :Note:.\n# not a heading"), ...Array.from({ length: 8 }, (_, at) => spec(`spec-${at}`, "x".repeat(at === 0 ? 1600 : 10)))],
      definitions: [{ concept: ":Note:", text: ":Note: again." }],
      assumptions: [],
      uncertain: [],
      dropped: [],
    };
    const problems = featureProblems(captured, [{ concept: ":Note:", text: ":Note: is a short text." }]).join("\n");
    expect(problems).toContain("9 functional specs is more than 8");
    expect(problems).toContain(":Note: is given already");
    expect(problems).toContain('Functional spec add-note has a line starting with "# "');
    expect(problems).toContain("Functional spec add-note uses :User:, which is not defined");
    expect(problems).toContain("Functional spec spec-0 is 1600 characters");
  });

  it("refuses a link the parser would refuse - an autolink or a Markdown link - and lets an address written as code or bare through", () => {
    const captured: CapturedFeature = {
      specs: [
        {
          funcId: "manager-help",
          text: "`httpie --help` names the manager's docs (<https://httpie.io/docs#manager>).",
          conformance: [{ id: "docs-link", text: "The help names [the docs](https://httpie.io/docs)." }],
          acceptance: [],
        },
        { funcId: "update-warning", text: "The warning ends with `https://httpie.io/docs/cli/<channel>`, or https://httpie.io/docs bare.", conformance: [], acceptance: [] },
      ],
      definitions: [{ concept: ":BuildChannel:", text: ":BuildChannel: is how HTTPie was installed, as <https://packages.httpie.io/latest.json> names it." }],
      assumptions: [],
      uncertain: [],
      dropped: [],
    };
    expect(featureProblems(captured, [])).toEqual([
      "The definition of :BuildChannel: has a link, <https://packages.httpie.io/latest.json>, which ***plain refuses: its links name files of the project. Write the address as code instead: `https://packages.httpie.io/latest.json`.",
      "Functional spec manager-help has a link, <https://httpie.io/docs#manager>, which ***plain refuses: its links name files of the project. Write the address as code instead: `https://httpie.io/docs#manager`.",
      "Functional spec manager-help, scenario docs-link has a link, [the docs](https://httpie.io/docs), which ***plain refuses: its links name files of the project. Write the address as code instead: `https://httpie.io/docs`.",
    ]);
    expect(editProblems("manager-help", "Names <https://httpie.io/docs#manager>.", "`httpie --help` names the manager's docs.", new Set())[0]).toMatch(/^The new text of manager-help has a link/);
  });

  it("takes an interface reference only as the code has it - every name, choice, default and help found where it cites - and whole", () => {
    const root = writeCodebase({
      "cli/definition.py": [
        'parser.add_argument("--proxy", "-x", default=[], action="append", metavar="PROTOCOL:PROXY_URL", help="""',
        "    String mapping protocol to the URL of the proxy",
        "    (e.g. http:http://foo.bar:3128).",
        '""")',
        'parser.add_argument("--ssl", choices=sorted(SSL_VERSIONS), help="The desired protocol version " "to use.")',
        'parser.add_argument("--timeout", type=float, default=0, help="The connection timeout of the request in seconds.")',
        "",
      ].join("\n"),
      "cli/constants.py": 'SSL_VERSIONS = {"ssl2.3": 1, "tls1": 2, "tls1.2": 3}\n',
    });
    made.push(root);
    const codeMap = buildMap(root);
    const option = (over: Partial<InterfaceEntry>): InterfaceEntry => ({ kind: "option", name: "", aliases: [], choices: [], details: [], where: "cli/definition.py:1", also: [], ...over });
    const proxy = option({ name: "--proxy", aliases: ["-x"], takes: "PROTOCOL:PROXY_URL", repeatable: true, help: "String mapping protocol to the URL of the proxy (e.g. http:http://foo.bar:3128)." });
    const ssl = option({ name: "--ssl", choices: ["ssl2.3", "tls1", "tls1.2"], help: "The desired protocol version to use.", where: "cli/definition.py:5", also: ["cli/constants.py"] });
    const timeout = option({ name: "--timeout", takes: "float", default: "0", where: "cli/definition.py:6" });
    expect(referenceProblems(codeMap, root, ["cli/definition.py"], { entries: [proxy, ssl, timeout], excluded: [] })).toEqual([]);

    const problems = referenceProblems(codeMap, root, ["cli/definition.py"], {
      entries: [
        { ...proxy, help: "The proxy to use." },
        { ...ssl, choices: [...ssl.choices, "tls1.3"], also: [] },
        { ...timeout, where: "cli/definition.py:99" },
      ],
      excluded: [],
    });
    expect(problems).toEqual([
      "Entry 1, `--proxy`: `the proxy to use.` is not in cli/definition.py. Give each exactly as the code has it - a help text word for word - and name in also the files where one is worked out: never one the code does not have.",
      "Entry 2, `--ssl`: `ssl2.3`, `tls1`, `tls1.2`, `tls1.3` are not in cli/definition.py. Give each exactly as the code has it - a help text word for word - and name in also the files where one is worked out: never one the code does not have.",
      "Entry 3, `--timeout`: cli/definition.py has no line 99.",
    ]);
    // Whole: what the map found in the files given is listed, or excluded with why.
    expect(referenceProblems(codeMap, root, ["cli/definition.py"], { entries: [proxy, ssl], excluded: [] })).toEqual([
      "Neither listed nor excluded, of what the map found in your files: `--timeout` (option, cli/definition.py). List each - or exclude it, by name, with why, when it is not the software's interface.",
    ]);
    expect(referenceProblems(codeMap, root, ["cli/definition.py"], { entries: [proxy, ssl], excluded: [{ name: "--timeout", path: "cli/definition.py", why: "" }] })).toEqual(["Say why `--timeout` is not the software's interface."]);
  });

  it("refuses a feature written for the interface no feature captured that leaves a surface neither captured nor dropped with why", () => {
    const captured: CapturedFeature = {
      specs: [{ funcId: "proxies", text: "`--proxy=PROTOCOL:URL` sends that protocol's requests through `URL`; it can be given once a protocol.", conformance: [], acceptance: [] }],
      definitions: [],
      assumptions: [],
      uncertain: [],
      dropped: ["`--min-speed` is an option of the benchmark script in extras/, not of HTTPie."],
    };
    const surfaces = [
      { path: "httpie/cli/definition.py", kind: "option" as const, name: "--proxy" },
      { path: "extras/profiling/run.py", kind: "option" as const, name: "--min-speed" },
      { path: "httpie/config.py", kind: "env" as const, name: "HTTPIE_CONFIG_DIR" },
    ];
    expect(gapProblems(captured, surfaces)).toEqual([
      "Neither captured nor dropped: `HTTPIE_CONFIG_DIR` (environment variable, httpie/config.py). Capture each exactly, by the name the code gives it - or, when it is not the software's interface, name it in dropped with why.",
    ]);
    expect(gapProblems(captured, surfaces.slice(0, 2))).toEqual([]);
  });

  it("refuses a correction of the interface to a functional spec or scenario that is not there, with no why, or one that would not parse", () => {
    const spec = { funcId: "ssl-version", text: "`--ssl` takes `tls1.3` too.", conformance: [{ id: "tls12", text: "`--ssl=tls1.2` connects." }], acceptance: [] };
    const specs = new Map([[spec.funcId, spec]]);
    expect(correctionProblems([{ funcId: "ssl-version", text: "`--ssl` takes `ssl2.3`, `tls1`, `tls1.1` or `tls1.2`.", why: "httpie/ssl_.py keeps only the versions with a PROTOCOL_ constant." }], specs, new Set())).toEqual([]);
    expect(correctionProblems([{ funcId: "ssl-version", scenarioId: "tls12", text: "`--ssl=tls1.2` connects to a server that speaks TLS 1.2.", why: "the scenario's server" }], specs, new Set())).toEqual([]);
    expect(
      correctionProblems(
        [
          { funcId: "ssl-versions", text: "x", why: "y" },
          { funcId: "ssl-version", scenarioId: "tls13", text: "`--ssl=tls1.3` is refused.", why: "" },
          { funcId: "ssl-version", text: "See <https://docs.python.org/3/library/ssl.html>.", why: "the docs" },
        ],
        specs,
        new Set(),
      ),
    ).toEqual([
      "There is no functional spec ssl-versions among those you were given.",
      "ssl-version has no scenario tls13.",
      "The correction of ssl-version's scenario tls13: say why, from the code.",
      "The correction of ssl-version has a link, <https://docs.python.org/3/library/ssl.html>, which ***plain refuses: its links name files of the project. Write the address as code instead: `https://docs.python.org/3/library/ssl.html`.",
    ]);
  });

  it("refuses definitions that use each other in a circle, which the parser refuses", () => {
    const survey: Survey = {
      parts: [{ ...part, definitions: [{ concept: ":Link:", text: ":Link: is a URL with its :LinkCode:." }, { concept: ":LinkCode:", text: ":LinkCode: is 7 letters, unique among :Link: items." }] }],
      leftOut: [],
      assumptions: [],
    };
    expect(surveyProblems(map(), survey)).toEqual(["Part notes: The definitions of :Link:, :LinkCode: use each other in a circle, which ***plain refuses: define one without naming the other."]);
    const feature: CapturedFeature = { specs: [{ funcId: "add-note", text: "A :Note: has a :NoteTag:.", conformance: [], acceptance: [] }], definitions: [{ concept: ":NoteTag:", text: ":NoteTag: labels one :Note:." }], assumptions: [], uncertain: [], dropped: [] };
    expect(featureProblems(feature, [{ concept: ":Note:", text: ":Note: is a short text with a :NoteTag:." }]).join("\n")).toContain("The definitions of");
  });

  it("refuses a readability edit that makes a functional spec longer", () => {
    expect(editProblems("add-note", "A :Note: is added, and kept, and shown, and counted, and sorted, and filtered, and so on and on and on.", "A :Note: is added.", new Set([":Note:"]))[0]).toMatch(/longer than the original/);
    expect(editProblems("add-note", "A :Note: is added.", "Any :Note: can be added by anyone.", new Set([":Note:"]))).toEqual([]);
  });
});

const SEND = { funcId: "send-request", text: "`http URL` sends a GET request and prints the response.", conformance: [{ id: "get-json", text: "`http :8000/json` prints the response's JSON body." }], acceptance: [] };
const FORMAT = {
  funcId: "format-json",
  text: "A JSON body is printed indented.",
  conformance: [{ id: "indented", text: "`http :8000/json` prints the body indented by four spaces." }],
  acceptance: [{ id: "follow-then-format", text: "`http --follow :8000/redirect` prints the final body indented." }],
};

/** Two modules of httpie as their trials are checked: what each holds, and the concepts each may use. */
function modules() {
  return new Map([
    ["request-execution", { specs: new Map([[SEND.funcId, SEND]]), known: new Set<string>() }],
    ["output-formatting", { specs: new Map([[FORMAT.funcId, FORMAT]]), known: new Set<string>() }],
  ]);
}

/** Three features of httpie, one area's, as their gathering into modules is checked. */
function gathering(moduleSpecs = 40) {
  return {
    features: new Map([
      ["httpie/core#send-request", [SEND]],
      ["httpie/core#format-json", [FORMAT]],
      ["httpie/core#sessions", [{ funcId: "keep-session", text: "`--session NAME` keeps the headers sent.", conformance: [], acceptance: [] }]],
    ]),
    known: new Set<string>(),
    reserved: new Set(["httpie-shared"]),
    moduleSpecs,
  };
}

describe("what capture checks of a part's features gathered into modules", () => {
  it("takes every feature in one module, each module needing only those before it, and a scenario rewritten to need none after it", () => {
    expect(
      moduleProblems(
        {
          modules: [
            { name: "request-execution", about: "Sending a request and printing what it answers.", features: ["httpie/core#send-request"], needs: [] },
            { name: "output-formatting", about: "How what is printed is formatted.", features: ["httpie/core#format-json"], needs: ["request-execution"] },
            { name: "sessions", about: "Keeping what was sent between runs.", features: ["httpie/core#sessions"], needs: ["request-execution"] },
          ],
          rewrites: [{ feature: "httpie/core#format-json", funcId: "format-json", scenarioId: "follow-then-format", text: "`http :8000/json` prints the final body indented.", why: "following redirects is request-execution's" }],
        },
        gathering(),
      ),
    ).toEqual([]);
  });

  it("refuses a feature in no module or two, a name taken twice or an import module's, a module needing one after it, and a rewrite that is no scenario", () => {
    const problems = moduleProblems(
      {
        modules: [
          { name: "output-formatting", about: "How it prints.", features: ["httpie/core#format-json", "httpie/core#send-request"], needs: ["request-execution", "output-formatting"] },
          { name: "httpie-shared", about: "Everything else.", features: ["httpie/core#send-request", "httpie/core#downloads"], needs: [] },
          { name: "request-execution", about: "", features: [], needs: [] },
        ],
        rewrites: [
          { feature: "httpie/core#format-json", funcId: "format-json", scenarioId: "gone", text: "x", why: "y" },
          { feature: "httpie/core#downloads", funcId: "download", scenarioId: "resume", text: "x", why: "y" },
        ],
      },
      gathering(),
    );
    expect(problems).toEqual([
      "Module httpie-shared: httpie-shared is the name of an import module - name the concern.",
      "Module httpie-shared: httpie/core#send-request is in another module too - a feature is in one module.",
      "Module httpie-shared: httpie/core#downloads is no feature of the part - name each by its key, as listed.",
      "Module request-execution: its about is empty.",
      "Module request-execution holds no feature: give it its features, or leave it out.",
      "Put every feature in a module: httpie/core#sessions is in none.",
      "output-formatting needs request-execution, which comes after it: put request-execution first - or, when request-execution needs output-formatting too, rewrite the scenarios of one that need the other.",
      "output-formatting needs itself: name only the modules before it.",
      "httpie/core#format-json: format-json has no scenario gone.",
      "The rewrite of download's scenario resume: httpie/core#downloads is no feature of the part.",
    ]);
  });

  it("refuses one module holding a part too large for one, and a module past twice the most a module holds", () => {
    const all = ["httpie/core#send-request", "httpie/core#format-json", "httpie/core#sessions"];
    expect(moduleProblems({ modules: [{ name: "httpie", about: "Everything.", features: all, needs: [] }], rewrites: [] }, gathering(2))).toEqual([
      "One module holding all 3 functional specs is the code again, unread and regenerated whole on every change: gather them by concern.",
    ]);
    expect(
      moduleProblems(
        {
          modules: [
            { name: "core", about: "Sending and printing.", features: all.slice(0, 2), needs: [] },
            { name: "sessions", about: "Sessions.", features: all.slice(2), needs: ["core"] },
          ],
          rewrites: [],
        },
        gathering(0.5),
      ),
    ).toEqual(["Module core holds 2 functional specs, more than a person reads in one file: split it by concern."]);
  });
});

describe("what capture checks of scenarios tried on the original", () => {
  const given = [
    { funcId: "format-json", scenarioId: "indented", text: "`http :8000/json` prints the body indented by four spaces." },
    { funcId: "format-json", scenarioId: "follow-then-format", text: "`http --follow :8000/redirect` prints the final body indented." },
  ];
  const module = modules().get("output-formatting")!;

  it("takes every scenario once, each held or corrected on what was run, the rest with why", () => {
    expect(
      trialProblems(
        {
          results: [
            { funcId: "format-json", scenarioId: "indented", outcome: "corrected", ran: "http --pretty=format :8000/json: indented by 4", text: "`http --pretty=format :8000/json` prints the body indented by four spaces.", why: "output is not a terminal in the test: no formatting unless asked" },
            { funcId: "format-json", scenarioId: "follow-then-format", outcome: "untried", ran: "", why: "no redirecting server would start" },
          ],
          specs: [],
          testReqs: [":ConformanceTests: run `http` with `COLUMNS=80`."],
        },
        given,
        module,
      ),
    ).toEqual([]);
  });

  it("refuses a scenario with no result or two, one it was not given, one held on nothing run, a correction to the same text, and one removed with no why", () => {
    const problems = trialProblems(
      {
        results: [
          { funcId: "format-json", scenarioId: "indented", outcome: "held", ran: "" },
          { funcId: "format-json", scenarioId: "indented", outcome: "corrected", ran: "ran it", text: "`http :8000/json` prints the body indented by four spaces.", why: "same" },
          { funcId: "format-json", scenarioId: "colours", outcome: "held", ran: "ran it" },
          { funcId: "send-request", scenarioId: "get-json", outcome: "removed", ran: "" },
        ],
        specs: [{ funcId: "format-json", text: "See <https://httpie.io/docs>.", why: "the docs" }],
        testReqs: ["- two\nlines"],
      },
      given,
      module,
    );
    expect(problems).toEqual([
      "Scenario indented of format-json: say in ran what you ran against the original and what it answered - a scenario holds, or is corrected, on what the original did, never on reading its code.",
      "Scenario indented of format-json has two results: give it one.",
      "Scenario indented of format-json is corrected to the text it had: it held.",
      "Scenario colours of format-json is not among those you were given: name each by its func-id and scenario-id as listed.",
      "Scenario get-json of send-request is not among those you were given: name each by its func-id and scenario-id as listed.",
      "Try every scenario you were given - these have no result: format-json/follow-then-format.",
      "The correction of format-json has a link, <https://httpie.io/docs>, which ***plain refuses: its links name files of the project. Write the address as code instead: `https://httpie.io/docs`.",
      "Test req 1 is more than one line: one fact a bullet, on one line.",
    ]);
  });

  it("refuses a test req that is some scenarios' setup - naming a scenario or a functional spec - which goes in their own text", () => {
    const problems = trialProblems(
      {
        results: [
          { funcId: "format-json", scenarioId: "indented", outcome: "held", ran: "http --pretty=format :8000/json: indented by 4" },
          { funcId: "format-json", scenarioId: "follow-then-format", outcome: "held", ran: "http --follow :8000/redirect: indented" },
        ],
        specs: [],
        testReqs: [
          ":ConformanceTests: run the follow-then-format scenario against a local server that redirects once.",
          ":ConformanceTests: create `data.json` for the format-json scenarios.",
          ":ConformanceTests: run `http` with `COLUMNS=80` and `--pretty=format` where indented output is checked.",
        ],
      },
      given,
      module,
    );
    expect(problems).toEqual([
      "Test req 1 names `follow-then-format`: what some scenarios need is set up in their own text - correct each to say it. A test req is what every conformance test of the part sets up.",
      "Test req 2 names `format-json`: what some scenarios need is set up in their own text - correct each to say it. A test req is what every conformance test of the part sets up.",
    ]);
  });
});
