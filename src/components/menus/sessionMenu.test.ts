import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionInfo, SessionMeta } from "../../lib/types";
import { shellLabel } from "../../lib/platform";
import { useApp } from "../../store/appStore";
import { useAttentionUi } from "../../store/attention";
import { useUi } from "../../store/uiStore";
import type { MenuAction, MenuItem } from "../ui/Menu";
import { buildGroupMenu } from "./containerMenus";
import { buildSessionMenu, sessionMenuState, type SessionMenuState } from "./sessionMenu";

vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0));

const actions = (items: MenuItem[]) => items.filter((i): i is MenuAction => i !== "separator");
const labels = (items: MenuItem[]) => actions(items).map((i) => i.label);
const find = (items: MenuItem[], label: string) => actions(items).find((i) => i.label === label);

function state(p: Partial<SessionMenuState> = {}): SessionMenuState {
  return {
    exists: true,
    name: "builder",
    agent: "claude",
    live: true,
    hasRun: true,
    role: null,
    muted: false,
    hidden: false,
    groupId: "g1",
    index: 0,
    count: 2,
    maximized: false,
    resume: { mode: "continue" },
    ...p,
  };
}

describe("buildSessionMenu — terminal", () => {
  it("live session with a selection: clipboard, view, layout and lifecycle items", () => {
    const items = buildSessionMenu("s1", { surface: "terminal", hasSelection: true }, state());
    expect(labels(items)).toEqual([
      "Copy",
      "Paste",
      "Select all",
      "Find…",
      "Clear",
      "Copy all output",
      "Zoom",
      "Message…",
      "New session",
      "Split",
      "Maximize",
      "Restart (resume)",
      "Restart fresh",
      "Stop",
      "Force stop…",
      "Mute notifications",
      "Role",
      "Rename…",
      "Hide view",
      "Close…",
    ]);
    expect(find(items, "Copy")?.disabled).toBeFalsy();
    expect(find(items, "Message…")?.disabled).toBe(false);
    expect(labels(find(items, "Zoom")!.children!)).toEqual(["Zoom in", "Zoom out", "Reset zoom"]);
    expect(labels(find(items, "Split")!.children!)).toEqual(["New session in columns", "New session in rows"]);
    expect(find(items, "Close…")?.danger).toBe(true);
    expect(find(items, "Force stop…")?.danger).toBe(true);
  });

  it("Copy is disabled without a selection", () => {
    const items = buildSessionMenu("s1", { surface: "terminal", hasSelection: false }, state());
    expect(find(items, "Copy")?.disabled).toBe(true);
    expect(find(items, "Paste")?.disabled).toBeFalsy();
  });

  it("New session submenu lists agents and adds the formation / dialog entries", () => {
    const sub = find(buildSessionMenu("s1", { surface: "terminal" }, state()), "New session")!.children!;
    expect(labels(sub)).toContain(shellLabel()); // "PowerShell" on Windows, "Shell" on macOS / Linux
    expect(labels(sub)).toContain("More options…");
    expect(labels(sub)).toContain("Browser");
    expect(labels(sub)).toContain("Launch formation…"); // group not empty / unknown: no "here"
  });

  it("maximized pane offers Restore; hidden view offers Show view", () => {
    const items = buildSessionMenu("s1", { surface: "terminal" }, state({ maximized: true, hidden: true }));
    expect(labels(items)).toContain("Restore");
    expect(labels(items)).toContain("Show view");
    expect(labels(items)).not.toContain("Hide view");
  });
});

describe("buildSessionMenu — states and surfaces", () => {
  it("an exited agent offers Start (resume) / Start fresh and no Stop; Message is disabled", () => {
    const items = buildSessionMenu("s1", { surface: "mission" }, state({ live: false }));
    expect(labels(items)).toContain("Start (resume)");
    expect(labels(items)).toContain("Start fresh");
    expect(labels(items)).not.toContain("Stop");
    expect(labels(items)).not.toContain("Force stop…");
    expect(find(items, "Message…")?.disabled).toBe(true);
    expect(find(items, "Close")?.danger).toBe(true); // no "…": nothing running to stop
  });

  it("a shell has a single Restart (no resume / fresh distinction)", () => {
    const items = buildSessionMenu("s1", { surface: "header" }, state({ agent: "powershell" }));
    expect(labels(items)).toContain("Restart");
    expect(labels(items)).not.toContain("Restart fresh");
  });

  it("Mission Control: jump + keyboard hints, no terminal-only items", () => {
    const items = buildSessionMenu("s1", { surface: "mission" }, state());
    expect(labels(items)[0]).toBe("Jump to pane");
    expect(find(items, "Jump to pane")?.hint).toBe("Enter");
    expect(find(items, "Restart (resume)")?.hint).toBe("R");
    expect(find(items, "Stop")?.hint).toBe("S");
    expect(find(items, "Message…")?.hint).toBe("M");
    expect(find(items, "Close…")?.hint).toBe("Del");
    for (const l of ["Copy", "Paste", "Zoom", "Split", "New session", "Hide view", "Maximize"]) expect(labels(items)).not.toContain(l);
    expect(labels(items)).toContain("Copy output");
    expect(labels(items).indexOf("Hand off…")).toBe(labels(items).indexOf("Message…") + 1);
  });

  it("Hand off… only on the Mission Control surface", () => {
    for (const surface of ["terminal", "header", "fleet", "comms"] as const) expect(labels(buildSessionMenu("s1", { surface }, state()))).not.toContain("Hand off…");
  });

  it("pane header: move left / right follow the position", () => {
    const first = buildSessionMenu("s1", { surface: "header" }, state({ index: 0, count: 2 }));
    expect(find(first, "Move left")?.disabled).toBe(true);
    expect(find(first, "Move right")?.disabled).toBe(false);
    const last = buildSessionMenu("s1", { surface: "header" }, state({ index: 1, count: 2 }));
    expect(find(last, "Move right")?.disabled).toBe(true);
  });

  it("mute toggles label and check mark; role submenu marks the current role", () => {
    const items = buildSessionMenu("s1", { surface: "fleet" }, state({ muted: true, role: "reviewer" }));
    expect(find(items, "Unmute notifications")?.checked).toBe(true);
    const roles = find(items, "Role")!.children!;
    expect(actions(roles).filter((r) => r.checked).map((r) => r.label)).toEqual([expect.stringContaining("Reviewer")]);
    expect(find(roles, "No role")?.checked).toBe(false);
  });

  it("browser panes get no process / input actions", () => {
    const items = buildSessionMenu("w", { surface: "fleet" }, state({ isBrowser: true, live: false }));
    expect(labels(items)).toEqual(["Jump to pane", "Rename…", "Close"]);
  });

  it("listening ports become an 'Open in browser pane' submenu", () => {
    const items = buildSessionMenu("s1", { surface: "terminal" }, state({ ports: [5173, 8080] }));
    expect(labels(find(items, "Open in browser pane")!.children!)).toEqual(["localhost:5173", "localhost:8080"]);
    expect(labels(buildSessionMenu("s1", { surface: "terminal" }, state()))).not.toContain("Open in browser pane");
  });

  it("a missing session yields a single disabled item", () => {
    expect(buildSessionMenu("nope", { surface: "terminal" }, state({ exists: false }))).toEqual([{ label: "Session not found", disabled: true }]);
  });
});

// ---- actions read the stores: destructive ones confirm, Message only opens the composer -------------

function meta(id: string, agent: SessionMeta["agent"] = "claude"): SessionMeta {
  return {
    id,
    name: id,
    agent,
    cwd: "C:\\",
    profileId: null,
    command: null,
    args: [],
    env: [],
    autoStart: false,
    resumeOnRestore: { mode: "continue" },
    agentSessionId: null,
    worktree: null,
    createdAt: null,
    lastExitCode: null,
  };
}

function running(id: string): SessionInfo {
  return { id, name: id, agent: "claude", pid: 1, state: { state: "running" }, cwd: "C:\\", profileId: null, commandDisplay: "", startedAt: "2026-01-01T00:00:00Z", endedAt: null, bytesOut: 0 };
}

describe("menu actions", () => {
  beforeEach(() => {
    useUi.setState({ confirms: [] });
    useAttentionUi.setState({ overlay: null, broadcastPreselect: null });
    useApp.setState({ loaded: true, runtime: {}, hiddenViews: {}, focusedSessionId: null });
    useApp.setState((s) => ({ persisted: { ...s.persisted, workspaces: [], sessions: [], activeWorkspaceId: null } }));
    useApp.getState().createWorkspace("one", null);
    const g = useApp.getState().persisted.workspaces[0].groups[0].id;
    useApp.getState().addSessionMeta(g, meta("a"));
    useApp.getState().addSessionMeta(g, meta("b"));
    useApp.getState().setRuntime(running("a"));
  });

  it("sessionMenuState reads live / position from the stores", () => {
    const st = sessionMenuState("a");
    expect(st.live).toBe(true);
    expect(st.index).toBe(0);
    expect(st.count).toBe(2);
    expect(sessionMenuState("b").live).toBe(false);
  });

  it("Close… on a live session asks first and closes nothing yet", () => {
    find(buildSessionMenu("a", { surface: "terminal" }), "Close…")!.onSelect!();
    expect(useUi.getState().confirms).toHaveLength(1);
    expect(useApp.getState().persisted.sessions.map((m) => m.id)).toContain("a");
  });

  it("Stop from Mission Control asks first", () => {
    find(buildSessionMenu("a", { surface: "mission" }), "Stop")!.onSelect!();
    expect(useUi.getState().confirms).toHaveLength(1);
  });

  it("Restart of a live session asks first", () => {
    find(buildSessionMenu("a", { surface: "terminal" }), "Restart (resume)")!.onSelect!();
    expect(useUi.getState().confirms).toHaveLength(1);
  });

  it("Hand off… lists the other live sessions (none running = disabled, empty submenu)", () => {
    expect(find(buildSessionMenu("b", { surface: "mission" }), "Hand off…")!.children!.map((c) => (c === "separator" ? c : c.label))).toEqual(["a"]);
    expect(find(buildSessionMenu("a", { surface: "mission" }), "Hand off…")!.children).toEqual([]);
  });

  it("Message… opens the Broadcast composer preselected with the session (nothing is sent)", () => {
    find(buildSessionMenu("a", { surface: "mission" }), "Message…")!.onSelect!();
    expect(useAttentionUi.getState().overlay).toBe("broadcast");
    expect(useAttentionUi.getState().broadcastPreselect).toEqual(["a"]);
  });

  it("group menu: message / restart / stop / close target the group; delete needs another group", () => {
    const g = useApp.getState().persisted.workspaces[0].groups[0].id;
    const items = buildGroupMenu(g, { onRename: () => {} });
    expect(labels(items)).toEqual([
      "Rename",
      "New session",
      "Launch formation…",
      "Layout",
      "Message all in group…",
      "Restart all…",
      "Stop all…",
      "Tests",
      "Close all sessions…",
      "Delete group…",
    ]);
    expect(find(items, "Delete group…")?.disabled).toBe(true);
    expect(actions(find(items, "Layout")!.children!).find((c) => c.checked)?.label).toBe("Grid");
    find(items, "Stop all…")!.onSelect!();
    expect(useUi.getState().confirms).toHaveLength(1);
    find(items, "Message all in group…")!.onSelect!();
    expect(useAttentionUi.getState().broadcastPreselect).toEqual(["a"]); // live only
  });
});
