import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_BINDINGS } from "../keybindings/combo";
import { useApp } from "../store/appStore";
import { useUi } from "../store/uiStore";
import { useAttention, useAttentionUi } from "../store/attention";
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

describe("attention commands", () => {
  beforeEach(() => {
    useUi.setState({ dialog: null, visited: {}, lastFocusByGroup: {} });
    useAttention.setState({ sessions: {}, feed: [] });
    useAttentionUi.setState({ overlay: null, commsOpen: false });
  });

  it("attention.next jumps across workspaces round-robin and clears unread", () => {
    const { ws1, ws2 } = setup();
    const g2 = useApp.getState().persisted.workspaces[1].groups[0].id;
    useApp.getState().addSessionMeta(g2, meta("z"));
    const at = useAttention.getState();
    at.apply("b", { type: "attention", ev: { id: "b", kind: "bell" } }, false);
    at.apply("z", { type: "attention", ev: { id: "z", kind: "status", status: "done" } }, false);
    runCommand("attention.next");
    expect(useApp.getState().focusedSessionId).toBe("b");
    expect(useAttention.getState().sessions.b.unread).toBe(false);
    runCommand("attention.next");
    expect(useApp.getState().focusedSessionId).toBe("z");
    expect(useApp.getState().persisted.activeWorkspaceId).toBe(ws2);
    // b is still waiting (already seen): the next jump wraps back to it
    runCommand("attention.next");
    expect(useApp.getState().focusedSessionId).toBe("b");
    expect(useApp.getState().persisted.activeWorkspaceId).toBe(ws1);
  });

  it("view.fleet and session.broadcast toggle their overlays", () => {
    setup();
    runCommand("view.fleet");
    expect(useAttentionUi.getState().overlay).toBe("fleet");
    runCommand("session.broadcast");
    expect(useAttentionUi.getState().overlay).toBe("broadcast");
    runCommand("session.broadcast");
    expect(useAttentionUi.getState().overlay).toBeNull();
  });
});
