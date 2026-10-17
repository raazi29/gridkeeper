import { describe, expect, it } from "vitest";
import { applySamples, computeRate, formatRate, latestRate, type RateState } from "./rates";

const S = "2026-10-17T10:00:00Z";
const S2 = "2026-10-17T10:05:00Z";

describe("computeRate", () => {
  it("is null without a previous sample or elapsed time", () => {
    expect(computeRate(undefined, { bytes: 10, startedAt: S, t: 1000 })).toBeNull();
    expect(computeRate({ bytes: 0, startedAt: S, t: 1000 }, { bytes: 10, startedAt: S, t: 1000 })).toBeNull();
  });
  it("divides the byte delta by elapsed seconds", () => {
    expect(computeRate({ bytes: 1000, startedAt: S, t: 0 }, { bytes: 3048, startedAt: S, t: 1000 })).toBe(2048);
    expect(computeRate({ bytes: 1000, startedAt: S, t: 0 }, { bytes: 2000, startedAt: S, t: 2000 })).toBe(500);
  });
  it("treats a restart (new startedAt) as a counter reset", () => {
    // 900 bytes since the restart, all within the 1 s interval.
    expect(computeRate({ bytes: 50_000, startedAt: S, t: 0 }, { bytes: 900, startedAt: S2, t: 1000 })).toBe(900);
  });
  it("treats a counter that went backwards as a reset", () => {
    expect(computeRate({ bytes: 50_000, startedAt: S, t: 0 }, { bytes: 100, startedAt: S, t: 500 })).toBe(200);
  });
  it("never goes negative", () => {
    expect(computeRate({ bytes: 10, startedAt: null, t: 0 }, { bytes: 10, startedAt: null, t: 1000 })).toBe(0);
  });
});

describe("applySamples", () => {
  const empty: RateState = { hist: {}, last: {}, sampledAt: null };
  it("builds history from successive session_list results and drops removed sessions", () => {
    let st = applySamples(empty, [{ id: "a", bytesOut: 0, startedAt: S }, { id: "b", bytesOut: 0, startedAt: S }], 0);
    expect(st.hist.a).toEqual([]);
    st = applySamples(st, [{ id: "a", bytesOut: 1024, startedAt: S }, { id: "b", bytesOut: 0, startedAt: S }], 1000);
    st = applySamples(st, [{ id: "a", bytesOut: 3072, startedAt: S }], 2000);
    expect(st.hist.a).toEqual([1024, 2048]);
    expect(st.hist.b).toBeUndefined();
    expect(st.sampledAt).toBe(2000);
    expect(latestRate(st.hist.a)).toBe(2048);
  });
  it("caps history at the limit", () => {
    let st = empty;
    for (let i = 0; i <= 10; i++) st = applySamples(st, [{ id: "a", bytesOut: i * 100, startedAt: S }], i * 1000, 4);
    expect(st.hist.a).toEqual([100, 100, 100, 100]);
  });
  it("handles restarts mid-history", () => {
    let st = applySamples(empty, [{ id: "a", bytesOut: 10_000, startedAt: S }], 0);
    st = applySamples(st, [{ id: "a", bytesOut: 300, startedAt: S2 }], 1000);
    expect(st.hist.a).toEqual([300]);
  });
});

describe("formatRate", () => {
  it("labels KB/s, never tokens", () => {
    expect(formatRate(null)).toBe("—");
    expect(formatRate(0)).toBe("0 KB/s");
    expect(formatRate(1536)).toBe("1.5 KB/s");
    expect(formatRate(200 * 1024)).toBe("200 KB/s");
    expect(formatRate(3 * 1024 * 1024)).toBe("3.0 MB/s");
  });
});
