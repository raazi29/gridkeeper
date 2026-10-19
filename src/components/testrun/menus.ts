// Menu entries for test runs, used by the session menu, the lane / group menu and the workspace menu.

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
  const t = sessionTarget(id);
  if (!t) return [];
  const run = latestRunFor(useTestRuns.getState(), t.path);
  const items: MenuItem[] = [];
  if (run && isActiveStatus(run.status)) items.push({ label: "Cancel tests", onSelect: () => void cancelTestRun(run.id) });
  else items.push({ label: "Run tests", hint: "in its worktree", onSelect: () => void runTestsForSession(id) });
  if (run) items.push({ label: "Test log", onSelect: () => openTestLog(run.id) });
  return items;
}

/** "Tests" submenu of a lane / group: "Test lane" (each member's worktree) and the lane's test command. */
export function laneTestsSubmenu(groupId: string): MenuItem {
  const n = laneTargets(groupId).length;
  return {
    label: "Tests",
    children: [
      { label: n > 1 ? `Test lane (${n} folders)` : "Test lane", disabled: n === 0, onSelect: () => void runTestsForLane(groupId) },
      { label: "Lane test command…", onSelect: () => openLaneCommandDialog(groupId) },
    ],
  };
}

/** "Test command…" for a workspace (sidebar row menu). */
export function workspaceTestMenuItem(workspaceId: string): MenuItem {
  const ws = useApp.getState().persisted.workspaces.find((w) => w.id === workspaceId);
  const cmd = ws?.testCommand?.trim();
  const hint = cmd ? (cmd.length > 24 ? `${cmd.slice(0, 23)}…` : cmd) : "auto-detect";
  return { label: "Test command…", hint, onSelect: () => openTestCommandDialog({ workspaceId }) };
}
