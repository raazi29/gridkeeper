// Skills panel state: Agent Skills discovered on GitHub, reviewed, installed into the active workspace's
// project folder (.claude/skills / .agents/skills). Ephemeral (this run only).
// Network happens only inside ipc.skills* calls the user triggers (opening the panel, switching tab,
// searching, opening a repository or file, checking for an update); nothing here polls or runs in the
// background, and nothing is ever sent to an agent without the user pressing Send in Broadcast.

import { create } from "zustand";
import { notify } from "../actions/notify";
import { errorMessage, ipc } from "../lib/ipc";
import { agentsReading, installToast, pageKey, repoKey } from "../lib/skills";
import type {
  AgentKind,
  InstallResult,
  InstalledSkill,
  RepoSkills,
  SkillFileText,
  SkillInfo,
  SkillRepoPage,
  SkillSort,
  SkillTarget,
  SkillUpdateCheck,
} from "../lib/types";
import { useAttentionUi } from "./attention";
import { actionToast, confirmDialog, useUi } from "./uiStore";

export type SkillsTab = "trending" | "top" | "search" | "paste" | "installed";
export type DiscoverTab = "trending" | "top" | "search";

export type Load<T> = { status: "loading" } | { status: "ok"; data: T } | { status: "error"; error: string };

export interface RepoSelection {
  repo: string;
  ref: string | null;
  /** Skill folder to open once the repository is read (featured entry, /tree/ URL, update). */
  pathHint: string | null;
}

export interface InstalledState {
  projectDir: string;
  status: "loading" | "ok" | "error";
  items: InstalledSkill[];
  error: string | null;
}

/** A workspace agent session, for install targets / toast counts / "message running agents". */
export interface WorkspaceAgent {
  id: string;
  agent: AgentKind;
  live: boolean;
}

export interface SkillsState {
  open: boolean;
  tab: SkillsTab;
  /** Page shown per discover tab (1-based). */
  pageByTab: Record<DiscoverTab, number>;
  /** Last submitted search text and sort. */
  searchQuery: string;
  searchSort: "best" | "stars";
  /** Search results by pageKey(sort, query, page). */
  pages: Record<string, Load<SkillRepoPage>>;
  /** Repository shown in the detail pane. */
  selection: RepoSelection | null;
  /** Inspected repositories by repoKey(repo, ref). */
  repos: Record<string, Load<RepoSkills>>;
  /** Selected skill folder in the selected repository (null = the list of its skills). */
  skillPath: string | null;
  /** Files opened for reading, by `${repo}@${sha}:${path}`. */
  files: Record<string, Load<SkillFileText>>;
  installed: InstalledState | null;
  /** dirRel selected in the Installed tab. */
  installedSel: string | null;
  updateChecks: Record<string, Load<SkillUpdateCheck>>;
  /** Reviewing an update of this installed skill. */
  updating: InstalledSkill | null;
  /** Result of the last install in this review (`${repo}@${sha}:${path}`). */
  lastInstall: { key: string; result: InstallResult } | null;
  busy: boolean;
}

const initial = (): SkillsState => ({
  open: false,
  tab: "trending",
  pageByTab: { trending: 1, top: 1, search: 1 },
  searchQuery: "",
  searchSort: "best",
  pages: {},
  selection: null,
  repos: {},
  skillPath: null,
  files: {},
  installed: null,
  installedSel: null,
  updateChecks: {},
  updating: null,
  lastInstall: null,
  busy: false,
});

export const useSkills = create<SkillsState>()(() => initial());

export function resetSkillsForTests() {
  useSkills.setState(initial(), true);
}

const set = (p: Partial<SkillsState> | ((s: SkillsState) => Partial<SkillsState>)) => useSkills.setState(p);

export const fileKey = (repo: string, sha: string, path: string) => `${repo.toLowerCase()}@${sha}:${path}`;
export const installKey = fileKey;

/** AppError code ("conflict", "not_found", …) of an invoke rejection. */
export function errorCode(e: unknown): string | null {
  return e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : null;
}

// ---- open / tabs -------------------------------------------------------------------------------------

export function openSkills(tab?: SkillsTab) {
  useUi.getState().closePalette();
  set((s) => ({ open: true, tab: tab ?? s.tab }));
}

export function closeSkills() {
  set({ open: false, updating: null });
}

export function toggleSkills() {
  if (useSkills.getState().open) closeSkills();
  else openSkills();
}

export function setSkillsTab(tab: SkillsTab) {
  set((s) => ({ tab, updating: tab === "installed" ? s.updating : null }));
}

export function setDiscoverPage(tab: DiscoverTab, page: number) {
  set((s) => ({ pageByTab: { ...s.pageByTab, [tab]: Math.max(1, page) } }));
}

export function submitSearch(query: string, sort: "best" | "stars") {
  set((s) => ({ searchQuery: query.trim(), searchSort: sort, pageByTab: { ...s.pageByTab, search: 1 } }));
}

// ---- discover ----------------------------------------------------------------------------------------

/** Fetch one page (once; `force` asks again, e.g. after a rate limit). */
export async function loadPage(sort: SkillSort, query: string, page: number, force = false): Promise<void> {
  const key = pageKey(sort, query, page);
  const cur = useSkills.getState().pages[key];
  if (cur?.status === "loading" || (cur?.status === "ok" && !force)) return;
  set((s) => ({ pages: { ...s.pages, [key]: { status: "loading" } } }));
  let next: Load<SkillRepoPage>;
  try {
    next = { status: "ok", data: await ipc.skillsSearch(query.trim(), sort, page) };
  } catch (e) {
    next = { status: "error", error: errorMessage(e) };
  }
  set((s) => ({ pages: { ...s.pages, [key]: next } }));
}

/** Show a repository in the detail pane and read its skills. */
export function selectRepo(repo: string, ref: string | null = null, pathHint: string | null = null) {
  set({ selection: { repo, ref, pathHint }, skillPath: pathHint, lastInstall: null });
  void inspectRepo(repo, ref);
}

export function clearSelection() {
  set({ selection: null, skillPath: null, lastInstall: null, updating: null });
}

export async function inspectRepo(repo: string, ref: string | null, force = false): Promise<void> {
  const key = repoKey(repo, ref);
  const cur = useSkills.getState().repos[key];
  if (cur && (cur.status === "loading" || (cur.status === "ok" && !force))) {
    if (cur.status === "ok") autoSelectSkill(repo, ref, cur.data);
    return;
  }
  set((s) => ({ repos: { ...s.repos, [key]: { status: "loading" } } }));
  let next: Load<RepoSkills>;
  try {
    next = { status: "ok", data: await ipc.skillsInspect(repo, ref) };
  } catch (e) {
    next = { status: "error", error: errorMessage(e) };
  }
  set((s) => ({ repos: { ...s.repos, [key]: next } }));
  if (next.status === "ok") autoSelectSkill(repo, ref, next.data);
}

/** Open the only skill of a repository, or drop a path hint that matches no skill. */
function autoSelectSkill(repo: string, ref: string | null, data: RepoSkills) {
  const s = useSkills.getState();
  if (!s.selection || repoKey(s.selection.repo, s.selection.ref) !== repoKey(repo, ref)) return;
  if (s.skillPath !== null && !data.skills.some((k) => k.path === s.skillPath)) set({ skillPath: null });
  if (useSkills.getState().skillPath === null && data.skills.length === 1) set({ skillPath: data.skills[0].path });
}

export function selectSkill(path: string | null) {
  set({ skillPath: path, lastInstall: null });
}

/** Read one file of a skill at its pinned commit (SKILL.md when not fetched yet, scripts before install). */
export async function loadFile(repo: string, sha: string, path: string): Promise<void> {
  const key = fileKey(repo, sha, path);
  const cur = useSkills.getState().files[key];
  if (cur && cur.status !== "error") return;
  set((s) => ({ files: { ...s.files, [key]: { status: "loading" } } }));
  let next: Load<SkillFileText>;
  try {
    next = { status: "ok", data: await ipc.skillsFile(repo, sha, path) };
  } catch (e) {
    next = { status: "error", error: errorMessage(e) };
  }
  set((s) => ({ files: { ...s.files, [key]: next } }));
}

// ---- installed ---------------------------------------------------------------------------------------

/** Read the project's installed skills (local files only, no network). */
export async function loadInstalled(projectDir: string): Promise<void> {
  set((s) => ({
    installed: { projectDir, status: "loading", items: s.installed?.projectDir === projectDir ? s.installed.items : [], error: null },
  }));
  try {
    const items = await ipc.skillsInstalled(projectDir);
    if (useSkills.getState().installed?.projectDir === projectDir) set({ installed: { projectDir, status: "ok", items, error: null } });
  } catch (e) {
    if (useSkills.getState().installed?.projectDir === projectDir)
      set({ installed: { projectDir, status: "error", items: [], error: errorMessage(e) } });
  }
}

export function selectInstalled(dirRel: string | null) {
  set({ installedSel: dirRel, updating: null, selection: null, skillPath: null, lastInstall: null });
}

/** Compare an installed skill's pinned commit with its repository's default branch (one click = one check). */
export async function checkUpdate(skill: InstalledSkill): Promise<void> {
  const p = skill.provenance;
  if (!p) return;
  const key = skill.dirRel;
  if (useSkills.getState().updateChecks[key]?.status === "loading") return;
  set((s) => ({ updateChecks: { ...s.updateChecks, [key]: { status: "loading" } } }));
  let next: Load<SkillUpdateCheck>;
  try {
    next = { status: "ok", data: await ipc.skillsCheckUpdate(p.repo, p.path, p.commitSha, p.treeSha) };
  } catch (e) {
    next = { status: "error", error: errorMessage(e) };
  }
  set((s) => ({ updateChecks: { ...s.updateChecks, [key]: next } }));
}

/** Review the default branch's version of an installed skill (the same review as a new install). */
export function startUpdate(skill: InstalledSkill) {
  const p = skill.provenance;
  if (!p) return;
  set({ updating: skill, installedSel: skill.dirRel, tab: "installed" });
  selectRepo(p.repo, null, p.path);
}

// ---- install / remove --------------------------------------------------------------------------------

export interface InstallArgs {
  projectDir: string;
  repo: string;
  commitSha: string;
  skill: SkillInfo;
  targets: SkillTarget[];
  /** The user is updating an installed skill: replacing its folder is what they asked for. */
  isUpdate: boolean;
  /** Agent sessions of the workspace (toast count, "Message agents…"). */
  agents: WorkspaceAgent[];
}

/** Hand the running agents to the Broadcast composer (preselected; the user types and sends). */
export function messageAgents(ids: string[]) {
  closeSkills();
  useAttentionUi.getState().openBroadcast(ids);
}

/** Install (asking before replacing existing folders), then toast and refresh the Installed list. */
export async function installSkill(a: InstallArgs): Promise<InstallResult | null> {
  if (useSkills.getState().busy) return null;
  set({ busy: true });
  try {
    let result: InstallResult;
    try {
      result = await ipc.skillsInstall(a.projectDir, a.repo, a.commitSha, a.skill.path, a.targets, a.isUpdate);
    } catch (e) {
      if (errorCode(e) !== "conflict") throw e;
      const ok = await confirmDialog({
        title: `Replace “${a.skill.installName}”?`,
        message: `${errorMessage(e).replace(/^conflict:\s*/i, "")}. Replacing swaps the whole folder for this version; files you added inside it are removed.`,
        confirmLabel: "Replace",
        danger: true,
      });
      if (!ok) return null;
      result = await ipc.skillsInstall(a.projectDir, a.repo, a.commitSha, a.skill.path, a.targets, true);
    }
    set((s) => {
      // An earlier "update available" for these folders is stale now.
      const updateChecks = { ...s.updateChecks };
      for (const dir of result.installed) delete updateChecks[dir];
      return { lastInstall: { key: installKey(a.repo, a.commitSha, a.skill.path), result }, updating: null, updateChecks };
    });
    const readers = agentsReading(a.targets, a.agents);
    const live = readers.filter((r) => r.live).map((r) => r.id);
    const message = installToast(result.name, result.installed, readers.length);
    if (live.length) actionToast({ kind: "info", message, action: { label: "Message agents…", run: () => messageAgents(live) } }, 12000);
    else notify("info", message, 6000);
    if (result.warnings.length) notify("warn", result.warnings.join(" "));
    void loadInstalled(a.projectDir);
    return result;
  } catch (e) {
    notify("error", `Install failed: ${errorMessage(e)}`);
    return null;
  } finally {
    set({ busy: false });
  }
}

/** Delete one installed skill folder after confirmation. */
export async function removeSkill(projectDir: string, skill: InstalledSkill): Promise<boolean> {
  if (useSkills.getState().busy) return false;
  const ok = await confirmDialog({
    title: `Remove “${skill.name}”?`,
    message: `Deletes ${skill.dirRel} from the project folder. Running agents keep what they already loaded until their next session.`,
    detail: skill.dirAbs,
    confirmLabel: "Remove",
    danger: true,
  });
  if (!ok) return false;
  set({ busy: true });
  try {
    await ipc.skillsRemove(projectDir, skill.dirRel);
    notify("info", `Removed ${skill.name} (${skill.dirRel})`);
    set((s) => ({ installedSel: s.installedSel === skill.dirRel ? null : s.installedSel }));
    void loadInstalled(projectDir);
    return true;
  } catch (e) {
    notify("error", `Remove failed: ${errorMessage(e)}`);
    return false;
  } finally {
    set({ busy: false });
  }
}
