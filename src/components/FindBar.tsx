// Compact find-in-terminal overlay for one pane (command `terminal.find`).
// Enter / Shift+Enter (or F3 / Shift+F3) = next / previous; Esc closes and refocuses the terminal.

import { memo, useEffect, useRef, useState } from "react";
import type { SessionId } from "../lib/types";
import { useFind } from "../store/findStore";
import { findKeyAction, findLabel, queryError, type FindResults } from "../terminal/findState";
import { clearSearch, findInTerminal, focusTerminal, onSearchResults } from "../terminal/registry";
import "../styles/tools.css";

export const FindBar = memo(function FindBar({ sessionId }: { sessionId: SessionId }) {
  const nonce = useFind((s) => s.nonce);
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regex, setRegex] = useState(false);
  const [found, setFound] = useState<boolean | null>(null);
  const [results, setResults] = useState<FindResults | null>(null);

  // (Re)focus and select on every open request.
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [nonce]);

  useEffect(() => onSearchResults(sessionId, setResults), [sessionId]);

  // Clear highlights when the bar goes away.
  useEffect(() => () => clearSearch(sessionId), [sessionId]);

  const run = (dir: "next" | "prev", incremental = false, q = query, cs = caseSensitive, re = regex) => {
    if (!q || queryError(q, re)) {
      clearSearch(sessionId);
      setFound(null);
      setResults(null);
      return;
    }
    setFound(findInTerminal(sessionId, q, dir, { caseSensitive: cs, regex: re, incremental }));
  };

  const close = () => {
    useFind.getState().close();
    focusTerminal(sessionId);
  };

  const label = findLabel({ query, regex, found, results });
  const miss = !!query && (label === "No results" || label === "Invalid regex");

  return (
    <div className="findbar" role="search" onMouseDown={(e) => e.stopPropagation()}>
      <input
        ref={input}
        className={`findbar-input${miss ? " is-miss" : ""}`}
        value={query}
        placeholder="Find"
        aria-label="Find in terminal"
        spellCheck={false}
        onChange={(e) => {
          const q = e.currentTarget.value;
          setQuery(q);
          run("next", true, q);
        }}
        onKeyDown={(e) => {
          const a = findKeyAction(e);
          if (!a) return;
          e.preventDefault();
          e.stopPropagation();
          if (a === "close") close();
          else run(a);
        }}
      />
      <span className="findbar-count" aria-live="polite">
        {label}
      </span>
      <button
        type="button"
        className={`findbar-btn${caseSensitive ? " is-on" : ""}`}
        aria-pressed={caseSensitive}
        title="Match case"
        onClick={() => {
          setCaseSensitive(!caseSensitive);
          run("next", true, query, !caseSensitive);
          input.current?.focus();
        }}
      >
        Aa
      </button>
      <button
        type="button"
        className={`findbar-btn${regex ? " is-on" : ""}`}
        aria-pressed={regex}
        title="Regular expression"
        onClick={() => {
          setRegex(!regex);
          run("next", true, query, caseSensitive, !regex);
          input.current?.focus();
        }}
      >
        .*
      </button>
      <button type="button" className="findbar-btn" title="Previous match (Shift+Enter)" aria-label="Previous match" onClick={() => run("prev")}>
        ↑
      </button>
      <button type="button" className="findbar-btn" title="Next match (Enter)" aria-label="Next match" onClick={() => run("next")}>
        ↓
      </button>
      <button type="button" className="findbar-btn" title="Close (Esc)" aria-label="Close find" onClick={close}>
        ✕
      </button>
    </div>
  );
});

/** Mount point used by Pane: renders the bar only for the pane it was opened on. */
export function PaneFindBar({ sessionId }: { sessionId: SessionId }) {
  const open = useFind((s) => s.sessionId === sessionId);
  return open ? <FindBar sessionId={sessionId} /> : null;
}
