// Global application store (zustand). Persisted part = `persisted` (workspaces.json via Rust).
// Terminal output NEVER goes through this store — it flows Channel -> xterm directly.
// Components must subscribe with narrow selectors to avoid re-renders on unrelated changes.

import { create } from "zustand";
import { ipc } from "../lib/ipc";
import {
  DEFAULT_SETTINGS,
  STATE_VERSION,
  type Account,
  type AccountAgentInfo,
  type AgentAvailability,
  type ClaudeProfile,
  type Group,
  type Layout,
  type PersistedState,
  type SessionId,
  type SessionInfo,
  type SessionMeta,
  type Settings,
  type Workspace,
} from "../lib/types";

export const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();

export interface AppStore {
  loaded: boolean;
  loadError: string | null;
  persisted: PersistedState;
  /** Live process info keyed by session id (from Rust events). */
  runtime: Record<SessionId, SessionInfo>;
  /** Sessions whose terminal view the user explicitly hid (process keeps running). */
  hiddenViews: Record<SessionId, true>;
  /** Claude accounts (historical name). Kept in sync with the Claude rows of `accounts`. */
  profiles: ClaudeProfile[];
  /** Accounts of every agent (Claude, Codex, Hermes, ...). */
  accounts: Account[];
  /** Agents with account support (+ installed tools without it), from the backend. */
  accountAgents: AccountAgentInfo[];
  /** Removed homes the automatic scan skips. */
  dismissedAccounts: number;
  agents: AgentAvailability[];
  focusedSessionId: SessionId | null;

  // --- lifecycle
  hydrate: (state: PersistedState) => void;
  setRuntime: (info: SessionInfo) => void;
  dropRuntime: (id: SessionId) => void;
  setProfiles: (p: ClaudeProfile[]) => void;
  setAccounts: (a: Account[], dismissed?: number) => void;
  setAccountAgents: (a: AccountAgentInfo[]) => void;
  setAgents: (a: AgentAvailability[]) => void;

  // --- settings
  updateSettings: (patch: Partial<Settings>) => void;

  // --- workspaces
  createWorkspace: (name: string, projectDir: string | null) => string;
  renameWorkspace: (id: string, name: string) => void;
  updateWorkspace: (id: string, patch: Partial<Omit<Workspace, "id" | "groups">>) => void;
  duplicateWorkspace: (id: string) => string | null;
  deleteWorkspace: (id: string) => void;
  setActiveWorkspace: (id: string) => void;

  // --- groups
  createGroup: (workspaceId: string, name: string) => string;
  renameGroup: (groupId: string, name: string) => void;
  deleteGroup: (groupId: string) => void;
  setActiveGroup: (workspaceId: string, groupId: string) => void;
  updateLayout: (groupId: string, patch: Partial<Layout>) => void;
  moveSession: (groupId: string, from: number, to: number) => void;
  /**
   * Move a session to `toIndex` of another group of the SAME workspace (or reorder inside its own group).
   * `toIndex` is the final position, counted in the target list without the moved session (clamped).
   * No-op for unknown ids or a cross-workspace move. The session's metadata is untouched, so its terminal
   * (registry entry) and process survive; the pane simply re-mounts in the target group's grid.
   */
  moveSessionToGroup: (sessionId: SessionId, toGroupId: string, toIndex: number) => void;
  /** Reorder a workspace's groups (lane / tab order). No-op for invalid indices. */
  moveGroup: (workspaceId: string, from: number, to: number) => void;

  // --- session metadata
  addSessionMeta: (groupId: string, meta: SessionMeta) => void;
  updateSessionMeta: (id: SessionId, patch: Partial<SessionMeta>) => void;
  removeSessionMeta: (id: SessionId) => void;
  setFocused: (id: SessionId | null) => void;
  setViewHidden: (id: SessionId, hidden: boolean) => void;
}

function emptyGroup(name: string, preset = DEFAULT_SETTINGS.defaultLayout): Group {
  return { id: uid(), name, layout: { preset, maximized: null, sizes: {} }, sessionIds: [] };
}

function mapGroups(ws: Workspace[], groupId: string, fn: (g: Group) => Group): Workspace[] {
  return ws.map((w) =>
    w.groups.some((g) => g.id === groupId) ? { ...w, groups: w.groups.map((g) => (g.id === groupId ? fn(g) : g)) } : w,
  );
}

export const useApp = create<AppStore>()((set, get) => ({
  loaded: false,
  loadError: null,
  persisted: { version: STATE_VERSION, settings: DEFAULT_SETTINGS, workspaces: [], sessions: [], activeWorkspaceId: null },
  runtime: {},
  hiddenViews: {},
  profiles: [],
  accounts: [],
  accountAgents: [],
  dismissedAccounts: 0,
  agents: [],
  focusedSessionId: null,

  hydrate: (state) =>
    set({ loaded: true, persisted: { ...state, settings: { ...DEFAULT_SETTINGS, ...state.settings } } }),
  setRuntime: (info) =>
    set((s) => {
      const prev = s.runtime[info.id];
      // Events and command responses can arrive out of order. For the same process run (same startedAt),
      // never regress: keep the larger byte count and never go from a terminal state back to running.
      if (prev && info.startedAt && prev.startedAt === info.startedAt) {
        const terminal = (x: SessionInfo) => x.state.state === "exited" || x.state.state === "failed";
        const merged: SessionInfo = {
          ...info,
          bytesOut: Math.max(prev.bytesOut, info.bytesOut),
          state: terminal(prev) && !terminal(info) ? prev.state : info.state,
          endedAt: info.endedAt ?? prev.endedAt,
        };
        return { runtime: { ...s.runtime, [info.id]: merged } };
      }
      return { runtime: { ...s.runtime, [info.id]: info } };
    }),
  dropRuntime: (id) =>
    set((s) => {
      const { [id]: _, ...rest } = s.runtime;
      return { runtime: rest };
    }),
  // Claude-only list from older code paths (profilesList): splice it into `accounts` so both views agree.
  setProfiles: (profiles) =>
    set((s) => {
      const byId = new Map(s.accounts.map((a) => [a.id, a]));
      const claude: Account[] = profiles.map((p) => ({
        agent: "claude",
        preset: null,
        autoDetected: false,
        resolvedDir: null,
        ...byId.get(p.id),
        ...p,
      }));
      return { profiles, accounts: [...claude, ...s.accounts.filter((a) => a.agent !== "claude")] };
    }),
  setAccounts: (accounts, dismissed) =>
    set((s) => ({
      accounts,
      profiles: accounts.filter((a) => a.agent === "claude"),
      dismissedAccounts: dismissed ?? s.dismissedAccounts,
    })),
  setAccountAgents: (accountAgents) => set({ accountAgents }),
  setAgents: (agents) => set({ agents }),

  updateSettings: (patch) =>
    set((s) => ({ persisted: { ...s.persisted, settings: { ...s.persisted.settings, ...patch } } })),

  createWorkspace: (name, projectDir) => {
    const g = emptyGroup("Main", get().persisted.settings.defaultLayout);
    const ws: Workspace = { id: uid(), name, projectDir, groups: [g], activeGroupId: g.id, createdAt: now() };
    set((s) => ({ persisted: { ...s.persisted, workspaces: [...s.persisted.workspaces, ws], activeWorkspaceId: ws.id } }));
    return ws.id;
  },
  renameWorkspace: (id, name) => get().updateWorkspace(id, { name }),
  updateWorkspace: (id, patch) =>
    set((s) => ({
      persisted: { ...s.persisted, workspaces: s.persisted.workspaces.map((w) => (w.id === id ? { ...w, ...patch } : w)) },
    })),
  duplicateWorkspace: (id) => {
    const src = get().persisted.workspaces.find((w) => w.id === id);
    if (!src) return null;
    // Duplicates configuration (groups + session definitions), never processes.
    const newSessions: SessionMeta[] = [];
    const groups = src.groups.map((g) => {
      const ids = g.sessionIds.map((sid) => {
        const meta = get().persisted.sessions.find((m) => m.id === sid);
        if (!meta) return null;
        const copy: SessionMeta = { ...meta, id: uid(), agentSessionId: null, lastExitCode: null, createdAt: now() };
        newSessions.push(copy);
        return copy.id;
      });
      return { ...g, id: uid(), sessionIds: ids.filter((x): x is string => !!x), layout: { ...g.layout, maximized: null } };
    });
    const ws: Workspace = { ...src, id: uid(), name: `${src.name} copy`, groups, activeGroupId: groups[0]?.id ?? null, createdAt: now() };
    set((s) => ({
      persisted: {
        ...s.persisted,
        workspaces: [...s.persisted.workspaces, ws],
        sessions: [...s.persisted.sessions, ...newSessions],
      },
    }));
    return ws.id;
  },
  deleteWorkspace: (id) =>
    set((s) => {
      const ws = s.persisted.workspaces.find((w) => w.id === id);
      const dropped = new Set(ws?.groups.flatMap((g) => g.sessionIds) ?? []);
      const workspaces = s.persisted.workspaces.filter((w) => w.id !== id);
      return {
        persisted: {
          ...s.persisted,
          workspaces,
          sessions: s.persisted.sessions.filter((m) => !dropped.has(m.id)),
          activeWorkspaceId: s.persisted.activeWorkspaceId === id ? (workspaces[0]?.id ?? null) : s.persisted.activeWorkspaceId,
        },
      };
    }),
  setActiveWorkspace: (id) => set((s) => ({ persisted: { ...s.persisted, activeWorkspaceId: id } })),

  createGroup: (workspaceId, name) => {
    const g = emptyGroup(name, get().persisted.settings.defaultLayout);
    set((s) => ({
      persisted: {
        ...s.persisted,
        workspaces: s.persisted.workspaces.map((w) =>
          w.id === workspaceId ? { ...w, groups: [...w.groups, g], activeGroupId: g.id } : w,
        ),
      },
    }));
    return g.id;
  },
  renameGroup: (groupId, name) =>
    set((s) => ({ persisted: { ...s.persisted, workspaces: mapGroups(s.persisted.workspaces, groupId, (g) => ({ ...g, name })) } })),
  deleteGroup: (groupId) =>
    set((s) => {
      let dropped: string[] = [];
      const workspaces = s.persisted.workspaces.map((w) => {
        const g = w.groups.find((x) => x.id === groupId);
        if (!g) return w;
        dropped = g.sessionIds;
        const groups = w.groups.filter((x) => x.id !== groupId);
        return { ...w, groups, activeGroupId: w.activeGroupId === groupId ? (groups[0]?.id ?? null) : w.activeGroupId };
      });
      const d = new Set(dropped);
      return { persisted: { ...s.persisted, workspaces, sessions: s.persisted.sessions.filter((m) => !d.has(m.id)) } };
    }),
  setActiveGroup: (workspaceId, groupId) => get().updateWorkspace(workspaceId, { activeGroupId: groupId }),
  updateLayout: (groupId, patch) =>
    set((s) => ({
      persisted: {
        ...s.persisted,
        workspaces: mapGroups(s.persisted.workspaces, groupId, (g) => ({ ...g, layout: { ...g.layout, ...patch } })),
      },
    })),
  moveSession: (groupId, from, to) =>
    set((s) => ({
      persisted: {
        ...s.persisted,
        workspaces: mapGroups(s.persisted.workspaces, groupId, (g) => {
          const ids = [...g.sessionIds];
          if (from < 0 || from >= ids.length || to < 0 || to >= ids.length) return g;
          const [m] = ids.splice(from, 1);
          ids.splice(to, 0, m);
          return { ...g, sessionIds: ids };
        }),
      },
    })),

  moveSessionToGroup: (sessionId, toGroupId, toIndex) =>
    set((s) => {
      const ws = s.persisted.workspaces.find((w) => w.groups.some((g) => g.sessionIds.includes(sessionId)));
      const from = ws?.groups.find((g) => g.sessionIds.includes(sessionId));
      const to = ws?.groups.find((g) => g.id === toGroupId);
      if (!ws || !from || !to || !Number.isFinite(toIndex)) return s;
      const rest = to.sessionIds.filter((x) => x !== sessionId);
      const at = Math.max(0, Math.min(rest.length, Math.trunc(toIndex)));
      if (from.id === to.id && to.sessionIds.indexOf(sessionId) === at) return s;
      rest.splice(at, 0, sessionId);
      const groups = ws.groups.map((g) => {
        if (g.id === to.id) return { ...g, sessionIds: rest };
        if (g.id === from.id)
          return {
            ...g,
            sessionIds: g.sessionIds.filter((x) => x !== sessionId),
            layout: g.layout.maximized === sessionId ? { ...g.layout, maximized: null } : g.layout,
          };
        return g;
      });
      // The focused pane stays on screen: when it leaves the active group, the active group follows it.
      const follow = s.focusedSessionId === sessionId && ws.activeGroupId === from.id && from.id !== to.id;
      const next: Workspace = { ...ws, groups, activeGroupId: follow ? to.id : ws.activeGroupId };
      return { persisted: { ...s.persisted, workspaces: s.persisted.workspaces.map((w) => (w.id === ws.id ? next : w)) } };
    }),
  moveGroup: (workspaceId, from, to) =>
    set((s) => {
      const ws = s.persisted.workspaces.find((w) => w.id === workspaceId);
      const n = ws?.groups.length ?? 0;
      if (!ws || from === to || !Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from >= n || to >= n) return s;
      const groups = [...ws.groups];
      const [g] = groups.splice(from, 1);
      groups.splice(to, 0, g);
      return { persisted: { ...s.persisted, workspaces: s.persisted.workspaces.map((w) => (w.id === workspaceId ? { ...w, groups } : w)) } };
    }),

  addSessionMeta: (groupId, meta) =>
    set((s) => ({
      persisted: {
        ...s.persisted,
        sessions: [...s.persisted.sessions, meta],
        workspaces: mapGroups(s.persisted.workspaces, groupId, (g) => ({ ...g, sessionIds: [...g.sessionIds, meta.id] })),
      },
    })),
  updateSessionMeta: (id, patch) =>
    set((s) => ({
      persisted: { ...s.persisted, sessions: s.persisted.sessions.map((m) => (m.id === id ? { ...m, ...patch } : m)) },
    })),
  removeSessionMeta: (id) =>
    set((s) => ({
      focusedSessionId: s.focusedSessionId === id ? null : s.focusedSessionId,
      persisted: {
        ...s.persisted,
        sessions: s.persisted.sessions.filter((m) => m.id !== id),
        workspaces: s.persisted.workspaces.map((w) => ({
          ...w,
          groups: w.groups.map((g) =>
            g.sessionIds.includes(id)
              ? {
                  ...g,
                  sessionIds: g.sessionIds.filter((x) => x !== id),
                  layout: g.layout.maximized === id ? { ...g.layout, maximized: null } : g.layout,
                }
              : g,
          ),
        })),
      },
    })),
  setFocused: (id) => set({ focusedSessionId: id }),
  setViewHidden: (id, hidden) =>
    set((s) => {
      const next = { ...s.hiddenViews };
      if (hidden) next[id] = true;
      else delete next[id];
      return { hiddenViews: next };
    }),
}));

// ---- selectors --------------------------------------------------------------

export const selectActiveWorkspace = (s: AppStore): Workspace | undefined =>
  s.persisted.workspaces.find((w) => w.id === s.persisted.activeWorkspaceId) ?? s.persisted.workspaces[0];

export const selectActiveGroup = (s: AppStore): Group | undefined => {
  const ws = selectActiveWorkspace(s);
  return ws?.groups.find((g) => g.id === ws.activeGroupId) ?? ws?.groups[0];
};

export const selectSessionMeta = (id: SessionId) => (s: AppStore) => s.persisted.sessions.find((m) => m.id === id);

export const isLive = (info?: SessionInfo) =>
  !!info && (info.state.state === "running" || info.state.state === "starting" || info.state.state === "stopping");

/**
 * Whether a `session_start` response should be written to the store. The response and the
 * `session-state` events travel separately, so an event for the same run (same `startedAt`) can arrive
 * first — e.g. `exited` for a process that ended immediately. The ordered event stream is then
 * authoritative; applying the older response snapshot would resurrect a "running" pane.
 */
export function shouldApplyStartResult(current: SessionInfo | undefined, result: SessionInfo): boolean {
  return !(current && current.startedAt !== null && current.startedAt === result.startedAt);
}

/** Find the group (and workspace) containing a session. */
export function findGroupOf(id: SessionId): { workspace: Workspace; group: Group } | undefined {
  for (const workspace of useApp.getState().persisted.workspaces)
    for (const group of workspace.groups) if (group.sessionIds.includes(id)) return { workspace, group };
  return undefined;
}

// ---- persistence (debounced; only the `persisted` slice is saved) ----------

let saveTimer: number | undefined;
let lastSaved: PersistedState | null = null;

export function startPersistence() {
  useApp.subscribe((s) => {
    // After a failed load `persisted` holds defaults: saving them would overwrite the real file.
    if (!s.loaded || s.loadError || s.persisted === lastSaved) return;
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      const snapshot = useApp.getState().persisted;
      lastSaved = snapshot;
      ipc.stateSave(snapshot).catch((e) => ipc.log("error", `state_save failed: ${String(e?.message ?? e)}`));
    }, 400);
  });
}

/** Flush pending save immediately (e.g. before window close). */
export async function flushPersistence() {
  window.clearTimeout(saveTimer);
  const { persisted: snapshot, loaded, loadError } = useApp.getState();
  if (loaded && !loadError && snapshot !== lastSaved) {
    lastSaved = snapshot;
    await ipc.stateSave(snapshot).catch(() => {});
  }
}
