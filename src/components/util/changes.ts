// Pure helpers for the read-only Changes drawer (unit-tested).

import type { ChangedFile, SessionMeta, Workspace } from "../../lib/types";

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

/** Same repository root (Windows paths: case-insensitive, either slash). */
export function sameRoot(a: string | null | undefined, b: string | null | undefined): boolean {
  const n = (p: string) => p.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
  return !!a && !!b && n(a) === n(b);
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

/** Visible slice of a fixed-row-height list (virtualization). */
export function visibleRange(scrollTop: number, viewport: number, rowHeight: number, total: number, overscan = 20): [number, number] {
  const first = Math.min(total, Math.max(0, Math.floor(scrollTop / rowHeight) - overscan));
  const last = Math.min(total, Math.ceil((scrollTop + viewport) / rowHeight) + overscan);
  return [first, Math.max(first, last)];
}
