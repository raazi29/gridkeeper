// Lead control channel: how a lead (or any agent) instructs teammates through plain files, and the generated
// team status it reads. Pure and node-safe (unit-tested); the engine lives in actions/leadControl.ts.
//
// Files in <main project>/.gridkeeper/:
//
//   outbox/   Any agent (normally the lead) creates ONE new file per instruction, e.g. outbox/0007-builder-1.md:
//
//                 to: builder-1
//                 from: lead
//                 action: message
//                 ---
//                 Also add a unit test for the callback route, then mark the task done.
//
//             - to (required): a teammate slug (slugify(name), as in mission.md), a role ("builder" = every
//               builder), a comma-separated list, or "all" (everyone except the sender).
//             - from: self-declared and unverifiable (shown "… (self-declared)" unless it names a lead;
//               default "lead").
//             - action: message (default) | review | stop | restart; anything else = message + a warning.
//             - Body after "---" (or the whole file when there is no header) = the text typed into the target's
//               terminal: control characters / ANSI stripped, newlines collapsed, at most 4000 characters.
//             Gridkeeper never edits these files; it MOVES each handled one to outbox/sent/ or outbox/dismissed/.
//
//   team.md   Written ONLY by Gridkeeper (renderTeamMd): mission goal + progress and one line per member.

import { ownerMatches, slugify, type MissionProgress } from "./missionDoc";
import { normalizeRole } from "./roles";

export type OutboxAction = "message" | "review" | "stop" | "restart";
export const OUTBOX_ACTIONS: readonly OutboxAction[] = ["message", "review", "stop", "restart"];

/** Longest instruction text typed into a terminal. */
export const MAX_INSTRUCTION_CHARS = 4000;

export interface OutboxInstruction {
  /** Target tokens (slugs, roles, "all"), lowercase, unique, in file order. Empty = no "to:" line. */
  to: string[];
  /** Self-declared sender token (slugified), null when the file has no "from:" line. */
  from: string | null;
  action: OutboxAction;
  /** The instruction as one clean line (may be empty). */
  text: string;
  warnings: string[];
}

const HEADER_LINE = /^\s*([A-Za-z][\w-]*)\s*:\s*(.*?)\s*$/;
const KNOWN_KEYS = new Set(["to", "from", "action"]);
const SEPARATOR = /^\s*-{3,}\s*$/;
const EVERYONE = new Set(["all", "everyone", "team"]);

/**
 * Remove everything a terminal would interpret: ANSI CSI / OSC / other escape sequences, C0 / C1 control
 * characters (tabs and line breaks become spaces) and bidirectional overrides. Pure.
 */
export function stripControl(s: string): string {
  return s
    .replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g, "") // OSC … BEL / ST
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "") // CSI
    .replace(/\u001b[\s\S]?/g, "") // any other escape (+ its next character)
    .replace(/[\t\n\r\u000b\u000c\u2028\u2029]/g, " ")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, "");
}

/** Instruction text as typed: controls stripped, whitespace collapsed to single spaces, capped. Pure. */
export function cleanInstruction(s: string, max = MAX_INSTRUCTION_CHARS): { text: string; cut: boolean } {
  const t = stripControl(s).replace(/\s+/g, " ").trim();
  if (t.length <= max) return { text: t, cut: false };
  return { text: t.slice(0, max).trimEnd(), cut: true };
}

/** "builder-1, @builder-2 reviewer" → ["builder-1", "builder-2", "reviewer"]. */
function splitTargets(value: string): string[] {
  const out: string[] = [];
  for (const raw of value.split(/[\s,;]+/)) {
    const t = slugify(raw.replace(/^@+/, ""));
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/** Parse one outbox file (see the format above). Never throws. */
export function parseOutbox(raw: string): OutboxInstruction {
  const warnings: string[] = [];
  const lines = raw.replace(/^﻿/, "").split(/\r\n|\r|\n/);
  let start = 0;
  while (start < lines.length && !lines[start].trim()) start++;
  // Front-matter style: an optional "---" before the header.
  if (start < lines.length && SEPARATOR.test(lines[start])) start++;

  let header: string[] = [];
  let body: string[];
  const sep = lines.findIndex((l, i) => i >= start && SEPARATOR.test(l));
  const head = sep >= 0 ? lines.slice(start, sep) : [];
  // A header block: only "key: value" lines, at least one of them to / from / action ("Note: …" + a rule is prose).
  const isHeader =
    head.every((l) => !l.trim() || HEADER_LINE.test(l)) && head.some((l) => KNOWN_KEYS.has(HEADER_LINE.exec(l)?.[1].toLowerCase() ?? ""));
  if (sep >= 0 && isHeader) {
    header = lines.slice(start, sep);
    body = lines.slice(sep + 1);
  } else {
    // No "---" after a header: leading "to: / from: / action:" lines still count.
    let i = start;
    while (i < lines.length) {
      const m = HEADER_LINE.exec(lines[i]);
      if (!m || !KNOWN_KEYS.has(m[1].toLowerCase())) break;
      i++;
    }
    header = lines.slice(start, i);
    body = lines.slice(i);
  }

  const to: string[] = [];
  let from: string | null = null;
  let actionRaw = "";
  for (const l of header) {
    const m = HEADER_LINE.exec(l);
    if (!m) continue;
    const key = m[1].toLowerCase();
    if (key === "to") {
      for (const t of splitTargets(m[2])) if (!to.includes(t)) to.push(t);
    } else if (key === "from") from = slugify(m[2].replace(/^@+/, "")) || null;
    else if (key === "action") actionRaw = m[2].replace(/^@+/, "").trim().toLowerCase();
    else warnings.push(`unknown header “${cleanInstruction(key, 40).text}” ignored`);
  }

  let action: OutboxAction = "message";
  if (actionRaw) {
    if ((OUTBOX_ACTIONS as readonly string[]).includes(actionRaw)) action = actionRaw as OutboxAction;
    else warnings.push(`unknown action “${cleanInstruction(actionRaw, 40).text}” — treated as a message`);
  }
  if (to.length === 0) warnings.push("no “to:” line — nobody to deliver it to");

  const { text, cut } = cleanInstruction(body.join("\n"));
  if (cut) warnings.push(`longer than ${MAX_INSTRUCTION_CHARS} characters — shortened`);
  return { to, from, action, text, warnings };
}

// ---- team resolution ------------------------------------------------------------------------------

export interface TeamRef {
  id: string;
  name: string;
  role: string | null;
}

export const isLeadRole = (role: string | null | undefined): boolean => normalizeRole(role) === "lead";

/** Members a self-declared `from` names (name slug or role); none without a `from`. */
export function senderIds(from: string | null, team: readonly TeamRef[]): string[] {
  if (!from || EVERYONE.has(from)) return [];
  return team.filter((m) => ownerMatches(from, m)).map((m) => m.id);
}

/** The leads a `from` names: by name slug or the role ("lead" / "leads"); no `from` = every lead. */
export function senderLeads(from: string | null, team: readonly TeamRef[]): TeamRef[] {
  const leads = team.filter((m) => isLeadRole(m.role));
  if (!from) return leads;
  return leads.filter((m) => from === "lead" || from === "leads" || slugify(m.name) === from);
}

/**
 * Session ids for "to:" tokens, in team order (unique), and the tokens that match nobody.
 * - A name slug always matches (even the sender's own).
 * - A role ("builder", "builders") leaves out the members `from` names.
 * - "all" / "everyone" / "team" = everyone except the sender (no `from`: the sender is the lead).
 */
export function resolveTargets(to: readonly string[], team: readonly TeamRef[], from: string | null = null): { ids: string[]; unknown: string[] } {
  const explicit = new Set(senderIds(from, team));
  const forAll = from ? explicit : new Set(senderLeads(null, team).map((m) => m.id));
  const hit = new Set<string>();
  const unknown: string[] = [];
  for (const tok of to) {
    let matched = false;
    for (const m of team) {
      if (slugify(m.name) === tok) {
        hit.add(m.id);
        matched = true;
      } else if (EVERYONE.has(tok)) {
        matched = true;
        if (!forAll.has(m.id)) hit.add(m.id);
      } else if (ownerMatches(tok, m)) {
        matched = true; // a role; matching only the sender is not "unknown"
        if (!explicit.has(m.id)) hit.add(m.id);
      }
    }
    if (!matched) unknown.push(tok);
  }
  return { ids: team.filter((m) => hit.has(m.id)).map((m) => m.id), unknown };
}

/** How the sender is shown: "lead" (no `from`), the `from` when it names a lead, else "<from> (self-declared)". */
export function fromLabel(from: string | null, team: readonly TeamRef[]): string {
  if (!from) return "lead";
  return senderLeads(from, team).length > 0 ? from : `${from} (self-declared)`;
}

/** Prefix typed before an instruction so the receiving agent knows where it came from. */
export function instructionPrefix(action: OutboxAction, from: string | null): string {
  const who = from ?? "lead";
  return action === "review" ? `[review request from ${who}] ` : `[from ${who}] `;
}

// ---- rate limits (autopilot) --------------------------------------------------------------------------

/** At most one automatic delivery per target per this interval. */
export const RATE_PER_TARGET_MS = 20_000;
/** …and at most RATE_MAX_PER_WINDOW automatic deliveries overall per this window. */
export const RATE_WINDOW_MS = 60_000;
export const RATE_MAX_PER_WINDOW = 8;

export interface Delivery {
  target: string;
  at: number;
}

/** Milliseconds until one more delivery to `target` is allowed (0 = now). Pure. */
export function rateLimitWait(history: readonly Delivery[], target: string, now: number): number {
  let last = -Infinity;
  const recent: number[] = [];
  for (const d of history) {
    if (d.target === target && d.at > last) last = d.at;
    if (now - d.at < RATE_WINDOW_MS) recent.push(d.at);
  }
  let wait = last + RATE_PER_TARGET_MS - now;
  if (recent.length >= RATE_MAX_PER_WINDOW) {
    recent.sort((a, b) => a - b);
    wait = Math.max(wait, recent[recent.length - RATE_MAX_PER_WINDOW] + RATE_WINDOW_MS - now);
  }
  return Math.max(0, Math.ceil(wait));
}

/** Drop deliveries that can no longer limit anything. Pure. */
export function pruneDeliveries(history: readonly Delivery[], now: number): Delivery[] {
  const keep = Math.max(RATE_WINDOW_MS, RATE_PER_TARGET_MS);
  return history.filter((d) => now - d.at < keep);
}

// ---- auto-review -------------------------------------------------------------------------------------

export interface ReviewRequest {
  name: string;
  slug: string;
  task: string | null;
  branch: string | null;
  base: string | null;
  ahead: number;
  files: number;
  /** Folder whose git state is the evidence (the session's worktree, else its working folder). */
  path: string;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The review request typed into the lead when a teammate finishes. One line. Pure. */
export function autoReviewText(r: ReviewRequest): string {
  const task = r.task ? `'${cleanInstruction(r.task, 200).text}'` : "their task";
  const where = r.branch ? `on ${r.branch}` : `in ${r.path}`;
  const stats = r.ahead > 0 ? `(+${plural(r.ahead, "commit")}, ${plural(r.files, "file")})` : "(no new commits)";
  const cmd = r.ahead > 0 && r.base && r.branch ? `git -C "${r.path}" diff ${r.base}...${r.branch}` : `git -C "${r.path}" diff HEAD`;
  const who = r.slug || "them";
  return cleanInstruction(
    `${r.name} finished ${task} ${where} ${stats}. Review with: ${cmd} — then message them via .gridkeeper/outbox (to: ${who}) with fixes, or mark the review task done.`,
  ).text;
}

// ---- team.md ------------------------------------------------------------------------------------------

export type MemberState = "working" | "needs-you" | "done" | "error" | "idle" | "stopped";

/** Team-file state of a member from its process liveness and attention state. Pure. */
export function memberState(live: boolean, attention: string | undefined): MemberState {
  if (!live) return "stopped";
  switch (attention) {
    case "working":
      return "working";
    case "waiting":
      return "needs-you";
    case "done":
      return "done";
    case "error":
      return "error";
    default:
      return "idle";
  }
}

export interface TeamMdBranch {
  name: string | null;
  ahead: number;
  files: number;
  insertions: number;
  deletions: number;
  uncommitted: number;
}

export interface TeamMdMember {
  slug: string;
  name: string;
  role: string | null;
  /** Agent label, e.g. "claude", "codex", "gemini". */
  agent: string;
  state: MemberState;
  task: string | null;
  branch: TeamMdBranch | null;
  /** Last lines of output (only when the user shares output with the lead). */
  output?: string[] | null;
}

export interface TeamMdSnapshot {
  /** Absolute `<project>\.gridkeeper` folder (for the messaging how-to). */
  gridkeeperDir: string;
  goal: string | null;
  /** Null when there is no mission file. */
  progress: MissionProgress | null;
  mode: "advisor" | "autopilot";
  paused: boolean;
  members: TeamMdMember[];
  /** Local time stamp; left out when comparing two renders. */
  updatedAt?: string;
}

/** A Markdown fence longer than any backtick run in `lines`. */
function fenceFor(lines: readonly string[]): string {
  let run = 0;
  for (const l of lines) for (const m of l.matchAll(/`+/g)) run = Math.max(run, m[0].length);
  return "`".repeat(Math.max(3, run + 1));
}

const oneLine = (s: string) => cleanInstruction(s, 300).text;

function sepOf(dir: string): string {
  return dir.includes("\\") || !dir.includes("/") ? "\\" : "/";
}

function memberLine(m: TeamMdMember): string {
  const who = [normalizeRole(m.role), oneLine(m.agent)].filter(Boolean).join(", ");
  const bits = [`- @${m.slug || oneLine(m.name) || "unnamed"}${who ? ` (${who})` : ""}`, m.state, m.task ? `task: ${oneLine(m.task)}` : "no open task"];
  if (m.branch) {
    const b = m.branch;
    bits.push(
      `⎇ ${b.name ? oneLine(b.name) : "detached"} +${plural(b.ahead, "commit")}, ${plural(b.files, "file")} +${b.insertions} −${b.deletions}, uncommitted ${b.uncommitted}`,
    );
  }
  return bits.join(" — ");
}

/** The generated, read-only `.gridkeeper/team.md`. Pure; LF line endings. */
export function renderTeamMd(s: TeamMdSnapshot): string {
  const sep = sepOf(s.gridkeeperDir);
  const gk = s.gridkeeperDir.replace(/[\\/]+$/, "");
  const outbox = `${gk}${sep}outbox${sep}`;
  const out: string[] = [
    "<!-- Generated by Gridkeeper. Read-only: every change to this file is overwritten. -->",
    "# Team status",
    "",
    "> Generated by Gridkeeper and rewritten whenever the team changes. Do not edit this file.",
    `> To instruct a teammate, create a NEW file in ${outbox} (see "Messaging" below).`,
    `> Project memory: read ${gk}${sep}brain${sep}INDEX.md first (if present); suggest new memories as new files in ${gk}${sep}brain${sep}inbox${sep}.`,
    "",
  ];
  if (s.updatedAt) out.push(`Updated: ${s.updatedAt}`);
  if (!s.progress) out.push("Mission: none yet (no .gridkeeper/mission.md)");
  else {
    const p = s.progress;
    const rest = [p.doing ? `${p.doing} doing` : "", p.blocked ? `${p.blocked} blocked` : "", p.todo ? `${p.todo} todo` : ""].filter(Boolean);
    out.push(`Mission: ${s.goal ? oneLine(s.goal) : "(no goal)"} — ${p.done}/${p.total} tasks done${rest.length ? ` (${rest.join(", ")})` : ""}`);
  }
  out.push(
    s.mode === "autopilot" && !s.paused
      ? "Delivery: autopilot — message / review instructions are typed into the target automatically when it is idle and not asking anything; stop / restart always wait for the user."
      : s.mode === "autopilot"
        ? "Delivery: autopilot paused by the user — every instruction waits for the user's approval for now."
        : "Delivery: advisor — the user reviews every instruction before it is sent.",
    "",
    "## Members",
    "",
  );
  if (s.members.length === 0) out.push("(nobody yet)");
  for (const m of s.members) out.push(memberLine(m));

  const shared = s.members.filter((m) => m.output && m.output.length > 0);
  if (shared.length) {
    out.push("", "## Recent output", "", "Last lines of each terminal, shared by the user (may be incomplete).");
    for (const m of shared) {
      const lines = (m.output ?? []).map((l) => stripControl(l).replace(/\s+$/, ""));
      const fence = fenceFor(lines);
      out.push("", `### @${m.slug || oneLine(m.name)}`, "", `${fence}text`, ...lines, fence);
    }
  }

  out.push(
    "",
    "## Messaging",
    "",
    `Create ONE new file per instruction in ${outbox}, for example 0007-builder-1.md:`,
    "",
    "    to: builder-1",
    "    action: message",
    "    ---",
    "    Also add a unit test for the callback route, then mark the task done.",
    "",
    "- to: a teammate's slug (the name after @ above), a role (builder = every builder), a comma-separated list, or all.",
    "- action: message (default), review (ask them to review someone's work), stop or restart (the user always confirms those).",
    "- The text after --- is typed into their terminal as one line (at most 4000 characters).",
    "- Never edit or delete files in the outbox; Gridkeeper moves handled ones to outbox/sent/ or outbox/dismissed/.",
    "",
  );
  return out.join("\n");
}
