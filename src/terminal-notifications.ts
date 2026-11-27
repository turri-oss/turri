import type { TurriCore, TerminalNotification } from "@turri-dev/core/terminal";
import type { Notice } from "@turri-dev/core";
import { Container, SelectList, Text, truncateToWidth, visibleWidth, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { QuestionDialog, type DialogStyle } from "./question-dialog.ts";

/** The notifications tab. Opening or leaving a detail never answers its notice. Only an explicit choice does. */
interface NotificationStyle extends DialogStyle {
  warning(text: string): string;
  button(text: string, selected: boolean): string;
}

export function notificationView(session: TurriCore, style: NotificationStyle, leave: () => void) {
  const inbox = session.notifications;
  const { accent, muted } = style;
  const listBox = new Container();
  const markRead = () => {
    for (const item of inbox.items) item.seen = true;
    session.changed();
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
      question: steering ? "What should be done about it?" : "notifications",
      context: [item.warning ? style.warning(item.title) : item.title, item.detail, item.conclusion, ...(open && notice.kind === undefined && target ? [`Accepted work goes to ${target.title}.`] : [])].filter(Boolean).join("\n\n"),
      ...(steering ? {} : { options, choiceButton: style.button }), rows: () => height,
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
