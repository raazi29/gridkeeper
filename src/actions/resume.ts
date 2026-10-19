// Sleep / long-absence recovery, event-driven (no timers, no polling).
//
// The window timestamps when it goes away (hidden or blurred) and, when it becomes visible or focused
// again after more than 60 s of wall-clock time, assumes the PC may have slept:
//   - refits and repaints every visible terminal (and re-sends PTY sizes),
//   - re-syncs session runtime state from the backend (ipc.sessionList),
//   - re-runs agent detection lazily (only if it never succeeded).
//
// What this does NOT cover, honestly:
//   - Session processes survive sleep on their own (ConPTY + job objects); nothing to restart.
//   - Network-bound agents (Claude Code, Codex) may need to retry their own requests after resume.
//   - A lid close while the window stays "visible" and focused may fire neither event; the next
//     focus change then triggers the resync. Lost WebGL contexts are handled by the registry itself.

import { ipc } from "../lib/ipc";
import { isLongGap } from "../lib/clockGap";
import { useApp } from "../store/appStore";
import { refitAllTerminals } from "../terminal/registry";

let lastAway = Date.now();
let syncing = false;

async function resync() {
  if (syncing) return;
  syncing = true;
  try {
    refitAllTerminals();
    for (const info of await ipc.sessionList().catch(() => [])) useApp.getState().setRuntime(info);
    if (useApp.getState().agents.length === 0) {
      ipc.agentsDetect().then((a) => useApp.getState().setAgents(a)).catch(() => {});
    }
    void ipc.log("info", "[resume] window back after a long absence: terminals refit, runtime re-synced");
  } finally {
    syncing = false;
  }
}

/** Install once (Shell). Returns an uninstall function. */
export function installResumeWatch(): () => void {
  const away = () => {
    lastAway = Date.now();
  };
  const back = () => {
    const now = Date.now();
    const long = isLongGap(lastAway, now);
    lastAway = now;
    if (long) void resync();
  };
  const onVisibility = () => (document.visibilityState === "visible" ? back() : away());
  document.addEventListener("visibilitychange", onVisibility);
  const onBlur = () => document.hasFocus() || away(); // focus moving into a browser-pane iframe is not "away"
  window.addEventListener("blur", onBlur);
  window.addEventListener("focus", back);
  return () => {
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("blur", onBlur);
    window.removeEventListener("focus", back);
  };
}
