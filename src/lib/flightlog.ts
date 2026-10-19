// Flight log: a local daily streak, ranks and medals from mission tasks the app saw completed. Pure and
// node-safe (unit-tested); the store (store/flightlog.ts) feeds it and persists it in localStorage.
//
// What counts (nothing new is read; never terminal content):
// - A task completion = a mission task observed going to "[x]" (mission file store). Agents merely
//   running never count. Idempotent: one completion per project + task text + local day.
// - A mission day = a local calendar day with at least one completion. The streak counts consecutive
//   mission days; every 7 mission days in a streak earn a shield (at most 2 stored), and one shield covers
//   one missed day. A gap longer than the shields restarts the streak and keeps the shields.
// - Missions finished = boards that went to "every task done" (once per project + goal + day).
// - Commits during missions = increases of a worktree's "commits ahead" between two branch summaries the
//   replay recorder saw (the first summary of a worktree is the baseline).
// - Agents commanded = distinct sessions credited with a completion (owner tokens on the task).
//
// PRIVACY: stored as counts and 8-hex FNV hashes only (project folder, task text, goal, session id):
// no paths, task text, names or anything else readable. No network, no telemetry.

import { t, type MessageKey } from "../i18n";
import { normalizeRole } from "./roles";
import { slugify, type MissionDoc, type Task, type TeamMember } from "./missionDoc";

export const FLIGHTLOG_KEY = "gridkeeper.flightlog.v1";
export const FLIGHTLOG_VERSION = 1;
export const MAX_SHIELDS = 2;
export const SHIELD_EVERY = 7;
/** Idempotency keys are kept this many days back (a completion's day comes from the file's write time). */
export const SEEN_DAYS = 3;
const SEEN_MAX = 4000;
const HEADS_MAX = 200;
const SQUADS_MAX = 50;
const AGENTS_MAX = 20000;
const PROJECTS_MAX = 2000;

// ---- hashing / dates ----------------------------------------------------------------------------

/** FNV-1a 32-bit as 8 hex digits. */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** Hash of a project folder (case, slashes and a trailing separator don't matter). */
export function projectHash(dir: string): string {
  return fnv1a(dir.trim().replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase());
}

const normText = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim().toLowerCase();

const pad = (n: number) => String(n).padStart(2, "0");
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Local calendar day of `ms` as "YYYY-MM-DD" (the machine's time zone, DST included). */
export function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function isDayKey(s: unknown): s is string {
  if (typeof s !== "string") return false;
  const m = DAY_RE.exec(s);
  if (!m) return false;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  return utcKey(t) === s;
}

/** Day keys are calendar dates: arithmetic happens in UTC, so DST and time zones never shift a day. */
function keyUtc(key: string): number {
  const m = DAY_RE.exec(key);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN;
}

function utcKey(t: number): string {
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Whole calendar days from `a` to `b` (b - a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((keyUtc(b) - keyUtc(a)) / 86_400_000);
}

export function addDays(key: string, n: number): string {
  return utcKey(keyUtc(key) + n * 86_400_000);
}

/** 0 = Monday … 6 = Sunday. */
export function weekday(key: string): number {
  return (new Date(keyUtc(key)).getUTCDay() + 6) % 7;
}

// ---- ranks --------------------------------------------------------------------------------------

export interface Rank {
  id: string;
  /** Display name in the UI language (a getter over the catalog). */
  readonly name: string;
  /** Total completed tasks needed. */
  min: number;
}

const rank = (id: string, key: MessageKey, min: number): Rank => ({
  id,
  min,
  get name() {
    return t(key);
  },
});

/** Ranks by total completed mission tasks. */
export const RANKS: readonly Rank[] = [
  rank("cadet", "flightLog.rank.cadet", 0),
  rank("pilot", "flightLog.rank.pilot", 5),
  rank("flight-lead", "flightLog.rank.flightLead", 15),
  rank("wing-commander", "flightLog.rank.wingCommander", 40),
  rank("captain", "flightLog.rank.captain", 100),
  rank("commodore", "flightLog.rank.commodore", 250),
  rank("admiral", "flightLog.rank.admiral", 500),
  rank("fleet-admiral", "flightLog.rank.fleetAdmiral", 1000),
];

export function rankIndex(tasks: number): number {
  let i = 0;
  while (i + 1 < RANKS.length && tasks >= RANKS[i + 1].min) i++;
  return i;
}

export function rankFor(tasks: number): Rank {
  return RANKS[rankIndex(tasks)];
}

export interface RankProgress {
  rank: Rank;
  index: number;
  next: Rank | null;
  /** Tasks still needed for the next rank (0 at the top). */
  toNext: number;
  /** 0–1 between this rank and the next (1 at the top). */
  fraction: number;
}

export function rankProgress(tasks: number): RankProgress {
  const index = rankIndex(tasks);
  const rank = RANKS[index];
  const next = RANKS[index + 1] ?? null;
  if (!next) return { rank, index, next, toNext: 0, fraction: 1 };
  return { rank, index, next, toNext: next.min - tasks, fraction: Math.max(0, Math.min(1, (tasks - rank.min) / (next.min - rank.min))) };
}

// ---- medals -------------------------------------------------------------------------------------

export type MedalId =
  | "first-jump"
  | "full-squadron"
  | "clean-landing"
  | "night-shift"
  | "seven-suns"
  | "hyperspace"
  | "long-patrol"
  | "outer-rim"
  | "ten-campaigns"
  | "supply-line";

export interface MedalDef {
  id: MedalId;
  /** Name and criterion in the UI language (getters over the catalog). */
  readonly name: string;
  readonly criterion: string;
}

const medal = (id: MedalId, nameKey: MessageKey, criterionKey: MessageKey): MedalDef => ({
  id,
  get name() {
    return t(nameKey);
  },
  get criterion() {
    return t(criterionKey);
  },
});

export const MEDALS: readonly MedalDef[] = [
  medal("first-jump", "flightLog.medal.firstJump.name", "flightLog.medal.firstJump.criterion"),
  medal("full-squadron", "flightLog.medal.fullSquadron.name", "flightLog.medal.fullSquadron.criterion"),
  medal("clean-landing", "flightLog.medal.cleanLanding.name", "flightLog.medal.cleanLanding.criterion"),
  medal("night-shift", "flightLog.medal.nightShift.name", "flightLog.medal.nightShift.criterion"),
  medal("seven-suns", "flightLog.medal.sevenSuns.name", "flightLog.medal.sevenSuns.criterion"),
  medal("hyperspace", "flightLog.medal.hyperspace.name", "flightLog.medal.hyperspace.criterion"),
  medal("long-patrol", "flightLog.medal.longPatrol.name", "flightLog.medal.longPatrol.criterion"),
  medal("outer-rim", "flightLog.medal.outerRim.name", "flightLog.medal.outerRim.criterion"),
  medal("ten-campaigns", "flightLog.medal.tenCampaigns.name", "flightLog.medal.tenCampaigns.criterion"),
  medal("supply-line", "flightLog.medal.supplyLine.name", "flightLog.medal.supplyLine.criterion"),
];

const MEDAL_IDS: ReadonlySet<string> = new Set(MEDALS.map((m) => m.id));

// ---- data ---------------------------------------------------------------------------------------

export interface Squad {
  /** Goal hash of the project's current mission. */
  g: string;
  /** Session hashes credited with a completion on it. */
  ids: string[];
}

export interface FlightLogData {
  v: 1;
  /** Counting and every flight-log surface; off = nothing is recorded or shown. */
  enabled: boolean;
  /** Completed tasks per local day ("YYYY-MM-DD" → count). */
  days: Record<string, number>;
  tasks: number;
  missions: number;
  commits: number;
  /** Session hashes credited with at least one completion. */
  agents: string[];
  /** Project hashes with at least one completion. */
  projects: string[];
  /** Medal id → earned at (ms). */
  medals: Partial<Record<MedalId, number>>;
  /** Highest rank index already announced. */
  rank: number;
  /** Idempotency keys "day|project|hash" of recent days. */
  seen: string[];
  /** "project|worktree" → last commits-ahead seen. */
  heads: Record<string, number>;
  /** Project hash → its current mission's squad. */
  squads: Record<string, Squad>;
}

export function emptyLog(enabled = true): FlightLogData {
  return { v: 1, enabled, days: {}, tasks: 0, missions: 0, commits: 0, agents: [], projects: [], medals: {}, rank: 0, seen: [], heads: {}, squads: {} };
}

export type LoadStatus = "ok" | "fresh" | "migrated" | "repaired" | "newer";

const HEX8 = /^[0-9a-f]{8}$/;
const SEEN_RE = /^\d{4}-\d{2}-\d{2}\|[0-9a-f]{8}\|m?[0-9a-f]{8}$/;
const HEAD_RE = /^[0-9a-f]{8}\|[0-9a-z]{1,16}$/;
const count = (v: unknown, max = 1e9): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.min(max, Math.floor(v)) : null);
const hexList = (v: unknown, max: number): string[] | null => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string" && HEX8.test(x)))].slice(-max) : null);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * Read stored JSON. Never throws: damaged fields fall back to empty values ("repaired"), an unversioned
 * (pre-v1) object is migrated, unreadable data starts fresh, and a NEWER version is left untouched
 * ("newer": the caller must not write over it).
 */
export function parseLog(raw: string | null | undefined): { data: FlightLogData; status: LoadStatus } {
  if (!raw) return { data: emptyLog(), status: "fresh" };
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return { data: emptyLog(), status: "repaired" };
  }
  if (!isObj(v)) return { data: emptyLog(), status: "repaired" };
  const ver = v.v;
  if (typeof ver === "number" && ver > FLIGHTLOG_VERSION) return { data: emptyLog(v.enabled !== false), status: "newer" };
  const legacy = ver === undefined || ver === 0;
  if (!legacy && ver !== 1) return { data: emptyLog(), status: "repaired" };
  let repaired = false;
  const fix = <T>(val: T | null, fallback: T): T => {
    if (val === null) {
      repaired = true;
      return fallback;
    }
    return val;
  };
  const d = emptyLog(v.enabled !== false);
  if (v.enabled !== undefined && typeof v.enabled !== "boolean") repaired = true;
  // days: legacy files may carry them as `streakDays: string[]` (one task each).
  if (isObj(v.days)) {
    for (const [k, n] of Object.entries(v.days)) {
      const c = count(n, 1e6);
      if (isDayKey(k) && c) d.days[k] = c;
      else repaired = true;
    }
  } else if (legacy && Array.isArray(v.streakDays)) {
    for (const k of v.streakDays) if (isDayKey(k)) d.days[k] = (d.days[k] ?? 0) + 1;
  } else if (v.days !== undefined) repaired = true;
  const daySum = Object.values(d.days).reduce((a, b) => a + b, 0);
  d.tasks = Math.max(daySum, v.tasks === undefined ? 0 : fix(count(v.tasks), 0));
  d.missions = v.missions === undefined ? 0 : fix(count(v.missions), 0);
  d.commits = v.commits === undefined ? 0 : fix(count(v.commits), 0);
  d.agents = v.agents === undefined ? [] : fix(hexList(v.agents, AGENTS_MAX), []);
  d.projects = v.projects === undefined ? [] : fix(hexList(v.projects, PROJECTS_MAX), []);
  if (isObj(v.medals)) {
    for (const [k, at] of Object.entries(v.medals)) {
      const t = count(at, 1e14);
      if (MEDAL_IDS.has(k) && t) d.medals[k as MedalId] = t;
      else repaired = true;
    }
  } else if (v.medals !== undefined) repaired = true;
  d.rank = Math.min(RANKS.length - 1, v.rank === undefined ? rankIndex(d.tasks) : fix(count(v.rank), rankIndex(d.tasks)));
  if (Array.isArray(v.seen)) d.seen = v.seen.filter((s): s is string => typeof s === "string" && SEEN_RE.test(s)).slice(-SEEN_MAX);
  else if (v.seen !== undefined) repaired = true;
  if (isObj(v.heads)) {
    for (const [k, n] of Object.entries(v.heads)) {
      const c = count(n, 1e6);
      if (HEAD_RE.test(k) && c !== null) d.heads[k] = c;
      else repaired = true;
    }
  } else if (v.heads !== undefined) repaired = true;
  if (isObj(v.squads)) {
    for (const [k, sq] of Object.entries(v.squads)) {
      const ids = isObj(sq) ? hexList(sq.ids, 64) : null;
      if (HEX8.test(k) && isObj(sq) && typeof sq.g === "string" && HEX8.test(sq.g) && ids) d.squads[k] = { g: sq.g, ids };
      else repaired = true;
    }
  } else if (v.squads !== undefined) repaired = true;
  return { data: d, status: legacy ? "migrated" : repaired ? "repaired" : "ok" };
}

export function serializeLog(d: FlightLogData): string {
  return JSON.stringify(d);
}

// ---- streak -------------------------------------------------------------------------------------

export interface StreakInfo {
  /** Mission days in the current streak (0 = no streak). */
  current: number;
  best: number;
  /** Shields available now (after covering the days missed so far). */
  shields: number;
  /** Shields covering missed days of the current streak since the last mission day. */
  shieldsInUse: number;
  /** Today is already a mission day. */
  todayDone: boolean;
  lastDay: string | null;
}

/** Streak with shields as of the local day `today` (days after `today` are ignored). */
export function streakInfo(days: Readonly<Record<string, number>>, today: string): StreakInfo {
  const keys = Object.keys(days)
    .filter((k) => days[k] > 0 && isDayKey(k) && k <= today)
    .sort();
  if (keys.length === 0) return { current: 0, best: 0, shields: 0, shieldsInUse: 0, todayDone: false, lastDay: null };
  let streak = 0;
  let best = 0;
  let shields = 0;
  let run = 0;
  let prev: string | null = null;
  for (const k of keys) {
    if (prev) {
      const gap = daysBetween(prev, k) - 1;
      if (gap > 0) {
        if (gap <= shields) shields -= gap;
        else {
          streak = 0;
          run = 0;
        }
      }
    }
    streak++;
    run++;
    if (run === SHIELD_EVERY) {
      shields = Math.min(MAX_SHIELDS, shields + 1);
      run = 0;
    }
    best = Math.max(best, streak);
    prev = k;
  }
  const last = prev as string;
  const todayDone = last === today;
  // Days missed between the last mission day and today (today itself is never "missed" yet).
  const missed = todayDone ? 0 : Math.max(0, daysBetween(last, today) - 1);
  if (missed > shields) return { current: 0, best, shields, shieldsInUse: 0, todayDone, lastDay: last };
  return { current: streak, best, shields: shields - missed, shieldsInUse: missed, todayDone, lastDay: last };
}

// ---- mission diffs ------------------------------------------------------------------------------

const EVERYONE = new Set(["all", "everyone", "team"]);

function keyed(tasks: readonly Task[]): Map<string, Task> {
  const seen = new Map<string, number>();
  const out = new Map<string, Task>();
  for (const t of tasks) {
    const base = normText(t.text);
    if (!base) continue;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    out.set(n === 1 ? base : `${base}#${n}`, t);
  }
  return out;
}

/** Tasks done in `next` that were on `prev`'s board and not done there (matched by text). */
export function newlyDone(prev: MissionDoc, next: MissionDoc): Task[] {
  const before = keyed(prev.tasks);
  const out: Task[] = [];
  for (const [k, t] of keyed(next.tasks)) {
    if (t.state !== "done") continue;
    const p = before.get(k);
    if (p && p.state !== "done") out.push(t);
  }
  return out;
}

const allDone = (d: MissionDoc) => d.tasks.length > 0 && d.tasks.every((t) => t.state === "done");

/** The board went to "every task done" with this change. */
export function missionFinished(prev: MissionDoc, next: MissionDoc): boolean {
  return allDone(next) && !allDone(prev);
}

/**
 * Sessions credited with a completed task: owners named by session name; otherwise by role ("@builder").
 * "@all" / "@team" credit nobody (it says nothing about who did the work).
 */
export function creditedSessions(task: Pick<Task, "owners">, team: readonly TeamMember[]): string[] {
  const tokens = task.owners.filter((o) => !EVERYONE.has(o));
  if (tokens.length === 0) return [];
  const byName = team.filter((m) => tokens.includes(slugify(m.name)));
  if (byName.length) return byName.map((m) => m.id);
  return team
    .filter((m) => {
      const role = normalizeRole(m.role);
      return !!role && tokens.some((o) => o === role || o === `${role}s`);
    })
    .map((m) => m.id);
}

// ---- recording ----------------------------------------------------------------------------------

export interface CompletionIn {
  text: string;
  /** When the task was done (ms): the mission file's write time. */
  at: number;
  /** Credited session ids. */
  agents: readonly string[];
}

export interface MissionUpdate {
  /** Project folder (hashed here). */
  project: string;
  goal: string | null;
  completions: readonly CompletionIn[];
  /** The board went to "every task done" at `at`; `clean` = Clean landing evidence. */
  finished?: { at: number; clean: boolean } | null;
}

export interface ApplyResult {
  data: FlightLogData;
  changed: boolean;
  /** The new rank, when this update promoted. */
  promoted: Rank | null;
  medals: MedalDef[];
  /** Commits added (recordCommits). */
  commits: number;
}

function clone(d: FlightLogData): FlightLogData {
  return {
    ...d,
    days: { ...d.days },
    agents: d.agents.slice(),
    projects: d.projects.slice(),
    medals: { ...d.medals },
    seen: d.seen.slice(),
    heads: { ...d.heads },
    squads: { ...d.squads },
  };
}

interface MedalCtx {
  night?: boolean;
  squad?: number;
  clean?: boolean;
}

function finishUpdate(before: FlightLogData, d: FlightLogData, ctx: MedalCtx, now: number, commits = 0): ApplyResult {
  const medals: MedalDef[] = [];
  const st = streakInfo(d.days, dayKey(now));
  const maxDay = Object.values(d.days).reduce((a, b) => Math.max(a, b), 0);
  const earned: Record<MedalId, boolean> = {
    "first-jump": d.missions >= 1,
    "full-squadron": (ctx.squad ?? 0) >= 5,
    "clean-landing": !!ctx.clean,
    "night-shift": !!ctx.night,
    "seven-suns": st.best >= 7,
    hyperspace: maxDay >= 10,
    "long-patrol": st.best >= 30,
    "outer-rim": d.projects.length >= 5,
    "ten-campaigns": d.missions >= 10,
    "supply-line": d.commits >= 50,
  };
  for (const m of MEDALS)
    if (earned[m.id] && !d.medals[m.id]) {
      d.medals[m.id] = now;
      medals.push(m);
    }
  const idx = rankIndex(d.tasks);
  let promoted: Rank | null = null;
  if (idx > d.rank) {
    d.rank = idx;
    promoted = RANKS[idx];
  }
  const changed = serializeLog(d) !== serializeLog(before);
  return { data: changed ? d : before, changed, promoted, medals, commits };
}

function pruneSeen(seen: string[], today: string): string[] {
  const floor = addDays(today, -SEEN_DAYS);
  const kept = seen.filter((k) => k.slice(0, 10) >= floor);
  return kept.length > SEEN_MAX ? kept.slice(-SEEN_MAX) : kept;
}

/** Hour-of-day check in local time. */
const isNight = (ms: number) => new Date(ms).getHours() < 5;

/** Apply observed completions (and a finished mission) to the log. Pure; idempotent per project + task + day. */
export function recordMission(data: FlightLogData, u: MissionUpdate, now: number): ApplyResult {
  if (!data.enabled) return { data, changed: false, promoted: null, medals: [], commits: 0 };
  const d = clone(data);
  const p = projectHash(u.project);
  const g = fnv1a(normText(u.goal));
  const seen = new Set(d.seen);
  const ctx: MedalCtx = {};
  const agents = new Set(d.agents);
  let squad = d.squads[p];
  if (!squad || squad.g !== g) squad = { g, ids: [] };
  else squad = { g, ids: squad.ids.slice() };
  let counted = 0;
  for (const c of u.completions) {
    const text = normText(c.text);
    if (!text) continue;
    const day = dayKey(c.at);
    const key = `${day}|${p}|${fnv1a(text)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    d.seen.push(key);
    d.days[day] = (d.days[day] ?? 0) + 1;
    d.tasks++;
    counted++;
    if (isNight(c.at)) ctx.night = true;
    for (const id of c.agents) {
      const h = fnv1a(id);
      if (!agents.has(h) && agents.size < AGENTS_MAX) {
        agents.add(h);
        d.agents.push(h);
      }
      if (!squad.ids.includes(h) && squad.ids.length < 64) squad.ids.push(h);
    }
  }
  if (counted && !d.projects.includes(p)) {
    d.projects.push(p);
    if (d.projects.length > PROJECTS_MAX) d.projects.shift();
  }
  if (counted || squad.ids.length || d.squads[p]) {
    delete d.squads[p];
    d.squads[p] = squad; // most recent last (pruned from the front)
    const keys = Object.keys(d.squads);
    for (let i = 0; i < keys.length - SQUADS_MAX; i++) delete d.squads[keys[i]];
  }
  ctx.squad = squad.ids.length;
  if (u.finished) {
    const key = `${dayKey(u.finished.at)}|${p}|m${g}`;
    if (!seen.has(key)) {
      seen.add(key);
      d.seen.push(key);
      d.missions++;
      if (u.finished.clean) ctx.clean = true;
    }
  }
  d.seen = pruneSeen(d.seen, dayKey(now));
  return finishUpdate(data, d, ctx, now);
}

/**
 * A worktree's commits-ahead as the replay recorder saw it. The first value per project + worktree is
 * the baseline; afterwards every increase counts (a drop, e.g. after a merge, just moves the baseline).
 */
export function recordCommits(data: FlightLogData, project: string, worktree: string, ahead: number, now: number): ApplyResult {
  if (!data.enabled) return { data, changed: false, promoted: null, medals: [], commits: 0 };
  const w = worktree.toLowerCase().replace(/[^0-9a-z]/g, "").slice(0, 16) || "0";
  const key = `${projectHash(project)}|${w}`;
  const n = Math.max(0, Math.floor(ahead) || 0);
  const prev = data.heads[key];
  if (prev === n) return { data, changed: false, promoted: null, medals: [], commits: 0 };
  const d = clone(data);
  const delta = prev === undefined ? 0 : Math.max(0, n - prev);
  delete d.heads[key];
  d.heads[key] = n;
  const keys = Object.keys(d.heads);
  for (let i = 0; i < keys.length - HEADS_MAX; i++) delete d.heads[keys[i]];
  d.commits += delta;
  return finishUpdate(data, d, {}, now, delta);
}

/** Wipe the log (keeps the on/off choice). */
export function resetLog(data: FlightLogData): FlightLogData {
  return emptyLog(data.enabled);
}

// ---- views --------------------------------------------------------------------------------------

/** 0 (none) … 4 for the heat strip. */
export function heatLevel(n: number): 0 | 1 | 2 | 3 | 4 {
  return n <= 0 ? 0 : n <= 2 ? 1 : n <= 5 ? 2 : n <= 9 ? 3 : 4;
}

export interface HeatCell {
  key: string;
  count: number;
  level: 0 | 1 | 2 | 3 | 4;
  future: boolean;
}

/** `weeks` columns (Monday first) ending with the week of `today`; days after today are `future`. */
export function heatWeeks(days: Readonly<Record<string, number>>, today: string, weeks = 12): HeatCell[][] {
  const start = addDays(today, -weekday(today) - (weeks - 1) * 7);
  const out: HeatCell[][] = [];
  for (let w = 0; w < weeks; w++) {
    const col: HeatCell[] = [];
    for (let i = 0; i < 7; i++) {
      const key = addDays(start, w * 7 + i);
      const n = days[key] ?? 0;
      col.push({ key, count: n, level: heatLevel(n), future: key > today });
    }
    out.push(col);
  }
  return out;
}

/** Streak and rank as they were at the end of the local day `day` (null when nothing was logged by then). */
export function statusOn(data: FlightLogData, day: string): { streak: number; rank: Rank } | null {
  let tasks = 0;
  for (const [k, n] of Object.entries(data.days)) if (k <= day) tasks += n;
  if (tasks === 0) return null;
  return { streak: streakInfo(data.days, day).current, rank: rankFor(tasks) };
}

/** "Day 7 streak · Captain" (or just the rank without a streak); null when nothing was logged. */
export function statusLine(data: FlightLogData, day: string): string | null {
  const s = statusOn(data, day);
  if (!s) return null;
  return s.streak > 0 ? t("flightLog.statusLine", { streak: s.streak, rank: s.rank.name }) : s.rank.name;
}

/** Header chip text: "6-day streak · Wing Commander" (just the rank without a streak). */
export function chipText(streak: number, rank: Rank): string {
  return streak > 0 ? t("flightLog.chipStreak", { streak, rank: rank.name }) : rank.name;
}

/** One line in the app's voice for a promotion and / or medals. */
export function announcement(promoted: Rank | null, medals: readonly MedalDef[]): string | null {
  const parts: string[] = [];
  if (promoted) parts.push(t("flightLog.promoted", { rank: promoted.name }));
  if (medals.length === 1) parts.push(t("flightLog.medalEarned", { name: medals[0].name }));
  else if (medals.length > 1) parts.push(t("flightLog.medalsEarned", { names: medals.map((m) => m.name).join(", ") }));
  return parts.length ? parts.join(" ") : null;
}
