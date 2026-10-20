// Agent browser UI state: the host's state (agent-browser-state events), a per-session action log
// (agent-browser-activity events), the view's open / selection state. Actions on the host go through
// `agentBrowserIpc` only. Browser actions are also recorded in the session activity log (Mission
// Control) — page reads (snapshots, console, network, screenshots) only in this view's log.

import { create } from "zustand";
import { notify } from "../../actions/notify";
import { startSession } from "../../actions/sessions";
import { agentBrowserIpc, errorMessage, onAgentBrowserActivity, onAgentBrowserState } from "../../lib/ipc";
import type { AgentBrowserActivity, AgentBrowserOutcome, AgentBrowserSession, AgentBrowserState, AgentKind, SessionId } from "../../lib/types";
import { recordActivity, sessionLabelOf, type ActivityLevel } from "../../store/activity";

export const LOG_LIMIT = 150;

export type ViewMode = "grid" | "focus";

interface AgentBrowserStore {
  open: boolean;
  mode: ViewMode;
  selected: SessionId | null;
  state: AgentBrowserState | null;
  log: Record<SessionId, AgentBrowserActivity[]>;
}

export const useAgentBrowser = create<AgentBrowserStore>()(() => ({ open: false, mode: "grid", selected: null, state: null, log: {} }));

/** Agents that get the browser injected at launch (others: manual MCP setup, see README). */
export function isBrowserCapable(agent: AgentKind | null | undefined): boolean {
  return agent === "claude" || agent === "codex";
}

export function openAgentBrowser(sessionId?: SessionId) {
  useAgentBrowser.setState(sessionId ? { open: true, selected: sessionId, mode: "focus" } : { open: true });
}

export function closeAgentBrowser() {
  useAgentBrowser.setState({ open: false });
}

export function toggleAgentBrowser() {
  if (useAgentBrowser.getState().open) closeAgentBrowser();
  else openAgentBrowser();
}

export function focusSession(id: SessionId) {
  useAgentBrowser.setState({ selected: id, mode: "focus" });
}

export function showGrid() {
  useAgentBrowser.setState({ mode: "grid" });
}

/** Append to a per-session ring (newest last). Pure. */
export function pushLog(log: Record<SessionId, AgentBrowserActivity[]>, ev: AgentBrowserActivity, limit = LOG_LIMIT): Record<SessionId, AgentBrowserActivity[]> {
  const prev = log[ev.sessionId] ?? [];
  const next = prev.length >= limit ? prev.slice(prev.length - limit + 1) : prev.slice();
  next.push(ev);
  return { ...log, [ev.sessionId]: next };
}

const PAGE_READS = new Set(["browser_snapshot", "browser_console_messages", "browser_network_requests", "browser_take_screenshot", "browser_wait_for"]);

/** Whether an event belongs in the session activity log (actions and decisions, not page reads). */
export function isLoggedAction(ev: AgentBrowserActivity): boolean {
  return !(PAGE_READS.has(ev.tool) && ev.outcome === "ok");
}

export function activityLevel(ev: AgentBrowserActivity): ActivityLevel {
  if (ev.tool === "confirm") return "needs";
  const map: Record<AgentBrowserOutcome, ActivityLevel> = { ok: "info", info: "info", error: "error", blocked: "error", denied: "info" };
  return map[ev.outcome];
}

export function sessionRow(state: AgentBrowserState | null, id: SessionId): AgentBrowserSession | undefined {
  return state?.sessions.find((s) => s.sessionId === id);
}

/** Whether the opt-in differs from what the running process got (a restart applies it). */
export function needsRestart(row: AgentBrowserSession | undefined, live: boolean): boolean {
  if (!row || !live) return false;
  return row.enabled !== row.launched;
}

function applyState(s: AgentBrowserState) {
  useAgentBrowser.setState((cur) => {
    // Keep the selection valid.
    const selected = cur.selected && s.sessions.some((r) => r.sessionId === cur.selected) ? cur.selected : (s.sessions.find((r) => r.hasTab)?.sessionId ?? cur.selected);
    return { state: s, selected };
  });
}

/** Subscribe to the host's events (call once, at app level). */
export function installAgentBrowserWatch(): () => void {
  let disposed = false;
  const offs: (() => void)[] = [];
  void onAgentBrowserState((s) => applyState(s)).then((off) => (disposed ? off() : offs.push(off)));
  void onAgentBrowserActivity((ev) => {
    useAgentBrowser.setState((cur) => ({ log: pushLog(cur.log, ev) }));
    if (isLoggedAction(ev)) {
      const l = sessionLabelOf(ev.sessionId);
      recordActivity({
        sessionId: ev.sessionId,
        sessionName: l.name,
        role: l.role,
        agent: l.agent,
        kind: "browser",
        level: activityLevel(ev),
        message: `browser: ${ev.summary}`,
        result: ev.outcome === "ok" ? ev.tool.replace(/^browser_/, "") : ev.outcome,
        at: ev.atMs,
      });
    }
  }).then((off) => (disposed ? off() : offs.push(off)));
  agentBrowserIpc
    .state()
    .then((s) => applyState(s))
    .catch(() => {});
  return () => {
    disposed = true;
    for (const off of offs) off();
  };
}

async function run(what: string, p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    notify("error", `${what}: ${errorMessage(e)}`);
  }
}

export function setBrowserEnabled(id: SessionId, enabled: boolean) {
  return run("Agent browser", agentBrowserIpc.setSession(id, enabled));
}

/** New session with a browser: opt in first, then start (the launch reads the opt-in). */
export async function startWithBrowser(id: SessionId) {
  try {
    await agentBrowserIpc.setSession(id, true);
  } catch (e) {
    notify("warn", `Agent browser: ${errorMessage(e)}. Starting without it.`);
  }
  await startSession(id, { mode: "none" });
}

export const takeOver = (id: SessionId, on: boolean) => run("Take over", agentBrowserIpc.takeOver(id, on));
export const setStopped = (id: SessionId, stopped: boolean) => run("Agent browser", agentBrowserIpc.setStopped(id, stopped));
export const answerPrompt = (promptId: number, allow: boolean, remember = false) => run("Agent browser", agentBrowserIpc.answer(promptId, allow, remember));
export const stopBrowser = () => run("Close browser", agentBrowserIpc.stopBrowser());
export const saveAllowlist = (entries: string[]) => run("Allowlist", agentBrowserIpc.setAllowlist(entries));
export const saveIdleMinutes = (m: number) => run("Idle timeout", agentBrowserIpc.setIdleMinutes(m));
export const sendInput = (id: SessionId, ev: Parameters<typeof agentBrowserIpc.input>[1]) => agentBrowserIpc.input(id, ev).catch(() => {});
