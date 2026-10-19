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
//   CRLF / LF endings, is preserved. The board's structural edits (moveTask, addTask, editTaskText,
//   setTaskOwners, addTaskOwner, deleteTask, changeTaskState) touch only the task line(s) they are about:
//   unknown lines stay byte for byte, each line keeps its own ending, a file without a final newline keeps
//   lacking one. A task "block" is the task line plus the deeper-indented lines under it (notes, sub-items);
//   moves and deletes take the whole block.

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
      return pre + "\0"; // marker: lets the next step drop only brackets this removal emptied, not a literal "()" / "[]"
    })
    .replace(/[(\[][\s\0,;]*\0[\s\0,;]*[)\]]/g, "")
    .replace(/\0/g, "")
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

// ---- structural edits (the board: drag, quick add, inline edit, assign, delete) -----------------

const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const TASKS_HEADING_RE = /^\s{0,3}#{2,6}\s+tasks?\b/i;
/** The board's own blocked-reason prefix: "[!] blocked: <reason> — <task>". */
const BLOCK_PREFIX_RE = /^\s*blocked:\s.*?\s—\s/i;

const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ").replace(/\s{2,}/g, " ").trim();

type LineKind = "task" | "heading" | "text" | "code";

/** Line kinds with the same fence / comment rules as parseMission ("code" = fenced or commented). */
function classify(lines: readonly string[]): LineKind[] {
  const out: LineKind[] = [];
  let fence: string | null = null;
  let comment = false;
  for (const l of lines) {
    if (fence) {
      if (l.trim().startsWith(fence)) fence = null;
      out.push("code");
      continue;
    }
    const f = FENCE_RE.exec(l);
    if (f) {
      fence = f[1];
      out.push("code");
      continue;
    }
    if (comment) {
      if (l.includes("-->")) comment = false;
      out.push("code");
      continue;
    }
    if (/^\s*<!--/.test(l)) {
      if (!l.includes("-->")) comment = true;
      out.push("code");
      continue;
    }
    out.push(TASK_RE.test(l) ? "task" : HEADING_RE.test(l) ? "heading" : "text");
  }
  return out;
}

interface Rec {
  body: string;
  /** This line's own ending ("\r\n", "\n"; "" for a last line without one). */
  sep: string;
}

interface Split {
  recs: Rec[];
  /** Ending given to a line that had none and is no longer last: the file's first ending, else "\n". */
  eol: string;
  /** The file ends with a line ending (the empty piece after it is not a record). */
  finalNewline: boolean;
  lines: string[];
  kinds: LineKind[];
}

function split(text: string): Split {
  const parts = text.split(/(\r?\n)/);
  const recs: Rec[] = [];
  for (let i = 0; i < parts.length; i += 2) recs.push({ body: parts[i], sep: parts[i + 1] ?? "" });
  const finalNewline = recs.length > 1 && recs[recs.length - 1].body === "";
  if (finalNewline) recs.pop();
  const lines = recs.map((r) => r.body);
  return { recs, eol: parts[1] ?? "\n", finalNewline, lines, kinds: classify(lines) };
}

function join(s: Pick<Split, "eol" | "finalNewline">, recs: readonly Rec[]): string {
  let out = "";
  recs.forEach((r, i) => {
    const last = i === recs.length - 1;
    out += r.body + (last && !s.finalNewline ? "" : r.sep || s.eol);
  });
  return out;
}

function indentOf(l: string): number {
  let n = 0;
  for (const c of /^[ \t]*/.exec(l)![0]) n += c === "\t" ? 4 : 1;
  return n;
}

/** Exclusive end of the block of the task on `line`: deeper-indented lines after it (blank lines count only between them). */
function blockEndOf(s: Split, line: number): number {
  const ind = indentOf(s.lines[line]);
  let end = line + 1;
  for (let j = line + 1; j < s.lines.length; j++) {
    const l = s.lines[j];
    if (l.trim() === "") continue;
    if (indentOf(l) <= ind) break;
    // A deeper fence / comment owns its body even when that body is not indented.
    if (s.kinds[j] === "code") while (j + 1 < s.lines.length && s.kinds[j + 1] === "code") j++;
    end = j + 1;
  }
  return end;
}

const isTaskLine = (s: Split, line: number) => Number.isInteger(line) && line >= 0 && line < s.lines.length && s.kinds[line] === "task";

/** Exclusive end line of the task block starting at `line` (null when that line is not a task). */
export function taskBlockEnd(text: string, line: number): number | null {
  const s = split(text);
  return isTaskLine(s, line) ? blockEndOf(s, line) : null;
}

/** The raw source line of the task on `line` (for "copy line"); null when that line is not a task. */
export function taskSource(text: string, line: number): string | null {
  const s = split(text);
  return isTaskLine(s, line) ? s.lines[line] : null;
}

/**
 * Move the block of the task on `fromLine` so it starts where line `toLine` (of the current text) starts;
 * `toLine` = the line count appends. A target inside another task's notes snaps to the end of that block,
 * so a task is never separated from its notes. Returns the new text and the task's new line, the same text
 * for a no-op, null when `fromLine` is not a task.
 */
export function planMove(text: string, fromLine: number, toLine: number): { text: string; line: number } | null {
  const s = split(text);
  if (!isTaskLine(s, fromLine)) return null;
  const end = blockEndOf(s, fromLine);
  let at = Math.max(0, Math.min(Math.trunc(toLine), s.lines.length));
  for (;;) {
    if (at >= s.lines.length || s.kinds[at] === "task") break;
    let snapped = at;
    for (let t = at - 1; t >= 0; t--) {
      if (s.kinds[t] !== "task") continue;
      const e = blockEndOf(s, t);
      if (e > at) {
        snapped = e;
        break;
      }
    }
    if (snapped === at) break;
    at = snapped;
  }
  if (at >= fromLine && at <= end) return { text, line: fromLine };
  const block = s.recs.slice(fromLine, end);
  const rest = [...s.recs.slice(0, fromLine), ...s.recs.slice(end)];
  const ins = at > end ? at - (end - fromLine) : at;
  rest.splice(ins, 0, ...block);
  return { text: join(s, rest), line: ins };
}

/** planMove, text only (null when `fromLine` is not a task). */
export function moveTask(text: string, fromLine: number, toLine: number): string | null {
  return planMove(text, fromLine, toLine)?.text ?? null;
}

/** Remove the task on `line` with its notes / sub-items. Null when that line is not a task. */
export function deleteTask(text: string, line: number): string | null {
  const s = split(text);
  if (!isTaskLine(s, line)) return null;
  const rest = [...s.recs.slice(0, line), ...s.recs.slice(blockEndOf(s, line))];
  if (rest.length === 0) return "";
  return join(s, rest);
}

/** Rewrite one task line through `fn(match)`; null when not a task, the same text when `fn` returns the same line. */
function rewriteTask(text: string, line: number, fn: (m: RegExpExecArray) => string | null): string | null {
  const s = split(text);
  if (!isTaskLine(s, line)) return null;
  const m = TASK_RE.exec(s.lines[line])!;
  const next = fn(m);
  if (next === null) return null;
  if (next === s.lines[line]) return text;
  const recs = s.recs.slice();
  recs[line] = { ...recs[line], body: next };
  return join(s, recs);
}

/**
 * The board's state change: the box, plus the blocked reason. Blocking with a reason writes it right after
 * the box ("[!] blocked: <reason> — <task>", as the agent-mission skill asks); leaving blocked removes that
 * board-written prefix again. Null when `line` is not a task.
 */
export function changeTaskState(text: string, line: number, state: TaskState, reason?: string | null): string | null {
  return rewriteTask(text, line, (m) => {
    const from = stateOfBox(m[2]);
    const why = oneLine(reason ?? "");
    let rest = m[3];
    if (state === "blocked" && why) {
      const bare = rest.replace(BLOCK_PREFIX_RE, " ").trim();
      rest = ` blocked: ${why}${bare ? ` — ${bare}` : ""}`;
    } else if (from === "blocked" && state !== "blocked") rest = rest.replace(BLOCK_PREFIX_RE, " ");
    const box = from === state ? m[2] : BOX_CHAR[state];
    return `${m[1]}[${box}]${rest}`;
  });
}

/**
 * Add a task under the "## Tasks" heading (after the section's last non-blank line), creating the heading
 * at the end of the file when there is none. `taskText` may carry "@owner" tokens; a typed bullet / box is
 * stripped. Null when the text is empty.
 */
export function addTask(text: string, taskText: string, state: TaskState = "todo"): string | null {
  return planAdd(text, taskText, state)?.text ?? null;
}

/** addTask + the new task's line. */
export function planAdd(text: string, taskText: string, state: TaskState = "todo"): { text: string; line: number } | null {
  const body = cleanTaskLine(oneLine(taskText));
  if (!body) return null;
  const task = `- [${BOX_CHAR[state]}] ${body}`;
  const s = split(text);
  if (text.trim() === "") return { text: `## Tasks${s.eol}${task}${s.eol}`, line: 1 };
  const h = s.lines.findIndex((l, i) => s.kinds[i] === "heading" && TASKS_HEADING_RE.test(l));
  const recs = s.recs.slice();
  if (h < 0) {
    const add: string[] = s.lines[s.lines.length - 1].trim() === "" ? [] : [""];
    add.push("## Tasks", task);
    // The old last line gets an ending if it had none; the file's final-newline state carries over.
    recs.push(...add.map((body) => ({ body, sep: s.eol })));
    return { text: join(s, recs), line: recs.length - 1 };
  }
  let end = s.lines.length;
  for (let i = h + 1; i < s.lines.length; i++)
    if (s.kinds[i] === "heading") {
      end = i;
      break;
    }
  let at = h + 1;
  for (let i = end - 1; i > h; i--)
    if (s.lines[i].trim() !== "") {
      at = i + 1;
      break;
    }
  recs.splice(at, 0, { body: task, sep: s.eol });
  return { text: join(s, recs), line: at };
}

/**
 * Replace a task's text, keeping its box. Without "@" tokens in `newText` the task keeps its owners (appended
 * as "@a @b"); with tokens, the typed ones are the owners. Unchanged text = same file; empty text = null.
 */
export function editTaskText(text: string, line: number, newText: string): string | null {
  const body = cleanTaskLine(oneLine(newText));
  if (!body) return null;
  return rewriteTask(text, line, (m) => {
    const old = ownersOf(m[3]);
    const typed = ownersOf(body);
    if (typed.owners.length === 0 && typed.text === old.text) return m[0];
    const owners = typed.owners.length ? "" : old.owners.map((o) => ` @${o}`).join("");
    return `${m[1]}[${m[2]}] ${body}${owners}`;
  });
}

/** Set a task's owners (slugified, unique; [] = unassigned): the old tokens go, the new ones are appended. */
export function setTaskOwners(text: string, line: number, slugs: readonly string[]): string | null {
  const want: string[] = [];
  for (const raw of slugs) {
    const s = slugify(raw.replace(/^@/, ""));
    if (s && !want.includes(s)) want.push(s);
  }
  return rewriteTask(text, line, (m) => {
    const cur = ownersOf(m[3]);
    if (cur.owners.length === want.length && cur.owners.every((o, i) => o === want[i])) return m[0];
    return `${m[1]}[${m[2]}]${cur.text ? ` ${cur.text}` : ""}${want.map((o) => ` @${o}`).join("")}`;
  });
}

/** Add one owner (minimal edit: " @slug" appended to the line). Same text when it already owns the task. */
export function addTaskOwner(text: string, line: number, slug: string): string | null {
  const s = slugify(slug.replace(/^@/, ""));
  if (!s) return null;
  return rewriteTask(text, line, (m) => {
    if (ownersOf(m[3]).owners.includes(s)) return m[0];
    return `${m[0].replace(/\s+$/, "")} @${s}`;
  });
}

/** Owner suggestions for "@" completion: member name slugs (team order), then their roles. Unique. */
export function teamSlugs(team: readonly Pick<TeamMember, "name" | "role">[]): string[] {
  const out: string[] = [];
  for (const m of team) {
    const s = slugify(m.name);
    if (s && !out.includes(s)) out.push(s);
  }
  for (const m of team) {
    const r = normalizeRole(m.role);
    if (r && !out.includes(r)) out.push(r);
  }
  return out;
}

/** The "@partial" token ending at `caret` and the slugs it can complete to (null when the caret is not in one). */
export function ownerCompletion(value: string, caret: number, slugs: readonly string[]): { start: number; prefix: string; matches: string[] } | null {
  const before = value.slice(0, caret);
  const m = /(^|[\s(\[,;])@([A-Za-z0-9_-]*)$/.exec(before);
  if (!m) return null;
  const prefix = m[2].toLowerCase();
  const start = caret - m[2].length - 1;
  return { start, prefix, matches: slugs.filter((s) => s.startsWith(prefix) && s !== prefix) };
}

export type TaskFilter = "all" | "mine" | "unassigned" | "blocked";

/**
 * Board filter: "mine" = owned by `member` (the agent selected in Mission Control; nothing without one),
 * "unassigned" = not done and owned by nobody on the team, "blocked". `query` matches text or "@owner".
 */
export function matchesFilter(
  task: Task,
  filter: TaskFilter,
  query: string,
  team: readonly TeamMember[],
  member: Pick<TeamMember, "name" | "role"> | null,
): boolean {
  if (filter === "mine" && !(member && ownsTask(task, member))) return false;
  if (filter === "unassigned" && (task.state === "done" || ownersFor(task, team).length > 0)) return false;
  if (filter === "blocked" && task.state !== "blocked") return false;
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (task.text.toLowerCase().includes(q)) return true;
  const bare = q.replace(/^@/, "");
  return !!bare && task.owners.some((o) => o.includes(bare));
}
