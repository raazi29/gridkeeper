// Mission file: `<projectDir>/.gridkeeper/mission.md`, a plain Markdown task board that every agent CLI
// can read and edit, rendered live by Mission Control. Pure and node-safe (unit-tested).
//
// Format (lenient: agents write it by hand):
//
//   # Mission: Add OAuth login              <- goal: the first "# " heading ("Mission:" prefix optional)
//
//   Optional free-text context paragraphs.  <- context: text between the goal and the first heading / task
//
//   ## Tasks
//   - [ ] Design the token storage @lead    <- todo
//   - [~] Implement /auth/callback @builder-1   <- doing ("[~]", "[-]" or "[/]")
//   - [x] Add login button @builder-2      <- done ("[x]" or "[X]")
//   - [!] Blocked: needs client secret @builder-2   <- blocked
//
// - A task is ANY list item ("-", "*", "+" or "1." / "1)") starting with a box, under "## Tasks" or not.
//   "[]" counts as todo. Task lines inside ``` / ~~~ fences and HTML comments are ignored.
// - Owners are "@slug" tokens (after a space, "(" or line start, so e-mail addresses don't count). A slug
//   matches a session whose name slugifies to it (lowercase, spaces/underscores -> "-", other characters
//   dropped) or its role ("@builder" = every builder, "@builders" too); "@all" / "@everyone" / "@team" =
//   everyone.
// - Rewrites (setTaskState) change ONLY the box of one line; every other byte, including the file's
//   CRLF / LF endings, is preserved.

import { normalizeRole } from "./roles";

export type TaskState = "todo" | "doing" | "done" | "blocked";

export interface Task {
  /** 0-based line index in the file. */
  line: number;
  /** Task text with the owner tokens removed. */
  text: string;
  state: TaskState;
  /** Owner slugs (without "@"), lowercase, in order, unique. */
  owners: string[];
}

export interface MissionDoc {
  goal: string | null;
  context: string;
  tasks: Task[];
}

export interface TeamMember {
  id: string;
  name: string;
  role: string | null;
}

/** Box character written for each state. */
export const BOX_CHAR: Record<TaskState, string> = { todo: " ", doing: "~", done: "x", blocked: "!" };

/** "- [ ] text", "* [x] text", "1. [~] text" → indent+bullet, box char, rest. */
const TASK_RE = /^(\s*(?:[-*+]|\d{1,4}[.)])\s+)\[([ xX~\-/!]?)\](.*)$/;
const FENCE_RE = /^\s*(```|~~~)/;
const OWNER_RE = /(^|[\s(\[,;])@([A-Za-z0-9][A-Za-z0-9_-]*)/g;
const EVERYONE = new Set(["all", "everyone", "team"]);

export function stateOfBox(ch: string): TaskState {
  switch (ch) {
    case "x":
    case "X":
      return "done";
    case "~":
    case "-":
    case "/":
      return "doing";
    case "!":
      return "blocked";
    default:
      return "todo";
  }
}

/** Session name -> owner slug: lowercase, spaces/underscores -> "-", other characters dropped. Pure. */
export function slugify(name: string | null | undefined): string {
  if (!name) return "";
  let out = "";
  for (const ch of name.trim().toLowerCase()) {
    if (/[a-z0-9-]/.test(ch)) out += ch;
    else if (ch === " " || ch === "_" || ch === "\t") out += "-";
  }
  return out.replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
}

function ownersOf(rest: string): { owners: string[]; text: string } {
  const owners: string[] = [];
  const text = rest
    .replace(OWNER_RE, (_m, pre: string, raw: string) => {
      const slug = slugify(raw);
      if (slug && !owners.includes(slug)) owners.push(slug);
      return pre;
    })
    .replace(/\(\s*\)|\[\s*\]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return { owners, text };
}

/** Parse a mission file (see the format above). Never throws. */
export function parseMission(text: string): MissionDoc {
  const lines = text.split(/\r?\n/);
  let goal: string | null = null;
  let goalSeen = false;
  let contextOpen = false;
  let contextDone = false;
  const context: string[] = [];
  const tasks: Task[] = [];
  let fence: string | null = null;
  let comment = false;

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (fence) {
      if (l.trim().startsWith(fence)) fence = null;
      continue;
    }
    const f = FENCE_RE.exec(l);
    if (f) {
      fence = f[1];
      contextDone ||= contextOpen;
      continue;
    }
    if (comment) {
      if (l.includes("-->")) comment = false;
      continue;
    }
    if (/^\s*<!--/.test(l)) {
      if (!l.includes("-->")) comment = true;
      continue;
    }
    const m = TASK_RE.exec(l);
    if (m) {
      const { owners, text: t } = ownersOf(m[3]);
      tasks.push({ line: i, text: t, state: stateOfBox(m[2]), owners });
      contextDone = true;
      continue;
    }
    const h = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(l);
    if (h) {
      if (h[1].length === 1 && !goalSeen) {
        goalSeen = true;
        const g = h[2].replace(/^mission\b\s*[:\-–—]?\s*/i, "").trim();
        goal = g || null;
        contextOpen = !contextDone;
      } else contextDone = true;
      continue;
    }
    if (contextOpen && !contextDone) context.push(l.trim());
  }
  return { goal, context: context.join("\n").replace(/\n{3,}/g, "\n\n").trim(), tasks };
}

/**
 * Rewrite ONLY the box of the task on `line` to `state`. Keeps the file's line endings (CRLF / LF / mixed)
 * and every other byte. Returns null when that line is not a task (stale line number).
 */
export function setTaskState(text: string, line: number, state: TaskState): string | null {
  const parts = text.split(/(\r?\n)/); // content, sep, content, sep, …
  const idx = line * 2;
  if (line < 0 || idx >= parts.length) return null;
  const m = TASK_RE.exec(parts[idx]);
  if (!m) return null;
  if (stateOfBox(m[2]) === state) return text;
  parts[idx] = `${m[1]}[${BOX_CHAR[state]}]${m[3]}`;
  return parts.join("");
}

/** Click on a task box: todo -> doing -> done -> todo; blocked -> todo. */
export function nextState(s: TaskState): TaskState {
  return s === "todo" ? "doing" : s === "doing" ? "done" : "todo";
}

/** Strip a leading list bullet / box someone typed into the "tasks" textarea. */
function cleanTaskLine(raw: string): string {
  return raw
    .trim()
    .replace(/^(?:[-*+]|\d{1,4}[.)])\s+/, "")
    .replace(/^\[[ xX~\-/!]?\]\s*/, "")
    .trim();
}

/** Text of a brand-new mission file (LF endings). `tasks` are task texts, owners inline ("… @builder-1"). */
export function newMissionText(goal: string, context: string, tasks: readonly string[]): string {
  const out = [`# Mission: ${goal.replace(/\s+/g, " ").trim()}`, ""];
  const ctx = context.replace(/\r\n?/g, "\n").trim();
  if (ctx) out.push(ctx, "");
  out.push(
    "<!-- Shared task board (Gridkeeper). One task per line: '- [ ] task @owner'. Boxes: [ ] todo, [~] doing,",
    "     [x] done, [!] blocked (add the reason). Owners: @session-name or @role (@builder = every builder). -->",
    "",
    "## Tasks",
  );
  for (const t of tasks.map(cleanTaskLine).filter(Boolean)) out.push(`- [ ] ${t}`);
  return `${out.join("\n")}\n`;
}

/** Does `token` (an owner slug) name this member? Name slug, role, plural role or everyone. */
export function ownerMatches(token: string, m: Pick<TeamMember, "name" | "role">): boolean {
  if (EVERYONE.has(token)) return true;
  if (slugify(m.name) === token) return true;
  const role = normalizeRole(m.role);
  return !!role && (role === token || `${role}s` === token);
}

/** Session ids owning `task`, in team order (unique). */
export function ownersFor(task: Pick<Task, "owners">, team: readonly TeamMember[]): string[] {
  if (task.owners.length === 0) return [];
  return team.filter((m) => task.owners.some((o) => ownerMatches(o, m))).map((m) => m.id);
}

/** Owner tokens that match nobody on the team. */
export function unknownOwners(task: Pick<Task, "owners">, team: readonly TeamMember[]): string[] {
  return task.owners.filter((o) => !team.some((m) => ownerMatches(o, m)));
}

export function ownsTask(task: Pick<Task, "owners">, m: Pick<TeamMember, "name" | "role">): boolean {
  return task.owners.some((o) => ownerMatches(o, m));
}

/** A member's current task: the first "doing" task it owns, else the first "todo"; null when none. */
export function currentTaskFor(tasks: readonly Task[], m: Pick<TeamMember, "name" | "role">): Task | null {
  let todo: Task | null = null;
  for (const t of tasks) {
    if (t.state !== "doing" && t.state !== "todo") continue;
    if (!ownsTask(t, m)) continue;
    if (t.state === "doing") return t;
    todo ??= t;
  }
  return todo;
}

/** Number of tasks owned by at least one of `members`. */
export function countOwned(tasks: readonly Task[], members: readonly Pick<TeamMember, "name" | "role">[]): number {
  let n = 0;
  for (const t of tasks) if (members.some((m) => ownsTask(t, m))) n++;
  return n;
}

export interface MissionProgress {
  total: number;
  done: number;
  doing: number;
  todo: number;
  blocked: number;
  /** done / total (0 when there are no tasks). */
  fraction: number;
}

export function progress(tasks: readonly Pick<Task, "state">[]): MissionProgress {
  const p = { total: tasks.length, done: 0, doing: 0, todo: 0, blocked: 0, fraction: 0 };
  for (const t of tasks) p[t.state]++;
  p.fraction = p.total ? p.done / p.total : 0;
  return p;
}

/** Display order of the board: doing, todo, blocked, done (file order inside a state). */
export const STATE_ORDER: readonly TaskState[] = ["doing", "todo", "blocked", "done"];
