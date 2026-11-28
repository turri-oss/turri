import { afterEach, describe, expect, it, vi } from "vitest";
import { gateLine, printReport } from "../src/skill-report.ts";

const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

describe("a gated skill's run, printed", () => {
  afterEach(() => vi.restoreAllMocks());

  it("lists each step with its gate as it starts - its rubric, judges, quorum, what a failure does and how often it is tried", () => {
    expect(gateLine({ name: "intent" })).toBe("intent -> no gate");
    expect(gateLine({ name: "stack", gate: { rubric: "stack.md", judges: 3, quorum: "majority", onFail: "retry", maxRetries: 2 } })).toBe(
      "stack -> gate(stack.md, judges=3, quorum=majority, on_fail=retry, max_retries=2)",
    );
    expect(gateLine({ name: "product", gate: { rubric: "product.md", judges: 2, quorum: "all", onFail: "escalate", maxRetries: 1, continuous: { rubric: "live.md", judges: 1 } } })).toBe(
      "product -> gate(product.md, judges=2, quorum=all, on_fail=escalate, max_retries=1) + continuous(live.md, judges=1)",
    );
  });

  it("says each judge's verdict, counted from one, and the gate's decision with its critique under it", () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => void lines.push(plain(args.join(" "))));
    printReport({ kind: "gate", step: "stack", judges: 0 });
    printReport({ kind: "judge", step: "stack", judge: 0, model: "p/judge", verdict: "none", violations: 0 });
    printReport({ kind: "outcome", step: "stack", decision: "retry", critique: "Name the database.\nSay why." });
    expect(lines).toEqual(["> gate stack no artifact - failing without spending judges", "  judge 1 (p/judge): none", "  retry <- gate stack", "    Name the database.", "    Say why."]);
  });
});
