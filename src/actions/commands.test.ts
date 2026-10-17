import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_BINDINGS } from "../keybindings/combo";
import { useApp } from "../store/appStore";
import { useUi } from "../store/uiStore";
import { COMMANDS, getCommand, runCommand, targetSession } from "./commands";
import type { SessionMeta } from "../lib/types";

// Node has no rAF; focus helpers schedule terminal focus with it.
vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0));

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

function setup() {
  const app = useApp.getState();
  useApp.setState({ loaded: true, focusedSessionId: null, runtime: {}, hiddenViews: {} });
  useApp.setState((s) => ({ persisted: { ...s.persisted, workspaces: [], sessions: [], activeWorkspaceId: null } }));
  const ws1 = app.createWorkspace("one", null);
  const g1 = useApp.getState().persisted.workspaces[0].groups[0].id;
  for (const id of ["a", "b", "c"]) useApp.getState().addSessionMeta(g1, meta(id));
  const ws2 = useApp.getState().createWorkspace("two", null);
  useApp.getState().setActiveWorkspace(ws1);
  useApp.getState().setFocused(null);
  return { ws1, ws2, g1 };
}

describe("command registry", () => {
  it("has unique ids", () => {
    const ids = COMMANDS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it("every default keybinding targets a registered command", () => {
    for (const id of Object.keys(DEFAULT_BINDINGS)) expect(getCommand(id), id).toBeDefined();
  });
});

describe("navigation commands", () => {
  beforeEach(() => {
    useUi.setState({ dialog: null, visited: {}, lastFocusByGroup: {} });
  });

  it("session.next / prev cycle focus within the active group", () => {
    setup();
    runCommand("session.next");
    expect(useApp.getState().focusedSessionId).toBe("a");
    runCommand("session.next");
    runCommand("session.next");
    expect(useApp.getState().focusedSessionId).toBe("c");
    runCommand("session.next");
    expect(useApp.getState().focusedSessionId).toBe("a");
    runCommand("session.prev");
    expect(useApp.getState().focusedSessionId).toBe("c");
  });

  it("session.focusN focuses the Nth pane", () => {
    setup();
    runCommand("session.focus2");
    expect(useApp.getState().focusedSessionId).toBe("b");
    expect(targetSession()).toBe("b");
    runCommand("session.focus9");
    expect(useApp.getState().focusedSessionId).toBe("b");
  });

  it("workspace.next switches workspace and marks it visited", () => {
    const { ws2 } = setup();
    runCommand("workspace.next");
    expect(useApp.getState().persisted.activeWorkspaceId).toBe(ws2);
    expect(useUi.getState().visited[ws2]).toBe(true);
    expect(targetSession()).toBeNull();
  });

  it("session.maximize toggles the focused pane", () => {
    const { g1 } = setup();
    runCommand("session.focus1");
    runCommand("session.maximize");
    const group = () => useApp.getState().persisted.workspaces[0].groups.find((g) => g.id === g1)!;
    expect(group().layout.maximized).toBe("a");
    runCommand("session.maximize");
    expect(group().layout.maximized).toBeNull();
  });

  it("split commands open the new-session dialog with a preset", () => {
    const { g1 } = setup();
    runCommand("session.splitRows");
    expect(useUi.getState().dialog).toEqual({ kind: "newSession", groupId: g1, preset: "rows" });
  });
});
