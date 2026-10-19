// Typed wrappers around Tauri commands. The only module that calls `invoke`.

import { Channel, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  Account,
  AccountAgentInfo,
  AccountsSnapshot,
  AgentAvailability,
  AgentKind,
  BranchSummary,
  BranchFiles,
  MissionChanged,
  MissionFile,
  OutboxDisposition,
  OutboxItem,
  PlannedHome,
  ClaudeProfile,
  Diagnostics,
  FileDiff,
  FrameProbe,
  GitInfo,
  RepoChanges,
  SessionPorts,
  PathInfo,
  PersistedState,
  ProfileStatus,
  ReplayAppend,
  ReplayExportKind,
  ReplayInfo,
  ReplaySaveTarget,
  SessionId,
  SessionAttention,
  SessionInfo,
  SessionMeter,
  SessionSpec,
  WorktreeInfo,
} from "./types";
import { EVT_MISSION_CHANGED, EVT_SESSION_ATTENTION, EVT_SESSION_METER, EVT_SESSION_STATE } from "./types";
// Skills
import type { InstallResult, InstalledSkill, RepoSkills, SkillFileText, SkillRepoPage, SkillSort, SkillTarget, SkillUpdateCheck } from "./types";
// Brain
import type { BrainHit, BrainIndex, BrainNoteFile, BrainShare } from "./types";

export interface AppInfo {
  version: string;
  windowsBuild: number | null;
  /** Host OS (absent from older backends; `lib/platform.ts` detects it from navigator too). */
  os?: "windows" | "macos" | "linux";
  bench: string | null;
  benchScriptsDir: string | null;
  /** GRIDKEEPER_SANDBOX name when this is an isolated test instance (own data folder, no single-instance lock). */
  sandbox: string | null;
}

export const ipc = {
  sessionStart: (spec: SessionSpec) => invoke<SessionInfo>("session_start", { spec }),
  /** Output arrives on `channel` as ArrayBuffer frames (see FRAME_* in types). */
  sessionAttach: (id: SessionId, channel: Channel<ArrayBuffer>) =>
    invoke<SessionInfo>("session_attach", { id, channel }),
  sessionDetach: (id: SessionId) => invoke<void>("session_detach", { id }),
  sessionWrite: (id: SessionId, data: string) => invoke<void>("session_write", { id, data }),
  /** Raw bytes (xterm onBinary). */
  sessionWriteBinary: (id: SessionId, data: number[]) => invoke<void>("session_write_binary", { id, data }),
  sessionResize: (id: SessionId, cols: number, rows: number) =>
    invoke<void>("session_resize", { id, cols, rows }),
  sessionAck: (id: SessionId, bytes: number) => invoke<void>("session_ack", { id, bytes }),
  sessionStop: (id: SessionId, force: boolean) => invoke<void>("session_stop", { id, force }),
  sessionList: () => invoke<SessionInfo[]>("session_list"),
  sessionOutputText: (id: SessionId) => invoke<string>("session_output_text", { id }),
  /** Plain text of roughly the last `maxBytes` of buffered output (cheap; for previews). */
  sessionOutputTail: (id: SessionId, maxBytes: number) => invoke<string>("session_output_tail", { id, maxBytes }),
  sessionClearBuffer: (id: SessionId) => invoke<void>("session_clear_buffer", { id }),
  sessionRemove: (id: SessionId) => invoke<void>("session_remove", { id }),

  stateLoad: () => invoke<PersistedState>("state_load"),
  stateSave: (state: PersistedState) => invoke<void>("state_save", { state }),

  profilesList: () => invoke<ClaudeProfile[]>("profiles_list"),
  profileCreate: (name: string, configDir: string | null, color: string | null) =>
    invoke<ClaudeProfile>("profile_create", { name, configDir, color }),
  profileUpdate: (profile: ClaudeProfile) => invoke<ClaudeProfile>("profile_update", { profile }),
  profileDelete: (id: string) => invoke<void>("profile_delete", { id }),
  /** Works for an account of any agent. */
  profileCheck: (id: string) => invoke<ProfileStatus>("profile_check", { id }),

  // Accounts of every agent. profileUpdate / profileDelete / profileCheck accept any account id.
  accountsList: () => invoke<AccountsSnapshot>("accounts_list"),
  /** Detect new homes and verify every account with the agent's own status command (slow: up to ~15 s). */
  accountsScan: () => invoke<AccountsSnapshot>("accounts_scan"),
  accountsSpecs: () => invoke<AccountAgentInfo[]>("accounts_specs"),
  accountsPlanHome: (agent: AgentKind, preset: string | null, name: string) =>
    invoke<PlannedHome>("accounts_plan_home", { agent, preset, name }),
  accountsCreate: (agent: AgentKind, preset: string | null, name: string, useExisting: boolean, homeDir: string | null, color: string | null) =>
    invoke<Account>("accounts_create", { agent, preset, name, useExisting, homeDir, color }),
  accountsRestoreDismissed: () => invoke<void>("accounts_restore_dismissed"),

  agentsDetect: () => invoke<AgentAvailability[]>("agents_detect"),
  pathInfo: (path: string) => invoke<PathInfo>("path_info", { path }),
  gitInfo: (path: string) => invoke<GitInfo>("git_info", { path }),
  gitWorktreeAdd: (repo: string, path: string, branch: string, newBranch: boolean) =>
    invoke<WorktreeInfo>("git_worktree_add", { repo, path, branch, newBranch }),

  // Read-only Changes panel.
  gitChanges: (path: string) => invoke<RepoChanges>("git_changes", { path }),
  gitDiff: (repo: string, file: string, staged: boolean, untracked: boolean) =>
    invoke<FileDiff>("git_diff", { repo, file, staged, untracked }),
  /** Branch vs base (ahead/behind, shortstat, uncommitted count, last commit). base null = main worktree branch. */
  gitBranchSummary: (path: string, base: string | null) => invoke<BranchSummary>("git_branch_summary", { path, base }),

  // Mission file: <projectDir>/.gridkeeper/mission.md (shared task board every agent can edit).
  missionRead: (projectDir: string) => invoke<MissionFile>("mission_read", { projectDir }),
  /** Atomic write; creates .gridkeeper/ (with a self-ignoring .gitignore). Rejects with code "conflict" when the
   *  file changed since `expectedModifiedMs` (null = must not exist yet, undefined = no check). */
  missionWrite: (projectDir: string, text: string, expectedModifiedMs?: number | null) =>
    invoke<MissionFile>("mission_write", { projectDir, text, expectedModifiedMs, checkExpected: expectedModifiedMs !== undefined }),
  /** Ref-counted filesystem watch (no polling) emitting EVT_MISSION_CHANGED. Pair every watch with an unwatch. */
  missionWatch: (projectDir: string) => invoke<void>("mission_watch", { projectDir }),
  missionUnwatch: (projectDir: string) => invoke<void>("mission_unwatch", { projectDir }),
  /** Listening TCP ports per running session. Call only while a view shows ports (or once per activity change). */
  portsList: () => invoke<SessionPorts[]>("ports_list"),
  browserProbe: (url: string) => invoke<FrameProbe>("browser_probe", { url }),
  /** Opens (or navigates + focuses `label`) a pop-out browser window; returns its label. */
  browserOpenWindow: (url: string, label: string | null) => invoke<string>("browser_open_window", { url, label }),
  browserCloseWindow: (label: string) => invoke<boolean>("browser_close_window", { label }),
  browserDevtools: (label: string) => invoke<void>("browser_devtools", { label }),

  diagnosticsSnapshot: () => invoke<Diagnostics>("diagnostics_snapshot"),
  diagnosticsExport: (frontend: unknown) => invoke<string>("diagnostics_export", { frontend }),
  appInfo: () => invoke<AppInfo>("app_info"),
  log: (level: "info" | "warn" | "error", message: string) =>
    invoke<void>("log_frontend", { level, message }).catch(() => {}),

  // Committed work of a worktree's branch vs a base (read-only; base null = the main worktree's branch).
  gitBranchFiles: (path: string, base: string | null) => invoke<BranchFiles>("git_branch_files", { path, base }),
  /** One file's diff over `base...HEAD`; pass a rename's `origFile` so git pairs the rename. */
  gitBranchFileDiff: (path: string, base: string, file: string, origFile: string | null = null) =>
    invoke<FileDiff>("git_branch_file_diff", { path, base, file, origFile }),

  // Lead control: <projectDir>/.gridkeeper/outbox/ (instruction files any agent creates) + team.md (generated).
  /** Instruction files directly in the outbox (.md / .txt), oldest first, at most 50 × 16 KiB. Missing folder = []. */
  missionOutboxList: (projectDir: string) => invoke<OutboxItem[]>("mission_outbox_list", { projectDir }),
  /** Move a handled file to outbox/sent/ or outbox/dismissed/ (a name clash gets "-<n>"). Rejects with code
   *  "not_found" when the file is gone. Returns the archived path. */
  missionOutboxArchive: (projectDir: string, name: string, disposition: OutboxDisposition) =>
    invoke<string>("mission_outbox_archive", { projectDir, name, disposition }),
  /** Atomic write of .gridkeeper/team.md (redacted by the host, <= 256 KiB; never emits mission-changed). */
  missionTeamWrite: (projectDir: string, text: string) => invoke<void>("mission_team_write", { projectDir, text }),
  // Skills: Agent Skills from GitHub. Rust does all network (curl.exe, user-initiated only, 10-minute cache);
  // installs go into the project's .claude/skills / .agents/skills, never into agent homes. Nothing is executed.
  /** One page of skill repositories. `query` is required for "best" / "stars"; rate limits return `rateLimited`. */
  skillsSearch: (query: string, sort: SkillSort, page = 1) => invoke<SkillRepoPage>("skills_search", { query, sort, page }),
  /** Skills of `repo` (owner/name) at `gitRef` (default branch when null), pinned to a commit SHA. */
  skillsInspect: (repo: string, gitRef: string | null = null) => invoke<RepoSkills>("skills_inspect", { repo, gitRef }),
  /** One file at a pinned commit (text up to 256 KiB), for review before install. */
  skillsFile: (repo: string, commitSha: string, path: string) => invoke<SkillFileText>("skills_file", { repo, commitSha, path }),
  /** Rejects with code "conflict" when a target folder exists and `replace` is false. */
  skillsInstall: (projectDir: string, repo: string, commitSha: string, skillPath: string, targets: SkillTarget[], replace: boolean) =>
    invoke<InstallResult>("skills_install", { projectDir, repo, commitSha, skillPath, targets, replace }),
  skillsInstalled: (projectDir: string) => invoke<InstalledSkill[]>("skills_installed", { projectDir }),
  /** `targetDirRel` = InstalledSkill.dirRel (".claude/skills/<name>" or ".agents/skills/<name>" only). */
  skillsRemove: (projectDir: string, targetDirRel: string) => invoke<void>("skills_remove", { projectDir, targetDirRel }),
  skillsCheckUpdate: (repo: string, skillPath: string, commitSha: string, treeSha: string | null) =>
    invoke<SkillUpdateCheck>("skills_check_update", { repo, skillPath, commitSha, treeSha }),
  // Replay: mission recordings in <projectDir>/.gridkeeper/replay/*.jsonl and export saves.
  /** Append JSON-object lines (name `^[A-Za-z0-9._-]+\.jsonl$`). `full` = the 5 MB cap was hit; nothing written. */
  replayAppend: (projectDir: string, fileName: string, lines: string[]) =>
    invoke<ReplayAppend>("replay_append", { projectDir, fileName, lines }),
  replayList: (projectDir: string) => invoke<ReplayInfo[]>("replay_list", { projectDir }),
  replayRead: (projectDir: string, name: string) => invoke<string>("replay_read", { projectDir, name }),
  replayDelete: (projectDir: string, name: string) => invoke<void>("replay_delete", { projectDir, name }),
  /** Native save dialog (run by Rust); null when cancelled. The token authorizes one replaySaveFile to that path. */
  replaySaveDialog: (defaultName: string, kind: ReplayExportKind) =>
    invoke<ReplaySaveTarget | null>("replay_save_dialog", { defaultName, kind }),
  /** Raw binary body (no JSON number[]: a 20 MB video stays 20 MB on the wire). Returns the written path. */
  replaySaveFile: (token: string, bytes: Uint8Array) =>
    invoke<string>("replay_save_file", bytes, { headers: { "x-replay-token": token } }),
  // Meter: Claude Code cost & context per pane (status line JSON; live updates via onSessionMeter).
  meterSnapshot: () => invoke<SessionMeter[]>("meter_snapshot"),
  // Brain: long-term project memory in <projectDir>/.gridkeeper/brain/ (notes/, inbox/, generated INDEX.md).
  // Agents' direct edits arrive as EVT_MISSION_CHANGED with file "brain" while a mission watch is held.
  /** Every note and suggestion; missing folder = exists false. Also refreshes a stale INDEX.md. */
  brainList: (projectDir: string) => invoke<BrainIndex>("brain_list", { projectDir }),
  brainRead: (projectDir: string, slug: string, inbox: boolean) => invoke<BrainNoteFile>("brain_read", { projectDir, slug, inbox }),
  /** Atomic, redacted, <= 16 KiB. Rejects with code "conflict" when the note changed since `expectedModifiedMs`
   *  (null = must not exist yet, undefined = no check). */
  brainWrite: (projectDir: string, slug: string, text: string, inbox: boolean, expectedModifiedMs?: number | null) =>
    invoke<BrainNoteFile>("brain_write", { projectDir, slug, text, inbox, expectedModifiedMs, checkExpected: expectedModifiedMs !== undefined }),
  /** inbox/ → notes/ as confirmed; returns the slug in notes/ (a clash gets "-<n>"). */
  brainApprove: (projectDir: string, slug: string) => invoke<string>("brain_approve", { projectDir, slug }),
  /** Returns the deleted text (for Undo). Code "not_found" when it is gone. */
  brainDelete: (projectDir: string, slug: string, inbox: boolean) => invoke<string>("brain_delete", { projectDir, slug, inbox }),
  brainSearch: (projectDir: string, query: string) => invoke<BrainHit[]>("brain_search", { projectDir, query }),
  /** Share the brain through git (notes/*.md + INDEX.md committable) or keep it local (default). */
  brainShare: (projectDir: string, share: boolean) => invoke<BrainShare>("brain_share", { projectDir, share }),
};

export function onSessionState(cb: (info: SessionInfo) => void): Promise<UnlistenFn> {
  return listen<SessionInfo>(EVT_SESSION_STATE, (e) => cb(e.payload));
}

export function onSessionAttention(cb: (ev: SessionAttention) => void): Promise<UnlistenFn> {
  return listen<SessionAttention>(EVT_SESSION_ATTENTION, (e) => cb(e.payload));
}

/** Extract a readable message from an invoke rejection. */
export function errorMessage(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
}

export function onMissionChanged(cb: (ev: MissionChanged) => void): Promise<UnlistenFn> {
  return listen<MissionChanged>(EVT_MISSION_CHANGED, (e) => cb(e.payload));
}

export function onSessionMeter(cb: (m: SessionMeter) => void): Promise<UnlistenFn> {
  return listen<SessionMeter>(EVT_SESSION_METER, (e) => cb(e.payload));
}
