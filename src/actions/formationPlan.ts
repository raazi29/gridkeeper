// Formations (team templates) — pure planning. A template (built-in or saved) plus the dialog's options
// becomes a FormationPlan: the exact groups, sessions and `git worktree add` commands that WILL be run.
// Nothing here touches the store or IPC (unit-tested in node); execution lives in actions/formations.ts.

import type { AgentKind, LayoutPreset } from "../lib/types";
import { normalizeRole } from "../lib/roles";
import { defaultWorktreePath, isValidBranchName } from "../components/util/text";

/** "claude" | "codex" | "powershell" | "preset:<catalog id>" | "command:<executable>" */
export type AgentKey = string;

export interface SlotTemplate {
  role: string;
  agent: AgentKey;
  /** Explicit session name (saved formations); otherwise derived from the role. */
  name?: string;
  /** Slots sharing a key share ONE new worktree; undefined = work in the project folder. */
  worktreeKey?: string;
  /** Saved formations remember the Claude profile per session. */
  profileId?: string | null;
  args?: string[];
}

export interface GroupTemplate {
  name: string;
  layout: LayoutPreset;
  slots: SlotTemplate[];
}

export interface FormationTemplate {
  id: string;
  name: string;
  description: string;
  builtin: boolean;
  groups: GroupTemplate[];
}

export type BuiltinFormationId = "pbv" | "pair" | "swarm";

export interface BuiltinParams {
  /** Plan · Build · Verify: number of builders (1..8). */
  builders: number;
  builderAgent: "claude" | "codex";
  /** Plan · Build · Verify: add a Claude verifier next to the Codex reviewer. */
  verifier: boolean;
  /** Scout swarm: number of scouts (1..16). */
  scouts: number;
  scoutAgent: AgentKey;
}

export const DEFAULT_PARAMS: BuiltinParams = { builders: 3, builderAgent: "claude", verifier: true, scouts: 4, scoutAgent: "claude" };
export const MAX_BUILDERS = 8;

/** Key used for naming, per-role accounts and prompts; slots without a role share "agent". */
export function roleKeyOf(role: string | null | undefined): string {
  return normalizeRole(role) ?? "agent";
}
export const MAX_SCOUTS = 16;

export const BUILTIN_FORMATIONS: { id: BuiltinFormationId; name: string; description: string }[] = [
  { id: "pbv", name: "Plan · Build · Verify", description: "A Claude lead plans, N builders implement (each in its own worktree), a Codex reviewer (+ optional Claude verifier) checks." },
  { id: "pair", name: "Pair", description: "One Claude builder and one Codex reviewer side by side, sharing one worktree." },
  { id: "swarm", name: "Scout swarm", description: "N lightweight scouts exploring in parallel in the project folder (read-only by convention)." },
];

const clampInt = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(Number.isFinite(n) ? n : lo)));

export function builtinTemplate(id: BuiltinFormationId, p: BuiltinParams): FormationTemplate {
  const meta = BUILTIN_FORMATIONS.find((f) => f.id === id)!;
  const base = { id, name: meta.name, description: meta.description, builtin: true };
  if (id === "pair")
    return {
      ...base,
      groups: [
        {
          name: "Pair",
          layout: "columns",
          slots: [
            { role: "builder", agent: "claude", worktreeKey: "pair" },
            { role: "reviewer", agent: "codex", worktreeKey: "pair" },
          ],
        },
      ],
    };
  if (id === "swarm") {
    const n = clampInt(p.scouts, 1, MAX_SCOUTS);
    return { ...base, groups: [{ name: "Scouts", layout: "grid", slots: Array.from({ length: n }, () => ({ role: "scout", agent: p.scoutAgent })) }] };
  }
  const n = clampInt(p.builders, 1, MAX_BUILDERS);
  const verify: SlotTemplate[] = [{ role: "reviewer", agent: "codex" }];
  if (p.verifier) verify.push({ role: "verifier", agent: "claude" });
  return {
    ...base,
    groups: [
      { name: "Plan", layout: "grid", slots: [{ role: "lead", agent: "claude" }] },
      { name: "Build", layout: "grid", slots: Array.from({ length: n }, (_, i) => ({ role: "builder", agent: p.builderAgent, worktreeKey: `builder-${i + 1}` })) },
      { name: "Verify", layout: "columns", slots: verify },
    ],
  };
}

export function parseAgentKey(key: AgentKey): { agent: AgentKind; preset: string | null; command: string | null } {
  if (key.startsWith("preset:")) return { agent: "generic", preset: key.slice(7) || null, command: null };
  if (key.startsWith("command:")) return { agent: "generic", preset: null, command: key.slice(8) || null };
  if (key === "claude" || key === "codex" || key === "powershell") return { agent: key, preset: null, command: null };
  return { agent: "generic", preset: null, command: null };
}

// ---- plan -------------------------------------------------------------------------------

/** Per-role Claude profile choice: a profile id, "" = Claude's default config, "rr" = round-robin, "saved" = per-slot saved profile. */
export type ProfileChoice = string;
export const PROFILE_RR = "rr";
export const PROFILE_SAVED = "saved";
const RR_PENDING = "\u0000rr";

export interface PlanInput {
  template: FormationTemplate;
  projectDir: string;
  /** Git repository root, or null when the project folder is not a repo. */
  repoRoot: string | null;
  useWorktrees: boolean;
  /** e.g. "gk/" */
  branchPrefix: string;
  /** Timestamp segment that keeps branch names unique per launch, e.g. "1017-1530". */
  stamp: string;
  profiles: { id: string; name: string }[];
  profileByRole: Record<string, ProfileChoice>;
  prompts: Record<string, string>;
  existingWorktrees: { path: string; branch: string | null }[];
  /** Live Claude sessions per profile id ("" = default profile), to warn about shared profiles. */
  liveProfileUse: Record<string, number>;
}

export interface PlannedSession {
  name: string;
  /** null = no role (saved sessions that never had one). */
  role: string | null;
  agent: AgentKind;
  preset: string | null;
  command: string | null;
  args: string[];
  profileId: string | null;
  profileName: string | null;
  worktreeKey: string | null;
  /** Directory the session starts in (the worktree path when it has one). */
  cwd: string;
  prompt: string | null;
}

export interface PlannedWorktree {
  key: string;
  branch: string;
  path: string;
  /** Exactly what will run (shown in the confirmation). */
  command: string;
}

export interface PlannedGroup {
  name: string;
  layout: LayoutPreset;
  sessions: PlannedSession[];
}

export interface FormationPlan {
  name: string;
  repoRoot: string | null;
  groups: PlannedGroup[];
  worktrees: PlannedWorktree[];
  warnings: string[];
  errors: string[];
  sessionCount: number;
}

/** Branch for a worktree key: `<prefix><stamp>/<key>`, e.g. "gk/1017-1530/builder-1". */
export function formationBranch(prefix: string, stamp: string, key: string): string {
  const p = prefix.trim();
  const s = stamp.trim();
  return `${p}${s ? `${s}/` : ""}${key}`;
}

/** Local timestamp for branch names: MMDD-HHmm. */
export function formationStamp(d: Date): string {
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}`;
}

const SHARED_PROFILE_NOTE = "Concurrent token refreshes in one profile can force a re-login (Claude Code #91708).";

export function buildFormationPlan(input: PlanInput): FormationPlan {
  const errors: string[] = [];
  const warnings: string[] = [];
  const projectDir = input.projectDir.trim();
  if (!projectDir) errors.push("Choose a project folder.");
  const wantsWorktrees = input.useWorktrees && input.template.groups.some((g) => g.slots.some((s) => s.worktreeKey));
  if (wantsWorktrees && !input.repoRoot) errors.push("Worktrees need the project folder to be a Git repository.");
  const prefix = input.branchPrefix.trim();
  if (prefix && /[\s~^:?*\[\\]|\.\.|@\{/.test(prefix)) errors.push(`Branch prefix “${prefix}” contains characters Git does not allow.`);

  // Session names: role, or role-N when the role occurs more than once.
  const roleTotals = new Map<string, number>();
  for (const g of input.template.groups) for (const s of g.slots) {
    const r = roleKeyOf(s.role);
    roleTotals.set(r, (roleTotals.get(r) ?? 0) + 1);
  }
  const roleSeen = new Map<string, number>();

  // Worktrees (one per distinct key, in slot order).
  const worktrees: PlannedWorktree[] = [];
  const wtByKey = new Map<string, PlannedWorktree>();
  const existingPaths = new Set(input.existingWorktrees.map((w) => w.path.replace(/[\\/]+$/, "").toLowerCase()));
  const existingBranches = new Set(input.existingWorktrees.map((w) => w.branch).filter((b): b is string => !!b));

  const profileName = (id: string | null) => (id ? (input.profiles.find((p) => p.id === id)?.name ?? null) : null);
  const resolveProfile = (role: string, slot: SlotTemplate): string | null => {
    const choice = input.profileByRole[role] ?? PROFILE_RR;
    if (choice === PROFILE_SAVED) {
      const id = slot.profileId ?? null;
      if (id && !input.profiles.some((p) => p.id === id)) {
        warnings.push(`A saved Claude profile no longer exists; “${slot.name ?? role}” uses the default profile.`);
        return null;
      }
      return id;
    }
    if (choice === PROFILE_RR) return RR_PENDING; // assigned after explicit choices are known
    if (choice && !input.profiles.some((p) => p.id === choice)) return null;
    return choice || null;
  };

  const groups: PlannedGroup[] = input.template.groups.map((g) => ({
    name: g.name.trim() || "Group",
    layout: g.layout,
    sessions: g.slots.map((slot) => {
      const role = roleKeyOf(slot.role);
      const n = (roleSeen.get(role) ?? 0) + 1;
      roleSeen.set(role, n);
      const { agent, preset, command } = parseAgentKey(slot.agent);
      if (agent === "generic" && !preset && !command) errors.push(`Unknown agent “${slot.agent}” for ${role}.`);
      let worktreeKey: string | null = null;
      let cwd = projectDir;
      if (wantsWorktrees && input.repoRoot && slot.worktreeKey) {
        worktreeKey = slot.worktreeKey;
        let wt = wtByKey.get(worktreeKey);
        if (!wt) {
          const branch = formationBranch(prefix, input.stamp, worktreeKey);
          const path = defaultWorktreePath(input.repoRoot, branch);
          wt = { key: worktreeKey, branch, path, command: `git worktree add -b ${branch} "${path}"` };
          if (!isValidBranchName(branch)) errors.push(`Invalid branch name “${branch}”.`);
          if (existingBranches.has(branch)) errors.push(`Branch “${branch}” is already checked out in a worktree.`);
          if (existingPaths.has(path.toLowerCase())) errors.push(`A worktree already exists at ${path}.`);
          wtByKey.set(worktreeKey, wt);
          worktrees.push(wt);
        }
        cwd = wt.path;
      }
      const profileId = agent === "claude" ? resolveProfile(role, slot) : null;
      const prompt = input.prompts[role]?.trim() || null;
      return {
        name: slot.name?.trim() || ((roleTotals.get(role) ?? 0) > 1 ? `${role}-${n}` : role),
        role: normalizeRole(slot.role),
        agent,
        preset,
        command,
        args: slot.args ?? [],
        profileId,
        profileName: agent === "claude" ? (profileName(profileId) ?? "default") : null,
        worktreeKey,
        cwd,
        prompt,
      };
    }),
  }));

  // Round-robin slots: each goes to the least-used profile so far (explicit choices and already-live
  // sessions count), ties in profile order — spreads load across accounts and avoids shared profiles.
  const usage = new Map<string, number>(input.profiles.map((p) => [p.id, input.liveProfileUse[p.id] ?? 0]));
  const all = groups.flatMap((g) => g.sessions);
  for (const s of all) if (s.profileId && s.profileId !== RR_PENDING && usage.has(s.profileId)) usage.set(s.profileId, (usage.get(s.profileId) ?? 0) + 1);
  for (const s of all) {
    if (s.profileId !== RR_PENDING) continue;
    let best: string | null = null;
    for (const p of input.profiles) if (best === null || (usage.get(p.id) ?? 0) < (usage.get(best) ?? 0)) best = p.id;
    s.profileId = best;
    s.profileName = profileName(best) ?? "default";
    if (best) usage.set(best, (usage.get(best) ?? 0) + 1);
  }

  // Duplicate paths inside the plan (two keys flattening to the same folder).
  const seenPath = new Set<string>();
  for (const w of worktrees) {
    const k = w.path.toLowerCase();
    if (seenPath.has(k)) errors.push(`Two worktrees would use the same folder: ${w.path}`);
    seenPath.add(k);
  }

  // Shared Claude profiles (plan + already-live sessions).
  const use = new Map<string, number>();
  for (const g of groups) for (const s of g.sessions) if (s.agent === "claude") use.set(s.profileId ?? "", (use.get(s.profileId ?? "") ?? 0) + 1);
  for (const [id, planned] of use) {
    const total = planned + (input.liveProfileUse[id] ?? 0);
    if (total > 1) warnings.push(`Claude profile “${profileName(id || null) ?? "default"}” would run in ${total} concurrent sessions. ${SHARED_PROFILE_NOTE}`);
  }

  const sessionCount = groups.reduce((n, g) => n + g.sessions.length, 0);
  if (sessionCount === 0) errors.push("This formation has no sessions.");
  return { name: input.template.name, repoRoot: input.repoRoot, groups, worktrees, warnings, errors, sessionCount };
}

/** The confirmation text: every group, session and git command, in execution order. */
export function describePlan(plan: FormationPlan): string {
  const lines: string[] = [];
  if (plan.worktrees.length && plan.repoRoot) {
    lines.push(`# ${plan.worktrees.length} new worktree${plan.worktrees.length === 1 ? "" : "s"} (run one by one; stops at the first failure)`);
    lines.push(`cd "${plan.repoRoot}"`);
    for (const w of plan.worktrees) lines.push(w.command);
    lines.push("");
  }
  for (const g of plan.groups) {
    lines.push(`# group “${g.name}” (${g.layout})`);
    for (const s of g.sessions) {
      const agent = s.agent === "generic" ? (s.preset ?? s.command ?? "command") : s.agent;
      const bits = [`${s.name.padEnd(12)} ${agent}`];
      if (s.profileName) bits.push(`account ${s.profileName}`);
      bits.push(s.worktreeKey ? `in worktree ${plan.worktrees.find((w) => w.key === s.worktreeKey)?.branch ?? s.worktreeKey}` : `in ${s.cwd}`);
      if (s.prompt) bits.push("starter prompt once it is idle");
      lines.push(`  ${bits.join(" · ")}`);
    }
  }
  return lines.join("\n");
}

// ---- saved formations ---------------------------------------------------------------------

export interface SnapshotSession {
  name: string;
  role: string | null;
  agent: AgentKind;
  preset: string | null;
  command: string | null;
  args: string[];
  profileId: string | null;
  hasWorktree: boolean;
}

/** Template from an existing workspace layout (no prompts, no env, no conversation ids). */
export function templateFromWorkspace(name: string, groups: { name: string; layout: LayoutPreset; sessions: SnapshotSession[] }[], id: string): FormationTemplate {
  let wt = 0;
  return {
    id,
    name: name.trim() || "Saved formation",
    description: `${groups.length} group${groups.length === 1 ? "" : "s"}, ${groups.reduce((n, g) => n + g.sessions.length, 0)} sessions`,
    builtin: false,
    groups: groups
      .filter((g) => g.sessions.length > 0)
      .map((g) => ({
        name: g.name,
        layout: g.layout,
        slots: g.sessions.map((s) => ({
          role: normalizeRole(s.role) ?? "",
          agent: s.agent === "generic" ? (s.preset ? `preset:${s.preset}` : `command:${s.command ?? ""}`) : s.agent,
          name: s.name,
          worktreeKey: s.hasWorktree ? `wt-${++wt}` : undefined,
          profileId: s.agent === "claude" ? s.profileId : undefined,
          args: s.args,
        })),
      })),
  };
}

/** Validate a template read back from localStorage (untrusted shape). */
export function sanitizeTemplate(raw: unknown): FormationTemplate | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Partial<FormationTemplate>;
  if (typeof t.id !== "string" || typeof t.name !== "string" || !Array.isArray(t.groups)) return null;
  const layouts: LayoutPreset[] = ["grid", "columns", "rows"];
  const groups: GroupTemplate[] = [];
  for (const g of t.groups as unknown[]) {
    if (!g || typeof g !== "object") continue;
    const gg = g as Partial<GroupTemplate>;
    if (typeof gg.name !== "string" || !Array.isArray(gg.slots)) continue;
    const slots: SlotTemplate[] = [];
    for (const s of gg.slots as unknown[]) {
      if (!s || typeof s !== "object") continue;
      const ss = s as Partial<SlotTemplate>;
      if (typeof ss.agent !== "string") continue;
      slots.push({
        role: normalizeRole(typeof ss.role === "string" ? ss.role : null) ?? "",
        agent: ss.agent,
        name: typeof ss.name === "string" ? ss.name.slice(0, 80) : undefined,
        worktreeKey: typeof ss.worktreeKey === "string" ? ss.worktreeKey.replace(/[^a-z0-9-]/gi, "").slice(0, 32) || undefined : undefined,
        profileId: typeof ss.profileId === "string" ? ss.profileId : null,
        args: Array.isArray(ss.args) ? ss.args.filter((a): a is string => typeof a === "string") : [],
      });
    }
    if (slots.length) groups.push({ name: gg.name.slice(0, 60), layout: layouts.includes(gg.layout as LayoutPreset) ? (gg.layout as LayoutPreset) : "grid", slots });
  }
  if (!groups.length) return null;
  return { id: t.id, name: t.name.slice(0, 80), description: typeof t.description === "string" ? t.description.slice(0, 200) : "", builtin: false, groups };
}
