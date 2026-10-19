// Menu entries for test runs, used by the session menu, the lane / group menu and the workspace menu.

import { t } from "../../i18n";
import type { SessionId } from "../../lib/types";
import { useApp } from "../../store/appStore";
import {
  cancelTestRun,
  laneTargets,
  latestRunFor,
  openLaneCommandDialog,
  openTestCommandDialog,
  openTestLog,
  runTestsForLane,
  runTestsForSession,
  sessionTarget,
  useTestRuns,
} from "../../store/testrun";
import type { MenuItem } from "../ui/Menu";
import { isActiveStatus } from "./format";

/** "Run tests" (+ "Test log" / "Cancel tests" when the folder has a run) for a terminal session. */
export function testRunMenuItems(id: SessionId): MenuItem[] {
  const target = sessionTarget(id);
  if (!target) return [];
  const run = latestRunFor(useTestRuns.getState(), target.path);
  const items: MenuItem[] = [];
  if (run && isActiveStatus(run.status)) items.push({ label: t("testrun.menu.cancel"), onSelect: () => void cancelTestRun(run.id) });
  else items.push({ label: t("testrun.menu.run"), hint: t("testrun.menu.runHint"), onSelect: () => void runTestsForSession(id) });
  if (run) items.push({ label: t("testrun.menu.log"), onSelect: () => openTestLog(run.id) });
  return items;
}

/** "Tests" submenu of a lane / group: "Test lane" (each member's worktree) and the lane's test command. */
export function laneTestsSubmenu(groupId: string): MenuItem {
  const n = laneTargets(groupId).length;
  return {
    label: t("testrun.menu.tests"),
    children: [
      { label: n > 1 ? t("testrun.menu.testLaneCount", { count: n }) : t("testrun.menu.testLane"), disabled: n === 0, onSelect: () => void runTestsForLane(groupId) },
      { label: t("testrun.menu.laneCommand"), onSelect: () => openLaneCommandDialog(groupId) },
    ],
  };
}

/** "Test command…" for a workspace (sidebar row menu). */
export function workspaceTestMenuItem(workspaceId: string): MenuItem {
  const ws = useApp.getState().persisted.workspaces.find((w) => w.id === workspaceId);
  const cmd = ws?.testCommand?.trim();
  const hint = cmd ? (cmd.length > 24 ? `${cmd.slice(0, 23)}…` : cmd) : t("testrun.cmd.autoDetect");
  return { label: t("testrun.menu.command"), hint, onSelect: () => openTestCommandDialog({ workspaceId }) };
}
