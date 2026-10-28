import { existsSync, readFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { advisorModel, configForSpec, readProjectConfig, stackOf, testDirOf } from "../config.ts";
import { plainFileParser } from "../plain/parser.ts";
import { FUNCTIONAL_REQUIREMENTS, REQUIRED_FUNCTIONAL_SPECS, type FunctionalSpecItem } from "../plain/spec.ts";
import { isStdlibModule } from "../plain/stdlib.ts";
import { outsideJobs, withStopSignal } from "./activity.ts";
import {
  advisorEntry,
  isCurrent,
  keptInStep,
  pendingEntries,
  personsScenarios,
  putAdvisorEntry,
  removeAdvisorEntry,
  scenariosOf,
  textHash,
  type AdvisorEntry,
  type AdvisorReport,
  type AdvisorScenario,
} from "./advisor-records.ts";
import { firstLine, record } from "./ledger.ts";
import type { SeenSpec } from "./loop.ts";
import { buildDirUnder, modulesRoot, projectDirOf, resolveTemplateDirs } from "./paths.ts";
import { readRecord } from "./records.ts";
import { advise as adviseByModel, type AdvisorCallOptions, type AdvisorSubject } from "./test-advisor.ts";

/**
 * When the test advisor runs, and on what (docs/test-advisor.md). It watches what the work loop looks at - every
 * ***plain change the loop sees, as it sees it - and takes each functional spec that is new or whose text changed since
 * its code was built (its code record), has no scenarios of the person's, and has no entry in the advisor's file for
 * that text. A project already built, with no advisor file, is looked at not at all: only what changes from now on is.
 *
 * Each is marked `pending` in the advisor's file then and there, and judged in the background - two at a time at most,
 * outside `parallel-jobs` and the lanes: no pulse waits for it, and it never steers or stops one. Its work is clear of
 * any pulse: no panel, no log, no stop of a pulse's reaches it. A functional spec whose text changes while it is judged
 * or written has that work thrown away - whoever changed it - and the new text starts again. What `pending` is left as
 * turri quits, the next start in the chat or a host picks up.
 *
 * It is made only where the session starts in the chat or a host (extension.ts) - never for a headless command, nor
 * pi's print, json and rpc modes - and does nothing in a project whose `test-advisor:` is false.
 */

/** How many functional specs the advisor works on at once. */
export const ADVISOR_PARALLEL = 2;

/** Thrown by the writer when what it wrote cannot land as it is: the text it judged, or a file it changed, changed in the project meanwhile. */
export class AdvisorDroppedError extends Error {
  constructor(why: string) {
    super(why);
    this.name = "AdvisorDroppedError";
  }
}

/** What the writer is given on a yes: the functional spec, its report, and where its chain's tests live. */
export interface AdvisorWork {
  project: string;
  module: string;
  funcId: string;
  /** The module's .plain file. */
  plainFile: string;
  /** The tip's .plain file: where the chain's test reqs and conformance testing script are. */
  tip: string;
  /** The functional spec's text, and its hash, as it was judged. */
  text: string;
  hash: string;
  report: AdvisorReport;
  model?: string;
  /** turri's own scenarios of an earlier text of the functional spec, still as turri wrote them: the writer may replace them. */
  previous: AdvisorScenario[];
  /** Stops the work: the text changed, or the session ends. */
  signal: AbortSignal;
}

/** What the writer wrote and landed: the scenarios, and whether the test reqs or the script were written with them. */
export interface AdvisorWritten {
  scenarios: AdvisorScenario[];
  testReqs: boolean;
  script: boolean;
}

/** Scenarios that landed: for the chat the person looks at to say so. */
export interface AdvisorLanding {
  project: string;
  module: string;
  funcId: string;
  report: AdvisorReport;
  written: AdvisorWritten;
  /** Whether the module's code is built: then its conformance pulse follows at once. */
  built: boolean;
}

export interface TestAdvisorOptions {
  /** Whether a project wants the advisor now. Default: its `test-advisor:` is not false. */
  enabled?: (project: string) => boolean;
  /** The judgement of a functional spec. Default: the model calls of test-advisor.ts. */
  advise?: (subject: AdvisorSubject, options: AdvisorCallOptions) => Promise<AdvisorReport>;
  /** What writes and lands the scenarios on a yes - throwing when it fails. Not given: a yes is only recorded. */
  write?: (work: AdvisorWork) => Promise<AdvisorWritten>;
  /** The conversation's own words on what matters for a module - its steering. */
  context?: (plainFile: string) => string[];
  /** Scenarios landed. */
  onLanded?: (landing: AdvisorLanding) => void;
  /** How many functional specs at once. Default: ADVISOR_PARALLEL. */
  parallel?: number;
}

export interface TestAdvisor {
  /** What the loop looked at: the functional specs to take, and the work whose text changed under it to drop. */
  seen(look: SeenSpec): void;
  /** Pick up what a project's advisor file has pending - the work turri quit in the middle of. */
  resume(project: string): void;
  /** Resolves once nothing is queued or running. */
  idle(): Promise<void>;
  /** Stop everything, leaving what was running pending. */
  stop(): void;
  /** The functional specs it is judging or writing for now, or about to - `module:func-id`, a project's alone when named. */
  taking(project?: string): string[];
}

interface Work {
  key: string;
  project: string;
  module: string;
  funcId: string;
  plainFile: string;
  tip: string;
  text: string;
  hash: string;
  controller: AbortController;
  /** Thrown away: its text changed while it ran. */
  dropped?: boolean;
}

/** The functional spec's own place in a module, as its own .plain file has it now - or nothing. */
function currentItem(plainFile: string, funcId: string): FunctionalSpecItem | undefined {
  try {
    const [, tree] = plainFileParser(basename(plainFile), resolveTemplateDirs(plainFile), { allowNoFunctionalities: true, testDir: testDirOf(plainFile) });
    return ((tree[FUNCTIONAL_REQUIREMENTS] as FunctionalSpecItem[] | undefined) ?? []).find((item) => item.id === funcId);
  } catch {
    return undefined;
  }
}

/** The project's AGENTS.md, whole: its own words on what matters. */
function agentsText(project: string): string[] {
  const file = join(project, "AGENTS.md");
  try {
    return existsSync(file) ? [readFileSync(file, "utf8")] : [];
  } catch {
    return [];
  }
}

/** Whether a project wants the advisor: its `test-advisor:` is not false. */
function wanted(project: string): boolean {
  try {
    return readProjectConfig(project, stackOf(project)).testAdvisor !== false;
  } catch {
    return true;
  }
}

export function createTestAdvisor(options: TestAdvisorOptions = {}): TestAdvisor {
  const enabled = options.enabled ?? wanted;
  const advise = options.advise ?? adviseByModel;
  const parallel = options.parallel ?? ADVISOR_PARALLEL;
  const queue: Work[] = [];
  const running = new Map<string, Work>();
  let idleWaiters: Array<() => void> = [];
  let stopped = false;

  const keyOf = (project: string, module: string, funcId: string) => `${project}\0${module}:${funcId}`;

  const settleIdle = () => {
    if (queue.length > 0 || running.size > 0) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const resolveIdle of waiters) resolveIdle();
  };

  /** The work on a functional spec thrown away: its text is not what it was judging or writing any more. */
  const drop = (key: string, hash: string) => {
    const at = queue.findIndex((work) => work.key === key && work.hash !== hash);
    if (at !== -1) queue.splice(at, 1);
    const work = running.get(key);
    if (work !== undefined && work.hash !== hash && work.dropped !== true) {
      work.dropped = true;
      work.controller.abort();
    }
  };

  /** Take a functional spec, marked pending at once - unless the same text is taken already. */
  const take = (given: Omit<Work, "key" | "controller">, entry: AdvisorEntry | undefined) => {
    const key = keyOf(given.project, given.module, given.funcId);
    drop(key, given.hash);
    if (queue.some((work) => work.key === key) || running.get(key)?.hash === given.hash) return;
    putAdvisorEntry(given.project, given.module, relative(given.project, given.plainFile), {
      funcId: given.funcId,
      hash: given.hash,
      state: "pending",
      tip: relative(given.project, given.tip),
      // turri's scenarios of the earlier text stay turri's while this one is worked on.
      ...(entry?.scenarios !== undefined ? { scenarios: entry.scenarios } : {}),
    });
    queue.push({ ...given, key, controller: new AbortController() });
    pump();
  };

  const pump = () => {
    if (stopped) return;
    while (running.size < parallel) {
      // A new text waits for the work on its old one to unwind; the rest go on past it.
      const at = queue.findIndex((work) => !running.has(work.key));
      if (at === -1) break;
      const work = queue.splice(at, 1)[0]!;
      running.set(work.key, work);
      // Clear of any pulse the loop was looking for, and stopped by its own signal alone.
      void outsideJobs(() => withStopSignal(work.controller.signal, () => run(work))).finally(() => {
        if (running.get(work.key) === work) running.delete(work.key);
        pump();
        settleIdle();
      });
    }
    settleIdle();
  };

  const spec = (work: Work) => `${work.module}:${work.funcId}`;
  const place = (work: Work) => ({ project: work.project, module: work.module });

  const run = async (work: Work): Promise<void> => {
    const config = (() => {
      try {
        return configForSpec(work.plainFile);
      } catch {
        return {};
      }
    })();
    const model = advisorModel(config);
    const entryOf = (state: AdvisorEntry["state"], more: Partial<AdvisorEntry> = {}) => {
      const before = advisorEntry(work.project, work.module, work.funcId);
      putAdvisorEntry(work.project, work.module, relative(work.project, work.plainFile), {
        funcId: work.funcId,
        hash: work.hash,
        state,
        tip: relative(work.project, work.tip),
        ...(model !== undefined ? { model } : {}),
        ...(before?.scenarios !== undefined ? { scenarios: before.scenarios } : {}),
        ...more,
      });
    };
    let report: AdvisorReport | undefined;
    try {
      if (!enabled(work.project)) return;
      const subject: AdvisorSubject = {
        module: work.module,
        funcId: work.funcId,
        text: work.text,
        moduleText: readFileSync(work.plainFile, "utf8"),
        ...(resolve(work.tip) !== resolve(work.plainFile) && existsSync(work.tip) ? { testedIn: { module: basename(work.tip).replace(/\.plain$/, ""), text: readFileSync(work.tip, "utf8") } } : {}),
        context: [...agentsText(work.project), ...(options.context?.(work.plainFile) ?? [])],
      };
      report = await advise(subject, { cwd: work.project, ...(model !== undefined ? { model } : {}) });
      if (work.controller.signal.aborted) throw new Error("stopped");
      record({ kind: "advisor.classified", spec: spec(work), verdict: report.verdict, questions: report.questions.map((answered) => answered.question) }, place(work));
      if (report.verdict === "no" || options.write === undefined) {
        entryOf(report.verdict, { report });
        return;
      }
      // Pending still, the report kept, until the scenarios land.
      entryOf("pending", { report });
      // turri's scenarios of an earlier text that are still as it wrote them.
      const before = advisorEntry(work.project, work.module, work.funcId);
      const there = new Set(scenariosOf(currentItem(work.plainFile, work.funcId)).map((scenario) => `${scenario.kind} ${scenario.id} ${scenario.hash}`));
      const previous = (before?.scenarios ?? []).filter((scenario) => there.has(`${scenario.kind} ${scenario.id} ${scenario.hash}`));
      const written = await options.write({
        project: work.project,
        module: work.module,
        funcId: work.funcId,
        plainFile: work.plainFile,
        tip: work.tip,
        text: work.text,
        hash: work.hash,
        report,
        ...(model !== undefined ? { model } : {}),
        previous,
        signal: work.controller.signal,
      });
      // Landed just as the text changed again: the newer text's entry stays as it is, and knows these scenarios for turri's.
      const now = advisorEntry(work.project, work.module, work.funcId);
      if (work.dropped === true && now !== undefined && now.hash !== work.hash) putAdvisorEntry(work.project, work.module, relative(work.project, work.plainFile), { ...now, scenarios: written.scenarios });
      else entryOf("yes", { report, scenarios: written.scenarios });
      record({ kind: "advisor.wrote", spec: spec(work), scenarios: written.scenarios.map((scenario) => scenario.id), testReqs: written.testReqs, script: written.script }, place(work));
      options.onLanded?.({ project: work.project, module: work.module, funcId: work.funcId, report, written, built: builtNow(work) });
    } catch (error) {
      if (work.dropped === true) {
        record({ kind: "advisor.dropped", spec: spec(work) }, place(work));
        return;
      }
      // The ***plain moved under the writer, perhaps with no loop to see it: the functional spec is taken again as it is now.
      if (error instanceof AdvisorDroppedError) {
        record({ kind: "advisor.dropped", spec: spec(work) }, place(work));
        setTimeout(() => retake(work), 0);
        return;
      }
      // Stopped with the session: left pending, for the next start.
      if (stopped || work.controller.signal.aborted) return;
      const reason = firstLine(error instanceof Error ? error.message : String(error), 300);
      entryOf("failed", { reason, ...(report !== undefined ? { report } : {}) });
      record({ kind: "advisor.failed", spec: spec(work), reason }, place(work));
    }
  };

  /** Whether the functional spec's code is built as its text now reads - the tip's code record has it so. */
  const builtNow = (work: Work): boolean => {
    const tipName = basename(work.tip).replace(/\.plain$/, "");
    const record = readRecord(buildDirUnder(modulesRoot(work.project), tipName));
    if (record === null) return false;
    const items = (section: string) => (record[section] as Array<{ id?: string; module?: string; markdown?: string }> | undefined) ?? [];
    const built = work.module === tipName ? items(FUNCTIONAL_REQUIREMENTS).find((item) => item.id === work.funcId) : items(REQUIRED_FUNCTIONAL_SPECS).find((item) => item.module === work.module && item.id === work.funcId);
    return built !== undefined && (built.markdown ?? "").trim() === work.text;
  };

  /** A functional spec taken again, as its module's .plain file has it now - unless it is gone, or the person's to test. */
  const retake = (work: Work) => {
    if (stopped) return;
    const item = currentItem(work.plainFile, work.funcId);
    const known = advisorEntry(work.project, work.module, work.funcId);
    if (item === undefined || personsScenarios(known, item).length > 0) return;
    const text = item.markdown.trim();
    take({ project: work.project, module: work.module, funcId: work.funcId, plainFile: work.plainFile, tip: work.tip, text, hash: textHash(text) }, known);
  };

  const advisor: TestAdvisor = {
    seen(look) {
      if (stopped) return;
      const tip = look.chain.at(-1);
      if (tip === undefined) return;
      const project = projectDirOf(tip.plainFile);
      if (!enabled(project)) return;
      const built = new Map<string, string>();
      const builtItems = (section: string) => ((look.built[section] as Array<{ id?: string; module?: string; markdown?: string }> | undefined) ?? []);
      for (const item of builtItems(FUNCTIONAL_REQUIREMENTS)) built.set(`${tip.moduleName}:${item.id}`, (item.markdown ?? "").trim());
      for (const item of builtItems(REQUIRED_FUNCTIONAL_SPECS)) built.set(`${item.module}:${item.id}`, (item.markdown ?? "").trim());
      const items = (section: string, own: boolean) =>
        ((look.tree[section] as Array<FunctionalSpecItem & { module?: string }> | undefined) ?? []).map((item) => ({ item, module: own ? tip.moduleName : (item.module ?? "") }));
      for (const { item, module } of [...items(REQUIRED_FUNCTIONAL_SPECS, false), ...items(FUNCTIONAL_REQUIREMENTS, true)]) {
        if (module === "" || isStdlibModule(module)) continue;
        const entry = look.chain.find((link) => link.moduleName === module);
        if (entry === undefined) continue;
        const text = item.markdown.trim();
        const hash = textHash(text);
        const key = keyOf(project, module, item.id);
        // Work on a text that is no more is thrown away, wherever the change came from.
        drop(key, hash);
        // A scenario of turri's changed while the text stayed as it was: the person's edit, built or not - from now on they
        // are theirs, and a later change to the text cannot pass for keeping them in step.
        const before = advisorEntry(project, module, item.id);
        if (isCurrent(before, hash) && (before.scenarios ?? []).length > 0 && personsScenarios(before, item).length > 0) {
          putAdvisorEntry(project, module, relative(project, resolve(entry.plainFile)), { ...before, scenarios: [] });
        }
        // Built as it is now: neither new nor changed.
        if (built.get(`${module}:${item.id}`) === text) continue;
        // turri's scenarios kept in step with a changed text are still turri's.
        const known = keptInStep(advisorEntry(project, module, item.id), item, hash);
        // The person's scenarios: today's review covers it.
        if (personsScenarios(known, item).length > 0) continue;
        // Judged already, for this text - or being judged now.
        if (isCurrent(known, hash) && (known.state !== "pending" || running.has(key) || queue.some((work) => work.key === key))) continue;
        take({ project, module, funcId: item.id, plainFile: resolve(entry.plainFile), tip: resolve(tip.plainFile), text, hash }, known);
      }
    },
    resume(project) {
      if (stopped || !enabled(project)) return;
      for (const pending of pendingEntries(project)) {
        const plainFile = resolve(project, pending.plainFile);
        const item = currentItem(plainFile, pending.entry.funcId);
        // Gone, or the person's to test now: nothing is left to pick up.
        if (item === undefined || personsScenarios(pending.entry, item).length > 0) {
          removeAdvisorEntry(project, pending.module, pending.entry.funcId);
          continue;
        }
        const text = item.markdown.trim();
        take({ project, module: pending.module, funcId: item.id, plainFile, tip: resolve(project, pending.entry.tip ?? pending.plainFile), text, hash: textHash(text) }, pending.entry);
      }
    },
    idle() {
      if (queue.length === 0 && running.size === 0) return Promise.resolve();
      return new Promise((resolveIdle) => idleWaiters.push(resolveIdle));
    },
    taking(project) {
      const mine = (work: Work) => project === undefined || resolve(work.project) === resolve(project);
      return [...new Set([...running.values(), ...queue].filter(mine).map((work) => `${work.module}:${work.funcId}`))];
    },
    stop() {
      stopped = true;
      queue.length = 0;
      for (const work of running.values()) work.controller.abort();
    },
  };
  return advisor;
}
