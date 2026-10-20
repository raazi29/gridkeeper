// Find bar logic (pure; unit-tested): key handling, query validation and the match feedback label.

import { t } from "../i18n";

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
    return t("find.invalidRegex");
  }
}

export function findLabel(f: FindFeedback, limit = 1000): string {
  if (!f.query) return "";
  const err = queryError(f.query, f.regex);
  if (err) return err;
  if (f.results) {
    const { index, count } = f.results;
    if (count === 0) return t("find.noResults");
    if (index < 0) return count >= limit ? t("find.matchesOverLimit", { limit }) : t("find.matches", { count });
    return count >= limit ? t("find.positionOverLimit", { index: index + 1, count }) : t("find.position", { index: index + 1, count });
  }
  if (f.found === false) return t("find.noResults");
  return "";
}
