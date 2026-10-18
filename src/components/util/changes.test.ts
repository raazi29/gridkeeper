import { describe, expect, it } from "vitest";
import type { BranchFile, BranchFiles, ChangedFile, SessionMeta, Workspace } from "../../lib/types";
import {
  branchDiffCommand,
  branchFileLetter,
  branchTotals,
  classifyDiffLine,
  committedHeading,
  defaultDiffSide,
  focusPick,
  hasCommittedWork,
  isInside,
  letterClass,
  repoDirsFor,
  rootKey,
  sameRoot,
  statusLetter,
  visibleRange,
} from "./changes";

const file = (p: Partial<ChangedFile>): ChangedFile => ({ path: "a.txt", origPath: null, index: ".", worktree: "M", kind: "changed", ...p });

describe("diff lines", () => {
  it("classifies unified diff lines", () => {
    expect(classifyDiffLine("+added")).toBe("add");
    expect(classifyDiffLine("-removed")).toBe("del");
    expect(classifyDiffLine("+++ b/a.txt")).toBe("meta");
    expect(classifyDiffLine("--- a/a.txt")).toBe("meta");
    expect(classifyDiffLine("@@ -1,2 +1,3 @@ fn")).toBe("hunk");
    expect(classifyDiffLine("diff --git a/x b/x")).toBe("meta");
    expect(classifyDiffLine("\\ No newline at end of file")).toBe("meta");
    expect(classifyDiffLine(" context")).toBe("ctx");
  });
  it("virtualizes with overscan and clamps", () => {
    expect(visibleRange(0, 170, 17, 1000, 5)).toEqual([0, 15]);
    expect(visibleRange(1700, 170, 17, 1000, 5)).toEqual([95, 115]);
    expect(visibleRange(99999, 170, 17, 50, 5)).toEqual([50, 50]);
  });
});

describe("file status", () => {
  it("chooses the first diff side and the letter", () => {
    expect(defaultDiffSide(file({}))).toBe("unstaged");
    expect(defaultDiffSide(file({ index: "A", worktree: "." }))).toBe("staged");
    expect(defaultDiffSide(file({ kind: "untracked", worktree: "?" }))).toBe("untracked");
    expect(statusLetter(file({}))).toBe("M");
    expect(statusLetter(file({ index: "A", worktree: "." }))).toBe("A");
    expect(statusLetter(file({ kind: "untracked" }))).toBe("?");
    expect(statusLetter(file({ kind: "unmerged", index: "U", worktree: "U" }))).toBe("U");
  });
});

describe("committed work", () => {
  const bfile = (p: Partial<BranchFile>): BranchFile => ({ path: "a.txt", origPath: null, status: "M", insertions: 1, deletions: 0, binary: false, ...p });
  const list = (p: Partial<BranchFiles>): BranchFiles => ({ isRepo: true, branch: "feat", base: "main", ahead: 3, files: [bfile({})], truncated: false, ...p });

  it("needs a base, a branch that is not the base and commits ahead", () => {
    expect(hasCommittedWork(list({}))).toBe(true);
    expect(hasCommittedWork(list({ branch: null }))).toBe(true); // detached HEAD ahead of base
    expect(hasCommittedWork(list({ branch: "main" }))).toBe(false);
    expect(hasCommittedWork(list({ base: null }))).toBe(false);
    expect(hasCommittedWork(list({ ahead: 0 }))).toBe(false);
    expect(hasCommittedWork(list({ isRepo: false }))).toBe(false);
    expect(hasCommittedWork(null)).toBe(false);
    expect(hasCommittedWork(undefined)).toBe(false);
  });

  it("headings, totals, letters and the terminal command", () => {
    const l = list({ files: [bfile({ insertions: 120, deletions: 8 }), bfile({ path: "b.png", status: "A", binary: true, insertions: 0 }), bfile({ path: "c", deletions: 2 })] });
    expect(committedHeading(l as BranchFiles & { base: string })).toBe("committed on feat vs main (3 files)");
    expect(committedHeading(list({ branch: null }) as BranchFiles & { base: string })).toBe("committed on HEAD vs main (1 file)");
    expect(committedHeading(list({ truncated: true }) as BranchFiles & { base: string })).toBe("committed on feat vs main (1+ files)");
    expect(branchTotals(l.files)).toEqual({ insertions: 121, deletions: 10 });
    expect(branchTotals([])).toEqual({ insertions: 0, deletions: 0 });
    expect(branchFileLetter(bfile({ status: "R" }))).toBe("R");
    expect(branchFileLetter(bfile({ status: "d" }))).toBe("D");
    expect(branchFileLetter(bfile({ status: "" }))).toBe("M");
    expect(branchFileLetter(bfile({ status: "?" }))).toBe("M");
    expect(letterClass("?")).toBe("new");
    expect(letterClass("R")).toBe("r");
    expect(branchDiffCommand("D:\\wt\\b1", "main", "feat")).toBe('git -C "D:\\wt\\b1" diff main...feat');
    expect(branchDiffCommand("D:\\wt\\b1", "main", null)).toBe('git -C "D:\\wt\\b1" diff main...HEAD');
  });

  it("focus picks the first uncommitted file, else the first committed one once loaded", () => {
    const u = file({ path: "dirty.txt" });
    const l = list({ files: [bfile({ path: "x.rs" }), bfile({ path: "y.rs" })] });
    expect(focusPick([u], undefined)).toEqual({ kind: "status", file: u });
    expect(focusPick([u], l)).toEqual({ kind: "status", file: u });
    expect(focusPick([], undefined)).toBeUndefined();
    expect(focusPick([], l)).toEqual({ kind: "branch", file: l.files[0], base: "main", branch: "feat" });
    expect(focusPick([], null)).toBeNull();
    expect(focusPick([], list({ files: [] }))).toBeNull();
    expect(focusPick([], list({ branch: "main" }))).toBeNull();
  });

  it("root keys normalize Windows paths", () => {
    expect(rootKey("D:/Repo/wt/")).toBe("d:\\repo\\wt");
    expect(rootKey("d:\\repo\\wt")).toBe(rootKey("D:\\Repo\\WT\\\\"));
  });
});

describe("repository folders", () => {
  const meta = (id: string, cwd: string, extra: Partial<SessionMeta> = {}): SessionMeta => ({
    id,
    name: id,
    agent: "powershell",
    cwd,
    profileId: null,
    command: null,
    args: [],
    env: [],
    autoStart: false,
    resumeOnRestore: { mode: "none" },
    agentSessionId: null,
    worktree: null,
    createdAt: null,
    lastExitCode: null,
    ...extra,
  });
  const ws: Workspace = {
    id: "w",
    name: "W",
    projectDir: "D:\\repo",
    activeGroupId: "g",
    createdAt: null,
    groups: [{ id: "g", name: "G", layout: { preset: "grid", maximized: null, sizes: {} }, sessionIds: ["a", "b", "c", "web"] }],
  };
  it("project folder first, then worktrees, deduplicated, browser panes skipped", () => {
    const metas = [
      meta("a", "D:\\Repo\\"),
      meta("b", "D:\\repo", { worktree: { path: "D:\\repo\\.wt\\feat", branch: "feat" } }),
      meta("c", "D:\\other"),
      meta("web", "D:\\elsewhere", { kind: "browser", url: "http://localhost:5173/" }),
      meta("x", "D:\\not-in-workspace"),
    ];
    expect(repoDirsFor(ws, metas)).toEqual(["D:\\repo", "D:\\repo\\.wt\\feat", "D:\\other"]);
    expect(repoDirsFor(undefined, metas)).toEqual([]);
  });
  it("compares Windows paths", () => {
    expect(sameRoot("D:/repo", "d:\\Repo\\")).toBe(true);
    expect(sameRoot("D:\\repo", null)).toBe(false);
    expect(isInside("D:\\repo", "D:\\Repo\\src")).toBe(true);
    expect(isInside("D:\\repo", "D:\\repo2")).toBe(false);
  });
});
