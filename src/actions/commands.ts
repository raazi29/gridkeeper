// Command registry: every user-invocable action (palette, keybindings, menus) goes through here.

import { notify } from "./notify";
import {
  clearSession,
  closeSession,
  copyOutput,
  restartSession,
  stopSession,
} from "./sessions";
import type { LayoutPreset, SessionId } from "../lib/types";
import {
  findGroupOf,
  isLive,
  selectActiveGroup,
  selectActiveWorkspace,
  useApp,
} from "../store/appStore";
import { nextAttentionTarget, useAttention, useAttentionUi } from "../store/attention";
import { useMission } from "../store/mission";
import { confirmDialog, useUi } from "../store/uiStore";
import { focusTerminal } from "../terminal/registry";
import { THEMES, getTheme } from "../theme/themes";
import { terminalCommands } from "./terminalCommands";

export interface Command {
  id: string;
  title: string;
  category: "Session" | "Workspace" | "Group" | "Layout" | "View" | "Theme";
  run: () => void | Promise<unknown>;
  /** Hidden from the palette (still bindable). */
  hidden?: boolean;
}

// ---- navigation helpers (also used by components) ----------------------------

/** Focus a session's terminal after the grid had a chance to mount/show it. */
export function focusSoon(id: SessionId) {
  requestAnimationFrame(() => requestAnimationFrame(() => focusTerminal(id)));
}

export function focusSession(id: SessionId) {
  const loc = findGroupOf(id);
  const app = useApp.getState();
  if (loc) {
    if (app.persisted.activeWorkspaceId !== loc.workspace.id) app.setActiveWorkspace(loc.workspace.id);
    if (loc.workspace.activeGroupId !== loc.group.id) app.setActiveGroup(loc.workspace.id, loc.group.id);
    useUi.getState().markVisited(loc.workspace.id);
    // A maximized pane hides the others: follow focus.
    if (loc.group.layout.maximized && loc.group.layout.maximized !== id) app.updateLayout(loc.group.id, { maximized: id });
    if (app.hiddenViews[id]) app.setViewHidden(id, false);
  }
  app.setFocused(id);
  focusSoon(id);
}

/** Every session in workspace -> group -> pane order. */
export function globalSessionOrder(): SessionId[] {
  const out: SessionId[] = [];
  for (const w of useApp.getState().persisted.workspaces) for (const g of w.groups) out.push(...g.sessionIds);
  return out;
}

/** Switch workspace / group as needed, focus the pane and clear its unread flag. */
export function jumpToSession(id: SessionId) {
  focusSession(id);
  useAttention.getState().markRead(id);
}

/** `attention.next`: the next session needing attention, round-robin across all workspaces. */
export function jumpToNextAlert() {
  const target = nextAttentionTarget(globalSessionOrder(), useAttention.getState().sessions, useApp.getState().focusedSessionId);
  if (!target) {
    notify("info", "No sessions need attention");
    return;
  }
  jumpToSession(target);
}

function toggleOverlay(kind: "fleet" | "broadcast") {
  const ui = useAttentionUi.getState();
  if (ui.overlay === kind) ui.close();
  else {
    useUi.getState().closePalette();
    ui.open(kind);
  }
}

/** Activate a group and restore its last focused session. */
export function activateGroup(workspaceId: string, groupId: string) {
  const app = useApp.getState();
  if (app.persisted.activeWorkspaceId !== workspaceId) app.setActiveWorkspace(workspaceId);
  app.setActiveGroup(workspaceId, groupId);
  useUi.getState().markVisited(workspaceId);
  const ws = useApp.getState().persisted.workspaces.find((w) => w.id === workspaceId);
  const g = ws?.groups.find((x) => x.id === groupId);
  if (!g) return;
  const last = useUi.getState().lastFocusByGroup[groupId];
  const target = last && g.sessionIds.includes(last) ? last : g.sessionIds[0];
  if (target) {
    app.setFocused(target);
    focusSoon(target);
  }
}

export function switchWorkspace(workspaceId: string) {
  const ws = useApp.getState().persisted.workspaces.find((w) => w.id === workspaceId);
  if (!ws) return;
  const gid = ws.activeGroupId ?? ws.groups[0]?.id;
  if (gid) activateGroup(ws.id, gid);
  else {
    useApp.getState().setActiveWorkspace(ws.id);
    useUi.getState().markVisited(ws.id);
  }
}

function cycleWorkspace(dir: 1 | -1) {
  const s = useApp.getState();
  const list = s.persisted.workspaces;
  if (list.length < 2) return;
  const cur = selectActiveWorkspace(s);
  const i = Math.max(0, list.findIndex((w) => w.id === cur?.id));
  switchWorkspace(list[(i + dir + list.length) % list.length].id);
}

/** The session commands act on: the focused one if it is in the active group. */
export function targetSession(): SessionId | null {
  const s = useApp.getState();
  const g = selectActiveGroup(s);
  const f = s.focusedSessionId;
  if (g && f && g.sessionIds.includes(f)) return f;
  return null;
}

function requireTarget(): SessionId | null {
  const id = targetSession();
  if (!id) notify("info", "No session focused in this group");
  return id;
}

function cycleSession(dir: 1 | -1) {
  const s = useApp.getState();
  const g = selectActiveGroup(s);
  if (!g || g.sessionIds.length === 0) return;
  const visible = g.sessionIds.filter((id) => !s.hiddenViews[id]);
  const ids = visible.length ? visible : g.sessionIds;
  const i = s.focusedSessionId ? ids.indexOf(s.focusedSessionId) : -1;
  const next = i < 0 ? ids[dir === 1 ? 0 : ids.length - 1] : ids[(i + dir + ids.length) % ids.length];
  focusSession(next);
}

function focusIndex(n: number) {
  const g = selectActiveGroup(useApp.getState());
  const id = g?.sessionIds[n - 1];
  if (id) focusSession(id);
}

function setPreset(preset: LayoutPreset) {
  const g = selectActiveGroup(useApp.getState());
  if (g) useApp.getState().updateLayout(g.id, { preset, maximized: null });
}

function sessionName(id: SessionId) {
  return useApp.getState().persisted.sessions.find((m) => m.id === id)?.name ?? "session";
}

export async function confirmCloseSession(id: SessionId): Promise<void> {
  const live = isLive(useApp.getState().runtime[id]);
  if (live) {
    const ok = await confirmDialog({
      title: `Close “${sessionName(id)}”?`,
      message: "The process is still running. Closing the pane stops it and removes the session.",
      confirmLabel: "Stop and close",
      danger: true,
    });
    if (!ok) return;
  }
  await closeSession(id);
}

export async function confirmForceStop(id: SessionId): Promise<void> {
  const ok = await confirmDialog({
    title: `Force stop “${sessionName(id)}”?`,
    message: "Kills the whole process tree immediately. Unsaved agent work in progress may be lost.",
    confirmLabel: "Force stop",
    danger: true,
  });
  if (ok) await stopSession(id, true);
}

function toggleMaximize() {
  const id = requireTarget();
  if (!id) return;
  const loc = findGroupOf(id);
  if (!loc) return;
  useApp.getState().updateLayout(loc.group.id, { maximized: loc.group.layout.maximized === id ? null : id });
}

function newSessionDialog(preset?: LayoutPreset) {
  const g = selectActiveGroup(useApp.getState());
  useUi.getState().openDialog({ kind: "newSession", groupId: g?.id, preset });
}

function newGroup() {
  const ws = selectActiveWorkspace(useApp.getState());
  if (!ws) return;
  const id = useApp.getState().createGroup(ws.id, `Group ${ws.groups.length + 1}`);
  useUi.getState().markVisited(ws.id);
  useApp.getState().setActiveGroup(ws.id, id);
}

function toggleDialog(kind: "settings" | "profiles" | "diagnostics") {
  const ui = useUi.getState();
  if (ui.dialog?.kind === kind) ui.closeDialog();
  else ui.openDialog({ kind });
}

// ---- appearance -----------------------------------------------------------------

function setTheme(id: string) {
  useApp.getState().updateSettings({ theme: id });
}

function cycleTheme(dir: 1 | -1) {
  const cur = getTheme(useApp.getState().persisted.settings.theme).id;
  const i = THEMES.findIndex((t) => t.id === cur);
  const next = THEMES[(i + dir + THEMES.length) % THEMES.length];
  setTheme(next.id);
  notify("info", `Theme: ${next.name}`);
}

/** Per-theme commands ("Theme: Deep Space", …). Ids: theme.set.<themeId>. */
export const THEME_COMMAND_PREFIX = "theme.set.";
const themeCommands: Command[] = THEMES.map((t) => ({
  id: `${THEME_COMMAND_PREFIX}${t.id}`,
  title: `Theme: ${t.name}`,
  category: "Theme" as const,
  run: () => setTheme(t.id),
}));

// ---- registry -----------------------------------------------------------------

const focusCommands: Command[] = Array.from({ length: 9 }, (_, i) => ({
  id: `session.focus${i + 1}`,
  title: `Focus pane ${i + 1}`,
  category: "Session" as const,
  run: () => focusIndex(i + 1),
  hidden: i > 0,
}));

export const COMMANDS: Command[] = [
  { id: "session.new", title: "New session…", category: "Session", run: () => newSessionDialog() },
  { id: "session.splitColumns", title: "Split: new session in columns", category: "Session", run: () => newSessionDialog("columns") },
  { id: "session.splitRows", title: "Split: new session in rows", category: "Session", run: () => newSessionDialog("rows") },
  { id: "session.next", title: "Focus next session", category: "Session", run: () => cycleSession(1) },
  { id: "session.prev", title: "Focus previous session", category: "Session", run: () => cycleSession(-1) },
  ...focusCommands,
  {
    id: "session.close",
    title: "Close session",
    category: "Session",
    run: () => {
      const id = requireTarget();
      if (id) return confirmCloseSession(id);
    },
  },
  {
    id: "session.restart",
    title: "Restart session (resume)",
    category: "Session",
    run: () => {
      const id = requireTarget();
      if (id) return restartSession(id, { mode: "continue" });
    },
  },
  {
    id: "session.restartFresh",
    title: "Restart session (fresh conversation)",
    category: "Session",
    run: () => {
      const id = requireTarget();
      if (id) return restartSession(id, { mode: "none" });
    },
  },
  {
    id: "session.stop",
    title: "Stop session",
    category: "Session",
    run: () => {
      const id = requireTarget();
      if (id) return stopSession(id, false);
    },
  },
  {
    id: "session.forceStop",
    title: "Force stop session…",
    category: "Session",
    run: () => {
      const id = requireTarget();
      if (id) return confirmForceStop(id);
    },
  },
  { id: "session.maximize", title: "Toggle maximize pane", category: "Layout", run: toggleMaximize },
  {
    id: "session.copyOutput",
    title: "Copy session output",
    category: "Session",
    run: () => {
      const id = requireTarget();
      if (id) return copyOutput(id);
    },
  },
  {
    id: "session.clear",
    title: "Clear terminal",
    category: "Session",
    run: () => {
      const id = requireTarget();
      if (id) return clearSession(id);
    },
  },
  ...terminalCommands(requireTarget),
  { id: "workspace.new", title: "New workspace…", category: "Workspace", run: () => useUi.getState().openDialog({ kind: "newWorkspace" }) },
  { id: "workspace.next", title: "Next workspace", category: "Workspace", run: () => cycleWorkspace(1) },
  { id: "workspace.prev", title: "Previous workspace", category: "Workspace", run: () => cycleWorkspace(-1) },
  { id: "workspace.switch", title: "Switch workspace…", category: "Workspace", run: () => useUi.getState().openPalette("workspaces") },
  { id: "session.goto", title: "Go to session…", category: "Session", run: () => useUi.getState().openPalette("sessions") },
  { id: "group.new", title: "New group", category: "Group", run: newGroup },
  { id: "layout.grid", title: "Layout: grid", category: "Layout", run: () => setPreset("grid") },
  { id: "layout.columns", title: "Layout: columns", category: "Layout", run: () => setPreset("columns") },
  { id: "layout.rows", title: "Layout: rows", category: "Layout", run: () => setPreset("rows") },
  {
    id: "view.toggleSidebar",
    title: "Toggle sidebar",
    category: "View",
    run: () => {
      const s = useApp.getState();
      s.updateSettings({ sidebarCollapsed: !s.persisted.settings.sidebarCollapsed });
    },
  },
  {
    id: "view.toggleInspector",
    title: "Toggle inspector",
    category: "View",
    run: () => {
      const s = useApp.getState();
      s.updateSettings({ inspectorOpen: !s.persisted.settings.inspectorOpen });
    },
  },
  { id: "view.toggleDiagnostics", title: "Toggle diagnostics", category: "View", run: () => toggleDialog("diagnostics") },
  {
    id: "view.palette",
    title: "Command palette",
    category: "View",
    hidden: true,
    run: () => {
      const ui = useUi.getState();
      if (ui.palette.open) ui.closePalette();
      else ui.openPalette("all");
    },
  },
  { id: "view.settings", title: "Settings", category: "View", run: () => toggleDialog("settings") },
  {
    id: "view.focusMode",
    title: "Toggle focus mode",
    category: "View",
    run: () => {
      const ui = useUi.getState();
      ui.setFocusMode(!ui.focusMode);
    },
  },
  {
    id: "view.presentation",
    title: "Toggle presentation mode",
    category: "View",
    run: () => {
      const ui = useUi.getState();
      ui.setPresentation(!ui.presentation);
    },
  },
  { id: "view.appearance", title: "Appearance settings…", category: "Theme", run: () => useUi.getState().openDialog({ kind: "settings", section: "appearance" }) },
  { id: "theme.next", title: "Next theme", category: "Theme", run: () => cycleTheme(1) },
  { id: "theme.prev", title: "Previous theme", category: "Theme", run: () => cycleTheme(-1) },
  ...themeCommands,
  { id: "attention.next", title: "Jump to next alert", category: "Session", run: jumpToNextAlert },
  { id: "view.fleet", title: "Fleet overview (all sessions)", category: "View", run: () => toggleOverlay("fleet") },
  { id: "session.broadcast", title: "Broadcast a line to several sessions…", category: "Session", run: () => toggleOverlay("broadcast") },
  { id: "view.comms", title: "Comms: recent alerts", category: "View", run: () => useAttentionUi.getState().toggleComms() },
  { id: "attention.markAllRead", title: "Comms: mark all alerts read", category: "View", run: () => useAttention.getState().markAllRead() },
  { id: "view.profiles", title: "Claude account profiles", category: "View", run: () => toggleDialog("profiles") },
  { id: "view.mission", title: "Mission Control (team view of this workspace)", category: "View", run: () => useMission.getState().toggle() },
  { id: "formation.launch", title: "Launch formation (agent team template)…", category: "Workspace", run: () => useMission.getState().openFormation() },
];

const byId = new Map(COMMANDS.map((c) => [c.id, c]));

export function getCommand(id: string): Command | undefined {
  return byId.get(id);
}

/** Run a command by id; errors become toasts, never unhandled rejections. */
export function runCommand(id: string): void {
  const cmd = byId.get(id);
  if (!cmd) return;
  try {
    const r = cmd.run();
    if (r && typeof (r as Promise<unknown>).then === "function")
      (r as Promise<unknown>).catch((e) => notify("error", `${cmd.title}: ${String((e as Error)?.message ?? e)}`));
  } catch (e) {
    notify("error", `${cmd.title}: ${String((e as Error)?.message ?? e)}`);
  }
}

/** Keep per-group "last focused session" in sync with the store (call once). */
export function installFocusTracking(): () => void {
  let prev = useApp.getState().focusedSessionId;
  return useApp.subscribe((s) => {
    if (s.focusedSessionId === prev) return;
    prev = s.focusedSessionId;
    if (!prev) return;
    const loc = findGroupOf(prev);
    if (loc) useUi.getState().rememberFocus(loc.group.id, prev);
  });
}

// ---- destructive workspace / group flows (shared by sidebar, tabs, palette) -----

function sessionIdsOf(groups: { sessionIds: SessionId[] }[]): SessionId[] {
  return groups.flatMap((g) => g.sessionIds);
}

function liveCount(ids: SessionId[]): number {
  const rt = useApp.getState().runtime;
  return ids.filter((id) => isLive(rt[id])).length;
}

function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

/** Confirm, stop every session (closeSession), then delete the workspace. */
export async function deleteWorkspaceFlow(workspaceId: string): Promise<void> {
  const ws = useApp.getState().persisted.workspaces.find((w) => w.id === workspaceId);
  if (!ws) return;
  const ids = sessionIdsOf(ws.groups);
  const live = liveCount(ids);
  const ok = await confirmDialog({
    title: `Delete workspace “${ws.name}”?`,
    message:
      (live > 0 ? `${plural(live, "running session")} will be stopped first. ` : "") +
      `Removes the workspace, its groups and ${plural(ids.length, "session definition")}. Files in the project folder are not touched.`,
    confirmLabel: live > 0 ? "Stop sessions and delete" : "Delete workspace",
    danger: true,
  });
  if (!ok) return;
  await Promise.all(ids.map((id) => closeSession(id).catch(() => {})));
  const app = useApp.getState();
  app.deleteWorkspace(workspaceId);
  if (useApp.getState().persisted.workspaces.length === 0) app.createWorkspace("Workspace", null);
  const next = selectActiveWorkspace(useApp.getState());
  if (next) switchWorkspace(next.id);
}

/** Confirm, stop the group's sessions, then delete the group. The last group of a workspace is kept. */
export async function deleteGroupFlow(groupId: string): Promise<void> {
  const ws = useApp.getState().persisted.workspaces.find((w) => w.groups.some((g) => g.id === groupId));
  const g = ws?.groups.find((x) => x.id === groupId);
  if (!ws || !g) return;
  if (ws.groups.length <= 1) {
    notify("info", "A workspace needs at least one group");
    return;
  }
  const live = liveCount(g.sessionIds);
  const ok = await confirmDialog({
    title: `Delete group “${g.name}”?`,
    message:
      (live > 0 ? `${plural(live, "running session")} will be stopped first. ` : "") +
      `Removes the group and ${plural(g.sessionIds.length, "session definition")}.`,
    confirmLabel: live > 0 ? "Stop sessions and delete" : "Delete group",
    danger: true,
  });
  if (!ok) return;
  await Promise.all(g.sessionIds.map((id) => closeSession(id).catch(() => {})));
  useApp.getState().deleteGroup(groupId);
  const after = useApp.getState().persisted.workspaces.find((w) => w.id === ws.id);
  const gid = after?.activeGroupId ?? after?.groups[0]?.id;
  if (after && gid) activateGroup(after.id, gid);
}
