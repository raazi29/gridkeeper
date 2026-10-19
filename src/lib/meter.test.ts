import { describe, expect, it } from "vitest";
import {
  cardLine,
  chipModel,
  codexNa,
  compactHint,
  contextLevel,
  estimateNote,
  formatCost,
  formatDuration,
  formatPct,
  formatTokens,
  geminiNa,
  meterLabel,
  meterTooltip,
  paneCost,
  workspaceCost,
} from "./meter";
import type { SessionMeter } from "./types";

function meter(over: Partial<SessionMeter> = {}): SessionMeter {
  return {
    sessionId: "s1",
    status: "metered",
    note: null,
    chained: false,
    claudeSessionId: "c1",
    costUsd: 0.42,
    paneCostUsd: 0.42,
    contextPct: 37,
    contextSize: 200_000,
    inputTokens: 74_000,
    outputTokens: 2100,
    apiDurationMs: 72_000,
    durationMs: 300_000,
    model: "Opus 4.1",
    fiveHourPct: null,
    sevenDayPct: null,
    updatedMs: 1000,
    ...over,
  };
}

describe("formatting", () => {
  it("formats cost", () => {
    expect(formatCost(0.42)).toBe("$0.42");
    expect(formatCost(0)).toBe("$0.00");
    expect(formatCost(0.004)).toBe("<$0.01");
    expect(formatCost(12.345)).toBe("$12.35");
    expect(formatCost(1500)).toBe("$1.5k");
    expect(formatCost(2000)).toBe("$2k");
    expect(formatCost(null)).toBe("—");
    expect(formatCost(Number.NaN)).toBe("—");
  });
  it("formats percent, tokens and durations", () => {
    expect(formatPct(37.4)).toBe("37%");
    expect(formatPct(0.3)).toBe("<1%");
    expect(formatPct(0)).toBe("0%");
    expect(formatPct(undefined)).toBe("—");
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(7400)).toBe("7.4k");
    expect(formatTokens(2000)).toBe("2k");
    expect(formatTokens(74_000)).toBe("74k");
    expect(formatTokens(200_000)).toBe("200k");
    expect(formatTokens(1_000_000)).toBe("1M");
    expect(formatTokens(1_250_000)).toBe("1.3M");
    expect(formatDuration(2300)).toBe("2.3s");
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(72_000)).toBe("1m 12s");
    expect(formatDuration(3_780_000)).toBe("1h 3m");
  });
});

describe("thresholds", () => {
  it("warns at 80 % context and above", () => {
    expect(contextLevel(79.9)).toBe("ok");
    expect(contextLevel(80)).toBe("warn");
    expect(contextLevel(97)).toBe("warn");
    expect(contextLevel(null)).toBe("ok");
  });
  it("puts the compact hint in the tooltip only when nearly full", () => {
    expect(meterTooltip(meter({ contextPct: 85 }))).toContain(compactHint());
    expect(meterTooltip(meter({ contextPct: 40 }))).not.toContain(compactHint());
  });
});

describe("labels and tooltip", () => {
  it("chip, card line and tooltip", () => {
    const m = meter();
    expect(meterLabel(m)).toBe("$0.42 · 37%");
    expect(cardLine(m)).toBe("est. $0.42 · ctx 37%");
    expect(meterLabel(meter({ contextPct: null }))).toBe("$0.42");
    expect(cardLine(meter({ costUsd: null, paneCostUsd: null }))).toBe("ctx 37%");
    const tip = meterTooltip(m);
    expect(tip).toContain("Estimated cost: $0.42 in this pane");
    expect(tip).toContain("Context: 37% of 200k tokens (74k in · 2.1k out)");
    expect(tip).toContain("Model: Opus 4.1");
    expect(tip).toContain("API time: 1m 12s");
    expect(tip).toContain(estimateNote());
    expect(tip).not.toContain("current conversation");
  });
  it("tooltip shows the current conversation when the pane total differs (after /clear)", () => {
    const tip = meterTooltip(meter({ costUsd: 0.1, paneCostUsd: 0.52, fiveHourPct: 23, sevenDayPct: 41, chained: true }));
    expect(tip).toContain("Estimated cost: $0.52 in this pane ($0.10 in the current conversation)");
    expect(tip).toContain("Plan limits used: 5-hour 23% · 7-day 41%");
    expect(tip).toContain("Your own status line still runs in the pane.");
  });
});

describe("totals", () => {
  it("pane cost prefers the running total", () => {
    expect(paneCost(meter({ costUsd: 0.1, paneCostUsd: 0.5 }))).toBe(0.5);
    expect(paneCost(meter({ paneCostUsd: null }))).toBe(0.42);
    expect(paneCost(meter({ updatedMs: null }))).toBeNull();
    expect(paneCost(undefined)).toBeNull();
  });
  it("workspace total sums panes with data only", () => {
    const by = {
      a: meter({ sessionId: "a", paneCostUsd: 1.1 }),
      b: meter({ sessionId: "b", paneCostUsd: 2 }),
      c: meter({ sessionId: "c", updatedMs: null }),
      other: meter({ sessionId: "other", paneCostUsd: 50 }),
    };
    expect(workspaceCost(["a", "b", "c", "missing"], by)).toBeCloseTo(3.1);
    expect(workspaceCost(["c", "missing"], by)).toBeNull();
    expect(workspaceCost([], by)).toBeNull();
  });
});

describe("chipModel", () => {
  it("shows nothing while the setting is off", () => {
    expect(chipModel({ agent: "claude", enabled: false, meter: meter() })).toBeNull();
    expect(chipModel({ agent: "codex", enabled: false })).toBeNull();
  });
  it("Claude: data chip with warning level, nothing without data", () => {
    const c = chipModel({ agent: "claude", enabled: true, meter: meter({ contextPct: 91 }) });
    expect(c).toMatchObject({ kind: "data", label: "$0.42 · 91%", level: "warn" });
    expect(chipModel({ agent: "claude", enabled: true, meter: meter({ updatedMs: null }) })).toBeNull();
    expect(chipModel({ agent: "claude", enabled: true })).toBeNull();
  });
  it("Claude: off reasons win over stale data", () => {
    const c = chipModel({ agent: "claude", enabled: true, meter: meter({ status: "customSettings", note: "meter off: custom --settings" }) });
    expect(c).toEqual({ kind: "off", label: "meter off", tooltip: "meter off: custom --settings" });
    expect(chipModel({ agent: "claude", enabled: true, meter: meter({ status: "managed", note: null, updatedMs: null }) })?.kind).toBe("off");
  });
  it("Codex and Gemini are labelled n/a; other agents show nothing", () => {
    expect(chipModel({ agent: "codex", enabled: true })).toEqual({ kind: "na", label: "n/a", tooltip: codexNa() });
    expect(chipModel({ agent: "generic", preset: "gemini", enabled: true })).toEqual({ kind: "na", label: "n/a", tooltip: geminiNa() });
    expect(chipModel({ agent: "generic", preset: "hermes", enabled: true })).toBeNull();
    expect(chipModel({ agent: "powershell", enabled: true })).toBeNull();
  });
});
