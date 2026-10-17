// Context menus for containers: a group tab (also Mission Control lane headers), a sidebar workspace
// row (extra items) and the empty grid background.

import { deleteGroupFlow, runCommand, switchWorkspace } from "../../actions/commands";
import { closeSessions, groupSessionIds, messageSessions, restartSessions, stopSessions, workspaceSessionIds } from "../../actions/groupActions";
import { isWorkspaceMuted, toggleWorkspaceMute } from "../../actions/notifyPrefs";
import { useApp } from "../../store/appStore";
import { useMission } from "../../store/mission";
import type { MenuItem } from "../ui/Menu";
import { layoutSubmenu, newSessionSubmenu, shortcutHint } from "./common";

function findGroup(groupId: string) {
  for (const w of useApp.getState().persisted.workspaces) {
    const g = w.groups.find((x) => x.id === groupId);
    if (g) return { ws: w, group: g };
  }
  return undefined;
}

/** Group tab right-click. `onRename` starts the tab's inline rename. */
export function buildGroupMenu(groupId: string, ctx: { onRename?: () => void } = {}): MenuItem[] {
  const loc = findGroup(groupId);
  if (!loc) return [{ label: "Group not found", disabled: true }];
  const { ws, group } = loc;
  const what = `“${group.name}”`;
  const empty = group.sessionIds.length === 0;
  return [
    ...(ctx.onRename ? [{ label: "Rename", hint: "F2", onSelect: ctx.onRename } as MenuItem] : []),
    newSessionSubmenu(groupId),
    { label: "Launch formation here…", onSelect: () => useMission.getState().openFormation({ groupId }) },
    layoutSubmenu(groupId, group.layout.preset),
    "separator",
    { label: "Message all in group…", disabled: empty, onSelect: () => messageSessions(groupSessionIds(groupId), what) },
    { label: "Restart all…", disabled: empty, onSelect: () => void restartSessions(groupSessionIds(groupId), what) },
    { label: "Stop all…", disabled: empty, onSelect: () => void stopSessions(groupSessionIds(groupId), what) },
    "separator",
    { label: "Close all sessions…", danger: true, disabled: empty, onSelect: () => void closeSessions(groupSessionIds(groupId), what) },
    { label: "Delete group…", danger: true, disabled: ws.groups.length <= 1, onSelect: () => void deleteGroupFlow(groupId) },
  ];
}

/** Extra items for a sidebar workspace row (the row keeps its own rename / folder / duplicate / delete). */
export function workspaceExtraItems(workspaceId: string): MenuItem[] {
  const ws = useApp.getState().persisted.workspaces.find((w) => w.id === workspaceId);
  if (!ws) return [];
  const targetGroup = ws.activeGroupId ?? ws.groups[0]?.id;
  const muted = isWorkspaceMuted(workspaceId);
  const hasSessions = ws.groups.some((g) => g.sessionIds.length > 0);
  return [
    { ...newSessionSubmenu(targetGroup), disabled: !targetGroup },
    {
      label: "Open Mission Control",
      hint: shortcutHint("view.mission"),
      onSelect: () => {
        switchWorkspace(workspaceId);
        useMission.getState().toggle(true);
      },
    },
    { label: muted ? "Unmute notifications" : "Mute notifications", checked: muted, hint: "alerts still reach Comms", onSelect: () => toggleWorkspaceMute(workspaceId) },
    { label: "Stop all sessions…", disabled: !hasSessions, onSelect: () => void stopSessions(workspaceSessionIds(workspaceId), `“${ws.name}”`) },
  ];
}

/** Right-click on an empty grid / the space around panes. */
export function buildBackgroundMenu(groupId: string): MenuItem[] {
  const loc = findGroup(groupId);
  if (!loc) return [];
  return [
    newSessionSubmenu(groupId),
    { label: "Launch formation here…", onSelect: () => useMission.getState().openFormation({ groupId }) },
    layoutSubmenu(groupId, loc.group.layout.preset),
    "separator",
    { label: "Message all in group…", disabled: loc.group.sessionIds.length === 0, onSelect: () => messageSessions(groupSessionIds(groupId), `“${loc.group.name}”`) },
    { label: "Mission Control", hint: shortcutHint("view.mission"), onSelect: () => useMission.getState().toggle(true) },
    { label: "Fleet overview", hint: shortcutHint("view.fleet"), onSelect: () => runCommand("view.fleet") },
  ];
}
