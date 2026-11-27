import { getMarkdownTheme, UserMessageComponent, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { COMMAND_OUTCOME, SKILL_MESSAGE_ENTRY, SIDE_ENTRY, SKILL_RUN_ENTRY, JOB_ENTRY, HISTORY_ENTRY, JOBS_LIST_ENTRY, MILESTONE_ENTRY, INTERVIEW_ENTRY, type CommandOutcome, type Exchange, type JobAnnouncement } from "@turri-dev/core";
import { PANEL_KEY } from "./terminal-marks.ts";

/**
 * A skill's question as the transcript keeps it: who asked, what it said before asking - a brief to confirm, the choices
 * it weighed, shown in the dialog that is gone once answered - the question, and the answer.
 */
export function exchangeLines(data: Exchange, fg: (color: "muted" | "text" | "dim" | "accent", text: string) => string): string[] {
  const said = data.said !== undefined ? data.said.split("\n").map((line) => fg("text", line)) : [];
  const answer = data.answer.trim() === "" ? fg("dim", "> (no answer)") : fg("accent", `> ${data.answer}`);
  return [fg("muted", `${data.skill} asked`), ...said, ...(said.length > 0 ? [""] : []), fg("text", data.question), answer];
}

export function registerEntries(pi: ExtensionAPI): void {
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
  // The sentinel's notices, their answers and its conclusions are the inbox's (terminal-notifications.ts): answered and
  // read there, and the chat says each conclusion in its own words. No renderer: pi draws none of them in the chat.

  pi.registerEntryRenderer(SKILL_RUN_ENTRY, (entry, _options, theme) => {
    const data = entry.data as { text: string } | undefined;
    if (data === undefined) return undefined;
    const box = new Box(1, 0);
    box.addChild(new Text(theme.fg("muted", data.text), 0, 0));
    return box;
  });
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
