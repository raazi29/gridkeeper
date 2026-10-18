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
  SessionId,
  SessionAttention,
  SessionInfo,
  SessionMeter,
  SessionSpec,
  WorktreeInfo,
} from "./types";
import { EVT_MISSION_CHANGED, EVT_SESSION_ATTENTION, EVT_SESSION_METER, EVT_SESSION_STATE } from "./types";

export interface AppInfo {
  version: string;
  windowsBuild: number | null;
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

  // Meter: Claude Code cost & context per pane (status line JSON; live updates via onSessionMeter).
  meterSnapshot: () => invoke<SessionMeter[]>("meter_snapshot"),
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
