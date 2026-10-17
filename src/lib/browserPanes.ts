// Pane kinds (pure helpers). Browser panes have no process: everything that means "processes"
// (running counts, Fleet tiles, broadcast targets, auto-start, Mission Control members) uses
// terminal panes only.

import type { PaneKind, SessionId, SessionMeta, SessionPort } from "./types";
import { localPortOf } from "./url";

export const paneKind = (m: Pick<SessionMeta, "kind"> | undefined | null): PaneKind => m?.kind ?? "terminal";
export const isBrowserMeta = (m: Pick<SessionMeta, "kind"> | undefined | null): boolean => paneKind(m) === "browser";
export const isTerminalMeta = (m: Pick<SessionMeta, "kind"> | undefined | null): boolean => !!m && paneKind(m) === "terminal";

/** Ids of panes backed by a process, in the given order (unknown ids are dropped). */
export function processSessionIds(ids: SessionId[], metas: ReadonlyMap<SessionId, Pick<SessionMeta, "kind">>): SessionId[] {
  return ids.filter((id) => isTerminalMeta(metas.get(id)));
}

/** Metas that may be started automatically on restore. */
export function autoStartable<T extends Pick<SessionMeta, "kind" | "autoStart">>(metas: T[]): T[] {
  return metas.filter((m) => m.autoStart && paneKind(m) === "terminal");
}

/** A browser pane among `ids` already showing local `port`, if any. */
export function browserPaneForPort(
  port: number,
  ids: SessionId[],
  metas: ReadonlyMap<SessionId, Pick<SessionMeta, "kind" | "url">>,
): SessionId | null {
  for (const id of ids) {
    const m = metas.get(id);
    if (m && isBrowserMeta(m) && localPortOf(m.url) === port) return id;
  }
  return null;
}

/** Header chip text for a session's listening ports: ":5173" or ":5173 +2". */
export function portChipLabel(ports: SessionPort[] | undefined): string | null {
  if (!ports || ports.length === 0) return null;
  return ports.length === 1 ? `:${ports[0].port}` : `:${ports[0].port} +${ports.length - 1}`;
}
