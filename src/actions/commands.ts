// Command registry: every user-invocable action (palette, keybindings, menus) goes through here.

import { EXPERIENCE_COMMANDS } from "./experienceCommands";
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
import { openTeamTemplates } from "../store/teamTemplates";
import { toggleSkills } from "../store/skills";
import { openBrain } from "../store/brain";
import { rememberText } from "../components/brain/remember";
import { openReplay } from "../store/replay";
import { confirmDialog, useUi } from "../store/uiStore";
import { focusTerminal } from "../terminal/registry";
import { THEMES, getTheme } from "../theme/themes";
import { terminalCommands } from "./terminalCommands";
import { isBrowserMeta } from "../lib/browserPanes";
import { refreshPorts, usePorts } from "../store/ports";
import { openBrowserPane, openExternal, popOut, promptOpenUrl, reload as reloadBrowser } from "./browser";
import { isMessageKey, t, type MessageKey } from "../i18n";

export type CommandCategory = "Session" | "Workspace" | "Group" | "Layout" | "View" | "Theme";

export interface Command {
  /** Stable id (keybindings, menus, settings): never translated. */
  id: string;
  /** Display title in the current UI language (a getter over the catalog key `command.<id>`). */
  readonly title: string;
  category: CommandCategory;
  run: () => void | Promise<unknown>;
  /** Hidden from the palette (still bindable). */
  hidden?: boolean;
}

/** A command as written in the registry: the title comes from the message catalog. */
export type CommandDef = Omit<Command, "title">;

/** Per-theme commands ("Theme: Deep Space", …). Ids: theme.set.<themeId>. */
export const THEME_COMMAND_PREFIX = "theme.set.";

/** A command's title in the current UI language. */
export function commandTitle(id: string): string {
  if (id.startsWith(THEME_COMMAND_PREFIX)) {
    const theme = THEMES.find((th) => th.id === id.slice(THEME_COMMAND_PREFIX.length));
    return t("command.themeSet", { name: theme?.name ?? id });
  }
  const focus = /^session\.focus(\d)$/.exec(id);
  if (focus) return t("command.focusPane", { n: focus[1] });
  const key = `command.${id}`;
  return isMessageKey(key) ? t(key) : id;
}

const CATEGORY_KEYS: Record<CommandCategory, MessageKey> = {
  Session: "command.category.session",
  Workspace: "command.category.workspace",
  Group: "command.category.group",
  Layout: "command.category.layout",
  View: "command.category.view",
  Theme: "command.category.theme",
};

/** A command category's label in the current UI language. */
export function categoryLabel(c: CommandCategory): string {
  return t(CATEGORY_KEYS[c]);
}

function withTitles(defs: CommandDef[]): Command[] {
  return defs.map((d) => Object.defineProperty(d, "title", { get: () => commandTitle(d.id), enumerable: true, configurable: true }) as Command);
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
    notify("info", t("command.toast.noAlerts"));
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
  if (!id) notify("info", t("command.toast.noFocusedSession"));
  return id;
}

const isBrowserPane = (id: SessionId) => isBrowserMeta(useApp.getState().persisted.sessions.find((m) => m.id === id));

/** Focused pane, when it is a terminal session (process commands do not apply to browser panes). */
function requireTerminal(): SessionId | null {
  const id = requireTarget();
  if (id && isBrowserPane(id)) {
    notify("info", t("command.toast.notForBrowser"));
    return null;
  }
  return id;
}

function requireBrowser(): SessionId | null {
  const id = targetSession();
  if (!id || !isBrowserPane(id)) {
    notify("info", t("command.toast.focusBrowser"));
    return null;
  }
  return id;
}

async function refreshPortsCommand() {
  await refreshPorts();
  const n = Object.values(usePorts.getState().bySession).reduce((a, p) => a + p.length, 0);
  notify("info", n ? t("command.toast.ports", { count: n }) : t("command.toast.noPorts"));
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
  return useApp.getState().persisted.sessions.find((m) => m.id === id)?.name ?? t("command.sessionFallbackName");
}

export async function confirmCloseSession(id: SessionId): Promise<void> {
  const live = isLive(useApp.getState().runtime[id]);
  if (live) {
    const ok = await confirmDialog({
      title: t("command.closeSession.title", { name: sessionName(id) }),
      message: t("command.closeSession.message"),
      confirmLabel: t("command.closeSession.confirm"),
      danger: true,
    });
    if (!ok) return;
  }
  await closeSession(id);
}

export async function confirmForceStop(id: SessionId): Promise<void> {
  const ok = await confirmDialog({
    title: t("command.forceStop.title", { name: sessionName(id) }),
    message: t("command.forceStop.message"),
    confirmLabel: t("command.forceStop.confirm"),
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
  const id = useApp.getState().createGroup(ws.id, t("command.defaultGroupName", { n: ws.groups.length + 1 }));
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
  notify("info", t("command.toast.theme", { name: next.name }));
}

const themeCommands: CommandDef[] = THEMES.map((th) => ({
  id: `${THEME_COMMAND_PREFIX}${th.id}`,
  category: "Theme" as const,
  run: () => setTheme(th.id),
}));

// ---- registry -----------------------------------------------------------------

const focusCommands: CommandDef[] = Array.from({ length: 9 }, (_, i) => ({
  id: `session.focus${i + 1}`,
  category: "Session" as const,
  run: () => focusIndex(i + 1),
  hidden: i > 0,
}));

export const COMMANDS: Command[] = withTitles([
  { id: "session.new", category: "Session", run: () => newSessionDialog() },
  { id: "session.splitColumns", category: "Session", run: () => newSessionDialog("columns") },
  { id: "session.splitRows", category: "Session", run: () => newSessionDialog("rows") },
  { id: "session.next", category: "Session", run: () => cycleSession(1) },
  { id: "session.prev", category: "Session", run: () => cycleSession(-1) },
  ...focusCommands,
  {
    id: "session.close",
    category: "Session",
    run: () => {
      const id = requireTarget();
      if (id) return confirmCloseSession(id);
    },
  },
  {
    id: "session.restart",
    category: "Session",
    run: () => {
      const id = requireTarget();
      if (id && isBrowserPane(id)) return reloadBrowser(id); // a browser pane "restarts" by reloading
      if (id) return restartSession(id, { mode: "continue" });
    },
  },
  {
    id: "session.restartFresh",
    category: "Session",
    run: () => {
      const id = requireTerminal();
      if (id) return restartSession(id, { mode: "none" });
    },
  },
  {
    id: "session.stop",
    category: "Session",
    run: () => {
      const id = requireTerminal();
      if (id) return stopSession(id, false);
    },
  },
  {
    id: "session.forceStop",
    category: "Session",
    run: () => {
      const id = requireTerminal();
      if (id) return confirmForceStop(id);
    },
  },
  { id: "session.maximize", category: "Layout", run: toggleMaximize },
  {
    id: "session.copyOutput",
    category: "Session",
    run: () => {
      const id = requireTerminal();
      if (id) return copyOutput(id);
    },
  },
  {
    id: "session.clear",
    category: "Session",
    run: () => {
      const id = requireTerminal();
      if (id) return clearSession(id);
    },
  },
  ...terminalCommands(requireTerminal),
  { id: "browser.new", category: "Session", run: () => void openBrowserPane({}) },
  { id: "browser.open", category: "Session", run: () => promptOpenUrl(selectActiveGroup(useApp.getState())?.id) },
  {
    id: "browser.reload",
    category: "Session",
    run: () => {
      const id = requireBrowser();
      if (id) reloadBrowser(id);
    },
  },
  {
    id: "browser.popOut",
    category: "Session",
    run: () => {
      const id = requireBrowser();
      if (id) return popOut(id);
    },
  },
  {
    id: "browser.external",
    category: "Session",
    run: () => {
      const id = requireBrowser();
      if (id) openExternal(useApp.getState().persisted.sessions.find((m) => m.id === id)?.url);
    },
  },
  { id: "ports.refresh", category: "View", run: refreshPortsCommand },
  {
    id: "view.changes",
    category: "View",
    run: () => {
      const ui = useUi.getState();
      ui.setChangesOpen(!ui.changesOpen);
    },
  },
  { id: "workspace.new", category: "Workspace", run: () => useUi.getState().openDialog({ kind: "newWorkspace" }) },
  { id: "workspace.next", category: "Workspace", run: () => cycleWorkspace(1) },
  { id: "workspace.prev", category: "Workspace", run: () => cycleWorkspace(-1) },
  { id: "workspace.switch", category: "Workspace", run: () => useUi.getState().openPalette("workspaces") },
  { id: "session.goto", category: "Session", run: () => useUi.getState().openPalette("sessions") },
  { id: "group.new", category: "Group", run: newGroup },
  { id: "layout.grid", category: "Layout", run: () => setPreset("grid") },
  { id: "layout.columns", category: "Layout", run: () => setPreset("columns") },
  { id: "layout.rows", category: "Layout", run: () => setPreset("rows") },
  {
    id: "view.toggleSidebar",
    category: "View",
    run: () => {
      const s = useApp.getState();
      s.updateSettings({ sidebarCollapsed: !s.persisted.settings.sidebarCollapsed });
    },
  },
  {
    id: "view.toggleInspector",
    category: "View",
    run: () => {
      const s = useApp.getState();
      s.updateSettings({ inspectorOpen: !s.persisted.settings.inspectorOpen });
    },
  },
  { id: "view.toggleDiagnostics", category: "View", run: () => toggleDialog("diagnostics") },
  {
    id: "view.palette",
    category: "View",
    hidden: true,
    run: () => {
      const ui = useUi.getState();
      if (ui.palette.open) ui.closePalette();
      else ui.openPalette("all");
    },
  },
  { id: "view.settings", category: "View", run: () => toggleDialog("settings") },
  {
    id: "view.focusMode",
    category: "View",
    run: () => {
      const ui = useUi.getState();
      ui.setFocusMode(!ui.focusMode);
    },
  },
  {
    id: "view.presentation",
    category: "View",
    run: () => {
      const ui = useUi.getState();
      ui.setPresentation(!ui.presentation);
    },
  },
  { id: "view.appearance", category: "Theme", run: () => useUi.getState().openDialog({ kind: "settings", section: "appearance" }) },
  { id: "theme.next", category: "Theme", run: () => cycleTheme(1) },
  { id: "theme.prev", category: "Theme", run: () => cycleTheme(-1) },
  ...themeCommands,
  { id: "attention.next", category: "Session", run: jumpToNextAlert },
  { id: "view.fleet", category: "View", run: () => toggleOverlay("fleet") },
  { id: "session.broadcast", category: "Session", run: () => toggleOverlay("broadcast") },
  { id: "view.comms", category: "View", run: () => useAttentionUi.getState().toggleComms() },
  { id: "attention.markAllRead", category: "View", run: () => useAttention.getState().markAllRead() },
  { id: "view.profiles", category: "View", run: () => toggleDialog("profiles") },
  { id: "view.mission", category: "View", run: () => useMission.getState().toggle() },
  { id: "formation.launch", category: "Workspace", run: () => useMission.getState().openFormation() },
  { id: "teamTemplate.import", category: "Workspace", run: () => openTeamTemplates("import") },
  { id: "teamTemplate.export", category: "Workspace", run: () => openTeamTemplates("export") },
  { id: "view.skills", category: "Workspace", run: toggleSkills },
  { id: "mission.replay", category: "View", run: () => openReplay() },
  { id: "brain.open", category: "Workspace", run: () => openBrain() },
  { id: "brain.add", category: "Workspace", run: () => rememberText() },
  ...EXPERIENCE_COMMANDS,
]);

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
      (r as Promise<unknown>).catch((e) => notify("error", t("command.toast.failed", { command: cmd.title, error: String((e as Error)?.message ?? e) })));
  } catch (e) {
    notify("error", t("command.toast.failed", { command: cmd.title, error: String((e as Error)?.message ?? e) }));
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

/** Confirm, stop every session (closeSession), then delete the workspace. */
export async function deleteWorkspaceFlow(workspaceId: string): Promise<void> {
  const ws = useApp.getState().persisted.workspaces.find((w) => w.id === workspaceId);
  if (!ws) return;
  const ids = sessionIdsOf(ws.groups);
  const live = liveCount(ids);
  const ok = await confirmDialog({
    title: t("command.deleteWorkspace.title", { name: ws.name }),
    message: live > 0 ? t("command.deleteWorkspace.messageLive", { live, count: ids.length }) : t("command.deleteWorkspace.message", { count: ids.length }),
    confirmLabel: live > 0 ? t("command.deleteFlow.stopAndDelete") : t("command.deleteWorkspace.confirm"),
    danger: true,
  });
  if (!ok) return;
  await Promise.all(ids.map((id) => closeSession(id).catch(() => {})));
  const app = useApp.getState();
  app.deleteWorkspace(workspaceId);
  if (useApp.getState().persisted.workspaces.length === 0) app.createWorkspace(t("command.defaultWorkspaceName"), null);
  const next = selectActiveWorkspace(useApp.getState());
  if (next) switchWorkspace(next.id);
}

/** Confirm, stop the group's sessions, then delete the group. The last group of a workspace is kept. */
export async function deleteGroupFlow(groupId: string): Promise<void> {
  const ws = useApp.getState().persisted.workspaces.find((w) => w.groups.some((g) => g.id === groupId));
  const g = ws?.groups.find((x) => x.id === groupId);
  if (!ws || !g) return;
  if (ws.groups.length <= 1) {
    notify("info", t("command.toast.lastGroup"));
    return;
  }
  const live = liveCount(g.sessionIds);
  const ok = await confirmDialog({
    title: t("command.deleteGroup.title", { name: g.name }),
    message: live > 0 ? t("command.deleteGroup.messageLive", { live, count: g.sessionIds.length }) : t("command.deleteGroup.message", { count: g.sessionIds.length }),
    confirmLabel: live > 0 ? t("command.deleteFlow.stopAndDelete") : t("command.deleteGroup.confirm"),
    danger: true,
  });
  if (!ok) return;
  await Promise.all(g.sessionIds.map((id) => closeSession(id).catch(() => {})));
  useApp.getState().deleteGroup(groupId);
  const after = useApp.getState().persisted.workspaces.find((w) => w.id === ws.id);
  const gid = after?.activeGroupId ?? after?.groups[0]?.id;
  if (after && gid) activateGroup(after.id, gid);
}
