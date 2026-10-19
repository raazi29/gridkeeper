// Find bar (Ctrl/⌘+F in Mission Control): agents and mission tasks, every word must match. Enter / ↓ next,
// Shift+Enter / ↑ previous, Esc closes. The current hit is shown in the active view (selected card, task row…)
// without taking the focus out of the field; the list under the field jumps on click.

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useDeck } from "../../store/missionDeck";
import { stepHit, type FindHit } from "./find";
import { IcSearch } from "./mcIcons";
import { T } from "./mcText";

const SHOWN = 8;

export function FindBar({ hits, onGo }: { hits: FindHit[]; onGo: (hit: FindHit) => void }) {
  const query = useDeck((s) => s.findQuery);
  const current = useDeck((s) => s.findCurrent);
  const set = useDeck((s) => s.set);
  const input = useRef<HTMLInputElement>(null);
  const [listOpen, setListOpen] = useState(true);
  const index = useMemo(() => hits.findIndex((h) => h.key === current), [hits, current]);
  const go = useRef(onGo);
  go.current = onGo;

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  // A new query lands on its first hit.
  useEffect(() => {
    const first = hits[0];
    if (!first) {
      if (current !== null) set({ findCurrent: null });
      return;
    }
    if (!hits.some((h) => h.key === current)) {
      set({ findCurrent: first.key });
      go.current(first);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hits]);

  const step = (dir: 1 | -1) => {
    const i = stepHit(index, hits.length, dir);
    if (i < 0) return;
    set({ findCurrent: hits[i].key });
    onGo(hits[i]);
  };
  const close = () => {
    set({ findOpen: false, findCurrent: null });
    requestAnimationFrame(() => document.querySelector<HTMLElement>(".mc")?.focus({ preventScroll: true }));
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation(); // Mission Control's letter keys never act while typing here
    if (e.key === "Escape") {
      e.preventDefault();
      if (query) set({ findQuery: "" });
      else close();
    } else if (e.key === "Enter" || e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      step(e.key === "ArrowUp" || (e.key === "Enter" && e.shiftKey) ? -1 : 1);
    } else if ((e.ctrlKey || e.metaKey) && (e.key === "f" || e.key === "F")) {
      e.preventDefault();
      input.current?.select();
    }
  };

  const start = Math.max(0, Math.min(index - 2, hits.length - SHOWN));
  const shown = hits.slice(start, start + SHOWN);
  return (
    <div className="mc-find" role="search" onPointerDown={(e) => e.stopPropagation()}>
      <div className="mc-find-row">
        <IcSearch size={12} />
        <input
          ref={input}
          className="mc-find-input"
          value={query}
          spellCheck={false}
          placeholder={T.find.placeholder}
          aria-label={T.find.label}
          aria-controls="mc-find-list"
          onChange={(e) => {
            set({ findQuery: e.target.value });
            setListOpen(true);
          }}
          onKeyDown={onKey}
        />
        <span className={`mc-find-count${query && !hits.length ? " is-none" : ""}`} aria-live="polite">
          {query ? (hits.length ? T.find.count(index, hits.length) : T.find.none) : ""}
        </span>
        <button type="button" className="mc-find-btn" title={T.find.prev} aria-label={T.find.prev} disabled={!hits.length} onClick={() => step(-1)}>
          ↑
        </button>
        <button type="button" className="mc-find-btn" title={T.find.next} aria-label={T.find.next} disabled={!hits.length} onClick={() => step(1)}>
          ↓
        </button>
        <button type="button" className="mc-find-btn" title={T.find.close} aria-label={T.find.close} onClick={close}>
          ✕
        </button>
      </div>
      {listOpen && query && hits.length > 0 && (
        <ul className="mc-find-list" id="mc-find-list" role="listbox" aria-label={T.find.label}>
          {shown.map((h) => (
            <li key={h.key} role="option" aria-selected={h.key === current}>
              <button
                type="button"
                className={`mc-find-hit is-${h.kind}${h.key === current ? " is-current" : ""}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  set({ findCurrent: h.key });
                  onGo(h);
                }}
              >
                <span className="mc-find-kind">{h.kind === "agent" ? T.find.agent : T.find.task}</span>
                <span className="mc-find-label">{h.label}</span>
                <span className="mc-find-detail">{h.detail}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
