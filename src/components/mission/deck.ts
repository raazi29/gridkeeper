// Mission Control "deck" rules, pure (unit-tested): filter chips (role, state), the spotlight, pinned-first card
// order and view keys. A card is dimmed when it is outside the spotlight or does not match the active filters;
// nothing is hidden in the graph (lines and drop targets stay where they are).

import type { SessionId } from "../../lib/types";
import type { FleetLamp } from "../util/fleet";

export type McView = "graph" | "board" | "timeline" | "list";
export const VIEWS: readonly McView[] = ["graph", "board", "timeline", "list"];

/** State chips: what the user filters by (several lamps fold into one chip). */
export type StateChip = "working" | "needs" | "done" | "idle" | "error";
export const STATE_CHIPS: readonly StateChip[] = ["working", "needs", "done", "idle", "error"];

export function stateChipOf(lamp: FleetLamp): StateChip {
  switch (lamp) {
    case "working":
      return "working";
    case "waiting":
      return "needs";
    case "done":
      return "done";
    case "error":
      return "error";
    default:
      return "idle"; // idle, exited, not started
  }
}

export interface DeckFilters {
  roles: string[];
  states: StateChip[];
}

export const NO_FILTERS: DeckFilters = { roles: [], states: [] };

export function filtersActive(f: DeckFilters): boolean {
  return f.roles.length > 0 || f.states.length > 0;
}

/** Role chip key: the role, or "" for agents without one. */
export function roleKey(role: string | null | undefined): string {
  return role ?? "";
}

/** Both chip groups must match when both are set; within a group any chip matches. */
export function matchesFilters(f: DeckFilters, role: string | null | undefined, lamp: FleetLamp): boolean {
  if (f.roles.length && !f.roles.includes(roleKey(role))) return false;
  if (f.states.length && !f.states.includes(stateChipOf(lamp))) return false;
  return true;
}

export function toggleIn<T>(list: readonly T[], v: T): T[] {
  return list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
}

export type Spotlight = { kind: "lane"; id: string } | { kind: "agent"; id: SessionId } | null;

/** Is the card lit by the spotlight (no spotlight = everything is)? `lane` = the card's group id (or "lead"). */
export function inSpotlight(s: Spotlight, id: SessionId, lane: string | null): boolean {
  if (!s) return true;
  return s.kind === "agent" ? s.id === id : s.id === lane;
}

/** Same spotlight again turns it off. */
export function toggleSpotlight(cur: Spotlight, next: NonNullable<Spotlight>): Spotlight {
  return cur && cur.kind === next.kind && cur.id === next.id ? null : next;
}

/** Pinned cards first (in their own order), then the rest; stable. Returns `ids` itself when nothing moves. */
export function pinnedFirst(ids: readonly SessionId[], pinned: readonly SessionId[]): SessionId[] {
  if (!pinned.length) return ids as SessionId[];
  const top = ids.filter((id) => pinned.includes(id));
  if (!top.length) return ids as SessionId[];
  const out = [...top, ...ids.filter((id) => !pinned.includes(id))];
  return out.every((id, i) => id === ids[i]) ? (ids as SessionId[]) : out;
}

/** View for the number keys 1–4, or null. */
export function viewForKey(key: string): McView | null {
  const i = ["1", "2", "3", "4"].indexOf(key);
  return i < 0 ? null : VIEWS[i];
}
