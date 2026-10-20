// Mission Control timeline, pure (unit-tested): state segments per agent from the recorded state history, the
// visible time range (zoom around a moment, pan, follow "now") and readable tick marks.

import type { HistoryEntry, HistoryState } from "../../store/stateHistory";

export interface Segment {
  state: HistoryState;
  from: number;
  to: number;
}

export interface TimeRange {
  from: number;
  to: number;
}

/** Narrowest and widest visible span. */
export const SPAN_MIN = 30_000;
export const SPAN_MAX = 12 * 3600_000;
export const RANGE_PRESETS: readonly { label: string; ms: number }[] = [
  { label: "5m", ms: 5 * 60_000 },
  { label: "15m", ms: 15 * 60_000 },
  { label: "1h", ms: 3600_000 },
  { label: "4h", ms: 4 * 3600_000 },
];

/**
 * Segments clipped to [from, to]: each entry's state lasts until the next entry (the last one until `now`).
 * Nothing before the first entry (unknown). Adjacent equal states merge; empty pieces are dropped.
 */
export function segmentsFor(entries: readonly HistoryEntry[], from: number, to: number, now: number): Segment[] {
  const out: Segment[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const end = Math.min(i + 1 < entries.length ? entries[i + 1].at : now, now);
    const a = Math.max(e.at, from);
    const b = Math.min(end, to);
    if (b <= a) continue;
    const prev = out[out.length - 1];
    if (prev && prev.state === e.state && prev.to >= a - 1) prev.to = b;
    else out.push({ state: e.state, from: a, to: b });
  }
  return out;
}

/** Total ms per state inside the range (for the row summary). */
export function stateTotals(segs: readonly Segment[]): Partial<Record<HistoryState, number>> {
  const t: Partial<Record<HistoryState, number>> = {};
  for (const s of segs) t[s.state] = (t[s.state] ?? 0) + (s.to - s.from);
  return t;
}

function clampSpan(span: number): number {
  return Math.min(SPAN_MAX, Math.max(SPAN_MIN, span));
}

/** Zoom by `factor` (< 1 zooms in) keeping moment `at` at the same place on screen. */
export function zoomRange(r: TimeRange, factor: number, at: number): TimeRange {
  const span = r.to - r.from;
  const next = clampSpan(span * factor);
  const f = span > 0 ? (at - r.from) / span : 1;
  const from = at - f * next;
  return { from: Math.round(from), to: Math.round(from + next) };
}

/** Shift by `dt` ms, never past `now` on the right. */
export function panRange(r: TimeRange, dt: number, now: number): TimeRange {
  const span = r.to - r.from;
  const to = Math.min(now, r.to + dt);
  return { from: to - span, to };
}

/** A range of `span` ending now. */
export function liveRange(span: number, now: number): TimeRange {
  return { from: now - clampSpan(span), to: now };
}

const STEPS = [5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600].map((s) => s * 1000);

/** Tick step so that at most `maxTicks` fit. */
export function tickStep(span: number, maxTicks: number): number {
  return STEPS.find((s) => span / s <= Math.max(1, maxTicks)) ?? STEPS[STEPS.length - 1];
}

/** Tick moments in the range (aligned to the local clock for steps of a minute or more). */
export function ticks(r: TimeRange, maxTicks: number, tzOffsetMin = new Date(r.from).getTimezoneOffset()): { t: number; step: number }[] {
  const step = tickStep(r.to - r.from, maxTicks);
  const shift = step >= 60_000 ? -tzOffsetMin * 60_000 : 0;
  const first = Math.ceil((r.from + shift) / step) * step - shift;
  const out: { t: number; step: number }[] = [];
  for (let t = first; t <= r.to && out.length < 200; t += step) out.push({ t, step });
  return out;
}

/** "14:05" for minute steps, "14:05:30" for second steps. */
export function tickLabel(t: number, step: number): string {
  const d = new Date(t);
  const two = (n: number) => String(n).padStart(2, "0");
  const hm = `${two(d.getHours())}:${two(d.getMinutes())}`;
  return step < 60_000 ? `${hm}:${two(d.getSeconds())}` : hm;
}

/** Fraction (0..1, unclamped) of moment `t` across the range. */
export function frac(r: TimeRange, t: number): number {
  const span = r.to - r.from;
  return span > 0 ? (t - r.from) / span : 0;
}
