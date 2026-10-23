import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import type { ChatLink, TurriCore } from "./chats.ts";
import { projectModels, readProjectConfig, roleModel } from "./config.ts";
import { concludedNote, concludeTool, keepGuidanceTool, notifyTool, sentinelFileTools, type Conclusion, type Notice } from "./sentinel.ts";

/**
 * The sentinel in a chat: its tools in place of the chat's - the project to read, its shell behind the walls, notices,
 * its guidance, a host's own - its model, and, in every chat, the notices it puts to the person: a card in the chat and,
 * in the terminal, a dialog once the chat is idle (docs/sentinel.md).
 */

/** A notice in the transcript: the card. */
const NOTICE_ENTRY = "turri_notice";
/** A notice's end, under its card: answered, dismissed, superseded by a newer one about its module. */
const NOTICE_OVER_ENTRY = "turri_notice_over";
/** The sentinel done with a pulse, in the chat the person is in. */
const CONCLUDED_ENTRY = "turri_sentinel_concluded";

const STEER = "Say what to do instead…";
const DISMISS = "Dismiss";

/** The sentinel's tools and model, built into its chat. */
export function registerSentinel(pi: ExtensionAPI, session: TurriCore, cwd: string, hostTools: ToolDefinition[], allowed: Set<string>): void {
  // pi's own file tools and shell, replaced by fenced ones of the same names: the whole project to read, nothing to write.
  for (const tool of sentinelFileTools(cwd)) pi.registerTool(tool);
  pi.registerTool(
    notifyTool((input) => {
      const job = input.job !== undefined ? session.jobs.get(input.job) : undefined;
      const module = input.module ?? job?.module;
      return session.notice({ ...input, ...(module !== undefined ? { module } : {}), ...(job?.pulse !== undefined ? { pulse: job.pulse } : {}) });
    }),
  );
  pi.registerTool(concludeTool((conclusion) => session.concluded(conclusion)));
  pi.registerTool(keepGuidanceTool(cwd));
  for (const tool of hostTools) pi.registerTool(tool);

  // Only its tools are offered to its model; what it calls besides is refused (extension.ts, tool_call).
  let modelSet = false;
  pi.on("session_start", async (_event, ctx) => {
    try {
      pi.setActiveTools(pi.getAllTools().map((tool) => tool.name).filter((name) => allowed.has(name)));
    } catch {
      /* a session let go has no tools to set */
    }
    // Its model, once: the `sentinel` role's, else the chat's - never the one its session started on, which in a host is
    // pi's default and may not be the project's provider's. What the person then picks in its chat stands.
    if (modelSet) return;
    modelSet = true;
    const config = readProjectConfig(cwd);
    const choice = roleModel(config, "sentinel") ?? projectModels(config).harness;
    if (choice?.model !== undefined) {
      const slash = choice.model.indexOf("/");
      const found = slash === -1 ? undefined : ctx.modelRegistry.find(choice.model.slice(0, slash), choice.model.slice(slash + 1));
      if (found !== undefined) await pi.setModel(found);
    }
    if (choice?.thinking !== undefined) pi.setThinkingLevel(choice.thinking);
  });
}

/**
 * A chat's notices: each drawn as a card, and - with no host to answer it - put to the person as a dialog once the chat
 * is idle, one at a time: an action accepted, their own words, or dismissed. A notice that is over closes its dialog.
 */
export function noticeDialogs(
  pi: ExtensionAPI,
  session: TurriCore,
  link: ChatLink,
  context: () => ExtensionContext | undefined,
): { put(notice: Notice): void; over(notice: Notice): void; concluded(conclusion: Conclusion): void } {
  const waiting: Notice[] = [];
  const asking = new Map<string, AbortController>();
  let open = false;

  pi.registerEntryRenderer(NOTICE_ENTRY, (entry, _options, theme) => {
    const notice = entry.data as Notice | undefined;
    if (notice === undefined) return undefined;
    const mark = notice.severity === "error" ? theme.fg("error", "✗") : notice.severity === "warning" ? theme.fg("warning", "!") : theme.fg("accent", "·");
    const about = notice.module !== undefined ? `${notice.module}${notice.pulse !== undefined ? ` · pulse ${notice.pulse}` : ""}` : "";
    const lines = [
      `${mark} ${theme.fg("muted", `sentinel${about !== "" ? ` · ${about}` : ""}`)}`,
      `  ${theme.fg("text", notice.summary)}`,
      ...notice.evidence.map((line) => theme.fg("muted", `    ${line}`)),
      ...notice.actions.map((action, index) => `  ${theme.fg("accent", `${index + 1}.`)} ${action.label}`),
    ];
    const box = new Box(1, 0);
    box.addChild(new Text(lines.join("\n"), 0, 0));
    return box;
  });
  pi.registerEntryRenderer(CONCLUDED_ENTRY, (entry, _options, theme) => {
    const data = entry.data as Conclusion | undefined;
    if (data === undefined) return undefined;
    const about = data.module !== undefined ? `${data.module}${data.pulse !== undefined ? ` · pulse ${data.pulse}` : ""}` : data.job;
    const mark = data.verdict === "holds" ? theme.fg("success", "✓") : theme.fg("error", "✗");
    const box = new Box(1, 0);
    box.addChild(new Text(`${mark} ${theme.fg("muted", `sentinel · ${about} · ${data.verdict === "holds" ? "checked, it holds" : "found something wrong"}`)}\n  ${theme.fg("text", data.summary)}`, 0, 0));
    return box;
  });
  pi.registerEntryRenderer(NOTICE_OVER_ENTRY, (entry, _options, theme) => {
    const data = entry.data as { state: Notice["state"]; summary: string } | undefined;
    if (data === undefined) return undefined;
    const said = data.state === "superseded" ? "superseded by a newer notice" : data.state === "dismissed" ? "dismissed" : data.state === "steered" ? "answered in your words" : "accepted";
    const box = new Box(1, 0);
    box.addChild(new Text(theme.fg("muted", `  ${said}: ${data.summary}`), 0, 0));
    return box;
  });

  const ask = async (): Promise<void> => {
    if (open || link.session()?.isStreaming === true) return;
    const notice = waiting.shift();
    if (notice === undefined) return;
    if (notice.state !== "open") return ask();
    const ctx = context();
    if (ctx === undefined || !ctx.hasUI) {
      waiting.unshift(notice);
      return;
    }
    open = true;
    const controller = new AbortController();
    asking.set(notice.id, controller);
    try {
      const options = [...notice.actions.map((action, index) => `${index + 1}. ${action.label}`), STEER, DISMISS];
      const picked = await ctx.ui.select(`sentinel: ${notice.summary}`, options, { signal: controller.signal });
      if (controller.signal.aborted || notice.state !== "open") return;
      if (picked === STEER) {
        const words = await ctx.ui.input("What should be done about it?", "", { signal: controller.signal });
        if (controller.signal.aborted || notice.state !== "open") return;
        if (words === undefined || words.trim() === "") waiting.unshift(notice);
        else session.answer(notice.id, { steer: words });
        return;
      }
      const index = options.indexOf(picked ?? DISMISS);
      session.answer(notice.id, index >= 0 && index < notice.actions.length ? { action: index } : { dismiss: true });
    } catch {
      /* a dialog the chat lost - let go, or rebuilt - leaves the notice for the next */
    } finally {
      asking.delete(notice.id);
      open = false;
      void ask();
    }
  };
  pi.on("agent_settled", () => void ask());

  return {
    put(notice) {
      try {
        pi.appendEntry(NOTICE_ENTRY, notice);
      } catch {
        /* the host still hears of it */
      }
      // A host answers it itself: its card, its buttons.
      if (session.host.onNotice !== undefined) return;
      waiting.push(notice);
      void ask();
    },
    concluded(conclusion) {
      try {
        pi.appendEntry(CONCLUDED_ENTRY, conclusion);
      } catch {
        /* the agent is still told */
      }
      void pi.sendMessage(
        { customType: "turri_sentinel_concluded", content: concludedNote(conclusion), display: false, details: { jobId: conclusion.job, verdict: conclusion.verdict } },
        { triggerTurn: true, deliverAs: "followUp" },
      );
    },
    over(notice) {
      asking.get(notice.id)?.abort();
      const at = waiting.indexOf(notice);
      if (at !== -1) waiting.splice(at, 1);
      try {
        pi.appendEntry(NOTICE_OVER_ENTRY, { state: notice.state, summary: notice.summary });
      } catch {
        /* a chat let go says nothing */
      }
    },
  };
}
