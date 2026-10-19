// Pure parts of Mission Control's sign-off dock (unit-tested): the one-line evidence summary of a
// session's branch / worktree, the order of hand-off targets, and the hand-off message.
// Everything shown comes from read-only git (`git_branch_summary`): nothing is estimated.
// The evidence line is in the UI language; the hand-off message is typed into an agent and stays English.

import { intlLocale, t } from "../../i18n";
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

/** English counted noun for the hand-off message (agent-facing). */
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Collapse whitespace (a subject is one line) and cut at `max` characters with an ellipsis. */
export function truncate(text: string, max: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  if (max <= 0) return "";
  return one.length > max ? `${one.slice(0, Math.max(0, max - 1)).trimEnd()}…` : one;
}

/** "just now", "42s ago", "4m ago", "3h ago", "2d ago" (UI language). Future times (clock skew) read "just now". */
export function formatAgo(ms: number, now: number): string {
  const s = Math.floor((now - ms) / 1000);
  if (s < 10) return t("signoff.ago.now");
  if (s < 60) return t("signoff.ago.seconds", { n: s });
  const m = Math.floor(s / 60);
  if (m < 60) return t("signoff.ago.minutes", { n: m });
  const h = Math.floor(m / 60);
  if (h < 48) return t("signoff.ago.hours", { n: h });
  return t("signoff.ago.days", { n: Math.floor(h / 24) });
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
  const base = s.base ?? t("signoff.ev.base");
  const onBase = isOnBase(s);
  parts.push(
    s.branch
      ? {
          kind: "branch",
          text: `⎇ ${s.branch}`,
          title: onBase
            ? t("signoff.ev.onBase", { branch: s.branch })
            : s.base
              ? t("signoff.ev.branchVs", { branch: s.branch, base: s.base })
              : t("signoff.ev.branch", { branch: s.branch }),
        }
      : // "⎇ " stays first: ListView strips the branch token by it.
        { kind: "branch", text: `⎇ ${t("signoff.ev.detached")}`, title: t("signoff.ev.detachedTitle") },
  );
  if (!onBase) {
    if (s.ahead > 0) {
      parts.push({ kind: "commits", text: t("signoff.ev.commits", { count: s.ahead }), title: t("signoff.ev.commitsTitle", { count: s.ahead, base }) });
      parts.push({
        kind: "diff",
        text: t("signoff.ev.diff", { files: s.filesChanged, insertions: s.insertions, deletions: s.deletions }),
        title: t("signoff.ev.diffTitle", { base, files: s.filesChanged, insertions: s.insertions, deletions: s.deletions }),
      });
    } else {
      parts.push({ kind: "none", text: t("signoff.ev.noCommits"), title: t("signoff.ev.noCommitsTitle", { base }) });
    }
    if (s.behind > 0) parts.push({ kind: "behind", text: t("signoff.ev.behind", { count: s.behind, base }), title: t("signoff.ev.behindTitle", { count: s.behind, base }) });
  }
  parts.push(
    s.uncommitted > 0
      ? { kind: "dirty", text: t("signoff.ev.dirty", { count: s.uncommitted }), title: t("signoff.ev.dirtyTitle", { count: s.uncommitted }) }
      : { kind: "clean", text: t("signoff.ev.clean"), title: t("signoff.ev.cleanTitle") },
  );
  // The last commit is evidence of THIS work only when the branch has its own commits (or works on base).
  if ((s.ahead > 0 || onBase || !s.base) && s.lastCommitSubject) {
    parts.push({ kind: "subject", text: `“${truncate(s.lastCommitSubject, SUBJECT_MAX)}”`, title: s.lastCommitSubject });
    if (s.lastCommitMs) parts.push({ kind: "age", text: formatAgo(s.lastCommitMs, now), title: new Date(s.lastCommitMs).toLocaleString(intlLocale()) });
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
 * Agent-facing: stays English (typed into agents / written to files).
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
