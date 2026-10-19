import { describe, expect, it } from "vitest";
import type { SessionInfo } from "../../lib/types";
import { historyState, pushEntry, type HistoryEntry } from "../../store/stateHistory";
import { frac, liveRange, panRange, segmentsFor, stateTotals, tickLabel, ticks, tickStep, zoomRange, SPAN_MAX, SPAN_MIN } from "./timeline";

const e = (at: number, state: HistoryEntry["state"]): HistoryEntry => ({ at, state });

describe("segmentsFor", () => {
  const hist = [e(100, "idle"), e(200, "working"), e(500, "waiting"), e(700, "working")];
  it("lasts each state until the next entry, the last one until now", () => {
    expect(segmentsFor(hist, 0, 1000, 900)).toEqual([
      { state: "idle", from: 100, to: 200 },
      { state: "working", from: 200, to: 500 },
      { state: "waiting", from: 500, to: 700 },
      { state: "working", from: 700, to: 900 },
    ]);
  });
  it("clips to the range and drops what is outside", () => {
    expect(segmentsFor(hist, 300, 600, 900)).toEqual([
      { state: "working", from: 300, to: 500 },
      { state: "waiting", from: 500, to: 600 },
    ]);
    expect(segmentsFor(hist, 0, 50, 900)).toEqual([]);
    expect(segmentsFor([], 0, 50, 900)).toEqual([]);
  });
  it("merges equal neighbours and totals the time per state", () => {
    const segs = segmentsFor([e(0, "working"), e(10, "working"), e(20, "idle")], 0, 100, 30);
    expect(segs).toEqual([
      { state: "working", from: 0, to: 20 },
      { state: "idle", from: 20, to: 30 },
    ]);
    expect(stateTotals(segs)).toEqual({ working: 20, idle: 10 });
  });
});

describe("time range", () => {
  it("zooms around a moment and respects the span limits", () => {
    const r = { from: 0, to: 600_000 };
    const z = zoomRange(r, 0.5, 300_000);
    expect(z).toEqual({ from: 150_000, to: 450_000 });
    expect(zoomRange(r, 0.0001, 0).to - zoomRange(r, 0.0001, 0).from).toBe(SPAN_MIN);
    expect(zoomRange(r, 1e6, 0).to - zoomRange(r, 1e6, 0).from).toBe(SPAN_MAX);
  });
  it("pans but never past now, and builds live ranges", () => {
    expect(panRange({ from: 0, to: 100_000 }, 50_000, 120_000)).toEqual({ from: 20_000, to: 120_000 });
    expect(panRange({ from: 50_000, to: 150_000 }, -30_000, 999_999)).toEqual({ from: 20_000, to: 120_000 });
    expect(liveRange(60_000, 1_000_000)).toEqual({ from: 940_000, to: 1_000_000 });
    expect(frac({ from: 0, to: 200 }, 50)).toBe(0.25);
  });
  it("picks readable ticks", () => {
    expect(tickStep(5 * 60_000, 10)).toBe(30_000);
    expect(tickStep(3600_000, 8)).toBe(600_000);
    const t = ticks({ from: 1_000, to: 61_000 }, 6, 0);
    expect(t[0].t).toBe(10_000);
    expect(t.every((x) => x.step === 10_000)).toBe(true);
    expect(tickLabel(new Date(2026, 0, 1, 9, 5, 7).getTime(), 10_000)).toBe("09:05:07");
    expect(tickLabel(new Date(2026, 0, 1, 9, 5, 7).getTime(), 60_000)).toBe("09:05");
  });
});

describe("state history", () => {
  const rt = (state: SessionInfo["state"]): SessionInfo => ({
    id: "x",
    name: "x",
    agent: "claude",
    pid: 1,
    state,
    cwd: "C:\\",
    profileId: null,
    commandDisplay: "",
    startedAt: null,
    endedAt: null,
    bytesOut: 0,
  });
  it("maps process + attention state", () => {
    expect(historyState(undefined, undefined)).toBe("off");
    expect(historyState(rt({ state: "running" }), undefined)).toBe("idle");
    expect(historyState(rt({ state: "running" }), { state: "waiting", unread: true, at: 0 })).toBe("waiting");
    expect(historyState(rt({ state: "exited", code: 0 }), { state: "working", unread: false, at: 0 })).toBe("off");
    expect(historyState(rt({ state: "exited", code: 3 }), undefined)).toBe("error");
    expect(historyState(rt({ state: "failed", message: "x" }), undefined)).toBe("error");
  });
  it("appends changes only, replaces same-moment changes and stays bounded", () => {
    let l: readonly HistoryEntry[] = [];
    l = pushEntry(l, e(10, "idle"));
    const same = pushEntry(l, e(20, "idle"));
    expect(same).toBe(l);
    l = pushEntry(l, e(30, "working"));
    l = pushEntry(l, e(30, "waiting"));
    expect(l).toEqual([e(10, "idle"), e(30, "waiting")]);
    l = pushEntry(l, e(30, "idle"));
    expect(l).toEqual([e(10, "idle")]);
    l = pushEntry(l, e(5, "done")); // out of order: never before the last entry
    expect(l[l.length - 1]).toEqual(e(10, "done"));
    let big: readonly HistoryEntry[] = [];
    for (let i = 0; i < 20; i++) big = pushEntry(big, e(i, i % 2 ? "idle" : "working"), 8);
    expect(big.length).toBe(8);
    expect(big[7].at).toBe(19);
  });
});
