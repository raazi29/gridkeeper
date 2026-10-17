// Store helpers for settings.notifications: read (normalized), patch, mutes, DND.
// Writing always stores the full normalized object so older state files are upgraded on first edit.

import type { NotificationSettings, SessionId } from "../lib/types";
import { useApp } from "../store/appStore";
import { notify } from "./notify";
import { normalizeNotifications, toggleIn } from "./notifyRules";

export function getNotif(): NotificationSettings {
  return normalizeNotifications(useApp.getState().persisted.settings.notifications);
}

export function updateNotif(patch: Partial<NotificationSettings>): void {
  useApp.getState().updateSettings({ notifications: { ...getNotif(), ...patch } });
}

/** Reactive, normalized notification settings. */
export function useNotif(): NotificationSettings {
  const raw = useApp((s) => s.persisted.settings.notifications);
  return normalizeNotifications(raw);
}

export function useSessionMuted(id: SessionId): boolean {
  return useApp((s) => !!s.persisted.settings.notifications?.mutedSessions?.includes(id));
}

export function useDnd(): boolean {
  return useApp((s) => !!s.persisted.settings.notifications?.dnd);
}

export function isWorkspaceMuted(id: string): boolean {
  return getNotif().mutedWorkspaces.includes(id);
}

function nameOfSession(id: SessionId) {
  return useApp.getState().persisted.sessions.find((m) => m.id === id)?.name ?? "session";
}

export function toggleSessionMute(id: SessionId, on?: boolean): void {
  const n = getNotif();
  const next = toggleIn(n.mutedSessions, id, on);
  updateNotif({ mutedSessions: next });
  const muted = next.includes(id);
  notify("info", muted ? `Notifications muted for “${nameOfSession(id)}” — alerts still land in Comms` : `Notifications on for “${nameOfSession(id)}”`);
}

export function toggleWorkspaceMute(id: string, on?: boolean): void {
  const n = getNotif();
  const next = toggleIn(n.mutedWorkspaces, id, on);
  updateNotif({ mutedWorkspaces: next });
  const name = useApp.getState().persisted.workspaces.find((w) => w.id === id)?.name ?? "workspace";
  notify("info", next.includes(id) ? `Notifications muted for workspace “${name}”` : `Notifications on for workspace “${name}”`);
}

export function toggleDnd(on?: boolean): void {
  const dnd = on ?? !getNotif().dnd;
  updateNotif({ dnd });
  notify("info", dnd ? "Do not disturb on — alerts collect silently in Comms" : "Do not disturb off");
}
