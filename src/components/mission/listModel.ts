// Mission Control list view, pure (unit-tested): one row per agent and the column sort. Empty values (no data)
// always sort last, whichever the direction; ties keep the cards' display order.

import type { TaskState } from "../../lib/missionDoc";
import type { SessionId } from "../../lib/types";
import type { FleetLamp } from "../util/fleet";

export interface ListRow {
  id: SessionId;
  /** Display order in the graph (lead box, then lanes): the tie-breaker. */
  order: number;
  name: string;
  role: string | null;
  lane: string;
  lamp: FleetLamp;
  /** ms epoch since the current state, null when not running. */
  since: number | null;
  task: string | null;
  taskState: TaskState | null;
  branch: string | null;
  /** Evidence summary line (sign-off cache), "" when unknown. */
  evidence: string;
  cost: number | null;
  ctx: number | null;
  cpu: number | null;
  ram: number | null;
  out: number | null;
}

export type SortKey = "name" | "role" | "lane" | "state" | "since" | "task" | "branch" | "cost" | "ctx" | "cpu" | "ram" | "out";
export type SortDir = "asc" | "desc";

/** What needs a human first. */
const STATE_RANK: Record<FleetLamp, number> = { waiting: 0, error: 1, working: 2, done: 3, idle: 4, exited: 5, stopped: 6 };

export function stateRank(l: FleetLamp): number {
  return STATE_RANK[l] ?? 9;
}

type Val = string | number | null;

function valueOf(r: ListRow, key: SortKey): Val {
  switch (key) {
    case "name":
      return r.name.toLowerCase();
    case "role":
      return r.role ? r.role.toLowerCase() : null;
    case "lane":
      return r.lane.toLowerCase();
    case "state":
      return stateRank(r.lamp);
    case "since":
      return r.since;
    case "task":
      return r.task ? r.task.toLowerCase() : null;
    case "branch":
      return r.branch ? r.branch.toLowerCase() : null;
    default:
      return r[key];
  }
}

/** Sorted copy. "since" ascending = longest in its state first (oldest timestamp). */
export function sortRows(rows: readonly ListRow[], key: SortKey, dir: SortDir): ListRow[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const va = valueOf(a, key);
    const vb = valueOf(b, key);
    if (va === null || vb === null) return va === vb ? a.order - b.order : va === null ? 1 : -1;
    const c = typeof va === "number" && typeof vb === "number" ? va - vb : String(va).localeCompare(String(vb), undefined, { numeric: true });
    return c !== 0 ? c * sign : a.order - b.order;
  });
}

/** Header click: same column flips the direction, a new one starts with its natural direction. */
export function nextSort(cur: { key: SortKey; dir: SortDir }, key: SortKey): { key: SortKey; dir: SortDir } {
  if (cur.key === key) return { key, dir: cur.dir === "asc" ? "desc" : "asc" };
  const numericDesc: SortKey[] = ["cost", "ctx", "cpu", "ram", "out"];
  return { key, dir: numericDesc.includes(key) ? "desc" : "asc" };
}
