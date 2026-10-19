// Formations — execution and saved templates. The plan (actions/formationPlan.ts) is built and shown to
// the user first; `launchFormation` then runs exactly that plan: worktrees one by one (stops at the
// first failure and never deletes anything), then groups, then sessions (with roles), then optional
// starter prompts. Saved formations live in localStorage (best effort, try/catch).

import { isBrowserMeta } from "../lib/browserPanes";
import { errorMessage, ipc } from "../lib/ipc";
import type { WorktreeRef } from "../lib/types";
import { uid, useApp } from "../store/appStore";
import { recordActivity } from "../store/activity";
import { useUi } from "../store/uiStore";
import { notify } from "./notify";
import { newSession } from "./sessions";
import { armStarterPrompt } from "./starterPrompt";
import { sanitizeTemplate, templateFromWorkspace, type FormationPlan, type FormationTemplate, type SnapshotSession } from "./formationPlan";

export interface LaunchResult {
  ok: boolean;
  createdWorktrees: string[];
  sessionIds: string[];
  error?: string;
}

/**
 * A workspace whose only group is empty: the formation's first group reuses (renames) it. With
 * `preferGroupId` ("Launch formation here"), that group is reused whenever it is empty.
 */
export function reusableEmptyGroup(workspaceId: string, preferGroupId?: string | null): { id: string; name: string } | null {
  const ws = useApp.getState().persisted.workspaces.find((w) => w.id === workspaceId);
  const preferred = preferGroupId ? ws?.groups.find((g) => g.id === preferGroupId) : undefined;
  if (preferred && preferred.sessionIds.length === 0) return { id: preferred.id, name: preferred.name };
  if (!ws || ws.groups.length !== 1 || ws.groups[0].sessionIds.length > 0) return null;
  return { id: ws.groups[0].id, name: ws.groups[0].name };
}

function logFormation(level: "info" | "ok" | "error", message: string, result?: string, kind: "formation" | "worktree" = "formation") {
  recordActivity({ sessionId: null, sessionName: "formation", role: null, agent: null, kind, level, message, result });
}

export async function launchFormation(plan: FormationPlan, workspaceId: string, opts: { groupId?: string | null } = {}): Promise<LaunchResult> {
  const createdWorktrees: string[] = [];
  const wt = new Map<string, WorktreeRef>();
  if (plan.errors.length) return { ok: false, createdWorktrees, sessionIds: [], error: plan.errors.join(" ") };

  // 1. Worktrees, sequentially. Stop at the first failure; never delete what was created.
  for (const w of plan.worktrees) {
    if (!plan.repoRoot) break;
    try {
      const info = await ipc.gitWorktreeAdd(plan.repoRoot, w.path, w.branch, true);
      wt.set(w.key, { path: info.path, branch: info.branch ?? w.branch });
      createdWorktrees.push(info.path);
      logFormation("ok", `worktree created: ${info.branch ?? w.branch}`, "created", "worktree");
    } catch (e) {
      const msg = `git worktree add failed for ${w.branch}: ${errorMessage(e)}`;
      logFormation("error", msg, "failed", "worktree");
      const kept = createdWorktrees.length ? ` Already created (kept, not deleted): ${createdWorktrees.join(", ")}.` : "";
      notify("error", `Formation stopped. ${msg}.${kept} No groups or sessions were created.`);
      return { ok: false, createdWorktrees, sessionIds: [], error: msg };
    }
  }

  // 2. Groups (the first may reuse an empty lone group), 3. sessions.
  const app = useApp.getState();
  const reuse = reusableEmptyGroup(workspaceId, opts.groupId);
  const sessionIds: string[] = [];
  let firstGroupId: string | null = null;
  plan.groups.forEach((g, gi) => {
    let groupId: string;
    if (gi === 0 && reuse) {
      groupId = reuse.id;
      app.renameGroup(groupId, g.name);
    } else groupId = useApp.getState().createGroup(workspaceId, g.name);
    firstGroupId ??= groupId;
    useApp.getState().updateLayout(groupId, { preset: g.layout, maximized: null });
    for (const s of g.sessions) {
      const worktree = s.worktreeKey ? (wt.get(s.worktreeKey) ?? null) : null;
      const id = newSession({
        groupId,
        agent: s.agent,
        cwd: s.cwd,
        name: s.name,
        profileId: s.profileId,
        preset: s.preset,
        command: s.command,
        args: s.args,
        worktree,
        role: s.role,
      });
      sessionIds.push(id);
      if (s.prompt) armStarterPrompt(id, s.prompt);
    }
  });
  if (firstGroupId) {
    useApp.getState().setActiveGroup(workspaceId, firstGroupId);
    useUi.getState().markVisited(workspaceId);
  }
  logFormation(
    "ok",
    `formation “${plan.name}” launched: ${plan.groups.length} group${plan.groups.length === 1 ? "" : "s"}, ${sessionIds.length} sessions`,
    `${sessionIds.length} sessions`,
  );
  return { ok: true, createdWorktrees, sessionIds };
}

// ---- saved formations (localStorage) ---------------------------------------------------------

const LS_KEY = "gridkeeper.formations.v1";

export function loadSavedFormations(): FormationTemplate[] {
  try {
    const raw = globalThis.localStorage?.getItem(LS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr.map(sanitizeTemplate).filter((t): t is FormationTemplate => !!t);
  } catch {
    return [];
  }
}

function writeSaved(list: FormationTemplate[]): boolean {
  try {
    globalThis.localStorage?.setItem(LS_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

/** Snapshot the workspace's groups / roles / agents / accounts (no prompts, env or conversation ids). */
export function saveWorkspaceAsFormation(workspaceId: string, name: string): FormationTemplate | null {
  const ws = useApp.getState().persisted.workspaces.find((w) => w.id === workspaceId);
  const t = workspaceFormation(workspaceId, name);
  if (!ws || !t) return null;
  if (!t.groups.length) {
    notify("info", "This workspace has no sessions to save");
    return null;
  }
  const list = [...loadSavedFormations().filter((x) => x.name !== t.name), t];
  if (!writeSaved(list)) {
    notify("error", "Could not save the formation (storage unavailable)");
    return null;
  }
  logFormation("info", `saved workspace “${ws.name}” as formation “${t.name}”`, "saved");
  return t;
}

/** The workspace's layout as a formation template (also used by team template export). */
export function workspaceFormation(workspaceId: string, name: string): FormationTemplate | null {
  const s = useApp.getState();
  const ws = s.persisted.workspaces.find((w) => w.id === workspaceId);
  if (!ws) return null;
  const metas = new Map(s.persisted.sessions.map((m) => [m.id, m]));
  const groups = ws.groups.map((g) => ({
    name: g.name,
    layout: g.layout.preset,
    sessions: g.sessionIds
      .map((id) => metas.get(id))
      .filter((m): m is NonNullable<typeof m> => !!m && !isBrowserMeta(m))
      .map(
        (m): SnapshotSession => ({
          name: m.name,
          role: m.role ?? null,
          agent: m.agent,
          preset: m.preset ?? null,
          command: m.command,
          args: m.args,
          profileId: m.profileId,
          hasWorktree: !!m.worktree,
        }),
      ),
  }));
  return templateFromWorkspace(name, groups, uid());
}

export function deleteSavedFormation(id: string): FormationTemplate[] {
  const list = loadSavedFormations().filter((t) => t.id !== id);
  writeSaved(list);
  return list;
}
