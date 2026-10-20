// Mission Control "deck" state: the view (graph / board / timeline / list), canvas tool, minimap, starfield,
// agent panel, pins (kept on this device in localStorage, best effort) and the per-open state (selection,
// spotlight, filter chips, find, shortcut sheet). A separate small store so cards subscribe to one boolean each.
// Pure rules live in components/mission/deck.ts and selection.ts.

import { create } from "zustand";
import { NO_FILTERS, type DeckFilters, type McView, type Spotlight } from "../components/mission/deck";
import { EMPTY_SELECTION, type Selection } from "../components/mission/selection";
import type { SessionId } from "../lib/types";

const LS_KEY = "gridkeeper.mc.deck";

export type CanvasTool = "pan" | "select";
/** auto = closed until a card is clicked; open; closed = the user closed it (clicks keep it closed). */
export type PanelMode = "auto" | "open" | "closed";
export type BoardBy = "agent" | "lane";

export const PANEL_MIN = 280;
export const PANEL_MAX = 560;
export const PANEL_DEFAULT = 340;

interface Stored {
  view: McView;
  tool: CanvasTool;
  minimap: boolean;
  starfield: boolean;
  panel: PanelMode;
  panelWidth: number;
  boardBy: BoardBy;
  /** Pinned session ids per workspace id. */
  pinned: Record<string, SessionId[]>;
}

const DEFAULTS: Stored = { view: "graph", tool: "pan", minimap: false, starfield: false, panel: "auto", panelWidth: PANEL_DEFAULT, boardBy: "agent", pinned: {} };

export function clampPanelWidth(w: number): number {
  return Math.round(Math.min(PANEL_MAX, Math.max(PANEL_MIN, Number.isFinite(w) ? w : PANEL_DEFAULT)));
}

function read(): Stored {
  try {
    const raw = globalThis.localStorage?.getItem(LS_KEY);
    if (!raw) return DEFAULTS;
    const v = JSON.parse(raw) as Partial<Stored>;
    return {
      view: v.view === "board" || v.view === "timeline" || v.view === "list" ? v.view : "graph",
      tool: v.tool === "select" ? "select" : "pan",
      minimap: v.minimap === true,
      starfield: v.starfield === true,
      panel: v.panel === "open" || v.panel === "closed" ? v.panel : "auto",
      panelWidth: clampPanelWidth(v.panelWidth ?? PANEL_DEFAULT),
      boardBy: v.boardBy === "lane" ? "lane" : "agent",
      pinned: v.pinned && typeof v.pinned === "object" ? (v.pinned as Record<string, SessionId[]>) : {},
    };
  } catch {
    return DEFAULTS;
  }
}

interface DeckState extends Stored {
  sel: Selection;
  spotlight: Spotlight;
  filters: DeckFilters;
  findOpen: boolean;
  findQuery: string;
  /** Key of the find hit the user is on ("a:<id>" / "t:<line>"), for highlighting. */
  findCurrent: string | null;
  sheetOpen: boolean;
  set: (patch: Partial<Omit<DeckState, "set">>) => void;
  /** Resets the per-open state (selection, spotlight, filters, find) when Mission Control opens. */
  resetOpen: () => void;
}

const STORED_KEYS: (keyof Stored)[] = ["view", "tool", "minimap", "starfield", "panel", "panelWidth", "boardBy", "pinned"];

export const useDeck = create<DeckState>()((set, get) => ({
  ...read(),
  sel: EMPTY_SELECTION,
  spotlight: null,
  filters: NO_FILTERS,
  findOpen: false,
  findQuery: "",
  findCurrent: null,
  sheetOpen: false,
  set: (patch) => {
    set(patch);
    if (!STORED_KEYS.some((k) => k in patch)) return;
    try {
      const s = get();
      const out: Partial<Stored> = {};
      for (const k of STORED_KEYS) (out as Record<string, unknown>)[k] = s[k];
      globalThis.localStorage?.setItem(LS_KEY, JSON.stringify(out));
    } catch {
      /* storage unavailable: the choice lasts for this run */
    }
  },
  resetOpen: () => set({ sel: EMPTY_SELECTION, spotlight: null, filters: NO_FILTERS, findOpen: false, findQuery: "", findCurrent: null, sheetOpen: false }),
}));

const NO_PINS: SessionId[] = [];

/** Pinned ids of a workspace (stable empty array when none). */
export function pinsOf(s: Pick<Stored, "pinned">, wsId: string | null): SessionId[] {
  return (wsId && s.pinned[wsId]) || NO_PINS;
}

export function togglePin(wsId: string | null, id: SessionId): boolean {
  if (!wsId) return false;
  const s = useDeck.getState();
  const cur = pinsOf(s, wsId);
  const on = !cur.includes(id);
  const next = on ? [...cur, id] : cur.filter((x) => x !== id);
  const pinned = { ...s.pinned };
  if (next.length) pinned[wsId] = next;
  else delete pinned[wsId];
  s.set({ pinned });
  return on;
}
