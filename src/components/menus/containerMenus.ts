// Context menus for containers: a group tab (also Mission Control lane headers), a sidebar workspace
// row (extra items) and the empty grid background.

import { deleteGroupFlow, runCommand, switchWorkspace } from "../../actions/commands";
import { closeSessions, groupSessionIds, messageSessions, restartSessions, stopSessions, workspaceSessionIds } from "../../actions/groupActions";
import { isWorkspaceMuted, toggleWorkspaceMute } from "../../actions/notifyPrefs";
import { useApp } from "../../store/appStore";
import { useMission } from "../../store/mission";
import type { MenuItem } from "../ui/Menu";
import { t } from "../../i18n";
import { laneTestsSubmenu, workspaceTestMenuItem } from "../testrun/menus";
import { formationItem, layoutSubmenu, newSessionSubmenu, shortcutHint } from "./common";

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
  if (!loc) return [{ label: t("menu.group.notFound"), disabled: true }];
  const { ws, group } = loc;
  const what = t("menu.quoted", { name: group.name });
  const empty = group.sessionIds.length === 0;
  return [
    ...(ctx.onRename ? [{ label: t("common.rename"), hint: "F2", onSelect: ctx.onRename } as MenuItem] : []),
    newSessionSubmenu(groupId),
    formationItem(groupId),
    layoutSubmenu(groupId, group.layout.preset),
    "separator",
    { label: t("menu.group.messageAll"), disabled: empty, onSelect: () => messageSessions(groupSessionIds(groupId), what) },
    { label: t("menu.group.restartAll"), disabled: empty, onSelect: () => void restartSessions(groupSessionIds(groupId), what) },
    { label: t("menu.group.stopAll"), disabled: empty, onSelect: () => void stopSessions(groupSessionIds(groupId), what) },
    laneTestsSubmenu(groupId),
    "separator",
    { label: t("menu.group.closeAll"), danger: true, disabled: empty, onSelect: () => void closeSessions(groupSessionIds(groupId), what) },
    { label: t("menu.group.delete"), danger: true, disabled: ws.groups.length <= 1, onSelect: () => void deleteGroupFlow(groupId) },
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
      label: t("menu.workspace.openMission"),
      hint: shortcutHint("view.mission"),
      onSelect: () => {
        switchWorkspace(workspaceId);
        useMission.getState().toggle(true);
      },
    },
    { label: muted ? t("menu.unmuteNotifications") : t("menu.muteNotifications"), checked: muted, hint: t("menu.workspace.muteHint"), onSelect: () => toggleWorkspaceMute(workspaceId) },
    { label: t("menu.workspace.stopAll"), disabled: !hasSessions, onSelect: () => void stopSessions(workspaceSessionIds(workspaceId), t("menu.quoted", { name: ws.name })) },
    workspaceTestMenuItem(workspaceId),
  ];
}

/** Right-click on an empty grid / the space around panes. */
export function buildBackgroundMenu(groupId: string): MenuItem[] {
  const loc = findGroup(groupId);
  if (!loc) return [];
  return [
    newSessionSubmenu(groupId),
    formationItem(groupId),
    layoutSubmenu(groupId, loc.group.layout.preset),
    "separator",
    { label: t("menu.group.messageAll"), disabled: loc.group.sessionIds.length === 0, onSelect: () => messageSessions(groupSessionIds(groupId), t("menu.quoted", { name: loc.group.name })) },
    { label: t("menu.missionControl"), hint: shortcutHint("view.mission"), onSelect: () => useMission.getState().toggle(true) },
    { label: t("menu.fleetOverview"), hint: shortcutHint("view.fleet"), onSelect: () => runCommand("view.fleet") },
  ];
}
