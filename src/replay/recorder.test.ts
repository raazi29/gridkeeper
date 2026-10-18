import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BranchSummary, MissionFile, SessionInfo, SessionMeta } from "../lib/types";

// ---- mocks: the Rust side ---------------------------------------------------------------------------

const DIR = "D:\\proj";
const WT = "D:\\proj\\.claude\\worktrees\\b1";
const disk = new Map<string, MissionFile>();
const files = new Map<string, string[]>();
const summaries = new Map<string, Partial<BranchSummary>>();

const ipcMock = vi.hoisted(() => ({
  replayAppend: vi.fn(),
  replayList: vi.fn(),
  missionRead: vi.fn(),
  missionWatch: vi.fn(async () => {}),
  missionUnwatch: vi.fn(async () => {}),
  gitBranchSummary: vi.fn(),
}));

vi.mock("../lib/ipc", () => ({
  ipc: ipcMock,
  errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  onMissionChanged: () => Promise.resolve(() => {}),
}));
const toasts: string[] = [];
vi.mock("../actions/notify", () => ({ notify: (kind: string, msg: string) => void toasts.push(`${kind}: ${msg}`) }));

const { recordBroadcast, recordActivity, useActivity } = await import("../store/activity");
const { useApp } = await import("../store/appStore");
const { useAttention } = await import("../store/attention");
const { acquireMission, reloadMission, resetMissionDocsForTests } = await import("../store/missionDoc");
const { refreshBranchSummary, resetBranchSummaries } = await import("../actions/handoff");
const { useReplay, setAutoRecord } = await import("../store/replay");
const { flushRecording, installReplayRecorder, isRecording, leaveReason, mapAttn, msgFromActivity, resetRecorderForTests, startRecording, stopRecording, uniqueSlug } = await import("./recorder");
const { parseReplay } = await import("./events");

const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};

function putMission(text: string, ms: number) {
  disk.set(DIR, { path: `${DIR}\\.gridkeeper\\mission.md`, exists: true, text, modifiedMs: ms });
}

function meta(id: string, p: Partial<SessionMeta> = {}): SessionMeta {
  return { id, name: id, agent: "claude", cwd: DIR, profileId: null, command: null, args: [], env: [], autoStart: false, resumeOnRestore: { mode: "none" }, agentSessionId: null, worktree: null, createdAt: null, lastExitCode: null, ...p };
}

function running(id: string): SessionInfo {
  return { id, name: id, agent: "claude", pid: 1, state: { state: "running" }, cwd: DIR, profileId: null, commandDisplay: "", startedAt: "x", endedAt: null, bytesOut: 0 };
}

function summary(p: Partial<BranchSummary>): BranchSummary {
  return { isRepo: true, branch: "b1", base: "main", ahead: 0, behind: 0, filesChanged: 0, insertions: 0, deletions: 0, uncommitted: 0, lastCommitSubject: "x", lastCommitMs: 1, ...p };
}

const allLines = () => [...files.values()].flat();
const written = () => parseReplay(allLines().join("\n")).events;

let groupId = "";

beforeEach(() => {
  disk.clear();
  files.clear();
  summaries.clear();
  toasts.length = 0;
  ipcMock.replayAppend.mockReset().mockImplementation(async (_dir: string, name: string, lines: string[]) => {
    const list = files.get(name) ?? [];
    list.push(...lines);
    files.set(name, list);
    return { sizeBytes: list.join("\n").length, full: false };
  });
  ipcMock.replayList.mockReset().mockImplementation(async () => [...files.keys()].map((name) => ({ name, sizeBytes: 10, modifiedMs: Date.now() })));
  ipcMock.missionRead.mockReset().mockImplementation(async (dir: string) => disk.get(dir) ?? { path: `${dir}\\.gridkeeper\\mission.md`, exists: false, text: "", modifiedMs: null });
  ipcMock.gitBranchSummary.mockReset().mockImplementation(async (path: string) => summary(summaries.get(path) ?? {}));
  resetRecorderForTests();
  resetMissionDocsForTests();
  resetBranchSummaries();
  setAutoRecord(true);
  useAttention.setState({ sessions: {} });
  useActivity.setState({ events: [] });
  useApp.setState({ loaded: true, runtime: {}, hiddenViews: {}, focusedSessionId: null });
  useApp.setState((s) => ({ persisted: { ...s.persisted, workspaces: [], sessions: [], activeWorkspaceId: null } }));
  useApp.getState().createWorkspace("one", DIR);
  groupId = useApp.getState().persisted.workspaces[0].groups[0].id;
  useApp.getState().addSessionMeta(groupId, meta("lead", { name: "Lead", role: "lead" }));
  useApp.getState().addSessionMeta(groupId, meta("b1", { name: "builder 1", role: "builder", worktree: { path: WT, branch: "b1" } }));
  useApp.getState().addSessionMeta(groupId, meta("web", { kind: "browser", name: "docs" }));
  useApp.getState().addSessionMeta(groupId, meta("off", { name: "verifier", role: "verifier" }));
  for (const id of ["lead", "b1", "web"]) useApp.getState().setRuntime(running(id));
  putMission("# Mission: Add OAuth for ops@corp.com\n## Tasks\n- [ ] Design token storage @lead\n- [ ] Callback in D:\\proj\\src\\auth.ts @builder-1\n", 1);
});

afterEach(() => {
  resetRecorderForTests();
});

describe("recorder helpers", () => {
  it("maps attention, slugs and leave reasons", () => {
    expect(mapAttn("waiting")).toBe("needs");
    expect(mapAttn(undefined)).toBe("idle");
    expect(mapAttn("working")).toBe("working");
    expect(uniqueSlug("Builder 1", new Set())).toBe("builder-1");
    expect(uniqueSlug("Builder 1", new Set(["builder-1", "builder-1-2"]))).toBe("builder-1-3");
    expect(uniqueSlug("x@y.io", new Set())).toBe("email");
    expect(uniqueSlug("!!!", new Set())).toBe("agent");
    expect(leaveReason(undefined)).toBe("stopped");
    expect(leaveReason({ ...running("a"), state: { state: "exited", code: 1 } })).toBe("error");
    expect(leaveReason({ ...running("a"), state: { state: "exited", code: 0 } })).toBe("stopped");
    expect(leaveReason({ ...running("a"), state: { state: "failed", message: "x" } })).toBe("error");
  });

  it("turns activity entries into messages", () => {
    const by = (n: string) => (n === "builder 1" ? "builder-1" : null);
    expect(msgFromActivity({ kind: "broadcast", level: "info", message: "broadcast: run tests", result: "sent" }, by)).toEqual({ from: "you", text: "run tests" });
    expect(msgFromActivity({ kind: "broadcast", level: "info", message: "hand-off from builder 1: please review", result: "sent" }, by)).toEqual({ from: "builder-1", text: "please review" });
    expect(msgFromActivity({ kind: "broadcast", level: "info", message: "handed off to rev", result: "handoff" }, by)).toBeNull();
    expect(msgFromActivity({ kind: "broadcast", level: "error", message: "broadcast: x", result: "failed" }, by)).toBeNull();
    expect(msgFromActivity({ kind: "mission", level: "info", message: "mission brief: you own the callback", result: "sent" }, by)).toEqual({ from: "you", text: "you own the callback" });
    expect(msgFromActivity({ kind: "mission", level: "needs", message: "mission brief not sent: busy", result: "skipped" }, by)).toBeNull();
    expect(msgFromActivity({ kind: "lifecycle", level: "info", message: "started claude", result: "pid 1" }, by)).toBeNull();
  });
});

describe("recorder", () => {
  it("auto-records when the active project's mission is read, and writes only scrubbed facts", async () => {
    summaries.set(WT, { ahead: 4, filesChanged: 10, insertions: 300, deletions: 20 });
    const off = installReplayRecorder();
    const release = acquireMission(DIR); // Mission Control opens
    await flush();
    expect(isRecording(DIR)).toBe(true);
    const [name] = [...files.keys()];
    expect(name).toMatch(/^\d{4}-\d{2}-\d{2}-\d{4}-add-oauth-for-email\.jsonl$/);
    expect(useReplay.getState().recording[DIR.toLowerCase()]).toMatchObject({ file: name, manual: false });

    let ev = written();
    const start = ev[0];
    expect(start.k).toBe("start");
    if (start.k !== "start") throw new Error();
    expect(start.goal).toBe("Add OAuth for ‹email›");
    expect(start.team.map((m) => `${m.slug}:${m.role}:${m.live}`)).toEqual(["lead:lead:true", "builder-1:builder:true", "verifier:verifier:false"]);
    expect(start.tasks.map((t) => t.text)).toEqual(["Design token storage", "Callback in ‹path›"]);

    // Branch baselines (fresh reads after the start).
    await flushRecording(DIR);
    ev = written();
    expect(ev.filter((e) => e.k === "branch").map((e) => (e.k === "branch" ? `${e.slug}:${e.ahead}` : ""))).toEqual(expect.arrayContaining(["builder-1:4", "lead:0"]));

    // Attention, mission edits, messages, new commits.
    useAttention.setState({ sessions: { b1: { state: "working", unread: false, at: Date.now() } } });
    putMission("# Mission: Add OAuth for ops@corp.com\n## Tasks\n- [x] Design token storage @lead\n- [~] Callback in D:\\proj\\src\\auth.ts @builder-1\n- [ ] Tests\n", 2);
    await reloadMission(DIR);
    recordBroadcast("look at C:\\Users\\me\\secret.txt please", [{ id: "b1", name: "builder 1" }, { id: "lead", name: "Lead" }], []);
    recordActivity({ sessionId: "b1", sessionName: "builder 1", role: "builder", agent: "claude", kind: "lifecycle", level: "info", message: "started claude", result: "pid 9" });
    summaries.set(WT, { ahead: 6, filesChanged: 12, insertions: 360, deletions: 21 });
    await refreshBranchSummary(WT);
    await flushRecording(DIR);
    ev = written();
    expect(ev).toContainEqual(expect.objectContaining({ k: "attn", slug: "builder-1", s: "working" }));
    expect(ev).toContainEqual(expect.objectContaining({ k: "task", text: "Design token storage", s: "done" }));
    expect(ev).toContainEqual(expect.objectContaining({ k: "task", text: "Callback in ‹path›", s: "doing" }));
    expect(ev).toContainEqual(expect.objectContaining({ k: "task", text: "Tests", s: "todo" }));
    const msgs = ev.filter((e) => e.k === "msg");
    expect(msgs).toHaveLength(1); // one broadcast to two agents = one message
    expect(msgs[0]).toMatchObject({ from: "you", to: ["builder-1", "lead"], text: "look at ‹path› please" });
    expect(ev).toContainEqual(expect.objectContaining({ k: "branch", slug: "builder-1", ahead: 6, ins: 360 }));

    // Team changes: a new session joins, one stops, one is removed.
    useApp.getState().addSessionMeta(groupId, meta("rev", { name: "reviewer", role: "reviewer" }));
    useApp.getState().setRuntime(running("rev"));
    useApp.getState().setRuntime({ ...running("b1"), state: { state: "exited", code: 1 } });
    useApp.getState().removeSessionMeta("lead");
    await flush();
    await flushRecording(DIR);
    ev = written();
    expect(ev).toContainEqual(expect.objectContaining({ k: "join", slug: "reviewer", role: "reviewer" }));
    expect(ev).toContainEqual(expect.objectContaining({ k: "leave", slug: "builder-1", why: "error" }));
    expect(ev).toContainEqual(expect.objectContaining({ k: "leave", slug: "lead", why: "removed" }));

    // Closing Mission Control does not stop the recording; the user does.
    release();
    expect(isRecording(DIR)).toBe(true);
    stopRecording(DIR);
    await flush();
    expect(isRecording(DIR)).toBe(false);
    expect(written().slice(-1)[0]?.k).toBe("end");
    expect(useReplay.getState().recording).toEqual({});

    // PRIVACY: nothing path-like, no e-mail, no terminal text.
    const raw = allLines().join("\n");
    expect(raw).not.toMatch(/[A-Za-z]:\\\\|proj\\\\|corp\.com|ops@|secret\.txt|started claude|pid/);

    // Stopped by the user: a re-read of the mission does not auto-restart it.
    const again = acquireMission(DIR);
    await flush();
    expect(isRecording(DIR)).toBe(false);
    again();
    off();
  });

  it("respects the auto-record setting and records on demand", async () => {
    setAutoRecord(false);
    const off = installReplayRecorder();
    const release = acquireMission(DIR);
    await flush();
    expect(isRecording(DIR)).toBe(false);
    await startRecording(DIR, { manual: true });
    await flush();
    expect(isRecording(DIR)).toBe(true);
    expect(useReplay.getState().recording[DIR.toLowerCase()]?.manual).toBe(true);
    expect(written()[0].k).toBe("start");
    release();
    off(); // app teardown ends the recording
    await flush();
    expect(written().slice(-1)[0]?.k).toBe("end");
  });

  it("resumes the latest recording of the same goal", async () => {
    files.set("2026-10-18-0900-add-oauth-for-email.jsonl", ['{"t":1,"k":"start","v":1,"goal":"x","team":[],"tasks":[]}']);
    const off = installReplayRecorder();
    await startRecording(DIR, { manual: true });
    await flush();
    expect([...files.keys()]).toEqual(["2026-10-18-0900-add-oauth-for-email.jsonl"]);
    expect(files.get("2026-10-18-0900-add-oauth-for-email.jsonl")).toHaveLength(2);
    off();
  });

  it("stops when the recording is full", async () => {
    const off = installReplayRecorder();
    await startRecording(DIR, { manual: true });
    await flush();
    ipcMock.replayAppend.mockResolvedValue({ sizeBytes: 5 * 1024 * 1024, full: true });
    useAttention.setState({ sessions: { b1: { state: "working", unread: false, at: Date.now() } } });
    await flushRecording(DIR);
    expect(isRecording(DIR)).toBe(false);
    expect(toasts.some((t) => t.includes("5 MB"))).toBe(true);
    off();
  });

  it("does no work while nothing is recording", async () => {
    setAutoRecord(false);
    const off = installReplayRecorder();
    useAttention.setState({ sessions: { b1: { state: "working", unread: false, at: Date.now() } } });
    recordBroadcast("hi", [{ id: "b1", name: "builder 1" }], []);
    await flush();
    expect(ipcMock.replayAppend).not.toHaveBeenCalled();
    expect(ipcMock.replayList).not.toHaveBeenCalled();
    off();
  });
});
