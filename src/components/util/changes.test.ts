import { describe, expect, it } from "vitest";
import type { ChangedFile, SessionMeta, Workspace } from "../../lib/types";
import { classifyDiffLine, defaultDiffSide, isInside, repoDirsFor, sameRoot, statusLetter, visibleRange } from "./changes";

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
