import { describe, expect, it } from "vitest";
import type { Task } from "../../lib/missionDoc";
import type { MergePreview, TestRunInfo } from "../../lib/types";
import {
  buildRequest,
  conflictMessage,
  defaultMessage,
  defaultStrategy,
  gateText,
  liveUsersOf,
  MESSAGE_MAX,
  mergeDisabledReasons,
  strategyOptions,
  taskForMember,
  testGate,
} from "./mergeModel";

const BRANCH_SHA = "b".repeat(40);

function preview(p: Partial<MergePreview> = {}): MergePreview {
  return {
    path: "D:\\repo\\wt",
    branch: "feat",
    branchSha: BRANCH_SHA,
    base: "main",
    baseSha: "a".repeat(40),
    mainPath: "D:\\repo",
    mainBranch: "main",
    ahead: 2,
    behind: 0,
    filesChanged: 3,
    insertions: 10,
    deletions: 1,
    files: [],
    filesTruncated: false,
    commits: [],
    commitsTruncated: false,
    lastSubject: "Add tests",
    canFastForward: true,
    clean: true,
    conflicts: [],
    checkMethod: "fast-forward",
    gitVersion: "git version 2.51.0",
    worktreeUncommitted: 0,
    blockers: [],
    warnings: [],
    ...p,
  };
}

function run(p: Partial<TestRunInfo> = {}): TestRunInfo {
  return {
    id: "t1",
    cwd: "D:\\repo\\wt",
    command: "npm test",
    label: "builder",
    sessionId: "s1",
    status: "passed",
    queuedMs: 1,
    startedMs: 1,
    endedMs: 2,
    durationMs: 1,
    exitCode: 0,
    counts: null,
    failures: [],
    lastLines: [],
    error: null,
    outputBytes: 0,
    timeoutSec: 900,
    repoRoot: "D:\\repo\\wt",
    headSha: BRANCH_SHA,
    uncommitted: 0,
    ...p,
  };
}

describe("strategy and message defaults", () => {
  it("fast-forward when possible, else a merge commit", () => {
    expect(defaultStrategy(preview())).toBe("fastForward");
    expect(defaultStrategy(preview({ canFastForward: false }))).toBe("mergeCommit");
    expect(defaultStrategy(null)).toBe("mergeCommit");
    const opts = strategyOptions(preview({ canFastForward: false }));
    expect(opts.map((o) => [o.value, o.disabled])).toEqual([
      ["fastForward", true],
      ["mergeCommit", false],
      ["squash", false],
    ]);
  });

  it("message: mission task, else the last subject, one line", () => {
    expect(defaultMessage("feat", "Add OAuth\ncallback", "wip")).toBe("Merge feat: Add OAuth callback");
    expect(defaultMessage("feat", null, "Add tests")).toBe("Merge feat: Add tests");
    expect(defaultMessage("feat", "", null)).toBe("Merge feat");
    expect(defaultMessage("feat", "x".repeat(800), null).length).toBe(MESSAGE_MAX);
  });

  it("finds the member's task: doing, then todo, then the last done", () => {
    const t = (text: string, state: Task["state"], owners: string[]): Task => ({ line: 0, text, state, owners });
    const tasks = [t("old", "done", ["builder-1"]), t("next", "todo", ["builder-1"]), t("other", "doing", ["scout"]), t("newer", "done", ["builder-1"])];
    expect(taskForMember(tasks, { name: "builder 1", role: "builder" })?.text).toBe("next");
    expect(taskForMember(tasks.filter((x) => x.state === "done"), { name: "builder 1", role: null })?.text).toBe("newer");
    expect(taskForMember(tasks, { name: "nobody", role: null })).toBeNull();
  });
});

describe("test gate", () => {
  it("needs a passing run on exactly the branch tip in a clean worktree", () => {
    const p = preview();
    expect(testGate(p, run(), false, true).state).toBe("off");
    expect(testGate(p, null, true, true).state).toBe("missing");
    expect(testGate(p, null, true, false).state).toBe("noCommand");
    expect(testGate(p, run({ status: "running" }), true, true).state).toBe("running");
    expect(testGate(p, run({ status: "failed" }), true, true).state).toBe("failed");
    const stale = testGate(p, run({ headSha: "c".repeat(40) }), true, true);
    expect(stale.state).toBe("stale");
    expect(gateText(stale)).toBe(`ran on cccccccccc, the branch is at bbbbbbbbbb`);
    expect(testGate(p, run({ headSha: null }), true, true).state).toBe("stale");
    const dirty = testGate(p, run({ uncommitted: 2 }), true, true);
    expect(dirty.state).toBe("stale");
    expect(gateText(dirty)).toContain("2 uncommitted or untracked files");
    const ok = testGate(p, run(), true, true);
    expect(ok.state).toBe("ok");
    expect(gateText(ok)).toBe("passed on bbbbbbbbbb");
  });
});

describe("merge button", () => {
  const ok = { state: "ok", run: run() } as const;

  it("is enabled only with a clean preview, a message and a green gate", () => {
    expect(mergeDisabledReasons({ preview: preview(), strategy: "fastForward", message: "", gate: ok, busy: false })).toEqual([]);
    expect(mergeDisabledReasons({ preview: preview(), strategy: "mergeCommit", message: "Merge feat", gate: { state: "off" }, busy: false })).toEqual([]);
    expect(mergeDisabledReasons({ preview: null, strategy: "mergeCommit", message: "x", gate: ok, busy: false })).toEqual(["The preview is not loaded."]);
    expect(mergeDisabledReasons({ preview: preview(), strategy: "mergeCommit", message: "  ", gate: ok, busy: false })).toContain("The commit message is empty.");
    expect(mergeDisabledReasons({ preview: preview(), strategy: "squash", message: "a\nb", gate: ok, busy: false })).toContain("The commit message must be one line.");
    expect(mergeDisabledReasons({ preview: preview({ canFastForward: false }), strategy: "fastForward", message: "", gate: ok, busy: false })).toContain("Fast-forward is not possible.");
    const blocked = mergeDisabledReasons({ preview: preview({ blockers: ["The main checkout has 1 uncommitted change"] }), strategy: "mergeCommit", message: "m", gate: ok, busy: false });
    expect(blocked).toEqual(["The main checkout has 1 uncommitted change"]);
    expect(mergeDisabledReasons({ preview: preview(), strategy: "mergeCommit", message: "m", gate: { state: "missing" }, busy: false })).toEqual(["Tests: not run yet on this commit."]);
    expect(mergeDisabledReasons({ preview: preview(), strategy: "mergeCommit", message: "m", gate: ok, busy: true })).toContain("A merge is running.");
  });

  it("builds the pinned request", () => {
    expect(buildRequest(preview(), "squash", "  Squash feat ", true)).toEqual({
      path: "D:\\repo\\wt",
      mainPath: "D:\\repo",
      base: "main",
      branch: "feat",
      baseSha: "a".repeat(40),
      branchSha: BRANCH_SHA,
      strategy: "squash",
      message: "Squash feat",
      requireTests: true,
    });
    expect(buildRequest(preview(), "fastForward", "ignored", false)?.message).toBe("");
    expect(buildRequest(preview({ branchSha: null }), "mergeCommit", "m", false)).toBeNull();
    expect(buildRequest(null, "mergeCommit", "m", false)).toBeNull();
  });
});

describe("conflict hand-off and clean-up guard", () => {
  it("lists the conflicting files in one line", () => {
    const m = conflictMessage("feat", "main", [
      { path: "a.txt", kind: "content" },
      { path: "d.txt", kind: "modify/delete" },
      { path: "e.txt", kind: "conflict" },
    ]);
    expect(m).toBe(
      "Merging feat into main would conflict in 3 files: a.txt (content), d.txt (modify/delete), e.txt. Please merge main into feat in your worktree, resolve the conflicts, run the tests, commit, and tell me when it is done.",
    );
    const many = conflictMessage("f", "m", Array.from({ length: 15 }, (_, i) => ({ path: `f${i}`, kind: "content" })));
    expect(many).toContain("and 3 more");
  });

  it("names live sessions inside the worktree", () => {
    const key = (p: string) => p.toLowerCase().replace(/\//g, "\\").replace(/\\+$/, "");
    const sessions = [
      { name: "builder", path: "D:\\repo\\wt", live: true },
      { name: "sub", path: "D:\\Repo\\wt\\src", live: true },
      { name: "stopped", path: "D:\\repo\\wt", live: false },
      { name: "sibling", path: "D:\\repo\\wt2", live: true },
      { name: "none", path: null, live: true },
    ];
    expect(liveUsersOf("D:\\repo\\wt\\", sessions, key)).toEqual(["builder", "sub"]);
  });
});
