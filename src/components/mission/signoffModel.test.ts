import { describe, expect, it } from "vitest";
import type { BranchSummary } from "../../lib/types";
import {
  buildHandoffText,
  formatAgo,
  formatSummaryLine,
  handoffRank,
  isOnBase,
  orderHandoffTargets,
  SUBJECT_MAX,
  summaryParts,
  truncate,
  type HandoffCandidate,
} from "./signoffModel";

const NOW = Date.parse("2026-10-18T12:00:00Z");

function sum(p: Partial<BranchSummary> = {}): BranchSummary {
  return {
    isRepo: true,
    branch: "builder-1-auth",
    base: "main",
    ahead: 3,
    behind: 0,
    filesChanged: 5,
    insertions: 120,
    deletions: 8,
    uncommitted: 2,
    lastCommitSubject: "Add callback route",
    lastCommitMs: NOW - 4 * 60_000,
    ...p,
  };
}

const kinds = (s: BranchSummary | null | undefined) => summaryParts(s, NOW).map((p) => p.kind);

describe("truncate / formatAgo", () => {
  it("collapses whitespace and cuts with an ellipsis", () => {
    expect(truncate("  a\n b\tc  ", 20)).toBe("a b c");
    expect(truncate("abcdefghij", 5)).toBe("abcd…");
    expect(truncate("abcde", 5)).toBe("abcde");
    expect(truncate("abc", 0)).toBe("");
  });

  it("formats relative times", () => {
    expect(formatAgo(NOW - 3_000, NOW)).toBe("just now");
    expect(formatAgo(NOW + 60_000, NOW)).toBe("just now"); // clock skew
    expect(formatAgo(NOW - 42_000, NOW)).toBe("42s ago");
    expect(formatAgo(NOW - 4 * 60_000, NOW)).toBe("4m ago");
    expect(formatAgo(NOW - 3 * 3_600_000, NOW)).toBe("3h ago");
    expect(formatAgo(NOW - 3 * 86_400_000, NOW)).toBe("3d ago");
  });
});

describe("summaryParts / formatSummaryLine", () => {
  it("the full evidence line of a builder branch", () => {
    expect(formatSummaryLine(sum(), NOW)).toBe("⎇ builder-1-auth · +3 commits · 5 files +120 −8 · 2 uncommitted · “Add callback route” · 4m ago");
  });

  it("singular forms", () => {
    expect(formatSummaryLine(sum({ ahead: 1, filesChanged: 1, uncommitted: 1 }), NOW)).toContain("+1 commit · 1 file +120 −8 · 1 uncommitted");
  });

  it("0 commits is shown plainly, without a diff stat or base's last commit", () => {
    const line = formatSummaryLine(sum({ ahead: 0, filesChanged: 0, insertions: 0, deletions: 0, uncommitted: 0 }), NOW);
    expect(line).toBe("⎇ builder-1-auth · 0 commits · clean");
    expect(kinds(sum({ ahead: 0 }))).toEqual(["branch", "none", "dirty"]);
    expect(summaryParts(sum({ ahead: 0 }), NOW)[1].title).toMatch(/No commits yet.*main/);
  });

  it("behind the base is shown with an arrow", () => {
    expect(formatSummaryLine(sum({ behind: 2 }), NOW)).toContain("· ↓2 behind main ·");
    expect(kinds(sum({ behind: 2 }))).toEqual(["branch", "commits", "diff", "behind", "dirty", "subject", "age"]);
  });

  it("detached HEAD", () => {
    const parts = summaryParts(sum({ branch: null }), NOW);
    expect(parts[0].text).toBe("⎇ detached HEAD");
    expect(parts.map((p) => p.kind)).toContain("commits");
  });

  it("working directly on the base branch: no ahead/behind, last commit shown", () => {
    const s = sum({ branch: "main", ahead: 0, behind: 0, filesChanged: 0, insertions: 0, deletions: 0 });
    expect(isOnBase(s)).toBe(true);
    expect(formatSummaryLine(s, NOW)).toBe("⎇ main · 2 uncommitted · “Add callback route” · 4m ago");
  });

  it("no resolvable base: uses 'base' wording and still shows the last commit", () => {
    const s = sum({ base: null, ahead: 0, behind: 3 });
    expect(formatSummaryLine(s, NOW)).toBe("⎇ builder-1-auth · 0 commits · ↓3 behind base · 2 uncommitted · “Add callback route” · 4m ago");
  });

  it("long subjects are truncated (full subject in the tooltip); missing time drops the age", () => {
    const long = "x".repeat(200);
    const parts = summaryParts(sum({ lastCommitSubject: long, lastCommitMs: null }), NOW);
    const subject = parts.find((p) => p.kind === "subject")!;
    expect(subject.text.length).toBe(SUBJECT_MAX + 2); // quotes
    expect(subject.text.endsWith("…”")).toBe(true);
    expect(subject.title).toBe(long);
    expect(parts.some((p) => p.kind === "age")).toBe(false);
  });

  it("no subject: no subject or age parts", () => {
    expect(kinds(sum({ lastCommitSubject: null }))).toEqual(["branch", "commits", "diff", "dirty"]);
  });

  it("not a repository / no summary: nothing", () => {
    expect(summaryParts(sum({ isRepo: false }), NOW)).toEqual([]);
    expect(summaryParts(null, NOW)).toEqual([]);
    expect(formatSummaryLine(undefined, NOW)).toBe("");
  });
});

describe("hand-off targets", () => {
  const c = (id: string, role: string | null, live = true, terminal = true): HandoffCandidate => ({ id, name: id.toUpperCase(), role, live, terminal });

  it("ranks reviewer/verifier, then lead, then others", () => {
    expect(handoffRank("reviewer")).toBe(0);
    expect(handoffRank("verifier")).toBe(0);
    expect(handoffRank("lead")).toBe(1);
    expect(handoffRank("builder")).toBe(2);
    expect(handoffRank(null)).toBe(2);
  });

  it("orders live terminal sessions other than the sender, stable within a rank", () => {
    const list = [c("b1", "builder"), c("lead", "lead"), c("b2", "builder"), c("ver", "verifier"), c("rev", "reviewer"), c("x", null)];
    expect(orderHandoffTargets("b1", list).map((t) => t.id)).toEqual(["ver", "rev", "lead", "b2", "x"]);
  });

  it("drops stopped sessions, browser panes and the sender", () => {
    const list = [c("b1", "builder"), c("rev", "reviewer", false), c("web", null, true, false), c("lead", "lead")];
    expect(orderHandoffTargets("b1", list).map((t) => t.id)).toEqual(["lead"]);
    expect(orderHandoffTargets("b1", [c("b1", "builder")])).toEqual([]);
  });
});

describe("buildHandoffText", () => {
  const path = "D:\\repo\\.claude\\worktrees\\builder-1";

  it("a branch with commits: what, how much, and how to review", () => {
    const t = buildHandoffText({ fromName: "builder-1", path, summary: sum({ uncommitted: 0 }) });
    expect(t).toBe(
      `builder-1 finished work on branch builder-1-auth (${path}): "Add callback route". 3 commits, 5 files +120 -8 vs main. Please review with: git -C "${path}" diff main...builder-1-auth - report problems or reply LGTM.`,
    );
  });

  it("mentions uncommitted leftovers and being behind", () => {
    const t = buildHandoffText({ fromName: "builder-1", path, summary: sum({ behind: 2, uncommitted: 1 }) });
    expect(t).toContain("The branch is 2 commits behind main.");
    expect(t).toContain(`Also 1 uncommitted change in the worktree (git -C "${path}" status).`);
  });

  it("no commits yet", () => {
    const clean = buildHandoffText({ fromName: "b", path, summary: sum({ ahead: 0, uncommitted: 0 }) });
    expect(clean).toBe(`b finished on branch builder-1-auth (${path}) but has no commits vs main yet. Please review and report problems or reply LGTM.`);
    const dirty = buildHandoffText({ fromName: "b", path, summary: sum({ ahead: 0, uncommitted: 4 }) });
    expect(dirty).toContain("4 uncommitted changes in the worktree.");
    expect(dirty).toContain(`git -C "${path}" diff - report`);
  });

  it("detached HEAD diffs base...HEAD", () => {
    const t = buildHandoffText({ fromName: "b", path, summary: sum({ branch: null }) });
    expect(t).toContain("on a detached HEAD");
    expect(t).toContain("diff main...HEAD");
  });

  it("working on the base branch or with no base: status/log based review", () => {
    const onMain = buildHandoffText({ fromName: "b", path, summary: sum({ branch: "main", ahead: 0, uncommitted: 0 }) });
    expect(onMain).toBe(`b finished work on branch main (${path}). Last commit: "Add callback route". Please review with: git -C "${path}" log -5 --stat - report problems or reply LGTM.`);
    const noBase = buildHandoffText({ fromName: "b", path, summary: sum({ base: null, uncommitted: 2 }) });
    expect(noBase).toContain(`git -C "${path}" diff - report`);
  });

  it("no repository / no summary: a plain request", () => {
    expect(buildHandoffText({ fromName: "b", path: "C:\\work", summary: null })).toBe("b finished work in C:\\work. Please review and report problems or reply LGTM.");
    expect(buildHandoffText({ fromName: "  ", path: "C:\\w", summary: sum({ isRepo: false }) })).toBe("An agent finished work in C:\\w. Please review and report problems or reply LGTM.");
  });

  it("always one line; quotes in subjects cannot break the quoting; long subjects are cut", () => {
    const t = buildHandoffText({ fromName: "multi\nline", path, summary: sum({ lastCommitSubject: 'Fix "auth"\n\nbody text ' + "y".repeat(300) }) });
    expect(t).not.toMatch(/[\r\n]/);
    expect(t).toContain("multi line finished");
    expect(t).toContain(`"Fix 'auth' body text`);
    expect(t).toMatch(/y…"/);
  });
});
