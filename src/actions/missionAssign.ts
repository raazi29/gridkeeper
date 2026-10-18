// Assign a mission task to a session: dropping a board task on a session card (the cards' drop handler calls
// assignTaskToSession). Adds the session's owner slug (its name, slugified) to that task line in the
// workspace's mission.md; the task keeps its other owners and its state. Conflict-checked write (an agent's
// concurrent edit is never overwritten) and a toast with Undo. Nothing is typed into any agent.

import { currentTaskDrag } from "../components/mission/mcDrag";
import { addTaskOwner, parseMission, slugify } from "../lib/missionDoc";
import type { SessionId } from "../lib/types";
import { useApp } from "../store/appStore";
import { dirKey, editMission, useMissionDocs } from "../store/missionDoc";
import { notify } from "./notify";

/** Project folder of the workspace that holds `sessionId` (else the active workspace's). */
export function projectDirOfSession(sessionId: SessionId): string | null {
  const p = useApp.getState().persisted;
  const ws = p.workspaces.find((w) => w.groups.some((g) => g.sessionIds.includes(sessionId))) ?? p.workspaces.find((w) => w.id === p.activeWorkspaceId);
  return ws?.projectDir ?? null;
}

/** The mission store's key for `dir` (the board's own spelling of the folder), or `dir` itself. */
function storeKey(dir: string): string {
  const byDir = useMissionDocs.getState().byDir;
  if (byDir[dir]) return dir;
  const k = dirKey(dir);
  return Object.keys(byDir).find((d) => dirKey(d) === k && byDir[d]?.file) ?? dir;
}

/**
 * Add the session as an owner of the task on `line`. `expectText` (default: the task being dragged, when
 * it is that line) guards against a line that moved since the board rendered it.
 */
export async function assignTaskToSession(sessionId: SessionId, line: number, expectText?: string): Promise<void> {
  const meta = useApp.getState().persisted.sessions.find((m) => m.id === sessionId);
  if (!meta) return;
  const slug = slugify(meta.name);
  if (!slug) {
    notify("warn", `Can't assign to “${meta.name}”: the name has no letters or digits for an @owner tag — rename the session first`);
    return;
  }
  const dir = projectDirOfSession(sessionId);
  if (!dir) {
    notify("warn", "This workspace has no project folder, so it has no mission file");
    return;
  }
  const key = storeKey(dir);
  const file = useMissionDocs.getState().byDir[key]?.file;
  if (!file?.exists) {
    notify("warn", "No mission file yet — set a mission first");
    return;
  }
  const drag = currentTaskDrag();
  const text = expectText ?? (drag && drag.line === line ? drag.text : undefined);
  const task = parseMission(file.text).tasks.find((t) => t.line === line);
  if (task && task.owners.includes(slug) && (text === undefined || task.text === text)) {
    notify("info", `${meta.name} already owns “${task.text}”`);
    return;
  }
  await editMission(key, (t) => addTaskOwner(t, line, slug), {
    undo: `Assigned to ${meta.name}`,
    expect: text !== undefined ? { line, text } : undefined,
  });
}
