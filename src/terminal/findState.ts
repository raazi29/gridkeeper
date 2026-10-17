// Find bar logic (pure; unit-tested): key handling, query validation and the match feedback label.

export interface FindResults {
  /** Active match index, or -1 when the highlight limit was exceeded (SearchAddon semantics). */
  index: number;
  count: number;
}

export interface FindFeedback {
  query: string;
  regex: boolean;
  /** Result of the last findNext/findPrevious, null before the first search. */
  found: boolean | null;
  /** From SearchAddon.onDidChangeResults, null until reported. */
  results: FindResults | null;
}

export type FindKeyAction = "next" | "prev" | "close" | null;

export function findKeyAction(e: { key: string; shiftKey: boolean; ctrlKey?: boolean; altKey?: boolean }): FindKeyAction {
  if (e.key === "Escape") return "close";
  if (e.key === "Enter" && !e.ctrlKey && !e.altKey) return e.shiftKey ? "prev" : "next";
  if (e.key === "F3") return e.shiftKey ? "prev" : "next";
  return null;
}

/** Error text for an invalid regular expression, else null. */
export function queryError(query: string, regex: boolean): string | null {
  if (!regex || !query) return null;
  try {
    new RegExp(query);
    return null;
  } catch {
    return "Invalid regex";
  }
}

export function findLabel(f: FindFeedback, limit = 1000): string {
  if (!f.query) return "";
  const err = queryError(f.query, f.regex);
  if (err) return err;
  if (f.results) {
    const { index, count } = f.results;
    if (count === 0) return "No results";
    if (index < 0) return count >= limit ? `${limit}+ matches` : `${count} matches`;
    return `${index + 1} of ${count}${count >= limit ? "+" : ""}`;
  }
  if (f.found === false) return "No results";
  return "";
}
