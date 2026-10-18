// WebGL context budget allocator (pure).
//
// Chromium allows at most 16 live WebGL contexts per renderer process and silently kills the oldest
// beyond that. We cap ourselves well below (MAX_WEBGL) and give the remaining terminals the DOM renderer.
// The allocator is stable: terminals that already hold a context keep it (no thrash when another
// terminal becomes visible); free slots go to the highest-priority candidates.

import { OS, type Os } from "../lib/platform";

/**
 * Context budget per platform. Windows (WebView2 / Chromium, measured): 12 of Chromium's 16.
 * macOS (WKWebView) and Linux (WebKitGTK) are UNVERIFIED: WebKit's own cap is also 16 active contexts
 * per page, but WebKitGTK often runs on weaker GL stacks (software / DMABUF fallbacks), so Linux starts
 * lower. Re-measure both on real hardware (context loss count in Diagnostics) and adjust.
 */
export function maxWebglFor(os: Os): number {
  if (os === "linux") return 8;
  return 12;
}

export const MAX_WEBGL = maxWebglFor(OS);

export interface WebglCandidate {
  id: string;
  /** Currently holds a WebGL context. */
  active: boolean;
  /** Higher wins when competing for a free slot (e.g. focused terminal, most recently shown). */
  priority: number;
}

/** Returns the ids that should hold a WebGL context. `candidates` = terminals that WANT WebGL. */
export function allocateWebgl(candidates: readonly WebglCandidate[], max = MAX_WEBGL): Set<string> {
  const out = new Set<string>();
  if (max <= 0) return out;
  const byPriority = [...candidates].sort((a, b) => b.priority - a.priority);
  for (const c of byPriority) {
    if (out.size >= max) break;
    if (c.active) out.add(c.id);
  }
  for (const c of byPriority) {
    if (out.size >= max) break;
    if (!c.active) out.add(c.id);
  }
  return out;
}

/** Diff a target allocation against the current one. */
export function diffAllocation(
  current: ReadonlySet<string>,
  target: ReadonlySet<string>,
): { grant: string[]; revoke: string[] } {
  const grant: string[] = [];
  const revoke: string[] = [];
  for (const id of target) if (!current.has(id)) grant.push(id);
  for (const id of current) if (!target.has(id)) revoke.push(id);
  return { grant, revoke };
}
