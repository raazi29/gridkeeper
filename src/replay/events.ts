// Mission replay: the recording format (one compact JSON object per line in
// `<projectDir>/.gridkeeper/replay/<YYYY-MM-DD-HHmm>-<slug(goal)>.jsonl`) and pure helpers around it.
// Pure and node-safe (unit-tested).
//
// Every event has `t` (ms epoch) and `k` (kind):
//   start   goal, team roster (slug / name / role / agent / live) and the task board at that moment.
//           A later `start` in the same file is a resume (app restarted): roster + board are re-synced.
//   task    one task changed (text, state, owner tokens); s "gone" = removed; `was` = renamed from.
//   goal    the mission goal changed.
//   attn    an agent's attention state (working / needs / done / error / idle).
//   branch  an agent's branch evidence refreshed: commits ahead, files, +ins / -del. `w` is an opaque
//           8-hex hash of the worktree folder (agents sharing a folder are counted once), never a path.
//   msg     a message between agents / the user (lead, hand-off, brief, broadcast), text <= 120 chars.
//   join    an agent joined the team (added / started); `was` = renamed from that slug.
//   leave   an agent left (stopped / exited / error / removed).
//   end     the recording was stopped.
//
// PRIVACY: never terminal output, file contents, environment, paths or account e-mails. Free text (goal,
// tasks, names, messages) goes through scrubText(), which removes absolute paths, e-mail addresses and
// secret-looking tokens before anything is written.

import { slugify, type TaskState } from "../lib/missionDoc";

export const REPLAY_FORMAT = 1;

export type ReplayAttn = "working" | "needs" | "done" | "error" | "idle";
export type ReplayTaskState = TaskState | "gone";
export type LeaveReason = "stopped" | "exited" | "error" | "removed";

export interface ReplayMember {
  slug: string;
  name: string;
  role: string | null;
  agent: string;
  live: boolean;
}

export interface ReplayTaskSnap {
  text: string;
  s: TaskState;
  o: string[];
}

export type ReplayEvent =
  | { t: number; k: "start"; v: number; goal: string | null; team: ReplayMember[]; tasks: ReplayTaskSnap[] }
  | { t: number; k: "task"; text: string; s: ReplayTaskState; o: string[]; was?: string }
  | { t: number; k: "goal"; goal: string | null }
  | { t: number; k: "attn"; slug: string; s: ReplayAttn }
  | { t: number; k: "branch"; slug: string; w: string; ahead: number; files: number; ins: number; del: number }
  | { t: number; k: "msg"; from: string; to: string[]; text: string }
  | { t: number; k: "join"; slug: string; name: string; role: string | null; agent: string; was?: string }
  | { t: number; k: "leave"; slug: string; why: LeaveReason }
  | { t: number; k: "end" };

export type ReplayKind = ReplayEvent["k"];

export const MSG_MAX = 120;
export const TEXT_MAX = 160;
export const NAME_MAX = 40;

// ---- privacy ------------------------------------------------------------------------------------

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// C:\…, C:/…, \\server\share…, and POSIX absolute paths under the usual roots (incl. ~/…).
const WIN_PATH_RE = /(?:\b[A-Za-z]:[\\/]|\\\\[^\s\\/]+[\\/])[^\s"'<>|*?]*/g;
const POSIX_PATH_RE = /(?:^|(?<=[\s("'=]))(?:~|\/(?:home|Users|root|mnt|tmp|var|etc|opt|usr|private|Volumes|srv|data))(?:\/[^\s"'<>|]*)+/g;
// Known credential prefixes, and long opaque runs (keys, tokens, hashes) that mix letters and digits.
const SECRET_PREFIX_RE = /\b(?:(?:sk|pk|rk)[-_][-_A-Za-z0-9]{12,}|(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{12,}|xox[abprs]-[-A-Za-z0-9]{10,}|glpat-[-_A-Za-z0-9]{12,}|AKIA[0-9A-Z]{16}|AIza[-_A-Za-z0-9]{30,})/g;
/** sk-/pk-/rk- forms only count with a digit in them ("sk-learn-notes" is text). */
const secretPrefix = (m: string) => (/^[spr]k[-_]/.test(m) && !/[0-9]/.test(m) ? m : "‹redacted›");
const OPAQUE_RE = /[A-Za-z0-9+_=-]{32,}/g;
const opaque = (m: string) => (/[0-9]/.test(m) && /[A-Za-z]/.test(m) ? "‹redacted›" : m);

/** One line of display text with absolute paths, e-mails and secret-looking tokens removed, cut to `max`. */
export function scrubText(raw: string | null | undefined, max = TEXT_MAX): string {
  if (!raw) return "";
  let s = String(raw)
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(EMAIL_RE, "‹email›")
    .replace(WIN_PATH_RE, "‹path›")
    .replace(POSIX_PATH_RE, "‹path›")
    .replace(SECRET_PREFIX_RE, secretPrefix)
    .replace(OPAQUE_RE, opaque)
    .replace(/\s+/g, " ")
    .trim();
  if (s.length > max) s = `${s.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
  return s;
}

/** FNV-1a 32-bit of a normalized folder key, as 8 hex digits: groups agents by worktree without a path. */
export function folderHash(path: string): string {
  const key = path.trim().replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

// ---- file names ---------------------------------------------------------------------------------

export const NAME_RE = /^[A-Za-z0-9._-]+\.jsonl$/;

const pad = (n: number) => String(n).padStart(2, "0");

/** `<YYYY-MM-DD-HHmm>-<slug(goal)>.jsonl` in local time; slug cut to 48 chars, "mission" when empty. */
export function recordingFileName(at: Date, goal: string | null | undefined, suffix = ""): string {
  const stamp = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}`;
  const slug = goalSlug(goal);
  return `${stamp}-${slug}${suffix}.jsonl`;
}

export function goalSlug(goal: string | null | undefined): string {
  const s = slugify(scrubText(goal, 200).replace(/[‹›]/g, ""))
    .slice(0, 48)
    .replace(/-+$/, "");
  return s || "mission";
}

export interface NameMeta {
  /** Local start time from the name (ms epoch), null when the name has no stamp. */
  startedAt: number | null;
  /** Goal slug from the name ("add-oauth-login"). */
  slug: string;
}

export function metaFromName(name: string): NameMeta {
  const m = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})-(.*?)(?:-\d+)?\.jsonl$/.exec(name);
  if (!m) return { startedAt: null, slug: name.replace(/\.jsonl$/, "") };
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  return { startedAt: Number.isFinite(d.getTime()) ? d.getTime() : null, slug: m[6] };
}

// ---- parsing ------------------------------------------------------------------------------------

const ATTN: ReadonlySet<string> = new Set(["working", "needs", "done", "error", "idle"]);
const TASK_STATES: ReadonlySet<string> = new Set(["todo", "doing", "done", "blocked"]);
const LEAVE: ReadonlySet<string> = new Set(["stopped", "exited", "error", "removed"]);

const str = (v: unknown, max = TEXT_MAX): string => (typeof v === "string" ? v.slice(0, max * 2) : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 32) : []);

function member(v: unknown): ReplayMember | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const slug = str(o.slug, NAME_MAX);
  if (!slug) return null;
  return { slug, name: str(o.name, NAME_MAX) || slug, role: typeof o.role === "string" ? o.role : null, agent: str(o.agent, 24), live: o.live !== false };
}

function taskSnap(v: unknown): ReplayTaskSnap | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const text = str(o.text);
  if (!text || typeof o.s !== "string" || !TASK_STATES.has(o.s)) return null;
  return { text, s: o.s as TaskState, o: strs(o.o) };
}

/** Validate one decoded object into an event (lenient: unknown fields dropped, bad events → null). */
export function toEvent(v: unknown): ReplayEvent | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const t = typeof o.t === "number" && Number.isFinite(o.t) ? o.t : NaN;
  if (!Number.isFinite(t) || t <= 0) return null;
  switch (o.k) {
    case "start":
      return {
        t,
        k: "start",
        v: num(o.v) || 1,
        goal: typeof o.goal === "string" ? o.goal : null,
        team: (Array.isArray(o.team) ? o.team : []).map(member).filter((m): m is ReplayMember => !!m),
        tasks: (Array.isArray(o.tasks) ? o.tasks : []).map(taskSnap).filter((x): x is ReplayTaskSnap => !!x),
      };
    case "task": {
      const text = str(o.text);
      const s = typeof o.s === "string" && (TASK_STATES.has(o.s) || o.s === "gone") ? (o.s as ReplayTaskState) : null;
      if (!text || !s) return null;
      return typeof o.was === "string" && o.was ? { t, k: "task", text, s, o: strs(o.o), was: o.was } : { t, k: "task", text, s, o: strs(o.o) };
    }
    case "goal":
      return { t, k: "goal", goal: typeof o.goal === "string" ? o.goal : null };
    case "attn": {
      const slug = str(o.slug, NAME_MAX);
      return slug && typeof o.s === "string" && ATTN.has(o.s) ? { t, k: "attn", slug, s: o.s as ReplayAttn } : null;
    }
    case "branch": {
      const slug = str(o.slug, NAME_MAX);
      if (!slug) return null;
      return { t, k: "branch", slug, w: str(o.w, 16) || slug, ahead: num(o.ahead), files: num(o.files), ins: num(o.ins), del: num(o.del) };
    }
    case "msg": {
      const text = str(o.text, MSG_MAX);
      if (!text) return null;
      return { t, k: "msg", from: str(o.from, NAME_MAX) || "you", to: strs(o.to), text };
    }
    case "join": {
      const slug = str(o.slug, NAME_MAX);
      if (!slug) return null;
      const ev: ReplayEvent = { t, k: "join", slug, name: str(o.name, NAME_MAX) || slug, role: typeof o.role === "string" ? o.role : null, agent: str(o.agent, 24) };
      return typeof o.was === "string" && o.was ? { ...ev, was: o.was } : ev;
    }
    case "leave": {
      const slug = str(o.slug, NAME_MAX);
      if (!slug) return null;
      return { t, k: "leave", slug, why: typeof o.why === "string" && LEAVE.has(o.why) ? (o.why as LeaveReason) : "stopped" };
    }
    case "end":
      return { t, k: "end" };
    default:
      return null;
  }
}

export interface ParsedReplay {
  events: ReplayEvent[];
  /** Lines that were not valid events (torn tail, hand edits, future kinds). */
  skipped: number;
}

/** Parse a JSONL recording. Never throws; events come back sorted by time (stable). */
export function parseReplay(text: string): ParsedReplay {
  const events: ReplayEvent[] = [];
  let skipped = 0;
  for (const line of text.split(/\r?\n/)) {
    const l = line.trim();
    if (!l) continue;
    let v: unknown;
    try {
      v = JSON.parse(l);
    } catch {
      skipped++;
      continue;
    }
    const ev = toEvent(v);
    if (ev) events.push(ev);
    else skipped++;
  }
  // Stable sort by time (Array.prototype.sort is stable).
  events.sort((a, b) => a.t - b.t);
  return { events, skipped };
}

/** One JSONL line (no trailing newline). */
export function encodeEvent(ev: ReplayEvent): string {
  return JSON.stringify(ev);
}

// ---- summaries (recording list) -----------------------------------------------------------------

export interface RecordingSummary {
  goal: string | null;
  startedAt: number | null;
  endedAt: number | null;
  durationMs: number;
  events: number;
  agents: number;
  tasksDone: number;
  tasksTotal: number;
  /** Has an explicit `end` (stopped) rather than just stopping (app closed / still recording). */
  ended: boolean;
}

/** Quick facts for the recording list (goal = the latest one, tasks = the final board). */
export function summarize(events: readonly ReplayEvent[]): RecordingSummary {
  let goal: string | null = null;
  const agents = new Set<string>();
  const tasks = new Map<string, TaskState>();
  let ended = false;
  for (const e of events) {
    switch (e.k) {
      case "start":
        goal = e.goal ?? goal;
        for (const m of e.team) agents.add(m.slug);
        tasks.clear();
        for (const t of e.tasks) tasks.set(t.text, t.s);
        break;
      case "goal":
        goal = e.goal;
        break;
      case "join":
        agents.add(e.slug);
        break;
      case "task":
        if (e.was) tasks.delete(e.was);
        if (e.s === "gone") tasks.delete(e.text);
        else tasks.set(e.text, e.s);
        break;
      case "end":
        ended = true;
        break;
      default:
        break;
    }
  }
  const startedAt = events.length ? events[0].t : null;
  const endedAt = events.length ? events[events.length - 1].t : null;
  let done = 0;
  for (const s of tasks.values()) if (s === "done") done++;
  return {
    goal,
    startedAt,
    endedAt,
    durationMs: startedAt !== null && endedAt !== null ? endedAt - startedAt : 0,
    events: events.length,
    agents: agents.size,
    tasksDone: done,
    tasksTotal: tasks.size,
    ended,
  };
}
