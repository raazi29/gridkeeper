import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionMeta, TestRunInfo, TestRunSpec } from "../lib/types";

const ipcMock = vi.hoisted(() => ({
  testDetect: vi.fn(),
  testRunStart: vi.fn(),
  testRunList: vi.fn(),
  testRunCancel: vi.fn(),
  sessionWrite: vi.fn(),
  sessionOutputTail: vi.fn(),
  log: vi.fn(),
}));
const events = vi.hoisted(() => ({ cb: null as null | ((i: unknown) => void) }));
vi.mock("../lib/ipc", () => ({
  ipc: ipcMock,
  errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  onTestRun: vi.fn(async (cb: (i: unknown) => void) => {
    events.cb = cb;
    return () => {};
  }),
}));
vi.mock("../actions/notify", () => ({ notify: vi.fn() }));
vi.stubGlobal("window", globalThis);

import { useActivity } from "./activity";
import { useApp } from "./appStore";
import { useAttention } from "./attention";
import {
  applyRun,
  askAgentToFix,
  ensureTestRuns,
  laneTargets,
  latestRunFor,
  MAX_RUNS,
  resetTestRuns,
  runTestsAt,
  runTestsForLane,
  runTestsForSession,
  saveTestCommands,
  sendToAgent,
  sessionTarget,
  useTestRuns,
} from "./testrun";

function info(p: Partial<TestRunInfo> = {}): TestRunInfo {
  return {
    id: "t1",
    cwd: "D:\\repo\\wt",
    command: "npm test",
    label: "b1",
    sessionId: "b1",
    status: "running",
    queuedMs: 100,
    startedMs: 100,
    endedMs: null,
    durationMs: null,
    exitCode: null,
    counts: null,
    failures: [],
    lastLines: [],
    error: null,
    outputBytes: 0,
    timeoutSec: 900,
    repoRoot: null,
    headSha: null,
    uncommitted: null,
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

let wsId = "";
let gid = "";

beforeEach(() => {
  resetTestRuns();
  for (const f of Object.values(ipcMock)) f.mockReset();
  ipcMock.testRunList.mockResolvedValue([]);
  ipcMock.testDetect.mockResolvedValue({ dir: "", command: "npm test", source: "package.json", candidates: [] });
  ipcMock.testRunStart.mockImplementation(async (spec: TestRunSpec) => info({ id: `run-${spec.cwd}`, cwd: spec.cwd, command: spec.command, label: spec.label, sessionId: spec.sessionId, status: "queued" }));
  ipcMock.sessionWrite.mockResolvedValue(undefined);
  ipcMock.sessionOutputTail.mockResolvedValue("> ready\n");
  useActivity.setState({ events: [] });
  useAttention.setState({ sessions: {} });
  useApp.setState({ loaded: true, runtime: {}, hiddenViews: {}, focusedSessionId: null });
  useApp.setState((s) => ({ persisted: { ...s.persisted, workspaces: [], sessions: [], activeWorkspaceId: null } }));
  wsId = useApp.getState().createWorkspace("one", "D:\\repo");
  gid = useApp.getState().persisted.workspaces[0].groups[0].id;
  useApp.getState().addSessionMeta(gid, meta("b1", { worktree: { path: "D:\\repo\\wt", branch: "b1" } }));
  useApp.getState().addSessionMeta(gid, meta("b2", { worktree: { path: "D:/Repo/WT/", branch: "b1" } })); // same folder
  useApp.getState().addSessionMeta(gid, meta("lead"));
  useApp.getState().addSessionMeta(gid, meta("web", { kind: "browser" }));
});

describe("applyRun", () => {
  it("keeps the newest run per folder", () => {
    let s = applyRun({ runs: {}, latestByPath: {} }, info({ id: "a", queuedMs: 10 }));
    s = applyRun(s, info({ id: "b", queuedMs: 20, cwd: "D:/repo/wt/" }));
    expect(latestRunFor(s, "d:\\REPO\\wt")?.id).toBe("b");
    // An update of the older run does not take the folder back.
    s = applyRun(s, info({ id: "a", queuedMs: 10, status: "passed" }));
    expect(latestRunFor(s, "D:\\repo\\wt")?.id).toBe("b");
    expect(s.runs.a.status).toBe("passed");
    expect(latestRunFor(s, null)).toBeUndefined();
  });

  it("caps the number of runs but keeps each folder's newest", () => {
    let s = { runs: {}, latestByPath: {} } as Parameters<typeof applyRun>[0];
    for (let i = 0; i < MAX_RUNS + 10; i++) s = applyRun(s, info({ id: `r${i}`, queuedMs: i, cwd: i === 0 ? "D:\\solo" : "D:\\many", status: "passed" }));
    expect(Object.keys(s.runs).length).toBe(MAX_RUNS);
    expect(latestRunFor(s, "D:\\solo")?.id).toBe("r0");
    expect(latestRunFor(s, "D:\\many")?.id).toBe(`r${MAX_RUNS + 9}`);
  });
});

describe("targets and commands", () => {
  it("a session's target is its worktree; browser panes have none", () => {
    expect(sessionTarget("b1")).toEqual({ path: "D:\\repo\\wt", label: "b1", sessionId: "b1", workspaceId: wsId, groupId: gid });
    expect(sessionTarget("web")).toBeNull();
    expect(sessionTarget("nope")).toBeNull();
  });

  it("a lane tests each distinct folder once", () => {
    expect(laneTargets(gid).map((t) => t.path)).toEqual(["D:\\repo\\wt", "D:\\repo"]);
  });

  it("lane override > workspace command > detected", async () => {
    await runTestsForSession("b1");
    expect(ipcMock.testRunStart).toHaveBeenLastCalledWith({ cwd: "D:\\repo\\wt", command: "npm test", label: "b1", sessionId: "b1", timeoutSec: null });
    saveTestCommands(wsId, " pnpm test ", null, "");
    await runTestsForSession("b1");
    expect(ipcMock.testRunStart.mock.lastCall?.[0].command).toBe("pnpm test");
    saveTestCommands(wsId, "pnpm test", gid, "cargo test -p core");
    expect(useApp.getState().persisted.workspaces[0].groups[0].testCommand).toBe("cargo test -p core");
    await runTestsForSession("b1");
    expect(ipcMock.testRunStart.mock.lastCall?.[0].command).toBe("cargo test -p core");
    // Clearing goes back to auto-detect.
    saveTestCommands(wsId, "", gid, "");
    expect(useApp.getState().persisted.workspaces[0].testCommand).toBeNull();
    expect(useApp.getState().persisted.workspaces[0].groups[0].testCommand).toBeNull();
  });

  it("no command anywhere opens the command dialog instead of running", async () => {
    ipcMock.testDetect.mockResolvedValue({ dir: "", command: null, source: null, candidates: [] });
    const r = await runTestsAt(sessionTarget("b1")!);
    expect(r).toBeNull();
    expect(ipcMock.testRunStart).not.toHaveBeenCalled();
    const d = useTestRuns.getState().commandDialog;
    expect(d?.workspaceId).toBe(wsId);
    expect(d?.reason).toContain("No test command found");
    expect(typeof d?.then).toBe("function");
  });

  it("test lane starts one run per folder", async () => {
    await runTestsForLane(gid);
    expect(ipcMock.testRunStart.mock.calls.map((c) => c[0].cwd)).toEqual(["D:\\repo\\wt", "D:\\repo"]);
    expect(Object.keys(useTestRuns.getState().latestByPath).sort()).toEqual(["d:\\repo", "d:\\repo\\wt"]);
  });
});

describe("events and the activity log", () => {
  it("records a finished run once and opens a log toast for failures", async () => {
    await ensureTestRuns();
    expect(events.cb).toBeTypeOf("function");
    events.cb!(info({ status: "running" }));
    expect(useActivity.getState().events).toHaveLength(0);
    const done = info({ status: "failed", exitCode: 1, durationMs: 1000, counts: { runner: "vitest", unit: "tests", passed: 1, failed: 2, skipped: 0 } });
    events.cb!(done);
    events.cb!(done);
    const ev = useActivity.getState().events.filter((e) => e.kind === "tests");
    expect(ev).toHaveLength(1);
    expect(ev[0].level).toBe("error");
    expect(ev[0].result).toBe("2 failed");
    expect(ev[0].message).toContain("tests ✗ 2 failed");
  });

  it("runs that finished before the snapshot are not reported again", async () => {
    ipcMock.testRunList.mockResolvedValue([info({ id: "old", status: "passed" })]);
    await ensureTestRuns();
    expect(latestRunFor(useTestRuns.getState(), "D:\\repo\\wt")?.id).toBe("old");
    events.cb!(info({ id: "old", status: "passed" }));
    expect(useActivity.getState().events.filter((e) => e.kind === "tests")).toHaveLength(0);
  });
});

describe("ask the agent to fix", () => {
  it("prefills a one-line message and sends only through sendToAgent", async () => {
    useTestRuns.setState((s) => applyRun(s, info({ id: "f", status: "failed", exitCode: 1, failures: ["a > b"] })));
    askAgentToFix("f");
    const req = useTestRuns.getState().ask!;
    expect(req.sessionId).toBe("b1");
    expect(req.text).toContain("Failing: a > b.");
    expect(ipcMock.sessionWrite).not.toHaveBeenCalled();

    // Not running: refused.
    expect(await sendToAgent(req, req.text)).toEqual({ ok: false, reason: "b1 is not running." });
    useApp.getState().setRuntime({ id: "b1", name: "b1", agent: "claude", pid: 1, state: { state: "running" }, cwd: "D:\\repo", profileId: null, commandDisplay: "", startedAt: null, endedAt: null, bytesOut: 0 });
    expect(await sendToAgent(req, "fix it\nplease")).toEqual({ ok: true });
    expect(ipcMock.sessionWrite.mock.calls).toEqual([
      ["b1", "fix it please"],
      ["b1", "\r"],
    ]);
    expect(useActivity.getState().events.some((e) => e.kind === "tests" && e.result === "sent")).toBe(true);
  });
});
