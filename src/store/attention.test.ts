import { beforeEach, describe, expect, it } from "vitest";
import type { SessionAttention } from "../lib/types";
import {
  FEED_LIMIT,
  HOOK_STALE_MS,
  countUnread,
  hookWaitReason,
  nextAttentionTarget,
  reduceAttention,
  useAttention,
  type AttnInput,
  type SessionAttn,
} from "./attention";

const ev = (e: Omit<SessionAttention, "id">): AttnInput => ({ type: "attention", ev: { id: "s", ...e } });
const T = 1_000_000;

function run(inputs: AttnInput[], seen = false): { state: SessionAttn | undefined; alerts: string[] } {
  let state: SessionAttn | undefined;
  const alerts: string[] = [];
  inputs.forEach((i, n) => {
    const r = reduceAttention(state, i, seen, T + n);
    state = r.next;
    if (r.alert) alerts.push(`${r.alert.category}:${r.alert.kind}`);
  });
  return { state, alerts };
}

describe("reduceAttention", () => {
  it("activity: working, then done after a long run", () => {
    const r = run([ev({ kind: "active" }), ev({ kind: "idle", status: "done", activeMs: 65_000 })]);
    expect(r.state).toMatchObject({ state: "done", unread: true, lastMessage: "Finished after 1m 5s" });
    expect(r.alerts).toEqual(["idle:done"]);
  });

  it("a short burst goes back to idle silently", () => {
    const r = run([ev({ kind: "active" }), ev({ kind: "idle", activeMs: 900 })]);
    expect(r.state).toMatchObject({ state: "idle", unread: false });
    expect(r.alerts).toEqual([]);
  });

  it("bell and notify mean waiting-for-you", () => {
    expect(run([ev({ kind: "bell" })]).state).toMatchObject({ state: "waiting", unread: true, lastMessage: "Needs your attention" });
    const n = run([ev({ kind: "notify", title: "Claude", body: "Approve edit?" })]);
    expect(n.state).toMatchObject({ state: "waiting", lastMessage: "Claude: Approve edit?" });
    expect(n.alerts).toEqual(["bell:waiting"]);
  });

  it("maps OSC 7501 states", () => {
    expect(run([ev({ kind: "status", status: "working" })]).state?.state).toBe("working");
    expect(run([ev({ kind: "status", status: "working" })]).alerts).toEqual([]);
    const blocked = run([ev({ kind: "status", status: "blocked", reason: "permission" })]);
    expect(blocked.state).toMatchObject({ state: "waiting", unread: true, lastMessage: "Waiting for permission" });
    expect(blocked.alerts).toEqual(["bell:waiting"]);
    expect(run([ev({ kind: "status", status: "done", body: "All tests pass" })]).state).toMatchObject({ state: "done", lastMessage: "All tests pass" });
    expect(run([ev({ kind: "status", status: "error" })]).alerts).toEqual(["error:error"]);
    // unknown status: state kept, message shown, no alert
    const unk = run([ev({ kind: "active" }), ev({ kind: "status", status: "compacting" })]);
    expect(unk.state).toMatchObject({ state: "working", lastMessage: "Status: compacting" });
    expect(unk.alerts).toEqual([]);
  });

  it("done persists through a later idle status until seen", () => {
    const r = run([ev({ kind: "status", status: "done" }), ev({ kind: "status", status: "idle" })]);
    expect(r.state?.state).toBe("done");
    const seen = reduceAttention({ state: "done", unread: false, at: T }, ev({ kind: "status", status: "idle" }), false, T);
    expect(seen.next.state).toBe("idle");
  });

  it("exits: non-zero is an error, user stop is quiet, start resets", () => {
    expect(run([ev({ kind: "active" }), { type: "exit", code: 2, userStopped: false }]).state).toMatchObject({ state: "error", unread: true, lastMessage: "Exited with code 2" });
    const stopped = run([ev({ kind: "active" }), { type: "exit", code: 1, userStopped: true }]);
    expect(stopped.state).toMatchObject({ state: "idle", unread: false });
    expect(stopped.alerts).toEqual([]);
    expect(run([{ type: "failed", message: "nope" }]).state?.state).toBe("error");
    expect(run([ev({ kind: "bell" }), { type: "start" }]).state).toMatchObject({ state: "idle", unread: false });
  });

  it("never marks the session the user is looking at as unread", () => {
    const r = run([ev({ kind: "bell" })], true);
    expect(r.state).toMatchObject({ state: "waiting", unread: false });
    expect(r.alerts).toEqual(["bell:waiting"]); // the notifier decides whether to toast
  });

  it("returns the same object when nothing changes", () => {
    const a: SessionAttn = { state: "working", unread: false, at: T };
    expect(reduceAttention(a, ev({ kind: "active" }), false, T + 5).next).toBe(a);
  });
});

describe("nextAttentionTarget", () => {
  const S = (state: SessionAttn["state"], unread = false): SessionAttn => ({ state, unread, at: 0 });
  const order = ["a", "b", "c", "d", "e"];

  it("round-robins after the current session and wraps", () => {
    const sessions = { b: S("waiting", true), d: S("done", true) };
    expect(nextAttentionTarget(order, sessions, null)).toBe("b");
    expect(nextAttentionTarget(order, sessions, "b")).toBe("d");
    expect(nextAttentionTarget(order, sessions, "d")).toBe("b");
    expect(nextAttentionTarget(order, sessions, "e")).toBe("b");
  });

  it("prefers unread over already-seen waiting sessions", () => {
    const sessions = { b: S("waiting"), e: S("error", true) };
    expect(nextAttentionTarget(order, sessions, "a")).toBe("e");
    expect(nextAttentionTarget(order, { b: S("waiting") }, "a")).toBe("b");
  });

  it("returns null when nothing needs attention", () => {
    expect(nextAttentionTarget(order, { a: S("working"), b: S("done") }, "a")).toBeNull();
    expect(nextAttentionTarget([], {}, null)).toBeNull();
    // only the current one waits: stay on it
    expect(nextAttentionTarget(order, { c: S("waiting") }, "c")).toBe("c");
  });
});

describe("attention store", () => {
  beforeEach(() => useAttention.setState({ sessions: {}, feed: [] }));

  it("records alerts in the feed and counts unread", () => {
    const st = useAttention.getState();
    expect(st.apply("a", ev({ kind: "bell" }), false)).toMatchObject({ kind: "waiting" });
    expect(st.apply("b", ev({ kind: "active" }), false)).toBeUndefined();
    expect(useAttention.getState().feed.map((f) => f.id)).toEqual(["a"]);
    expect(countUnread(useAttention.getState().sessions)).toBe(1);
    expect(countUnread(useAttention.getState().sessions, ["b"])).toBe(0);
    st.markRead("a");
    expect(countUnread(useAttention.getState().sessions)).toBe(0);
  });

  it("caps the feed and prunes removed sessions", () => {
    const st = useAttention.getState();
    for (let i = 0; i < FEED_LIMIT + 20; i++) st.apply(i % 2 ? "a" : "b", ev({ kind: "bell" }), false, T + i);
    expect(useAttention.getState().feed).toHaveLength(FEED_LIMIT);
    st.prune(new Set(["a"]));
    expect(Object.keys(useAttention.getState().sessions)).toEqual(["a"]);
    expect(useAttention.getState().feed.every((f) => f.id === "a")).toBe(true);
  });

  it("markAllRead / unchanged inputs keep identity", () => {
    const st = useAttention.getState();
    st.apply("a", ev({ kind: "active" }), false);
    const before = useAttention.getState().sessions;
    st.apply("a", ev({ kind: "active" }), false);
    st.markAllRead(); // nothing unread
    expect(useAttention.getState().sessions).toBe(before);
  });
});

describe("hook precedence (Claude Code hooks)", () => {
  const hook = (status: string, extra: Partial<SessionAttention> = {}): AttnInput => ev({ kind: "hook", status, ...extra });
  const S = 1000;

  /** Inputs at explicit times (ms after T). */
  function runAt(steps: [AttnInput, number][], seen = false) {
    let state: SessionAttn | undefined;
    const alerts: string[] = [];
    for (const [i, at] of steps) {
      const r = reduceAttention(state, i, seen, T + at);
      state = r.next;
      if (r.alert) alerts.push(`${r.alert.category}:${r.alert.kind}:${r.alert.message}`);
    }
    return { state, alerts };
  }

  it("permission is waiting with the tool name, alerts once, and heuristics can't hide it", () => {
    const r = runAt([
      [hook("working"), 0],
      [hook("tool", { tool: "Bash" }), 1 * S],
      [ev({ kind: "active" }), 1.5 * S],
      [hook("permission", { tool: "Bash" }), 2 * S],
      // The dialog repaint, the quiet afterwards and Claude's own bell ~6 s later change nothing.
      [ev({ kind: "active" }), 2.1 * S],
      [ev({ kind: "idle", status: "done", activeMs: 9000 }), 7 * S],
      [ev({ kind: "bell" }), 8 * S],
      [ev({ kind: "notify", body: "Claude needs your permission" }), 8.1 * S],
    ]);
    expect(r.state).toMatchObject({ state: "waiting", unread: true, lastMessage: "Needs permission · Bash", hook: { state: "permission", tool: "Bash" } });
    expect(r.alerts).toEqual(["bell:waiting:Needs permission · Bash"]);
  });

  it("a prompt right after another waiting alert doesn't alert twice", () => {
    const r = runAt([
      [ev({ kind: "bell" }), 0],
      [hook("permission", { tool: "Edit" }), 1 * S],
    ]);
    expect(r.state).toMatchObject({ state: "waiting", lastMessage: "Needs permission · Edit" });
    expect(r.alerts).toEqual(["bell:waiting:Needs your attention"]);
  });

  it("answered prompt: running the tool, then the Stop hook is the only 'done'", () => {
    const r = runAt([
      [hook("working"), 0],
      [hook("permission", { tool: "Bash" }), 1 * S],
      [hook("tool", { tool: "Bash" }), 5 * S],
      // A long, quiet tool: the output heuristic must not call it idle (or done).
      [ev({ kind: "idle", status: "done", activeMs: 4000 }), 60 * S],
      [hook("working"), 90 * S],
      [hook("stopped", { activeMs: 95_000 }), 95 * S],
      // The final repaint and its quiet: no second alert, no flip to working.
      [ev({ kind: "active" }), 96 * S],
      [ev({ kind: "idle", status: "done", activeMs: 5000 }), 100 * S],
    ]);
    expect(r.state).toMatchObject({ state: "done", unread: true, lastMessage: "Finished after 1m 35s", hook: { state: "stopped" } });
    expect(r.alerts).toEqual(["bell:waiting:Needs permission · Bash", "idle:done:Finished after 1m 35s"]);
    const mid = runAt([
      [hook("tool", { tool: "Bash" }), 0],
      [ev({ kind: "idle" }), 30 * S],
    ]);
    expect(mid.state).toMatchObject({ state: "working", lastMessage: "Running Bash" });
  });

  it("a stale working hook lets the heuristic fill the gap (quietly)", () => {
    const r = runAt([
      [hook("working"), 0],
      [ev({ kind: "idle", status: "done", activeMs: 9000 }), HOOK_STALE_MS + 1],
    ]);
    expect(r.state).toMatchObject({ state: "idle" });
    expect(r.alerts).toEqual([]);
    // New work after a finished turn (no hook for it yet) still shows as working once the repaint has settled.
    const later = runAt([
      [hook("stopped", { activeMs: 10_000 }), 0],
      [ev({ kind: "active" }), 30 * S],
    ]);
    expect(later.state?.state).toBe("working");
  });

  it("short turns end quietly, interrupts are quiet, stop failures are errors", () => {
    expect(runAt([[hook("working"), 0], [hook("stopped", { activeMs: 1200 }), 1.2 * S]]).alerts).toEqual([]);
    const i = runAt([[hook("tool", { tool: "Bash" }), 0], [hook("stopped", { reason: "interrupt" }), S]]);
    expect(i.state).toMatchObject({ state: "idle", lastMessage: "Interrupted" });
    expect(i.alerts).toEqual([]);
    const f = runAt([[hook("working"), 0], [hook("stopped", { reason: "rate_limit" }), S]]);
    expect(f.state).toMatchObject({ state: "error", lastMessage: "Stopped: rate limit" });
    expect(f.alerts).toEqual(["error:error:Stopped: rate limit"]);
  });

  it("idle prompt and session events are quiet; done stays until seen", () => {
    const r = runAt([
      [hook("working"), 0],
      [hook("stopped", { activeMs: 30_000 }), 30 * S],
      [hook("idle-prompt"), 90 * S],
    ]);
    expect(r.state).toMatchObject({ state: "done", unread: true, lastMessage: "Waiting for your next prompt" });
    expect(r.alerts).toHaveLength(1);
    const seen = runAt([[hook("idle-prompt"), 0]], true);
    expect(seen.state).toMatchObject({ state: "idle", unread: false });
    const q = runAt([[hook("input", { tool: "AskUserQuestion" }), 0]]);
    expect(q.state).toMatchObject({ state: "waiting", lastMessage: "Asks you a question" });
    const bogus = runAt([[hook("bogus"), 0]]);
    expect(bogus.state?.hook).toBeUndefined();
    expect(bogus.alerts).toEqual([]);
  });

  it("start / exit drop the hook state (heuristics rule again)", () => {
    const r = runAt([
      [hook("permission", { tool: "Bash" }), 0],
      [{ type: "exit", code: 0, userStopped: true }, S],
      [{ type: "start" }, 2 * S],
      [ev({ kind: "bell" }), 3 * S],
    ]);
    expect(r.state?.hook).toBeUndefined();
    expect(r.alerts).toEqual(["bell:waiting:Needs permission · Bash", "bell:waiting:Needs your attention"]);
  });

  it("hookWaitReason names the prompt", () => {
    const at = (h: SessionAttn["hook"]): SessionAttn => ({ state: "waiting", unread: false, at: 0, hook: h });
    expect(hookWaitReason(at({ state: "permission", tool: "Bash", at: 0 }))).toBe("is waiting for permission to use Bash");
    expect(hookWaitReason(at({ state: "permission", tool: "mcp__github__create_issue", at: 0 }))).toBe("is waiting for permission to use github create_issue");
    expect(hookWaitReason(at({ state: "input", tool: "ExitPlanMode", at: 0 }))).toMatch(/plan/);
    expect(hookWaitReason(at({ state: "tool", tool: "Bash", at: 0 }))).toBeNull();
    expect(hookWaitReason(undefined)).toBeNull();
  });
});
