import { didNotPass, formatDuration, pulseName, type ChatInfo, type Conclusion, type Notice, type NoticeAnswer, type TurriEvent } from "@turri-dev/core";
import { Container, SelectList, Text, truncateToWidth, visibleWidth, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { QuestionDialog, type DialogStyle } from "./question-dialog.ts";

/**
 * The terminal's inbox: what the person looks at later in the side panel's notifications - each pulse that ended, the
 * sentinel's notices and what it concluded, and what turri warned of outside any transcript - built from the session's
 * events. A notice is answered here (`notices.answer`): the chat never puts it as a question (`shows.notices`).
 */
export interface TerminalNotification {
  title: string;
  detail: string;
  conclusion?: string;
  warning?: boolean;
  /** The notice as the session last said it: open, or how it ended. */
  notice?: Notice;
  seen: boolean;
}

export class TerminalNotifications {
  readonly items: TerminalNotification[] = [];
  private readonly reviews = new Map<string, TerminalNotification>();
  /**
   * An incident's line, said again as a notification at once: left out, as the chat shows it.
   * core-gap: an incident comes as an `incident` event and again as a `notification`, with nothing to tell the second for
   * the first but its text - matched here until a notification says what it is about.
   */
  private incident: string | undefined;

  get count(): number {
    return this.items.filter((item) => !item.seen || this.needsAnswer(item)).length;
  }

  needsAnswer(item: TerminalNotification): boolean {
    return item.notice?.state === "open" && item.notice.kind !== "fixed";
  }

  add(title: string, detail: string, options: Pick<TerminalNotification, "notice" | "warning"> = {}): void {
    this.items.unshift({ title, detail, seen: false, ...options });
  }

  /** What an event puts in the inbox, put: true when it changed. */
  hear(event: TurriEvent): boolean {
    switch (event.type) {
      case "job": {
        if (!event.final) return false;
        const { job } = event;
        const wrong = didNotPass(job);
        const result = job.status === "succeeded" ? (wrong ? "did not pass" : "finished") : job.status;
        this.add(`${pulseName(job)} · ${result} after ${formatDuration(job)}`, job.error ?? job.report ?? job.note ?? "", { warning: job.status === "failed" || wrong });
        return true;
      }
      case "notice":
        this.put(event.notice);
        return true;
      case "noticeOver":
        return this.over(event.notice);
      case "concluded":
        this.concluded(event.conclusion);
        return true;
      case "incident":
        this.incident = event.event.job !== undefined ? `${event.event.job}: ${event.text}` : event.text;
        return false;
      case "notification": {
        const incident = this.incident;
        this.incident = undefined;
        // What turri warned of - the sentinel that could not open, a config not written - kept to be read later; a
        // provider waited out is the chat's line only, as it was said there.
        if (event.level === "info" || event.text === incident) return false;
        this.add(event.text, "", { warning: true });
        return true;
      }
      default:
        return false;
    }
  }

  /** Only the sentinel's review shares a row. The pulse result and the question whether to start it are independent. */
  private review(about: { job?: string; check?: string }, title: string): TerminalNotification {
    const key = about.check ? `check:${about.check}` : about.job ? `pulse:${about.job}` : undefined;
    const known = key && this.reviews.get(key);
    if (known) return known;
    const item = { title, detail: "", seen: false };
    this.items.unshift(item);
    if (key) this.reviews.set(key, item);
    return item;
  }

  put(notice: Notice): void {
    const about = [notice.module, notice.pulse !== undefined ? `pulse ${notice.pulse}` : undefined].filter(Boolean).join(" · ");
    const heading = notice.kind === "fixed" ? "Fixed" : "Sentinel";
    const title = [heading, about, notice.summary].filter(Boolean).join(" · ");
    const detail = notice.evidence.join("\n\n");
    if (notice.kind === "sentinel-start") return this.add(title, detail, { notice });
    const item = this.review(notice, title);
    if (!item.conclusion) item.warning = notice.severity !== "info";
    Object.assign(item, { title, detail, notice, seen: false });
  }

  /** A notice answered, dismissed or superseded: its row says so. */
  over(notice: Notice): boolean {
    const item = this.items.find((each) => each.notice?.id === notice.id);
    if (item === undefined) return false;
    item.notice = notice;
    return true;
  }

  concluded(result: Conclusion): void {
    const what = result.pulse !== undefined ? `pulse ${result.pulse}` : result.job ?? result.check;
    const verdict = result.verdict === "holds" ? "it holds" : result.verdict === "wrong" ? "found something wrong" : "not checked";
    const item = this.review(result, ["Sentinel", result.module, what, verdict].filter(Boolean).join(" · "));
    item.conclusion = `${verdict}: ${result.summary}`;
    item.warning = result.verdict !== "holds";
  }
}

/** What the notifications view reaches of the terminal: the inbox, the chats a notice may go to, and answering one. */
export interface NotificationsSource {
  inbox: TerminalNotifications;
  chats(): ChatInfo[];
  answer(id: string, answer: NoticeAnswer): void;
  /** Something the view changed - a row read: the tabs' count drawn again. */
  changed(): void;
}

/** The notifications tab. Opening or leaving a detail never answers its notice. Only an explicit choice does. */
interface NotificationStyle extends DialogStyle {
  warning(text: string): string;
  button(text: string, selected: boolean): string;
}

export function notificationView(source: NotificationsSource, style: NotificationStyle, leave: () => void) {
  const { inbox } = source;
  const { accent, muted } = style;
  const listBox = new Container();
  const markRead = () => {
    for (const item of inbox.items) item.seen = true;
    source.changed();
  };
  const readLabel = " mark all as read ";
  let pressedRead = false;
  const listHeader: Component = {
    render(width) {
      const button = truncateToWidth(readLabel, width);
      const room = width - visibleWidth(button);
      const title = truncateToWidth("notifications", Math.max(0, room - 1), "");
      return [style.bold(accent(title)) + " ".repeat(room - visibleWidth(title)) + style.button(button, false)];
    },
    handleMouse(event) {
      if (event.button !== "left" || (event.type !== "press" && event.type !== "click")) return;
      const inside = event.x >= Math.max(0, event.width - visibleWidth(readLabel)) && event.x < event.width && event.y === 0;
      const down = pressedRead;
      pressedRead = event.type === "press" && inside;
      if (!inside) return;
      if (event.type === "click" && down) markRead();
      return { handled: true };
    },
    invalidate() {},
  };
  let list: SelectList | undefined;
  let rows: TerminalNotification[] = [];
  let labels: string[] = [];
  let visible = 0;
  let detail: QuestionDialog | undefined;
  // The row open, and its notice's state as it opened: a notice the session ends meanwhile takes the detail away.
  let selected: TerminalNotification | undefined;
  let detailState: Notice["state"] | undefined;
  let height = 20;
  const back = () => { detail = undefined; selected = undefined; };
  const show = (item: TerminalNotification, steering = false) => {
    item.seen = true;
    const notice = item.notice;
    selected = item;
    detailState = notice?.state;
    const open = notice?.state === "open";
    const actions = open && notice.kind !== "fixed" ? notice.actions.map((action, index) => `${index + 1}. ${action.label}`) : [];
    const steer = "Say what to do instead…";
    const ignore = "Ignore - leave it as the build has it";
    const options = [...actions, ...(open && notice.ignorable ? [ignore] : []), ...(open && notice.kind === undefined ? [steer] : []), ...(open ? ["Dismiss"] : []), "Back"];
    const target = notice && source.chats().find((chat) => chat.id === notice.chat);
    detail = new QuestionDialog({
      question: steering ? "What should be done about it?" : "notifications",
      context: [item.warning ? style.warning(item.title) : item.title, item.detail, item.conclusion, ...(open && notice.kind === undefined && target ? [`Accepted work goes to ${target.title}.`] : [])].filter(Boolean).join("\n\n"),
      ...(steering ? {} : { options, choiceButton: style.button }), rows: () => height,
      style, requestRender: () => {},
      done(answer) {
        if (!answer || !notice || item.notice?.state !== "open" || (!steering && answer === "Back")) return back();
        if (!steering && answer === steer) return show(item, true);
        if (steering) source.answer(notice.id, { steer: answer });
        else if (answer === "Dismiss") source.answer(notice.id, { dismiss: true });
        else if (answer === ignore) source.answer(notice.id, { ignore: true });
        else source.answer(notice.id, { action: actions.indexOf(answer) });
        back();
      },
    });
    source.changed();
  };
  return {
    count: () => inbox.count,
    inDetail: () => detail !== undefined,
    render(width: number, available: number) {
      height = available;
      if (selected?.notice !== undefined && selected.notice.state !== detailState) back();
      if (detail) return detail.render(width);
      const next = inbox.items;
      const lines = next.map((item) => {
        const label = `${inbox.needsAnswer(item) ? "? " : item.seen ? "  " : "• "}${item.notice && item.notice.state !== "open" ? `[${item.notice.state}] ` : ""}${item.title.replace(/\s+/g, " ")}`;
        return item.warning ? style.warning(label) : label;
      });
      const room = Math.max(1, available - 4);
      if (!list || room !== visible || next.length !== rows.length || next.some((item, i) => item !== rows[i] || lines[i] !== labels[i])) {
        // Keep the same item selected when a pulse finishes while the person is reading the list.
        const selected = rows[Number(list?.getSelectedItem()?.value)];
        rows = next.slice(); labels = lines; visible = room;
        list = new SelectList(rows.map((_item, i) => ({ value: String(i), label: labels[i]! })), room, { selectedPrefix: accent, selectedText: accent, description: muted, scrollInfo: muted, noMatch: muted });
        list.setSelectedIndex(selected ? rows.indexOf(selected) : 0);
        list.onSelect = ({ value }) => show(rows[Number(value)]!);
        list.onCancel = leave;
        listBox.clear();
        listBox.addChild(listHeader);
        listBox.addChild(rows.length ? list : new Text("No notifications this session.", 0, 0));
        listBox.addChild(new Text(muted(rows.length ? "↑↓ select · enter open · r mark all read · esc back" : "esc back"), 0, 0));
      }
      return listBox.render(width);
    },
    handleInput(data: string) {
      if (detail) detail.handleInput(data);
      else if (data === "r") markRead();
      else list?.handleInput(data);
    },
    handleMouse: (event: TuiMouseEvent) => detail ? detail.handleMouse(event) : listBox.handleMouse(event),
  };
}
