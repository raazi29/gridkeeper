import { describe, expect, it } from "vitest";
import type { AgentKind, PersistedState, SessionInfo, SessionMeta } from "../lib/types";
import { DEFAULT_SETTINGS } from "../lib/types";
import {
  broadcastCandidates,
  confirmationReason,
  defaultBroadcastTargets,
  filterByAgent,
  resolveTargets,
} from "./broadcast";

function meta(id: string, agent: AgentKind): SessionMeta {
  return {
    id,
    name: id.toUpperCase(),
    agent,
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

function info(id: string, state: SessionInfo["state"]): SessionInfo {
  return { id, name: id, agent: "generic", pid: 1, state, cwd: "", profileId: null, commandDisplay: "", startedAt: null, endedAt: null, bytesOut: 0 };
}

const layout = { preset: "grid" as const, maximized: null, sizes: {} };
const persisted: PersistedState = {
  version: 1,
  settings: DEFAULT_SETTINGS,
  activeWorkspaceId: "w1",
  sessions: [meta("a", "claude"), meta("b", "codex"), meta("c", "powershell"), meta("d", "claude"), meta("e", "claude")],
  workspaces: [
    {
      id: "w1",
      name: "One",
      projectDir: null,
      createdAt: null,
      activeGroupId: "g1",
      groups: [
        { id: "g1", name: "Main", layout, sessionIds: ["a", "b", "c"] },
        { id: "g2", name: "Side", layout, sessionIds: ["d"] },
      ],
    },
    { id: "w2", name: "Two", projectDir: null, createdAt: null, activeGroupId: "g3", groups: [{ id: "g3", name: "Main", layout, sessionIds: ["e"] }] },
  ],
};
const running = { state: "running" } as const;
const runtime: Record<string, SessionInfo> = {
  a: info("a", running),
  b: info("b", running),
  c: info("c", { state: "exited", code: 0 }), // not live
  d: info("d", running),
  e: info("e", { state: "starting" }),
};

describe("broadcast targets", () => {
  const cands = broadcastCandidates({ persisted, runtime });

  it("lists only live sessions in workspace/group/pane order", () => {
    expect(cands.map((c) => c.id)).toEqual(["a", "b", "d", "e"]);
    expect(cands[3]).toMatchObject({ workspaceId: "w2", workspaceName: "Two", groupName: "Main" });
  });

  it("defaults to the live sessions of the active group", () => {
    expect(defaultBroadcastTargets(cands, "g1")).toEqual(["a", "b"]);
    expect(defaultBroadcastTargets(cands, undefined)).toEqual([]);
  });

  it("filters by agent", () => {
    expect(filterByAgent(cands, "claude").map((c) => c.id)).toEqual(["a", "d", "e"]);
    expect(filterByAgent(cands, "all")).toHaveLength(4);
  });

  it("resolves selections against live candidates only", () => {
    expect(resolveTargets(cands, new Set(["c", "e", "a", "gone"])).map((c) => c.id)).toEqual(["a", "e"]);
  });

  it("requires confirmation above 3 targets or across workspaces", () => {
    expect(confirmationReason(resolveTargets(cands, new Set(["a", "b", "d"])), "w1")).toBeNull();
    expect(confirmationReason(resolveTargets(cands, new Set(["a", "e"])), "w1")).toMatch(/other workspace: Two/);
    const four = ["p", "q", "r", "s"].map((id) => ({ ...cands[0], id }));
    expect(confirmationReason(four, "w1")).toBe("4 sessions");
    expect(confirmationReason(four.slice(1), "w1")).toBeNull();
  });
});
