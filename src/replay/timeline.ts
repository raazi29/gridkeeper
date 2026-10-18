// Mission replay: the pure scene model behind the timelapse. Node-safe (unit-tested).
//
//   buildTimeline(events)   sorted events → time map (idle gaps squeezed), keyframe snapshots of the
//                           scene state every KEYFRAME_EVERY events, final state and totals.
//   makePlan(tl, seconds)   the video schedule: title card, main scene, end card.
//   sceneClock(plan, ms)    video time → phase + the REAL time shown at that moment.
//   stateAt(tl, real)       scene state (goal, agents, tasks, counters, messages) at a real time:
//                           nearest keyframe + the events after it; cheap enough for every frame.
//
// Everything shown comes from recorded events. Branch counters are deltas against the first
// observation of each worktree (work done before the recording is never counted) and keep their
// high-water mark (merging a branch into main does not make work "un-happen").

import { currentTaskFor, type Task, type TaskState } from "../lib/missionDoc";
import type { LeaveReason, ReplayAttn, ReplayEvent } from "./events";

/** Gaps longer than this between events are squeezed (activity dominates the video). */
export const GAP_MS = 2 * 60_000;
export const TITLE_MS = 1500;
export const END_MS = 2500;
/** Main scene: a beat before the first event and a hold after the last one. */
export const LEAD_MS = 400;
export const HOLD_MS = 900;
export const LENGTHS = [15, 30, 45, 60] as const;
export type ReplayLength = (typeof LENGTHS)[number];
export const KEYFRAME_EVERY = 200;
export const MSG_KEEP = 6;

// ---- time compression ---------------------------------------------------------------------------

/** Squeezed length of an idle gap: unchanged up to GAP_MS, then 5 % of the rest, at most 2 × GAP_MS total. */
export function squeezeGap(g: number, gap = GAP_MS): number {
  if (!(g > gap)) return Math.max(0, g);
  return gap + Math.min(gap, (g - gap) * 0.05);
}

export interface TimeMap {
  t0: number;
  t1: number;
  /** [real ms epoch, virtual ms] knots; linear in between (slope 1 except across squeezed gaps). */
  knots: [number, number][];
  /** Virtual (compressed) length in ms. */
  span: number;
}

export function buildTimeMap(times: readonly number[], gap = GAP_MS): TimeMap {
  const ts = [...new Set(times.filter((t) => Number.isFinite(t)))].sort((a, b) => a - b);
  if (ts.length === 0) return { t0: 0, t1: 0, knots: [[0, 0]], span: 0 };
  const knots: [number, number][] = [[ts[0], 0]];
  let v = 0;
  for (let i = 1; i < ts.length; i++) {
    const g = ts[i] - ts[i - 1];
    const s = squeezeGap(g, gap);
    if (s !== g) {
      if (knots[knots.length - 1][0] !== ts[i - 1]) knots.push([ts[i - 1], v]);
      v += s;
      knots.push([ts[i], v]);
    } else v += g;
  }
  const end = ts[ts.length - 1];
  if (knots[knots.length - 1][0] !== end) knots.push([end, v]);
  return { t0: ts[0], t1: end, knots, span: v };
}

function interp(knots: readonly [number, number][], x: number, from: 0 | 1): number {
  const to = from === 0 ? 1 : 0;
  if (knots.length === 1) return knots[0][to];
  if (x <= knots[0][from]) return knots[0][to];
  const last = knots[knots.length - 1];
  if (x >= last[from]) return last[to];
  let lo = 0;
  let hi = knots.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (knots[mid][from] <= x) lo = mid;
    else hi = mid;
  }
  const a = knots[lo];
  const b = knots[hi];
  const d = b[from] - a[from];
  return d > 0 ? a[to] + ((x - a[from]) / d) * (b[to] - a[to]) : a[to];
}

export const realToVirtual = (m: TimeMap, real: number): number => interp(m.knots, real, 0);
export const virtualToReal = (m: TimeMap, v: number): number => interp(m.knots, v, 1);

// ---- scene state --------------------------------------------------------------------------------

export interface Counters {
  ahead: number;
  files: number;
  ins: number;
  del: number;
}

export const ZERO: Counters = { ahead: 0, files: 0, ins: 0, del: 0 };

export interface AgentState {
  slug: string;
  name: string;
  role: string | null;
  agent: string;
  live: boolean;
  /** Was live at some point (counted as a team member). */
  everLive: boolean;
  attn: ReplayAttn;
  /** Real time of the last attention change. */
  attnAt: number;
  /** Worktree hash of the last branch event. */
  w: string | null;
  joinedAt: number;
  leftAt: number | null;
  leftWhy: LeaveReason | null;
  order: number;
}

export interface BranchState {
  /** First observation (the baseline). */
  base: Counters;
  /** High-water deltas against the baseline. */
  hw: Counters;
  /** `hw` before the last change (counter tick animation). */
  prev: Counters;
  at: number;
}

export interface TaskItem {
  key: string;
  text: string;
  s: TaskState;
  o: string[];
  /** State before the last change (null = new task). */
  prev: TaskState | null;
  /** Real time of the last change. */
  at: number;
  order: number;
}

export interface MsgItem {
  t: number;
  from: string;
  to: string[];
  text: string;
}

export interface SceneState {
  goal: string | null;
  goalAt: number;
  agents: AgentState[];
  tasks: TaskItem[];
  branches: Record<string, BranchState>;
  msgs: MsgItem[];
  /** Done / total before the last board change, and when it changed (progress bar animation). */
  progPrev: { done: number; total: number };
  progAt: number;
  /** Most recent task change (task list scrolling): key + time, and the one before. */
  focus: { key: string | null; at: number; prevKey: string | null; prevAt: number };
  ended: boolean;
  seq: number;
  msgCount: number;
}

export function emptyState(): SceneState {
  return {
    goal: null,
    goalAt: 0,
    agents: [],
    tasks: [],
    branches: {},
    msgs: [],
    progPrev: { done: 0, total: 0 },
    progAt: 0,
    focus: { key: null, at: 0, prevKey: null, prevAt: 0 },
    ended: false,
    seq: 0,
    msgCount: 0,
  };
}

export function cloneState(s: SceneState): SceneState {
  const branches: Record<string, BranchState> = {};
  for (const k in s.branches) branches[k] = { ...s.branches[k] };
  return {
    ...s,
    agents: s.agents.map((a) => ({ ...a })),
    tasks: s.tasks.map((t) => ({ ...t })),
    branches,
    msgs: s.msgs.slice(),
    progPrev: { ...s.progPrev },
    focus: { ...s.focus },
  };
}

export const taskKey = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();

export function boardProgress(tasks: readonly Pick<TaskItem, "s">[]): { done: number; total: number } {
  let done = 0;
  for (const t of tasks) if (t.s === "done") done++;
  return { done, total: tasks.length };
}

function agentOf(s: SceneState, slug: string, t: number, live = true): AgentState {
  let a = s.agents.find((x) => x.slug === slug);
  if (!a) {
    a = { slug, name: slug, role: null, agent: "", live, everLive: live, attn: "idle", attnAt: t, w: null, joinedAt: t, leftAt: null, leftWhy: null, order: s.seq++ };
    s.agents.push(a);
  }
  return a;
}

function markBoard(s: SceneState, t: number, before: { done: number; total: number }) {
  const now = boardProgress(s.tasks);
  if (now.done !== before.done || now.total !== before.total) {
    s.progPrev = before;
    s.progAt = t;
  }
}

function focusTask(s: SceneState, key: string, t: number) {
  if (s.focus.key !== key) s.focus = { key, at: t, prevKey: s.focus.key, prevAt: s.focus.at };
  else s.focus = { ...s.focus, at: t };
}

function upsertTask(s: SceneState, text: string, st: TaskState, o: string[], t: number, wasKey?: string): void {
  const key = taskKey(text);
  let item = (wasKey ? s.tasks.find((x) => x.key === wasKey) : undefined) ?? s.tasks.find((x) => x.key === key);
  if (!item) {
    item = { key, text, s: st, o, prev: null, at: t, order: s.seq++ };
    s.tasks.push(item);
    focusTask(s, key, t);
    return;
  }
  const changed = item.s !== st;
  item.key = key;
  item.text = text;
  item.o = o;
  if (changed) {
    item.prev = item.s;
    item.s = st;
    item.at = t;
    focusTask(s, key, t);
  }
}

/** Apply one event to a (mutable) state. */
export function applyEvent(s: SceneState, e: ReplayEvent): void {
  switch (e.k) {
    case "start": {
      if (e.goal !== s.goal) {
        s.goal = e.goal;
        s.goalAt = e.t;
      }
      const inTeam = new Set<string>();
      for (const m of e.team) {
        inTeam.add(m.slug);
        const a = agentOf(s, m.slug, e.t, m.live);
        a.name = m.name;
        a.role = m.role;
        a.agent = m.agent;
        if (m.live && !a.live) a.joinedAt = e.t;
        a.live = m.live;
        a.everLive ||= m.live;
        if (m.live) {
          a.leftAt = null;
          a.leftWhy = null;
        }
      }
      for (const a of s.agents)
        if (!inTeam.has(a.slug) && a.live) {
          a.live = false;
          a.leftAt = e.t;
          a.leftWhy = "removed";
        }
      // The board is re-synced: tasks not in the snapshot are gone.
      const before = boardProgress(s.tasks);
      const keep = new Set(e.tasks.map((x) => taskKey(x.text)));
      s.tasks = s.tasks.filter((x) => keep.has(x.key));
      for (const x of e.tasks) upsertTask(s, x.text, x.s, x.o, e.t);
      markBoard(s, e.t, before);
      return;
    }
    case "task": {
      const before = boardProgress(s.tasks);
      if (e.s === "gone") {
        const key = taskKey(e.text);
        s.tasks = s.tasks.filter((x) => x.key !== key);
      } else upsertTask(s, e.text, e.s, e.o, e.t, e.was ? taskKey(e.was) : undefined);
      markBoard(s, e.t, before);
      return;
    }
    case "goal":
      s.goal = e.goal;
      s.goalAt = e.t;
      return;
    case "attn": {
      const a = agentOf(s, e.slug, e.t);
      if (a.attn !== e.s) {
        a.attn = e.s;
        a.attnAt = e.t;
      }
      return;
    }
    case "branch": {
      const a = agentOf(s, e.slug, e.t);
      a.w = e.w;
      const cur: Counters = { ahead: e.ahead, files: e.files, ins: e.ins, del: e.del };
      const b = s.branches[e.w];
      if (!b) {
        s.branches[e.w] = { base: cur, hw: { ...ZERO }, prev: { ...ZERO }, at: e.t };
        return;
      }
      const hw: Counters = {
        ahead: Math.max(b.hw.ahead, cur.ahead - b.base.ahead),
        files: Math.max(b.hw.files, cur.files - b.base.files),
        ins: Math.max(b.hw.ins, cur.ins - b.base.ins),
        del: Math.max(b.hw.del, cur.del - b.base.del),
      };
      if (hw.ahead !== b.hw.ahead || hw.files !== b.hw.files || hw.ins !== b.hw.ins || hw.del !== b.hw.del)
        s.branches[e.w] = { base: b.base, hw, prev: b.hw, at: e.t };
      return;
    }
    case "msg":
      s.msgs.push({ t: e.t, from: e.from, to: e.to, text: e.text });
      if (s.msgs.length > MSG_KEEP) s.msgs.splice(0, s.msgs.length - MSG_KEEP);
      s.msgCount++;
      return;
    case "join": {
      let a = e.was ? s.agents.find((x) => x.slug === e.was) : undefined;
      if (a && !s.agents.some((x) => x.slug === e.slug)) a.slug = e.slug;
      else a = agentOf(s, e.slug, e.t);
      a.name = e.name;
      a.role = e.role;
      a.agent = e.agent || a.agent;
      if (!a.live) a.joinedAt = e.t;
      a.live = true;
      a.everLive = true;
      a.leftAt = null;
      a.leftWhy = null;
      return;
    }
    case "leave": {
      const a = s.agents.find((x) => x.slug === e.slug);
      if (!a) return;
      a.live = false;
      a.leftAt = e.t;
      a.leftWhy = e.why;
      if (a.attn === "working") {
        a.attn = e.why === "error" ? "error" : "idle";
        a.attnAt = e.t;
      }
      return;
    }
    case "end":
      s.ended = true;
      return;
  }
}

/** The task an agent is on: its first "doing" task, else its first "todo" (owner = name slug or role). */
export function currentTask(s: Pick<SceneState, "tasks">, a: Pick<AgentState, "name" | "role">): TaskItem | null {
  const asTasks: Task[] = s.tasks.map((x, i) => ({ line: i, text: x.text, state: x.s, owners: x.o }));
  const t = currentTaskFor(asTasks, a);
  return t ? s.tasks[t.line] : null;
}

/** Branch counters of an agent (its worktree's high-water deltas). */
export function agentCounters(s: Pick<SceneState, "branches">, a: Pick<AgentState, "w">): BranchState | null {
  return a.w ? (s.branches[a.w] ?? null) : null;
}

// ---- timeline -----------------------------------------------------------------------------------

export interface ReplayStats {
  tasksDone: number;
  tasksTotal: number;
  commits: number;
  files: number;
  ins: number;
  del: number;
  agents: number;
  wallMs: number;
  startT: number;
  endT: number;
  msgs: number;
}

export interface Timeline {
  events: ReplayEvent[];
  map: TimeMap;
  keyframes: { idx: number; state: SceneState }[];
  final: SceneState;
  stats: ReplayStats;
}

export function totals(s: SceneState): Counters {
  const out = { ...ZERO };
  for (const k in s.branches) {
    const h = s.branches[k].hw;
    out.ahead += h.ahead;
    out.files += h.files;
    out.ins += h.ins;
    out.del += h.del;
  }
  return out;
}

export function computeStats(final: SceneState, map: TimeMap): ReplayStats {
  const p = boardProgress(final.tasks);
  const c = totals(final);
  return {
    tasksDone: p.done,
    tasksTotal: p.total,
    commits: c.ahead,
    files: c.files,
    ins: c.ins,
    del: c.del,
    agents: final.agents.filter((a) => a.everLive).length,
    wallMs: Math.max(0, map.t1 - map.t0),
    startT: map.t0,
    endT: map.t1,
    msgs: final.msgCount,
  };
}

export function buildTimeline(input: readonly ReplayEvent[]): Timeline {
  const events = [...input].sort((a, b) => a.t - b.t);
  const map = buildTimeMap(events.map((e) => e.t));
  const keyframes: { idx: number; state: SceneState }[] = [{ idx: 0, state: emptyState() }];
  const s = emptyState();
  for (let i = 0; i < events.length; i++) {
    applyEvent(s, events[i]);
    if ((i + 1) % KEYFRAME_EVERY === 0) keyframes.push({ idx: i + 1, state: cloneState(s) });
  }
  return { events, map, keyframes, final: s, stats: computeStats(s, map) };
}

/** Number of events with t <= real. */
function countUpTo(events: readonly ReplayEvent[], real: number): number {
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid].t <= real) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Scene state after every event at or before `real` (a fresh copy, safe to mutate). */
export function stateAt(tl: Timeline, real: number): SceneState {
  const n = countUpTo(tl.events, real);
  let k = tl.keyframes.length - 1;
  while (k > 0 && tl.keyframes[k].idx > n) k--;
  const s = cloneState(tl.keyframes[k].state);
  for (let i = tl.keyframes[k].idx; i < n; i++) applyEvent(s, tl.events[i]);
  return s;
}

// ---- the video schedule -------------------------------------------------------------------------

export interface ReplayPlan {
  totalMs: number;
  titleMs: number;
  endMs: number;
  mainMs: number;
  map: TimeMap;
}

export type Phase = "title" | "main" | "end";

export interface SceneClock {
  phase: Phase;
  /** ms since the phase began. */
  phaseMs: number;
  phaseLen: number;
  /** Real time (ms epoch) the scene shows. */
  real: number;
  /** Main-scene progress 0..1 (0 in the title card, 1 in the end card). */
  p: number;
}

export function makePlan(tl: Pick<Timeline, "map">, lengthSec: number): ReplayPlan {
  const totalMs = Math.max(6, lengthSec) * 1000;
  return { totalMs, titleMs: TITLE_MS, endMs: END_MS, mainMs: totalMs - TITLE_MS - END_MS, map: tl.map };
}

function mainPlay(plan: ReplayPlan): number {
  return Math.max(1, plan.mainMs - LEAD_MS - HOLD_MS);
}

export function sceneClock(plan: ReplayPlan, sceneMs: number): SceneClock {
  const s = Math.max(0, Math.min(plan.totalMs, sceneMs));
  const { map } = plan;
  if (s < plan.titleMs) return { phase: "title", phaseMs: s, phaseLen: plan.titleMs, real: map.t0, p: 0 };
  const m = s - plan.titleMs;
  if (m < plan.mainMs) {
    const u = Math.max(0, Math.min(1, (m - LEAD_MS) / mainPlay(plan)));
    return { phase: "main", phaseMs: m, phaseLen: plan.mainMs, real: map.span > 0 ? virtualToReal(map, u * map.span) : u < 1 ? map.t0 : map.t1, p: u };
  }
  return { phase: "end", phaseMs: m - plan.mainMs, phaseLen: plan.endMs, real: map.t1, p: 1 };
}

/** Video time (ms) at which the main scene reaches real time `real` (animations count from it). */
export function realToScene(plan: ReplayPlan, real: number): number {
  const { map } = plan;
  const u = map.span > 0 ? realToVirtual(map, real) / map.span : real >= map.t1 ? 1 : 0;
  return plan.titleMs + LEAD_MS + u * mainPlay(plan);
}

// ---- formatting ---------------------------------------------------------------------------------

/** "2 h 09 m", "45 m", "38 s". */
export function formatWall(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} m`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} m`;
}

const p2 = (n: number) => String(n).padStart(2, "0");

/** Local "10:42". */
export function formatClock(t: number): string {
  const d = new Date(t);
  return `${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "10:42 → 12:51", with dates when the range crosses midnight. */
export function formatClockRange(t0: number, t1: number): string {
  const a = new Date(t0);
  const b = new Date(t1);
  if (a.toDateString() === b.toDateString()) return `${formatClock(t0)} → ${formatClock(t1)}`;
  const day = (d: Date) => `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return `${day(a)} ${formatClock(t0)} → ${day(b)} ${formatClock(t1)}`;
}

/** 1234 → "1,234"; 12345 → "12.3k". */
export function formatCount(n: number): string {
  const v = Math.max(0, Math.round(n));
  if (v >= 10000) return `${(v / 1000).toFixed(v >= 100000 ? 0 : 1)}k`;
  return v.toLocaleString("en-US");
}
