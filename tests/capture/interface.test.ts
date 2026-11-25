import { describe, expect, it } from "vitest";
import type { Surface } from "../../src/capture/map.ts";
import { interfaceConcept, interfaceDefinition, namedIn, optionsNotInReference, renderReference } from "../../src/capture/interface.ts";
import type { InterfaceEntry } from "../../src/capture/state.ts";

const option = (name: string): Surface => ({ kind: "option", name });
const command = (name: string): Surface => ({ kind: "command", name });
const route = (name: string): Surface => ({ kind: "route", name });
const env = (name: string): Surface => ({ kind: "env", name });

describe("whether the ***plain names a surface of the code", () => {
  it("names an option by itself, never by a longer one, and one with a short form by its long one", () => {
    expect(namedIn(option("--proxy"), "`--proxy=http:http://10.0.0.1:3128` sends requests through the proxy.")).toBe(true);
    expect(namedIn(option("--proxy"), "`--proxy-all` and `--no-proxy` are refused.")).toBe(false);
    expect(namedIn(option("-v, --verbose"), "`--verbose` prints the request too.")).toBe(true);
    expect(namedIn(option("-q"), "Under `-qq` nothing is printed.")).toBe(false);
  });

  it("names an environment variable as a word of its own", () => {
    expect(namedIn(env("HTTPIE_CONFIG_DIR"), "`$HTTPIE_CONFIG_DIR`, else `$XDG_CONFIG_HOME/httpie`.")).toBe(true);
    expect(namedIn(env("HTTPIE_CONFIG"), "`HTTPIE_CONFIG_DIR` names it.")).toBe(false);
  });

  it("names a command as a word of its own", () => {
    expect(namedIn(command("upgrade"), "`httpie cli sessions upgrade HOST SESSION` rewrites the file.")).toBe(true);
    expect(namedIn(command("upgrade"), "`httpie cli sessions upgrade-all` rewrites every file.")).toBe(false);
  });

  it("names a route by its path, whatever its method, under a prefix, its parameters written any way", () => {
    expect(namedIn(route("GET /notes"), "`POST /notes` adds a :Note:.")).toBe(true);
    expect(namedIn(route("GET /notes"), "`GET /api/notes` answers every :Note:.")).toBe(true);
    expect(namedIn(route("DELETE /notes/<int:note_id>"), "`DELETE /notes/{id}` deletes it.")).toBe(true);
    expect(namedIn(route("GET /notes/:id"), "Fetching `/notes/42` answers the :Note:.")).toBe(true);
    expect(namedIn(route("/notes/(?P<pk>[0-9]+)/"), "`GET /notes/<pk>/` answers it.")).toBe(true);
    expect(namedIn(route("resources notes"), "`GET /notes` lists them.")).toBe(true);
  });

  it("never takes a longer path, or a path inside a word, for a route", () => {
    expect(namedIn(route("GET /notes"), "`GET /notes/{id}` answers one :Note:.")).toBe(false);
    expect(namedIn(route("GET /notes"), "`GET /notebooks` lists them.")).toBe(false);
    expect(namedIn(route("DELETE /notes/<int:note_id>"), "`GET /notes` lists them.")).toBe(false);
    expect(namedIn(route("GET /"), "Its home page answers at `/`.")).toBe(true);
    expect(namedIn(route("GET /"), "Notes and/or tags are listed at `/notes`.")).toBe(false);
  });
});

const entry = (over: Partial<InterfaceEntry>): InterfaceEntry => ({ kind: "option", name: "", aliases: [], choices: [], details: [], where: "cli.py:1", also: [], ...over });
const HTTPIE: InterfaceEntry[] = [
  entry({ kind: "command", name: "http", help: "HTTPie: a CLI, cURL-like tool for humans." }),
  entry({ kind: "argument", name: "URL", command: "http", help: "The request URL." }),
  entry({ name: "--proxy", aliases: ["-x"], command: "http", takes: "PROTOCOL:PROXY_URL", repeatable: true, help: "String mapping\n  protocol to the proxy." }),
  entry({ name: "--ssl", command: "http", choices: ["ssl2.3", "tls1.2"] }),
  entry({ name: "--history-print", command: "http", hidden: true }),
  entry({ kind: "env", name: "HTTPIE_CONFIG_DIR", default: "~/.config/httpie" }),
];

describe("a part's interface reference", () => {
  it("lists every piece exactly - each command with its arguments and options, every name, what it takes, choices, default and help", () => {
    expect(renderReference("httpie", HTTPIE)).toBe(
      [
        "# The interface of httpie",
        "",
        "Every command, argument, option, route and environment variable a user, a client or a script calls - exactly as the original defines them, taken from its code: every name, what each takes, its choices, its default and its help, word for word. What each does is in the ***plain's functional specs.",
        "",
        "## `http`",
        "",
        "help: HTTPie: a CLI, cURL-like tool for humans.",
        "",
        "### Arguments",
        "",
        "- `URL`",
        "  - help: The request URL.",
        "",
        "### Options",
        "",
        "- `--proxy` - also `-x`; takes `PROTOCOL:PROXY_URL`; repeatable",
        "  - help: String mapping protocol to the proxy.",
        "- `--ssl` - one of `ssl2.3`, `tls1.2`",
        "- `--history-print` - hidden from its help",
        "",
        "## Environment variables",
        "",
        "- `HTTPIE_CONFIG_DIR` - default `~/.config/httpie`",
        "",
      ].join("\n"),
    );
  });

  it("is linked by a concept of the part's, named after it", () => {
    expect([interfaceConcept("httpie"), interfaceConcept("short-links")]).toEqual([":HttpieInterface:", ":ShortLinksInterface:"]);
    expect(interfaceDefinition("short-links")).toContain(":ShortLinksInterface: is every command, argument, option, route and environment variable of short-links a user, a client or a script calls, each exactly as [its interface reference](resources/interface/short-links.md) lists it");
  });

  it("finds the options the ***plain names that the code does not define", () => {
    expect(optionsNotInReference("`--proxy` and `-x`, `--timeout=3`, and `--ssl`.", HTTPIE)).toEqual(["--timeout"]);
  });
});

describe("whether the ***plain names an argument", () => {
  it("names it as a word of its own", () => {
    expect(namedIn({ kind: "argument", name: "REQUEST_ITEM" }, "Each `REQUEST_ITEM` is parsed.")).toBe(true);
    expect(namedIn({ kind: "argument", name: "URL" }, "The `URLS` file.")).toBe(false);
  });
});
