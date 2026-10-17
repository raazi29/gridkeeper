// Actions on a set of sessions (a group / Mission Control lane / workspace): message, restart, stop,
// close. Target selection is pure and unit-tested; every bulk action asks for confirmation first and
// nothing is ever typed into an agent without the user pressing Send in the Broadcast composer.

import type { SessionId, SessionInfo, SessionMeta } from "../lib/types";
import { isLive, useApp } from "../store/appStore";
import { useAttentionUi } from "../store/attention";
import { confirmDialog } from "../store/uiStore";
import { notify } from "./notify";
import { closeSession, restartSession, stopSession } from "./sessions";

type MetaLike = Pick<SessionMeta, "id"> & { kind?: string | null };

/** Panes that are not terminal sessions (e.g. browser panes) never receive input or lifecycle actions. */
export function isTerminalSession(meta: MetaLike | undefined): boolean {
  return !!meta && (meta.kind === undefined || meta.kind === null || meta.kind === "terminal");
}

function metaMap(metas: readonly MetaLike[]): Map<SessionId, MetaLike> {
  return new Map(metas.map((m) => [m.id, m]));
}

/** Live terminal sessions among `ids` (message / stop targets), in order. */
export function liveTargets(ids: readonly SessionId[], metas: readonly MetaLike[], runtime: Record<SessionId, SessionInfo | undefined>): SessionId[] {
  const byId = metaMap(metas);
  return ids.filter((id) => isTerminalSession(byId.get(id)) && isLive(runtime[id]));
}

/** Terminal sessions among `ids` that have run in this app run (live, exited or failed): restart targets. */
export function restartTargets(ids: readonly SessionId[], metas: readonly MetaLike[], runtime: Record<SessionId, SessionInfo | undefined>): SessionId[] {
  const byId = metaMap(metas);
  return ids.filter((id) => isTerminalSession(byId.get(id)) && !!runtime[id]);
}

/** Terminal sessions among `ids` (close targets; browser panes are closed by their own UI). */
export function terminalTargets(ids: readonly SessionId[], metas: readonly MetaLike[]): SessionId[] {
  const byId = metaMap(metas);
  return ids.filter((id) => isTerminalSession(byId.get(id)));
}

function snapshot() {
  const s = useApp.getState();
  return { metas: s.persisted.sessions as MetaLike[], runtime: s.runtime };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Open the Broadcast composer preselected with the live sessions among `ids`. Sends nothing by itself. */
export function messageSessions(ids: readonly SessionId[], what = "this lane"): void {
  const { metas, runtime } = snapshot();
  const targets = liveTargets(ids, metas, runtime);
  if (targets.length === 0) {
    notify("info", `No running sessions in ${what}`);
    return;
  }
  useAttentionUi.getState().openBroadcast(targets);
}

export async function restartSessions(ids: readonly SessionId[], what: string): Promise<void> {
  const { metas, runtime } = snapshot();
  const targets = restartTargets(ids, metas, runtime);
  if (targets.length === 0) {
    notify("info", `Nothing to restart in ${what}`);
    return;
  }
  const live = targets.filter((id) => isLive(runtime[id])).length;
  const ok = await confirmDialog({
    title: `Restart ${plural(targets.length, "session")} in ${what}?`,
    message:
      (live ? `${plural(live, "running process", "running processes")} will be stopped and started again. ` : "") +
      "Agents resume their conversation where they support it.",
    confirmLabel: "Restart",
    danger: live > 0,
  });
  if (!ok) return;
  await Promise.all(targets.map((id) => restartSession(id, { mode: "continue" }).catch(() => false)));
}

export async function stopSessions(ids: readonly SessionId[], what: string): Promise<void> {
  const { metas, runtime } = snapshot();
  const targets = liveTargets(ids, metas, runtime);
  if (targets.length === 0) {
    notify("info", `No running sessions in ${what}`);
    return;
  }
  const ok = await confirmDialog({
    title: `Stop ${plural(targets.length, "session")} in ${what}?`,
    message: "Each process is asked to exit. The panes stay; start them again any time.",
    confirmLabel: "Stop",
    danger: true,
  });
  if (!ok) return;
  await Promise.all(targets.map((id) => stopSession(id, false)));
}

export async function closeSessions(ids: readonly SessionId[], what: string): Promise<void> {
  const { metas, runtime } = snapshot();
  const targets = terminalTargets(ids, metas);
  if (targets.length === 0) return;
  const live = targets.filter((id) => isLive(runtime[id])).length;
  const ok = await confirmDialog({
    title: `Close ${plural(targets.length, "session")} in ${what}?`,
    message: (live ? `${plural(live, "running process", "running processes")} will be stopped. ` : "") + "The panes and their session definitions are removed.",
    confirmLabel: live ? "Stop and close" : "Close",
    danger: true,
  });
  if (!ok) return;
  await Promise.all(targets.map((id) => closeSession(id).catch(() => {})));
}

/** Session ids of a group (any workspace). */
export function groupSessionIds(groupId: string): SessionId[] {
  for (const w of useApp.getState().persisted.workspaces) for (const g of w.groups) if (g.id === groupId) return [...g.sessionIds];
  return [];
}

export function workspaceSessionIds(workspaceId: string): SessionId[] {
  const ws = useApp.getState().persisted.workspaces.find((w) => w.id === workspaceId);
  return ws ? ws.groups.flatMap((g) => g.sessionIds) : [];
}
