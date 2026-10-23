import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Command, MemorySaver } from "@langchain/langgraph";
import { compileSkill, type Reporter } from "./graph.ts";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createExecutor } from "./pi.ts";
import { plainWriteTools } from "./plain-files.ts";
import { toolchainsBlock } from "./stack.ts";
import { clearOfStop, describeToolCall, describeToolResult, withStopSignal } from "./regenerate/activity.ts";
import { createLiveReviewer, type LiveReviewer } from "./review/live.ts";
import { loadSkill, readRubric, type Skill } from "./skill.ts";
import { createAskUserTool, createEndQuestionsTool, createReviewTools, createWriteArtifactTool, withReviewNote, type AskUser } from "./tools.ts";
import { DECLINED, DISMISSED } from "./ask.ts";
import { createQuestioning, levelOf, questioningQuestion, type Questioning, type QuestioningState } from "./questioning.ts";
import { createSpecDiffTools } from "./spec-tools.ts";

const CHANGE_PLAIN = "change_plain";
/** The conversation's tools a skill acts on the work loop with - never pi built-ins. */
const LOOP_TOOLS = ["regenerate", "drift", "halt", "conform"];
/** How much of what the agent said before a question is shown with it: its end, where the brief is. */
const SAID_MAX = 6000;
import type { WorkLoop } from "./regenerate/loop.ts";

export interface EscalationRequest {
  step: string;
  artifact: string;
  critique: string;
  question: string;
}

export interface RunSkillResult {
  skill: Skill;
  ok: boolean;
  artifacts: Record<string, string>;
  /** The last step's artifact - what the caller usually wants. */
  output: string;
}

/**
 * The person's messages to a run while it works - typed in the chat the skill was started from, whose own agent is busy
 * running it: each is given to the run's agent, and `read` is told when that agent reads it.
 */
export interface SkillMessages {
  /** Given what passes a message to the run's agent as the run starts, and undefined as it ends. */
  open(tell: ((text: string) => void) | undefined): void;
  /** The run's agent read a message passed to it. */
  read(text: string): void;
}

export interface RunSkillOptions {
  skillDir: string;
  cwd: string;
  runDir: string;
  report: Reporter;
  /** Called when a gate cannot be satisfied. Return true to accept the artifact anyway. */
  escalate: (request: EscalationRequest) => Promise<boolean>;
  /** Lets a step interview the user. Omitted: the skill runs with nobody to ask. */
  askUser?: AskUser;
  /** What the person says in the chat while it runs, for its agent. */
  messages?: SkillMessages;
  /** "provider/model-id" for the executor and the judges. Omitted: pi's default. */
  model?: string;
  /** Lets steps build functionalities in the background while the interview continues. */
  renderQueue?: WorkLoop;
  /** What the user has already said, so the skill does not re-ask it. */
  context?: string;
  /** Pick up the run of this skill that was interrupted here, rather than start a new one. */
  resume?: boolean;
  /**
   * Tools the conversation's agent has that the skill's agent needs as well, because the person
   * talks to the skill's agent while it runs - choosing the render model, for one.
   */
  sharedTools?: ToolDefinition[];
  /**
   * The conversation's tools that act on the work loop (loop-tools.ts): drift, for every skill with the loop - how its
   * builds stand - and regenerate and halt for a skill that names them in its allowed-tools.
   */
  loopTools?: ToolDefinition[];
  /**
   * Stops the run: its agents end their turns and it throws JobStoppedError, its manifest left as it was - an
   * interrupted run, for `resume` to pick up. What it started on the work loop goes on.
   */
  signal?: AbortSignal;
}

/**
 * Run one skill to completion. The only entry point: the CLI and the Pi extension
 * both go through here, so a skill behaves identically whether a human launched it
 * or a conversational agent decided to.
 */
export async function runSkill(opts: RunSkillOptions): Promise<RunSkillResult> {
  if (opts.signal === undefined) return runStoppable(opts);
  return withStopSignal(opts.signal, () =>
    runStoppable({
      ...opts,
      ...(opts.renderQueue !== undefined ? { renderQueue: clearOfStop(opts.renderQueue) } : {}),
      ...(opts.loopTools !== undefined ? { loopTools: opts.loopTools.map(clearOfStop) } : {}),
    }),
  );
}

async function runStoppable(opts: RunSkillOptions): Promise<RunSkillResult> {
  const skill = loadSkill(opts.skillDir);
  const runDir = resolve(opts.runDir);

  // A resumed run keeps its folder - the artifacts are in it - and starts where it stopped.
  let resumed: RunManifest | undefined;
  if (opts.resume === true) {
    resumed = readManifest(runDir);
    if (resumed === undefined || resumed.skill !== skill.name || resumed.status !== "running") {
      throw new Error(
        resumed === undefined || resumed.skill !== skill.name
          ? `There is no interrupted run of ${skill.name} to resume here.`
          : `The last run of ${skill.name} here ${resumed.status === "finished" ? "finished" : "was stopped"}; there is nothing to resume.`,
      );
    }
  } else {
    rmSync(runDir, { recursive: true, force: true });
  }
  mkdirSync(runDir, { recursive: true });

  // The executor has to exist before a reviewer can borrow its auth, and the reviewer has
  // to exist before the tools that report its findings. So the tool list is built in two
  // passes with a box the reviewer is dropped into once there is one.
  const liveReviewers = new Map<string, LiveReviewer>();
  const liveStep = skill.steps.find((step) => step.gate?.continuous !== undefined);
  const holder: { reviewer?: LiveReviewer } = {};
  const liveProxy: LiveReviewer | undefined =
    liveStep === undefined
      ? undefined
      : {
          notice: (scope) => holder.reviewer?.notice(scope),
          take: () => holder.reviewer?.take() ?? [],
          takeQuestions: () => holder.reviewer?.takeQuestions() ?? [],
          reply: (id, answer) => holder.reviewer?.reply(id, answer) ?? false,
          settle: async () => holder.reviewer?.settle() ?? { clean: true, findings: [] },
          history: () => holder.reviewer?.history() ?? [],
          passes: () => holder.reviewer?.passes() ?? 0,
        };

  const writeArtifact = createWriteArtifactTool(runDir);
  const customTools: ToolDefinition[] = [writeArtifact];

  // The questioning level, asked first in a skill whose phases it caps - when there is someone to ask. A resumed run
  // keeps the one it was given, and how far each phase's questions went.
  const capsQuestions = skill.questioning.length > 0 && opts.askUser !== undefined;
  let questioning: Questioning | undefined;
  const keepQuestioning = (state: QuestioningState) => {
    manifest.questioning = state;
    writeManifest(runDir, manifest);
  };
  const startQuestioning = (level: string, from?: QuestioningState) =>
    (questioning = createQuestioning({ level: levelOf(level), phases: skill.questioning, from, onChange: keepQuestioning }));
  if (capsQuestions && resumed?.questioning !== undefined) startQuestioning(resumed.questioning.level, resumed.questioning);
  // The step running now, and whether each of its answers is a spec change: then the next question waits until the last
  // answer is written, and a change the agent decides itself needs no answer before it.
  let currentStep = "";
  const diffPerAnswer = () => skill.diffPerAnswer.includes(currentStep);
  const holdsQuestions = capsQuestions || (skill.diffPerAnswer.length > 0 && opts.askUser !== undefined);
  const questions = {
    refusal: (confirmsPhase: boolean) =>
      diffPerAnswer() && diffs?.pace.owed() === true
        ? "This question was not asked: the last answer is not in the spec yet. Every answer in this phase is a spec " +
          "change, built at once - write it with change_plain first, then ask."
        : questioning?.refusal(confirmsPhase),
    answered: (confirmsPhase: boolean) => questioning?.answered(confirmsPhase),
    end: () => questioning?.end() ?? "No questioning level was chosen: ask what the phase needs.",
  };

  // A skill whose unit of work is a spec change gets change_plain: the change is applied
  // and its build queued in one step.
  const diffs =
    opts.renderQueue !== undefined && skill.allowedTools.includes(CHANGE_PLAIN)
      ? createSpecDiffTools({
          loop: opts.renderQueue,
          cwd: opts.cwd,
          liveReview: liveProxy,
          paced: skill.paced,
          free: diffPerAnswer,
        })
      : undefined;

  // What the agent says between its questions - a brief to confirm, a plan - reaches the person only with
  // the next question: the session it talks in is its own, and nobody reads it.
  let said = "";
  /** A new message of the agent's has started, and has said nothing yet. */
  let saidFresh = false;
  if (opts.askUser !== undefined) {
    customTools.push(
      createAskUserTool(
        opts.askUser,
        (answer, confirmsPhase) => {
          said = "";
          // A phase's confirmation, or a question dismissed, owes the spec nothing.
          diffs?.pace.answered(!confirmsPhase && answer !== DISMISSED && answer !== DECLINED);
        },
        () => said,
        holdsQuestions ? questions : undefined,
      ),
    );
    if (capsQuestions) customTools.push(createEndQuestionsTool(questions));
  }
  if (opts.renderQueue !== undefined) {
    customTools.push(...createReviewTools(liveProxy));
    for (const tool of opts.loopTools ?? []) {
      if (tool.name === "drift") customTools.push(withReviewNote(tool, liveProxy));
      else if (skill.allowedTools.includes(tool.name)) customTools.push(tool);
    }
  }
  if (diffs !== undefined) customTools.push(...diffs.tools);
  customTools.push(...(opts.sharedTools ?? []));
  // Its write and edit reach the project's ***plain only - not the code, a release, or what an app it started writes.
  customTools.push(...plainWriteTools(opts.cwd).filter((tool) => skill.allowedTools.includes(tool.name)));

  const names = customTools.map((tool) => tool.name);
  // Tools this harness provides are never pi built-ins, even when it did not provide them.
  const builtins = skill.allowedTools.filter(
    (t) => !names.includes(t) && t !== CHANGE_PLAIN && !LOOP_TOOLS.includes(t),
  );
  const executor = await createExecutor({
    cwd: opts.cwd,
    customTools,
    tools: [...builtins, ...names],
    model: opts.model,
    // A skill writes specs; the rules it is held to are in its system prompt - and what this machine can build, so the
    // stack it offers or chooses is one that can be regenerated here.
    rules: true,
    system: toolchainsBlock(),
    resumeFrom: resumed?.sessionFile,
    // Its run picks it back up (resume) and the side questions read it (btw): saved whatever the mode.
    saveSession: true,
  });

  const manifest: RunManifest = resumed ?? {
    skill: skill.name,
    status: "running",
    artifacts: {},
    attempts: {},
    updatedAt: "",
  };
  // The person's messages, given to the agent at its next step - or with its next prompt, between steps.
  const passed: string[] = [];
  // What the agent does, as it does it: its session is its own, so without this a long step is silence.
  executor.subscribe((event) => {
    if (event.type === "message_start" && (event.message as { role?: string }).role === "user") {
      const content = (event.message as { content?: unknown }).content;
      const text = typeof content === "string" ? content : Array.isArray(content) ? content.filter((part) => part?.type === "text").map((part) => part.text).join("") : "";
      const at = passed.indexOf(text);
      if (at !== -1) {
        passed.splice(at, 1);
        opts.messages?.read(text);
      }
      return;
    }
    if (event.type === "tool_execution_start") {
      opts.report.activity?.(describeToolCall(event.toolName, event.args as Record<string, unknown> | undefined));
      return;
    }
    if (event.type === "tool_execution_end") {
      const line = describeToolResult(event.toolName, event.result, event.isError);
      if (line !== undefined) opts.report.activity?.(line);
      return;
    }
    // Shown with the next question is the last thing it said, not all it said since the last answer: a message of
    // its own replaces what came before - its account of a probe, a regeneration - once it has words in it, so a brief
    // said just before a bare ask_user call is still shown with it.
    if (event.type === "message_start") {
      if ((event.message as { role?: string }).role === "assistant") saidFresh = true;
      return;
    }
    if (event.type !== "message_update") return;
    const update = event.assistantMessageEvent;
    if (update.type === "text_start") {
      if (saidFresh) said = "";
      saidFresh = false;
      if (said.trim() !== "") said += "\n\n";
      opts.report.said?.("", true);
    } else if (update.type === "text_delta") {
      said = (said + update.delta).slice(-SAID_MAX);
      opts.report.said?.(update.delta, false);
    }
  });
  manifest.sessionFile = executor.sessionFile;
  writeManifest(runDir, manifest);

  // Built renders were lost with the process; queue what the specs hold that is not built.
  if (resumed !== undefined && opts.renderQueue !== undefined) {
    for (const file of plainFilesIn(opts.cwd)) void opts.renderQueue.bringUp(file, { specChange: true }).catch(() => undefined);
  }

  if (liveStep !== undefined && liveProxy !== undefined) {
    const continuous = liveStep.gate!.continuous!;
    holder.reviewer = createLiveReviewer({
      cwd: opts.cwd,
      spec: continuous,
      rubric: readRubric(skill, continuous),
      executor,
      defaultModel: opts.model,
      onPass: (pass) => opts.report.livePass?.(liveStep.name, pass.scope, pass.findings),
    });
    liveReviewers.set(liveStep.name, liveProxy);
  }

  try {
    opts.messages?.open((text) => {
      passed.push(text);
      void Promise.resolve(executor.steer(text, undefined, { source: "extension" })).catch(() => undefined);
    });
    const app = compileSkill({
      skill,
      cwd: opts.cwd,
      runDir,
      executor,
      report: opts.report,
      model: opts.model,
      context: opts.context,
      liveReviewers,
      startAt: resumed?.step,
      // Where the run is, written as each step starts: what a resume picks up from.
      onStepStart: (step, state) => {
        manifest.step = step;
        manifest.artifacts = state.artifacts;
        manifest.attempts = state.attempts;
        writeManifest(runDir, manifest);
      },
      beforeStep: async (step) => {
        currentStep = step;
        if (!capsQuestions) return;
        // The first question of the first phase is the harness's: how many the capped phases may ask.
        if (questioning === undefined) {
          const asked = questioningQuestion(skill.questioning);
          startQuestioning(await opts.askUser!({ ...asked, said: "" }));
          keepQuestioning(questioning!.state());
        }
        questioning!.enter(step);
      },
      stepNote: (step) => questioning?.note(step, step === skill.steps[0]!.name),
    }).compile({
      checkpointer: new MemorySaver(),
    });
    const config = { configurable: { thread_id: `genome-${Date.now()}` }, recursionLimit: 50 };

    let result = await app.invoke(
      resumed !== undefined ? { artifacts: resumed.artifacts, attempts: resumed.attempts } : {},
      config,
    );

    // Escalation surfaces as a LangGraph interrupt: the graph is paused, not
    // finished, and nothing advances until the handler answers.
    while (result.__interrupt__?.length) {
      const approved = await opts.escalate(result.__interrupt__[0].value as EscalationRequest);
      result = await app.invoke(new Command({ resume: { approved } }), config);
    }

    const artifacts: Record<string, string> = result.artifacts ?? {};
    const lastStep = skill.steps[skill.steps.length - 1]!.name;
    manifest.status = result.decision === "abort" ? "stopped" : "finished";
    writeManifest(runDir, manifest);
    return {
      skill,
      ok: result.decision !== "abort",
      artifacts,
      output: artifacts[lastStep] ?? "",
    };
  } finally {
    opts.messages?.open(undefined);
    executor.dispose();
  }
}

/**
 * Where a skill run is, kept in its run folder: enough to pick it up after the process that
 * ran it is gone - the agent's saved session, the step it was in, and the state that step
 * started from. Written as each step starts; `status` stays "running" until the run ends.
 */
interface RunManifest {
  skill: string;
  status: "running" | "finished" | "stopped";
  sessionFile?: string;
  step?: string;
  artifacts: Record<string, string>;
  attempts: Record<string, number>;
  /** The questioning level chosen, and how far each phase's questions went. */
  questioning?: QuestioningState;
  updatedAt: string;
}

const MANIFEST = "run.json";

function readManifest(runDir: string): RunManifest | undefined {
  try {
    return JSON.parse(readFileSync(join(runDir, MANIFEST), "utf8")) as RunManifest;
  } catch {
    return undefined;
  }
}

function writeManifest(runDir: string, manifest: RunManifest): void {
  manifest.updatedAt = new Date().toISOString();
  writeFileSync(join(runDir, MANIFEST), JSON.stringify(manifest, null, 2));
}

/** The .plain files at the top of a project. */
function plainFilesIn(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith(".plain"))
      .map((name) => join(dir, name));
  } catch {
    return [];
  }
}

/** Whether there is a run of this skill here that was interrupted, and could be resumed. */
export function interruptedRun(runDir: string, skillName: string): { step?: string; updatedAt: string } | undefined {
  const manifest = readManifest(resolve(runDir));
  return manifest?.skill === skillName && manifest.status === "running"
    ? { step: manifest.step, updatedAt: manifest.updatedAt }
    : undefined;
}

/** Human-readable one-liner per step, for logs and tool output. */
export function describeGates(skill: Skill): string[] {
  return skill.steps.map((s) => {
    if (!s.gate) return `${s.name} -> no gate`;
    const live = s.gate.continuous
      ? ` + continuous(${s.gate.continuous.rubric}, judges=${s.gate.continuous.judges})`
      : "";
    const r = s.gate.review;
    return `${s.name} -> gate(${r.rubric}, judges=${r.judges}, quorum=${r.quorum}, on_fail=${r.onFail}, max_retries=${r.maxRetries})${live}`;
  });
}

export type { Reporter };
