// Spend guard: a daily budget per workspace over the cost meter. Pure bookkeeping and rules (no React, no stores).
//
// Source: each pane's `session-meter` update carries Claude Code's own estimate for the current conversation
// (`costUsd`, keyed by `claudeSessionId`; it starts again at $0 after /clear because that is a new conversation).
// The ledger keeps the last cost seen per conversation and books every increase to the local day it was seen
// and to the workspace that owned the pane at that moment. A cost that goes down for the same conversation (a
// resume with a fresh counter) books the new value. The day boundary is local midnight. Numbers only: nothing
// from transcripts. Cost is Claude Code's estimate at list price (on a subscription: API-equivalent value).

import type { SessionMeter, SpendAction, SpendGuard } from "./types";

export const LEDGER_VERSION = 1;
/** Per-day totals kept this many days. */
export const KEEP_DAYS = 35;
/** Conversations not seen for this many days are forgotten. */
export const KEEP_CONVERSATION_DAYS = 7;
/** Totals booked for panes that belong to no workspace. */
export const NO_WORKSPACE = "_none";
const EPS = 1e-9;

export const SPEND_ACTIONS: readonly SpendAction[] = ["warn", "pause", "pauseNotify"];
export const DEFAULT_GUARD: SpendGuard = { budgetUsd: 10, warnPct: 80, action: "warn" };
export const SPEND_NOTE = "Claude Code's own estimate at list price; on a subscription this is API-equivalent value, not a bill.";

/** A one-time guard step, remembered with the budget it fired for (raising the budget arms it again). */
export interface GuardMark {
  day: string;
  budget: number;
}

export interface TripMark extends GuardMark {
  /** Project folder whose Autopilot the guard paused (resumed by "Resume"), if any. */
  pausedDir: string | null;
}

export interface SpendLedger {
  v: number;
  /** Local day (YYYY-MM-DD) -> workspace id -> USD booked that day. */
  days: Record<string, Record<string, number>>;
  /** Conversation key -> last cost seen and the day it was last seen. */
  last: Record<string, { cost: number; day: string }>;
  warned: Record<string, GuardMark>;
  tripped: Record<string, TripMark>;
  /** The user resumed / dismissed today's budget stop (no new action until the budget changes). */
  resumed: Record<string, GuardMark>;
}

export function emptyLedger(): SpendLedger {
  return { v: LEDGER_VERSION, days: {}, last: {}, warned: {}, tripped: {}, resumed: {} };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Local calendar day of `ms`, `YYYY-MM-DD`. */
export function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Local midnight that starts the day of `ms`. */
export function startOfDay(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Milliseconds until the next local midnight (DST-safe: computed from the calendar, not +24 h). */
export function msUntilNextDay(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime() - ms;
}

const isNum = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function marks<T extends GuardMark>(v: unknown, extra?: (o: Record<string, unknown>) => Omit<T, keyof GuardMark>): Record<string, T> {
  const out: Record<string, T> = {};
  if (!isObj(v)) return out;
  for (const [k, m] of Object.entries(v)) {
    if (isObj(m) && typeof m.day === "string" && DAY_RE.test(m.day) && isNum(m.budget)) {
      out[k] = { day: m.day, budget: m.budget, ...(extra ? extra(m) : {}) } as T;
    }
  }
  return out;
}

/** Lenient parse of the stored ledger: anything malformed is dropped, never thrown. Null = unusable. */
export function parseLedger(text: string | null | undefined): SpendLedger | null {
  if (!text) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(raw)) return null;
  const l = emptyLedger();
  if (isObj(raw.days)) {
    for (const [day, row] of Object.entries(raw.days)) {
      if (!DAY_RE.test(day) || !isObj(row)) continue;
      const clean: Record<string, number> = {};
      for (const [ws, usd] of Object.entries(row)) if (isNum(usd) && usd >= 0) clean[ws] = usd;
      l.days[day] = clean;
    }
  }
  if (isObj(raw.last)) {
    for (const [k, e] of Object.entries(raw.last)) {
      if (isObj(e) && isNum(e.cost) && e.cost >= 0 && typeof e.day === "string" && DAY_RE.test(e.day)) l.last[k] = { cost: e.cost, day: e.day };
    }
  }
  l.warned = marks<GuardMark>(raw.warned);
  l.resumed = marks<GuardMark>(raw.resumed);
  l.tripped = marks<TripMark>(raw.tripped, (o) => ({ pausedDir: typeof o.pausedDir === "string" ? o.pausedDir : null }));
  return l;
}

/** The conversation a meter update belongs to. */
export function conversationKey(m: Pick<SessionMeter, "sessionId" | "claudeSessionId">): string {
  return m.claudeSessionId ? `c:${m.claudeSessionId}` : `p:${m.sessionId}`;
}

export interface Booking {
  ledger: SpendLedger;
  /** USD booked to today by this update (0 when nothing changed). */
  delta: number;
}

/**
 * Book one meter update. A conversation seen for the first time counts in full when its data is from today
 * (a new conversation starts at $0), and only as a baseline when its data is older (an earlier day's spend).
 * Returns the same ledger object when nothing changed.
 */
export function bookMeter(ledger: SpendLedger, m: SessionMeter, workspaceId: string | null, now: number): Booking {
  const cost = m.costUsd;
  if (!isNum(cost) || cost < 0 || m.updatedMs === null || m.updatedMs === undefined) return { ledger, delta: 0 };
  const key = conversationKey(m);
  const today = dayKey(now);
  const prev = ledger.last[key];
  let delta: number;
  if (!prev) delta = m.updatedMs >= startOfDay(now) ? cost : 0;
  else if (cost + EPS < prev.cost) delta = cost; // the counter started again
  else delta = cost - prev.cost;
  if (prev && prev.cost === cost && prev.day === today) return { ledger, delta: 0 };
  const next: SpendLedger = { ...ledger, last: { ...ledger.last, [key]: { cost, day: today } } };
  if (delta > EPS) {
    const ws = workspaceId ?? NO_WORKSPACE;
    const row = { ...(ledger.days[today] ?? {}) };
    row[ws] = (row[ws] ?? 0) + delta;
    next.days = { ...ledger.days, [today]: row };
  } else delta = 0;
  return { ledger: next, delta };
}

/** USD booked today for a workspace. */
export function spentToday(ledger: SpendLedger | null, workspaceId: string, now: number): number {
  return ledger?.days[dayKey(now)]?.[workspaceId] ?? 0;
}

/** Drop old days, forgotten conversations and marks of earlier days. Returns the same object when nothing went. */
export function pruneLedger(ledger: SpendLedger, now: number): SpendLedger {
  const today = dayKey(now);
  const oldestDay = dayKey(startOfDay(now) - (KEEP_DAYS - 1) * 86_400_000 + 3_600_000);
  const oldestConv = dayKey(startOfDay(now) - (KEEP_CONVERSATION_DAYS - 1) * 86_400_000 + 3_600_000);
  let changed = false;
  const days: SpendLedger["days"] = {};
  for (const [d, row] of Object.entries(ledger.days)) (d >= oldestDay ? (days[d] = row) : (changed = true));
  const last: SpendLedger["last"] = {};
  for (const [k, e] of Object.entries(ledger.last)) (e.day >= oldestConv ? (last[k] = e) : (changed = true));
  const keepToday = <T extends GuardMark>(m: Record<string, T>) => {
    const out: Record<string, T> = {};
    for (const [k, v] of Object.entries(m)) (v.day === today ? (out[k] = v) : (changed = true));
    return out;
  };
  const warned = keepToday(ledger.warned);
  const tripped = keepToday(ledger.tripped);
  const resumed = keepToday(ledger.resumed);
  return changed ? { ...ledger, days, last, warned, tripped, resumed } : ledger;
}

// ---- guard rules -------------------------------------------------------------------------------------------

/** A usable guard (budget > 0), with warn % and action normalized; null = no guard. */
export function normalizeGuard(g: Partial<SpendGuard> | null | undefined): SpendGuard | null {
  if (!g || !isNum(g.budgetUsd) || g.budgetUsd <= 0) return null;
  const warnPct = isNum(g.warnPct) ? Math.min(99, Math.max(1, Math.round(g.warnPct))) : DEFAULT_GUARD.warnPct;
  const action = SPEND_ACTIONS.includes(g.action as SpendAction) ? (g.action as SpendAction) : "warn";
  return { budgetUsd: Math.round(g.budgetUsd * 100) / 100, warnPct, action };
}

export type GuardLevel = "ok" | "warn" | "over";

export function guardLevel(spent: number, g: SpendGuard): GuardLevel {
  if (spent + EPS >= g.budgetUsd) return "over";
  if (spent + EPS >= (g.budgetUsd * g.warnPct) / 100) return "warn";
  return "ok";
}

const sameMark = (m: GuardMark | undefined, day: string, g: SpendGuard) => !!m && m.day === day && m.budget === g.budgetUsd;

/** One-time steps due now for a workspace: each fires once per day and budget. */
export function dueSteps(ledger: SpendLedger, workspaceId: string, spent: number, g: SpendGuard, now: number): { warn: boolean; trip: boolean } {
  const day = dayKey(now);
  const level = guardLevel(spent, g);
  const trip = level === "over" && !sameMark(ledger.tripped[workspaceId], day, g) && !sameMark(ledger.resumed[workspaceId], day, g);
  const warn = level === "warn" && !sameMark(ledger.warned[workspaceId], day, g);
  return { warn, trip };
}

export function markWarned(ledger: SpendLedger, workspaceId: string, g: SpendGuard, now: number): SpendLedger {
  return { ...ledger, warned: { ...ledger.warned, [workspaceId]: { day: dayKey(now), budget: g.budgetUsd } } };
}

export function markTripped(ledger: SpendLedger, workspaceId: string, g: SpendGuard, now: number, pausedDir: string | null): SpendLedger {
  return {
    ...ledger,
    // A trip implies the warning: no warn toast later the same day for the same budget.
    warned: { ...ledger.warned, [workspaceId]: { day: dayKey(now), budget: g.budgetUsd } },
    tripped: { ...ledger.tripped, [workspaceId]: { day: dayKey(now), budget: g.budgetUsd, pausedDir } },
  };
}

export function markResumed(ledger: SpendLedger, workspaceId: string, g: SpendGuard, now: number): SpendLedger {
  return { ...ledger, resumed: { ...ledger.resumed, [workspaceId]: { day: dayKey(now), budget: g.budgetUsd } } };
}

/** The persistent banner of a workspace: shown while today's budget is used up and the user hasn't resumed. */
export function bannerFor(ledger: SpendLedger | null, workspaceId: string, spent: number, g: SpendGuard | null, now: number): TripMark | null {
  if (!ledger || !g || guardLevel(spent, g) !== "over") return null;
  const day = dayKey(now);
  const t = ledger.tripped[workspaceId];
  if (!t || t.day !== day || sameMark(ledger.resumed[workspaceId], day, g)) return null;
  return t;
}

/** A budget step up from `spent`: 1.5x, rounded up to a whole dollar (at least $1 more than now). */
export function suggestRaise(spent: number, g: SpendGuard): number {
  return Math.max(Math.ceil(Math.max(spent, g.budgetUsd) * 1.5), Math.ceil(g.budgetUsd) + 1);
}

export function formatUsd(usd: number): string {
  if (!isNum(usd) || usd <= 0) return "$0.00";
  if (usd < 0.01) return "<$0.01";
  if (usd < 1000) return `$${usd.toFixed(2)}`;
  return `$${(usd / 1000).toFixed(1).replace(/\.0$/, "")}k`;
}

/** Budget text: whole dollars without cents. */
export function formatBudget(usd: number): string {
  return Number.isInteger(usd) ? `$${usd}` : formatUsd(usd);
}

/** `today ~$4.20 / $10` (no guard: `today ~$4.20`). */
export function todayLabel(spent: number, g: SpendGuard | null): string {
  return g ? `today ~${formatUsd(spent)} / ${formatBudget(g.budgetUsd)}` : `today ~${formatUsd(spent)}`;
}
