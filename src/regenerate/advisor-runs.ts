import { existsSync, readFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { advisorModel, configForSpec, readProjectConfig, stackOf, testDirOf } from "../config.ts";
import { plainFileParser } from "../plain/parser.ts";
import { ACCEPTANCE_TESTS, CONFORMANCE_TESTS, FUNCTIONAL_REQUIREMENTS, REQUIRED_FUNCTIONAL_SPECS, type FunctionalSpecItem } from "../plain/spec.ts";
import { isStdlibModule } from "../plain/stdlib.ts";
import { outsideJobs, withStopSignal } from "./activity.ts";
import {
  advisorEntry,
  isCurrent,
  markDelivered,
  pendingEntries,
  putAdvisorEntry,
  removeAdvisorEntry,
  textHash,
  undeliveredEntries,
  type AdvisorEntry,
  type AdvisorReport,
} from "./advisor-records.ts";
import { firstLine, record } from "./ledger.ts";
import type { SeenSpec } from "./loop.ts";
import { projectDirOf, resolveTemplateDirs } from "./paths.ts";
import { advise as adviseByModel, type AdvisorCallOptions, type AdvisorSubject } from "./test-advisor.ts";

/**
 * When the test advisor runs, and on what (docs/test-advisor.md). It watches what the work loop looks at - every
 * ***plain change the loop sees, as it sees it - and takes each functional spec that is new or whose text changed since
 * its code was built (its code record), has no scenarios, and has no entry in the advisor's file for that text. A
 * project already built, with no advisor file, is looked at not at all: only what changes from now on is.
 *
 * Each is marked `pending` in the advisor's file then and there, and judged in the background - two at a time at most,
 * outside `parallel-jobs` and the lanes: no pulse waits for it, and it never steers or stops one. Its work is clear of
 * any pulse: no panel, no log, no stop of a pulse's reaches it. A functional spec whose text changes while it is judged
 * has that work thrown away - whoever changed it - and the new text starts again. What `pending` is left as turri quits,
 * the next start in the chat or a host picks up.
 *
 * The advisor decides and writes nothing in the ***plain: what it made of a functional spec is kept in its file and
 * handed on (`onVerdict`) to the chat the person looks at, which writes the scenarios on a yes. A yes not yet handed to a
 * chat stays marked undelivered, and is handed on again at the next start.
 *
 * It is made only where the session starts in the chat or a host (extension.ts) - never for a headless command, nor
 * pi's print, json and rpc modes - and does nothing in a project whose `test-advisor:` is false.
 */

/** How many functional specs the advisor works on at once. */
export const ADVISOR_PARALLEL = 2;

/** A finished verdict, handed on to the chat: the functional spec, what was made of it, and where its scenarios go. */
export interface AdvisorVerdict {
  project: string;
  module: string;
  funcId: string;
  /** The module's .plain file. */
  plainFile: string;
  /** The tip's .plain file: where the chain's scenarios are tested, and its test reqs and conformance testing script are. */
  tip: string;
  /** The test plain file its scenarios go in, from the project: `<test-dir>/<module>/<func-id>.plain`. */
  testFile: string;
  /** The hash of the text it judged. */
  hash: string;
  report: AdvisorReport;
  /** Whether it is still about the functional spec as it is now: its text the same, and still with no scenarios. */
  current(): boolean;
  /** Handed to a chat: no longer kept for the next start. */
  delivered(): void;
}

export interface TestAdvisorOptions {
  /** Whether a project wants the advisor now. Default: its `test-advisor:` is not false. */
  enabled?: (project: string) => boolean;
  /** The judgement of a functional spec. Default: the model calls of test-advisor.ts. */
  advise?: (subject: AdvisorSubject, options: AdvisorCallOptions) => Promise<AdvisorReport>;
  /** The conversation's own words on what matters for a module - its steering. */
  context?: (plainFile: string) => string[];
  /** A verdict finished - or a yes left undelivered, at the next start: for the chat the person looks at. Not given: only kept. */
  onVerdict?: (verdict: AdvisorVerdict) => void;
  /** How many functional specs at once. Default: ADVISOR_PARALLEL. */
  parallel?: number;
}

export interface TestAdvisor {
  /** What the loop looked at: the functional specs to take, and the work whose text changed under it to drop. */
  seen(look: SeenSpec): void;
  /** Pick up what a project's advisor file has pending - the work turri quit in the middle of - and hand on its undelivered yeses. */
  resume(project: string): void;
  /** Resolves once nothing is queued or running. */
  idle(): Promise<void>;
  /** Stop everything, leaving what was running pending. */
  stop(): void;
  /** The functional specs it is judging for now, or about to - `module:func-id`, a project's alone when named. */
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

/** Whether a functional spec has scenarios of any kind: then it is tested as the person wants, and today's review covers it. */
export function hasScenarios(item: unknown): boolean {
  const of = (key: string) => (((item as Record<string, unknown> | null)?.[key] as unknown[] | undefined) ?? []).length;
  return of(CONFORMANCE_TESTS) + of(ACCEPTANCE_TESTS) > 0;
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

  /** The work on a functional spec thrown away: its text is not what it was judging any more. */
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
  const take = (given: Omit<Work, "key" | "controller">) => {
    const key = keyOf(given.project, given.module, given.funcId);
    drop(key, given.hash);
    if (queue.some((work) => work.key === key) || running.get(key)?.hash === given.hash) return;
    putAdvisorEntry(given.project, given.module, relative(given.project, given.plainFile), {
      funcId: given.funcId,
      hash: given.hash,
      state: "pending",
      tip: relative(given.project, given.tip),
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

  /** A verdict handed on to the chat: a yes kept undelivered in the advisor's file until a chat has it. */
  const handOn = (given: { project: string; module: string; funcId: string; plainFile: string; tip: string; hash: string; report: AdvisorReport }) => {
    if (options.onVerdict === undefined) return;
    const { project, module, funcId, plainFile, hash } = given;
    try {
      options.onVerdict({
        ...given,
        testFile: relative(project, join(testDirOf(plainFile), module, `${funcId}.plain`)),
        current: () => {
          const item = currentItem(plainFile, funcId);
          return item !== undefined && textHash(item.markdown) === hash && !hasScenarios(item) && advisorEntry(project, module, funcId)?.hash === hash;
        },
        delivered: () => markDelivered(project, module, funcId, hash),
      });
    } catch {
      /* a chat that throws as it is told: the yes stays undelivered, for the next start */
    }
  };

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
      putAdvisorEntry(work.project, work.module, relative(work.project, work.plainFile), {
        funcId: work.funcId,
        hash: work.hash,
        state,
        tip: relative(work.project, work.tip),
        ...(model !== undefined ? { model } : {}),
        ...more,
      });
    };
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
      const report = await advise(subject, { cwd: work.project, ...(model !== undefined ? { model } : {}) });
      if (work.controller.signal.aborted) throw new Error("stopped");
      record({ kind: "advisor.classified", spec: spec(work), verdict: report.verdict, questions: report.questions.map((answered) => answered.question) }, place(work));
      // A yes is kept undelivered until a chat has it; a no is only a line, and nothing is lost when it is not drawn.
      entryOf(report.verdict, { report, ...(report.verdict === "yes" && options.onVerdict !== undefined ? { undelivered: true } : {}) });
      handOn({ project: work.project, module: work.module, funcId: work.funcId, plainFile: work.plainFile, tip: work.tip, hash: work.hash, report });
    } catch (error) {
      if (work.dropped === true) {
        record({ kind: "advisor.dropped", spec: spec(work) }, place(work));
        return;
      }
      // Stopped with the session: left pending, for the next start.
      if (stopped || work.controller.signal.aborted) return;
      const reason = firstLine(error instanceof Error ? error.message : String(error), 300);
      entryOf("failed", { reason });
      record({ kind: "advisor.failed", spec: spec(work), reason }, place(work));
    }
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
        // Built as it is now: neither new nor changed.
        if (built.get(`${module}:${item.id}`) === text) continue;
        // Scenarios of any kind: tested as the person wants, and today's review covers it.
        if (hasScenarios(item)) continue;
        // Judged already, for this text - or being judged now.
        const known = advisorEntry(project, module, item.id);
        if (isCurrent(known, hash) && (known.state !== "pending" || running.has(key) || queue.some((work) => work.key === key))) continue;
        take({ project, module, funcId: item.id, plainFile: resolve(entry.plainFile), tip: resolve(tip.plainFile), text, hash });
      }
    },
    resume(project) {
      if (stopped || !enabled(project)) return;
      for (const pending of pendingEntries(project)) {
        const plainFile = resolve(project, pending.plainFile);
        const item = currentItem(plainFile, pending.entry.funcId);
        // Gone, or given scenarios meanwhile: nothing is left to pick up.
        if (item === undefined || hasScenarios(item)) {
          removeAdvisorEntry(project, pending.module, pending.entry.funcId);
          continue;
        }
        const text = item.markdown.trim();
        take({ project, module: pending.module, funcId: item.id, plainFile, tip: resolve(project, pending.entry.tip ?? pending.plainFile), text, hash: textHash(text) });
      }
      // A yes no chat had when turri quit: handed on now, while it is still about the functional spec as it is.
      for (const kept of undeliveredEntries(project)) {
        const { entry } = kept;
        const plainFile = resolve(project, kept.plainFile);
        const item = currentItem(plainFile, entry.funcId);
        if (entry.report === undefined || item === undefined || textHash(item.markdown) !== entry.hash || hasScenarios(item)) {
          markDelivered(project, kept.module, entry.funcId, entry.hash);
          continue;
        }
        handOn({ project, module: kept.module, funcId: entry.funcId, plainFile, tip: resolve(project, entry.tip ?? kept.plainFile), hash: entry.hash, report: entry.report });
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
