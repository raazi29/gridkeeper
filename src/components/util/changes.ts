// Pure helpers for the read-only Changes drawer (unit-tested).

import type { BranchFile, BranchFiles, ChangedFile, SessionMeta, Workspace } from "../../lib/types";
import { t } from "../../i18n";

export type DiffLineKind = "add" | "del" | "hunk" | "meta" | "ctx";

export function classifyDiffLine(line: string): DiffLineKind {
  if (line.startsWith("+++") || line.startsWith("---")) return "meta";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  if (line.startsWith("@@")) return "hunk";
  if (/^(diff |index |new file|deleted file|similarity |rename |old mode|new mode|Binary files|\\ No newline)/.test(line)) return "meta";
  return "ctx";
}

/** Folders to inspect for a workspace: its project folder, then each session's worktree / folder. */
export function repoDirsFor(ws: Workspace | undefined, metas: SessionMeta[]): string[] {
  if (!ws) return [];
  const inWs = new Set(ws.groups.flatMap((g) => g.sessionIds));
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (p: string | null | undefined) => {
    const v = p?.trim();
    if (!v) return;
    const k = v.replace(/[\\/]+$/, "").toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.push(v);
  };
  add(ws.projectDir);
  for (const m of metas) if (inWs.has(m.id) && (m.kind ?? "terminal") === "terminal") add(m.worktree?.path ?? m.cwd);
  return out;
}

/** Lookup key of a repository root (Windows paths: case-insensitive, either slash, no trailing slash). */
export function rootKey(p: string): string {
  return p.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
}

/** Same repository root (Windows paths: case-insensitive, either slash). */
export function sameRoot(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && rootKey(a) === rootKey(b);
}

/** Is `path` inside the repository at `root`? */
export function isInside(root: string, path: string): boolean {
  const n = (p: string) => p.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
  const r = n(root);
  const p = n(path);
  return p === r || p.startsWith(`${r}\\`);
}

/** Which diff to show first for a file: work-tree changes, else staged; untracked as a new file. */
export function defaultDiffSide(f: ChangedFile): "unstaged" | "staged" | "untracked" {
  if (f.kind === "untracked") return "untracked";
  return f.worktree !== "." ? "unstaged" : "staged";
}

/** One-letter status shown in the list ("M", "A", "D", "R", "U", "?"). */
export function statusLetter(f: ChangedFile): string {
  if (f.kind === "untracked") return "?";
  if (f.kind === "unmerged") return "U";
  const s = f.worktree !== "." ? f.worktree : f.index;
  return s === "." ? "M" : s;
}

/** CSS modifier of a status letter (`changes-letter is-…`). */
export function letterClass(letter: string): string {
  return letter === "?" ? "new" : letter.toLowerCase();
}

// ---- committed work (branch vs base) ----------------------------------------------------------

/** A branch list worth a "committed on …" subsection: a resolved base, HEAD not on it, commits ahead. */
export function hasCommittedWork(b: BranchFiles | null | undefined): b is BranchFiles & { base: string } {
  return !!b && b.isRepo && !!b.base && b.branch !== b.base && b.ahead > 0;
}

/** "committed on feat vs main (5 files)", in the UI language ("HEAD" is git's name and stays). */
export function committedHeading(b: BranchFiles & { base: string }): string {
  const n = b.files.length;
  const params = { branch: b.branch ?? "HEAD", base: b.base, count: n };
  return b.truncated ? t("changes.committedHeadingTruncated", params) : t("changes.committedHeading", params);
}

/** Summed line counts of a committed-file list (binary files count nothing). */
export function branchTotals(files: BranchFile[]): { insertions: number; deletions: number } {
  let insertions = 0;
  let deletions = 0;
  for (const f of files) {
    insertions += f.insertions;
    deletions += f.deletions;
  }
  return { insertions, deletions };
}

/** One-letter status of a committed file ("A", "M", "D", "R", "C", "T"); "M" when unknown. */
export function branchFileLetter(f: BranchFile): string {
  const c = f.status.charAt(0).toUpperCase();
  return /^[A-Z]$/.test(c) ? c : "M";
}

/** The terminal command that shows the same committed diff. */
export function branchDiffCommand(root: string, base: string, branch: string | null): string {
  return `git -C "${root}" diff ${base}...${branch ?? "HEAD"}`;
}

export type FocusPick =
  | { kind: "status"; file: ChangedFile }
  | { kind: "branch"; file: BranchFile; base: string; branch: string | null }
  | null;

/**
 * What to select when the drawer is focused on a repository (sign-off "review diff"): its first uncommitted
 * file, else its first committed file. `undefined` = the committed list is still loading (wait);
 * `null` = nothing to select.
 */
export function focusPick(uncommitted: ChangedFile[], branch: BranchFiles | null | undefined): FocusPick | undefined {
  if (uncommitted.length) return { kind: "status", file: uncommitted[0] };
  if (branch === undefined) return undefined;
  if (hasCommittedWork(branch) && branch.files.length) return { kind: "branch", file: branch.files[0], base: branch.base, branch: branch.branch };
  return null;
}

/** Visible slice of a fixed-row-height list (virtualization). */
export function visibleRange(scrollTop: number, viewport: number, rowHeight: number, total: number, overscan = 20): [number, number] {
  const first = Math.min(total, Math.max(0, Math.floor(scrollTop / rowHeight) - overscan));
  const last = Math.min(total, Math.ceil((scrollTop + viewport) / rowHeight) + overscan);
  return [first, Math.max(first, last)];
}
