import { describe, expect, it } from "vitest";
import { MAX_WEBGL, allocateWebgl, diffAllocation, type WebglCandidate } from "./webglBudget";

const c = (id: string, priority: number, active = false): WebglCandidate => ({ id, priority, active });

describe("allocateWebgl", () => {
  it("grants everyone under budget", () => {
    const r = allocateWebgl([c("a", 1), c("b", 2)], 12);
    expect([...r].sort()).toEqual(["a", "b"]);
  });

  it("never exceeds the budget", () => {
    const many = Array.from({ length: 40 }, (_, i) => c(`t${i}`, i, i % 3 === 0));
    expect(allocateWebgl(many).size).toBe(MAX_WEBGL);
    expect(MAX_WEBGL).toBeLessThan(16);
  });

  it("keeps existing contexts (stable) instead of thrashing to higher priority newcomers", () => {
    const r = allocateWebgl([c("old1", 1, true), c("old2", 2, true), c("new", 100)], 2);
    expect([...r].sort()).toEqual(["old1", "old2"]);
  });

  it("fills free slots by priority", () => {
    const r = allocateWebgl([c("low", 1), c("high", 9), c("mid", 5), c("held", 0, true)], 3);
    expect([...r].sort()).toEqual(["held", "high", "mid"]);
  });

  it("drops lowest-priority active ones when the budget shrinks", () => {
    const r = allocateWebgl([c("a", 1, true), c("b", 5, true), c("c", 3, true)], 2);
    expect([...r].sort()).toEqual(["b", "c"]);
  });

  it("returns nothing for zero budget", () => {
    expect(allocateWebgl([c("a", 1)], 0).size).toBe(0);
  });
});

describe("diffAllocation", () => {
  it("computes grants and revokes", () => {
    const d = diffAllocation(new Set(["a", "b"]), new Set(["b", "c"]));
    expect(d).toEqual({ grant: ["c"], revoke: ["a"] });
  });
});
