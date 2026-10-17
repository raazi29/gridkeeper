import { beforeEach, describe, expect, it } from "vitest";
import type { SessionInfo } from "../lib/types";
import {
  ACTIVITY_LIMIT,
  isLifecycleEcho,
  mapAttentionTransition,
  mapLifecycle,
  matchesActivityFilter,
  pushRing,
  recordActivity,
  useActivity,
  type ActivityEvent,
} from "./activity";
import type { SessionAttn } from "./attention";

function info(state: SessionInfo["state"], startedAt: string | null = "2026-10-17T10:00:00Z", pid: number | null = 42): SessionInfo {
  return { id: "s1", name: "S1", agent: "claude", pid, state, cwd: "C:\\", profileId: null, commandDisplay: "", startedAt, endedAt: null, bytesOut: 0 };
}
const attn = (state: SessionAttn["state"], lastMessage?: string): SessionAttn => ({ state, unread: false, lastMessage, at: 1 });

describe("pushRing", () => {
  it("appends and keeps the newest `limit` items", () => {
    let list: number[] = [];
    for (let i = 1; i <= 7; i++) list = pushRing(list, i, 5);
    expect(list).toEqual([3, 4, 5, 6, 7]);
  });
  it("does not mutate the input", () => {
    const a = [1, 2];
    const b = pushRing(a, 3, 5);
    expect(a).toEqual([1, 2]);
    expect(b).toEqual([1, 2, 3]);
  });
  it("handles limit 1 and 0", () => {
    expect(pushRing([1, 2, 3], 4, 1)).toEqual([4]);
    expect(pushRing([1], 2, 0)).toEqual([]);
  });
});

describe("activity store ring buffer", () => {
  beforeEach(() => useActivity.getState().clear());
  it("keeps the last ACTIVITY_LIMIT events with increasing seq", () => {
    for (let i = 0; i < ACTIVITY_LIMIT + 25; i++)
      recordActivity({ sessionId: "s", sessionName: "s", role: null, agent: "codex", kind: "lifecycle", level: "info", message: `m${i}` });
    const ev = useActivity.getState().events;
    expect(ev).toHaveLength(ACTIVITY_LIMIT);
    expect(ev[0].message).toBe("m25");
    expect(ev[ev.length - 1].message).toBe(`m${ACTIVITY_LIMIT + 24}`);
    for (let i = 1; i < ev.length; i++) expect(ev[i].seq).toBeGreaterThan(ev[i - 1].seq);
  });
});

describe("mapAttentionTransition", () => {
  it("logs transitions into working / waiting / done / error", () => {
    expect(mapAttentionTransition(undefined, attn("working"))?.message).toBe("working");
    expect(mapAttentionTransition(attn("working"), attn("waiting", "Waiting for permission"))).toEqual({
      level: "needs",
      message: "Waiting for permission",
      result: "needs you",
    });
    expect(mapAttentionTransition(attn("working"), attn("done", "Finished after 12s"))?.level).toBe("ok");
    expect(mapAttentionTransition(attn("working"), attn("error"))?.level).toBe("error");
  });
  it("drops quiet transitions and repeats", () => {
    expect(mapAttentionTransition(attn("working"), attn("idle"))).toBeNull();
    expect(mapAttentionTransition(attn("working"), attn("working"))).toBeNull();
    expect(mapAttentionTransition(undefined, attn("idle"))).toBeNull();
  });
  it("recognises exit / failure echoes", () => {
    expect(isLifecycleEcho(attn("done", "Exited (code 0)"))).toBe(true);
    expect(isLifecycleEcho(attn("error", "Failed to start: nope"))).toBe(true);
    expect(isLifecycleEcho(attn("done", "Finished after 3s"))).toBe(false);
  });
});

describe("mapLifecycle", () => {
  it("logs one start per run (keyed by startedAt), with account and worktree", () => {
    const m = mapLifecycle(undefined, info({ state: "running" }), { profileName: "work", worktreeBranch: "gk/x/builder-1" });
    expect(m?.message).toBe("started claude · account work · worktree gk/x/builder-1");
    expect(m?.result).toBe("pid 42");
    const prev = { state: "running", startedAt: "2026-10-17T10:00:00Z" };
    expect(mapLifecycle(prev, info({ state: "running" }), {})).toBeNull();
  });
  it("ignores the optimistic starting snapshot without startedAt", () => {
    expect(mapLifecycle(undefined, info({ state: "starting" }, null, null), {})).toBeNull();
  });
  it("maps exits, user stops and failures", () => {
    const run = { state: "running", startedAt: "2026-10-17T10:00:00Z" };
    expect(mapLifecycle(run, info({ state: "exited", code: 0 }), {})).toEqual({ level: "ok", message: "exited", result: "exit 0" });
    expect(mapLifecycle(run, info({ state: "exited", code: 3 }), {})?.level).toBe("error");
    expect(mapLifecycle({ ...run, state: "stopping" }, info({ state: "exited", code: 1 }), {})?.message).toBe("stopped by user");
    expect(mapLifecycle(run, info({ state: "failed", message: "not found" }), {})?.message).toBe("failed to start: not found");
    // Same coarse state again: nothing.
    expect(mapLifecycle({ ...run, state: "exited" }, info({ state: "exited", code: 0 }), {})).toBeNull();
  });
});

describe("matchesActivityFilter", () => {
  const ev = (p: Partial<ActivityEvent>): ActivityEvent => ({
    seq: 1,
    at: 0,
    sessionId: "s",
    sessionName: "s",
    role: null,
    agent: null,
    kind: "attention",
    level: "info",
    message: "",
    ...p,
  });
  it("filters by level and kind", () => {
    expect(matchesActivityFilter(ev({ level: "needs" }), "needs")).toBe(true);
    expect(matchesActivityFilter(ev({ level: "info" }), "needs")).toBe(false);
    expect(matchesActivityFilter(ev({ level: "error" }), "errors")).toBe(true);
    expect(matchesActivityFilter(ev({ kind: "lifecycle" }), "lifecycle")).toBe(true);
    expect(matchesActivityFilter(ev({ kind: "worktree" }), "lifecycle")).toBe(true);
    expect(matchesActivityFilter(ev({ kind: "broadcast" }), "lifecycle")).toBe(false);
    expect(matchesActivityFilter(ev({}), "all")).toBe(true);
  });
});
