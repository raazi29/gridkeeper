// "?" in Mission Control: a compact sheet of every key and gesture, grouped. Esc, ? or a click outside closes it.

import { useEffect, useRef } from "react";
import { isMac } from "../../lib/platform";
import { useDeck } from "../../store/missionDeck";
import { T } from "./mcText";

const MOD = isMac ? "⌘" : "Ctrl";

const GROUPS: { title: string; rows: [string, string][] }[] = [
  {
    title: "select & move",
    rows: [
      ["← ↑ ↓ →", "select a card"],
      ["Home / End", "first / last card"],
      ["click", "select (opens the agent panel)"],
      [`${MOD}+click`, "add / remove from the selection"],
      ["Shift+click · Shift+← →", "select a range"],
      [`${MOD}+A`, "select every card"],
      ["Shift+drag · select tool", "box-select on the empty canvas"],
      ["Enter · double-click", "jump to the pane"],
      ["Alt+← →", "reorder the card in its lane"],
      ["Alt+↑ ↓", "move the card to the previous / next lane"],
    ],
  },
  {
    title: "canvas",
    rows: [
      [`${MOD}+wheel · pinch`, "zoom around the pointer"],
      ["+ / −", "zoom in / out"],
      ["0", "100 %"],
      ["F", "fit to screen"],
      ["wheel · Space+drag", "pan"],
      ["middle-drag · drag empty canvas", "pan"],
      ["H / V", "hand / select tool"],
      ["Shift+M", "minimap"],
    ],
  },
  {
    title: "act on the selected card",
    rows: [
      ["R", "restart"],
      ["S", "stop / start"],
      ["M", "message… (several selected: all of them)"],
      ["Del", "close"],
      ["F2", "rename"],
      ["P", "pin to the top of its lane"],
      ["Shift+F10", "menu"],
    ],
  },
  {
    title: "views & focus",
    rows: [
      ["1 · 2 · 3 · 4", "graph · board · timeline · list"],
      [`${MOD}+F`, "find agents and tasks"],
      [".", "spotlight the selected agent"],
      ["click a lane name", "spotlight the lane"],
      ["I", "agent panel"],
      ["?", "this sheet"],
      ["Esc", "clear find, selection, spotlight, then close"],
    ],
  },
  {
    title: "board view (on a task)",
    rows: [
      ["↑ ↓ ← →", "move between tasks"],
      ["Space", "next state"],
      ["Alt+← →", "give it to the neighbouring agent"],
      ["Enter", "select its agent"],
      ["drag", "reassign"],
    ],
  },
];

export function ShortcutSheet() {
  const set = useDeck((s) => s.set);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    root.current?.focus();
  }, []);
  const close = () => {
    set({ sheetOpen: false });
    requestAnimationFrame(() => document.querySelector<HTMLElement>(".mc")?.focus({ preventScroll: true }));
  };
  return (
    <div className="mc-sheet-back" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div
        ref={root}
        className="mc-sheet"
        role="dialog"
        aria-label={T.sheet.title}
        tabIndex={-1}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape" || e.key === "?") {
            e.preventDefault();
            close();
          }
        }}
      >
        <div className="mc-sheet-head">
          <span className="mc-micro">{T.sheet.title}</span>
          <button type="button" className="mc-btn mc-btn-icon" title={T.sheet.close} aria-label={T.sheet.close} onClick={close}>
            ✕
          </button>
        </div>
        <div className="mc-sheet-grid">
          {GROUPS.map((g) => (
            <section key={g.title} className="mc-sheet-group">
              <h4 className="mc-micro">{g.title}</h4>
              <dl>
                {g.rows.map(([k, v]) => (
                  <div key={k} className="mc-sheet-row">
                    <dt>
                      <kbd>{k}</kbd>
                    </dt>
                    <dd>{v}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
