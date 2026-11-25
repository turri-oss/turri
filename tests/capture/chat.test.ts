import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { captureEnded, captureFailed, captureGoesOn, captureOpenQuestion, captureRefusal, captureStartedText, readReopenedAfterCapture, reopenedAfterCapture } from "../../src/capture/chat.ts";
import { CaptureError } from "../../src/capture/capture.ts";
import { saveState, newState } from "../../src/capture/state.ts";
import { writeCodebase } from "./fixture.ts";

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function codebase(): string {
  const root = writeCodebase();
  made.push(root);
  return root;
}

describe("/capture in the chat", () => {
  it("starts on a codebase with no plain/ yet, and goes on with one that was stopped", () => {
    const root = codebase();
    expect(captureRefusal(root)).toBeUndefined();
    expect(captureGoesOn(root)).toBe(false);
    saveState(join(root, "plain"), newState(root));
    expect(captureRefusal(root)).toBeUndefined();
    expect(captureGoesOn(root)).toBe(true);
    expect(captureStartedText(root, true)).toMatch(/^Going on with the capture .* in the background\. Nothing is asked/);
  });

  it("refuses a folder that is not there, a finished capture, and a plain/ that is not a capture", () => {
    const root = codebase();
    expect(captureRefusal(join(root, "missing"))).toMatch(/is not a folder/);
    saveState(join(root, "plain"), { ...newState(root), finished: "2026-11-23T10:00:00Z" });
    expect(captureRefusal(root)).toMatch(/holds a finished capture already/);

    const other = codebase();
    mkdirSync(join(other, "plain"));
    writeFileSync(join(other, "plain", "app.plain"), "***functional specs***\n");
    expect(captureRefusal(other)).toMatch(/holds app\.plain and no capture of turri's/);
  });

  it("ends in a line for the person and a turn for the chat's agent to pass the report on, regenerating nothing", () => {
    const end = captureEnded("/work/app", { plainDir: "/work/app/plain", reportFile: "/work/app/plain/.turri/capture/report.md", summary: "Captured 3 functional specs in 2 modules.", modules: ["storage", "api"], specs: 3, uncaptured: 0, failing: 0 });
    expect(end).toMatchObject({ skill: "capture", ok: true, line: `Capture finished: Captured 3 functional specs in 2 modules. The report: ${join("plain", ".turri", "capture", "report.md")}. To review and regenerate it, open turri in its folder: cd plain && turri.` });
    expect(end.task).toContain("Change no ***plain and regenerate nothing until they say.");
    expect(end.task).toContain("tell them to open turri in its folder to review and regenerate it - `cd plain && turri`");
    expect(captureFailed(new CaptureError("no source code")).task).toBe("The capture the person started with /capture stopped: no source code\nTell the person in a line or two.");
    expect(captureFailed(new Error("provider down")).task).toContain("/capture again goes on from where it was");
  });

  it("told in turri opened again in the captured project, says nothing of opening it elsewhere", () => {
    const end = captureEnded("/work/app/plain", { plainDir: "/work/app/plain", reportFile: "/work/app/plain/.turri/capture/report.md", summary: "Captured 3 functional specs in 2 modules." });
    expect(end.line).toBe(`Capture finished: Captured 3 functional specs in 2 modules. The report: ${join(".turri", "capture", "report.md")}.`);
    expect(end.task).not.toContain("open turri in its folder");
  });

  it("asks to open turri again in the captured project, and hands it what the capture said", () => {
    const question = captureOpenQuestion("/work/app", { plainDir: "/work/app/plain", summary: "Captured 3 functional specs in 2 modules." });
    expect(question.title).toBe("Open the captured ***plain in plain/?");
    expect(question.message).toContain("ctrl+h shows its ***plain and /regenerate builds it");
    expect(question.message).toContain("`cd plain && turri` opens it later");
    expect(readReopenedAfterCapture(reopenedAfterCapture("Captured 3 functional specs."))).toEqual({ summary: "Captured 3 functional specs." });
    expect([readReopenedAfterCapture(undefined), readReopenedAfterCapture("not json"), readReopenedAfterCapture("{}")]).toEqual([undefined, undefined, undefined]);
  });
});
