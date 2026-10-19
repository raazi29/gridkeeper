// Team templates: one portable file `<name>.gridkeeper-team.json` that carries a formation (groups, roles,
// agent kinds), per-role starter prompts, a mission template, optional brain notes and a recommended lead
// control mode. Pure and node-safe (unit-tested); file IO and launching live in actions/teamTemplates.ts.
//
// Safety model: a template is untrusted input. `sanitizeTeamTemplate` rebuilds it field by field from a fixed
// schema: unknown fields are dropped (and reported), every string is length-capped and stripped of control /
// bidi characters, absolute paths and well-known secret formats are redacted, and only built-in agent kinds or
// known catalog presets are accepted ("command:<exe>" keys are refused: a template never names a program to
// run). Nothing in a template is ever executed; prompts are only typed into agents after the user has seen
// them in the preview and confirmed. Account / profile ids, args, env and paths are never exported.
// Schema reference: docs/team-templates.md.
//
// Check errors / warnings are UI text (translated when produced); template content (names, prompts, mission
// text, defaults written into a template) stays English: it is written to files and typed into agents.

import { t } from "../i18n";
import type { LayoutPreset } from "../lib/types";
import { addTask, newMissionText, parseMission, slugify } from "../lib/missionDoc";
import { normalizeRole } from "../lib/roles";
import {
  buildFormationPlan,
  PROFILE_RR,
  roleKeyOf,
  type FormationPlan,
  type FormationTemplate,
  type PlanInput,
} from "./formationPlan";

export const TEAM_FORMAT = "gridkeeper-team";
export const TEAM_SCHEMA_VERSION = 1;
export const TEAM_FILE_SUFFIX = ".gridkeeper-team.json";
/** Oldest Gridkeeper that can run everything a v1 template describes (formations, mission board, lead control). */
export const TEAM_MIN_APP_VERSION = "0.2.0";

export const TEAM_LIMITS = {
  fileChars: 256 * 1024,
  groups: 8,
  slotsPerGroup: 16,
  slots: 24,
  name: 80,
  description: 400,
  groupName: 60,
  sessionName: 40,
  tags: 8,
  tag: 24,
  author: 39,
  roles: 16,
  prompt: 2000,
  goalHint: 200,
  context: 2000,
  tasks: 60,
  taskText: 300,
  owners: 6,
  notes: 20,
  noteTitle: 120,
  noteBody: 4000,
  noteKind: 24,
} as const;

/** Catalog tool ids (src-tauri/src/adapters/catalog.rs) a template may name as `preset:<id>`. */
export const KNOWN_PRESETS = ["hermes", "opencode", "gemini", "copilot", "aider", "droid", "kimi", "qwen", "cursor", "goose", "crush", "amp", "openclaw"] as const;

export type LeadMode = "off" | "advisor" | "autopilot";
const LEAD_MODES: readonly LeadMode[] = ["off", "advisor", "autopilot"];
const LAYOUTS: readonly LayoutPreset[] = ["grid", "columns", "rows"];

export interface TeamSlot {
  role: string;
  /** "claude" | "codex" | "powershell" | "preset:<catalog id>" */
  agent: string;
  /** Optional session name; otherwise derived from the role ("builder-1"). */
  name?: string;
  /** Slots sharing a key share ONE new worktree; absent = the project folder. */
  worktree?: string;
}

export interface TeamGroup {
  name: string;
  layout: LayoutPreset;
  slots: TeamSlot[];
}

export interface TeamTask {
  text: string;
  /** Role keys (or session names from the formation, or "all"), without "@". */
  owners: string[];
}

export interface BrainNote {
  title: string;
  kind: string;
  tags: string[];
  body: string;
}

export interface TeamMeta {
  name: string;
  description: string;
  author: string | null;
  tags: string[];
  minVersion: string;
}

export interface TeamMission {
  /** Shown as the placeholder of the goal field when importing. */
  goalHint: string;
  /** Written under the goal in a new mission file. */
  context: string;
  tasks: TeamTask[];
}

export interface TeamTemplate {
  format: typeof TEAM_FORMAT;
  version: typeof TEAM_SCHEMA_VERSION;
  meta: TeamMeta;
  formation: { groups: TeamGroup[] };
  /** Starter prompt per role key ("agent" = sessions without a role). Placeholders: {mission} {teammates} {role}. */
  prompts: Record<string, string>;
  mission: TeamMission;
  brain: BrainNote[];
  leadControl: LeadMode;
}

export interface TemplateCheck {
  template: TeamTemplate | null;
  errors: string[];
  warnings: string[];
}

export interface CheckOptions {
  /** Running Gridkeeper version, for the minimum-version warning. */
  appVersion?: string | null;
  /** Extra catalog ids detected on this machine (merged with KNOWN_PRESETS). */
  knownPresets?: readonly string[];
}

// ---- text hygiene -----------------------------------------------------------------------------

// C0 controls except \t \n (CR is normalized first), DEL and C1 controls: no escape sequences reach a terminal.
const CONTROL_RE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;
// Zero-width and bidi override / isolate characters (hidden text, "Trojan Source").
const INVISIBLE_RE = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;
// Absolute paths: drive letters, UNC shares, ~/ and well-known Unix roots. No lookbehind (older WebKit).
const ABS_PATH_RE = /(^|[\s"'(=,;<>[{])((?:[A-Za-z]:[\\/]|\\\\|~[\\/]|\/(?:Users|home|root|var|etc|opt|tmp|mnt|Volumes|private|srv|usr|Library)\/)[^\s"'`<>|)\]}]*)/g;
const SECRET_RE = /\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g;

/** Replace absolute paths with "<path>" and well-known token formats with "<redacted>". Pure. */
export function redactText(s: string): string {
  return s.replace(SECRET_RE, "<redacted>").replace(ABS_PATH_RE, (_m, pre: string) => `${pre}<path>`);
}

function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  let out = s.slice(0, max);
  if (/[\uD800-\uDBFF]$/.test(out)) out = out.slice(0, -1);
  return out.trimEnd();
}

/** Untrusted value → clean string ("" when not a string). `multiline` keeps paragraphs, else one line. */
export function cleanText(v: unknown, max: number, multiline = false): string {
  if (typeof v !== "string") return "";
  let s = v.replace(/\r\n?/g, "\n").replace(/\t/g, " ").replace(CONTROL_RE, "").replace(INVISIBLE_RE, "");
  s = multiline
    ? s
        .split("\n")
        .map((l) => l.replace(/ {2,}/g, " ").trimEnd())
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
    : s.replace(/\s+/g, " ");
  return clip(redactText(s).trim(), max);
}

function cleanTags(v: unknown, max: number, warn: (w: string) => void, what: "tags" | "noteTags"): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const tag of v) {
    const s = slugify(typeof tag === "string" ? tag : "").slice(0, TEAM_LIMITS.tag);
    if (s && !out.includes(s)) out.push(s);
  }
  if (out.length > max) warn(t(what === "tags" ? "teams.check.tagsKept" : "teams.check.noteTagsKept", { max }));
  return out.slice(0, max);
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Keys of `o` outside `allowed`, as safe display names. */
function extraKeys(o: Record<string, unknown>, allowed: readonly string[]): string[] {
  return Object.keys(o)
    .filter((k) => !allowed.includes(k))
    .map((k) => k.replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 24) || "?");
}

// ---- versions -----------------------------------------------------------------------------------

const VERSION_RE = /^(\d{1,4})\.(\d{1,4})\.(\d{1,6})$/;

/** -1 / 0 / 1 for "a.b.c" versions (pre-release suffixes ignored); 0 when either is unparsable. */
export function compareVersions(a: string, b: string): number {
  const pa = VERSION_RE.exec(a.trim().replace(/^v/, "").replace(/[-+].*$/, ""));
  const pb = VERSION_RE.exec(b.trim().replace(/^v/, "").replace(/[-+].*$/, ""));
  if (!pa || !pb) return 0;
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

// ---- agent keys ------------------------------------------------------------------------------------

/** Accept a built-in kind or a known catalog preset; refuse commands and anything unknown. Pure. */
export function checkAgentKey(raw: unknown, known: ReadonlySet<string>): { key: string } | { reason: string } {
  if (typeof raw !== "string" || !raw.trim()) return { reason: t("teams.check.noAgentKind") };
  const k = raw.trim();
  if (k === "claude" || k === "codex" || k === "powershell") return { key: k };
  if (k.startsWith("command:")) return { reason: t("teams.check.agentCommand") };
  if (k.startsWith("preset:")) {
    const id = k.slice(7).toLowerCase();
    if (/^[a-z0-9-]{1,32}$/.test(id) && known.has(id)) return { key: `preset:${id}` };
    return { reason: t("teams.check.agentUnknownTool", { name: clean1(id) }) };
  }
  return { reason: t("teams.check.agentUnknownKind", { name: clean1(k) }) };
}

const clean1 = (s: string) => cleanText(s, 32);

function sessionName(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = cleanText(v, TEAM_LIMITS.sessionName)
    .replace(/[^\p{L}\p{N} _-]/gu, "")
    .trim();
  return s || undefined;
}

const worktreeKey = (v: unknown) => (typeof v === "string" ? v.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 32) || undefined : undefined);

// ---- sanitize ----------------------------------------------------------------------------------------

const TOP_KEYS = ["format", "version", "meta", "formation", "prompts", "mission", "brain", "leadControl"] as const;
const META_KEYS = ["name", "description", "author", "tags", "minVersion"];
const GROUP_KEYS = ["name", "layout", "slots"];
const SLOT_KEYS = ["role", "agent", "name", "worktree"];
const MISSION_KEYS = ["goalHint", "context", "tasks"];
const TASK_KEYS = ["text", "owners"];
const NOTE_KEYS = ["title", "kind", "tags", "body"];

/** Parse + sanitize the text of a template file. Never throws. */
export function parseTeamTemplate(text: unknown, opts: CheckOptions = {}): TemplateCheck {
  if (typeof text !== "string" || !text.trim()) return { template: null, errors: [t("teams.check.empty")], warnings: [] };
  if (text.length > TEAM_LIMITS.fileChars) return { template: null, errors: [t("teams.check.tooLarge", { kb: TEAM_LIMITS.fileChars >> 10 })], warnings: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^﻿/, ""));
  } catch (e) {
    return { template: null, errors: [t("teams.check.invalidJson", { error: cleanText(e instanceof Error ? e.message : String(e), 160) })], warnings: [] };
  }
  return sanitizeTeamTemplate(raw, opts);
}

/** Rebuild a template from an untrusted value (strict schema, caps, redaction). Never throws. */
export function sanitizeTeamTemplate(raw: unknown, opts: CheckOptions = {}): TemplateCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  const warn = (w: string) => {
    if (!warnings.includes(w)) warnings.push(w);
  };
  const fail = (e: string): TemplateCheck => ({ template: null, errors: [...errors, e], warnings });
  if (!isObj(raw)) return fail(t("teams.check.notObject"));
  if (raw.format !== TEAM_FORMAT) return fail(t("teams.check.wrongFormat", { expected: TEAM_FORMAT }));
  const version = raw.version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) return fail(t("teams.check.noVersion"));
  if (version > TEAM_SCHEMA_VERSION) return fail(t("teams.check.newerVersion", { version, supported: TEAM_SCHEMA_VERSION }));

  const dropped = new Set<string>();
  const noteDropped = (keys: string[]) => keys.forEach((k) => dropped.add(k));
  noteDropped(extraKeys(raw, TOP_KEYS));

  // meta
  const m = isObj(raw.meta) ? raw.meta : {};
  noteDropped(extraKeys(m, META_KEYS));
  const name = cleanText(m.name, TEAM_LIMITS.name);
  if (!name) return fail(t("teams.check.noName"));
  const authorRaw = typeof m.author === "string" ? m.author.trim().replace(/^@/, "") : "";
  const author = /^[A-Za-z0-9_.-]{1,39}$/.test(authorRaw) ? authorRaw : null;
  if (authorRaw && !author) warn(t("teams.check.badAuthor"));
  let minVersion = typeof m.minVersion === "string" && VERSION_RE.test(m.minVersion.trim()) ? m.minVersion.trim() : TEAM_MIN_APP_VERSION;
  if (compareVersions(minVersion, TEAM_MIN_APP_VERSION) < 0) minVersion = TEAM_MIN_APP_VERSION;
  if (opts.appVersion && compareVersions(opts.appVersion, minVersion) < 0)
    warn(t("teams.check.minVersion", { min: minVersion, version: cleanText(opts.appVersion, 20) }));
  const meta: TeamMeta = {
    name,
    description: cleanText(m.description, TEAM_LIMITS.description),
    author,
    tags: cleanTags(m.tags, TEAM_LIMITS.tags, warn, "tags"),
    minVersion,
  };

  // formation
  const known = new Set<string>([...KNOWN_PRESETS, ...(opts.knownPresets ?? []).map((p) => p.toLowerCase())]);
  const f = isObj(raw.formation) ? raw.formation : null;
  if (!f || !Array.isArray(f.groups)) return fail(t("teams.check.noFormation"));
  noteDropped(extraKeys(f, ["groups"]));
  const groups: TeamGroup[] = [];
  let total = 0;
  let capped = false;
  for (const g of f.groups.slice(0, TEAM_LIMITS.groups)) {
    if (!isObj(g) || !Array.isArray(g.slots)) continue;
    noteDropped(extraKeys(g, GROUP_KEYS));
    const slots: TeamSlot[] = [];
    if (g.slots.length > TEAM_LIMITS.slotsPerGroup) capped = true;
    for (const s of g.slots.slice(0, TEAM_LIMITS.slotsPerGroup)) {
      if (!isObj(s)) continue;
      noteDropped(extraKeys(s, SLOT_KEYS));
      const role = normalizeRole(typeof s.role === "string" ? s.role : null) ?? "";
      const agent = checkAgentKey(s.agent, known);
      if ("reason" in agent) {
        warn(role ? t("teams.check.skippedSlot", { role, reason: agent.reason }) : t("teams.check.skippedSessionSlot", { reason: agent.reason }));
        continue;
      }
      if (total >= TEAM_LIMITS.slots) {
        capped = true;
        continue;
      }
      total++;
      const slot: TeamSlot = { role, agent: agent.key };
      const n = sessionName(s.name);
      if (n) slot.name = n;
      const wk = worktreeKey(s.worktree);
      if (wk) slot.worktree = wk;
      slots.push(slot);
    }
    if (!slots.length) continue;
    const layout = LAYOUTS.includes(g.layout as LayoutPreset) ? (g.layout as LayoutPreset) : "grid";
    // Template content (becomes the group's name): stays English.
    groups.push({ name: cleanText(g.name, TEAM_LIMITS.groupName) || `Group ${groups.length + 1}`, layout, slots });
  }
  if (f.groups.length > TEAM_LIMITS.groups) capped = true;
  if (capped) warn(t("teams.check.capped", { groups: TEAM_LIMITS.groups, perGroup: TEAM_LIMITS.slotsPerGroup, slots: TEAM_LIMITS.slots }));
  if (!groups.length) return fail(t("teams.check.noSessions"));

  const roleKeys = new Set(groups.flatMap((g) => g.slots.map((s) => roleKeyOf(s.role))));
  const ownerTokens = new Set<string>([...roleKeys, "all"]);
  for (const g of groups) for (const s of g.slots) if (s.name) ownerTokens.add(slugify(s.name));

  // prompts (role key → text)
  const prompts: Record<string, string> = {};
  if (isObj(raw.prompts)) {
    let n = 0;
    for (const [k, v] of Object.entries(raw.prompts)) {
      const key = normalizeRole(k);
      if (!key || !roleKeys.has(key)) {
        warn(t("teams.check.promptIgnored", { role: clean1(k) }));
        continue;
      }
      const text = cleanText(v, TEAM_LIMITS.prompt, true);
      if (!text || n >= TEAM_LIMITS.roles) continue;
      prompts[key] = text;
      n++;
    }
  }

  // mission
  const mr = isObj(raw.mission) ? raw.mission : {};
  noteDropped(extraKeys(mr, MISSION_KEYS));
  const tasks: TeamTask[] = [];
  if (Array.isArray(mr.tasks)) {
    if (mr.tasks.length > TEAM_LIMITS.tasks) warn(t("teams.check.tasksKept", { max: TEAM_LIMITS.tasks }));
    for (const task of mr.tasks.slice(0, TEAM_LIMITS.tasks)) {
      const tt = typeof task === "string" ? { text: task, owners: [] } : isObj(task) ? task : null;
      if (!tt) continue;
      if (isObj(task)) noteDropped(extraKeys(task, TASK_KEYS));
      // Owner tokens typed into the text are moved into `owners`; boxes / bullets are stripped.
      const inline: string[] = [];
      const text = cleanText(tt.text, TEAM_LIMITS.taskText)
        .replace(/^(?:[-*+]|\d{1,4}[.)])\s+/, "")
        .replace(/^\[[ xX~\-/!]?\]\s*/, "")
        .replace(/(^|\s)@([A-Za-z0-9][A-Za-z0-9_-]*)/g, (_m, pre: string, o: string) => {
          inline.push(o);
          return pre;
        })
        .replace(/\s{2,}/g, " ")
        .trim();
      if (!text) continue;
      const owners: string[] = [];
      for (const o of [...(Array.isArray(tt.owners) ? tt.owners : []), ...inline]) {
        const slug = slugify(typeof o === "string" ? o.replace(/^@/, "") : "");
        if (!slug || owners.includes(slug)) continue;
        if (!ownerTokens.has(slug) && !ownerTokens.has(slug.replace(/s$/, ""))) {
          warn(t("teams.check.ownerDropped", { owner: clean1(slug) }));
          continue;
        }
        owners.push(slug);
      }
      tasks.push({ text, owners: owners.slice(0, TEAM_LIMITS.owners) });
    }
  }
  const mission: TeamMission = {
    goalHint: cleanText(mr.goalHint, TEAM_LIMITS.goalHint),
    context: cleanText(mr.context, TEAM_LIMITS.context, true),
    tasks,
  };

  // brain notes
  const brain: BrainNote[] = [];
  if (Array.isArray(raw.brain)) {
    if (raw.brain.length > TEAM_LIMITS.notes) warn(t("teams.check.notesKept", { max: TEAM_LIMITS.notes }));
    for (const b of raw.brain.slice(0, TEAM_LIMITS.notes)) {
      if (!isObj(b)) continue;
      noteDropped(extraKeys(b, NOTE_KEYS));
      const title = cleanText(b.title, TEAM_LIMITS.noteTitle);
      const body = cleanText(b.body, TEAM_LIMITS.noteBody, true);
      if (!title || !body) continue;
      brain.push({ title, kind: slugify(typeof b.kind === "string" ? b.kind : "").slice(0, TEAM_LIMITS.noteKind) || "convention", tags: cleanTags(b.tags, TEAM_LIMITS.tags, warn, "noteTags"), body });
    }
  }

  const leadControl: LeadMode = LEAD_MODES.includes(raw.leadControl as LeadMode) ? (raw.leadControl as LeadMode) : "off";
  if (raw.leadControl !== undefined && raw.leadControl !== leadControl) warn(t("teams.check.unknownLead"));

  if (dropped.size) {
    const list = [...dropped];
    warn(t("teams.check.ignoredFields", { fields: `${list.slice(0, 10).join(", ")}${list.length > 10 ? ", …" : ""}` }));
  }
  return {
    template: { format: TEAM_FORMAT, version: TEAM_SCHEMA_VERSION, meta, formation: { groups }, prompts, mission, brain, leadControl },
    errors,
    warnings,
  };
}

/** The file body (2-space JSON, LF, trailing newline). */
export function serializeTeamTemplate(t: TeamTemplate): string {
  return `${JSON.stringify(t, null, 2)}\n`;
}

/** "Feature squad" → "feature-squad.gridkeeper-team.json". */
export function teamTemplateFileName(name: string): string {
  return `${slugify(name).slice(0, 60) || "team"}${TEAM_FILE_SUFFIX}`;
}

// ---- export -------------------------------------------------------------------------------------------

/** Default starter prompt per role (placeholders filled at import). Short and concrete. */
// Agent-facing: stays English (typed into agents / written to files).
export function defaultRolePrompt(role: string): string {
  switch (normalizeRole(role)) {
    case "lead":
      return "You are the lead. The mission is in {mission}. Explore the code enough to plan, then write small tasks under '## Tasks' as '- [ ] task @owner' for: {teammates}. Review finished work before you mark it done. Don't write the code yourself.";
    case "builder":
      return "You are a builder. Read {mission} and take the first '[ ]' task tagged with your name or @builder: mark it '[~]', do it, run the tests, commit on your branch, then mark it '[x]'. If you are blocked, mark it '[!] reason' and take the next one.";
    case "reviewer":
      return "You are the reviewer. Read {mission}. For each task marked '[x]', read the author's branch diff and run the tests. Add problems as '- [ ] fix: … @author' lines; write 'LGTM' under tasks that pass. Don't change code.";
    case "verifier":
      return "You are the verifier. Read {mission}. For each task marked '[x]', run the tests, lint and build on the author's branch. Report failures as '- [ ] fix: … @author' lines. Don't change code.";
    case "scout":
      return "You are a scout. Read {mission} and take tasks tagged with your name or @scout: mark '[~]', investigate, then mark '[x]' with a one-line finding under the task. Don't change code.";
    default:
      return "You are the {role}. Read {mission} and work on tasks tagged with your name or @{role}: mark '[~]' when you start, '[x]' when done, '[!] reason' if blocked. Teammates: {teammates}.";
  }
}

export interface ExportSource {
  name: string;
  description?: string;
  author?: string | null;
  tags?: string[];
  /** Saved formation, or `templateFromWorkspace(...)` of the current workspace. */
  formation: FormationTemplate;
  /** Per-role prompts (role key → text); missing roles get `defaultRolePrompt`. */
  prompts?: Record<string, string>;
  /** Current mission file text: its open tasks become template tasks (owners kept as roles). */
  missionText?: string | null;
  /** Everyone in the source workspace, to turn "@builder-1" into "@builder". */
  team?: { name: string; role: string | null }[];
  /** Absolute mission path / project folder: replaced by {mission} / dropped from prompts. */
  missionPath?: string | null;
  goalHint?: string;
  context?: string;
  brain?: BrainNote[];
  leadControl?: LeadMode;
}

/** Template tasks from a mission file: open tasks (todo / doing / blocked) as todo, owners mapped to roles. */
export function tasksFromMission(missionText: string, team: readonly { name: string; role: string | null }[]): TeamTask[] {
  const byName = new Map(team.map((m) => [slugify(m.name), roleKeyOf(m.role)]));
  const roles = new Set(team.map((m) => roleKeyOf(m.role)));
  const out: TeamTask[] = [];
  for (const t of parseMission(missionText).tasks) {
    if (t.state === "done" || !t.text) continue;
    const owners: string[] = [];
    for (const o of t.owners) {
      const role = roles.has(o) ? o : roles.has(o.replace(/s$/, "")) ? o.replace(/s$/, "") : o === "all" || o === "everyone" || o === "team" ? "all" : byName.get(o);
      if (role && role !== "agent" && !owners.includes(role)) owners.push(role);
    }
    out.push({ text: t.text.replace(/^blocked:\s*/i, ""), owners });
  }
  return out;
}

/** Build a template from a formation (+ prompts / mission / notes). The result is already sanitized. */
export function teamTemplateFrom(src: ExportSource): TemplateCheck {
  const missionPath = src.missionPath?.trim() || null;
  const roleKeys: string[] = [];
  const groups = src.formation.groups.map((g) => ({
    name: g.name,
    layout: g.layout,
    slots: g.slots.map((s) => {
      const role = roleKeyOf(s.role);
      if (!roleKeys.includes(role)) roleKeys.push(role);
      const out: Record<string, unknown> = { role: s.role, agent: s.agent };
      if (s.name) out.name = s.name;
      if (s.worktreeKey) out.worktree = s.worktreeKey;
      return out;
    }),
  }));
  const prompts: Record<string, string> = {};
  for (const r of roleKeys) {
    let text = src.prompts?.[r]?.trim() || defaultRolePrompt(r === "agent" ? "" : r);
    if (missionPath) text = text.split(missionPath).join("{mission}");
    prompts[r] = text;
  }
  const raw = {
    format: TEAM_FORMAT,
    version: TEAM_SCHEMA_VERSION,
    meta: { name: src.name, description: src.description ?? src.formation.description ?? "", author: src.author ?? null, tags: src.tags ?? [], minVersion: TEAM_MIN_APP_VERSION },
    formation: { groups },
    prompts,
    mission: {
      // Template content (written to the file): stays English.
      goalHint: src.goalHint ?? "Describe the goal in one line",
      context: src.context ?? "",
      tasks: src.missionText ? tasksFromMission(src.missionText, src.team ?? []) : [],
    },
    brain: src.brain ?? [],
    leadControl: src.leadControl ?? "off",
  };
  return sanitizeTeamTemplate(raw);
}

// ---- import → plan ------------------------------------------------------------------------------------

/** The formation a template describes (no profiles, args or paths). */
export function formationOf(t: TeamTemplate, id = `team:${slugify(t.meta.name) || "template"}`): FormationTemplate {
  return {
    id,
    name: t.meta.name,
    description: t.meta.description,
    builtin: false,
    groups: t.formation.groups.map((g) => ({
      name: g.name,
      layout: g.layout,
      slots: g.slots.map((s) => ({ role: s.role, agent: s.agent, name: s.name, worktreeKey: s.worktree, args: [] })),
    })),
  };
}

/** `<project>/.gridkeeper/mission.md` with the folder's own separator style. */
export function missionPathFor(projectDir: string): string {
  const dir = projectDir.trim().replace(/[\\/]+$/, "");
  const sep = dir.includes("\\") || !dir.includes("/") ? "\\" : "/";
  return `${dir}${sep}.gridkeeper${sep}mission.md`;
}

export interface PromptContext {
  role: string;
  missionPath: string;
  team: readonly { name: string; role: string | null }[];
}

/** "@lead, @builder-1 (builder), @builder-2 (builder)" — everyone but the role's single member (itself). */
// Agent-facing: stays English (typed into agents / written to files).
export function teammatesText(role: string, team: readonly { name: string; role: string | null }[]): string {
  const key = roleKeyOf(role);
  const same = team.filter((m) => roleKeyOf(m.role) === key).length;
  const list = team
    .filter((m) => !(same === 1 && roleKeyOf(m.role) === key))
    .map((m) => {
      const slug = slugify(m.name);
      const r = normalizeRole(m.role);
      return r && r !== slug ? `@${slug} (${r})` : `@${slug}`;
    });
  return list.length ? list.join(", ") : "no teammates";
}

/** Fill {mission} {teammates} {role}; the result is one line (starter prompts are typed as one line). */
export function renderPrompt(text: string, ctx: PromptContext): string {
  const role = roleKeyOf(ctx.role) === "agent" ? "agent" : roleKeyOf(ctx.role);
  const teammates = teammatesText(ctx.role, ctx.team);
  // Function replacements: a "$" in a path or name is literal text, not a replacement pattern.
  return text
    .replace(/\{mission\}/g, () => ctx.missionPath)
    .replace(/\{teammates\}/g, () => teammates)
    .replace(/\{role\}/g, () => role)
    .replace(/[\r\n]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export type ImportPlanOptions = Omit<PlanInput, "template" | "prompts" | "profileByRole"> & {
  /** Role → profile choice; default: lead gets the first profile, other Claude roles round-robin. */
  profileByRole?: Record<string, string>;
};

/** The PlanInput a template launches with: its formation plus rendered starter prompts. Pure. */
export function teamPlanInput(t: TeamTemplate, opts: ImportPlanOptions): PlanInput {
  const template = formationOf(t);
  const profileByRole: Record<string, string> = {};
  for (const g of template.groups)
    for (const s of g.slots) {
      if (s.agent !== "claude") continue;
      const key = roleKeyOf(s.role);
      profileByRole[key] = opts.profileByRole?.[key] ?? (key === "lead" ? (opts.profiles[0]?.id ?? "") : PROFILE_RR);
    }
  const base: PlanInput = { ...opts, template, prompts: {}, profileByRole };
  // Names come from the planner (role-N), so {teammates} matches the panes that will exist.
  const team = buildFormationPlan(base).groups.flatMap((g) => g.sessions.map((s) => ({ name: s.name, role: s.role })));
  const missionPath = missionPathFor(opts.projectDir);
  const prompts: Record<string, string> = {};
  for (const [role, text] of Object.entries(t.prompts)) prompts[role] = renderPrompt(text, { role, missionPath, team });
  return { ...base, prompts };
}

export function planTeamTemplate(t: TeamTemplate, opts: ImportPlanOptions): FormationPlan {
  return buildFormationPlan(teamPlanInput(t, opts));
}

// ---- mission file -------------------------------------------------------------------------------------

export type MissionChoice = "merge" | "replace" | "skip";

/** "Write the tests @builder @reviewer" lines. */
export function templateTaskLines(t: TeamTemplate): string[] {
  return t.mission.tasks.map((k) => [k.text, ...k.owners.map((o) => `@${o}`)].join(" "));
}

/** A new mission file for the template and the goal the user typed (LF endings). */
export function missionTextFromTemplate(t: TeamTemplate, goal: string): string {
  return newMissionText(cleanText(goal, 200) || t.meta.name, t.mission.context, templateTaskLines(t));
}

/** Add the template's tasks to an existing mission file, skipping tasks whose text is already there. */
export function mergeTemplateTasks(existing: string, t: TeamTemplate): { text: string; added: number } {
  const have = new Set(parseMission(existing).tasks.map((k) => k.text.toLowerCase()));
  let text = existing;
  let added = 0;
  for (const [i, line] of templateTaskLines(t).entries()) {
    if (have.has(t.mission.tasks[i].text.toLowerCase())) continue;
    const next = addTask(text, line);
    if (next !== null) {
      text = next;
      added++;
    }
  }
  return { text, added };
}
