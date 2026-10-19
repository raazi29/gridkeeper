import { describe, expect, it } from "vitest";
import type { SessionMeter } from "./types";
import {
  bannerFor,
  bookMeter,
  dayKey,
  dueSteps,
  emptyLedger,
  guardLevel,
  markResumed,
  markTripped,
  markWarned,
  msUntilNextDay,
  normalizeGuard,
  NO_WORKSPACE,
  parseLedger,
  pruneLedger,
  spentToday,
  startOfDay,
  suggestRaise,
  todayLabel,
  type SpendLedger,
} from "./spend";

// Local times (the day boundary is local midnight, whatever the test machine's zone).
const at = (y: number, mo: number, d: number, h = 12, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const NOON = at(2026, 10, 19, 12);

function meter(sessionId: string, claudeSessionId: string | null, costUsd: number | null, updatedMs: number | null = NOON): SessionMeter {
  return {
    sessionId,
    status: "metered",
    note: null,
    chained: false,
    claudeSessionId,
    costUsd,
    paneCostUsd: costUsd,
    contextPct: null,
    contextSize: null,
    inputTokens: null,
    outputTokens: null,
    apiDurationMs: null,
    durationMs: null,
    model: null,
    fiveHourPct: null,
    sevenDayPct: null,
    updatedMs,
  };
}

function book(l: SpendLedger, steps: [SessionMeter, string | null, number][]): SpendLedger {
  for (const [m, ws, now] of steps) l = bookMeter(l, m, ws, now).ledger;
  return l;
}

describe("day boundary", () => {
  it("local calendar days and midnight", () => {
    expect(dayKey(at(2026, 10, 19, 0, 0))).toBe("2026-10-19");
    expect(dayKey(at(2026, 10, 19, 23, 59))).toBe("2026-10-19");
    expect(dayKey(at(2026, 10, 20, 0, 0))).toBe("2026-10-20");
    expect(startOfDay(at(2026, 10, 19, 15, 30))).toBe(at(2026, 10, 19, 0, 0));
    expect(msUntilNextDay(at(2026, 10, 19, 23, 0))).toBe(at(2026, 10, 20, 0, 0) - at(2026, 10, 19, 23, 0));
    expect(dayKey(at(2026, 12, 31, 23, 59) + msUntilNextDay(at(2026, 12, 31, 23, 59)))).toBe("2027-01-01");
  });
});

describe("ledger bookkeeping", () => {
  it("books cost increases per conversation to today and the pane's workspace", () => {
    let l = emptyLedger();
    let b = bookMeter(l, meter("p1", "c1", 0.1), "w1", NOON);
    expect(b.delta).toBeCloseTo(0.1);
    l = b.ledger;
    b = bookMeter(l, meter("p1", "c1", 0.35), "w1", NOON + 60_000);
    expect(b.delta).toBeCloseTo(0.25);
    l = b.ledger;
    // The same record again changes nothing (same object back).
    expect(bookMeter(l, meter("p1", "c1", 0.35), "w1", NOON + 61_000).ledger).toBe(l);
    // /clear: a new conversation starts at $0 and books from there; the earlier spend stays.
    l = book(l, [
      [meter("p1", "c2", 0), "w1", NOON + 120_000],
      [meter("p1", "c2", 0.5), "w1", NOON + 180_000],
    ]);
    expect(spentToday(l, "w1", NOON)).toBeCloseTo(0.85);
    // Another workspace and a pane in none.
    l = book(l, [
      [meter("p2", "c3", 1), "w2", NOON],
      [meter("p3", "c4", 2), null, NOON],
    ]);
    expect(spentToday(l, "w2", NOON)).toBeCloseTo(1);
    expect(spentToday(l, NO_WORKSPACE, NOON)).toBeCloseTo(2);
    expect(spentToday(l, "w1", NOON)).toBeCloseTo(0.85);
  });

  it("a resumed conversation with a fresh counter books the new value; no data books nothing", () => {
    let l = book(emptyLedger(), [[meter("p1", "c1", 2), "w1", NOON]]);
    l = book(l, [
      [meter("p9", "c1", 0.2), "w1", NOON + 1000],
      [meter("p9", "c1", 0.3), "w1", NOON + 2000],
    ]);
    expect(spentToday(l, "w1", NOON)).toBeCloseTo(2.3);
    expect(bookMeter(l, meter("p1", "c9", null), "w1", NOON).delta).toBe(0);
    expect(bookMeter(l, meter("p1", "c9", 1, null), "w1", NOON).delta).toBe(0);
  });

  it("splits at local midnight; earlier days' conversations are a baseline, not today's spend", () => {
    const late = at(2026, 10, 19, 23, 50);
    const early = at(2026, 10, 20, 0, 10);
    let l = book(emptyLedger(), [
      [meter("p1", "c1", 1, late), "w1", late],
      [meter("p1", "c1", 1.4, early), "w1", early],
    ]);
    expect(spentToday(l, "w1", late)).toBeCloseTo(1);
    expect(spentToday(l, "w1", early)).toBeCloseTo(0.4);
    // First sight of a conversation whose data is from yesterday (e.g. the first run with the guard): baseline only.
    l = book(l, [[meter("p2", "old", 5, late), "w1", early]]);
    expect(spentToday(l, "w1", early)).toBeCloseTo(0.4);
    l = book(l, [[meter("p2", "old", 5.5, early + 1000), "w1", early + 1000]]);
    expect(spentToday(l, "w1", early)).toBeCloseTo(0.9);
  });

  it("round-trips through JSON leniently and prunes old data", () => {
    let l = book(emptyLedger(), [[meter("p1", "c1", 1), "w1", NOON]]);
    l = markWarned(l, "w1", normalizeGuard({ budgetUsd: 2, warnPct: 50, action: "warn" })!, NOON);
    const back = parseLedger(JSON.stringify(l))!;
    expect(back).toEqual(l);
    expect(parseLedger("not json")).toBeNull();
    expect(parseLedger("[1]")).toBeNull();
    expect(parseLedger(null)).toBeNull();
    const messy = parseLedger(JSON.stringify({ days: { "2026-10-19": { w1: 1, w2: -3, w3: "x" }, bad: { w1: 1 } }, last: { k: { cost: "1" } }, tripped: { w1: { day: "x" } } }))!;
    expect(messy.days).toEqual({ "2026-10-19": { w1: 1 } });
    expect(messy.last).toEqual({});
    expect(messy.tripped).toEqual({});
    // 40 days later: the old day and the forgotten conversation go, the marks of earlier days too.
    const later = NOON + 40 * 86_400_000;
    const pruned = pruneLedger(l, later);
    expect(pruned.days).toEqual({});
    expect(pruned.last).toEqual({});
    expect(pruned.warned).toEqual({});
    expect(pruneLedger(pruned, later)).toBe(pruned);
    // Today's data stays.
    expect(pruneLedger(l, NOON)).toBe(l);
  });
});

describe("guard rules", () => {
  const g = normalizeGuard({ budgetUsd: 10, warnPct: 80, action: "pause" })!;

  it("normalizes guards", () => {
    expect(normalizeGuard(undefined)).toBeNull();
    expect(normalizeGuard({ budgetUsd: 0 })).toBeNull();
    expect(normalizeGuard({ budgetUsd: -5, warnPct: 50, action: "warn" })).toBeNull();
    expect(normalizeGuard({ budgetUsd: 5.556, warnPct: 150, action: "explode" as never })).toEqual({ budgetUsd: 5.56, warnPct: 99, action: "warn" });
    expect(normalizeGuard({ budgetUsd: 5, warnPct: 0, action: "pauseNotify" })).toEqual({ budgetUsd: 5, warnPct: 1, action: "pauseNotify" });
  });

  it("levels and one-time steps per day and budget", () => {
    expect(guardLevel(7.99, g)).toBe("ok");
    expect(guardLevel(8, g)).toBe("warn");
    expect(guardLevel(10, g)).toBe("over");
    let l = emptyLedger();
    expect(dueSteps(l, "w1", 8.5, g, NOON)).toEqual({ warn: true, trip: false });
    l = markWarned(l, "w1", g, NOON);
    expect(dueSteps(l, "w1", 9, g, NOON)).toEqual({ warn: false, trip: false });
    expect(dueSteps(l, "w1", 10.2, g, NOON)).toEqual({ warn: false, trip: true });
    l = markTripped(l, "w1", g, NOON, "D:\\proj");
    expect(dueSteps(l, "w1", 12, g, NOON)).toEqual({ warn: false, trip: false });
    expect(bannerFor(l, "w1", 12, g, NOON)).toMatchObject({ pausedDir: "D:\\proj" });
    // Resumed: no banner and no new stop today for this budget.
    const resumed = markResumed(l, "w1", g, NOON);
    expect(bannerFor(resumed, "w1", 12, g, NOON)).toBeNull();
    expect(dueSteps(resumed, "w1", 15, g, NOON).trip).toBe(false);
    // A raised budget arms the guard again; reaching it acts again.
    const raised = normalizeGuard({ ...g, budgetUsd: 20 })!;
    expect(bannerFor(l, "w1", 12, raised, NOON)).toBeNull();
    expect(dueSteps(resumed, "w1", 21, raised, NOON).trip).toBe(true);
    // Next day: a fresh budget day (nothing spent yet, no banner).
    const tomorrow = at(2026, 10, 20, 9);
    expect(spentToday(l, "w1", tomorrow)).toBe(0);
    expect(bannerFor(l, "w1", 12, g, tomorrow)).toBeNull();
    expect(dueSteps(l, "w1", 10.5, g, tomorrow)).toEqual({ warn: false, trip: true });
    // Going straight past 100 % trips without a separate warning; the trip counts as warned.
    let fresh = emptyLedger();
    expect(dueSteps(fresh, "w2", 11, g, NOON)).toEqual({ warn: false, trip: true });
    fresh = markTripped(fresh, "w2", g, NOON, null);
    expect(fresh.warned.w2).toEqual({ day: "2026-10-19", budget: 10 });
  });

  it("labels and the raise suggestion", () => {
    expect(todayLabel(4.2, normalizeGuard({ budgetUsd: 10, warnPct: 80, action: "warn" }))).toBe("today ~$4.20 / $10");
    expect(todayLabel(4.2, null)).toBe("today ~$4.20");
    expect(todayLabel(0.004, normalizeGuard({ budgetUsd: 2.5, warnPct: 80, action: "warn" }))).toBe("today ~<$0.01 / $2.50");
    expect(suggestRaise(10.4, g)).toBe(16);
    expect(suggestRaise(0.5, normalizeGuard({ budgetUsd: 1, warnPct: 80, action: "warn" })!)).toBe(2);
  });
});
