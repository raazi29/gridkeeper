// Global application store (zustand). Persisted part = `persisted` (workspaces.json via Rust).
// Terminal output NEVER goes through this store — it flows Channel -> xterm directly.
// Components must subscribe with narrow selectors to avoid re-renders on unrelated changes.

import { create } from "zustand";
import { ipc } from "../lib/ipc";
import {
  DEFAULT_SETTINGS,
  STATE_VERSION,
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
  profiles: ClaudeProfile[];
  agents: AgentAvailability[];
  focusedSessionId: SessionId | null;

  // --- lifecycle
  hydrate: (state: PersistedState) => void;
  setRuntime: (info: SessionInfo) => void;
  dropRuntime: (id: SessionId) => void;
  setProfiles: (p: ClaudeProfile[]) => void;
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
  agents: [],
  focusedSessionId: null,

  hydrate: (state) =>
    set({ loaded: true, persisted: { ...state, settings: { ...DEFAULT_SETTINGS, ...state.settings } } }),
  setRuntime: (info) => set((s) => ({ runtime: { ...s.runtime, [info.id]: info } })),
  dropRuntime: (id) =>
    set((s) => {
      const { [id]: _, ...rest } = s.runtime;
      return { runtime: rest };
    }),
  setProfiles: (profiles) => set({ profiles }),
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
    if (!s.loaded || s.persisted === lastSaved) return;
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
  const snapshot = useApp.getState().persisted;
  if (snapshot !== lastSaved) {
    lastSaved = snapshot;
    await ipc.stateSave(snapshot).catch(() => {});
  }
}
