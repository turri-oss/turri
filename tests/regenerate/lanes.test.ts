import { describe, expect, it } from "vitest";
import { createJobRegistry, describeJob } from "../../src/regenerate/jobs.ts";

function gated() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const order: string[] = [];
  const run = (name: string, fail = false) => async () => {
    order.push(`start ${name}`);
    await gate;
    order.push(`end ${name}`);
    if (fail) throw new Error("boom");
    return { report: name };
  };
  return { release, order, run };
}

describe("jobs that write the same module", () => {
  it("queue behind each other, in order, and start their clock only when they start", async () => {
    const jobs = createJobRegistry();
    const { release, order, run } = gated();
    const a = jobs.start({ kind: "render", summary: "a", lanes: ["m"], run: run("a") });
    const b = jobs.start({ kind: "render", summary: "b", lanes: ["m"], run: run("b") });
    const c = jobs.start({ kind: "render", summary: "c", lanes: ["m"], run: run("c") });

    expect(a.status).toBe("running");
    expect(b.status).toBe("queued");
    expect(b.waitingOn).toEqual([a.id]);
    expect(c.waitingOn).toEqual([b.id]);
    expect(describeJob(b)).toContain(`queued behind pulse ${a.id}`);

    const queuedAt = b.queuedAt;
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    await jobs.wait(c.id);

    expect(order).toEqual(["start a", "end a", "start b", "end b", "start c", "end c"]);
    expect(b.startedAt).toBeGreaterThan(queuedAt);
  });

  it("still run the next one when the one ahead fails", async () => {
    const jobs = createJobRegistry();
    const { release, run } = gated();
    const a = jobs.start({ kind: "render", summary: "a", lanes: ["m"], run: run("a", true) });
    const b = jobs.start({ kind: "render", summary: "b", lanes: ["m"], run: run("b") });
    release();
    await jobs.wait(b.id);
    expect(a.status).toBe("failed");
    expect(b.status).toBe("succeeded");
  });

  it("wait if they share any lane, and run side by side if they share none", () => {
    const jobs = createJobRegistry();
    const { run } = gated();
    jobs.start({ kind: "render", summary: "base", lanes: ["base"], run: run("base") });
    const other = jobs.start({ kind: "render", summary: "other", lanes: ["other"], run: run("other") });
    const chain = jobs.start({ kind: "render", summary: "chain", lanes: ["app", "base"], run: run("chain") });
    expect(other.status).toBe("running");
    expect(chain.status).toBe("queued");
  });

  it("do not wait on a lane whose last job already finished", async () => {
    const jobs = createJobRegistry();
    const first = jobs.start({ kind: "render", summary: "a", lanes: ["m"], run: async () => ({ report: "" }) });
    await jobs.wait(first.id);
    const next = jobs.start({ kind: "render", summary: "b", lanes: ["m"], run: async () => ({ report: "" }) });
    expect(next.status).toBe("running");
  });

});
