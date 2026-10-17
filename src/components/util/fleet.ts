// Pure helpers for the Fleet overview (unit-tested).

import type { SessionInfo } from "../../lib/types";
import { needsAttention, type SessionAttn } from "../../store/attention";

export type FleetLamp = "working" | "waiting" | "done" | "error" | "idle" | "exited" | "stopped";
export type FleetFilter = "all" | "needs" | "working" | "errors";

const isLiveInfo = (r?: SessionInfo) => !!r && (r.state.state === "running" || r.state.state === "starting" || r.state.state === "stopping");

/** Tile lamp from process state + attention state. */
export function fleetLamp(rt: SessionInfo | undefined, a: SessionAttn | undefined): FleetLamp {
  if (!rt) return "stopped";
  if (rt.state.state === "failed") return "error";
  if (rt.state.state === "exited") {
    if (rt.state.code !== null && rt.state.code !== 0) return "error";
    return a?.unread && a.state === "done" ? "done" : "exited";
  }
  return a?.state ?? "idle";
}

export function matchesFleetFilter(filter: FleetFilter, rt: SessionInfo | undefined, a: SessionAttn | undefined): boolean {
  switch (filter) {
    case "all":
      return true;
    case "needs":
      return needsAttention(a);
    case "working":
      return isLiveInfo(rt) && a?.state === "working";
    case "errors":
      return fleetLamp(rt, a) === "error";
  }
}

/** Last `n` non-blank lines of plain text, right-trimmed and capped in width. */
export function tailLines(text: string, n = 3, width = 160): string[] {
  const out: string[] = [];
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0 && out.length < n; i--) {
    const l = lines[i].replace(/\s+$/, "");
    if (l.trim()) out.unshift(l.length > width ? `${l.slice(0, width - 1)}…` : l);
  }
  return out;
}

export function formatUptime(startedAt: string | null | undefined, endedAt: string | null | undefined, now: number): string {
  if (!startedAt) return "";
  const start = Date.parse(startedAt);
  if (Number.isNaN(start)) return "";
  const end = endedAt ? Date.parse(endedAt) : now;
  const s = Math.max(0, Math.floor(((Number.isNaN(end) ? now : end) - start) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}
