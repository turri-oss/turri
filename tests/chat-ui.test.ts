import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createChatUi } from "../src/chat-ui.ts";

/** pi's screen, as far as a chat draws on it: what was drawn and asked, in order, and the answers it gives. */
function screen(answers: unknown[] = []) {
  const did: string[] = [];
  let editor = "";
  const ui = {
    select: async (title: string) => {
      did.push(`select ${title}`);
      return answers.shift();
    },
    confirm: async (title: string) => {
      did.push(`confirm ${title}`);
      return answers.shift();
    },
    notify: (message: string) => did.push(`notify ${message}`),
    setWidget: (key: string, content: unknown) => did.push(`widget ${key} ${content === undefined ? "off" : "on"}`),
    setStatus: (key: string, text: string | undefined) => did.push(`status ${key} ${text}`),
    setWorkingMessage: (message?: string) => did.push(`working ${message}`),
    getEditorText: () => editor,
    setEditorText: (text: string) => {
      editor = text;
    },
    theme: { name: "the screen's" },
  } as unknown as ExtensionUIContext;
  return { ui, did, editor: () => editor };
}

describe("what a chat draws on while another is shown", () => {
  it("draws on the screen while it is shown", async () => {
    const shown = screen(["yes"]);
    const chat = createChatUi({ screen: () => undefined });
    chat.show(shown.ui);
    expect(await chat.ui.select("Ship it?", ["yes", "no"])).toBe("yes");
    chat.ui.notify("hello", "info");
    expect(shown.did).toEqual(["select Ship it?", "notify hello"]);
  });

  it("keeps its questions until it is shown, then asks them there, one after another", async () => {
    const shown = screen(["HubSpot", true]);
    const chat = createChatUi({ screen: () => undefined });
    const first = chat.ui.select("Which CRM?", ["HubSpot", "Salesforce"]);
    const second = chat.ui.confirm("Go on?", "");
    expect(chat.waiting()).toBe(2);
    chat.show(shown.ui);
    expect(await first).toBe("HubSpot");
    expect(await second).toBe(true);
    expect(shown.did).toEqual(["select Which CRM?", "confirm Go on?"]);
    expect(chat.waiting()).toBe(0);
  });

  it("says what it said while hidden once it is shown", () => {
    const shown = screen();
    const chat = createChatUi({ screen: () => undefined });
    chat.ui.notify("pulse 1a2b landed", "info");
    expect(shown.did).toEqual([]);
    chat.show(shown.ui);
    expect(shown.did).toEqual(["notify pulse 1a2b landed"]);
  });

  it("puts back what it keeps on the screen each time it is shown, and not what it took off", () => {
    const first = screen();
    const chat = createChatUi({ screen: () => undefined });
    chat.show(first.ui);
    chat.ui.setWidget("turri-skill", ["brood · interview"]);
    chat.ui.setWidget("turri-gone", ["x"]);
    chat.ui.setWidget("turri-gone", undefined);
    chat.ui.setStatus("turri", "regenerating");
    chat.hide();
    chat.ui.setWorkingMessage("waiting for your answer");
    const again = screen();
    chat.show(again.ui);
    expect(again.did).toEqual(["widget turri-skill on", "status turri regenerating", "working waiting for your answer"]);
  });

  it("keeps what was typed in its editor and not sent", () => {
    const shown = screen();
    const chat = createChatUi({ screen: () => undefined });
    chat.show(shown.ui);
    shown.ui.setEditorText("half a thought");
    chat.hide();
    expect(shown.editor()).toBe("");
    expect(chat.ui.getEditorText()).toBe("half a thought");
    chat.show(shown.ui);
    expect(shown.editor()).toBe("half a thought");
  });

  it("keeps every name when pi copies it, as pi copies the ui it is given", async () => {
    const shown = screen(["yes"]);
    const chat = createChatUi({ screen: () => shown.ui });
    const copied = { ...chat.ui } as ExtensionUIContext;
    chat.show(shown.ui);
    copied.setWidget("turri-jobs", ["a pulse"]);
    copied.notify("hello", "info");
    expect(await copied.select("Ship it?", ["yes"])).toBe("yes");
    expect(shown.did).toEqual(["widget turri-jobs on", "notify hello", "select Ship it?"]);
    expect(copied.getEditorText()).toBe("");
  });

  it("reads the theme from the screen, even before it was ever shown", () => {
    const shown = screen();
    const chat = createChatUi({ screen: () => shown.ui });
    expect((chat.ui.theme as unknown as { name: string }).name).toBe("the screen's");
  });

  it("answers its questions with nothing when the chat is closed unasked", async () => {
    const chat = createChatUi({ screen: () => undefined });
    const asked = chat.ui.select("Which?", ["a"]);
    const confirmed = chat.ui.confirm("Sure?", "");
    chat.close();
    expect(await asked).toBeUndefined();
    expect(await confirmed).toBe(false);
  });
});
