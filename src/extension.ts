// Whether the terminal shows images, before anything draws: the banner's jellyfish is a picture or text.
import "./terminal-images.ts";
import { moduleOfTestPlainFile, refuseTestPlainFile, testPlainFileRefusal } from "./test-plain-files.ts";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { conversationCommand, conversationSettled, conversationWriting } from "./regenerate/conversation-writes.ts";
import { fileURLToPath } from "node:url";
import type { AgentSession, ExtensionAPI, ExtensionContext, ExtensionFactory, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { OverlayHandle, TUI } from "@earendil-works/pi-tui";
import { allocateImageId, Box, type Component, getCapabilities, getPngDimensions, type ImageDimensions, isKeyRelease, isKeyRepeat, matchesKey, renderImage, Text, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { defineTool, getMarkdownTheme, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { CODING_MODEL_ENV } from "./chat-models.ts";
import { AGENT_ROLES, CONFIG_FILE, configForSpec, readConfigFile, configModuleFor, hasProjectConfig, LEGACY_CONFIG_FILE, projectConfigFile, moduleConfigFile, moduleConfigFileIn, configModuleOf, moduleConfigsOf, withConfigModule, modelOnly, modelSpec, projectModels, readProjectConfig, roleModel, splitModelSpec, configLines, type ConfigLine } from "./config.ts";
import { modulesRoot, projectDirOf, skillRunDir } from "./regenerate/paths.ts";
import { sweepOrphanedGroups } from "./regenerate/shell.ts";
import { readScript, scriptAgainstMachine, stackOnMachine, toolchainsBlock } from "./stack.ts";
import { sandboxAvailable, sandboxSummary } from "./regenerate/os-sandbox.ts";
import { findTestScripts, scriptKindOfSkill } from "./regenerate/test-scripts.ts";
import { writingScript } from "./regenerate/scripts-being-written.ts";
import { applyBedrockRegion } from "./bedrock-region.ts";
import { bannerWarnings } from "./turri-versions.ts";
import { CONFORMANCE_OFF_REFUSAL, conformanceBlock, conformanceTestsOn, conformanceTestsOnIn, turnOnConformanceTests } from "./conformance-switch.ts";
import { BACKGROUND_NOTE, doneLine, failedTask, ownChanges, runDetails, skillRunDelivery, startedText } from "./background-skills.ts";
import { highlightPlainCodeBlocks } from "./plain-code-blocks.ts";
import { createAskUserTool } from "./tools.ts";
import { asksFromScratch, asksWholeChain, driftTool, endWait, fromWorkingDir, haltLaunched, haltTool, loopReply, startWait, toldByWaitingCall, MODEL_PARAM, regenerateTool, stopJob, WAIT_PARAM, whenBuildable, WORKING_DIR_PARAM } from "./loop-tools.ts";
import { createWebTools } from "./regenerate/web.ts";
import { describeGates, interruptedRun, runSkill, type SkillMessages } from "./genome.ts";
import { unqueue } from "./chat-waiting.ts";
import type { Reporter } from "./graph.ts";
import { loadSkill, skillStatus, type Skill } from "./skill.ts";
import { runningLaunched, stopLaunched } from "./regenerate/launch.ts";
import { launchTool } from "./launch-tools.ts";
import { createSessionLaunches, launchedDir, launchedNote, replacedNote, type SessionLaunches } from "./launch-session.ts";
import { describeLaunchLine, launchText, type Launch } from "./launch-track.ts";
import { checkedSpecs } from "./sentinel-check.ts";
import { askedForCommandLine, refusal, selfInvocation, TOOLS_NOT_CLI } from "./self-invocation.ts";
import { NEW_PROJECT } from "./new-project.ts";
import { describeResolution, resolveModel } from "./regenerate/model-names.ts";
import { checkPlainFile, formatCheckResults } from "./plain/check.ts";
import { checkPlainTool } from "./parse-tool.ts";
import { changedFiles, projectFiles } from "./plain-files.ts";
import { whyFailed } from "./regenerate/diagnose-job.ts";
import { didNotLand } from "./regenerate/failure-reports.ts";
import { conformanceRefusal, createWorkLoop, TestingStepsMissing, describeModules, isUpToDate, type ModuleStatus, type PlannedPulse, type WorkLoop } from "./regenerate/loop.ts";
import { brandNeon, brandPink, plainPaint } from "./regenerate/plain-palette.ts";
import { halfBlocks, JELLYFISH_FRAME_MS, JELLYFISH_REST, JELLYFISH_SEQUENCE, JELLYFISH_TEXT_FRAMES } from "./jellyfish.ts";
import { createJobPanel, didNotPass, keyPressed, PANEL_KEY, spinner } from "./regenerate/job-panel.ts";
import { clickToFocus, dockedWidth, narrowChat, shade, shadeChat } from "./regenerate/panel-dock.ts";
import { overPictureRow, PICTURE_AT } from "./picture-row.ts";
import { padScreen, paddedColumns, paddedRows, SCREEN_PADDING } from "./screen-padding.ts";
import { skillAboutLine, skillProgressLine } from "./skill-progress.ts";
import { createSidePanel } from "./regenerate/side-panel.ts";
import { createSpecMapSource, defaultMapFiles } from "./regenerate/spec-map.ts";
import { createSpecMapState } from "./regenerate/spec-map-view.ts";
import { createJobsTreeState, selectJob } from "./regenerate/jobs-tree.ts";
import { describeDiagnosis, diagnoseFailure } from "./regenerate/diagnose.ts";
import { HISTORY_DIR, historyLog } from "./regenerate/lineage.ts";
import { defaultBuildDir } from "./regenerate/paths.ts";
import { describeTurnIncident, describeUsage, JobStoppedError, onModelEvent, type SpecConflict } from "./regenerate/activity.ts";
import { ledgerWanted, startLedger } from "./regenerate/ledger.ts";
import { describePastPulse, describeRuns, earlierPulses, ledgerProjects } from "./regenerate/ledger-view.ts";
import { doctorTool } from "./doctor-tool.ts";
import { describeSpecConflict } from "./regenerate/stop-report.ts";
import { inheritProviders, inheritThinkingLevel } from "./pi.ts";
import { LOADING_PROVIDERS } from "./installed-providers.ts";
import { machineChange, machineChangeReason, runsBuiltCode, writesPlain } from "./regenerate/command-check.ts";
import { beginCapture, captureConsole, describeCaptured, dropNoise } from "./quiet.ts";
import { loadRules, renderRulesBlock } from "./rules.ts";
import { registerSettings, ruleNames } from "./settings.ts";
import { writeSetting } from "./config-edit.ts";
import { describeStdlib } from "./stdlib.ts";
import { DECLINED, peekKeyListener, runAsk, type AskUser, type AskUserIO, type AskUserRequest } from "./ask.ts";
import { QuestionDialog } from "./question-dialog.ts";
import { catalogueLine, chosenCommand, createCommandGate, startPicked, discoverSkills, leftOutNote, startedByCommandOnly, type SkillCatalogue } from "./skills.ts";
import { supersededByTurri } from "./chat-skills.ts";
import { conversationIdentity } from "./identity.ts";
import { setSurface, surfaceOf } from "./surface.ts";
import { createChats, scopedToChat, type ChatLink, type TurriCore, type TurriHost } from "./chats.ts";
import { ignoredGuidance, keepGuidance, landedNote, pulseEndsBlock, SENTINEL, SENTINEL_TOOLS, sentinelBrief, sentinelCheckBrief, sentinelPrompt, sentinelSetting, sentinelStartNotice, specConflictNotice, type SentinelCheck } from "./sentinel.ts";
import { noticeDialogs, registerSentinel } from "./sentinel-chat.ts";
import { currentChat } from "./chat-scope.ts";
import { registerChats } from "./chat-commands.ts";
import { buttonLabel, terminalPointer } from "./pointer-hover.ts";
import { turriIdentity } from "./environment.ts";
import { answerSideQuestion, askWithAsides, BTW_HOW, runningSkill, skillRunStarted, skillSessionText, transcriptOf } from "./btw.ts";
import {
  createJobRegistry,
  defaultParallelJobs,
  describeJob,
  formatDuration,
  pulseName,
  shouldWait,
  STOPPED_ON_REQUEST,
  type Job,
  type JobOutcome,
  type JobRegistry,
} from "./regenerate/jobs.ts";

/**
 * Makes gated skills reachable from a conversation.
 *
 * The conversational agent keeps ordinary progressive disclosure - it reads the
 * skill descriptions and decides when one applies. What it does not get is the
 * choice of how to run it: `cultivate` hands the work to the graph, which owns
 * the steps, the gates and the judges. The agent asks for the skill; it does not
 * perform it.
 */
const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Puts a skill step's question to the person, when there is one to ask.
 *
 * A skill runs inside one tool call, in its own session, so its dialogs are not
 * conversation turns and nothing it asks would otherwise reach the transcript. Every
 * exchange is therefore reported back, so the interview is visible while it happens and
 * survives in the tool's result afterwards.
 */
/**
 * What a question gets with nobody to answer it - print, json and rpc modes. What is the agent's to decide it decides; the
 * person's own files it leaves as they are, as it would have without their yes - a testing script it finds wrong is said,
 * not rewritten.
 */
export const NO_USER_ANSWER =
  "No user is available to answer. Decide yourself what is yours to decide - the ***plain you were asked to write, a choice the " +
  "***plain leaves open - and say in your report what you assumed. What you asked because it is the person's - their testing " +
  "scripts, their config, any file of theirs you would replace or delete - leave as it is: say what you would change and why, " +
  "and go on without it.";

export function askUserVia(
  ctx: ExtensionContext,
  onExchange: (question: string, answer: string, said?: string) => void,
  /** Given, "/btw ..." typed as an answer is a side question: answered with this, and the question asked again. */
  aside?: (question: string) => Promise<string>,
  /** A host's own dialogs (TurriHost.dialogs), the question put in them instead of the terminal's. */
  dialogs?: AskUserIO,
): AskUser {
  return async (request) => {
    if (dialogs === undefined && !ctx.hasUI) {
      return NO_USER_ANSWER;
    }
    // Declined - ctrl+c at it, the host's decline, or the turn that asked it stopped: the dialog open is closed, no other is
    // opened, and it comes back as DECLINED.
    const { declining, decline, done } = asking(ctx.signal);
    // The question has the keys: ctrl+h is caught here, or it would never reach the shortcut, which only the chat's editor sees.
    const unhook = dialogs === undefined ? hookPeekKey(ctx) : () => {};
    if (dialogs === undefined) ctx.ui.setWorkingMessage("waiting for your answer");
    try {
      const io = dialogs !== undefined ? hostDialogs(dialogs, declining) : terminalDialogs(ctx, declining, decline);
      const asking: AskUser = (asked) => runAsk(asked, io);
      const bare: AskUserRequest = { ...request, said: undefined };
      const given = declining.declined ? DECLINED : aside !== undefined ? await askWithAsides(bare, asking, aside) : await asking(bare);
      const answer = declining.declined ? DECLINED : given;
      // Kept: what was shown with it, and what it said before it.
      onExchange(request.question, answer, [request.context, request.said].map((part) => part?.trim() ?? "").filter((part) => part !== "").join("\n\n") || undefined);
      return answer;
    } finally {
      done();
      unhook();
      if (dialogs === undefined) ctx.ui.setWorkingMessage();
    }
  };
}

/** A question being asked: declined yet, and how to close the dialog open for it. */
interface Declining {
  declined: boolean;
  close: (() => void) | undefined;
}

/**
 * A question being asked, until `done`: declined by `decline` - ctrl+c at it - by the host (`Turri.decline`, through the
 * chat's `asking`) or by `turn` being stopped.
 */
function asking(turn: AbortSignal | undefined): { declining: Declining; decline: () => void; done: () => void } {
  const declining: Declining = { declined: turn?.aborted === true, close: undefined };
  const decline = () => {
    declining.declined = true;
    declining.close?.();
  };
  turn?.addEventListener("abort", decline, { once: true });
  const open = currentChat()?.asking;
  open?.add(decline);
  return {
    declining,
    decline,
    done: () => {
      turn?.removeEventListener("abort", decline);
      open?.delete(decline);
    },
  };
}

/**
 * A host's dialogs, for a question that can be declined: the question over at once, its dialog told through its
 * `signal` - the host's to close.
 */
function hostDialogs(dialogs: AskUserIO, declining: Declining): AskUserIO {
  const until = (asked: (signal: AbortSignal) => Promise<string | undefined>) => {
    if (declining.declined) return Promise.resolve(undefined);
    const over = new AbortController();
    return Promise.race([
      asked(over.signal),
      new Promise<undefined>(
        (resolve) =>
          (declining.close = () => {
            over.abort();
            resolve(undefined);
          }),
      ),
    ]);
  };
  return {
    select: (title, options, context, at) => until((signal) => dialogs.select(title, options, context, at, { signal })),
    input: (title, context) => until((signal) => dialogs.input(title, context, { signal })),
  };
}

/**
 * The terminal's dialogs: turri's own, a long brief scrolling above the question and the options always showing
 * (question-dialog.ts). ctrl+c declines the question - each one it is pressed at, however many in a row; what asked
 * goes on. The turn, and a skill asking in it, is stopped by ctrl+c with no question open.
 */
function terminalDialogs(ctx: ExtensionContext, declining: Declining, decline: () => void): AskUserIO {
  const dialog = (question: string, context: string | undefined, options?: string[], selected?: number) =>
    declining.declined
      ? Promise.resolve(undefined)
      : ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
          const shown: QuestionDialog = new QuestionDialog({
            question,
            ...(context !== undefined ? { context } : {}),
            ...(options !== undefined ? { options } : {}),
            ...(selected !== undefined ? { selected } : {}),
            rows: () => paddedRows(tui.terminal.rows),
            style: { accent: (text) => theme.fg("accent", text), muted: (text) => theme.fg("muted", text), bold: (text) => theme.bold(text) },
            done: (answer) => {
              if (questionShown === shown) questionShown = undefined;
              done(answer);
            },
            requestRender: () => tui.requestRender(),
            interrupt: decline,
          });
          declining.close = () => shown.dismiss();
          questionShown = shown;
          return shown;
        });
  return {
    select: (title, options, context, at) => dialog(title, context, options, at),
    input: (title, context) => dialog(title, context),
  };
}

/** The side panel, as a question open in the chat reaches it: set once the extension has its panel. */
let questionPeek:
  | {
      open(ctx: ExtensionContext): void;
      /** It shows now: its own listener has the keys, ctrl+h among them. */
      shown(): boolean;
    }
  | undefined;

/**
 * The question open in the chat now, if any. The side panel gives the keys back to it: pi would give them to what had the
 * focus when the panel first opened, and a panel kept beside the chat outlives that question - the keys would go to a
 * dialog already answered, and nothing would take them.
 */
let questionShown: Component | undefined;

/** A widget with nothing to draw: below the editor, it takes no line. */
const PEEK_KEY_WIDGET = "turri-peek-key";

/**
 * While a question is open, ctrl+h opens the side panel over it - the question waits under it. pi gives an extension's
 * shortcut only the keys its editor sees, and a question has the focus: the key is caught on the terminal's input
 * instead. While the panel shows, its own listener has ctrl+h - to close it - and this lets it be.
 */
function hookPeekKey(ctx: ExtensionContext): () => void {
  if (questionPeek === undefined) return () => {};
  const peek = questionPeek;
  ctx.ui.setWidget(
    PEEK_KEY_WIDGET,
    (tui) => {
      const unlisten = tui.addInputListener(peekKeyListener({ open: () => peek.open(ctx), shown: () => peek.shown() }));
      return { render: () => [], invalidate() {}, dispose: unlisten };
    },
    { placement: "belowEditor" },
  );
  return () => ctx.ui.setWidget(PEEK_KEY_WIDGET, undefined);
}

/**
 * ask_user, for the conversation's agent too - the same dialog a skill's interview uses: options to
 * pick from, several at once, "Something else…" to type instead, "Chat about this" to talk it over in
 * the chat first - so a question with a handful of answers is picked, not typed.
 */
/**
 * ask_user, for the conversation. `afterAnswer` may add to what an answer tells the model - a skill the person picked,
 * to start at once.
 */
export function chatAskUserTool(dialogs?: AskUserIO, afterAnswer?: (answer: string) => string | undefined): ReturnType<typeof createAskUserTool> {
  let conversation: ExtensionContext | undefined;
  const tool = createAskUserTool(
    (request) => (conversation !== undefined ? askUserVia(conversation, () => {}, undefined, dialogs)(request) : Promise.resolve("No user is available to answer.")),
    undefined,
    undefined,
    undefined,
    "reply",
  );
  return {
    ...tool,
    promptGuidelines: [
      ...(tool.promptGuidelines ?? []),
      "When a question to the user has a handful of plausible answers - a choice, yes or no, which of these - ask it with ask_user rather than in your reply.",
    ],
    async execute(...args: Parameters<typeof tool.execute>) {
      conversation = args[4] as ExtensionContext;
      const result = await tool.execute(...args);
      const answer = (result.details as { answer?: string } | undefined)?.answer;
      const note = answer !== undefined && answer !== "" ? afterAnswer?.(answer) : undefined;
      return note !== undefined ? { ...result, content: [...result.content, { type: "text" as const, text: note }] } : result;
    },
  };
}

export type { TurriHost } from "./chats.ts";

/**
 * The conversation's system prompt for a turn: pi's, turri's identity - with the host's surface in place of the
 * terminal's, when it has one - and turri's blocks; then the host's last word on it.
 */
function conversationSystemPrompt(base: string, host: TurriHost, blocks: string[]): string {
  const prompt = [base, conversationIdentity(host.surface), ...blocks].filter((part) => part !== "").join("\n\n");
  return host.systemPrompt !== undefined ? host.systemPrompt(prompt) : prompt;
}

/** Whether the person has been told which of pi's skills turri left out: once a session, not once a chat. */
let leftOutSaid = false;

/** The host each session's jobs report to. */
const hosts = new WeakMap<JobRegistry, TurriHost>();

/**
 * A turri session: its job registry and work loop, the ledger, and its chats, each with turri's extension in it
 * (chats.ts). The terminal makes one as it starts (pi-launch.ts), a host with `createTurri` (host.ts); `persist`
 * records the open chats for `turri --continue`.
 */
export function createTurriCore(
  host: TurriHost = {},
  options: {
    persist?: boolean;
    dialogs?: (chat: string) => AskUserIO | undefined;
  } = {},
): TurriCore {
  dropNoise();
  const cwd = process.cwd();
  // The AWS region the project's Bedrock models need, before any model is called - a host has no shell to export it in.
  applyBedrockRegion(cwd);
  let core: TurriCore | undefined;
  // Finished work is announced twice, to two audiences, because pi treats them differently - see ChatInstance.announce:
  // in the chat that asked for it, or the one shown when that is closed.
  const jobs: JobRegistry = createJobRegistry({
    // The loop's plan changed - a module being planned, or planned: the live panel shows it at once.
    onNotify: () => {
      core?.jobsChanged();
      host.onPlanChange?.();
    },
    // A job that fails is run once more; failing again, it and every job behind it fail, and the
    // harness - which can read the skills, the rules, the code, the tests and turri itself -
    // works out why, and what has to be done.
    retries: 1,
    // Modules that share nothing build side by side - as many at once as the machine has room for.
    maxRunning: parallelJobs(cwd),
    diagnose: async (job, failures, jobLog) => {
      const diagnosis = await diagnoseFailure({
        job,
        failures,
        projectDir: cwd,
        harnessDir: PACKAGE_ROOT,
        jobLog,
        // The coding model the job ran on - its model alone: the diagnosis thinks as its role has it.
        model: modelSpec(modelOnly(job.model ?? modelSpec(projectModels(readProjectConfig(cwd)).coding))),
      });
      return diagnosis !== undefined ? describeDiagnosis(diagnosis) : undefined;
    },
    onChange: (job) => {
      core?.jobsChanged();
      host.onJobChange?.(job);
    },
    onFinish: (job) => {
      core?.jobsChanged();
      host.onJobChange?.(job);
      // Queued again as another job: that one says how it went.
      if (job.replacedBy !== undefined) return;
      // Gone wrong: the next ctrl+h opens on it - the live panel that showed it is gone with the last pulse.
      if (job.status === "failed" || job.status === "stopped" || didNotPass(job)) needsLooking.set(jobs, job.id);
      core?.jobFinished(job);
    },
  });
  // The session's launches (docs/launch.md): a codebase's one at a time, the newest commit winning, on the coding model
  // of the codebase - and what the sentinel waits on of them.
  const launches = createSessionLaunches({
    cwd,
    jobs,
    model: (plainFile) => launchModel(workLoops.get(jobs)?.from.ctx, plainFile),
    onChange: (launch) => {
      core?.jobsChanged();
      try {
        host.onLaunch?.(launch);
      } catch {
        /* a host that throws still has the launch in the track */
      }
      core?.launchChanged(launch);
    },
  });
  sessionLaunches.set(jobs, launches);
  core = createChats({
    cwd,
    launches,
    host,
    jobs,
    extension: (pi, link) => turriExtension(pi, core!, link),
    // A finished pulse goes to the sentinel when the project wants one - read as each pulse finishes - the person asked
    // first under `sentinel: ask`, and what they choose for the project written.
    sentinel: () => sentinelSetting(cwd),
    sentinelStart: (job) => sentinelStartNotice(job, cwd),
    setSentinel: (on) => void writeSetting(cwd, "sentinel", on),
    ignored: (notice) => keepGuidance(cwd, ignoredGuidance(notice)),
    ...(options.persist !== undefined ? { persist: options.persist } : {}),
    ...(options.dialogs !== undefined ? { dialogs: options.dialogs } : {}),
  });
  const session = core;
  hosts.set(jobs, host);
  // What the model is told of where the person watches the work, deep in the tools too: the host's surface, or the terminal.
  setSurface(jobs, host.surface);
  // What this session does, as facts, in the project's .turri/ledger - a pulse's own in its project. Said once, in the
  // chat shown, when it cannot be written.
  if (ledgerWanted()) {
    startLedger({
      mode: Object.keys(host).length > 0 ? "host" : "chat",
      project: cwd,
      warn: (message) => session.notify(message, "warning"),
    });
  }
  // What a turri that was killed left running - its commands' process groups - stopped as this one starts.
  const orphans = sweepOrphanedGroups();
  if (orphans > 0) session.notify(`Stopped ${orphans} process group${orphans === 1 ? "" : "s"} a turri that was killed left running.`, "info");
  // A pulse's provider failing and waited out, or a turn turri ended itself: said in the chat shown as it happens - the
  // job panel's activity holds it too, but scrolls by.
  onModelEvent((event) => {
    const line = describeTurnIncident(event);
    if (line !== undefined) session.notify(event.job !== undefined ? `${event.job}: ${line}` : line, "warning");
  });
  // Sub-agents think as hard as the chat that started them, not pi's default - and reach the providers its extensions
  // registered - a company's own gateway - which they load none of.
  inheritThinkingLevel(() => session.instanceInScope()?.thinkingLevel() as never);
  inheritProviders(() => session.instanceInScope()?.context()?.modelRegistry);
  return core;
}

/** The session pi builds turri's extension into when it is given turri's file rather than a session's factory. */
const SESSION = Symbol.for("turri.session");

/** The session of this process: pi-launch.ts's, or one made as pi first builds the extension (`pi -e src/extension.ts`). */
export function processSession(make: () => TurriCore = () => createTurriCore()): TurriCore {
  const global = globalThis as Record<symbol, TurriCore | undefined>;
  return (global[SESSION] ??= make());
}

// Loaded as nothing while the person's pi extensions are loaded only for their providers (installed-providers.ts): an older
// turri installed into every pi is among them, and would start a session of its own.
const extension: ExtensionFactory = (pi) => (process.env[LOADING_PROVIDERS] === "1" ? undefined : processSession().extension(pi));
export default extension;

/**
 * The session's work loop, for a host to read: made with the first chat's context - the models it plans with - when no
 * chat has asked for work yet.
 */
export function sessionLoop(session: TurriCore): WorkLoop {
  const known = workLoops.get(session.jobs)?.loop;
  if (known !== undefined) return known;
  const live: AgentSession | undefined = session.shownChat()?.session ?? session.chats().map((info) => session.session(info.id)).find((found) => found !== undefined);
  if (live === undefined) throw new Error("No chat is open yet: the work loop plans with a chat's models.");
  return workLoopFor(session.jobs, session.cwd, live.extensionRunner.createContext());
}

/**
 * turri's extension, built into one chat of the session: its tools, commands and handlers run in the chat's scope -
 * its id on the pulses it asks for - on the session's job registry and work loop.
 */
function turriExtension(api: ExtensionAPI, session: TurriCore, link: ChatLink) {
  const pi = scopedToChat(api, link.scope);
  const { cwd, host, jobs } = session;
  // The session's sentinel: its own prompt and tools - the project to read, notices, its guidance - and nothing that
  // changes the project or starts work.
  const isSentinel = link.role === SENTINEL;
  const hostSentinelTools = isSentinel ? (host.sentinel?.tools ?? []) : [];
  const sentinelAllowed = new Set([...SENTINEL_TOOLS, ...hostSentinelTools.map((tool) => tool.name)]);
  // Its resume: the module brought up again on the session's work loop, as regenerate brings it up.
  const resumeModule = async (plainFile: string) => describeModules(await sessionLoop(session).bringUp(resolve(cwd, plainFile)));
  if (isSentinel) registerSentinel(pi, session, cwd, hostSentinelTools, sentinelAllowed, resumeModule);
  const dialogs = link.dialogs ?? host.dialogs;
  // turri's own skills, and the project's - .turri/skills, .agents/skills (skills.ts).
  const discoveredSkills = discoverSkills(PACKAGE_ROOT, cwd);

  // What the background work is doing right now, drawn above the editor while it runs.
  const panel = createJobPanel(() => shownJobs(jobs));

  // The chat's context, as its tools and handlers were last given it: for its model and its providers.
  let lastContext: ExtensionContext | undefined;
  const contextNow = (): ExtensionContext | undefined => {
    try {
      void lastContext?.model;
      return lastContext;
    } catch {
      // Rebuilt by pi since - a /reload, a /fork: its new extension has the context now.
      return undefined;
    }
  };

  // Finished work is announced twice, to two audiences, because pi treats them differently.
  // An entry is drawn the moment it is appended: the person sees the job end, now. The agent
  // gets the full report as a hidden message that starts a turn of its own - at once when it is
  // idle, else as soon as the turn it is in ends (a follow-up, never cutting into a reply or an
  // interview) - so it reacts to every job that ends without waiting for the person to speak:
  // does what the project's guidance says to do then (launch what was built, say), or says
  // what finished. In the chat that asked for the pulse, shown or not.
  const announce = (job: Job) => {
    announceJob(pi, job);
    // A pulse a call of this chat waits for is told in that call's reply: a turn of its own would say it again.
    if (toldByWaitingCall(jobs, job) && job.specConflict === undefined) return;
    // A spec that contradicts itself is the person's to settle, now: the agent is started on it.
    if (job.specConflict !== undefined) {
      void pi.sendMessage(
        { customType: "turri_spec_conflict", content: specConflictTask(job.specConflict), display: false, details: { jobId: job.id } },
        { triggerTurn: true },
      );
      return;
    }
    let launching = false;
    try {
      launching = readProjectConfig(cwd, job.configModule).launchAfterPulse === true;
    } catch {
      /* a config that cannot be read launches nothing */
    }
    void pi.sendMessage(
      {
        customType: "turri_job",
        content: pulseEndNote(job, { launching }),
        display: false,
        details: { jobId: job.id, status: job.status },
      },
      { triggerTurn: true, deliverAs: "followUp" },
    );
  };
  // The sentinel's: what a pulse that ended is, told to its agent in a conversation of its own for the pulse. The hidden
  // message is the conversation's first entry - a host splits the sentinel's work by pulse on it - so the pulse's end is
  // not drawn above it here: the person's chat shows it. Told once what runs holds its commit (chats.ts readyFor).
  const brief = async (job: Job, context: { asked?: string; focused?: string }) => {
    const launch = sessionLaunches.get(jobs)?.forPulse(job) ?? { later: [], laterSpecs: [], running: [] };
    const content = sentinelBrief(job, {
      project: cwd,
      ...(context.asked !== undefined ? { asked: context.asked } : {}),
      ...(context.focused !== undefined ? { focused: context.focused } : {}),
      launch,
      reaction: JOB_FINISHED_REACTION,
    });
    void pi.sendMessage({ customType: "turri_sentinel_pulse", content, display: false, details: { jobId: job.id, status: job.status } }, { triggerTurn: true });
  };
  // The sentinel's: functional specs a host asked it to check, in what is launched of the module - told, in a
  // conversation of its own for the check, its hidden first message `turri_sentinel_check`. It launches nothing.
  const briefCheck = async (check: SentinelCheck, context: { focused?: string }): Promise<void> => {
    const current = sessionLaunches.get(jobs)?.track.current(check.module);
    const commit = current?.short;
    const content = sentinelCheckBrief(check, {
      specs: checkedSpecs(check),
      running: runningLaunched(check.module),
      ...(commit !== undefined ? { commit } : {}),
      ...(current?.status === "failed" ? { failed: { id: current.id, ...(launchText(current) !== "" ? { summary: launchText(current) } : {}) } } : {}),
      ...(current !== undefined ? { dir: launchedDir(current) } : {}),
      ...(context.focused !== undefined ? { focused: context.focused } : {}),
    });
    void pi.sendMessage(
      { customType: "turri_sentinel_check", content, display: false, details: { checkId: check.id, module: check.module, funcIds: check.funcIds } },
      { triggerTurn: true },
    );
  };
  // The sentinel's: its check carried on in the conversation it was in, once its codebase was launched again.
  const resume = async (work: { job: Job } | { check: SentinelCheck }): Promise<void> => {
    const launches = sessionLaunches.get(jobs);
    if (launches === undefined) return;
    const content = launches.resumeText(work);
    void pi.sendMessage({ customType: "turri_sentinel_resume", content, display: false }, { triggerTurn: true });
  };
  // A launch this chat is to hear of ended: its agent told how it went, to tell the person.
  const launched = (launch: Launch) => tellLaunch(pi, jobs, launch);
  // A pulse ended, with the sentinel on: said in the chat. One that landed is told to its agent too, to tell the person
  // it landed and what the sentinel does with it - and nothing more: the pulse is the sentinel's. ***plain that
  // contradicts itself is put to the person at once, by turri itself, as the chat would have been started on it.
  const landed = (job: Job, options: { tell?: boolean } = {}) => {
    announceJob(pi, job);
    if (job.specConflict !== undefined) session.notice(specConflictNotice(job, specConflictTask(job.specConflict)));
    if (options.tell !== true || toldByWaitingCall(jobs, job)) return;
    // A host that shows the person the pulse's end itself: the chat knows of it - in order, with no turn of its own.
    const shown = host.pulseEndsShown === true;
    let launching = false;
    try {
      launching = readProjectConfig(cwd, job.configModule).launchAfterPulse === true;
    } catch {
      /* a config that cannot be read launches nothing */
    }
    void pi.sendMessage(
      { customType: "turri_job_landed", content: landedNote(job, { shown, launching }), display: false, details: { jobId: job.id, status: job.status } },
      shown ? { triggerTurn: false } : { triggerTurn: true, deliverAs: "followUp" },
    );
  };
  const notices = noticeDialogs(pi, session, link, contextNow);
  link.live({
    openPlainPanel: () => {
      const ctx = contextNow();
      if (ctx?.hasUI) sidePanelOf(jobs, cwd).open(ctx, "map", "beside");
    },
    announce,
    landed,
    brief,
    briefCheck,
    resume,
    launched,
    notice: notices.put,
    noticeOver: notices.over,
    concluded: notices.concluded,
    act: (task) => {
      void pi.sendMessage({ customType: "turri_notice_answer", content: task, display: false }, { triggerTurn: true, deliverAs: "followUp" });
    },
    jobsChanged: () => panel.refresh(),
    thinkingLevel: () => pi.getThinkingLevel(),
    context: contextNow,
  });
  pi.on("session_start", (_event, ctx) => {
    lastContext = ctx;
  });
  pi.on("before_agent_start", (_event, ctx) => {
    lastContext = ctx;
  });

  // The ***plain rules go into the system prompt in full, every turn. The block is
  // identical each time, so it sits inside the cached prefix rather than invalidating it.
  // With them, the instruction to do turri's work with its tools rather than its command
  // line - enforced below, not only asked for.
  const rules = loadRules(join(PACKAGE_ROOT, "genome", "rules"), readProjectConfig(cwd).rulesOff ?? []);
  // Laid out again once rules-off changes - /settings changes it as turri runs - and the same block in between.
  let rulesKept = { off: (readProjectConfig(cwd).rulesOff ?? []).join(","), block: chatRulesBlock(rules) };
  const rulesBlock = (): string => {
    const off = readProjectConfig(cwd).rulesOff ?? [];
    if (off.join(",") !== rulesKept.off) rulesKept = { off: off.join(","), block: chatRulesBlock(loadRules(join(PACKAGE_ROOT, "genome", "rules"), off)) };
    return rulesKept.block;
  };
  // What the project's config.turri.yaml says, read afresh every turn: the agent answers from it, and
  // the tools default to it.
  // pi's skills that turri has already - its own and the project's, run with cultivate, and any about ***plain from
  // another tool - are left out of the list the conversation is offered (chat-skills.ts); the person is told once.
  const turriRuns = new Set(discoveredSkills.skills.map((skill) => skill.name));
  // What the modules need of this machine: worked out when a turn first asks, and after a turn when a spec changed - never
  // as the session starts, which a host would wait on, and never while a message waits to be sent once it is known.
  const machine = machineNeeds(cwd);
  pi.on("agent_settled", () => machine.refreshSoon());
  pi.on("before_agent_start", (event, ctx) => {
    const offered = event.systemPromptOptions.skills;
    const leftOut = offered.filter((skill) => supersededByTurri(skill, turriRuns));
    if (leftOut.length > 0) {
      event.systemPromptOptions.skills = offered.filter((skill) => !leftOut.includes(skill));
      if (!leftOutSaid && ctx.hasUI) {
        leftOutSaid = true;
        const names = leftOut.map((skill) => skill.name);
        ctx.ui.notify(
          `turri left out ${names.length} of pi's skills it has already - ${names.slice(0, 6).join(", ")}${names.length > 6 ? ", ..." : ""}: ` +
            "the ***plain reference is in its prompt, and it runs its own skills with cultivate.",
          "info",
        );
      }
    }
    if (isSentinel) {
      const prompt = [event.systemPrompt, sentinelPrompt(cwd, { extraTools: hostSentinelTools.map((tool) => tool.name), ...(host.sentinel?.surface !== undefined ? { surface: host.sentinel.surface } : {}) }), projectConfigBlock(cwd), rulesBlock()].join("\n\n");
      return { systemPrompt: host.systemPrompt !== undefined ? host.systemPrompt(prompt) : prompt };
    }
    return {
      systemPrompt: conversationSystemPrompt(event.systemPrompt, host, [
        TOOLS_NOT_CLI,
        NEW_PROJECT,
        pulseEndsBlock(session.sentinelOn()),
        // Conformance tests - what they are, whether they are on here, and how they are turned on: every turn, read afresh.
        conformanceBlock(conformanceTestsOnIn(cwd)),
        projectConfigBlock(cwd),
        machineBlock(cwd, machine.now()),
        rulesBlock(),
      ]),
    };
  });

  // The conversation's agent does not run turri again through its shell, unless the person
  // asked for the command line in the message it is answering.
  let lastUserMessage = "";
  /** While a skill runs in this chat: what passes the person's message to its agent. */
  let skillMessage: ((text: string) => void) | undefined;
  pi.on("input", (event) => {
    if (event.source !== "extension") lastUserMessage = event.text;
    // A skill running in this chat holds its agent for the whole run: what the person types meanwhile is for the
    // skill's agent. It stays queued here too, shown waiting, until that agent reads it - or, the run over first, this one.
    if (event.source === "interactive" && skillMessage !== undefined && !event.text.startsWith("/")) skillMessage(event.text);
    return { action: "continue" as const };
  });
  pi.on("tool_call", (event) => {
    // The sentinel reads, and puts what it finds to the person: whatever else it calls is refused.
    if (isSentinel && !sentinelAllowed.has(event.toolName)) {
      return { block: true, reason: `${event.toolName} is not one of the sentinel's tools: it fixes the project's testing scripts and their config, and nothing else. Put what needs doing to the person with notify_person.` };
    }
    const command = (event.input as { command?: unknown }).command;
    // turri changes nothing of the machine's - no install, no system setting - asked or not, through any tool that runs a
    // command: its own bash, and a host's - a terminal in its window. The person does that.
    if (typeof command === "string") {
      const changes = machineChange(command);
      if (changes !== undefined) return { block: true, reason: machineChangeReason(changes) };
      // The sentinel's write and edit reach its tooling alone: a host's command does not write ***plain for it.
      const plain = isSentinel ? writesPlain(command) : undefined;
      if (plain !== undefined) return { block: true, reason: `${plain} is ***plain: the sentinel never changes it - put what it needs to the person with notify_person.` };
      // Nor does a host's terminal start the code in plain_modules for it: what it tests is what is launched.
      const built = isSentinel && event.toolName !== "bash" ? runsBuiltCode(command) : undefined;
      if (built !== undefined) {
        return {
          block: true,
          reason: `${built} is in plain_modules - the code a pulse may be writing, which nobody launched: the sentinel never runs it, nor starts a server of its own. Test what is launched, from where its brief says; a server that should run and does not is your finding.`,
        };
      }
    }
    if (event.toolName === "bash" && typeof command === "string") {
      const what = selfInvocation(command);
      if (what !== undefined && !askedForCommandLine(lastUserMessage)) return { block: true, reason: refusal(what, surfaceOf(jobs)) };
    }
    markConversationWrite(event.toolCallId, event.toolName, event.input as Record<string, unknown>);
    return undefined;
  });
  // What the conversation writes in the project while a pulse's agent runs a command is its own: the audit after that
  // command leaves it, rather than putting it back as the agent's (conversation-writes.ts).
  const conversationWrites = new Map<string, () => void>();
  const markConversationWrite = (id: string, tool: string, input: Record<string, unknown>) => {
    const path = typeof input.path === "string" ? input.path : undefined;
    if ((tool === "edit" || tool === "write") && path !== undefined) conversationWrites.set(id, conversationWriting([resolve(cwd, path)]));
    else if (tool === "bash" || tool === "powershell") conversationWrites.set(id, conversationCommand());
  };
  pi.on("tool_result", (event) => {
    conversationWrites.get(event.toolCallId)?.();
    conversationWrites.delete(event.toolCallId);
    return undefined;
  });
  const settleConversation = () => {
    for (const done of conversationWrites.values()) done();
    conversationWrites.clear();
    conversationSettled();
  };
  pi.on("agent_end", settleConversation);

  // A turn's own model calls happen inside pi's agent loop, outside any tool, so the
  // capture is bracketed around the turn itself. Without this, every model call writes
  // through the terminal the TUI is drawing on and strands a frame in the scrollback.
  let turnCapture: { end: () => string[] } | undefined;
  pi.on("agent_start", () => {
    turnCapture?.end();
    turnCapture = beginCapture();
  });
  const endTurnCapture = () => {
    turnCapture?.end();
    turnCapture = undefined;
  };
  pi.on("agent_end", endTurnCapture);
  pi.on("agent_settled", endTurnCapture);

  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;
    // setWidget is overloaded - lines or a component - and the panel is always a component. Through the chat's ui as it
    // is when the panel draws - pi's screen, or what stands in for it while another chat is shown.
    type ComponentWidget = Extract<Parameters<typeof ctx.ui.setWidget>[1], (...args: never[]) => unknown>;
    panel.attach({
      setWidget: (key, content, options) => {
        try {
          ctx.ui.setWidget(key, content as ComponentWidget | undefined, options);
        } catch {
          /* rebuilt by pi since: its new extension draws the panel */
        }
      },
      getToolsExpanded: () => {
        try {
          return ctx.ui.getToolsExpanded();
        } catch {
          return false;
        }
      },
    });
  });

  registerBranding(pi, discoveredSkills);
  registerInterviewLog(pi);
  registerJobTools(pi, jobs, cwd);
  // The skills the person starts themselves - a project's, marked command-only: each has its command, and cultivate starts it only
  // once its command is typed, or picked among the options the conversation offers with ask_user.
  const gate = createCommandGate();
  // A skill picked is started at once, with what the person asked for: they never type its command after picking it.
  registerCheckPlain(pi, cwd, dialogs, (answer) => {
    const chosen = chosenCommand(answer, discoveredSkills.skills);
    if (chosen === undefined) return undefined;
    gate.typed(chosen);
    return startPicked(chosen, lastUserMessage);
  });
  registerRegenerate(pi, cwd, jobs);
  registerDrift(pi, cwd, jobs);
  registerBind(pi, cwd, jobs, (plainFile) => turnOnConformance(session, plainFile));
  registerLaunch(pi, cwd, jobs);
  registerSideQuestions(pi, cwd, jobs);
  // More chats beside this one, in the terminal: /chat, alt+n, alt+1…9 (chat-commands.ts).
  if (session.terminal) registerChats(pi, session);

  const { skills } = discoveredSkills;
  if (skills.length === 0) return;

  const catalogue = skills.map(catalogueLine).join("\n");
  const pendingNote = leftOutNote(discoveredSkills);

  // The command puts what was typed in the chat, as the person's message, for the model to run it with what follows as
  // its context.
  for (const skill of skills.filter((s) => s.commandOnly)) {
    pi.registerCommand(skill.name, {
      description: `Start ${skill.name}${skill.steps.length > 1 ? ` - ${skill.steps.map((step) => step.name).join(" → ")}` : ""}: /${skill.name} [what you want]`,
      handler: async (args) => {
        gate.typed(skill.name);
        pi.sendUserMessage(`/${skill.name}${args.trim() !== "" ? ` ${args.trim()}` : ""}`, { deliverAs: "followUp" });
      },
    });
  }

  // A skill that runs in the background: started, and the turn goes on; its end comes back to this chat once it is idle.
  const skillRunEnds = skillRunDelivery(pi, link, contextNow);
  pi.on("session_shutdown", (event) => {
    if (event.reason !== "quit") return;
    for (const waiting of backgroundSkillQueue.values()) for (const run of waiting.splice(0)) run.drop();
    for (const controller of backgroundSkillRuns.values()) controller.abort();
  });
  const startInBackground = (
    skill: (typeof skills)[number],
    params: { context?: string },
    plainFile: string | undefined,
    ctx: ExtensionContext,
  ): { text: string; details: { background: true; started?: false } & ReturnType<typeof runDetails> } => {
    const key = `${cwd}\0${skill.name}`;
    const kind = scriptKindOfSkill(skill.name);
    const shown = plainFile !== undefined ? relative(cwd, plainFile) || basename(plainFile) : undefined;
    if (backgroundSkillRuns.has(key)) {
      const waiting = backgroundSkillQueue.get(key) ?? [];
      const runningFor = backgroundSkillFor.get(key);
      // Another module's run waits its turn - its testing script counted as being written from now, so the modules that
      // need it wait for it rather than start with another's. The same module's, or one for none, is the run under way.
      if (plainFile === undefined || runningFor === undefined || runningFor === plainFile || waiting.some((run) => run.plainFile === plainFile)) {
        return { text: `${skill.name} is running in the background already; what it does comes back to this chat when it ends. Nothing new was started.`, details: { background: true, started: false } };
      }
      const configModule = configModuleFor(plainFile);
      const held = kind !== undefined ? writingScript({ project: projectDirOf(plainFile), kind, ...(configModule !== undefined ? { configModule } : {}) }) : () => {};
      waiting.push({
        plainFile,
        // Started before the hold is let go: the module is never seen with no script being written in between.
        start: () => {
          try {
            startInBackground(skill, params, plainFile, ctx);
          } catch (error) {
            const why = `did not start: ${error instanceof Error ? error.message : String(error)}`;
            skillRunEnds.put({ skill: skill.name, ok: false, line: `${skill.name} ${why}.`, task: failedTask(skill.name, why, undefined, kind), ...runDetails(kind, shown) });
          } finally {
            held();
          }
        },
        drop: held,
      });
      backgroundSkillQueue.set(key, waiting);
      return {
        text: `${skill.name} is running in the background for ${relative(cwd, runningFor) || basename(runningFor)}; the run for ${shown} starts once it ends, and what it does comes back to this chat then.${kind !== undefined ? ` Until it has written its ${kind === "unit" ? "unit testing script" : "conformance testing script"}, the modules that need it wait for it.` : ""} Do not start it again.`,
        details: { background: true, ...runDetails(kind, shown) },
      };
    }
    const model = skill.model === "coding" ? jobModel(ctx, undefined, plainFile) : conversationModel(ctx);
    const configModule = plainFile !== undefined ? configModuleFor(plainFile) : undefined;
    // While it writes a testing script, the modules that need it wait for it rather than fail for want of it.
    const written = kind !== undefined ? writingScript({ project: plainFile !== undefined ? projectDirOf(plainFile) : cwd, kind, ...(configModule !== undefined ? { configModule } : {}) }) : () => {};
    const controller = new AbortController();
    backgroundSkillRuns.set(key, controller);
    backgroundSkillFor.set(key, plainFile);
    const context = [
      conversationContext(ctx, params.context),
      shown !== undefined ? `It is for ${shown}${configModule !== undefined ? `, built with ${moduleConfigFile(configModule)} over ${CONFIG_FILE}` : ""}.` : undefined,
      BACKGROUND_NOTE,
    ]
      .filter((part) => part !== undefined && part.trim() !== "")
      .join("\n\n");
    const filesBefore = projectFiles(cwd);
    const writes = ["write", "edit", "bash"].some((tool) => skill.allowedTools.includes(tool));
    const quiet: Reporter = { step: () => {}, artifact: () => {}, gate: () => {}, judge: () => {}, outcome: () => {} };
    const about = runDetails(kind, shown);
    const end = (ended: { ok: true; changed: string[] } | { ok: false; why: string; output?: string }) =>
      skillRunEnds.put(
        ended.ok
          ? { skill: skill.name, ok: true, line: doneLine(skill.name, ended.changed, kind), ...about }
          : { skill: skill.name, ok: false, line: `${skill.name} ${ended.why}.`, task: failedTask(skill.name, ended.why, ended.output, kind), ...about },
      );
    void captureConsole(() =>
      withConfigModule(configModule, () =>
        runSkill({
          skillDir: skill.dir,
          signal: controller.signal,
          cwd,
          runDir: skillRunDir(cwd, skill.name),
          report: quiet,
          context,
          ...(model !== undefined ? { model } : {}),
          // Nobody is asked: a gate that cannot be satisfied stands.
          escalate: async () => false,
        }),
      ),
    )
      .then(({ result }) => {
        // Its own: the chat went on meanwhile, and what it wrote is not the run's.
        const changed = ownChanges(changedFiles(filesBefore, projectFiles(cwd, filesBefore.keys())), kind);
        if (!result.ok) end({ ok: false, why: "stopped at a review gate, with no approved artifact", output: result.output });
        else if (writes && changed.length === 0) end({ ok: false, why: "ended having changed no file in the project", output: result.output });
        else end({ ok: true, changed });
      })
      .catch((error: unknown) => {
        // Stopped as turri quits: nobody is left to tell.
        if (error instanceof JobStoppedError) return;
        end({ ok: false, why: `failed: ${error instanceof Error ? error.message : String(error)}` });
      })
      .finally(() => {
        backgroundSkillRuns.delete(key);
        backgroundSkillFor.delete(key);
        // The next module's run, waiting its turn, starts before this one's hold is let go.
        backgroundSkillQueue.get(key)?.shift()?.start();
        written();
      });
    return {
      text: startedText(skill.name, { ...(model !== undefined ? { model } : {}), ...(shown !== undefined ? { plainFile: shown } : {}), ...(kind !== undefined ? { kind } : {}) }),
      details: { background: true, ...about },
    };
  };

  pi.registerTool({
    name: "cultivate",
    label: "Cultivate",
    description:
      "Execute one of this project's gated skills end to end. The skill's steps, review gates and " +
      "judges are enforced by the harness, so a gated skill's result has already passed review when it comes back; a skill " +
      "without gates is not reviewed. Every result says which files the run changed in the project.\n\n" +
      `Available skills:\n${catalogue}${pendingNote}`,
    promptSnippet: "cultivate: run a gated skill - its steps and review gates enforced by turri",
    promptGuidelines: [
      "When a request matches a skill listed in cultivate's description, call cultivate instead of doing the work yourself. Doing it by hand skips the review gates.",
      "A skill marked as started only by the person runs only from its command: a message that is its command - /<name> what they want - is the person starting it, and so is an option starting with it that they picked in your ask_user. Call cultivate for it at once, with what they said as context. Never call cultivate for one otherwise.",
      // pi lists .agents/skills among its own skills too: read and followed by hand, a skill's gates would be skipped.
      "A skill cultivate lists may also be among your own skills, from the project's .agents/skills: run it with cultivate all the same, never by reading its SKILL.md and following it.",
      "cultivate returns the reviewed artifact and a trace of every gate decision. Report the artifact to the user; do not rewrite it.",
      "A skill that runs in the background returns at once: go on with the turn, without waiting or telling the person to wait. Its end comes back to this chat by itself - a line when it did its work, a message to act on when it did not.",
      "If cultivate fails, say so and stop. Never carry out the skill's work yourself in the conversation - the gates and the judges are the point of running it, and an unreviewed hand-run silently drops them.",
      "Always pass `context` to cultivate, summarising what the user has already told you.",
    ],
    parameters: Type.Object({
      skill: Type.String({
        description: `Skill name. One of: ${skills.map((s) => s.name).join(", ")}`,
      }),
      context: Type.Optional(
        Type.String({
          description:
            "Everything the user has already told you that this skill would otherwise ask for - what " +
            "they are building, for whom, any decisions already made, names they have used. The skill " +
            "runs in its own session and cannot see this conversation, so whatever you leave out it " +
            "will ask again.",
        }),
      ),
      resume: Type.Optional(
        Type.Boolean({
          description:
            "Continue the run of this skill that was interrupted here - by a restart, a crash - from the step " +
            "it was in, with its session as it was. Use when the user wants to carry on where they left off.",
        }),
      ),
      fresh: Type.Optional(
        Type.Boolean({
          description: "Start a new run even though an interrupted one exists here, discarding it.",
        }),
      ),
      plainFile: Type.Optional(
        Type.String({
          description:
            "The module the skill's work is for - its .plain file, e.g. backend.plain: a testing script is written for that module, named in its config, " +
            "on its coding model. Omitted: the project's.",
        }),
      ),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const skill = skills.find((s) => s.name === params.skill);
      if (!skill) {
        return {
          content: [{ type: "text" as const, text: `Unknown skill '${params.skill}'. Available: ${skills.map((s) => s.name).join(", ")}` }],
          details: {},
        };
      }
      if (!gate.mayStart(skill)) return { content: [{ type: "text" as const, text: startedByCommandOnly(skill.name) }], details: { notStarted: true } };
      // The conformance testing script is for conformance tests: none is written while they are off.
      if (scriptKindOfSkill(skill.name) === "conformance" && !conformanceTestsOnIn(cwd)) {
        return {
          content: [{ type: "text" as const, text: `${skill.name} writes the conformance testing script, for conformance tests. ${CONFORMANCE_OFF_REFUSAL}` }],
          details: { notStarted: true },
        };
      }
      const plainFile = params.plainFile !== undefined && params.plainFile.trim() !== "" ? resolve(cwd, params.plainFile.trim()) : undefined;
      if (plainFile !== undefined && !existsSync(plainFile)) {
        return { content: [{ type: "text" as const, text: `There is no ${params.plainFile} here. Nothing was started.` }], details: { notStarted: true } };
      }

      // A skill that runs in the background, in a chat - where its end can come back to: started, and the turn goes on.
      if (skill.background && !shouldWait(ctx.mode, undefined)) {
        gate.started(skill.name);
        const started = startInBackground(skill, params, plainFile, ctx);
        return { content: [{ type: "text" as const, text: started.text }], details: started.details };
      }

      // A new run clears the run folder. An interrupted one is not thrown away by accident:
      // whether to pick it up or start over is the user's call.
      const runDir = skillRunDir(cwd, skill.name);
      const interrupted = interruptedRun(runDir, skill.name);
      if (interrupted !== undefined && params.resume !== true && params.fresh !== true) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                `There is an interrupted run of ${skill.name} here${interrupted.step ? `, stopped in its ${interrupted.step} step` : ""} ` +
                `(last active ${interrupted.updatedAt}). Ask the user whether to continue it or start over, then call ` +
                "cultivate again with resume: true or fresh: true. Nothing has been started.",
            },
          ],
          details: { interrupted },
        };
      }

      // Its command is used up: started again later, it is typed again.
      gate.started(skill.name);
      // What the person said to it while it ran, its agent having read it: told to this chat's agent with the result.
      const heard: string[] = [];
      const messages: SkillMessages = {
        open: (tell) => {
          skillMessage = tell;
        },
        read: (text) => {
          heard.push(text);
          const session = link.session();
          // Read by the skill's agent, not this one: out of this chat's queue, and into its chat where it was read.
          void (session !== undefined ? unqueue(session, text) : Promise.resolve(false)).then((taken) => {
            if (taken) pi.appendEntry(SKILL_MESSAGE_ENTRY, { text, skill: skill.name });
          });
        },
      };
      const trace: string[] = [`skill: ${skill.name}`, ...describeGates(skill).map((l) => `  ${l}`)];
      // While it runs, what its agent is doing leads: pi shows a running tool's first lines, and the trace's first
      // lines are the gates, which say nothing about now. The result keeps the trace alone.
      const live = { started: Date.now(), step: "", stepStarted: Date.now(), recent: [] as string[], saying: "" };
      const show = () => {
        const elapsed = (since: number) => {
          const s = Math.round((Date.now() - since) / 1000);
          return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
        };
        const words = live.saying.replace(/\s+/g, " ").trim();
        const view = [
          `${skill.name}${live.step !== "" ? ` · ${live.step}, ${elapsed(live.stepStarted)}` : ""} · ${elapsed(live.started)} in all`,
          ...live.recent.map((line) => `  ${line}`),
          ...(words !== "" ? [`  says: ${words.length > 160 ? `…${words.slice(-159)}` : words}`] : []),
          "",
        ];
        onUpdate?.({ content: [{ type: "text" as const, text: [...view, ...trace].join("\n") }], details: {} });
      };
      const push = (line: string) => {
        trace.push(line);
        show();
      };
      const ticker = setInterval(show, 5000);
      ticker.unref?.();

      // Above the input, while it runs: every phase by name, the one it is in, and how far through - and under it, what that phase does.
      const phases = skill.steps.map((step) => step.name);
      const progress = { current: -1, attempt: 1 };
      if (ctx.hasUI) {
        ctx.ui.setWidget("turri-skill", (tui, theme) => {
          // The spinner on the phase it is in moves.
          const redraw = setInterval(() => tui.requestRender(), 1000);
          redraw.unref?.();
          const style = {
            heading: (text: string) => theme.bold(theme.fg("accent", text)),
            done: (text: string) => theme.fg("success", text),
            now: (text: string) => theme.bold(theme.fg("accent", text)),
            muted: (text: string) => theme.fg("muted", text),
          };
          return {
            render: (width: number) => {
              const about = skill.steps[progress.current]?.about;
              const now = { skill: skill.name, phases, current: progress.current, attempt: progress.attempt, frame: spinner(Date.now()), ...(about !== undefined ? { about } : {}) };
              const under = skillAboutLine(now, width, style);
              return [skillProgressLine(now, width, style), ...(under !== undefined ? [under] : [])];
            },
            invalidate: () => {},
            dispose: () => clearInterval(redraw),
          };
        });
      }

      const report: Reporter = {
        step: (name, attempt) => {
          progress.current = phases.indexOf(name);
          progress.attempt = attempt;
          live.step = skillStatus(skill, name, attempt).slice(skill.name.length + 2);
          live.stepStarted = Date.now();
          push(`step ${name} (attempt ${attempt})`);
        },
        activity: (line) => {
          live.recent = [...live.recent, line].slice(-6);
          show();
        },
        said: (delta, fresh) => {
          live.saying = fresh ? "" : live.saying + delta;
          show();
        },
        artifact: (path, body) => push(`  ${path}: ${body.split("\n")[0]}${body.includes("\n") ? " ..." : ""}`),
        gate: (name, judges) => push(judges === 0 ? `gate ${name}: no artifact` : `gate ${name}: ${judges} judges`),
        livePass: (step, scope, findings) =>
          push(`  review ${step}: ${scope} - ${findings === 0 ? "clean" : `${findings} to fix`}`),
        liveReview: (name, passes, findings) =>
          push(
            findings === 0
              ? `gate ${name}: reviewer read along in ${passes} passes, nothing outstanding`
              : `gate ${name}: ${findings} unresolved from the reviewer`,
          ),
        judge: (index, model, verdict, violations) =>
          push(`  judge ${index + 1} (${model}): ${verdict}${violations ? ` (${violations} violations)` : ""}`),
        outcome: (name, decision, critique) => {
          push(`  ${decision} <- gate ${name}`);
          if (critique) for (const line of critique.split("\n")) push(`    ${line}`);
        },
      };

      // What the run changes in the project's ***plain - its specs, resources, scripts - is said with its result: a skill
      // that writes nothing is not taken for one that did its work. Only those: a launch or a running app changes other
      // files while it runs, and they are not its doing.
      const filesBefore = projectFiles(cwd);
      // A side question asked while it runs is told what it has done so far.
      const ran_ = skillRunStarted({ skill: skill.name, dir: skill.dir, step: () => live.step, trace: () => [...trace], runDir });
      // A testing script being written - here to its end, in print mode - holds the modules it is for, as in the background:
      // a pulse started meanwhile, by a regenerate called beside it, would run against the script as it was.
      const kind = scriptKindOfSkill(skill.name);
      const configModule = plainFile !== undefined ? configModuleFor(plainFile) : undefined;
      const written = kind !== undefined ? writingScript({ project: plainFile !== undefined ? projectDirOf(plainFile) : cwd, kind, ...(configModule !== undefined ? { configModule } : {}) }) : () => {};
      const ended = () => {
        written();
        ran_();
      };
      const ran = await captureConsole(() =>
        runSkill({
        skillDir: skill.dir,
        // The chat's turn stopped - ctrl+c, esc - stops the run with it.
        signal,
        cwd,
        runDir,
        resume: params.resume === true && interrupted !== undefined,
        report,
        context: conversationContext(ctx, params.context),
        messages,
        askUser: askUserVia(ctx, (question, answer, said) => {
          // What the skill's agent said before asking stays in the run's record, not only in the dialog.
          for (const line of (said ?? "").trim().split("\n").filter((line) => line.trim() !== "")) push(`  ${line}`);
          push(`  Q: ${question}`);
          push(`  A: ${answer}`);
          recordExchange(pi, { skill: skill.name, question, answer, ...(said !== undefined && said.trim() !== "" ? { said: said.trim() } : {}) });
        }, (question) => askOnTheSide(pi, ctx, cwd, jobs, question), dialogs),
        model: skill.model === "coding" ? jobModel(ctx, undefined, plainFile) : conversationModel(ctx),
        // Renders queued by a step land in the same registry as everything else, so
        // pulses sees them without knowing a skill started them.
        // Asked per job as it is queued, so a model chosen mid-interview applies from then on.
        renderQueue: workLoopFor(jobs, cwd, ctx),
        // The person answers the skill's agent while it runs, so it can take "render these with ..." too.
        // parse too: a skill parses what it wrote with the same check the conversation has.
        sharedTools: [checkPlainTool(cwd), ...createWebTools()],
        // The conversation's own regenerate, drift, halt and conform, on its loop: a skill waits for nothing, and regenerates on the model chosen.
        loopTools: [
          regenerateTool({ cwd, jobs, loop: () => workLoopFor(jobs, cwd, ctx), model: (_skill, plainFile, named) => jobModel(ctx, named, plainFile), wait: () => false }),
          driftTool({ cwd, jobs, loop: () => workLoopFor(jobs, cwd, ctx) }),
          haltTool({ jobs, workLoop: () => workLoops.get(jobs)?.loop, ...(sessionLaunches.get(jobs) !== undefined ? { launches: sessionLaunches.get(jobs)!.track } : {}) }),
          conformTool({ cwd, jobs, loop: () => workLoopFor(jobs, cwd, ctx), model: (_skill, plainFile, named) => jobModel(ctx, named, plainFile), wait: () => false }),
        ],
        // The escalation becomes a real dialog - the host's own, when it has them. Without one there is nobody to ask,
        // so the gate stands.
        escalate: async ({ question, critique }) => {
          if (dialogs !== undefined) {
            const through = "Let it through";
            // Declined, as any question in the host's dialogs can be: the gate stands.
            const asked = asking(signal);
            try {
              const answer = await hostDialogs(dialogs, asked.declining).select(`Review gate: ${skill.name} - ${question}`, [through, "Keep the gate"], critique);
              return !asked.declining.declined && answer === through;
            } finally {
              asked.done();
            }
          }
          if (!ctx.hasUI) {
            push("  no UI available for human review - gate stands");
            return false;
          }
          return ctx.ui.confirm(`Review gate: ${skill.name}`, `${critique}\n\n${question}`);
        },
        }),
      )
        .catch((error: unknown) => {
          if (!(error instanceof JobStoppedError)) throw error;
          return undefined;
        })
        .finally(() => {
          ended();
          clearInterval(ticker);
          if (ctx.hasUI) ctx.ui.setWidget("turri-skill", undefined);
        });
      if (ran === undefined) {
        const text = [`${skill.name}: stopped by the person, in its ${live.step || "first"} step. It can be continued with resume: true.`, "", "<trace>", ...trace, "</trace>"].join("\n");
        return { content: [{ type: "text" as const, text }], details: { stopped: true } };
      }
      const { result, output: captured } = ran;
      const noise = describeCaptured(captured);
      if (noise !== null) push(noise);

      const changes = changedFiles(filesBefore, projectFiles(cwd, filesBefore.keys()));
      // A skill that only reads and reports - an analysis - changes nothing, and its result is its verdict.
      const writes = ["write", "edit", "bash"].some((tool) => skill.allowedTools.includes(tool));
      const changed =
        changes.length > 0
          ? `It changed ${changes.length} file${changes.length === 1 ? "" : "s"} in the project: ${changes.join(", ")}.`
          : writes
            ? "It changed no file in the project - whatever it said it wrote is not there. Say so to the user; do not report the work as done."
            : "It only reads: what it found is the artifact below.";
      // A skill that edits the specs with the file tools builds nothing: the change is the conversation's to render.
      // A test plain file is its module's: the module is what regenerate is called for, its scenarios' tests brought up with it.
      const specsChanged = changes.filter((path) => path.endsWith(".plain"));
      const named = specsChanged.map((path) => {
        const owner = moduleOfTestPlainFile(resolve(cwd, path));
        return owner === undefined ? path : `${path} (a test plain file of ${owner.plainFile !== undefined ? relative(cwd, owner.plainFile) : owner.module})`;
      });
      const unrendered =
        specsChanged.length > 0
          ? `${named.join(", ")} changed, and nothing is regenerated from that yet: call regenerate for ${named.length === 1 ? "its module" : "their modules"}, and the code and its conformance tests are brought up to the spec.`
          : "";
      const gated = skill.steps.some((step) => step.gate !== undefined);
      const said =
        heard.length > 0 ? ["", `While it ran, the person said to it - its agent read and acted on each:`, ...heard.map((text) => `- ${text.replace(/\s+/g, " ").trim()}`)] : [];
      const text = result.ok
        ? [
            gated ? `${skill.name}: passed all gates.` : `${skill.name}: finished. It has no review gates, so nothing checked its work: read what it changed before you report it.`,
            changed,
            ...(unrendered !== "" ? [unrendered] : []),
            ...said,
            "",
            "<artifact>",
            result.output,
            "</artifact>",
            "",
            "<trace>",
            ...trace,
            "</trace>",
          ].join("\n")
        : [`${skill.name}: stopped at a gate. No approved artifact.`, changed, ...said, "", "<trace>", ...trace, "</trace>"].join("\n");

      return { content: [{ type: "text" as const, text }], details: { ok: result.ok, artifacts: result.artifacts } };
    },
  });
}

function registerRegenerate(pi: ExtensionAPI, cwd: string, jobs: JobRegistry) {
  pi.registerTool(
    regenerateTool({
      cwd,
      jobs,
      loop: (ctx) => workLoopFor(jobs, cwd, ctx),
      model: (ctx, plainFile, named) => jobModel(ctx, named, plainFile),
      wait: (ctx, asked) => shouldWait(ctx.mode, asked),
    }),
  );

  // /regenerate: the same as the tool, from the person - a module brought up to its spec as it is now, cut into pulses
  // by the planner: one functional spec at a time, a few together or the whole module in one, as it judges.
  pi.registerCommand("regenerate", {
    description: "Regenerate a module from its ***plain as it is now, in pulses the planner cuts - named functional specs though they did not change, or all of it from scratch, its whole chain too when asked: /regenerate [module | file.plain] [module:func-id ...] [from scratch [whole chain]]",
    handler: async (args, ctx) => {
      const command = `/regenerate ${args.trim()}`.trim();
      await echoCommand(pi, command);
      const say = (text: string, level: "info" | "warning" | "error") => shownAfterCommand(pi, ctx, command, text, level, true);
      const picked = await commandModule(cwd, ctx, args, say, { verb: "regenerate", outcome: "regenerated" });
      if (picked === undefined) return;
      const { plainFile } = picked;
      // Functional specs named first, each as module:func-id, as on the command line.
      const { funcIds: again, rest } = funcIdsNamedFirst(picked.rest);
      const words = rest.join(" ").trim();
      // From scratch - started over, its code deleted - asked in the person's words: started at once, as asked.
      const scratch = asksFromScratch(words);
      // The whole chain with it - "from scratch, the whole chain" - every module it requires built again from the bottom.
      const chain = scratch && asksWholeChain(words);
      const module = basename(plainFile).replace(/\.plain$/, "");
      // Nothing but the functional specs and from scratch: the planner cuts the work as it judges, so other words are not dropped unsaid.
      if (words !== "" && !scratch) {
        say(`/regenerate takes functional specs, each as module:func-id, and "from scratch" with "whole chain" - not "${words}". Nothing was started.`, "warning");
        return;
      }
      if (scratch && again.length > 0) {
        say("Name functional specs or ask for it from scratch, not both: from scratch regenerates every one of them.", "warning");
        return;
      }
      const loop = workLoopFor(jobs, cwd, ctx);
      const model = jobModel(ctx, undefined, plainFile);
      const request = { ...(model !== undefined ? { model } : {}) };
      // Said at once, and kept in the chat: what follows takes a while - the planner is an agent - and the person sees it
      // began, not a chat that stays empty until the first pulse starts. The plan is said under it once it is made.
      say(
        scratch
          ? `Deleting ${module}'s code${chain ? " and its whole chain's" : ""} and then starting regeneration…`
          : again.length > 0
            ? `Planning ${again.join(", ")} again…`
            : `Planning ${module}'s pulses…`,
        "info",
      );
      await nextFrame();
      // Planned in the background: pi reads what is typed next only once a command returns, and planning takes the
      // planner's time - the chat, and switching to another, stay free meanwhile. The plan is said once it is made.
      const target = plainFile;
      void (async () => {
        try {
          // Refused when its config cannot be told, or would build it with no testing script.
          const statuses = await whenBuildable(target, () =>
            scratch
              ? loop.fromScratch(target, { ...request, chain })
              : again.length > 0
                ? loop.regenerateAgain(target, again, request)
                : loop.bringUp(target, request),
          );
          // Nothing to do: say how to build it again anyway.
          const upToDate = statuses.length > 0 && statuses.every(isUpToDate);
          const hint = upToDate
            ? `\nTo regenerate parts of it anyway, name their functional specs - /regenerate ${basename(target)} ${module}:<func-id> - or start over with /regenerate ${basename(target)} from scratch.`
            : "";
          // Pulses started: the agent says so, and that the person need not wait - a plan alone leaves the chat silent.
          shownAfterCommand(pi, ctx, command, describeModules(statuses) + hint, "info", true, upToDate ? undefined : COMMAND_STARTED_REACTION);
        } catch (error) {
          say(error instanceof Error ? error.message : String(error), "error");
        }
      })().catch(() => {
        // The chat let go while it planned - closed, or rebuilt: there is nobody to say it to.
      });
    },
  });
}


/**
 * The module a /regenerate or /conform is for, and the words after it: the one its first words name, else the one
 * `module:` names, else the folder's top modules to pick from - checked to parse. Undefined, said why, when there is
 * none to take, or the person picked none.
 */
async function commandModule(
  cwd: string,
  ctx: ExtensionContext,
  args: string,
  say: (text: string, level: "info" | "warning" | "error") => void,
  words: { verb: "regenerate" | "conform"; outcome: string },
): Promise<{ plainFile: string; rest: string[] } | undefined> {
  const all = args.trim().split(/\s+/).filter((word) => word !== "");
  const [first = ""] = all;
  const { named, rest } = moduleNamedFirst(cwd, all);
  if (named === undefined && first.endsWith(".plain")) {
    say(`There is no ${first} here.`, "error");
    return undefined;
  }
  let plainFile = named;
  if (plainFile === undefined) {
    const modules = defaultMapFiles(cwd);
    if (modules.length === 0) {
      say(`No .plain file to ${words.verb}: name one - /${words.verb} app.plain - or set module: in config.turri.yaml.`, "warning");
      return undefined;
    }
    if (modules.length === 1 || !ctx.hasUI) plainFile = modules[0]!;
    else {
      const label = (file: string) => relative(cwd, file) || basename(file);
      const picked = await ctx.ui.select(`${words.verb === "regenerate" ? "Regenerate" : "Conform"} which module?`, modules.map(label));
      plainFile = modules.find((file) => label(file) === picked);
      if (plainFile === undefined) return undefined;
    }
  }
  const check = checkPlainFile(plainFile);
  if (!check.ok) {
    say(`${relative(cwd, plainFile) || plainFile} does not parse, so nothing can be ${words.outcome} from it yet:\n${formatCheckResults([check])}`, "error");
    return undefined;
  }
  return { plainFile, rest };
}

/** The functional specs a command's words name first, each as module:func-id - a comma after one allowed - and the words after them. */
export function funcIdsNamedFirst(words: string[]): { funcIds: string[]; rest: string[] } {
  const rest = [...words];
  const funcIds: string[] = [];
  while (rest.length > 0 && /^[^\s:]+:[a-z0-9-]+,?$/.test(rest[0]!)) funcIds.push(rest.shift()!.replace(/,$/, ""));
  return { funcIds, rest };
}

/** Whether a /conform's words after its functional specs ask for a pulse a functional spec - "one by one", "separately". */
export function asksOneByOne(words: string): boolean {
  return /\b(one[\s-]+(by|at)[\s-]+(one|a[\s-]+time)|separately|each[\s-]+(on[\s-]+its[\s-]+own|alone))\b/i.test(words);
}

/**
 * What a slash command showed the person: kept in the chat, where they read it, and put in the conversation as well -
 * unseen there - so that when they speak of it next ("fix it"), the agent knows what they saw. A command runs outside
 * the agent's turns, and a notification is gone in seconds and reaches no model. Given `react`, the agent is started on
 * it too - at once when it is idle, else once its turn ends - told what to do with it.
 */
export function shownAfterCommand(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  command: string,
  text: string,
  level: NonNullable<CommandOutcome["level"]>,
  /** The command is in the chat already, above it (echoCommand): the text alone. */
  echoed = false,
  react?: string,
): void {
  try {
    pi.appendEntry(COMMAND_OUTCOME, { command, text, level, ...(echoed ? { echoed } : {}) } satisfies CommandOutcome);
  } catch {
    // Shown for a moment all the same.
    if (ctx.hasUI) ctx.ui.notify(text, level);
  }
  const content = `The person ran ${command}, and was shown:\n${text}${react !== undefined ? `\n\n${react}` : ""}`;
  if (react === undefined) void pi.sendMessage({ customType: COMMAND_OUTCOME, content, display: false });
  else void pi.sendMessage({ customType: COMMAND_OUTCOME, content, display: false }, { triggerTurn: true, deliverAs: "followUp" });
}

/**
 * What a slash command found for the agent alone - guidance the person need not see: put in the conversation unseen,
 * and the agent started on it - at once when it is idle, else once its turn ends - told what to do with it.
 */
export function toldAfterCommand(pi: ExtensionAPI, command: string, text: string, react: string): void {
  const content = `The person ran ${command}. Not shown to them:\n${text}\n\n${react}`;
  void pi.sendMessage({ customType: COMMAND_OUTCOME, content, display: false }, { triggerTurn: true, deliverAs: "followUp" });
}

/**
 * What the agent does once /regenerate or /conform has started pulses: a command's output alone leaves the chat silent,
 * and the person wondering whether to wait. It says what runs, and that they need not - and starts nothing itself.
 */
export const COMMAND_STARTED_REACTION =
  "My pulses are running from the person's command, in the background. Tell the person, in a line or two, what " +
  "runs and what is planned - and that the two of us can go on with the ***plain, or anything else, meanwhile: they need " +
  "not wait for it. Start nothing for it: no regenerate, no check, no launch - its end is told when it comes.";

/**
 * What the agent does when /conform found a step of adding tests still to take: takes it at once, asking nothing - the
 * /conform was the person's yes - and says what it writes as the way there, never as a failure: the person saw none.
 */
export const CONFORM_STEPS_REACTION =
  "That is what conform needs before it can start - the steps of adding tests still to take - not an error: nothing " +
  "failed, and the person saw none of it. Their /conform is their yes to conformance tests here, so take the steps now, " +
  "in that order and only what is missing, asking nothing: the test reqs first; then the conformance testing script, " +
  "started with its skill before anything else - it runs in the background, so the scenarios are written while it does; " +
  "then the scenarios of the functional specs they named, or, naming none, of each functional spec that needs them by " +
  "the rules on test plain files. Then call regenerate for the module: the work loop writes and runs their tests once the " +
  "code is built. Tell the person in a line or two, as the way to their conformance tests and not as a refusal, what you " +
  "are writing, and for each functional spec why it needs scenarios - or, when none does, that and why.";

/**
 * What the agent does when /conform started nothing for a reason that is not a step of adding tests - a functional spec
 * named that is not there, words it does not take: answers it at once - why, and what would let it start - rather than
 * leave the person with a refusal and a silent chat.
 */
export const CONFORM_REFUSED_REACTION =
  "Nothing was started from the person's /conform, for the reason shown. Tell them in a line or two why, and what would " +
  "let it start - a functional spec they named that is not there, ***plain that does not parse or would have to change its " +
  "meaning to be tested - and offer to do what is yours to do; start nothing.";

export const COMMAND_OUTCOME = "turri_command_outcome";

interface CommandOutcome {
  command: string;
  /** None: the command itself, as the person typed it. */
  text?: string;
  level?: "info" | "warning" | "error";
  echoed?: boolean;
}

/** Longer than a frame of the TUI's (16ms): an entry appended before it is drawn by its end. */
const ONE_FRAME_MS = 20;

/**
 * What the person typed, put in the chat the moment they send it - before the command does anything - and drawn before
 * it goes on: a command's work can hold the event loop (a long requires chain parsed), and the chat stays as it was
 * until it lets go. What the command says comes under it.
 */
export async function echoCommand(pi: ExtensionAPI, command: string): Promise<void> {
  try {
    pi.appendEntry(COMMAND_OUTCOME, { command } satisfies CommandOutcome);
  } catch {
    return;
  }
  await nextFrame();
}

/** Until the TUI has drawn what was just put in the chat. */
export const nextFrame = () => new Promise<void>((resolve) => setTimeout(resolve, ONE_FRAME_MS));

/**
 * The module a /regenerate's first words name, and the words after it - all of them when none is named. A name typed
 * with spaces for its underscores - "d365_function executor" - is the module d365_function_executor: the most words
 * that name one win.
 */
export function moduleNamedFirst(cwd: string, words: string[]): { named?: string; rest: string[] } {
  for (let count = words.length; count >= 1; count -= 1) {
    const named = plainFileNamed(cwd, words.slice(0, count).join("_"));
    if (named !== undefined) return { named, rest: words.slice(count) };
  }
  return { rest: words };
}

/** The .plain file a /regenerate argument names - a path, or a module's name in the folder - if it names one. */
function plainFileNamed(cwd: string, word: string): string | undefined {
  for (const candidate of [word, `${word}.plain`]) {
    const path = resolve(cwd, candidate);
    // A test plain file names no module: it is refused where the module is taken.
    if (path.endsWith(".plain") && existsSync(path) && testPlainFileRefusal(path) === undefined) return path;
  }
  return undefined;
}

/** What is left to regenerate: the drift between a module's code and its spec - planning nothing, starting nothing. */
function registerDrift(pi: ExtensionAPI, cwd: string, jobs: JobRegistry) {
  pi.registerTool(driftTool({ cwd, jobs, loop: (ctx) => workLoopFor(jobs, cwd, ctx) }));
}

function registerBind(pi: ExtensionAPI, cwd: string, jobs: JobRegistry, turnOn: (plainFile: string) => string) {
  pi.registerTool(
    conformTool({
      cwd,
      jobs,
      loop: (ctx) => workLoopFor(jobs, cwd, ctx),
      model: (ctx, plainFile, named) => jobModel(ctx, named, plainFile),
      wait: (ctx, asked) => shouldWait(ctx.mode, asked),
    }),
  );

  // /conform: the same as the tool, from the person - a module's conformance tests written and run now, for the
  // functional specs named or every one with scenarios, in one pulse unless asked for one a functional spec. Asking for
  // them is asking for them on: off, they are turned on first. What would start nothing is found before anything is
  // said, and the chat's agent answers it at once.
  pi.registerCommand("conform", {
    description: "Write and run a module's conformance tests now - the functional specs named, or every one with scenarios - in one pulse, or one a functional spec when asked; those written already written again, named, or from scratch - the tests folder at the tip of its chain taken out, started again from the module it requires, or from nothing with whole chain; turned on first when they are off: /conform [module | file.plain] [module:func-id ...] [from scratch [whole chain]] [one by one]",
    handler: async (args, ctx) => {
      const command = `/conform ${args.trim()}`.trim();
      await echoCommand(pi, command);
      /** Nothing started: shown, and the agent told to answer it now. */
      const refuse = (text: string) => shownAfterCommand(pi, ctx, command, text, "error", true, CONFORM_REFUSED_REACTION);
      const picked = await commandModule(cwd, ctx, args, (text, level) => (level === "info" ? shownAfterCommand(pi, ctx, command, text, level, true) : refuse(text)), {
        verb: "conform",
        outcome: "conformance tested",
      });
      if (picked === undefined) return;
      const { plainFile } = picked;
      const { funcIds, rest } = funcIdsNamedFirst(picked.rest);
      const words = rest.join(" ").trim();
      const separately = asksOneByOne(words);
      // From scratch - the tests written again, the code untouched - asked in the person's words; the whole chain's with it.
      const scratch = asksFromScratch(words) ? (asksWholeChain(words) ? "chain" : "module") : undefined;
      // Nothing but the functional specs, from scratch and one by one: other words are not dropped unsaid.
      if (words !== "" && !separately && scratch === undefined) {
        refuse(`/conform takes functional specs, each as module:func-id, "from scratch" with "whole chain" and "one by one" - not "${words}". Nothing was started.`);
        return;
      }
      if (scratch !== undefined && funcIds.length > 0) {
        refuse("Name functional specs or ask for the conformance tests from scratch, not both: from scratch writes every one of them again. Nothing was started.");
        return;
      }
      // Off: turned on - written where the module's value comes from, every chat's tools switched - and said with what follows.
      let turnedOn: string | undefined;
      try {
        if (!conformanceTestsOn(plainFile)) turnedOn = `Conformance tests are on now - conformance-tests: true, written in ${turnOn(plainFile)}.`;
      } catch (error) {
        refuse(`Conformance tests could not be turned on: ${error instanceof Error ? error.message : String(error)}. Nothing was started.`);
        return;
      }
      const withTurnedOn = (text: string) => (turnedOn !== undefined ? `${turnedOn}\n${text}` : text);
      // What would start nothing - no scenarios, a functional spec not there, a step of adding tests skipped - read from the
      // ***plain alone, before anything is said.
      let refusal: { text: string; stepsMissing: boolean } | undefined;
      try {
        refusal = whenBuildable(plainFile, () => conformanceRefusal(plainFile, funcIds.length > 0 ? funcIds : undefined));
      } catch (error) {
        refusal = { text: error instanceof Error ? error.message : String(error), stepsMissing: false };
      }
      // A step of adding tests still to take - the test reqs, the script, the scenarios: the chat's to take, so told to it
      // alone, as what conform needs first. The person sees it take them, and conformance turned on, if it was.
      if (refusal?.stepsMissing === true) {
        if (turnedOn !== undefined) shownAfterCommand(pi, ctx, command, turnedOn, "info", true);
        toldAfterCommand(pi, command, refusal.text, CONFORM_STEPS_REACTION);
        return;
      }
      if (refusal !== undefined) {
        refuse(withTurnedOn(refusal.text));
        return;
      }
      const module = basename(plainFile).replace(/\.plain$/, "");
      const model = jobModel(ctx, undefined, plainFile);
      const starting =
        scratch !== undefined
          ? `Writing ${module}'s conformance tests${scratch === "chain" ? " and its whole chain's" : ""} again from scratch…`
          : `Starting ${funcIds.length > 0 ? `the conformance tests of ${funcIds.join(", ")}` : `${module}'s conformance tests`}…`;
      shownAfterCommand(pi, ctx, command, withTurnedOn(starting), "info", true);
      await nextFrame();
      // In the background, as /regenerate: a codebase built on the module may be stopped and deleted first.
      void (async () => {
        try {
          const statuses = await whenBuildable(plainFile, () =>
            workLoopFor(jobs, cwd, ctx).conformance(plainFile, {
              ...(funcIds.length > 0 ? { funcIds } : {}),
              ...(model !== undefined ? { model } : {}),
              ...(separately ? { separately: true } : {}),
              ...(scratch !== undefined ? { fromScratch: scratch } : {}),
            }),
          );
          // Nothing to write: said in the loop's words - "up to date" alone speaks of the code, not its tests.
          const upToDate = statuses.length > 0 && statuses.every(isUpToDate);
          const note = statuses.find((status) => status.conformanceNote !== undefined)?.conformanceNote;
          const text = upToDate ? `${(note ?? `the conformance tests of ${module} are written for it as built: there is nothing to write`).replace(/^./, (c) => c.toUpperCase())}.` : describeModules(statuses);
          shownAfterCommand(pi, ctx, command, text, "info", true, upToDate ? undefined : COMMAND_STARTED_REACTION);
        } catch (error) {
          if (error instanceof TestingStepsMissing) toldAfterCommand(pi, command, error.message, CONFORM_STEPS_REACTION);
          else refuse(error instanceof Error ? error.message : String(error));
        }
      })().catch(() => {
        // The chat let go meanwhile: there is nobody to say it to.
      });
    },
  });
}

/**
 * conform, for the conversation and for a skill that names it in its allowed-tools - the skill's on the conversation's
 * loop, its pulses scheduled like any other.
 */
function conformTool(options: {
  cwd: string;
  /** The pulses a waiting call tells of as it returns. */
  jobs: JobRegistry;
  loop: (ctx: ExtensionContext) => WorkLoop;
  model: (ctx: ExtensionContext, plainFile: string, named: string | undefined) => string | undefined;
  wait: (ctx: ExtensionContext, asked: boolean | undefined) => boolean;
}) {
  const { cwd } = options;
  return defineTool({
    name: "conform",
    label: "Conform",
    description:
      "Write and run the black-box conformance tests of a module's functional specs - the ones named, or every one with " +
      "scenarios - on the code as it is built, in a pulse of their own - every functional spec tested in one, as far as a size " +
      "guardrail lets, or one a functional spec when the user asks for that: each implements exactly the functional spec's " +
      "conformance and acceptance scenarios, at least one test each, by the spec's test reqs, runs them with the whole suite " +
      "the module inherits, and, where one fails, fixes the test or the code, whichever is wrong. What they are written for is " +
      "recorded apart from the code. The work loop starts these pulses by itself for every functional spec with scenarios whose " +
      "tests are behind, once the module's code is built; conform starts them now, or for the functional specs named - those alone: the module's others stay behind until conform names none, or the module is regenerated. " +
      "A functional spec named whose tests are written already has them written again - deleted and written anew from its " +
      "scenarios, its code untouched; with from_scratch, the module's whole tests folder is taken out and written again, at " +
      "the tip of each chain it is built in, as regenerate from scratch does its code. A " +
      "functional spec with no scenarios - no test plain file - is refused: there is nothing to test until scenarios " +
      "are written. So is one the spec does not have, and a module with scenarios that skipped a step of adding tests - " +
      "no test reqs, or no conformance testing script: the refusal names the next step. While conformance tests " +
      "are off it is refused too: they make each change take about twice as long, and turning them on is the person's - " +
      "with /conform - never yours.",
    promptSnippet: "conform: write and run the conformance tests of functional specs with scenarios",
    promptGuidelines: [
      "What is tested is the scenarios: a functional spec's conformance and acceptance scenarios, in its test plain file, tests/<module>/<func-id>.plain. When the user asks for conformance tests, decide in a sentence or two which scenarios to write, write them with the file tools - a test plain file's ***conformance tests*** and ***acceptance tests***, each scenario a # <scenario-id> heading and its text - then call regenerate for the module. Every scenario written is tested once the code is built: the loop starts the conformance pulse by itself. Never edit config.turri.yaml for it, and never name a functionality in funcIds to get them.",
      "Call conform when the user asks for the conformance tests to be written or run now, for a module or some of its functional specs with scenarios.",
      "What the user asks for comes first: for a module already regenerated, while a module built on it is being regenerated, conform stops that pulse, deletes the codebase built on it, writes the tests, and the module above is regenerated from it after - say so. For a module not regenerated yet, its tests are written once its code is built, before anything is built on it.",
      "Conformance tests go in one pulse for all the functional specs tested. Set one_by_one only when the user asks for a pulse a functional spec - one at a time, separately, or the like.",
      "Name a functional spec whose tests are written only when the user asks for its tests to be written again: they are deleted and written anew. Set from_scratch only when the user asks for a module's conformance tests - or its whole chain's - to be written again from scratch, never to fix tests that did not pass. Name funcIds or set from_scratch, not both.",
      'from_scratch works where the module\'s code lives - the tip of each chain it is built in, never a module in the middle - and takes that codebase\'s whole tests folder out, committed first so its lineage keeps it. "module" starts it again from a copy of the tests of the module the tip requires, and writes the tip\'s own tests anew on them; "chain" starts it from nothing, every functional spec of the chain written anew. Neither touches the code, nor any other codebase.',
    ],
    parameters: Type.Object({
      plain_file: Type.String({ description: "A .plain file of the module" }),
      working_dir: WORKING_DIR_PARAM,
      funcIds: Type.Optional(
        Type.Array(Type.String(), {
          description: "The functional specs to test, each as module:func-id (todo:add-task) - each with scenarios; one whose tests are written has them written again. Omitted: every one with scenarios",
        }),
      ),
      from_scratch: Type.Optional(
        Type.Union([Type.Literal("module"), Type.Literal("chain")], {
          description:
            "Only when the user asks for it: the tests folder where the module's code lives - the tip of its chain - taken out, committed first so its lineage keeps it, and written again from a copy of the tests of the module the tip requires; the code untouched. " +
            '"chain": written again from nothing - every functional spec of the chain\'s tests',
        }),
      ),
      one_by_one: Type.Optional(
        Type.Boolean({ description: "Only when the user asks for it: a pulse a functional spec. Omitted: every functional spec tested in one pulse, as far as the size guardrail lets" }),
      ),
      model: MODEL_PARAM,
      wait: WAIT_PARAM,
    }),
    async execute(_id, given, _signal, _onUpdate, ctx) {
      const params = fromWorkingDir(cwd, given);
      const plainFile = resolve(params.base, params.plain_file);
      refuseTestPlainFile(plainFile);
      return whenBuildable(plainFile, async () => {
        // Off: the person's to turn on, never the chat's - it is told to say why it wants them, and they decide.
        if (!conformanceTestsOn(plainFile)) return { content: [{ type: "text" as const, text: CONFORMANCE_OFF_REFUSAL }], details: { refused: true } };
        const model = options.model(ctx, plainFile, params.model);
        const loop = options.loop(ctx);
        const wait = options.wait(ctx, params.wait);
        const waiting = wait ? { jobs: options.jobs, wait: startWait(options.jobs) } : undefined;
        let statuses: ModuleStatus[];
        try {
          statuses = await loop.conformance(plainFile, {
            ...(params.funcIds !== undefined ? { funcIds: params.funcIds } : {}),
            ...(model !== undefined ? { model } : {}),
            ...(params.one_by_one === true ? { separately: true } : {}),
            ...(params.from_scratch !== undefined ? { fromScratch: params.from_scratch } : {}),
          });
        } catch (error) {
          if (waiting !== undefined) endWait(waiting.jobs, waiting.wait);
          throw error;
        }
        return loopReply(loop, statuses, wait, waiting);
      });
    },
  });
}

/** The config a spec is built with - its project's, with its module's own file over it - or, with no spec, the session folder's. */
function configOf(plainFile?: string) {
  return plainFile !== undefined ? configForSpec(resolve(process.cwd(), plainFile)) : readProjectConfig(process.cwd(), configModuleOf(process.cwd()));
}

/**
 * How many jobs the chat runs at once: `parallel-jobs:` in the session folder's config.turri.yaml - the only place it
 * is set - else half this machine's cores, between one and four.
 */
export function parallelJobs(cwd: string): number {
  return readProjectConfig(cwd).parallelJobs ?? defaultParallelJobs();
}

/**
 * This machine, for the chat's agent, read afresh every turn: which wall is up under the agents' commands, whether the
 * machine has the toolchains the project's modules name, and what in its testing scripts it lacks - for the person to
 * install or fix; the agents install nothing. `modules`: what the modules need, when it is known already - working it
 * out parses every spec of the project.
 */
export function machineBlock(cwd: string, modules: ReturnType<typeof stackOnMachine> = stackOnMachine(cwd)): string {
  const wall = sandboxAvailable();
  const walls =
    wall.kind === "none"
      ? `behind the command check and the audit alone - no OS sandbox: ${wall.why}${wall.fix !== undefined ? ` (to give it one: ${wall.fix})` : ""}`
      : `behind the command check, ${wall.kind === "seatbelt" ? "Seatbelt" : "bubblewrap"} and the audit`;
  const needing = modules.filter(({ needs }) => needs.length > 0);
  const scripts = findTestScripts(cwd);
  const misfits = [scripts.unit, scripts.prepare, scripts.conformance].flatMap((script) => {
    if (script === undefined) return [];
    const text = readScript(script);
    const found = text !== undefined ? scriptAgainstMachine(text) : [];
    return found.length > 0 ? [`- ${relative(cwd, script)} does not fit this machine: it ${found.join("; ")} - the person's to fix.`] : [];
  });
  return [
    "<this machine>",
    `The agents' commands run on this machine, with its toolchains, ${walls}. The testing scripts run here too, unfenced, in the person's environment. Nothing is installed by an agent: what the machine lacks is the person's to install.`,
    ...needing.map(({ module, needs, missing }) =>
      `- ${module}: its implementation reqs need ${needs.map((need) => `${need.toolchain} (${need.words.join(", ")})`).join(", ")}${missing.length > 0 ? ` - this machine LACKS ${missing.map((need) => need.toolchain).join(", ")}` : " - this machine has them"}.`,
    ),
    ...misfits,
    "</this machine>",
    "",
    toolchainsBlock(),
  ].join("\n");
}

/**
 * What the project's modules need of this machine, kept between turns - working it out parses every spec, seconds on a
 * project of long requires chains. Worked out when the first turn asks - not as the session starts: a host's thread
 * would be held up opening a chat no one may write in - and again, once known, when a turn has settled and a spec
 * changed since: a turn is told what was known last, at most a turn behind.
 */
export function machineNeeds(cwd: string, work: (cwd: string) => ReturnType<typeof stackOnMachine> = stackOnMachine) {
  let known: { stamp: string; modules: ReturnType<typeof stackOnMachine> } | undefined;
  /** The project's specs as they are on disk: their names and when each last changed. */
  const stamp = (): string => {
    try {
      return readdirSync(cwd)
        .filter((name) => name.endsWith(".plain"))
        .sort()
        .map((name) => `${name}\0${statSync(join(cwd, name)).mtimeMs}`)
        .join("\n");
    } catch {
      return "";
    }
  };
  const refresh = () => {
    const now = stamp();
    if (known?.stamp === now) return;
    known = { stamp: now, modules: work(cwd) };
  };
  return {
    /** What is known - worked out now only when nothing is yet. */
    now(): ReturnType<typeof stackOnMachine> {
      if (known === undefined) refresh();
      return known!.modules;
    },
    /** Worked out again, if it is known and a spec changed - once the chat has drawn what it is drawing. */
    refreshSoon(): void {
      if (known === undefined) return;
      setTimeout(() => {
        try {
          refresh();
        } catch {
          // Told what was known last.
        }
      }, ONE_FRAME_MS);
    },
  };
}

/** Whether a folder holds a project's config: config.turri.yaml, a module's own, or the config.turri.yaml read until there is one. */
function hasConfig(dir: string): boolean {
  return hasProjectConfig(dir);
}

/**
 * The project's config.turri.yaml, for the chat's agent: what it says, and what that means for the
 * tools - so a question about the project's settings is answered from the file, not from the
 * tools' defaults.
 */
export function projectConfigBlock(root: string): string {
  // The session's folder, and the projects one folder down - specs kept in plain/, with its own
  // config.turri.yaml and plain_modules - which its specs are built in when named from here.
  const projects = [
    ...(hasConfig(root) ? [root] : []),
    ...readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules" && entry.name !== "plain_modules")
      .map((entry) => join(root, entry.name))
      .filter(hasConfig),
  ];
  if (projects.length === 0) return "";

  const describe = (dir: string): string[] => {
    const modules = moduleConfigsOf(dir);
    const where = dir === root ? "" : ` (paths relative to ${relative(root, dir)}${sep})`;
    const at = (name: string) => (dir === root ? name : join(relative(root, dir), name));
    return [
      ...settings(
        readProjectConfig(dir),
        withConfigModule(undefined, () => findTestScripts(dir)),
        dir === root ? `${projectConfigFile(dir)}, for the specs here:` : `${join(relative(root, dir), projectConfigFile(dir))}, for the specs in ${relative(root, dir)}${sep} - built in ${join(relative(root, dir), "plain_modules")}:`,
        where,
        modules.length > 0 ? "project of module files" : "project",
      ),
      // A module's own file: over the project's, for it and every module built on it that has no file of its own.
      ...modules.flatMap((module) => [
        "",
        ...settings(
          readProjectConfig(dir, module),
          withConfigModule(module, () => findTestScripts(dir)),
          `${at(moduleConfigFileIn(dir, module))}, over ${projectConfigFile(dir)}, for ${module}.plain and every module built on it that has no file of its own - what it sets itself, and the testing scripts it builds with; the rest is ${projectConfigFile(dir)}'s:`,
          where,
          "module",
          readConfigFile(join(dir, moduleConfigFileIn(dir, module))),
        ),
      ]),
    ];
  };

  const settings = (
    config: ReturnType<typeof readProjectConfig>,
    scripts: ReturnType<typeof findTestScripts>,
    heading: string,
    where: string,
    /** The project's file, and whether modules have files of their own - whose scripts are theirs - or a module's. */
    of: "project" | "project of module files" | "module",
    /** A module's file as written: only what it sets itself is said - an inherited setting said again reads as its own. */
    own?: ReturnType<typeof readProjectConfig>,
  ): string[] => {
    const perModule = of === "project of module files";
    const sets = (set: boolean) => own === undefined || set;
    return [
      heading,
      ...[
        config.module !== undefined && of !== "module" ? `- module: ${config.module}${where} - the module to build when the user does not name one.` : undefined,
        of !== "module"
          ? "- conformance tests: written for every functional spec with scenarios - the conformance and acceptance scenarios of its test plain file - once the module's code is built, before anything is built on it. A functional spec with an empty test plain file is not tested. To have one tested, write its scenarios with the file tools, then call regenerate."
          : undefined,
        !sets(own?.review !== undefined)
          ? undefined
          : config.review === true
          ? "- review: true - the code and its tests are reviewed once they pass: two reviews at most, the arbiter weighing the second."
          : `- review: ${config.review === false ? "false" : "not set, so off"} - the code and its tests are not reviewed: a pulse lands once its tests pass.`,
        ...(() => {
          // Each as it holds, with what it inherits: judge from coding, coding from harness.
          const models = projectModels(config);
          const shown = (choice: typeof models.coding) => modelSpec(choice) ?? "";
          return [
            models.coding !== undefined && sets(own?.codingModel !== undefined || own?.models?.coding !== undefined || own?.models?.default !== undefined) ? `- coding-model: ${shown(models.coding)}${config.codingModel === undefined ? " (from harness-model)" : ""} - what pulses run on, unless a call names another model.` : undefined,
            models.judge !== undefined && sets(own?.judgeModel !== undefined || own?.models?.judge !== undefined) ? `- judge-model: ${shown(models.judge)}${config.judgeModel === undefined ? " (from coding-model)" : ""} - the judge and the test review in a conformance run.` : undefined,
            models.harness !== undefined && of !== "module" ? `- harness-model: ${shown(models.harness)} - the model you start with.` : undefined,
            // The other roles' own, where models: names them.
            ...AGENT_ROLES.filter((role) => role !== "coding" && role !== "chat").flatMap((role) => {
              const named = roleModel(config, role);
              return named !== undefined && sets(own?.models?.[role] !== undefined) ? [`- models: ${role}: ${shown(named)}`] : [];
            }),
            ...(() => {
              const limits = AGENT_ROLES.flatMap((role) => (config.models?.[role]?.turnLimit !== undefined ? [`${role} ${config.models[role]!.turnLimit}s`] : []));
              const all = config.models?.default?.turnLimit ?? config.turnLimit;
              return (all !== undefined || limits.length > 0) && sets(own?.turnLimit !== undefined || own?.models !== undefined) ? [`- turn limits: ${all !== undefined ? `${all}s each` : "two minutes each"}${limits.length > 0 ? `; ${limits.join(", ")}` : ""}.`] : [];
            })(),
          ];
        })(),
        `- unit testing script: ${scripts.unit !== undefined ? relative(root, scripts.unit) : perModule ? "none for the whole project - each module's file below names its own" : "none found - every build stops until there is one"}`,
        `- conformance testing script: ${scripts.conformance !== undefined ? relative(root, scripts.conformance) : perModule ? "none for the whole project - see each module's file" : "none found"}`,
        scripts.prepare !== undefined ? `- prepare script: ${relative(root, scripts.prepare)} - run on the build before every conformance testing script run, which runs only once it passes` : undefined,
        !sets(own?.testingScriptsRunOn !== undefined)
          ? undefined
          : config.testingScriptsRunOn === "copy"
          ? "- testing-scripts-run-on: copy - the testing scripts run on this machine, on a fresh copy of each module's code; `testing-scripts-run-on: in-place` (the default) runs them on the code in place."
          : "- testing-scripts-run-on: in-place - the testing scripts run on this machine on the code in place, from the project, against the host codebase; `testing-scripts-run-on: copy` runs them on a fresh copy of each module's code.",
      ].filter((line): line is string => line !== undefined),
    ];
  };

  return [
    `<project config>`,
    `A project's ${CONFIG_FILE} sets how its modules are built - and a module's own config.turri.<module>.yaml, over it, how that`,
    "module is built, and every module built on it that has no file of its own: its testing scripts, toolchains, models and conformance -",
    "a backend and a frontend each with their own scripts. Nobody chooses it: each module is built with its own file, else the one of",
    "a module it requires, else the project's alone - two among the modules it requires is an error to fix. A project with no",
    `${CONFIG_FILE} yet is read from its ${LEGACY_CONFIG_FILE} (and config.<module>.yaml). Change a setting with the settings tool,`,
    "never by editing these files; answer questions about the project's settings from what follows, and say when a pulse will",
    "differ from it because the user asked. Name a spec by its path from here - plain/hubspot.plain - and it is built in its own project.",
    ...projects.flatMap((dir) => ["", ...describe(dir)]),
    `</project config>`,
  ].join("\n");
}

/**
 * The model the spawned agents should use.
 *
 * Without this they fall back to whatever pi is configured to default to, which is not
 * necessarily the model the conversation is on - switching model mid-session would leave
 * every tool still building with the old one, silently.
 */
function conversationModel(ctx: ExtensionContext, override?: string): string | undefined {
  if (override !== undefined) return override;
  return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
}

/**
 * The chat's model, read now - it can change while a skill runs - or, from a context that has
 * gone stale since, the model it had when it was last readable.
 */
/**
 * The model a launch runs on: the coding model of the codebase - a launch follows steps, and a small model thinking little
 * does that well. Without a chat's context yet, the config's as it names it.
 */
function launchModel(ctx: ExtensionContext | undefined, plainFile: string): string | undefined {
  try {
    if (ctx !== undefined) return projectModel(ctx, plainFile) ?? chatModelOf(ctx);
  } catch {
    /* a name the chat cannot resolve: the config's, as it is */
  }
  return modelSpec(projectModels(configForSpec(plainFile)).coding);
}

function chatModelOf(ctx: ExtensionContext): string | undefined {
  try {
    const now = conversationModel(ctx);
    lastChatModel = now ?? lastChatModel;
    return now;
  } catch {
    return lastChatModel;
  }
}
let lastChatModel: string | undefined;

/**
 * Conformance tests turned on, for the session: `conformance-tests: true` written where the module's value comes from
 * (conformance-switch.ts) - what /conform does when they are off, and a host's turnOnConformance. Every chat is told at
 * its next turn. `plainFile`, absolute or from the project, picks the module whose own file
 * is written when that names the key. Returns the file written, from the project. Starts no conformance pulse.
 */
export function turnOnConformance(core: TurriCore, plainFile?: string): string {
  const file = turnOnConformanceTests(core.cwd, plainFile !== undefined && plainFile.trim() !== "" ? resolve(core.cwd, plainFile) : undefined);
  return file;
}

/** The skills running in the background, by project and skill - one at a time each, whichever chat started it - with what stops them. */
const backgroundSkillRuns = new Map<string, AbortController>();
/** The .plain file each run in `backgroundSkillRuns` is for. */
const backgroundSkillFor = new Map<string, string | undefined>();
/** The runs for other modules waiting their turn, by project and skill: each started as the one before it ends, or dropped as turri quits. */
const backgroundSkillQueue = new Map<string, Array<{ plainFile: string; start: () => void; drop: () => void }>>();

/**
 * The model a pulse's agents run on: the one named on the call, checked now so a wrong name fails here and not minutes
 * later in the background; else the coding model - `--coding-model`, or the module's config - else the conversation's.
 */
function jobModel(ctx: ExtensionContext, named?: string, plainFile?: string): string | undefined {
  const model = jobModelOf(ctx, named, plainFile);
  // The AWS region worked out again, with every model a job ran on this session: the config's may have changed since,
  // and one named on a call counts as the config's do - two needing two regions are said, not flipped between.
  if (model !== undefined) jobModels.add(model);
  applyBedrockRegion(plainFile !== undefined ? projectDirOf(plainFile) : process.cwd(), { also: [...jobModels] });
  return model;
}

/** Every model a job ran on in this session. */
const jobModels = new Set<string>();

function jobModelOf(ctx: ExtensionContext, named?: string, plainFile?: string): string | undefined {
  if (named !== undefined && named.trim() !== "") {
    const resolved = resolveModel(named, ctx.modelRegistry);
    if (!resolved.ok) throw new Error(describeResolution(resolved));
    return resolved.model;
  }
  return projectModel(ctx, plainFile) ?? chatModelOf(ctx);
}

/**
 * The coding model this session starts from, and where it was given: `turri
 * --coding-model`, or `coding-model:` in the project's config.turri.yaml - read afresh, so an edit to the
 * file holds for the next render.
 */
function codingModelDefault(plainFile?: string): { named: string; from: string } | undefined {
  const flag = process.env[CODING_MODEL_ENV]?.trim();
  if (flag) return { named: flag, from: "--coding-model" };
  // The coding model inherits what it leaves out from the harness model.
  const named = modelSpec(projectModels(configOf(plainFile)).coding);
  return named !== undefined ? { named, from: CONFIG_FILE } : undefined;
}

/**
 * The default coding model, resolved as a name the person said would be. One that cannot be used
 * says so, and where it came from, rather than running on something else.
 */
function projectModel(ctx: ExtensionContext, plainFile?: string): string | undefined {
  const given = codingModelDefault(plainFile);
  if (given === undefined) return undefined;
  // The model is looked up by name; how hard it thinks goes along with it as it was given.
  const { model, thinking } = splitModelSpec(given.named);
  if (model === undefined) return modelSpec({ thinking });
  const resolved = resolveModel(model, ctx.modelRegistry);
  if (!resolved.ok) {
    throw new Error(`${given.from} names the coding model "${model}", which cannot be used here.\n\n${describeResolution(resolved)}`);
  }
  return modelSpec({ model: resolved.model, thinking });
}

/**
 * Run the work now, or start it as a background job and hand back an id.
 *
 * Background only makes sense where the session outlives the turn. In print, json and rpc
 * modes the process is gone the moment the answer is written, taking the job with it, so
 * those wait by default.
 */
/** The one work loop of a conversation's jobs: every tool that builds brings its modules up through it. */
const workLoops = new WeakMap<JobRegistry, { loop: WorkLoop; from: { ctx: ExtensionContext } }>();

/** A session's launches, by its jobs: the launch track every chat's launch tool and every pulse's launch share. */
const sessionLaunches = new WeakMap<JobRegistry, SessionLaunches>();

function workLoopFor(jobs: JobRegistry, cwd: string, ctx: ExtensionContext): WorkLoop {
  let shared = workLoops.get(jobs);
  if (shared === undefined) {
    const from = { ctx };
    const loop = createWorkLoop({
      registry: jobs,
      cwd,
      modelFor: (plainFile) => projectModel(from.ctx, plainFile) ?? chatModelOf(from.ctx),
      // The planner reasons about the whole of the work: it runs on the chat's model.
      plannerModel: () => chatModelOf(from.ctx),
      // A pulse landed: its commit kept for the sentinel - and, under launch-after-pulse, launched in the background, the
      // codebase's next pulse not waiting on it.
      landed: (input) => sessionLaunches.get(jobs)?.landed(input),
    });
    shared = { loop, from };
    workLoops.set(jobs, shared);
  }
  shared.from.ctx = ctx;
  return shared.loop;
}

async function deliver(
  jobs: JobRegistry,
  input: {
    kind: string;
    summary: string;
    model: string | undefined;
    wait: boolean | undefined;
    mode: string;
    /** What the job writes. See StartJobInput.lanes. */
    lanes: string[];
    onUpdate?: (result: { content: Array<{ type: "text"; text: string }>; details: unknown }) => void;
    /** For a render spec diff job: the diff, shown while it waits and runs. */
    diff?: string;
    run: (onDelta: (delta: string) => void) => Promise<JobOutcome>;
  },
) {
  const wait = shouldWait(input.mode, input.wait);

  if (wait) {
    let streamed = "";
    const { result: outcome, output } = await captureConsole(() =>
      input.run((delta) => {
        streamed += delta;
        input.onUpdate?.({ content: [{ type: "text" as const, text: streamed }], details: {} });
      }),
    );
    const noise = describeCaptured(output);
    return {
      content: [{ type: "text" as const, text: noise ? `${outcome.report}\n\n${noise}` : outcome.report }],
      details: outcome.details ?? {},
    };
  }

  // The job's name stays short for the panel; which model it runs on goes to the agent.
  const summary = input.summary;
  const onModel = input.model ? ` on ${input.model}` : "";
  const job = jobs.start({
    kind: input.kind,
    summary,
    diff: input.diff,
    model: input.model,
    lanes: input.lanes,
    // Background work writes through the same terminal the TUI is drawing on, so its
    // console output is collected rather than printed.
    run: async (onDelta) => {
      const { result, output } = await captureConsole(() => input.run(onDelta));
      const noise = describeCaptured(output);
      return noise ? { ...result, report: `${result.report}\n\n${noise}` } : result;
    },
  });
  return {
    content: [
      {
        type: "text" as const,
        text:
          (job.status === "queued"
            ? `Queued ${input.kind} as pulse ${job.id}: ${summary}${onModel}. It writes the same ` +
              `module as ${job.waitingOn.map((id) => `pulse ${id}`).join(" and ")}, so it starts when that ` +
              "finishes. Nothing to wait for: if what you are doing has a next step, take it now, in this same turn, and tell " +
              "the user it is queued and why alongside it, never as a reply that ends your turn - and that the two of you " +
              "can go on with the ***plain, or anything else, meanwhile: they need not wait for it. "
            : `Started ${input.kind} as pulse ${job.id}: ${summary}${onModel}.\n` +
              "It is running now and will report back when it finishes - nothing to wait for: if what you are doing has a " +
              "next step, take it now, in this same turn, and tell the user it has started alongside it, never as a reply " +
              "that ends your turn - and that the two of you can go on with the ***plain, or anything else, meanwhile: they " +
              "need not wait for it. ") +
          `Use pulses with "${job.id}" if they ask how it is going.`,
      },
    ],
    details: { jobId: job.id, status: job.status },
  };
}

/** Looking in on work that is still running, and collecting what finished. */
/** By registry: what opens the side panel - for a skill's question that invites the person to peek. */
const panelOpeners = new WeakMap<JobRegistry, (ctx: ExtensionContext) => void>();

/** By registry: the last pulse that failed, stopped or did not pass, not yet looked at - ctrl+h opens on it. */
const needsLooking = new WeakMap<JobRegistry, string>();

/** What heads a pulse told from the ledger: it is not this session's, and the facts are all there is of it. */
const pastPulseNote =
  "A pulse of an earlier session, as the ledger recorded it - facts, not its transcript. Its whole log is the file it names, " +
  "for the read tool.";

function registerJobTools(pi: ExtensionAPI, jobs: JobRegistry, cwd: string) {
  pi.registerTool(doctorTool({ cwd }));

  pi.registerTool({
    name: "pulses",
    label: "Pulses",
    description:
      "Pulses in every tense - earlier sessions', this session's, running now and what runs next. With no parameter: every pulse of " +
      "this session - finished, running, and planned, those of a look ahead marked as waiting for regenerate - the launches and what they started, " +
      "and the last runs of earlier sessions, a line a pulse - how each ended, how long, what it cost. With job_id, one pulse: " +
      "running, whether it still is and its latest output; finished, its report and what the ledger recorded of it - its rounds " +
      "and test runs (how many failed the same way), the verdicts, the healers, the model provider's trouble, what turri refused, " +
      "what it committed - and, one that did not land, why, from its whole transcript: its diagnosis, the stages that went wrong, " +
      "the last failing test run with its output, the last review that sent the work back, the tool calls that failed, and where " +
      "the whole log is; of an earlier session, told from the ledger; planned (planned-<module>-N), its cases and - the next pulse " +
      "of its codebase - the whole prompt its coding agent will get, from the plan regenerate runs. With plain_file, a look " +
      "ahead: that module's work planned as regenerate plans it, and kept - nothing started, its pulses waiting " +
      "for regenerate, which then runs this plan unless the ***plain changed - and what is planned listed. " +
      "What is left to regenerate, without a plan, is drift's. Every generation of a module's code and tests is a commit in its " +
      "history, read with git: git --git-dir=plain_modules/<module>/.plaingit log, and show <commit>.",
    promptSnippet: "pulses: every pulse or one - earlier, running or planned - why one did not land, and with plain_file what will run next and its prompt",
    promptGuidelines: [
      "When a pulse failed or did not land, call pulses with its id before you explain it or change the spec: go by what happened, not by the report alone.",
      "Call pulses with plain_file when the user wants to see or check what will run before it does, then with a planned row's id for its prompt. To change the plan, change the ***plain, then look again.",
    ],
    parameters: Type.Object({
      job_id: Type.Optional(
        Type.String({
          description: "One pulse: the id returned when it started, an earlier session's, or a planned row's (planned-<module>-N). Omitted: every pulse",
        }),
      ),
      plain_file: Type.Optional(
        Type.String({ description: "A look ahead: the .plain file of the module to plan, starting nothing. Not with job_id. Omitted: no look ahead" }),
      ),
      working_dir: WORKING_DIR_PARAM,
      wait: Type.Optional(
        Type.Boolean({ description: "With a pulse started: block until it finishes instead of reporting its current state (default false)" }),
      ),
      runs: Type.Optional(Type.Number({ description: `With no parameter: how many runs of earlier sessions to list (default ${EARLIER_RUNS})` })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (params.plain_file !== undefined) {
        if (params.job_id !== undefined) return { content: [{ type: "text" as const, text: "Pass job_id or plain_file, not both: plain_file looks ahead at a module, job_id tells one pulse." }], details: { status: "refused" } };
        const given = fromWorkingDir(cwd, params);
        const plainFile = resolve(given.base, given.plain_file!);
        refuseTestPlainFile(plainFile);
        return whenBuildable(plainFile, async () => {
          const loop = workLoopFor(jobs, cwd, ctx);
          const statuses = await loop.lookAhead(plainFile);
          return { content: [{ type: "text" as const, text: describeLookAhead(loop, statuses) }], details: { status: "looked ahead" } };
        });
      }
      if (params.job_id === undefined) {
        const runs = params.runs !== undefined && Number.isFinite(params.runs) ? Math.max(1, Math.floor(params.runs)) : EARLIER_RUNS;
        return { content: [{ type: "text" as const, text: listJobs(jobs, cwd, runs) }], details: { status: "all" } };
      }
      const existing = jobs.get(params.job_id);
      const planned = shownJobs(jobs).find((job) => job.id === params.job_id && jobs.get(job.id) === undefined);
      if (planned !== undefined) {
        const pulse = await workLoops.get(jobs)?.loop.plannedPulse(planned.id);
        return { content: [{ type: "text" as const, text: describePlannedRow(planned, pulse) }], details: { status: "planned" } };
      }
      if (existing === undefined) {
        const past = describePastPulse(ledgerProjects(cwd), params.job_id);
        if (past !== undefined) return { content: [{ type: "text" as const, text: `${pastPulseNote}\n\n${past}` }], details: { status: "earlier" } };
        const known = shownJobs(jobs).map((job) => job.id);
        return {
          content: [
            {
              type: "text" as const,
              text: `No pulse ${params.job_id}. ${known.length > 0 ? `Known pulses: ${known.join(", ")}.` : "No pulses have been started."}`,
            },
          ],
          details: { status: "unknown" },
        };
      }

      const job = params.wait === true ? await jobs.wait(params.job_id) : existing;
      if (job.status === "running" || job.status === "queued") return { content: [{ type: "text" as const, text: describeJob(job) }], details: { status: job.status as string } };
      // Ended: how it went - why, for one that did not land - and what the ledger recorded of it besides: its rounds, test
      // runs, verdicts, healers and commits, as facts. A pulse that landed after a struggle shows it there.
      const told = didNotLand(job) ? whyFailed(job) : describeJob(job);
      const facts = describePastPulse(ledgerProjects(cwd), job.id, { report: false });
      const text = facts !== undefined ? `${told}\n\nWhat the ledger recorded of it:\n${facts}` : told;
      return { content: [{ type: "text" as const, text }], details: { status: job.status as string } };
    },
  });

  // The panel is compact and ctrl+o only lasts as long as the work does. This is the whole
  // list, finished jobs included, put in the transcript where it stays.

  pi.registerCommand("halt", {
    description: "Halt a queued or running pulse, a module's planned pulses, a launch, or what a launch started: /halt [pulse id | module | launched <name | module>]",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;
      const live = jobs.list().filter((job) => job.status === "running" || job.status === "queued");
      const servers = runningLaunched();
      const track = sessionLaunches.get(jobs)?.track;
      const underWay = (track?.list() ?? []).filter((launch) => launch.status === "running" || launch.status === "waiting");
      const loop = workLoops.get(jobs)?.loop;
      // A module's planned pulses, one line a module: halting one halts the module.
      const plannedRows = loop?.planned() ?? [];
      const planned = [...new Set(plannedRows.map((row) => row.module ?? ""))].filter((module) => module !== "");
      let id = args.trim();
      if (id === "") {
        if (live.length === 0 && servers.length === 0 && underWay.length === 0 && planned.length === 0) return ctx.ui.notify("Nothing is regenerating, queued, planned or launched.", "info");
        const label = (job: Job) => `${job.id}  ${job.status.padEnd(8)} ${pulseName(job)}`;
        const plannedLabel = (module: string) => {
          const rows = plannedRows.filter((row) => row.module === module);
          const waiting = rows.find((row) => row.id.endsWith("-waiting"));
          return `${module}  ${waiting !== undefined ? waiting.summary : `${rows.length} planned`} - halts the module`;
        };
        const labels = [
          ...live.map(label),
          ...planned.map(plannedLabel),
          ...underWay.map(describeLaunchLine),
          ...servers.map((item) => launchedLabel(item.name, item.url ?? item.command)),
        ];
        const picked = await ctx.ui.select("Halt which?", labels);
        const job = live.find((candidate) => picked !== undefined && label(candidate) === picked);
        const module = planned.find((name) => picked !== undefined && plannedLabel(name) === picked);
        const launch = underWay.find((candidate) => picked !== undefined && describeLaunchLine(candidate) === picked);
        const server = servers.find((item) => picked !== undefined && launchedLabel(item.name, item.url ?? item.command) === picked);
        if (server !== undefined) id = `launched ${server.name}`;
        else if (launch !== undefined) id = `launched ${launch.codebase}`;
        else if (job !== undefined) id = job.id;
        else if (module !== undefined) id = module;
        else return;
      }
      const name = /^launched\s+(.+)$/.exec(id)?.[1]?.trim();
      if (name !== undefined) return shownAfterCommand(pi, ctx, `/halt ${id}`, await haltLaunched(name, track), "info");
      ctx.ui.notify(stopJob(jobs, id, undefined, loop), "info");
    },
  });

  // Debug mode, for the render agents started from now on - see debug-log.ts.
  // A module's history: every render, regeneration and conformance run, as git commits.
  pi.registerCommand("lineage", {
    description: "Show a module's lineage - every generation of its code and tests, and what each was regenerated from: /lineage [module]",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;
      const modules = modulesWithHistory(cwd);
      let name = args.trim();
      if (name === "") {
        if (modules.length === 0) return ctx.ui.notify("No module has any history yet.", "info");
        name = modules.length === 1 ? modules[0]! : ((await ctx.ui.select("Lineage of which module?", modules)) ?? "");
        if (name === "") return;
      }
      pi.appendEntry(HISTORY_ENTRY, { module: name, text: historyLog(defaultBuildDir(name, cwd)) });
    },
  });

  // The side panel: the regeneration - and the pulses behind p - over the whole screen, or beside the chat (s, from one to
  // the other). Its key (PANEL_KEY) opens it; the key again closes it and goes back to the chat, as esc does over the
  // screen - beside the chat, the key switches sides, giving the keys to the chat or the panel, as esc gives them to the
  // chat, the panel staying; ctrl+c closes it.
  // While the panel has the keys, every key is its own.
  // The side panel is the session's, one for every chat: it stays on the screen - beside the chat or over it - as
  // another chat is shown, and what it says to a chat it says to the one shown.
  const sidePanel = sidePanelOf(jobs, cwd);
  const openPanel = sidePanel.open;
  pi.on("session_start", () => {
    sidePanel.say = (text) => pi.sendUserMessage(text, { deliverAs: "followUp" });
  });

  // /pulses opens the side panel on every pulse, regenerating, planned and finished, and what each regenerates; regen -
  // the spec, with how far the code has been regenerated into it - is PANEL_KEY's, no command of its own beside
  // /regenerate. What the agents did is in each pulse's log.
  pi.registerCommand("pulses", {
    description: `The pulses, in the side panel: every pulse, regenerating, planned and finished, and what each regenerates. ${PANEL_KEY} opens the panel too.`,
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      openPanel(ctx, "pulses");
    },
  });

  panelOpeners.set(jobs, (ctx) => openPanel(ctx));
  // A question open in the chat on the screen peeks at this chat's panel.
  const peek = {
    open: (ctx: ExtensionContext) => openPanel(ctx),
    shown: () => sidePanel.shown(),
  };
  questionPeek = peek;
  pi.on("session_start", () => {
    questionPeek = peek;
  });

  pi.registerShortcut(PANEL_KEY, {
    description: "Peek at regen and the pulses - a question waiting in the chat waits for you - or go back to it",
    handler: async (ctx) => {
      if (!ctx.hasUI) return;
      openPanel(ctx);
    },
  });

  // /settings: every setting of config.turri.yaml from the chat, each taking effect as it says - what turri fixed at its
  // start changed here, as it runs.
  registerSettings(pi, {
    cwd,
    rules: ruleNames,
    chatSpec: () => modelSpec(projectModels(readProjectConfig(cwd)).harness),
    live: {
      chatModel: async (spec, ctx) => {
        if (spec === undefined) return "The conversation keeps the model it runs on now; turri starts on pi's own choice next time.";
        const { model, thinking } = splitModelSpec(spec);
        if (model !== undefined) {
          const resolved = resolveModel(model, ctx.modelRegistry);
          if (!resolved.ok) return `The conversation keeps its model: ${model} cannot be used here.\n${describeResolution(resolved)}`;
          const slash = resolved.model.indexOf("/");
          const found = ctx.modelRegistry.find(resolved.model.slice(0, slash), resolved.model.slice(slash + 1));
          if (found === undefined || !(await pi.setModel(found))) return `The conversation keeps its model: ${resolved.model} could not be switched to.`;
        }
        if (thinking !== undefined) pi.setThinkingLevel(thinking);
        return `The conversation runs on ${spec} now.`;
      },
      codingModel: () => {
        const dropped: string[] = [];
        // What the session chose wins over the file; changed in the file, the file's holds from now on.
        if (process.env[CODING_MODEL_ENV] !== undefined) {
          dropped.push(`--coding-model ${process.env[CODING_MODEL_ENV]}`);
          delete process.env[CODING_MODEL_ENV];
        }
        return dropped.length === 0 ? undefined : `Chosen this session, and given way to the config: ${dropped.join("; ")}.`;
      },
      parallelJobs: (count) => {
        const limit = count ?? parallelJobs(cwd);
        jobs.setMaxRunning(limit);
        return `Up to ${limit} pulse${limit === 1 ? "" : "s"} run at once now.`;
      },
    },
  });
}

export { fromWorkingDir };

const WATCH_REDRAW_MS = 500;
/**
 * What a chat's agent is told of a pulse it asked for that ended, with the sentinel off. One that landed under
 * launch-after-pulse is being launched as it is told: it says so, and offers nothing else for it - it is told once the
 * launch ends.
 */
export function pulseEndNote(job: Job, options: { launching?: boolean } = {}): string {
  const head =
    job.status === "succeeded"
      ? `Pulse ${job.id} (${job.kind}) finished after ${formatDuration(job)}.\n\n${job.report ?? ""}`
      : job.status === "stopped"
        ? `Pulse ${job.id} (${job.kind}) was stopped after ${formatDuration(job)}. ${job.error ?? STOPPED_ON_REQUEST}${job.error === undefined || job.error === STOPPED_ON_REQUEST ? " The person stopped it; what it was building counts as not built." : ""}`
        : `Pulse ${job.id} (${job.kind}) failed after ${formatDuration(job)}.\n\n${job.error ?? ""}`;
  const landed = job.status === "succeeded" && (job.details as { landed?: unknown } | undefined)?.landed === true;
  if (!landed || options.launching !== true) return `${head}\n\n${JOB_FINISHED_REACTION}`;
  return [
    head,
    "",
    "It landed, and turri is launching the commit it landed now, in the background (launch-after-pulse): you are told once",
    "that launch ends - where it runs, or why it did not come up. React to this now - the person has not asked, and need",
    "not: say in a line or two what landed and that it is being launched. Offer nothing else for it - do not call launch,",
    "open it, run it or test it, and never say nothing runs - and start no other work, unless guidance for this project",
    "(its AGENTS.md, a skill, what the person said) says to do something besides launching it when a pulse finishes: do",
    "that. When you are told it is launched, do what you were told to do once something is launched.",
  ].join("\n");
}

/**
 * What the agent is to do with a job that just ended, unasked: what the project's guidance says to do then, or else say
 * in a line or two what ended - the person saw it end already, in the transcript.
 */
export const JOB_FINISHED_REACTION = [
  "React to this now - the person has not asked, and need not. If guidance for this project - its AGENTS.md, a skill,",
  "what the person said earlier - says what to do when a pulse finishes (launch what was built, run something, tell",
  "someone), do that, as it says. Otherwise say in a line or two what finished and what it means for the person - the",
  "report is theirs to read in full; do not repeat it - and, when it failed, what they can do. Start no other work.",
  "Under launch-after-pulse turri launches what a pulse lands itself, in the background: do not call launch for it - you",
  "are told once it is launched, and do then what you were told to do once something is launched.",
  "A pulse that stopped on its environment - \"stopped: turri's sandbox kept its agents from…\" or \"stopped: the",
  "environment lacks…\" - stops the same way again until that is fixed: never regenerate it before. Heal it, then regenerate the",
  "module to resume:",
  "- turri's sandbox kept the agents from reading a folder on this machine: nothing is missing. Add the folder its report",
  "  names to `toolchains:` in config.turri.yaml - a list, keeping what is there - say so in a line, and resume.",
  "- turri's sandbox kept the agents from writing a file - a lock a build tool takes, say: no setting lets them, and",
  "  `toolchains:` does not - never add it there, and never resume before the fix. Do what the report says if it is the",
  "  project's to change - a tool told to use `$HOME` in the build's own files - say so, and resume; otherwise tell the",
  "  person, in a line or two, what the report says and that \"resume\" picks it up once it is done.",
  "- the machine lacks a toolchain or a tool - a JDK, Maven, Gradle, Go, uv, Node, a system library: you install nothing,",
  "  and change no setting of the machine's or the person's shell - never, even when asked: your shell refuses it. First",
  "  find out, in your shell, whether it is there after all: off the PATH (`command -v`, Homebrew's opt folders,",
  "  /Library/Java/JavaVirtualMachines, a version manager's folder - mise, asdf, sdkman, nvm), or under another name - python",
  "  where the testing script runs python3, of the version the ***plain names. When it is there, the testing script calling",
  "  it the way this machine has it is the fix: change the script, say so in a line, and resume. When it is not, tell the",
  "  person exactly what to run themselves - `brew install openjdk@21`, `mise use -g java@21` - and the line for their",
  "  shell profile when the PATH needs it, and that \"resume\" picks it up once it is in. A tool the person installs where the",
  "  PATH turri was started with does not reach needs turri restarted: say so.",
  "- a credential `agent-env:` names that is not there: never make one up - tell the person where it is read from.",
].join("\n");

/** The session's side panel: opened from any chat, and the same panel whichever chat is shown. */
interface SidePanelHost {
  open(ctx: ExtensionContext, view?: "map" | "pulses", placement?: "beside"): void;
  /** It shows now, with the keys. */
  shown(): boolean;
  /** What it says to the chat - a module that needs the person: the chat shown says it. */
  say?: (text: string) => void;
}

const sidePanels = new WeakMap<JobRegistry, SidePanelHost>();

/** The side panel of the session these jobs are, made as a chat first asks for it. */
function sidePanelOf(jobs: JobRegistry, cwd: string): SidePanelHost {
  const known = sidePanels.get(jobs);
  if (known !== undefined) return known;
  const self: SidePanelHost = {
    open: (ctx, view, placement) => openPanel(ctx, view, placement),
    shown: () => panel !== undefined && panel.keys,
  };
  sidePanels.set(jobs, self);
  let panel: { handle?: OverlayHandle; view: ReturnType<typeof createSidePanel>; close: () => void; keepChatFocus: () => void; layOut: () => void; keys: boolean } | undefined;
  // Beside the chat or over it: as the person last left it, for the conversation.
  let panelDocked = false;
  // The terminal the panel is drawn on, for its width: set as it opens.
  let panelTerminal: { columns: number } | undefined;
  /** The columns the panel takes beside the chat - 0 over the whole screen, or when the terminal is too narrow to share. */
  const panelBeside = (): number => (panelDocked && panelTerminal !== undefined ? dockedWidth(paddedColumns(panelTerminal.columns)) : 0);
  // What is open in the pulse list and the map, and where their cursors are: the conversation's, as left each time it opens.
  const jobsTree = createJobsTreeState();
  // Earlier sessions' pulses, from the ledger: read as the panel first shows them - they do not change while this one runs.
  let earlier: Job[] | undefined;
  const earlierJobs = (): Job[] => {
    if (earlier !== undefined) return earlier;
    try {
      const found = earlierPulses(ledgerProjects(cwd), new Set(jobs.list().map((job) => job.id)));
      earlier = found.jobs;
      jobsTree.earlierMore = found.more;
    } catch {
      earlier = [];
    }
    return earlier;
  };
  const mapState = createSpecMapState();
  // The map from the files - the .plain files asked for, else the project's - with the work loop's plan laid over them.
  const specMap = createSpecMapSource({
    files: () => {
      const asked = workLoops.get(jobs)?.loop.mapPlan().files ?? [];
      return asked.length > 0 ? asked : defaultMapFiles(cwd);
    },
    plan: () => workLoops.get(jobs)?.loop.mapPlan() ?? { files: [], codebases: [] },
  });

  /** Open the side panel - on the view named, or as it was left. */
  const openPanel = (ctx: ExtensionContext, view?: "map" | "pulses", placement?: "beside") => {
    // Found: ctrl+h under the job panel stops breathing.
    keyPressed("peek");
    if (view !== undefined) mapState.view = view;
    // A pulse that failed or stopped since the panel was last opened: opened as it is, it is on that pulse - what went
    // wrong is what the person opens it to see.
    else {
      const id = needsLooking.get(jobs);
      if (id !== undefined && selectJob(shownJobs(jobs), jobsTree, id)) mapState.view = "pulses";
    }
    needsLooking.delete(jobs);
    if (placement === "beside") panelDocked = true;
    if (panel !== undefined) {
      panel.layOut();
      panel.keepChatFocus();
      panel.handle?.setHidden(false);
      panel.keys = true;
      panel.handle?.focus();
      return;
    }
    // Not awaited: the panel lives on while the jobs it shows run.
    void ctx.ui.custom<void>(
      (tui, theme, _keybindings, done) => {
        // What the chat shows when the panel takes the keys - its editor, or a pi dialog - for when it gives them back.
        const focusedNow = () => (tui as unknown as { getFocusedComponent?(): Component | null }).getFocusedComponent?.() ?? null;
        let chatFocus = focusedNow();
        const keepChatFocus = () => {
          const focused = focusedNow();
          if (focused !== null && focused !== component && !(focused instanceof QuestionDialog)) chatFocus = focused;
        };
        // The keys back to the chat: to the question open there now, else to what it showed - never to a question answered
        // while the panel was open.
        const giveBack = () => entry.handle?.unfocus({ target: questionShown ?? chatFocus });
        const close = () => {
          giveBack();
          done(undefined);
        };
        panelTerminal = tui.terminal;
        let component: { render(width: number): readonly string[]; dispose?(): void } | undefined;
        // Beside the chat: the chat drawn narrower, on the left, and a click on either side giving it the keys - undone
        // when the panel goes over the screen, or closes.
        let undock: (() => void) | undefined;
        const layOut = () => {
          if (panelDocked && undock === undefined) {
            const widen = narrowChat(tui, panelBeside);
            const unwatch = clickToFocus(
              tui,
              () => tui.terminal.columns - SCREEN_PADDING.right - panelBeside(),
              (side) => {
                if (panelBeside() === 0) return;
                if (side === "chat") toChat();
                else toPanel();
              },
            );
            // The side without the keys in the shade: the chat while the panel has them.
            const unshade = shadeChat(tui, () => panelBeside() > 0 && entry.keys);
            undock = () => {
              unshade();
              unwatch();
              widen();
            };
          } else if (!panelDocked && undock !== undefined) {
            undock();
            undock = undefined;
          }
        };
        // Beside the chat, back to it: the chat has the keys, the panel stays.
        const toChat = () => {
          entry.keys = false;
          giveBack();
          tui.requestRender();
        };
        const toPanel = () => {
          keepChatFocus();
          entry.keys = true;
          entry.handle?.focus();
          tui.requestRender();
        };
        const back = () => (panelBeside() > 0 ? toChat() : close());
        // Opened, it reads the files again at once: they may have changed while it was closed.
        specMap.refresh();
        const view = createSidePanel({
          pointer: terminalPointer(tui.terminal),
          tabLabel: (text, active, hovered, role) => buttonLabel(theme, text, active, hovered, role),
          jobs: () => shownJobs(jobs),
          earlier: earlierJobs,
          tree: jobsTree,
          map: () => specMap.read(),
          mapState,
          rows: () => paddedRows(tui.terminal.rows),
          key: PANEL_KEY,
          dock: {
            docked: () => panelBeside() > 0,
            toggle: () => {
              panelDocked = panelBeside() === 0;
              layOut();
              tui.requestRender();
            },
          },
          style: {
            heading: (text) => theme.bold(theme.fg("accent", text)),
            muted: (text) => theme.fg("muted", text),
            accent: (text) => theme.fg("accent", text),
            error: (text) => theme.fg("error", text),
            success: (text) => theme.fg("success", text),
            warning: (text) => theme.fg("warning", text),
            added: (text) => theme.fg("toolDiffAdded", text),
            removed: (text) => theme.fg("toolDiffRemoved", text),
            // A spec diff's ***plain highlighted by turri's grammar, and its added and removed lines filled.
            diff: plainPaint(theme),
            // What conformance tests show does what its spec says: neon.
            conforms: brandNeon(theme),
          },
          back,
          close,
          // A module that needs the person: the chat takes it up with them, in their words - what went wrong, and what now.
          discuss: (page) => {
            back();
            const why = page.codebase?.stuck?.why;
            self.say?.(
              `regen says ${page.module} needs me: ${page.status}. What went wrong, and what do we do about it?${why !== undefined ? `\n\n(turri's reason: ${why})` : ""}`,
            );
          },
          // Something took the keys' focus while the panel showed - a question in the chat - and waits there.
          waiting: () => {
            if (!entry.keys) return false;
            const focused = (tui as unknown as { getFocusedComponent?(): unknown }).getFocusedComponent?.() ?? null;
            return focused !== null && focused !== component;
          },
        });
        const entry: NonNullable<typeof panel> = { view, close, keepChatFocus, layOut, keys: true };
        panel = entry;
        layOut();
        // Every key goes to the panel while it shows, whatever has the focus: a question the chat model asks in the
        // background takes the focus, but no key reaches it - an enter never answers it unseen. It waits in the chat
        // until the panel closes, and has the keys then. Mouse events are the screen's, before this sees them.
        // Only while it is on the screen: up in the TUI's overlays and not hidden. An overlay taken off without the panel
        // being disposed - another one closed over it - leaves no panel to take keys for: it lets them go, and goes.
        const shown = (): boolean | "gone" => {
          const overlays = (tui as unknown as { overlayStack?: Array<{ component: unknown }> }).overlayStack;
          if (entry.handle === undefined || component === undefined) return false;
          if (overlays !== undefined && !overlays.some((overlay) => overlay.component === component)) return "gone";
          return entry.handle.isHidden() !== true;
        };
        const unlisten = tui.addInputListener((data) => {
          const state = shown();
          if (state === "gone") {
            component?.dispose?.();
            return undefined;
          }
          if (!state) return undefined;
          // Beside the chat, with the chat's keys: they are the chat's - PANEL_KEY among them, for the shortcut that gives
          // them to the panel. A click on the panel gives it the focus, and the keys with it.
          if (!entry.keys && entry.handle?.isFocused() !== true) return undefined;
          entry.keys = true;
          // A terminal on the Kitty keyboard protocol reports a key's release, and listeners are given it: the release of
          // the ctrl+h that opened the panel would close it again at once, and every arrow would move twice. Only
          // presses count - and ctrl+h held down, repeating, does not open and close it over and over.
          if (isKeyRelease(data) || (isKeyRepeat(data) && matchesKey(data, PANEL_KEY))) return { consume: true };
          // PANEL_KEY goes back: beside the chat, to the chat, the panel staying - the switch between the sides, as it is
          // from the chat to the panel - and over the screen, closing it. ctrl+c closes it either way: whatever else goes
          // wrong, a key always leads back to the chat.
          if (matchesKey(data, "ctrl+c")) close();
          else if (matchesKey(data, PANEL_KEY)) back();
          else {
            try {
              view.handleInput(data);
            } catch {
              /* a key the panel fails on is dropped, never the panel's hold on the keys */
            }
          }
          tui.requestRender();
          return { consume: true };
        });
        // Jobs keep writing; redraw so the panel follows them while it shows.
        const timer = setInterval(() => {
          if (entry.handle?.isHidden() !== true) tui.requestRender();
        }, WATCH_REDRAW_MS);
        timer.unref?.();
        component = {
          // Beside the chat, a rule down its left edge between them - and the panel in the shade while the chat has the keys.
          render: (width: number) => {
            if (panelBeside() === 0) return view.render(width);
            const lines = view.render(width - 2).map((line) => `${theme.fg("borderMuted", "│")} ${line}`);
            return entry.keys ? lines : lines.map(shade);
          },
          // Reached only if the listener above is gone: the same, so the panel never passes a key on.
          handleInput: (data: string) => {
            if (isKeyRepeat(data) && matchesKey(data, PANEL_KEY)) return;
            if (matchesKey(data, "ctrl+c")) close();
            else if (matchesKey(data, PANEL_KEY)) back();
            else view.handleInput(data);
            tui.requestRender();
          },
          handleMouse: (event: Parameters<NonNullable<ReturnType<typeof createSidePanel>["handleMouse"]>>[0]) =>
            view.handleMouse(panelBeside() > 0 ? { ...event, x: event.x - 2, width: event.width - 2 } : event),
          invalidate: () => view.invalidate(),
          dispose: () => {
            unlisten();
            clearInterval(timer);
            undock?.();
            if (panel === entry) panel = undefined;
          },
        } as { render(width: number): readonly string[]; dispose?(): void };
        return component as never;
      },
      {
        overlay: true,
        // The whole screen, or the columns on the right beside the chat - read at each frame, so it follows the terminal -
        // inside the screen's padding.
        overlayOptions: {
          get width() {
            return panelBeside() > 0 ? panelBeside() : "100%";
          },
          maxHeight: "100%",
          anchor: "top-right",
          margin: { ...SCREEN_PADDING },
        },
        onHandle: (handle) => {
          if (panel !== undefined) panel.handle = handle;
        },
      },
    );
  };

  return self;
}

/** Opens the side panel, and goes back to it from the conversation. */

/** The modules in this project that have a history, by name. */
function modulesWithHistory(cwd: string): string[] {
  const root = join(cwd, "plain_modules");
  try {
    return readdirSync(root).filter((name) => existsSync(join(root, name, HISTORY_DIR)));
  } catch {
    return [];
  }
}

/** Stop a job by id or id prefix, and say what that means for the queue. */
/** Every job, in the order it was started, with what a queued one is waiting for. */
/** What a launch started, as /halt offers it. */
function launchedLabel(name: string, what: string): string {
  return `launched ${name}  running  ${what}`;
}

/** The jobs as the person is shown them: those started, and those the work loop has planned after them. */
function shownJobs(jobs: JobRegistry): Job[] {
  return [...(workLoops.get(jobs)?.loop.planned() ?? []), ...jobs.list()];
}

function listJobs(jobs: JobRegistry, cwd: string, runs = EARLIER_RUNS): string {
  const all = [...shownJobs(jobs)].reverse().filter((job) => job.replacedBy === undefined);
  const servers = runningLaunched().map((item) => `launched ${item.name}  running  ${item.moduleName}: ${item.url ?? item.command}  (pid ${item.pid}, output in ${relative(process.cwd(), item.log) || item.log})`);
  const launches = (sessionLaunches.get(jobs)?.track.list() ?? []).slice(-10).reverse().map(describeLaunchLine);
  const listed =
    (launches.length > 0 ? `\n\nLaunches, newest first - /halt launched <module> halts one under way:\n${launches.join("\n")}` : "") +
    (servers.length > 0 ? `\n\nWhat launches started - /halt launched <name> halts one:\n${servers.join("\n")}` : "");
  const before = earlierRuns(jobs, cwd, runs);
  if (all.length === 0) return `No pulses have been started in this session.${listed}${before}`;
  return `${jobLines(all)}${listed}${before}`;
}

/** How many runs of earlier sessions `pulses` lists when it is asked for none. */
const EARLIER_RUNS = 3;

/** Earlier sessions' last runs and their pulses, from the ledger - nothing when it has none. */
function earlierRuns(jobs: JobRegistry, cwd: string, runs: number): string {
  try {
    const found = earlierPulses(ledgerProjects(cwd), new Set(jobs.list().map((job) => job.id)), runs);
    if (found.runs.length === 0) return "";
    const more = found.more > 0 ? `\n\n${found.more} earlier run${found.more === 1 ? "" : "s"} beyond these: ask with runs for more.` : "";
    return `\n\nEarlier sessions, from the ledger - pulses with a pulse's id tells one:\n${describeRuns(found.runs)}${more}`;
  } catch {
    return "";
  }
}

/** A look ahead, for the chat: what is planned in each codebase, each row by its id, and what happens next. */
function describeLookAhead(loop: WorkLoop, statuses: ModuleStatus[]): string {
  const modules = new Set(statuses.map((status) => status.module));
  const rows = loop.planned().filter((row) => row.module !== undefined && modules.has(row.module));
  const listed = rows.length > 0 ? `\n\nThe planned pulses - pulses with a row's id tells its cases and, for the next pulse of a codebase, the whole prompt its coding agent will get:\n${rows.map((row) => `${row.id}  ${row.summary}`).join("\n")}` : "";
  return (
    `${describeModules(statuses)}${listed}\n\n` +
    "Nothing was started. What is planned here waits for regenerate, conform or /regenerate, which runs this plan as it is - unless " +
    "the ***plain changes first, when it is planned again. To change the plan, change the ***plain, then " +
    "look again. Tell the user what will run and in what order - the parts they are likely to care about."
  );
}

/** A planned row, for the chat: what it is, and its prompt when it is the next pulse of its codebase. */
function describePlannedRow(row: Job, pulse: PlannedPulse | undefined): string {
  const head = `${row.id} · ${pulseName(row)}: ${row.note ?? "planned, not started"}${row.waitingOn.length > 0 ? ` It runs after ${row.waitingOn.join(", ")}.` : ""}`;
  if (pulse?.task !== undefined) {
    return (
      `${head}\n\nThe whole prompt its coding agent will get - built from the plan kept, the one regenerate runs:\n<prompt>\n${pulse.task}\n</prompt>\n\n` +
      "Tell the user what the pulse is and what it will be told - the parts they are likely to care about, not the whole prompt unless they ask."
    );
  }
  return pulse?.why !== undefined ? `${head}\n\nNo prompt shown: ${pulse.why}` : head;
}

function jobLines(all: Job[]): string {
  return all
    .map((job) => {
      // Planned by the work loop, not started: it has no job of the registry's yet.
      const planned = job.id.startsWith("planned-");
      const time = job.status === "queued" ? "waiting" : formatDuration(job);
      const after = job.status === "queued" && job.waitingOn.length > 0 ? `  (after ${job.waitingOn.join(", ")})` : "";
      const spent = describeUsage(job.usage);
      const model = job.model ? `  · ${job.model}` : "";
      const held = job.lookedAhead === true ? "  · looked ahead: waits for regenerate" : "";
      return `${job.id}  ${(planned ? "planned" : job.status).padEnd(9)} ${time.padStart(7)}  ${pulseName(job)}${model}${after}${held}${spent ? `  · ${spent}` : ""}`;
    })
    .join("\n");
}



/**
 * The ***plain parsed - its syntax and structure - regenerating nothing.
 *
 * This is the check that used to mean a renderer dry-run. It runs this repo's own parser,
 * so it needs no external tool, no API key and no credits - and it is the only honest way
 * to answer "is this spec valid?" without generating anything.
 */
function registerCheckPlain(pi: ExtensionAPI, cwd: string, dialogs?: AskUserIO, afterAnswer?: (answer: string) => string | undefined) {
  pi.registerTool(checkPlainTool(cwd));
  pi.registerTool(chatAskUserTool(dialogs, afterAnswer));
  // The web, for the conversation too - a library's documentation, an API, an error; curl is its
  // bash. Run here, like the rendering agents' (see render/web.ts).
  for (const tool of createWebTools()) pi.registerTool(tool);
}

const SIDE_ENTRY = "turri_btw";
/** A message the person sent while a skill ran in the chat, read by the skill's agent: drawn as the message it is. */
const SKILL_MESSAGE_ENTRY = "turri_skill_message";

/**
 * /btw, a question on the side (btw.ts): answered at once, even while a skill runs - pi runs a command mid-turn - and
 * shown in the transcript, never in a model's context.
 */
function registerSideQuestions(pi: ExtensionAPI, cwd: string, jobs: JobRegistry) {
  pi.registerCommand("btw", {
    description: "Ask turri something on the side - answered now, even mid-skill, and left out of the conversation: /btw <question>",
    handler: async (args, ctx) => {
      const question = args.trim();
      if (question === "") return ctx.ui.notify(BTW_HOW, "info");
      ctx.ui.notify(`Looking into it: ${question}`, "info");
      // Not awaited: the editor is free while it is answered, for another /btw or the conversation.
      void askOnTheSide(pi, ctx, cwd, jobs, question).catch((error: unknown) =>
        ctx.ui.notify(`The side question could not be answered: ${error instanceof Error ? error.message : String(error)}`, "error"),
      );
    },
  });

  pi.registerEntryRenderer(COMMAND_OUTCOME, (entry, _options, theme) => {
    const data = entry.data as CommandOutcome | undefined;
    if (data === undefined) return undefined;
    const box = new Box(1, 0);
    // The command as typed; what it said, under it - or, said without it above, with it.
    const said = data.text !== undefined ? theme.fg(data.level === undefined || data.level === "info" ? "text" : data.level, data.text) : undefined;
    const lines = data.text === undefined ? [theme.bold(theme.fg("accent", data.command))] : data.echoed === true ? [said!] : [theme.fg("muted", data.command), said!];
    box.addChild(new Text(lines.join("\n"), 0, 0));
    return box;
  });

  pi.registerEntryRenderer(SKILL_MESSAGE_ENTRY, (entry) => {
    const data = entry.data as { text: string } | undefined;
    if (data === undefined) return undefined;
    return new UserMessageComponent(data.text, getMarkdownTheme());
  });

  pi.registerEntryRenderer(SIDE_ENTRY, (entry, _options, theme) => {
    const data = entry.data as { question: string; answer: string } | undefined;
    if (data === undefined) return undefined;
    const box = new Box(1, 0);
    box.addChild(new Text([theme.fg("muted", `btw: ${data.question}`), theme.fg("text", data.answer)].join("\n"), 0, 0));
    return box;
  });
}

/** A side question answered - from the conversation, the skill running, the pulses - and kept in the transcript. */
async function askOnTheSide(pi: ExtensionAPI, ctx: ExtensionContext, cwd: string, jobs: JobRegistry, question: string): Promise<string> {
  let entries: unknown[] = [];
  try {
    entries = ctx.sessionManager.getEntries();
  } catch {
    // Without the conversation it is still answered, from the skill and the project.
  }
  const skill = runningSkill();
  const answer = await answerSideQuestion(
    {
      question,
      conversation: transcriptOf(entries, 24_000),
      ...(skill !== undefined ? { skill: { name: skill.skill, dir: skill.dir, step: skill.step(), trace: skill.trace(), session: skillSessionText(skill.runDir) } } : {}),
      pulses: jobs.list().map((job) => `${job.id} ${job.status}: ${pulseName(job)}`),
      projectDir: cwd,
      harnessDir: PACKAGE_ROOT,
      ...(surfaceOf(jobs) !== undefined ? { surface: surfaceOf(jobs) } : {}),
    },
    chatModelOf(ctx),
  );
  try {
    pi.appendEntry(SIDE_ENTRY, { question, answer });
  } catch {
    // Shown where it was asked all the same.
  }
  return answer;
}

/** A launch ended, told to a chat's agent - to tell the person where it runs, or why it did not come up. */
function tellLaunch(pi: ExtensionAPI, jobs: JobRegistry, launch: Launch): void {
  const job = "pulse" in launch.cause ? jobs.get(launch.cause.pulse) : undefined;
  void pi.sendMessage(
    { customType: "turri_launch", content: launchedNote(launch, job), display: false, details: { launch: launch.id, status: launch.status } },
    { triggerTurn: true, deliverAs: "followUp" },
  );
}

/** A newer launch took the place of one a chat asked for, told to its agent: it hears that one's end instead. */
function tellReplaced(pi: ExtensionAPI, jobs: JobRegistry, launch: Launch, next: Launch): void {
  const job = "pulse" in next.cause ? jobs.get(next.cause.pulse) : undefined;
  void pi.sendMessage(
    { customType: "turri_launch", content: replacedNote(launch, next, job), display: false, details: { launch: launch.id, status: launch.status, replacedBy: next.id } },
    { triggerTurn: true, deliverAs: "followUp" },
  );
}

function registerLaunch(pi: ExtensionAPI, cwd: string, jobs: JobRegistry) {
  const launches = sessionLaunches.get(jobs);
  if (launches !== undefined) {
    pi.registerTool(
      launchTool({
        cwd,
        track: launches.track,
        defaultPlainFile: () => readProjectConfig(cwd).module,
        chat: () => currentChat()?.id,
        // Told in the chat that asked, as a launch after a pulse is with the sentinel off.
        ended: (launch) => tellLaunch(pi, jobs, launch),
        replaced: (launch, next) => tellReplaced(pi, jobs, launch, next),
        wait: (ctx) => shouldWait(ctx.mode, undefined),
      }),
    );
  }
  pi.registerTool(haltTool({ jobs, workLoop: () => workLoops.get(jobs)?.loop, ...(launches !== undefined ? { launches: launches.track } : {}) }));
  // What launches started runs until turri ends - not when a chat is opened, closed, forked or reloaded.
  pi.on("session_shutdown", async (event) => {
    if (event.reason !== "quit") return;
    await launches?.track.stop();
    await stopLaunched();
  });
}

const MILESTONE_ENTRY = "turri_milestone";
/** A newer turri out, found once turri had started (turri-versions.ts). */
const VERSION_ENTRY = "turri_version";
const JOB_ENTRY = "turri_job";
const JOBS_LIST_ENTRY = "turri_jobs";
const HISTORY_ENTRY = "turri_history";

interface JobAnnouncement {
  id: string;
  summary: string;
  status: "succeeded" | "failed" | "stopped";
  /** The job ran to its end, and what it built did not pass - a build that stopped at a gate. */
  incomplete?: boolean;
  duration: string;
  /** Tokens and cost, when any were spent. */
  spent?: string;
  text: string;
}

function announceJob(pi: ExtensionAPI, job: Job): void {
  if (job.status !== "succeeded" && job.status !== "failed" && job.status !== "stopped") return;
  const announcement: JobAnnouncement = {
    id: job.id,
    // Its module, kind and number - never what it regenerates, which is the agents' words and long.
    summary: pulseName(job),
    status: job.status,
    incomplete: job.status === "succeeded" && (job.details as { passed?: unknown } | undefined)?.passed === false,
    duration: formatDuration(job),
    spent: describeUsage(job.usage) || undefined,
    text:
      job.specConflict !== undefined
        ? describeSpecConflict(job.specConflict)
        : job.status === "succeeded"
        ? (job.announce ?? job.report ?? "")
        : job.status === "stopped"
          ? (job.note ?? "Stopped on request. Whatever it changed before it stopped is still on disk; the functionality it was on counts as not built.")
          : (job.error ?? "no error recorded"),
  };
  try {
    pi.appendEntry(JOB_ENTRY, announcement);
  } catch {
    // The agent still gets the report; losing the entry must not lose the result.
  }
}

/**
 * What the conversation's agent is asked to do about a spec that contradicts itself: confirm it
 * with analyze-2-func-specs, work out the ways out with resolve-spec-conflict, and put the choice
 * to the person - who decides. Nothing in the spec is changed before they have.
 */
function specConflictTask(conflict: SpecConflict): string {
  const [one, two] = conflict.specs;
  return [
    describeSpecConflict(conflict),
    "",
    `The render stopped on it: the conformance run's judge found them conflicting, ${conflict.reasons.length} times -`,
    `functional spec ${one!.module}:${one!.funcId} (${one!.plainFile}) and functional spec ${two!.module}:${two!.funcId} (${two!.plainFile}). Now:`,
    "1. Run the analyze-2-func-specs skill (cultivate) on these two functional specs, to confirm they conflict.",
    "2. If they do, run the resolve-spec-conflict skill on the pair, to work out what could be changed - but change nothing yet.",
    "3. Tell the user exactly what the conflict is - both specs as they read, and the behaviour that cannot satisfy both -",
    "   and put the decision to them with ask_user: the ways out resolve-spec-conflict found, and Something else. Suggest they",
    "   simply decide which is meant; it is their call, not yours.",
    "4. Only once they have decided, make the change they chose to the .plain file it belongs in - either module's -",
    "   and regenerate it - its conformance tests follow it.",
    "If analyze-2-func-specs finds the two compatible, tell the user so, and that the conformance tests of these two are what",
    "kept failing - offer to conform them again.",
  ].join("\n");
}

const INTERVIEW_ENTRY = "turri_exchange";

/**
 * A skill's question as the transcript keeps it: who asked, what it said before asking - a brief to confirm, the choices
 * it weighed, shown in the dialog that is gone once answered - the question, and the answer.
 */
export function exchangeLines(data: Exchange, fg: (color: "muted" | "text" | "dim" | "accent", text: string) => string): string[] {
  const said = data.said !== undefined ? data.said.split("\n").map((line) => fg("text", line)) : [];
  const answer = data.answer.trim() === "" ? fg("dim", "> (no answer)") : fg("accent", `> ${data.answer}`);
  return [fg("muted", `${data.skill} asked`), ...said, ...(said.length > 0 ? [""] : []), fg("text", data.question), answer];
}

export interface Exchange {
  skill: string;
  /** What the skill's agent said before asking - a brief to confirm, the choices it weighed: shown in the dialog, kept here. */
  said?: string;
  question: string;
  answer: string;
}

/**
 * Show each question and answer in the transcript, where the person can see it.
 *
 * A skill runs inside one tool call and asks through dialogs, so its interview leaves no
 * trace in the conversation - the questions vanish once answered. These are custom
 * *entries* rather than messages on purpose: they are durable and rendered, but they do
 * not enter the model's context, so a long interview is readable without being paid for
 * twice.
 */
function registerInterviewLog(pi: ExtensionAPI) {
  pi.registerEntryRenderer(JOB_ENTRY, (entry, _options, theme) => {
    const data = entry.data as JobAnnouncement | undefined;
    if (data === undefined) return undefined;
    // A job that ran to its end but whose build did not pass is not a success: it says so.
    const header =
      data.status === "succeeded" && data.incomplete === true
        ? `${theme.fg("error", "✗")} ${theme.fg("text", data.summary)} ${theme.fg("error", `did not pass - stopped after ${data.duration}`)}`
        : data.status === "succeeded"
        ? `${theme.fg("success", "✓")} ${theme.fg("text", data.summary)} ${theme.fg("muted", `finished after ${data.duration}`)}`
        : data.status === "stopped"
          ? `${theme.fg("warning", "■")} ${theme.fg("text", data.summary)} ${theme.fg("warning", `stopped after ${data.duration}`)}`
          : `${theme.fg("error", "✗")} ${theme.fg("text", data.summary)} ${theme.fg("error", `failed after ${data.duration}`)}`;
    const spent = data.spent ? ` ${theme.fg("muted", `· ${data.spent}`)}` : "";
    // Its headline only: the chat has the whole report, and says what it means - or does what the project says to. One
    // that went wrong says where to see why: the live panel, which said it, is gone with the last pulse.
    const wrong = data.status !== "succeeded" || data.incomplete === true;
    const box = new Box(1, 0);
    box.addChild(new Text(header + spent + (wrong ? `\n${theme.fg("muted", `  ${PANEL_KEY} shows this pulse - its stages, what its agents did, its log`)}` : ""), 0, 0));
    return box;
  });

  pi.registerEntryRenderer(HISTORY_ENTRY, (entry, _options, theme) => {
    const data = entry.data as { module: string; text: string } | undefined;
    if (data === undefined) return undefined;
    const box = new Box(1, 0);
    box.addChild(new Text([theme.fg("muted", `history of ${data.module}`), theme.fg("text", data.text)].join("\n"), 0, 0));
    return box;
  });

  pi.registerEntryRenderer(JOBS_LIST_ENTRY, (entry, _options, theme) => {
    const data = entry.data as { text: string } | undefined;
    if (data === undefined) return undefined;
    const box = new Box(1, 0);
    box.addChild(new Text([theme.fg("muted", "pulses"), theme.fg("text", data.text)].join("\n"), 0, 0));
    return box;
  });

  pi.registerEntryRenderer(MILESTONE_ENTRY, (entry, _options, theme) => {
    const data = entry.data as { module: string; text: string } | undefined;
    if (data === undefined) return undefined;
    const box = new Box(1, 0);
    box.addChild(
      new Text(`${theme.fg("success", "●")} ${theme.fg("muted", data.module)} ${theme.fg("text", data.text)}`, 0, 0),
    );
    return box;
  });

  pi.registerEntryRenderer(INTERVIEW_ENTRY, (entry, _options, theme) => {
    const data = entry.data as Exchange | undefined;
    if (data === undefined) return undefined;

    // Two details of the TUI components matter here. Box's third argument is a
    // *background* function - passing a foreground colour into it tints every line, which
    // is what made these unreadable. And Text pads by 1 on both axes unless told
    // otherwise, so one Text per line puts a blank line between each. Hence a single Text
    // with explicit zero padding, coloured per line.
    const box = new Box(1, 0);
    box.addChild(new Text(exchangeLines(data, (color, text) => theme.fg(color, text)).join("\n"), 0, 0));
    return box;
  });
}

function recordExchange(pi: ExtensionAPI, exchange: Exchange): void {
  try {
    pi.appendEntry(INTERVIEW_ENTRY, exchange);
  } catch {
    // The trace still carries it; a rendering failure must not lose the answer.
  }
}


/**
 * What the skill should be told about the conversation that started it.
 *
 * The agent's own summary comes first, because it knows which parts matter. The user's
 * recent messages are appended verbatim underneath: a summary drops the particulars - a
 * product name, a phrasing the user chose - and those are exactly what makes a skill's
 * first question sound like it was listening.
 */
function conversationContext(ctx: ExtensionContext, summary: string | undefined): string | undefined {
  const spoken = recentUserMessages(ctx, 12);
  const parts: string[] = [];
  if (summary !== undefined && summary.trim() !== "") parts.push(summary.trim());
  if (spoken.length > 0) {
    parts.push(`In their own words:\n${spoken.map((line) => `- ${line}`).join("\n")}`);
  }
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

function recentUserMessages(ctx: ExtensionContext, limit: number): string[] {
  let entries: unknown[];
  try {
    entries = ctx.sessionManager.getEntries();
  } catch {
    return [];
  }

  const said: string[] = [];
  for (const entry of entries) {
    const message = (entry as { type?: string; message?: { role?: string; content?: unknown } }).message;
    if ((entry as { type?: string }).type !== "message" || message?.role !== "user") continue;

    const text =
      typeof message.content === "string"
        ? message.content
        : Array.isArray(message.content)
          ? message.content
              .filter((part) => (part as { type?: string }).type === "text")
              .map((part) => (part as { text?: string }).text ?? "")
              .join(" ")
          : "";

    const trimmed = text.trim().replace(/\s+/g, " ");
    if (trimmed !== "") said.push(trimmed.length > 400 ? `${trimmed.slice(0, 400)}…` : trimmed);
  }

  return said.slice(-limit);
}


const BANNER_ENTRY = "turri_banner";

/**
 * The name on the door.
 *
 * Pi's own startup header is a built-in component an extension cannot replace, so this
 * adds a wordmark of its own at the top of the session. `turri` starts pi without
 * its header (see pi-launch.ts), leaving only this one.
 */
/**
 * The ***plain rules as the conversation has them in its system prompt, every turn - the standard library's
 * inventory among them, in its rule, so the conversation knows what a spec can import from the start.
 */
export function chatRulesBlock(rules = loadRules(join(PACKAGE_ROOT, "genome", "rules"))): string {
  return renderRulesBlock(rules);
}

function registerBranding(pi: ExtensionAPI, skills: SkillCatalogue) {
  pi.registerCommand("stdlib", {
    description: "List the ***plain standard library: the stacks a spec can import instead of writing its implementation reqs.",
    handler: async (_args, ctx) => {
      if (ctx.hasUI) ctx.ui.notify(describeStdlib(), "info");
    },
  });

  pi.registerEntryRenderer(BANNER_ENTRY, (entry, _options, theme) => {
    const data = entry.data as
      | {
          version: string;
          /** The commit, when turri runs from a clone - and whether the clone has changes on it. */
          commit?: string;
          changed?: boolean;
          /** How many skills failed to load. */
          pending: number;
          sandbox?: ReturnType<typeof sandboxSummary>;
          /** A newer turri out, or installed and hidden behind this one on the PATH: a line each (turri-versions.ts). */
          versions?: string[];
          /** What turri says of the config files: a key it renamed in one, an old name left, keys it does not read. */
          config?: ConfigLine[];
        }
      | undefined;
    if (data === undefined) return undefined;

    const lines = [
      `${brandPink(theme)("turri")}  ${theme.fg("muted", `v${data.version}`)}` +
        (data.commit !== undefined ? theme.fg("dim", `  from a clone, ${data.commit}${data.changed ? " with changes" : ""}`) : ""),
      // A newer turri out, or one installed and hidden behind this one: said first, under the version it is about.
      ...(data.versions ?? []).map((line) => theme.fg("warning", line)),
      // A key renamed is information; one that does not parse stops everything that reads it; the rest are the person's to take out.
      ...(data.config ?? []).map((line) => theme.fg(line.kind === "renamed" ? "muted" : line.kind === "broken" ? "error" : "warning", line.text)),
      `${theme.fg("text", "the first coding agent with the power of ")}${brandPink(theme)("regenerative software")}`,
      // Where the settings are changed, without leaving the chat.
      theme.fg("muted", "configure with /settings"),
      // Only what is wrong: skills that did not load, and agents' commands less fenced than they should be.
      ...(data.pending > 0 ? [theme.fg("warning", `${data.pending} skill${data.pending === 1 ? "" : "s"} failed to load`)] : []),
      ...(data.sandbox !== undefined && data.sandbox.level !== "ok" ? [theme.fg(data.sandbox.level === "limited" ? "warning" : "error", data.sandbox.text)] : []),
    ];
    // The jellyfish turri is named after, regenerating, in ink for the theme's background: a picture
    // where the terminal shows images, drawn in text where it does not.
    return new Banner(lines, (rule) => theme.fg("borderMuted", rule), jellyfishArt(theme.appearance, (theme.getColorMode?.() ?? "truecolor") === "truecolor"));
  });

  // A newer turri, found once turri had started: a line, as the banner would have said it.
  pi.registerEntryRenderer(VERSION_ENTRY, (entry, _options, theme) => {
    const data = entry.data as { text: string } | undefined;
    if (data === undefined) return undefined;
    const box = new Box(1, 0);
    box.addChild(new Text(theme.fg("warning", data.text), 0, 0));
    return box;
  });

  let bannered = false;
  pi.on("session_start", (_event, ctx) => {
    if (ctx.hasUI) {
      padTheScreen(ctx);
      animateJellyfish(ctx);
      // ***plain an agent shows in the chat, highlighted in the theme of the moment.
      highlightPlainCodeBlocks(() => ctx.ui.theme);
    }
    // Once a chat: it starts again each time it is shown.
    if (bannered) return;
    bannered = true;
    try {
      const identity = turriIdentity();
      const versions = bannerWarnings();
      // A newer turri npm says is out only now - the banner read what it said last time: said under the banner once it does.
      void versions.later.then((line) => {
        if (line === undefined) return;
        try {
          pi.appendEntry(VERSION_ENTRY, { text: line });
        } catch {
          /* the chat let go meanwhile: the next start's banner says it */
        }
      });
      pi.appendEntry(BANNER_ENTRY, {
        version: identity.version ?? "0.0.0",
        commit: identity.git_commit?.slice(0, 7),
        changed: identity.git_dirty === true,
        pending: skills.pending.length,
        sandbox: sandboxSummary(),
        versions: versions.lines,
        config: configLines(ctx.cwd),
      });
    } catch {
      // Branding is the least important thing here; never let it stop a session starting.
    }
  });
}

/**
 * How many rows the banner's picture takes at most: its frame reaches down to the sea floor the polyp stands on, so it
 * is given more than the jellyfish drawn in text, ten.
 */
const JELLYFISH_ROWS = 14;


/** How far along its sequence the jellyfish every banner shows is, moved on by `animateJellyfish`. */
let jellyfishFrame = 0;

/** The frame the jellyfish is on: the one its sequence has at this point. */
export const shownFrame = () => JELLYFISH_SEQUENCE[jellyfishFrame % JELLYFISH_SEQUENCE.length]!;
let jellyfishTimer: ReturnType<typeof setInterval> | undefined;

/**
 * Moves the jellyfish on a frame every JELLYFISH_FRAME_MS while the banner is on the screen. An entry's
 * renderer is given no TUI to redraw, so an empty widget below the editor - which pi gives no
 * spacer - hands it over. Once the conversation is taller than the screen the banner has scrolled off,
 * and a line changing up there would have pi-tui clear and redraw everything, frame after frame: the
 * jellyfish stops for the rest of the session - swimming, whole, drawn once more if it was not, rather than on whatever
 * frame it was at, a polyp half grown.
 */
export function animateJellyfish(ctx: ExtensionContext): void {
  if (jellyfishTimer !== undefined) clearInterval(jellyfishTimer);
  jellyfishTimer = undefined;
  ctx.ui.setWidget(
    JELLYFISH_CLOCK_KEY,
    (tui) => {
      drawOverlaysBesidePicture(tui);
      const timer = setInterval(() => {
        if (tui.render(tui.terminal.columns).length > tui.terminal.rows) {
          clearInterval(timer);
          if (shownFrame() !== JELLYFISH_SEQUENCE[JELLYFISH_REST]) {
            jellyfishFrame = JELLYFISH_REST;
            tui.requestRender();
          }
          return;
        }
        jellyfishFrame++;
        tui.requestRender();
      }, JELLYFISH_FRAME_MS);
      timer.unref?.();
      jellyfishTimer = timer;
      return {
        render: () => [],
        invalidate: () => {},
        dispose: () => clearInterval(timer),
      };
    },
    { placement: "belowEditor" },
  );
}

const JELLYFISH_CLOCK_KEY = "turri-jellyfish";

/**
 * The whole screen inside its padding (`screen-padding.ts`). An extension is given pi's screen only through what it
 * draws, so an empty widget below the editor hands it over - at each frame, as pi starts a new screen when it changes
 * how it draws.
 */
function padTheScreen(ctx: ExtensionContext): void {
  ctx.ui.setWidget(
    SCREEN_PADDING_KEY,
    (tui) => {
      padScreen(tui);
      return {
        render: () => {
          padScreen(tui);
          return [];
        },
        invalidate: () => {},
      };
    },
    { placement: "belowEditor" },
  );
}

const SCREEN_PADDING_KEY = "turri-padding";

/** The columns the banner's picture takes from the left edge, while it shows one; 0 when it does not. */
let pictureRight = 0;

/**
 * pi-tui draws no overlay over a line holding an image: it leaves the line as it is, and the side panel
 * would have a gap on the banner's row that carries the picture. So that row's text gets the overlay as
 * any other does, and the picture goes back on after it - unless the overlay reaches over the picture,
 * which is then left out of that row until it no longer does.
 */
function drawOverlaysBesidePicture(tui: TUI): void {
  const target = tui as unknown as { compositeLineAt?: (base: string, overlay: string, col: number, width: number, total: number) => string; turriPicture?: true };
  if (target.turriPicture === true || typeof target.compositeLineAt !== "function") return;
  target.turriPicture = true;
  const original = target.compositeLineAt.bind(tui);
  target.compositeLineAt = (base, overlay, col, width, total) => overPictureRow(base, overlay, col, width, total, pictureRight) ?? original(base, overlay, col, width, total);
}

/** Columns between the jellyfish and the lines beside it. */
const JELLYFISH_GAP = 3;

/** The fewest columns the lines keep beside the jellyfish; a terminal narrower than that gets the lines alone. */
const BANNER_TEXT_MIN = 30;

/**
 * The banner: the jellyfish on the left at the frame `animateJellyfish` has it on, its lines beside it in
 * the middle of its height, and a rule the width of the terminal under them both.
 *
 * pi-tui writes a line holding an image as it is. So the picture goes on one of the rows after that
 * row's text: back to the jellyfish's column (`CSI G`), then the image's escape sequence. Kitty places
 * the image there without moving the cursor, from the first row; iTerm2 moves the cursor past what it
 * draws, so it goes on the last row and climbs back up to start, as pi-tui's Image does.
 */
class Banner implements Component {
  private readonly lines: string[];
  private readonly rule: (text: string) => string;
  private readonly art: JellyfishArt | undefined;
  private kittyImageId: number | undefined;

  /** Without `art` the banner is its lines alone. */
  constructor(lines: string[], rule: (text: string) => string, art: JellyfishArt | undefined) {
    this.lines = lines;
    this.rule = rule;
    this.art = art;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const inner = Math.max(1, width - 2);
    const art = this.art;
    const placed =
      art?.kind === "image" ? this.placeImage(art, Math.max(JELLYFISH_ROWS, this.lines.length), width - 2 - JELLYFISH_GAP - BANNER_TEXT_MIN) : art?.kind === "text" && art.columns <= width - 2 - JELLYFISH_GAP - BANNER_TEXT_MIN ? art : undefined;
    const left = placed !== undefined ? 1 + placed.columns + JELLYFISH_GAP : 1;
    // Wrapped in the columns beside the picture, never cut short - the chat beside the docked panel is narrow.
    const text = this.lines.flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width - 1 - left)));
    const height = Math.max(text.length, placed?.rows ?? 0);
    const above = Math.floor((height - text.length) / 2);
    const drawn = placed?.kind === "text" ? placed.frames[shownFrame()]! : undefined;
    const rows = Array.from({ length: height }, (_, row) => {
      const line = text[row - above];
      const jellyfish = drawn !== undefined ? (drawn[row] ?? " ".repeat(placed!.columns)) : " ".repeat(placed?.columns ?? 0);
      const before = placed !== undefined ? ` ${jellyfish}${" ".repeat(JELLYFISH_GAP)}` : " ";
      return line !== undefined ? `${before}${line}` : placed?.kind === "text" ? ` ${jellyfish}` : "";
    });
    // The side panel is drawn beside the picture (drawOverlaysBesidePicture), which goes on showing.
    pictureRight = placed?.kind === "image" ? SCREEN_PADDING.left + 1 + placed.columns : 0;
    if (placed?.kind === "image") {
      const at = placed.onLastRow ? placed.rows - 1 : 0;
      rows[at] = `${rows[at]}${PICTURE_AT}${placed.sequence}`;
    }
    return [...rows, ` ${this.rule("─".repeat(inner))}`];
  }

  private placeImage(
    art: Extract<JellyfishArt, { kind: "image" }>,
    rows: number,
    room: number,
  ): { kind: "image"; sequence: string; columns: number; rows: number; onLastRow: boolean } | undefined {
    if (room < 4) return undefined;
    const kitty = getCapabilities().images === "kitty";
    if (kitty && this.kittyImageId === undefined) this.kittyImageId = allocateImageId();
    const result = renderImage(art.frames[shownFrame()]!, art.dimensions, {
      maxWidthCells: room,
      maxHeightCells: rows,
      imageId: this.kittyImageId,
      moveCursor: false,
    });
    if (result === null || result.columns > room) return undefined;
    const sequence = kitty ? result.sequence : `${result.rows > 1 ? `\x1b[${result.rows - 1}A` : ""}${result.sequence}`;
    return { kind: "image", sequence, columns: result.columns, rows: result.rows, onLastRow: !kitty };
  }
}

/**
 * The jellyfish as the banner draws it: frames of a picture, for a terminal that shows images, or the same
 * pixels drawn in half blocks (`src/jellyfish.ts`), for one that does not.
 */
type JellyfishArt =
  | { kind: "image"; frames: string[]; dimensions: ImageDimensions }
  | { kind: "text"; frames: string[][]; columns: number; rows: number };

const jellyfishFrameCache = new Map<string, string[]>();

/**
 * The banner's jellyfish for this terminal: where it shows images, the picture's frames
 * (scripts/jellyfish-frames.mjs writes them), in the colours for the theme's background; where it does not, the
 * small one in half blocks. None when the pictures cannot be read.
 */
function jellyfishArt(appearance: "dark" | "light", truecolor: boolean): JellyfishArt | undefined {
  const dir = join(PACKAGE_ROOT, "assets", "jellyfish");
  try {
    if (getCapabilities().images === null) {
      const frames = JELLYFISH_TEXT_FRAMES.map((pixels) => halfBlocks(pixels, appearance, truecolor));
      return { kind: "text", frames, columns: JELLYFISH_TEXT_FRAMES[0]![0]!.length, rows: frames[0]!.length };
    }
    let frames = jellyfishFrameCache.get(appearance);
    if (frames === undefined) {
      frames = readdirSync(dir)
        .filter((name) => name.startsWith(`${appearance}-`) && name.endsWith(".png"))
        .sort()
        .map((name) => readFileSync(join(dir, name)).toString("base64"));
      jellyfishFrameCache.set(appearance, frames);
    }
    const dimensions = frames.length > 0 ? getPngDimensions(frames[0]!) : null;
    return dimensions !== null ? { kind: "image", frames, dimensions } : undefined;
  } catch {
    return undefined;
  }
}
