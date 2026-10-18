// Cost & context meter per pane (Claude Code status line data, pushed by Rust as `session-meter`).
// Event driven only: one snapshot at start, then events. No polling.

import { create } from "zustand";
import { ipc, onSessionMeter } from "../lib/ipc";
import type { SessionId, SessionMeter } from "../lib/types";

interface MeterStore {
  bySession: Record<SessionId, SessionMeter>;
}

export const useMeter = create<MeterStore>()(() => ({ bySession: {} }));

export function applyMeter(m: SessionMeter): void {
  useMeter.setState((s) => ({ bySession: { ...s.bySession, [m.sessionId]: m } }));
}

/** Install once (Shell): subscribe first, then merge the snapshot without overwriting newer events. */
export function installMeterWatch(): () => void {
  let disposed = false;
  let off: (() => void) | null = null;
  void onSessionMeter(applyMeter).then((f) => (disposed ? f() : (off = f)));
  void ipc
    .meterSnapshot()
    .then((list) => {
      if (disposed) return;
      useMeter.setState((s) => {
        const next = { ...s.bySession };
        for (const m of list) {
          const cur = next[m.sessionId];
          // An event that already arrived is at least as new as the snapshot unless the snapshot has newer data.
          if (!cur || (cur.updatedMs ?? 0) < (m.updatedMs ?? 0)) next[m.sessionId] = m;
        }
        return { bySession: next };
      });
    })
    .catch(() => {});
  return () => {
    disposed = true;
    off?.();
  };
}
