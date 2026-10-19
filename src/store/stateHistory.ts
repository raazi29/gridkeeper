// State history per session for Mission Control's timeline: every change of what a session is doing (working /
// waiting for you / done / idle / error / not running) since the app started, plus moments worth marking (a task
// turned done). In memory only, bounded per session. `installStateHistory()` subscribes to the app and attention
// stores (no timers) and is called once at app level (MissionLayer); pure helpers are unit-tested.

import { create } from "zustand";
import type { SessionId, SessionInfo } from "../lib/types";
import { useApp } from "./appStore";
import { useAttention, type SessionAttn } from "./attention";

export type HistoryState = "working" | "waiting" | "done" | "idle" | "error" | "off";

export interface HistoryEntry {
  at: number;
  state: HistoryState;
}

export interface HistoryMark {
  at: number;
  sessionId: SessionId;
  kind: "task";
  label: string;
}

/** Entries kept per session (oldest dropped first). */
export const HISTORY_LIMIT = 400;
export const MARK_LIMIT = 300;

const LIVE = new Set(["running", "starting", "stopping"]);

/** What the timeline shows for a session right now. Pure. */
export function historyState(rt: SessionInfo | undefined, a: SessionAttn | undefined): HistoryState {
  if (!rt) return "off";
  const st = rt.state.state;
  if (st === "failed") return "error";
  if (st === "exited") return rt.state.code !== null && rt.state.code !== 0 ? "error" : "off";
  if (!LIVE.has(st)) return "off";
  return a?.state ?? "idle";
}

/** Append when the state changed (a change at the same moment replaces the last entry). Pure; returns `list` when unchanged. */
export function pushEntry(list: readonly HistoryEntry[], e: HistoryEntry, limit = HISTORY_LIMIT): readonly HistoryEntry[] {
  const last = list[list.length - 1];
  if (last && last.state === e.state) return list;
  const at = last ? Math.max(e.at, last.at) : e.at;
  if (last && at === last.at) {
    const base = list.slice(0, -1);
    const prev = base[base.length - 1];
    return prev && prev.state === e.state ? base : [...base, { at, state: e.state }];
  }
  const out = [...list, { at, state: e.state }];
  return out.length > limit ? out.slice(out.length - limit) : out;
}

interface HistoryStore {
  bySession: Record<SessionId, readonly HistoryEntry[]>;
  marks: readonly HistoryMark[];
}

export const useStateHistory = create<HistoryStore>()(() => ({ bySession: {}, marks: [] }));

export function recordState(id: SessionId, state: HistoryState, at = Date.now()): void {
  const cur = useStateHistory.getState().bySession[id] ?? [];
  const next = pushEntry(cur, { at, state });
  if (next !== cur) useStateHistory.setState((s) => ({ bySession: { ...s.bySession, [id]: next } }));
}

export function recordMark(m: HistoryMark): void {
  useStateHistory.setState((s) => {
    const marks = [...s.marks, m];
    return { marks: marks.length > MARK_LIMIT ? marks.slice(marks.length - MARK_LIMIT) : marks };
  });
}

/** Subscribe to the app + attention stores. Returns a full cleanup. Call once. */
export function installStateHistory(): () => void {
  const seen = new Map<SessionId, HistoryState>();
  const sync = () => {
    const rt = useApp.getState().runtime;
    const attn = useAttention.getState().sessions;
    for (const id in rt) {
      const st = historyState(rt[id], attn[id]);
      if (seen.get(id) === st) continue;
      const first = !seen.has(id);
      seen.set(id, st);
      if (first) {
        // Seed: running since its start (idle), then its current state since the last attention change.
        const started = rt[id].startedAt ? Date.parse(rt[id].startedAt as string) : NaN;
        const a = attn[id];
        if (!Number.isNaN(started) && st !== "off") {
          recordState(id, "idle", started);
          if (st !== "idle") recordState(id, st, a && a.at > started ? a.at : started);
          continue;
        }
      }
      recordState(id, st);
    }
    for (const id of [...seen.keys()]) if (!rt[id]) seen.delete(id);
  };
  sync();
  let prevRt = useApp.getState().runtime;
  const offApp = useApp.subscribe((s) => {
    if (s.runtime === prevRt) return;
    prevRt = s.runtime;
    sync();
  });
  const offAttn = useAttention.subscribe((s, p) => {
    if (s.sessions !== p.sessions) sync();
  });
  return () => {
    offApp();
    offAttn();
  };
}
