import { describe, expect, it } from "vitest";
import type { SessionInfo } from "../../lib/types";
import type { SessionAttn } from "../../store/attention";
import { normalizeRole, roleInfo, roleTag } from "../../lib/roles";
import { looksLikeQuestion } from "../../actions/starterPrompt";
import { trailWidth } from "./ActivityRiver";
import { deriveMission, laneOf, laneProgress, phaseMark, sessionStatus, type SessionStatus } from "./derive";
import { linkPath } from "./Links";
import { sparkPath } from "./Sparkline";

const rt = (state: SessionInfo["state"]): SessionInfo => ({
  id: "x",
  name: "x",
  agent: "claude",
  pid: 1,
  state,
  cwd: "C:\\",
  profileId: null,
  commandDisplay: "",
  startedAt: "2026-10-17T10:00:00Z",
  endedAt: null,
  bytesOut: 0,
});
const a = (state: SessionAttn["state"], unread = false): SessionAttn => ({ state, unread, at: 0 });

describe("sessionStatus", () => {
  it("derives done / needs / working from real state", () => {
    expect(sessionStatus(rt({ state: "running" }), a("working"))).toMatchObject({ lamp: "working", working: true, live: true, done: false });
    expect(sessionStatus(rt({ state: "running" }), a("waiting", true))).toMatchObject({ lamp: "waiting", needs: true });
    expect(sessionStatus(rt({ state: "exited", code: 0 }), undefined)).toMatchObject({ lamp: "exited", done: true, live: false });
    expect(sessionStatus(rt({ state: "exited", code: 2 }), undefined)).toMatchObject({ lamp: "error", done: false });
    expect(sessionStatus(undefined, undefined)).toMatchObject({ lamp: "stopped", live: false, needs: false });
  });
});

describe("deriveMission", () => {
  const st: Record<string, SessionStatus> = {
    lead: sessionStatus(rt({ state: "running" }), a("idle")),
    b1: sessionStatus(rt({ state: "running" }), a("working")),
    b2: sessionStatus(rt({ state: "running" }), a("done", true)),
    b3: sessionStatus(rt({ state: "running" }), a("waiting", true)),
    r1: sessionStatus(rt({ state: "exited", code: 1 }), undefined),
  };
  const roles: Record<string, string | null> = { lead: "lead", b1: "builder", b2: "builder", b3: "builder", r1: "reviewer" };
  const groups = [
    { id: "g1", name: "Plan", sessionIds: ["lead"] },
    { id: "g2", name: "Build", sessionIds: ["b1", "b2", "b3"] },
    { id: "g3", name: "Verify", sessionIds: ["r1"] },
    { id: "g4", name: "Empty", sessionIds: [] },
  ];
  const m = deriveMission(groups, (id) => roles[id], (id) => st[id]);
  it("puts leads in the lead node and hides lead-only groups", () => {
    expect(m.leads).toEqual(["lead"]);
    expect(m.lanes.map((l) => l.name)).toEqual(["Build", "Verify", "Empty"]);
  });
  it("counts lanes from real states", () => {
    const build = m.lanes[0];
    expect(build).toMatchObject({ total: 3, done: 1, working: 1, needs: 2, state: "needs" });
    expect(m.lanes[1]).toMatchObject({ total: 1, errors: 1, done: 0, state: "idle" });
    expect(m.lanes[2]).toMatchObject({ total: 0, state: "empty" });
  });
  it("lists waiting / done sessions for sign-off and totals", () => {
    expect(m.signoff).toEqual(["b2", "b3"]);
    expect(m.counts).toEqual({ total: 5, live: 4, working: 1, needs: 2, done: 1, errors: 1 });
  });
  it("progress is done/total and only for non-empty lanes", () => {
    expect(laneProgress(m.lanes[0])).toEqual({ label: "1/3 done", fraction: 1 / 3 });
    expect(laneProgress(m.lanes[2])).toBeNull();
  });
  it("phase marks", () => {
    const done = laneOf({ id: "g", name: "g" }, ["b2"], (id) => st[id]);
    expect(phaseMark(done)).toBe("✓");
    expect(phaseMark(m.lanes[0])).toBe("!");
    expect(phaseMark(laneOf({ id: "g", name: "g" }, ["b1"], (id) => st[id]))).toBe("●");
    expect(phaseMark(m.lanes[1])).toBe("○");
  });
});

describe("roles", () => {
  it("normalizes like the Rust side", () => {
    expect(normalizeRole("  Lead ")).toBe("lead");
    expect(normalizeRole("Db Migrator")).toBe("db-migrator");
    expect(normalizeRole("<script>")).toBe("script");
    expect(normalizeRole("a-very-long-custom-role-name-here")).toBe("a-very-long-custom-role");
    expect(normalizeRole("!!!")).toBeNull();
  });
  it("maps colours to CSS variables", () => {
    expect(roleInfo("builder")).toMatchObject({ color: "var(--role-builder)", builtin: true });
    expect(roleInfo("docs")).toMatchObject({ color: "var(--role-custom)", builtin: false });
    expect(roleTag("verifier")).toBe("VERIFIER");
    expect(roleInfo(null)).toBeNull();
  });
});

describe("drawing helpers", () => {
  it("sparkPath scales with a 2 KB/s floor", () => {
    expect(sparkPath([5]).line).toBe("");
    const p = sparkPath([0, 4096], 120, 14);
    expect(p.peak).toBe(4096);
    expect(p.line.startsWith("M")).toBe(true);
    const flat = sparkPath([10, 10], 120, 14);
    expect(flat.line).toContain(",12.9"); // tiny rates stay near the baseline (y = 13)
  });
  it("linkPath is a vertical S-curve", () => {
    expect(linkPath({ x: 0, y: 0 }, { x: 10, y: 20 })).toBe("M0.0,0.0 C0.0,10.0 10.0,10.0 10.0,20.0");
  });
  it("trailWidth grows with rate (log) and has a hairline floor", () => {
    expect(trailWidth(0, 1000, 8)).toBe(0.5);
    const lo = trailWidth(1024, 100_000, 8);
    const hi = trailWidth(100_000, 100_000, 8);
    expect(lo).toBeGreaterThan(0.5);
    expect(hi).toBeCloseTo(8);
    expect(hi).toBeGreaterThan(lo);
  });
});

describe("starter prompt safety", () => {
  it("detects agents asking for confirmation", () => {
    expect(looksLikeQuestion("Do you trust the files in this folder?\n❯ 1. Yes, proceed\n  2. No, exit")).toBe(true);
    expect(looksLikeQuestion("Allow Codex to work in this folder without asking for approval?")).toBe(true);
    expect(looksLikeQuestion("Overwrite file? (y/n)")).toBe(true);
    expect(looksLikeQuestion("Please run /login to sign in")).toBe(true);
  });
  it("lets a normal idle prompt through", () => {
    expect(looksLikeQuestion("╭────╮\n│ >  │\n╰────╯\n  ? for shortcuts")).toBe(false);
    expect(looksLikeQuestion("")).toBe(false);
    expect(looksLikeQuestion("  ⏵⏵ accept edits on (shift+tab to cycle)\n  bypass permissions off")).toBe(false);
  });
});
