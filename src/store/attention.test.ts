import { beforeEach, describe, expect, it } from "vitest";
import type { SessionAttention } from "../lib/types";
import {
  FEED_LIMIT,
  countUnread,
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

  it("a late idle never overwrites waiting (needs input)", () => {
    const r = run([ev({ kind: "bell" }), ev({ kind: "idle", status: "done", activeMs: 65_000 })]);
    expect(r.state).toMatchObject({ state: "waiting" });
    expect(r.alerts).toEqual(["bell:waiting"]);
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
