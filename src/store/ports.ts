// Listening TCP ports per session ("Ports"). Never polled constantly:
// - a 3 s poll runs only while a view that shows ports holds it (browser start page, Inspector);
// - otherwise one refresh (throttled) after a session's activity changes (attention idle / active)
//   or a session starts / exits — dev servers usually print "ready" and go quiet right after.

import { useEffect } from "react";
import { create } from "zustand";
import { errorMessage, ipc, onSessionAttention, onSessionState } from "../lib/ipc";
import type { SessionId, SessionPort } from "../lib/types";

interface PortsStore {
  bySession: Record<SessionId, SessionPort[]>;
  error: string | null;
  at: number;
}

export const usePorts = create<PortsStore>()(() => ({ bySession: {}, error: null, at: 0 }));

let inflight = false;
let again = false;

function samePorts(a: SessionPort[] | undefined, b: SessionPort[] | undefined): boolean {
  if (!a || !b) return a === b;
  return a.length === b.length && a.every((p, i) => p.port === b[i].port && p.pid === b[i].pid);
}

export async function refreshPorts(): Promise<void> {
  if (inflight) {
    again = true;
    return;
  }
  inflight = true;
  try {
    const list = await ipc.portsList();
    const prev = usePorts.getState().bySession;
    const next: Record<SessionId, SessionPort[]> = {};
    for (const s of list) next[s.id] = samePorts(prev[s.id], s.ports) ? prev[s.id] : s.ports;
    const changed = Object.keys(prev).length !== Object.keys(next).length || Object.keys(next).some((k) => next[k] !== prev[k]);
    usePorts.setState({ bySession: changed ? next : prev, error: null, at: Date.now() });
  } catch (e) {
    usePorts.setState({ error: errorMessage(e) });
  } finally {
    inflight = false;
    if (again) {
      again = false;
      void refreshPorts();
    }
  }
}

// ---- holder-counted poll (same pattern as the diagnostics poller) ----------------------------

const POLL_MS = 3000;
let holders = 0;
let timer: number | undefined;

export function acquirePortsPoll(): () => void {
  holders++;
  if (holders === 1) {
    void refreshPorts();
    timer = window.setInterval(() => void refreshPorts(), POLL_MS);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holders--;
    if (holders === 0) {
      window.clearInterval(timer);
      timer = undefined;
    }
  };
}

/** Hold the ports poll while `want` and the window is visible. */
export function usePortsPoll(want: boolean) {
  useEffect(() => {
    if (!want) return;
    let release: (() => void) | null = null;
    const sync = () => {
      const visible = document.visibilityState === "visible";
      if (visible && !release) release = acquirePortsPoll();
      else if (!visible && release) {
        release();
        release = null;
      }
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => {
      document.removeEventListener("visibilitychange", sync);
      release?.();
    };
  }, [want]);
}

// ---- event-driven refresh --------------------------------------------------------------------

const THROTTLE_MS = 2500;
let lastEventRefresh = 0;
let eventTimer: number | undefined;

/** One refresh soon after an activity change; at most one per THROTTLE_MS; skipped while polling. */
export function scheduleEventRefresh() {
  if (holders > 0 || eventTimer !== undefined) return;
  const wait = Math.max(800, THROTTLE_MS - (Date.now() - lastEventRefresh));
  eventTimer = window.setTimeout(() => {
    eventTimer = undefined;
    lastEventRefresh = Date.now();
    void refreshPorts();
  }, wait);
}

/** Install once (Shell). */
export function installPortsWatch(): () => void {
  let disposed = false;
  const offs: (() => void)[] = [];
  void onSessionAttention((ev) => {
    if (ev.kind === "idle" || ev.kind === "active") scheduleEventRefresh();
  }).then((off) => (disposed ? off() : offs.push(off)));
  void onSessionState((info) => {
    const st = info.state.state;
    if (st === "exited" || st === "failed") {
      const cur = usePorts.getState().bySession;
      if (cur[info.id]) {
        const { [info.id]: _, ...rest } = cur;
        usePorts.setState({ bySession: rest });
      }
    } else if (st === "running") scheduleEventRefresh();
  }).then((off) => (disposed ? off() : offs.push(off)));
  return () => {
    disposed = true;
    offs.forEach((f) => f());
    window.clearTimeout(eventTimer);
    eventTimer = undefined;
  };
}
