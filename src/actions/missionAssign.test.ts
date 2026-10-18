import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MissionFile, SessionMeta } from "../lib/types";

const disk = new Map<string, MissionFile>();
const ipcMock = vi.hoisted(() => ({
  missionRead: vi.fn(),
  missionWrite: vi.fn(),
  missionWatch: vi.fn(async () => {}),
  missionUnwatch: vi.fn(async () => {}),
}));
vi.mock("../lib/ipc", () => ({
  ipc: ipcMock,
  onMissionChanged: () => Promise.resolve(() => {}),
  errorMessage: (e: unknown) => (e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : String(e)),
}));
const toasts: string[] = [];
vi.mock("./notify", () => ({ notify: (kind: string, msg: string) => void toasts.push(`${kind}: ${msg}`) }));
const undo: { message: string; run: () => void }[] = [];
vi.mock("../store/uiStore", async (orig) => ({
  ...(await orig<object>()),
  actionToast: (t: { message: string; action?: { run: () => void } }) => void undo.push({ message: t.message, run: t.action!.run }),
}));

import { beginTaskDrag, endTaskDrag } from "../components/mission/mcDrag";
import { parseMission } from "../lib/missionDoc";
import { useApp } from "../store/appStore";
import { resetMissionDocsForTests, useMissionDocs } from "../store/missionDoc";
import { assignTaskToSession, projectDirOfSession } from "./missionAssign";

const DIR = "D:\\proj";
const PATH = `${DIR}\\.gridkeeper\\mission.md`;

function meta(id: string, p: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id,
    name: id,
    agent: "claude",
    cwd: DIR,
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

/** Seed disk + the store as if the board had read the file (the board's key spells the folder in lowercase). */
function seed(text: string, modifiedMs = 1, key = "d:\\proj") {
  const file = { path: PATH, exists: true, text, modifiedMs };
  disk.set(DIR, file);
  useMissionDocs.setState({ byDir: { [key]: { file, doc: parseMission(text), loading: false, error: null } } });
}

beforeEach(() => {
  disk.clear();
  toasts.length = 0;
  undo.length = 0;
  endTaskDrag();
  resetMissionDocsForTests();
  ipcMock.missionRead.mockReset().mockImplementation(async () => disk.get(DIR) ?? { path: PATH, exists: false, text: "", modifiedMs: null });
  ipcMock.missionWrite.mockReset().mockImplementation(async (_dir: string, text: string, expected: number | null) => {
    const cur = disk.get(DIR);
    if ((cur?.modifiedMs ?? null) !== expected) throw { code: "conflict", message: "changed" };
    const f = { path: PATH, exists: true, text, modifiedMs: (cur?.modifiedMs ?? 0) + 1 };
    disk.set(DIR, f);
    return f;
  });
  useApp.setState({ loaded: true, runtime: {}, hiddenViews: {}, focusedSessionId: null });
  useApp.setState((s) => ({ persisted: { ...s.persisted, workspaces: [], sessions: [], activeWorkspaceId: null } }));
  useApp.getState().createWorkspace("one", null);
  const ws = useApp.getState().persisted.workspaces[0];
  useApp.getState().updateWorkspace(ws.id, { projectDir: DIR });
  useApp.getState().addSessionMeta(ws.groups[0].id, meta("s1", { name: "Builder 1", role: "builder" }));
  useApp.getState().addSessionMeta(ws.groups[0].id, meta("s2", { name: "ビルダー" }));
});

const TEXT = "# Mission: M\r\n## Tasks\r\n- [ ] one\r\n- [~] two @lead\r\n";

describe("assignTaskToSession", () => {
  it("finds the session's project folder", () => {
    expect(projectDirOfSession("s1")).toBe(DIR);
  });

  it("adds the session's slug as an owner (state and other owners kept) and offers Undo", async () => {
    seed(TEXT);
    await assignTaskToSession("s1", 3);
    expect(disk.get(DIR)?.text).toBe("# Mission: M\r\n## Tasks\r\n- [ ] one\r\n- [~] two @lead @builder-1\r\n");
    expect(undo.map((u) => u.message)).toEqual(["Assigned to Builder 1"]);
    undo[0].run();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(disk.get(DIR)?.text).toBe(TEXT);
  });

  it("an unassigned todo task becomes theirs and stays todo", async () => {
    seed(TEXT);
    await assignTaskToSession("s1", 2);
    expect(parseMission(disk.get(DIR)!.text).tasks[0]).toMatchObject({ state: "todo", owners: ["builder-1"] });
  });

  it("does nothing when the session already owns it", async () => {
    seed("- [ ] one @builder-1\n");
    await assignTaskToSession("s1", 0);
    expect(ipcMock.missionWrite).not.toHaveBeenCalled();
    expect(toasts).toEqual(["info: Builder 1 already owns “one”"]);
  });

  it("refuses a line that no longer holds the dragged task", async () => {
    seed(TEXT);
    beginTaskDrag({ line: 2, text: "something else" });
    await assignTaskToSession("s1", 2);
    expect(ipcMock.missionWrite).not.toHaveBeenCalled();
    expect(toasts[0]).toMatch(/changed/);
  });

  it("warns for a name without a slug and for a missing file", async () => {
    seed(TEXT);
    await assignTaskToSession("s2", 2);
    expect(toasts[0]).toMatch(/rename the session/);
    useMissionDocs.setState({ byDir: {} });
    await assignTaskToSession("s1", 2);
    expect(toasts[1]).toMatch(/No mission file/);
    expect(ipcMock.missionWrite).not.toHaveBeenCalled();
  });
});
