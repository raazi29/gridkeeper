import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, STATE_VERSION, type Group, type SessionInfo, type SessionMeta, type SessionState, type Workspace } from "../lib/types";
import { shouldApplyStartResult, useApp } from "./appStore";

function info(state: SessionState, startedAt: string | null, bytesOut = 0): SessionInfo {
  return {
    id: "s",
    name: "s",
    agent: "generic",
    pid: 1,
    state,
    cwd: "C:\\",
    profileId: null,
    commandDisplay: "",
    startedAt,
    endedAt: null,
    bytesOut,
  };
}

describe("shouldApplyStartResult", () => {
  const T1 = "2026-10-17T08:00:00.000Z";
  const T0 = "2026-10-17T07:00:00.000Z";
  const result = info({ state: "running" }, T1);

  it("applies over the optimistic 'starting' placeholder and the previous run", () => {
    expect(shouldApplyStartResult(undefined, result)).toBe(true);
    expect(shouldApplyStartResult(info({ state: "starting" }, null), result)).toBe(true);
    expect(shouldApplyStartResult(info({ state: "exited", code: 0 }, T0), result)).toBe(true);
  });

  it("never overwrites an event of the same run that arrived first", () => {
    // The process already exited: the stale 'running' snapshot must not resurrect the pane.
    expect(shouldApplyStartResult(info({ state: "exited", code: 1 }, T1), result)).toBe(false);
    // First-output event already counted bytes: keep it (else the no-output watchdog misfires).
    expect(shouldApplyStartResult(info({ state: "running" }, T1, 16), result)).toBe(false);
  });
});

// ---- moveSessionToGroup / moveGroup ----------------------------------------------------------

function meta(id: string): SessionMeta {
  return {
    id,
    name: id,
    agent: "powershell",
    cwd: "C:\\",
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
  };
}

function group(id: string, sessionIds: string[], maximized: string | null = null): Group {
  return { id, name: id, layout: { preset: "grid", maximized, sizes: {} }, sessionIds };
}

function seed() {
  const w1: Workspace = { id: "w1", name: "w1", projectDir: null, activeGroupId: "a", createdAt: null, groups: [group("a", ["s1", "s2", "s3"], "s2"), group("b", ["s4"]), group("c", [])] };
  const w2: Workspace = { id: "w2", name: "w2", projectDir: null, activeGroupId: "x", createdAt: null, groups: [group("x", ["s5"])] };
  useApp.setState({
    focusedSessionId: null,
    persisted: {
      version: STATE_VERSION,
      settings: DEFAULT_SETTINGS,
      workspaces: [w1, w2],
      sessions: ["s1", "s2", "s3", "s4", "s5"].map(meta),
      activeWorkspaceId: "w1",
    },
  });
}

const ids = (gid: string) => useApp.getState().persisted.workspaces.flatMap((w) => w.groups).find((g) => g.id === gid)?.sessionIds;
const ws = (id: string) => useApp.getState().persisted.workspaces.find((w) => w.id === id)!;

describe("moveSessionToGroup", () => {
  beforeEach(seed);

  it("moves a session to another lane at the drop position, keeping its metadata", () => {
    const sessionsBefore = useApp.getState().persisted.sessions;
    useApp.getState().moveSessionToGroup("s1", "b", 0);
    expect(ids("a")).toEqual(["s2", "s3"]);
    expect(ids("b")).toEqual(["s1", "s4"]);
    // Same metadata array: the terminal registry (which disposes on metadata removal) is not touched.
    expect(useApp.getState().persisted.sessions).toBe(sessionsBefore);
  });

  it("clamps the index and appends at the end", () => {
    useApp.getState().moveSessionToGroup("s3", "b", 99);
    expect(ids("b")).toEqual(["s4", "s3"]);
    useApp.getState().moveSessionToGroup("s1", "b", -5);
    expect(ids("b")).toEqual(["s1", "s4", "s3"]);
  });

  it("reorders within a group (index counted without the moved session)", () => {
    useApp.getState().moveSessionToGroup("s1", "a", 2);
    expect(ids("a")).toEqual(["s2", "s3", "s1"]);
    useApp.getState().moveSessionToGroup("s1", "a", 0);
    expect(ids("a")).toEqual(["s1", "s2", "s3"]);
  });

  it("keeps the empty source group and clears a maximized pane that left", () => {
    useApp.getState().moveSessionToGroup("s4", "c", 0);
    expect(ids("b")).toEqual([]);
    expect(ids("c")).toEqual(["s4"]);
    useApp.getState().moveSessionToGroup("s2", "c", 1);
    const a = ws("w1").groups.find((g) => g.id === "a")!;
    expect(a.layout.maximized).toBeNull();
    expect(ws("w1").groups).toHaveLength(3);
  });

  it("is a no-op for unknown ids and cross-workspace moves", () => {
    const before = useApp.getState().persisted;
    useApp.getState().moveSessionToGroup("nope", "b", 0);
    useApp.getState().moveSessionToGroup("s1", "nope", 0);
    useApp.getState().moveSessionToGroup("s1", "x", 0);
    useApp.getState().moveSessionToGroup("s5", "a", 0);
    useApp.getState().moveSessionToGroup("s1", "a", 0); // already there
    expect(useApp.getState().persisted).toBe(before);
  });

  it("the active group follows the focused session; otherwise it stays", () => {
    useApp.getState().moveSessionToGroup("s1", "b", 0);
    expect(ws("w1").activeGroupId).toBe("a");
    useApp.setState({ focusedSessionId: "s2" });
    useApp.getState().moveSessionToGroup("s2", "c", 0);
    expect(ws("w1").activeGroupId).toBe("c");
    expect(useApp.getState().focusedSessionId).toBe("s2");
  });
});

describe("moveGroup", () => {
  beforeEach(seed);

  it("reorders the groups of one workspace", () => {
    useApp.getState().moveGroup("w1", 0, 2);
    expect(ws("w1").groups.map((g) => g.id)).toEqual(["b", "c", "a"]);
    useApp.getState().moveGroup("w1", 2, 0);
    expect(ws("w1").groups.map((g) => g.id)).toEqual(["a", "b", "c"]);
    expect(ws("w2").groups.map((g) => g.id)).toEqual(["x"]);
  });

  it("is a no-op for invalid input", () => {
    const before = useApp.getState().persisted;
    useApp.getState().moveGroup("w1", 0, 3);
    useApp.getState().moveGroup("w1", -1, 0);
    useApp.getState().moveGroup("w1", 1, 1);
    useApp.getState().moveGroup("nope", 0, 1);
    expect(useApp.getState().persisted).toBe(before);
  });
});

describe("persistence", () => {
  it("a failed save is not marked saved: the next flush retries it", async () => {
    vi.resetModules();
    vi.stubGlobal("window", globalThis);
    const stateSave = vi.fn().mockRejectedValueOnce(new Error("disk full")).mockResolvedValue(undefined);
    vi.doMock("../lib/ipc", () => ({ ipc: { stateSave, log: vi.fn() }, errorMessage: String }));
    const { flushPersistence, useApp: store } = await import("./appStore");
    store.setState({ loaded: true, loadError: null, persisted: { ...store.getState().persisted, activeWorkspaceId: "changed" } });
    await flushPersistence();
    await flushPersistence();
    await flushPersistence(); // saved now: nothing more to write
    expect(stateSave).toHaveBeenCalledTimes(2);
    vi.doUnmock("../lib/ipc");
    vi.unstubAllGlobals();
  });
});
