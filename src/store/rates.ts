// Output-rate sampler for Mission Control. While (and only while) a consumer holds it, polls
// `session_list` once per second (self-rescheduling timeout, never overlapping, skipped while the window
// is hidden) and keeps per-session byte-rate history (bytes/s, last RATE_HISTORY samples) in memory.
// Rates are derived from the real `bytesOut` counter; this is terminal output volume, NOT tokens.

import { create } from "zustand";
import { ipc } from "../lib/ipc";
import type { SessionId, SessionInfo } from "../lib/types";

export const RATE_HISTORY = 120;
export const RATE_INTERVAL_MS = 1000;

export interface ByteSample {
  bytes: number;
  startedAt: string | null;
  /** ms epoch when sampled */
  t: number;
}

/**
 * Bytes per second between two samples of a session's `bytesOut` counter. Pure.
 * A restart (different `startedAt`) or a counter that went backwards is a reset: every byte counted
 * since the restart arrived within the interval, so the rate is `next.bytes / dt`.
 * Returns null when there is no previous sample or no time has passed.
 */
export function computeRate(prev: ByteSample | undefined, next: ByteSample): number | null {
  if (!prev) return null;
  const dt = (next.t - prev.t) / 1000;
  if (!(dt > 0)) return null;
  const reset = next.startedAt !== prev.startedAt || next.bytes < prev.bytes;
  const delta = reset ? next.bytes : next.bytes - prev.bytes;
  return Math.max(0, delta) / dt;
}

export interface RateState {
  /** Per session: bytes/s history, oldest first, at most RATE_HISTORY entries. */
  hist: Record<SessionId, number[]>;
  last: Record<SessionId, ByteSample>;
  /** ms epoch of the last successful sample (null until the first). */
  sampledAt: number | null;
}

/** Fold one `session_list` result into the rate state. Pure (returns a new state). */
export function applySamples(state: RateState, list: Pick<SessionInfo, "id" | "bytesOut" | "startedAt">[], t: number, limit = RATE_HISTORY): RateState {
  const hist: Record<SessionId, number[]> = {};
  const last: Record<SessionId, ByteSample> = {};
  for (const info of list) {
    const sample: ByteSample = { bytes: info.bytesOut, startedAt: info.startedAt, t };
    const rate = computeRate(state.last[info.id], sample);
    const prevHist = state.hist[info.id] ?? [];
    hist[info.id] = rate === null ? prevHist : [...prevHist.slice(Math.max(0, prevHist.length - limit + 1)), rate];
    last[info.id] = sample;
  }
  // Sessions no longer listed (removed) are dropped.
  return { hist, last, sampledAt: t };
}

/** Latest rate of a session (bytes/s), or null when unknown. */
export function latestRate(hist: number[] | undefined): number | null {
  return hist && hist.length ? hist[hist.length - 1] : null;
}

export function formatRate(bytesPerSec: number | null): string {
  if (bytesPerSec === null) return "—";
  const kb = bytesPerSec / 1024;
  if (kb < 0.05) return "0 KB/s";
  if (kb < 10) return `${kb.toFixed(1)} KB/s`;
  if (kb < 1024) return `${Math.round(kb)} KB/s`;
  return `${(kb / 1024).toFixed(1)} MB/s`;
}

export const useRates = create<RateState>()(() => ({ hist: {}, last: {}, sampledAt: null }));

// ---- sampler (acquire / release) -------------------------------------------------------

let holders = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let inflight = false;
/** Bumped on every start / stop so a tick from an earlier run never reschedules itself. */
let generation = 0;

async function tick(gen: number) {
  timer = undefined;
  if (gen !== generation || holders === 0) return;
  const hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
  if (!hidden && !inflight) {
    inflight = true;
    try {
      const list = await ipc.sessionList();
      if (gen === generation) useRates.setState((s) => applySamples(s, list, Date.now()));
    } catch {
      /* backend unavailable: keep the last history */
    } finally {
      inflight = false;
    }
  }
  if (gen === generation && holders > 0) timer = setTimeout(() => void tick(gen), RATE_INTERVAL_MS);
}

/** Start sampling while held. Returns an idempotent release; the last release stops the timer. */
export function acquireRateSampler(): () => void {
  holders++;
  if (holders === 1) {
    // Fresh history per open: a rate spanning the closed interval would fake a 1-second sample.
    useRates.setState({ hist: {}, last: {}, sampledAt: null });
    void tick(++generation);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holders--;
    if (holders === 0) {
      generation++;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    }
  };
}

/** Test hook: whether a sampling timer is currently scheduled or running. */
export function isRateSamplerRunning(): boolean {
  return holders > 0 || timer !== undefined;
}
