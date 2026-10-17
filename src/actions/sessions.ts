// Session lifecycle actions: the only place that turns user intent into session_* IPC calls.

import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { errorMessage, ipc } from "../lib/ipc";
import type { AgentKind, ResumeMode, SessionId, SessionMeta, SessionSpec, WorktreeRef } from "../lib/types";
import { isLive, uid, useApp } from "../store/appStore";
import { clearTerminal, getTerminalSize } from "../terminal/registry";
import { notify } from "./notify";

const AGENT_LABEL: Record<AgentKind, string> = {
  powershell: "PowerShell",
  claude: "Claude Code",
  codex: "Codex",
  generic: "Command",
};

export function defaultResume(agent: AgentKind): ResumeMode {
  if (agent === "claude") return { mode: "continue" }; // resolved to the pinned id when one exists
  if (agent === "codex") return { mode: "continue" };
  return { mode: "none" };
}

export interface NewSessionOptions {
  groupId: string;
  agent: AgentKind;
  cwd: string;
  name?: string;
  profileId?: string | null;
  command?: string | null;
  args?: string[];
  worktree?: WorktreeRef | null;
  start?: boolean;
}

export function newSession(o: NewSessionOptions): SessionId {
  const s = useApp.getState();
  const count = s.persisted.sessions.filter((m) => m.agent === o.agent).length + 1;
  const meta: SessionMeta = {
    id: uid(),
    name: o.name?.trim() || `${AGENT_LABEL[o.agent]} ${count}`,
    agent: o.agent,
    cwd: o.worktree?.path ?? o.cwd,
    profileId: o.agent === "claude" ? (o.profileId ?? null) : null,
    command: o.command ?? null,
    args: o.args ?? [],
    env: [],
    autoStart: true,
    resumeOnRestore: defaultResume(o.agent),
    agentSessionId: null,
    worktree: o.worktree ?? null,
    createdAt: new Date().toISOString(),
    lastExitCode: null,
  };
  s.addSessionMeta(o.groupId, meta);
  s.setFocused(meta.id);
  if (o.start !== false) void startSession(meta.id, { mode: "none" });
  return meta.id;
}

/**
 * Start (or restart after exit) the process for a session.
 * `resume`: none = fresh conversation; continue = resume pinned conversation (Claude) / most recent (Codex).
 */
// Launches of the same agent kind are spaced out: several agent CLIs starting in the same instant
// contend on shared per-user state (update checks, daemons, config files). Observed once with Codex 0.162
// (one of six simultaneous launches never produced output). Different kinds still start in parallel.
const LAUNCH_GAP_MS: Record<AgentKind, number> = { powershell: 0, claude: 350, codex: 600, generic: 0 };
const nextLaunchAt: Partial<Record<AgentKind, number>> = {};

async function launchSlot(agent: AgentKind) {
  const gap = LAUNCH_GAP_MS[agent];
  if (!gap) return;
  const now = Date.now();
  const at = Math.max(now, nextLaunchAt[agent] ?? 0);
  nextLaunchAt[agent] = at + gap;
  if (at > now) await new Promise((r) => setTimeout(r, at - now));
}

export async function startSession(id: SessionId, resume: ResumeMode = { mode: "none" }): Promise<boolean> {
  const meta0 = useApp.getState().persisted.sessions.find((m) => m.id === id);
  if (!meta0) return false;
  if (isLive(useApp.getState().runtime[id])) return true;
  await launchSlot(meta0.agent);
  const st = useApp.getState();
  const meta = st.persisted.sessions.find((m) => m.id === id);
  if (!meta) return false;
  if (isLive(st.runtime[id])) return true;

  const size = getTerminalSize(id) ?? { cols: 120, rows: 32 };
  let agentSessionId: string | null = null;
  let effectiveResume = resume;
  if (meta.agent === "claude") {
    if (resume.mode === "continue" && meta.agentSessionId) {
      // Resume the exact conversation this pane owns (falls back to a fresh pinned id in Rust if absent).
      effectiveResume = { mode: "session", id: meta.agentSessionId };
    } else if (resume.mode === "none" || !meta.agentSessionId) {
      agentSessionId = crypto.randomUUID();
      effectiveResume = { mode: "none" };
      st.updateSessionMeta(id, { agentSessionId });
    }
  }

  const spec: SessionSpec = {
    id,
    name: meta.name,
    agent: meta.agent,
    cwd: meta.cwd,
    profileId: meta.profileId,
    command: meta.command,
    args: meta.args,
    env: meta.env,
    resume: effectiveResume,
    agentSessionId,
    cols: size.cols,
    rows: size.rows,
  };
  // Optimistic state so the pane shows "starting" immediately.
  st.setRuntime({
    id,
    name: meta.name,
    agent: meta.agent,
    pid: null,
    state: { state: "starting" },
    cwd: meta.cwd,
    profileId: meta.profileId,
    commandDisplay: "",
    startedAt: null,
    endedAt: null,
    bytesOut: 0,
  });
  try {
    const info = await ipc.sessionStart(spec);
    useApp.getState().setRuntime(info);
    return true;
  } catch (e) {
    const message = errorMessage(e);
    useApp.getState().setRuntime({
      ...useApp.getState().runtime[id],
      state: { state: "failed", message },
    });
    notify("error", `${meta.name}: ${message}`);
    return false;
  }
}

export async function stopSession(id: SessionId, force = false) {
  try {
    await ipc.sessionStop(id, force);
  } catch (e) {
    notify("error", errorMessage(e));
  }
}

/** Wait until the session is no longer live (or timeout). */
function waitForExit(id: SessionId, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (!isLive(useApp.getState().runtime[id])) return resolve(true);
    const t = window.setTimeout(() => {
      unsub();
      resolve(false);
    }, timeoutMs);
    const unsub = useApp.subscribe((s) => {
      if (!isLive(s.runtime[id])) {
        window.clearTimeout(t);
        unsub();
        resolve(true);
      }
    });
  });
}

export async function restartSession(id: SessionId, resume: ResumeMode = { mode: "continue" }) {
  if (isLive(useApp.getState().runtime[id])) {
    await stopSession(id, false);
    if (!(await waitForExit(id, 6000))) {
      await stopSession(id, true);
      await waitForExit(id, 3000);
    }
  }
  clearTerminal(id);
  return startSession(id, resume);
}

/** Close a pane: stops the process (caller confirms if live), forgets the session. */
export async function closeSession(id: SessionId) {
  if (isLive(useApp.getState().runtime[id])) {
    await stopSession(id, false);
    if (!(await waitForExit(id, 4000))) await stopSession(id, true);
    await waitForExit(id, 3000);
  }
  await ipc.sessionRemove(id).catch(() => {});
  useApp.getState().dropRuntime(id);
  useApp.getState().removeSessionMeta(id);
}

export function hideView(id: SessionId) {
  useApp.getState().setViewHidden(id, true);
}

export function showView(id: SessionId) {
  useApp.getState().setViewHidden(id, false);
}

export async function copyOutput(id: SessionId) {
  try {
    const text = await ipc.sessionOutputText(id);
    await writeText(text);
    notify("info", `Copied ${text.length.toLocaleString()} characters`);
  } catch (e) {
    notify("error", errorMessage(e));
  }
}

export async function clearSession(id: SessionId) {
  clearTerminal(id);
  await ipc.sessionClearBuffer(id).catch(() => {});
}

export function renameSession(id: SessionId, name: string) {
  if (name.trim()) useApp.getState().updateSessionMeta(id, { name: name.trim() });
}

/** Called once after state hydration: restart sessions that were marked auto-start. */
export async function restoreSessions() {
  const { persisted } = useApp.getState();
  const inGroups = new Set(persisted.workspaces.flatMap((w) => w.groups.flatMap((g) => g.sessionIds)));
  const toStart = persisted.sessions.filter((m) => m.autoStart && inGroups.has(m.id));
  // Stagger launches slightly so many agents don't all hit the disk/network in the same tick.
  for (const m of toStart) {
    void startSession(m.id, m.resumeOnRestore);
    await new Promise((r) => setTimeout(r, 120));
  }
}
