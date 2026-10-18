// Pure parts of Mission Control's sign-off dock (unit-tested): the one-line evidence summary of a
// session's branch / worktree, the order of hand-off targets, and the hand-off message.
// Everything shown comes from read-only git (`git_branch_summary`): nothing is estimated.

import type { BranchSummary, SessionId } from "../../lib/types";

/** Longest commit subject shown on a card (the full subject is in the tooltip). */
export const SUBJECT_MAX = 60;

export type SummaryPartKind = "branch" | "commits" | "none" | "behind" | "diff" | "dirty" | "clean" | "subject" | "age";

export interface SummaryPart {
  kind: SummaryPartKind;
  text: string;
  /** Longer explanation for a tooltip. */
  title?: string;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Collapse whitespace (a subject is one line) and cut at `max` characters with an ellipsis. */
export function truncate(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (max <= 0) return "";
  return t.length > max ? `${t.slice(0, Math.max(0, max - 1)).trimEnd()}…` : t;
}

/** "just now", "42s ago", "4m ago", "3h ago", "2d ago". Future times (clock skew) read "just now". */
export function formatAgo(ms: number, now: number): string {
  const s = Math.floor((now - ms) / 1000);
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** The session works directly on the base branch (e.g. the main checkout): ahead/behind say nothing. */
export function isOnBase(s: Pick<BranchSummary, "branch" | "base">): boolean {
  return !!s.branch && !!s.base && s.branch === s.base;
}

/**
 * Evidence tokens for a card, e.g. `⎇ builder-1-auth · +3 commits · 5 files +120 −8 · 2 uncommitted ·
 * "Add callback route" · 4m ago`. Empty for a folder that is not a git repository.
 */
export function summaryParts(s: BranchSummary | null | undefined, now: number): SummaryPart[] {
  if (!s || !s.isRepo) return [];
  const parts: SummaryPart[] = [];
  const base = s.base ?? "base";
  const onBase = isOnBase(s);
  parts.push(
    s.branch
      ? { kind: "branch", text: `⎇ ${s.branch}`, title: onBase ? `Working directly on ${s.branch}` : s.base ? `Branch ${s.branch}, compared with ${s.base}` : `Branch ${s.branch}` }
      : { kind: "branch", text: "⎇ detached HEAD", title: "No branch checked out (detached HEAD)" },
  );
  if (!onBase) {
    if (s.ahead > 0) {
      parts.push({ kind: "commits", text: `+${plural(s.ahead, "commit")}`, title: `${plural(s.ahead, "commit")} not on ${base}` });
      parts.push({
        kind: "diff",
        text: `${plural(s.filesChanged, "file")} +${s.insertions} −${s.deletions}`,
        title: `Committed changes vs ${base}: ${plural(s.filesChanged, "file")}, ${s.insertions} insertions, ${s.deletions} deletions`,
      });
    } else {
      parts.push({ kind: "none", text: "0 commits", title: `No commits yet on this branch that are not on ${base}` });
    }
    if (s.behind > 0) parts.push({ kind: "behind", text: `↓${s.behind} behind ${base}`, title: `${plural(s.behind, "commit")} on ${base} that this branch does not have` });
  }
  parts.push(
    s.uncommitted > 0
      ? { kind: "dirty", text: `${s.uncommitted} uncommitted`, title: `${plural(s.uncommitted, "file")} changed but not committed (incl. untracked)` }
      : { kind: "clean", text: "clean", title: "No uncommitted changes" },
  );
  // The last commit is evidence of THIS work only when the branch has its own commits (or works on base).
  if ((s.ahead > 0 || onBase || !s.base) && s.lastCommitSubject) {
    parts.push({ kind: "subject", text: `“${truncate(s.lastCommitSubject, SUBJECT_MAX)}”`, title: s.lastCommitSubject });
    if (s.lastCommitMs) parts.push({ kind: "age", text: formatAgo(s.lastCommitMs, now), title: new Date(s.lastCommitMs).toLocaleString() });
  }
  return parts;
}

/** The summary as one plain line (tooltips, logs, tests). */
export function formatSummaryLine(s: BranchSummary | null | undefined, now: number): string {
  return summaryParts(s, now)
    .map((p) => p.text)
    .join(" · ");
}

// ---- hand-off targets -----------------------------------------------------------------------

export interface HandoffCandidate {
  id: SessionId;
  name: string;
  role: string | null;
  /** Running (can receive a line). */
  live: boolean;
  /** Terminal session (browser panes never receive input). */
  terminal: boolean;
}

/** Reviewers and verifiers first, then the lead, then everyone else. */
export function handoffRank(role: string | null | undefined): number {
  if (role === "reviewer" || role === "verifier") return 0;
  if (role === "lead") return 1;
  return 2;
}

/** Live terminal sessions other than `fromId`, ordered by rank, workspace order within a rank. */
export function orderHandoffTargets(fromId: SessionId, candidates: readonly HandoffCandidate[]): HandoffCandidate[] {
  return candidates
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => c.id !== fromId && c.live && c.terminal)
    .sort((a, b) => handoffRank(a.c.role) - handoffRank(b.c.role) || a.i - b.i)
    .map(({ c }) => c);
}

// ---- hand-off message -----------------------------------------------------------------------

export interface HandoffTextInput {
  fromName: string;
  /** Worktree (or folder) the work lives in. */
  path: string;
  summary: BranchSummary | null | undefined;
}

/**
 * One line handed to another agent (typed into its terminal only when the user presses Send).
 * ASCII punctuation only, so it types the same into any shell or agent CLI.
 */
export function buildHandoffText({ fromName, path, summary: s }: HandoffTextInput): string {
  const from = oneLine(fromName) || "An agent";
  const where = `"${path}"`;
  const tail = "Please review and report problems or reply LGTM.";
  if (!s || !s.isRepo) return `${from} finished work in ${path}. ${tail}`;

  const subject = s.lastCommitSubject ? truncate(s.lastCommitSubject, 120).replace(/"/g, "'") : null;
  const uncommitted = s.uncommitted > 0 ? ` Also ${plural(s.uncommitted, "uncommitted change")} in the worktree (git -C ${where} status).` : "";

  if (isOnBase(s) || !s.base) {
    const on = s.branch ? `on branch ${s.branch}` : "on a detached HEAD";
    const last = subject ? ` Last commit: "${subject}".` : "";
    const how = s.uncommitted > 0 ? `git -C ${where} diff` : `git -C ${where} log -5 --stat`;
    return `${from} finished work ${on} (${path}).${last}${uncommitted} Please review with: ${how} - report problems or reply LGTM.`;
  }

  const ref = s.branch ?? "HEAD";
  const on = s.branch ? `on branch ${s.branch}` : "on a detached HEAD";
  const behind = s.behind > 0 ? ` The branch is ${plural(s.behind, "commit")} behind ${s.base}.` : "";
  if (s.ahead === 0) {
    const how = s.uncommitted > 0 ? ` Review the uncommitted work with: git -C ${where} diff - report problems or reply LGTM.` : ` ${tail}`;
    return `${from} finished ${on} (${path}) but has no commits vs ${s.base} yet.${s.uncommitted > 0 ? ` ${plural(s.uncommitted, "uncommitted change")} in the worktree.` : ""}${behind}${how}`;
  }
  const last = subject ? `: "${subject}"` : "";
  const stats = `${plural(s.ahead, "commit")}, ${plural(s.filesChanged, "file")} +${s.insertions} -${s.deletions} vs ${s.base}.`;
  return `${from} finished work ${on} (${path})${last}. ${stats}${behind}${uncommitted} Please review with: git -C ${where} diff ${s.base}...${ref} - report problems or reply LGTM.`;
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}
