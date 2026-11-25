import { Container, SelectList, Text, type TuiMouseEvent } from "@earendil-works/pi-tui";
import type { TurriCore } from "./chats.ts";
import type { Conclusion, Notice } from "./notice.ts";
import { QuestionDialog, type DialogStyle } from "./question-dialog.ts";

/** The terminal session's inbox. A notice keeps its identity and live state from the session that answers it. */
export interface TerminalNotification {
  title: string;
  detail: string;
  conclusion?: string;
  notice?: Notice;
  seen: boolean;
}

export class TerminalNotifications {
  readonly items: TerminalNotification[] = [];
  private readonly reviews = new Map<string, TerminalNotification>();

  get count(): number {
    return this.items.filter((item) => !item.seen || this.needsAnswer(item)).length;
  }

  needsAnswer(item: TerminalNotification): boolean {
    return item.notice?.state === "open" && item.notice.kind !== "fixed";
  }

  add(title: string, detail: string, notice?: Notice): void {
    this.items.unshift({ title, detail, seen: false, notice });
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

  put(notice: Notice, work?: Pick<Conclusion, "job" | "check">): void {
    const about = [notice.module, notice.pulse !== undefined ? `pulse ${notice.pulse}` : undefined].filter(Boolean).join(" · ");
    const heading = notice.kind === "fixed" ? "Fixed" : "Sentinel";
    const title = [heading, about, notice.summary].filter(Boolean).join(" · ");
    const detail = notice.evidence.join("\n\n");
    if (notice.kind === "sentinel-start") return this.add(title, detail, notice);
    const item = this.review(work ?? notice, title);
    Object.assign(item, { title, detail, notice, seen: false });
  }

  concluded(result: Conclusion): void {
    const what = result.pulse !== undefined ? `pulse ${result.pulse}` : result.job ?? result.check;
    const verdict = result.verdict === "holds" ? "it holds" : result.verdict === "wrong" ? "found something wrong" : "not checked";
    const item = this.review(result, ["Sentinel", result.module, what, verdict].filter(Boolean).join(" · "));
    item.conclusion = `${verdict}: ${result.summary}`;
  }
}

/** The notifications tab. Opening or leaving a detail never answers its notice. Only an explicit choice does. */
export function notificationView(session: TurriCore, style: DialogStyle, leave: () => void) {
  const inbox = session.notifications;
  const { accent, muted } = style;
  const listBox = new Container();
  let list: SelectList | undefined;
  let rows: TerminalNotification[] = [];
  let labels: string[] = [];
  let visible = 0;
  let detail: QuestionDialog | undefined;
  let selectedNotice: Notice | undefined;
  let detailState: Notice["state"] | undefined;
  let height = 20;
  const back = () => { detail = undefined; selectedNotice = undefined; };
  const show = (item: TerminalNotification, steering = false) => {
    item.seen = true;
    const notice = item.notice;
    selectedNotice = notice;
    detailState = notice?.state;
    const open = notice?.state === "open";
    const actions = open && notice.kind !== "fixed" ? notice.actions.map((action, index) => `${index + 1}. ${action.label}`) : [];
    const steer = "Say what to do instead…";
    const ignore = "Ignore - leave it as the build has it";
    const options = [...actions, ...(open && notice.ignorable ? [ignore] : []), ...(open && notice.kind === undefined ? [steer] : []), ...(open ? ["Dismiss"] : []), "Back"];
    const target = notice && session.chats().find((chat) => chat.id === notice.chat);
    detail = new QuestionDialog({
      question: steering ? "What should be done about it?" : "Notifications",
      context: [item.title, item.detail, item.conclusion, ...(open && notice.kind === undefined && target ? [`Accepted work goes to ${target.title}.`] : [])].filter(Boolean).join("\n\n"),
      ...(steering ? {} : { options, clickable: true }), rows: () => height,
      style, requestRender: () => {},
      done(answer) {
        if (!answer || !notice || notice.state !== "open" || (!steering && answer === "Back")) return back();
        if (!steering && answer === steer) return show(item, true);
        if (steering) session.answer(notice.id, { steer: answer });
        else if (answer === "Dismiss") session.answer(notice.id, { dismiss: true });
        else if (answer === ignore) session.answer(notice.id, { ignore: true });
        else session.answer(notice.id, { action: actions.indexOf(answer) });
        back();
      },
    });
    session.changed();
  };
  return {
    count: () => inbox.count,
    inDetail: () => detail !== undefined,
    render(width: number, available: number) {
      height = available;
      if (selectedNotice && selectedNotice.state !== detailState) back();
      if (detail) return detail.render(width);
      const next = inbox.items;
      const lines = next.map((item) => `${inbox.needsAnswer(item) ? "? " : item.seen ? "  " : "• "}${item.notice && item.notice.state !== "open" ? `[${item.notice.state}] ` : ""}${item.title.replace(/\s+/g, " ")}`);
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
        listBox.addChild(new Text(style.bold(accent("Notifications")), 0, 0));
        listBox.addChild(rows.length ? list : new Text("No notifications this session.", 0, 0));
        listBox.addChild(new Text(muted(rows.length ? "↑↓ select · enter open · r mark all read · esc back" : "esc back"), 0, 0));
      }
      return listBox.render(width);
    },
    handleInput(data: string) {
      if (detail) detail.handleInput(data);
      else if (data === "r") {
        for (const item of inbox.items) item.seen = true;
        session.changed();
      } else list?.handleInput(data);
    },
    handleMouse: (event: TuiMouseEvent) => detail ? detail.handleMouse(event) : listBox.handleMouse(event),
  };
}
