import { describe, expect, it } from "vitest";
import type { ReplayEvent, ReplayMember } from "./events";
import {
  applyEvent,
  buildTimeline,
  buildTimeMap,
  currentTask,
  emptyState,
  formatClockRange,
  formatCount,
  formatWall,
  GAP_MS,
  HOLD_MS,
  KEYFRAME_EVERY,
  LEAD_MS,
  makePlan,
  realToScene,
  realToVirtual,
  sceneClock,
  squeezeGap,
  stateAt,
  totals,
  virtualToReal,
  type SceneState,
} from "./timeline";

const T0 = Date.UTC(2026, 9, 18, 8, 42);
const min = 60_000;
const member = (slug: string, role: string | null, live = true): ReplayMember => ({ slug, name: slug, role, agent: "claude", live });

function mission(): ReplayEvent[] {
  return [
    { t: T0, k: "start", v: 1, goal: "Add OAuth login", team: [member("lead", "lead"), member("builder-1", "builder"), member("builder-2", "builder")], tasks: [{ text: "Design token storage", s: "todo", o: ["lead"] }, { text: "Implement callback", s: "todo", o: ["builder-1"] }, { text: "Login button", s: "todo", o: ["builder-2"] }] },
    { t: T0 + 1000, k: "branch", slug: "builder-1", w: "aaaa0001", ahead: 4, files: 10, ins: 300, del: 20 },
    { t: T0 + 1000, k: "branch", slug: "builder-2", w: "aaaa0002", ahead: 0, files: 0, ins: 0, del: 0 },
    { t: T0 + 2 * min, k: "attn", slug: "builder-1", s: "working" },
    { t: T0 + 3 * min, k: "task", text: "Implement callback", s: "doing", o: ["builder-1"] },
    { t: T0 + 5 * min, k: "msg", from: "lead", to: ["builder-1"], text: "add tests" },
    { t: T0 + 70 * min, k: "branch", slug: "builder-1", w: "aaaa0001", ahead: 7, files: 14, ins: 420, del: 25 },
    { t: T0 + 71 * min, k: "task", text: "Implement callback", s: "done", o: ["builder-1"] },
    { t: T0 + 72 * min, k: "attn", slug: "builder-1", s: "done" },
    { t: T0 + 80 * min, k: "branch", slug: "builder-2", w: "aaaa0002", ahead: 2, files: 3, ins: 50, del: 5 },
    { t: T0 + 81 * min, k: "task", text: "Login button", s: "done", o: ["builder-2"] },
    { t: T0 + 85 * min, k: "end" },
  ];
}

describe("time compression", () => {
  it("squeezes only gaps longer than GAP_MS, and boundedly", () => {
    expect(squeezeGap(30_000)).toBe(30_000);
    expect(squeezeGap(GAP_MS)).toBe(GAP_MS);
    expect(squeezeGap(GAP_MS + 20 * min)).toBe(GAP_MS + 60_000);
    expect(squeezeGap(10 * 3600_000)).toBe(2 * GAP_MS);
    expect(squeezeGap(-5)).toBe(0);
  });

  it("is the identity without long gaps", () => {
    const m = buildTimeMap([T0, T0 + 30_000, T0 + 90_000]);
    expect(m.span).toBe(90_000);
    expect(realToVirtual(m, T0 + 45_000)).toBe(45_000);
    expect(virtualToReal(m, 45_000)).toBe(T0 + 45_000);
  });

  it("compresses a long idle gap and stays monotone and invertible", () => {
    const m = buildTimeMap([T0, T0 + min, T0 + 61 * min, T0 + 62 * min]);
    expect(m.span).toBe(min + squeezeGap(60 * min) + min);
    let prev = -1;
    for (let r = T0; r <= T0 + 62 * min; r += 37_000) {
      const v = realToVirtual(m, r);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
      expect(Math.abs(virtualToReal(m, v) - r)).toBeLessThan(2);
    }
    expect(realToVirtual(m, T0 - 999)).toBe(0);
    expect(realToVirtual(m, T0 + 999 * min)).toBe(m.span);
    expect(buildTimeMap([]).span).toBe(0);
  });
});

describe("video schedule", () => {
  const tl = buildTimeline(mission());
  const plan = makePlan(tl, 30);

  it("title 1.5 s, main, end 2.5 s", () => {
    expect(plan.totalMs).toBe(30_000);
    expect(sceneClock(plan, 0)).toMatchObject({ phase: "title", real: T0, p: 0 });
    expect(sceneClock(plan, 1499).phase).toBe("title");
    expect(sceneClock(plan, 1500 + LEAD_MS / 2)).toMatchObject({ phase: "main", real: T0, p: 0 });
    const end = sceneClock(plan, 30_000 - 2500 - HOLD_MS / 2);
    expect(end.phase).toBe("main");
    expect(end.real).toBe(T0 + 85 * min);
    expect(sceneClock(plan, 29_000)).toMatchObject({ phase: "end", real: T0 + 85 * min, p: 1 });
    expect(sceneClock(plan, 99_999).phase).toBe("end");
  });

  it("maps real time to video time monotonically and consistently", () => {
    let prev = 0;
    for (let r = T0; r <= T0 + 85 * min; r += 5 * min) {
      const s = realToScene(plan, r);
      expect(s).toBeGreaterThanOrEqual(prev);
      prev = s;
      const c = sceneClock(plan, s);
      expect(c.phase).toBe("main");
      expect(Math.abs(c.real - r)).toBeLessThan(5);
    }
  });

  it("idle gaps get less video time than activity", () => {
    // Between 5 min and 70 min nothing happens; it must take less than half the main scene.
    const a = realToScene(plan, T0 + 5 * min);
    const b = realToScene(plan, T0 + 70 * min);
    expect(b - a).toBeLessThan(plan.mainMs / 2);
  });
});

describe("scene state", () => {
  const tl = buildTimeline(mission());

  it("tracks tasks, progress, attention and messages", () => {
    const s = stateAt(tl, T0 + 4 * min);
    expect(s.goal).toBe("Add OAuth login");
    expect(s.tasks.map((t) => `${t.text}:${t.s}`)).toEqual(["Design token storage:todo", "Implement callback:doing", "Login button:todo"]);
    expect(s.tasks[1].prev).toBe("todo");
    expect(s.agents.find((a) => a.slug === "builder-1")?.attn).toBe("working");
    expect(currentTask(s, s.agents[1])?.text).toBe("Implement callback");
    expect(currentTask(s, s.agents[0])?.text).toBe("Design token storage");
    expect(s.msgs).toHaveLength(0);
    expect(stateAt(tl, T0 + 6 * min).msgs[0]).toMatchObject({ from: "lead", to: ["builder-1"], text: "add tests" });
  });

  it("counts branch work against the first observation, never what came before", () => {
    const early = stateAt(tl, T0 + 2 * min);
    expect(totals(early)).toEqual({ ahead: 0, files: 0, ins: 0, del: 0 });
    const s = stateAt(tl, T0 + 90 * min);
    expect(s.branches.aaaa0001.hw).toEqual({ ahead: 3, files: 4, ins: 120, del: 5 });
    expect(totals(s)).toEqual({ ahead: 5, files: 7, ins: 170, del: 10 });
  });

  it("keeps the high-water mark when a branch shrinks (merged)", () => {
    const s = emptyState();
    applyEvent(s, { t: 1, k: "branch", slug: "b", w: "w1", ahead: 1, files: 1, ins: 1, del: 0 });
    applyEvent(s, { t: 2, k: "branch", slug: "b", w: "w1", ahead: 5, files: 4, ins: 90, del: 9 });
    applyEvent(s, { t: 3, k: "branch", slug: "b", w: "w1", ahead: 0, files: 0, ins: 0, del: 0 });
    expect(s.branches.w1.hw).toEqual({ ahead: 4, files: 3, ins: 89, del: 9 });
    expect(s.branches.w1.at).toBe(2);
  });

  it("counts a worktree shared by two agents once", () => {
    const s = emptyState();
    for (const slug of ["a", "b"]) applyEvent(s, { t: 1, k: "branch", slug, w: "same", ahead: 0, files: 0, ins: 0, del: 0 });
    for (const slug of ["a", "b"]) applyEvent(s, { t: 2, k: "branch", slug, w: "same", ahead: 2, files: 2, ins: 2, del: 2 });
    expect(totals(s).ahead).toBe(2);
  });

  it("stats for the end card", () => {
    expect(tl.stats).toMatchObject({ tasksDone: 2, tasksTotal: 3, commits: 5, files: 7, ins: 170, del: 10, agents: 3, wallMs: 85 * min, msgs: 1 });
    expect(tl.final.ended).toBe(true);
  });

  it("keyframes give the same state as replaying every event", () => {
    const events: ReplayEvent[] = [{ t: T0, k: "start", v: 1, goal: "g", team: [member("a", "builder"), member("b", "reviewer")], tasks: [] }];
    for (let i = 1; i < KEYFRAME_EVERY * 3 + 17; i++) {
      const t = T0 + i * 1000;
      if (i % 3 === 0) events.push({ t, k: "attn", slug: i % 2 ? "a" : "b", s: i % 4 ? "working" : "idle" });
      else if (i % 3 === 1) events.push({ t, k: "task", text: `task ${i % 40}`, s: i % 5 ? "doing" : "done", o: ["a"] });
      else events.push({ t, k: "msg", from: "a", to: ["b"], text: `m${i}` });
    }
    const big = buildTimeline(events);
    expect(big.keyframes.length).toBeGreaterThan(3);
    for (const at of [T0 + 199_500, T0 + 200_000, T0 + 433_000, T0 + 10_000_000]) {
      const viaKeyframe = stateAt(big, at);
      const linear = emptyState();
      for (const e of events) if (e.t <= at) applyEvent(linear, e);
      expect(strip(viaKeyframe)).toEqual(strip(linear));
    }
    // stateAt returns a copy: mutating it never leaks into the timeline.
    stateAt(big, T0 + 450_000).tasks.length = 0;
    expect(stateAt(big, T0 + 450_000).tasks.length).toBeGreaterThan(0);
  });

  it("a resumed recording re-syncs roster and board", () => {
    const s = emptyState();
    applyEvent(s, { t: 1, k: "start", v: 1, goal: "g", team: [member("a", null), member("b", null)], tasks: [{ text: "x", s: "todo", o: [] }, { text: "y", s: "done", o: [] }] });
    applyEvent(s, { t: 5, k: "start", v: 1, goal: "g2", team: [member("a", null), member("c", null, false)], tasks: [{ text: "x", s: "doing", o: [] }] });
    expect(s.goal).toBe("g2");
    expect(s.tasks.map((t) => `${t.text}:${t.s}`)).toEqual(["x:doing"]);
    expect(s.agents.find((a) => a.slug === "b")).toMatchObject({ live: false, leftWhy: "removed" });
    expect(s.agents.find((a) => a.slug === "c")).toMatchObject({ live: false, everLive: false });
  });

  it("join / leave / rename", () => {
    const s = emptyState();
    applyEvent(s, { t: 1, k: "join", slug: "b1", name: "b1", role: "builder", agent: "codex" });
    applyEvent(s, { t: 2, k: "attn", slug: "b1", s: "working" });
    applyEvent(s, { t: 3, k: "leave", slug: "b1", why: "error" });
    expect(s.agents[0]).toMatchObject({ live: false, attn: "error", leftWhy: "error" });
    applyEvent(s, { t: 4, k: "join", slug: "builder-one", name: "builder one", role: "builder", agent: "codex", was: "b1" });
    expect(s.agents).toHaveLength(1);
    expect(s.agents[0]).toMatchObject({ slug: "builder-one", live: true, leftWhy: null });
  });

  it("renamed tasks keep their place", () => {
    const s = emptyState();
    applyEvent(s, { t: 1, k: "task", text: "a", s: "todo", o: [] });
    applyEvent(s, { t: 1, k: "task", text: "b", s: "todo", o: [] });
    applyEvent(s, { t: 2, k: "task", text: "a2", s: "doing", o: [], was: "a" });
    expect(s.tasks.map((t) => t.text)).toEqual(["a2", "b"]);
    applyEvent(s, { t: 3, k: "task", text: "b", s: "gone", o: [] });
    expect(s.tasks.map((t) => t.text)).toEqual(["a2"]);
    expect(s.progPrev).toEqual({ done: 0, total: 2 });
  });
});

function strip(s: SceneState) {
  return { ...s, seq: 0 };
}

describe("formatting", () => {
  it("wall time, counts, ranges", () => {
    expect(formatWall(38_000)).toBe("38 s");
    expect(formatWall(45 * min)).toBe("45 m");
    expect(formatWall(129 * min)).toBe("2 h 09 m");
    expect(formatCount(1234)).toBe("1,234");
    expect(formatCount(12_345)).toBe("12.3k");
    expect(formatCount(-3)).toBe("0");
    const a = new Date(2026, 9, 18, 10, 42).getTime();
    expect(formatClockRange(a, a + 129 * min)).toBe("10:42 → 12:51");
    expect(formatClockRange(a, a + 20 * 3600_000)).toBe("Oct 18 10:42 → Oct 19 06:42");
  });
});
