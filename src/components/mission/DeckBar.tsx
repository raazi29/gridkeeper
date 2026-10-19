// The deck bar under Mission Control's header: filter chips by role and state (matching agents stay lit, the rest
// dim), the active spotlight, the board's column mode, find (Ctrl/⌘+F) and the shortcut sheet (?).

import { memo } from "react";
import { isMac } from "../../lib/platform";
import { roleInfo } from "../../lib/roles";
import { useDeck } from "../../store/missionDeck";
import { filtersActive, STATE_CHIPS, toggleIn, type McView, type StateChip } from "./deck";
import { IcSearch, IcSpot } from "./mcIcons";
import { T } from "./mcText";
import { roleStyle } from "./RoleTag";

export interface DeckBarProps {
  view: McView;
  /** Role chip keys present ("" = agents without a role), in legend order. */
  roles: string[];
  roleCounts: Record<string, number>;
  stateCounts: Record<StateChip, number>;
  /** What the spotlight shows, e.g. "lane Build" / "builder-1"; null = none. */
  spotlightLabel: string | null;
}

export const DeckBar = memo(function DeckBar({ view, roles, roleCounts, stateCounts, spotlightLabel }: DeckBarProps) {
  const filters = useDeck((s) => s.filters);
  const boardBy = useDeck((s) => s.boardBy);
  const set = useDeck((s) => s.set);
  const active = filtersActive(filters);
  return (
    <div className="mc-deck" role="toolbar" aria-label={T.deck.filters}>
      <span className="mc-micro mc-deck-label" title={T.deck.filters}>
        {T.deck.filter}
      </span>
      <div className="mc-chips" role="group" aria-label="Roles">
        {roles.map((r) => {
          const on = filters.roles.includes(r);
          return (
            <button
              key={r || "_none"}
              type="button"
              className={`mc-chip-f is-role${on ? " is-on" : ""}`}
              style={roleStyle(r || null)}
              aria-pressed={on}
              title={T.deck.roleChip(r)}
              onClick={() => set({ filters: { ...filters, roles: toggleIn(filters.roles, r) } })}
            >
              <span className="mc-chip-f-sq" />
              {r ? (roleInfo(r)?.id ?? r) : T.deck.noRole}
              <span className="mc-chip-f-n">{roleCounts[r] ?? 0}</span>
            </button>
          );
        })}
      </div>
      <span className="mc-deck-sep" aria-hidden="true" />
      <div className="mc-chips" role="group" aria-label="States">
        {STATE_CHIPS.map((st) => {
          const on = filters.states.includes(st);
          return (
            <button
              key={st}
              type="button"
              className={`mc-chip-f is-state is-${st}${on ? " is-on" : ""}`}
              aria-pressed={on}
              disabled={!on && !stateCounts[st]}
              onClick={() => set({ filters: { ...filters, states: toggleIn(filters.states, st) } })}
            >
              <span className="mc-chip-f-dot" />
              {T.deck.states[st]}
              <span className="mc-chip-f-n">{stateCounts[st] ?? 0}</span>
            </button>
          );
        })}
      </div>
      {active && (
        <button type="button" className="mc-chip-f is-clear" onClick={() => set({ filters: { roles: [], states: [] } })}>
          {T.deck.clearFilters} ✕
        </button>
      )}
      {spotlightLabel && (
        <button type="button" className="mc-chip-f is-spot is-on" title={T.deck.spotlightClear} onClick={() => set({ spotlight: null })}>
          <IcSpot size={11} />
          {T.deck.spotlight(spotlightLabel)} ✕
        </button>
      )}
      <span className="mc-spacer" />
      {view === "board" && (
        <div className="mc-seg mc-deck-seg" role="radiogroup" aria-label={T.deck.boardBy}>
          <span className="mc-micro mc-deck-seg-label">{T.deck.boardBy}</span>
          <button type="button" role="radio" aria-checked={boardBy === "agent"} onClick={() => set({ boardBy: "agent" })}>
            {T.deck.byAgent}
          </button>
          <button type="button" role="radio" aria-checked={boardBy === "lane"} onClick={() => set({ boardBy: "lane" })}>
            {T.deck.byLane}
          </button>
        </div>
      )}
      <button type="button" className="mc-btn mc-deck-find" title={T.deck.findHint} onClick={() => set({ findOpen: true })}>
        <IcSearch size={11} />
        {T.deck.find}
        <kbd>{isMac ? "⌘F" : "ctrl F"}</kbd>
      </button>
      <button type="button" className="mc-btn mc-btn-icon" title={T.deck.help} aria-label={T.deck.help} onClick={() => set({ sheetOpen: true })}>
        ?
      </button>
    </div>
  );
});
