// Session lifecycle actions: the only place that turns user intent into session_* IPC calls.

import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { errorMessage, ipc } from "../lib/ipc";
import type { AgentKind, ResumeMode, SessionId, SessionInfo, SessionMeta, SessionSpec, WorktreeRef } from "../lib/types";
import { isLive, shouldApplyStartResult, uid, useApp } from "../store/appStore";
import { clearTerminal, getTerminalSize, writeLocalNotice } from "../terminal/registry";
import { autoStartable, isBrowserMeta } from "../lib/browserPanes";
import { dropNav, getNav } from "../browser/nav";
import { notify } from "./notify";
import { shellLabel } from "../lib/platform";
import { t } from "../i18n";

/** Default session names ("Claude Code 2"): product names stay; "Command" follows the UI language (getter). */
const AGENT_LABEL: Readonly<Record<AgentKind, string>> = {
  powershell: shellLabel(),
  claude: "Claude Code",
  codex: "Codex",
  get generic() {
    return t("sessions.defaultNameCommand");
  },
};

export function defaultResume(agent: AgentKind, presetResumes = false): ResumeMode {
  if (agent === "generic" && presetResumes) return { mode: "continue" };
  if (agent === "claude") return { mode: "continue" }; // resolved to the pinned id when one exists
  if (agent === "codex") return { mode: "continue" };
  return { mode: "none" };
}

export interface NewSessionOptions {
  groupId: string;
  agent: AgentKind;
  cwd: string;
  name?: string;
  /** Account id for the agent (Claude, Codex, or a catalog tool with account support). */
  profileId?: string | null;
  command?: string | null;
  args?: string[];
  worktree?: WorktreeRef | null;
  /** Catalog tool id (agent = "generic"), e.g. "hermes". */
  preset?: string | null;
  start?: boolean;
  /** Team role (see lib/roles.ts). */
  role?: string | null;
  /** Start on workspace restore (default true). */
  autoStart?: boolean;
  /** Resume mode on restore (default per agent). */
  resumeOnRestore?: ResumeMode;
  /** Never auto-retry this session after an early failure (e.g. a cancelled sign-in). */
  noAutoRetry?: boolean;
}

export function newSession(o: NewSessionOptions): SessionId {
  const s = useApp.getState();
  const tool = o.preset ? s.agents.find((a) => a.preset === o.preset) : undefined;
  const count = s.persisted.sessions.filter((m) => !isBrowserMeta(m) && m.agent === o.agent && (m.preset ?? null) === (o.preset ?? null)).length + 1;
  const meta: SessionMeta = {
    id: uid(),
    name: o.name?.trim() || `${tool?.label ?? AGENT_LABEL[o.agent]} ${count}`,
    agent: o.agent,
    cwd: o.worktree?.path ?? o.cwd,
    profileId: o.profileId ?? null,
    command: o.command ?? null,
    args: o.args ?? [],
    env: [],
    autoStart: o.autoStart ?? true,
    resumeOnRestore: o.resumeOnRestore ?? defaultResume(o.agent, !!tool?.supportsResume),
    preset: o.agent === "generic" ? (o.preset ?? null) : null,
    agentSessionId: null,
    worktree: o.worktree ?? null,
    createdAt: new Date().toISOString(),
    lastExitCode: null,
    role: o.role ?? null,
  };
  if (o.noAutoRetry) noAutoRetry.add(meta.id);
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

// ---- one automatic retry for agents that fail during startup ---------------------------------
// Agent CLIs occasionally die in their first seconds for reasons outside our control (observed: Codex 0.162
// "account/read failed during TUI bootstrap ... timed out" when several start at once). Such a run is retried
// once, after a pause, with the same resume mode. A user-requested stop never triggers it.
const STARTUP_FAIL_WINDOW_MS = 20_000;
const lastResume = new Map<SessionId, ResumeMode>();
const retried = new Set<SessionId>();
const userStopped = new Set<SessionId>();
/** Sessions that must never be retried automatically (sign-in panes). */
const noAutoRetry = new Set<SessionId>();

/** Called for every session-state event (App.tsx). */
export function maybeAutoRetry(info: SessionInfo) {
  if (info.state.state !== "exited" || info.state.code === 0 || info.state.code === null) return;
  const meta = useApp.getState().persisted.sessions.find((m) => m.id === info.id);
  // Agents only: Claude, Codex and catalog agent CLIs (not shells or arbitrary custom commands).
  if (!(info.agent === "claude" || info.agent === "codex" || (info.agent === "generic" && meta?.preset))) return;
  if (userStopped.delete(info.id)) return;
  if (noAutoRetry.has(info.id)) return;
  if (!info.startedAt || !info.endedAt) return;
  const upMs = Date.parse(info.endedAt) - Date.parse(info.startedAt);
  if (!(upMs >= 0 && upMs < STARTUP_FAIL_WINDOW_MS) || retried.has(info.id)) return;
  retried.add(info.id);
  // Local notice drawn in the pane only (never sent to the program), so it follows the UI language.
  writeLocalNotice(info.id, t("sessions.startupRetry", { seconds: Math.round(upMs / 1000) }));
  window.setTimeout(() => {
    const cur = useApp.getState().runtime[info.id];
    if (cur && !isLive(cur) && useApp.getState().persisted.sessions.some((m) => m.id === info.id))
      void startSession(info.id, lastResume.get(info.id) ?? { mode: "none" }, { keepRetryBudget: true });
  }, 3000);
}

export async function startSession(
  id: SessionId,
  resume: ResumeMode = { mode: "none" },
  opts: { keepRetryBudget?: boolean } = {},
): Promise<boolean> {
  const meta0 = useApp.getState().persisted.sessions.find((m) => m.id === id);
  // Browser panes have no process.
  if (!meta0 || isBrowserMeta(meta0)) return false;
  if (isLive(useApp.getState().runtime[id])) return true;
  userStopped.delete(id); // a stop only suppresses the retry of the run it ended
  lastResume.set(id, resume);
  if (!opts.keepRetryBudget) retried.delete(id);
  await launchSlot(meta0.agent);
  const st = useApp.getState();
  const meta = st.persisted.sessions.find((m) => m.id === id);
  if (!meta) return false;
  if (isLive(st.runtime[id])) return true;

  const size = getTerminalSize(id) ?? { cols: 120, rows: 32 };
  let agentSessionId: string | null = null;
  let effectiveResume = resume;
  // Codex can't pin a conversation id up front, so `resume --last` in a folder shared by several Codex
  // panes would make them all resume the SAME conversation. Those panes get Codex's picker instead.
  if (meta.agent === "codex" && resume.mode === "continue") {
    const cwd = meta.cwd.toLowerCase();
    if (st.persisted.sessions.some((m) => m.id !== id && m.agent === "codex" && m.cwd.toLowerCase() === cwd))
      effectiveResume = { mode: "pick" };
  }
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
    preset: meta.preset ?? null,
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
    if (shouldApplyStartResult(useApp.getState().runtime[id], info)) useApp.getState().setRuntime(info);
    return true;
  } catch (e) {
    const message = errorMessage(e);
    useApp.getState().setRuntime({
      ...useApp.getState().runtime[id],
      state: { state: "failed", message },
    });
    notify("error", t("sessions.startFailed", { name: meta.name, error: message }));
    return false;
  }
}

export async function stopSession(id: SessionId, force = false) {
  if (isBrowserMeta(useApp.getState().persisted.sessions.find((m) => m.id === id))) return;
  userStopped.add(id);
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
  if (isBrowserMeta(useApp.getState().persisted.sessions.find((m) => m.id === id))) {
    const popout = getNav(id)?.popout;
    if (popout) void ipc.browserCloseWindow(popout).catch(() => {});
    dropNav(id);
    useApp.getState().removeSessionMeta(id);
    return;
  }
  // The pane goes away at once; the process is stopped in the background (runtime events still arrive, so
  // waitForExit works without the meta) and the host entry is removed once it has exited.
  useApp.getState().removeSessionMeta(id);
  if (isLive(useApp.getState().runtime[id])) {
    await stopSession(id, false);
    if (!(await waitForExit(id, 4000))) await stopSession(id, true);
    await waitForExit(id, 3000);
  }
  await ipc.sessionRemove(id).catch(() => {});
  useApp.getState().dropRuntime(id);
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
    notify("info", t("sessions.copiedChars", { count: text.length }));
  } catch (e) {
    notify("error", errorMessage(e));
  }
}

export async function clearSession(id: SessionId) {
  clearTerminal(id);
  await ipc.sessionClearBuffer(id).catch(() => {});
}

export function renameSession(id: SessionId, name: string) {
  if (name.trim()) useApp.getState().updateSessionMeta(id, { name: name.trim(), titleAsName: false });
}

/** Called once after state hydration: restart sessions that were marked auto-start. */
export async function restoreSessions() {
  const { persisted, runtime } = useApp.getState();
  const inGroups = new Set(persisted.workspaces.flatMap((w) => w.groups.flatMap((g) => g.sessionIds)));
  // Terminal panes only: browser panes have no process (their URL reopens when the pane mounts).
  // Skip sessions the host already knows (renderer reload): live ones are running, stopped/exited ones were stopped on purpose.
  const toStart = autoStartable(persisted.sessions).filter((m) => inGroups.has(m.id) && !runtime[m.id]);
  // Stagger launches slightly so many agents don't all hit the disk/network in the same tick.
  for (const m of toStart) {
    void startSession(m.id, m.resumeOnRestore);
    await new Promise((r) => setTimeout(r, 120));
  }
}
