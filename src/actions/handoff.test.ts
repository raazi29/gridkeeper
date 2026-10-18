import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BranchSummary, SessionInfo, SessionMeta } from "../lib/types";

const ipcMock = vi.hoisted(() => ({
  gitBranchSummary: vi.fn(),
  sessionWrite: vi.fn(),
  sessionOutputTail: vi.fn(),
}));
vi.mock("../lib/ipc", () => ({
  ipc: ipcMock,
  errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

import { useActivity } from "../store/activity";
import { useApp } from "../store/appStore";
import { useAttention } from "../store/attention";
import {
  cachedBranchSummary,
  closeHandoff,
  evidencePath,
  handoffMenuItems,
  handoffSubmenu,
  handoffTargetCount,
  handoffTargets,
  openHandoff,
  pathKey,
  refreshBranchSummary,
  resetBranchSummaries,
  scheduleBranchSummary,
  sendHandoff,
  useBranchSummaries,
  useHandoff,
} from "./handoff";

const WT = "D:\\repo\\.claude\\worktrees\\b1";

function summary(p: Partial<BranchSummary> = {}): BranchSummary {
  return {
    isRepo: true,
    branch: "b1-auth",
    base: "main",
    ahead: 2,
    behind: 0,
    filesChanged: 3,
    insertions: 40,
    deletions: 1,
    uncommitted: 0,
    lastCommitSubject: "Add login",
    lastCommitMs: 1,
    ...p,
  };
}

function meta(id: string, p: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id,
    name: id,
    agent: "claude",
    cwd: "D:\\repo",
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
    ...p,
  };
}

function running(id: string): SessionInfo {
  return { id, name: id, agent: "claude", pid: 1, state: { state: "running" }, cwd: "D:\\repo", profileId: null, commandDisplay: "", startedAt: null, endedAt: null, bytesOut: 0 };
}

function setup() {
  useApp.setState({ loaded: true, runtime: {}, hiddenViews: {}, focusedSessionId: null });
  useApp.setState((s) => ({ persisted: { ...s.persisted, workspaces: [], sessions: [], activeWorkspaceId: null } }));
  useApp.getState().createWorkspace("one", null);
  const g = useApp.getState().persisted.workspaces[0].groups[0].id;
  useApp.getState().addSessionMeta(g, meta("b1", { role: "builder", worktree: { path: WT, branch: "b1-auth" } }));
  useApp.getState().addSessionMeta(g, meta("lead", { role: "lead" }));
  useApp.getState().addSessionMeta(g, meta("b2", { role: "builder" }));
  useApp.getState().addSessionMeta(g, meta("rev", { role: "reviewer" }));
  useApp.getState().addSessionMeta(g, meta("web", { kind: "browser" }));
  useApp.getState().addSessionMeta(g, meta("off", { role: "verifier" }));
  for (const id of ["b1", "lead", "b2", "rev", "web"]) useApp.getState().setRuntime(running(id));
}

beforeEach(() => {
  vi.useRealTimers();
  ipcMock.gitBranchSummary.mockReset();
  ipcMock.sessionWrite.mockReset().mockResolvedValue(undefined);
  ipcMock.sessionOutputTail.mockReset().mockResolvedValue("> ready\n");
  resetBranchSummaries();
  closeHandoff();
  useAttention.setState({ sessions: {} });
  useActivity.setState({ events: [] });
  setup();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("evidence path / cache key", () => {
  it("prefers the worktree, falls back to the folder", () => {
    expect(evidencePath({ cwd: "C:\\a", worktree: { path: "C:\\wt", branch: null } })).toBe("C:\\wt");
    expect(evidencePath({ cwd: "C:\\a", worktree: null })).toBe("C:\\a");
    expect(evidencePath({ cwd: "  ", worktree: null })).toBeNull();
    expect(evidencePath(undefined)).toBeNull();
  });

  it("keys paths case- and slash-insensitively", () => {
    expect(pathKey("D:/Repo/WT/")).toBe(pathKey("d:\\repo\\wt"));
  });
});

describe("branch summary cache", () => {
  it("fetches with base null, caches per path and dedupes concurrent requests", async () => {
    let resolve!: (s: BranchSummary) => void;
    ipcMock.gitBranchSummary.mockReturnValue(new Promise<BranchSummary>((r) => (resolve = r)));
    const a = refreshBranchSummary(WT);
    const b = refreshBranchSummary(WT.toUpperCase());
    expect(ipcMock.gitBranchSummary).toHaveBeenCalledTimes(1);
    expect(ipcMock.gitBranchSummary).toHaveBeenCalledWith(WT, null);
    resolve(summary());
    expect(await a).toBe(await b);
    expect(cachedBranchSummary(WT)?.branch).toBe("b1-auth");
    // a later refresh runs again (not deduped once settled)
    ipcMock.gitBranchSummary.mockResolvedValue(summary({ ahead: 5 }));
    await refreshBranchSummary(WT);
    expect(ipcMock.gitBranchSummary).toHaveBeenCalledTimes(2);
    expect(cachedBranchSummary(WT)?.ahead).toBe(5);
  });

  it("records errors instead of throwing", async () => {
    ipcMock.gitBranchSummary.mockRejectedValue(new Error("git missing"));
    const e = await refreshBranchSummary(WT);
    expect(e.summary).toBeNull();
    expect(e.error).toBe("git missing");
    expect(useBranchSummaries.getState().byPath[pathKey(WT)].error).toBe("git missing");
  });

  it("debounces scheduled refreshes into one call", async () => {
    vi.useFakeTimers();
    ipcMock.gitBranchSummary.mockResolvedValue(summary());
    scheduleBranchSummary(WT, 500);
    scheduleBranchSummary(WT, 500);
    vi.advanceTimersByTime(400);
    scheduleBranchSummary(WT, 500);
    vi.advanceTimersByTime(499);
    expect(ipcMock.gitBranchSummary).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(ipcMock.gitBranchSummary).toHaveBeenCalledTimes(1);
  });
});

describe("hand-off targets", () => {
  it("live terminal sessions of the workspace: reviewer first, then lead, then others", () => {
    expect(handoffTargets("b1").map((t) => t.id)).toEqual(["rev", "lead", "b2"]);
    expect(handoffTargetCount("b1", useApp.getState())).toBe(3);
  });

  it("menu items open the dialog (nothing sent); submenu is labelled and lists the same targets", async () => {
    ipcMock.gitBranchSummary.mockResolvedValue(summary());
    const before = vi.fn();
    const items = handoffMenuItems("b1", before);
    expect(items.map((i) => [i.label, i.hint])).toEqual([
      ["rev", "reviewer"],
      ["lead", "lead"],
      ["b2", "builder"],
    ]);
    expect(handoffSubmenu("b1").label).toBe("Hand off…");
    expect(handoffSubmenu("b1").children).toHaveLength(3);
    items[0].onSelect!();
    expect(before).toHaveBeenCalled();
    await vi.waitFor(() => expect(useHandoff.getState().request).not.toBeNull());
    expect(ipcMock.sessionWrite).not.toHaveBeenCalled();
  });
});

describe("openHandoff", () => {
  it("prefills the message from the branch summary (fetching when not cached)", async () => {
    ipcMock.gitBranchSummary.mockResolvedValue(summary());
    await openHandoff("b1", "rev");
    const r = useHandoff.getState().request!;
    expect(r).toMatchObject({ fromId: "b1", targetId: "rev", fromName: "b1", targetName: "rev", targetRole: "reviewer" });
    expect(r.text).toContain(`b1 finished work on branch b1-auth (${WT}): "Add login". 2 commits, 3 files +40 -1 vs main.`);
    expect(r.text).toContain(`git -C "${WT}" diff main...b1-auth`);
    expect(ipcMock.gitBranchSummary).toHaveBeenCalledTimes(1);
    await openHandoff("b1", "lead"); // cached now
    expect(ipcMock.gitBranchSummary).toHaveBeenCalledTimes(1);
  });

  it("works without git (plain message)", async () => {
    ipcMock.gitBranchSummary.mockRejectedValue(new Error("not a repo"));
    await openHandoff("b2", "rev");
    expect(useHandoff.getState().request?.text).toBe("b2 finished work in D:\\repo. Please review and report problems or reply LGTM.");
  });
});

describe("sendHandoff", () => {
  it("types one line, then Enter, and logs both sides", async () => {
    const r = await sendHandoff("b1", "rev", "please\nreview\r\nthis");
    expect(r).toEqual({ ok: true });
    expect(ipcMock.sessionWrite.mock.calls).toEqual([
      ["rev", "please review this"],
      ["rev", "\r"],
    ]);
    const ev = useActivity.getState().events;
    expect(ev.map((e) => [e.sessionId, e.message])).toEqual([
      ["b1", "handed off to rev"],
      ["rev", "hand-off from b1: please review this"],
    ]);
  });

  it("refuses when the target is waiting for an answer", async () => {
    useAttention.setState({ sessions: { rev: { state: "waiting", unread: true, at: 0 } } });
    const r = await sendHandoff("b1", "rev", "x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/waiting for an answer/);
    expect(ipcMock.sessionWrite).not.toHaveBeenCalled();
  });

  it("refuses when the target's last lines look like a prompt", async () => {
    ipcMock.sessionOutputTail.mockResolvedValue("Do you trust the files in this folder?\n❯ 1. Yes, proceed\n  2. No, exit\n");
    const r = await sendHandoff("b1", "rev", "x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/asking something/);
    expect(ipcMock.sessionWrite).not.toHaveBeenCalled();
  });

  it("refuses a stopped target and an empty message", async () => {
    expect((await sendHandoff("b1", "off", "x")).ok).toBe(false);
    expect((await sendHandoff("b1", "rev", " \n ")).ok).toBe(false);
    expect(ipcMock.sessionWrite).not.toHaveBeenCalled();
  });

  it("reports a write failure", async () => {
    ipcMock.sessionWrite.mockRejectedValue(new Error("pipe closed"));
    const r = await sendHandoff("b1", "rev", "x");
    expect(r).toEqual({ ok: false, reason: "pipe closed" });
    expect(useActivity.getState().events.slice(-1)[0]).toMatchObject({ sessionId: "rev", level: "error" });
  });
});
