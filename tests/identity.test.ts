import { describe, expect, it } from "vitest";
import { JOB_FINISHED_REACTION, pulseEndNote } from "../src/extension.ts";
import type { Job } from "../src/regenerate/jobs.ts";
import { TURRI_IDENTITY } from "../src/identity.ts";

describe("what the chat is told it is", () => {
  it("knows a job is a pulse, and the job queue regen - whatever a project's files still call them", () => {
    expect(TURRI_IDENTITY).toContain("A pulse is one unit of work regenerating the code");
    expect(TURRI_IDENTITY).toContain("the job_id a tool takes is a pulse's id");
    expect(TURRI_IDENTITY).toContain("parallel-jobs and");
    expect(TURRI_IDENTITY).toContain("\"Job\" in what you read is a pulse; say pulse.");
    expect(TURRI_IDENTITY).toContain("It was the regeneration, the job queue, or the job panel.");
    expect(TURRI_IDENTITY).toContain("Say regen,");
  });

  it("is turri itself, speaking in the first person, never of turri as someone else to pass a message to", () => {
    expect(TURRI_IDENTITY).toContain("you regenerate the code from it");
    expect(TURRI_IDENTITY).toContain("Speak as turri, in the first person");
    expect(TURRI_IDENTITY).toContain("never tell the person to tell or ask turri something");
    expect(TURRI_IDENTITY).not.toContain("turri regenerates");
    expect(TURRI_IDENTITY).not.toContain("Speak of yourself as turri");
  });

  it("introduces itself as the first coding agent with the power of regenerative software, that writes ***plain with the person and regenerates the code from it", () => {
    expect(TURRI_IDENTITY).toContain("You are turri - always lowercase - the first coding agent with the power of regenerative software.");
    expect(TURRI_IDENTITY).toContain("you write ***plain with them and regenerate the code from it");
    expect(TURRI_IDENTITY).toContain("Never say they write the\n***plain and you help");
    expect(TURRI_IDENTITY).not.toContain("help them write");
    expect(TURRI_IDENTITY).toContain("write the name escaped, \\*\\*\\*plain");
    expect(TURRI_IDENTITY).not.toContain("regenerative software harness");
  });

  it("tells its name as the likeness between the immortal jellyfish and regenerative software", () => {
    expect(TURRI_IDENTITY).toContain("Regenerative software works the same way - the ***plain is the genes");
    expect(TURRI_IDENTITY).toContain("Say it as that likeness, not as a fact about a");
  });

  it("goes on with the person while pulses regenerate in the background, and tells them they need not wait", () => {
    expect(TURRI_IDENTITY).toContain("Pulses regenerate in the background and never hold the conversation");
    expect(TURRI_IDENTITY).toContain("say so in a way that makes it plain they need not wait for it to finish");
    expect(TURRI_IDENTITY).toContain("never tell\nthem to wait for one, and never stop to wait for one yourself");
    expect(TURRI_IDENTITY).toContain("Changing the ***plain while a pulse runs is safe");
  });

  it("says regenerate for what it does to the code - never grow - and reads an older text's grow as regenerate", () => {
    expect(TURRI_IDENTITY).toContain("Regenerate is the word for what you do to the code: never grow, grew or grown");
    expect(TURRI_IDENTITY.replace(/never grow, grew or grown/, "")).not.toMatch(/\bgr[eo]w/i);
  });
});

describe("what the chat is told to do when a pulse stops on its environment", () => {
  it("heals it before regenerating it again - the sandbox's by config, a missing tool found or the script fixed to use it, never installed - and never makes up a credential", () => {
    expect(JOB_FINISHED_REACTION).toContain("stops the same way again until that is fixed: never regenerate it before");
    expect(JOB_FINISHED_REACTION).toContain("Add the folder its report\n  names to `toolchains:` in config.turri.yaml");
    // A refused write is no folder to add: never toolchains:, never resumed before the fix.
    expect(JOB_FINISHED_REACTION).toContain("kept the agents from writing a file");
    expect(JOB_FINISHED_REACTION).toContain("never add it there, and never resume before the fix");
    expect(JOB_FINISHED_REACTION).toContain("you install nothing,\n  and change no setting of the machine's or the person's shell - never, even when asked");
    expect(JOB_FINISHED_REACTION).toContain("python\n  where the testing script runs python3");
    expect(JOB_FINISHED_REACTION).toContain("the testing script calling\n  it the way this machine has it is the fix");
    expect(JOB_FINISHED_REACTION).toContain("tell the\n  person exactly what to run themselves");
    expect(JOB_FINISHED_REACTION).not.toContain("ask_user");
    expect(JOB_FINISHED_REACTION).toContain("needs turri restarted");
    expect(JOB_FINISHED_REACTION).toContain("never make one up");
  });
});

describe("what the chat is told to do when a pulse is launched after it", () => {
  it("does not launch it itself, and does what it was told to do once something is launched when it is told it is", () => {
    expect(JOB_FINISHED_REACTION).toContain("Under launch-after-pulse turri launches what a pulse lands itself, in the background");
    expect(JOB_FINISHED_REACTION).toContain("do not call launch for it");
    expect(JOB_FINISHED_REACTION).toContain("do then what you were told to do once something is launched");
  });
});

describe("what the chat that asked for a pulse is told as it ends, with the sentinel off", () => {
  const job = (over: Partial<Job> = {}) =>
    ({ id: "p3", kind: "regenerate", status: "succeeded", startedAt: 0, finishedAt: 5000, report: "greet says hello.", details: { landed: true }, ...over }) as unknown as Job;

  it("says the pulse's commit is being launched now, in the background, and that it is told once that ends - to say so in a line, and offer nothing else", () => {
    const text = pulseEndNote(job(), { launching: true });
    expect(text).toContain("Pulse p3 (regenerate) finished");
    expect(text).toContain("greet says hello.");
    expect(text).toContain("turri is launching the commit it landed now, in the background (launch-after-pulse): you are told once\nthat launch ends");
    expect(text).toContain("say in a line or two what landed and that it is being launched");
    expect(text).toContain("never say nothing runs");
    expect(text).not.toContain(JOB_FINISHED_REACTION);
  });

  it("reacts as before with launch-after-pulse off, and for a pulse that did not land", () => {
    expect(pulseEndNote(job(), { launching: false })).toContain(JOB_FINISHED_REACTION);
    expect(pulseEndNote(job(), { launching: false })).not.toContain("is launching the commit it landed");
    const failed = pulseEndNote(job({ status: "failed", error: "the unit tests failed", details: {} }), { launching: true });
    expect(failed).toContain("failed after");
    expect(failed).toContain(JOB_FINISHED_REACTION);
    const notLanded = pulseEndNote(job({ details: { landed: false } }), { launching: true });
    expect(notLanded).toContain(JOB_FINISHED_REACTION);
  });
});
