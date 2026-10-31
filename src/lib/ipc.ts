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
// Native browser panes
import type {
  BrowserViewAction,
  BrowserViewDownload,
  BrowserViewNewWindow,
  BrowserViewRect,
  BrowserViewShortcut,
  BrowserViewState,
  BrowserViewVisibility,
} from "./types";
import {
  EVT_BROWSER_VIEW_DOWNLOAD,
  EVT_BROWSER_VIEW_FOCUS,
  EVT_BROWSER_VIEW_NEW_WINDOW,
  EVT_BROWSER_VIEW_SHORTCUT,
  EVT_BROWSER_VIEW_STATE,
} from "./types";
// Skills
import type { InstallResult, InstalledSkill, RepoSkills, SkillFileText, SkillRepoPage, SkillSort, SkillTarget, SkillUpdateCheck } from "./types";
// Phone alerts
import type { PhoneAlert, PhoneAlertsView, PhoneConfig, PhoneSendResult } from "./types";
// Brain
import type { BrainHit, BrainIndex, BrainNoteFile, BrainShare } from "./types";
// Test runs + merge assistant
import type { MergeOutcome, MergePlan, MergePreview, MergeRequest, TestDetection, TestRunInfo, TestRunLog, TestRunSpec, WorktreeCleanupOutcome, WorktreeCleanupPlan } from "./types";
import { EVT_TEST_RUN } from "./types";
// Agent browser
import type { AgentBrowserActivity, AgentBrowserInput, AgentBrowserState } from "./types";
import { EVT_AGENT_BROWSER_ACTIVITY, EVT_AGENT_BROWSER_STATE } from "./types";
// Low-memory guard
import type { MemoryStatus } from "./types";
import { EVT_MEMORY_STATUS } from "./types";

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
  // Native browser panes (child webview per pane, Windows only; src/browser/nativeViews.ts drives them).
  browserViewSupported: () => invoke<boolean>("browser_view_supported"),
  /** Resolves true when an existing view was reused (frontend reload). */
  browserViewCreate: (paneId: string, url: string, rect: BrowserViewRect, visibility: BrowserViewVisibility) =>
    invoke<boolean>("browser_view_create", { paneId, url, rect, visibility }),
  browserViewSetBounds: (paneId: string, rect: BrowserViewRect | null, visibility: BrowserViewVisibility) =>
    invoke<void>("browser_view_set_bounds", { paneId, rect, visibility }),
  browserViewNavigate: (paneId: string, action: BrowserViewAction) => invoke<void>("browser_view_navigate", { paneId, action }),
  browserViewFocus: (paneId: string) => invoke<void>("browser_view_focus", { paneId }),
  /** Keyboard focus back to the app page (when a view has it). */
  browserViewBlur: () => invoke<void>("browser_view_blur"),
  browserViewClose: (paneId: string) => invoke<boolean>("browser_view_close", { paneId }),
  /** Close every view whose pane is not listed; resolves how many were closed. */
  browserViewRetain: (paneIds: string[]) => invoke<number>("browser_view_retain", { paneIds }),
  /** JPEG of the view (empty buffer when none could be taken in time). */
  browserViewSnapshot: (paneId: string) => invoke<ArrayBuffer>("browser_view_snapshot", { paneId }),
  /** App key bindings (canonical combos) that a focused page must hand to the app. */
  browserViewSetShortcuts: (combos: string[]) => invoke<void>("browser_view_set_shortcuts", { combos }),
  browserViewDevtools: (paneId: string) => invoke<void>("browser_view_devtools", { paneId }),

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
  // Phone alerts (opt-in ntfy push; the token is write-only: the UI only learns `hasToken`).
  phoneAlertsGet: () => invoke<PhoneAlertsView>("phone_alerts_get"),
  phoneAlertsSet: (config: PhoneConfig) => invoke<PhoneAlertsView>("phone_alerts_set", { config }),
  phoneAlertsNewTopic: () => invoke<PhoneAlertsView>("phone_alerts_new_topic"),
  /** Non-empty saves it (Credential Manager on Windows, a 0600 file elsewhere); null removes it. */
  phoneAlertsSetToken: (token: string | null) => invoke<PhoneAlertsView>("phone_alerts_set_token", { token }),
  phoneAlertSend: (alert: PhoneAlert) => invoke<PhoneSendResult>("phone_alert_send", { alert }),
  phoneAlertsTest: () => invoke<PhoneSendResult>("phone_alerts_test"),
  // Replay: mission recordings in <projectDir>/.gridkeeper/replay/*.jsonl and export saves.
  /** Append JSON-object lines (name `^[A-Za-z0-9._-]+\.jsonl$`). `full` = the 5 MB cap was hit; nothing written. */
  replayAppend: (projectDir: string, fileName: string, lines: string[]) =>
    invoke<ReplayAppend>("replay_append", { projectDir, fileName, lines }),
  replayList: (projectDir: string) => invoke<ReplayInfo[]>("replay_list", { projectDir }),
  replayRead: (projectDir: string, name: string) => invoke<string>("replay_read", { projectDir, name }),
  replayDelete: (projectDir: string, name: string) => invoke<void>("replay_delete", { projectDir, name }),
  /** Native save dialog (run by Rust); null when cancelled. The token authorizes one replaySaveFile to that path.
   *  "json" saves a team template (actions/teamTemplates.ts) through the same one-time-token path. */
  replaySaveDialog: (defaultName: string, kind: ReplayExportKind | "json") =>
    invoke<ReplaySaveTarget | null>("replay_save_dialog", { defaultName, kind }),
  /** Raw binary body (no JSON number[]: a 20 MB video stays 20 MB on the wire). Returns the written path. */
  replaySaveFile: (token: string, bytes: Uint8Array) =>
    invoke<string>("replay_save_file", bytes, { headers: { "x-replay-token": token } }),
  // Meter: Claude Code cost & context per pane (status line JSON; live updates via onSessionMeter).
  meterSnapshot: () => invoke<SessionMeter[]>("meter_snapshot"),
  // Low-memory guard: fresh reading with the guard's level (changes arrive via onMemoryStatus). The program
  // list is only filled while the level is not "ok".
  memoryStatus: () => invoke<MemoryStatus>("memory_status"),
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
  /** Spend guard ledger (`<data>/spend-ledger.json`, owned by src/store/spend.ts); null = none yet. */
  spendLedgerRead: () => invoke<string | null>("spend_ledger_read"),
  spendLedgerWrite: (text: string) => invoke<void>("spend_ledger_write", { text }),
  // Test runs: the test command in a worktree as a contained background process (live updates via onTestRun).
  /** Test commands found in a folder's own files (best first). Reads files only. */
  testDetect: (path: string) => invoke<TestDetection>("test_detect", { path }),
  /** Queue a run; a folder that already has an active run gets that run back. */
  testRunStart: (spec: TestRunSpec) => invoke<TestRunInfo>("test_run_start", { spec }),
  testRunCancel: (id: string) => invoke<boolean>("test_run_cancel", { id }),
  testRunList: () => invoke<TestRunInfo[]>("test_run_list"),
  /** Captured output (ANSI stripped): the newest `maxBytes` (null = all of the 2 MiB kept). */
  testRunLog: (id: string, maxBytes: number | null = null) => invoke<TestRunLog>("test_run_log", { id, maxBytes }),
  // Merge assistant: the one git write path (ADR-020). Preview and plan write nothing.
  mergePreview: (path: string, base: string | null = null) => invoke<MergePreview>("merge_preview", { path, base }),
  /** The exact commands `mergeExecute(request)` runs. */
  mergePlan: (request: MergeRequest) => invoke<MergePlan>("merge_plan", { request }),
  /** Guards are re-checked; refusals reject (code "conflict"), a failed step resolves with ok false + rolledBack. */
  mergeExecute: (request: MergeRequest) => invoke<MergeOutcome>("merge_execute", { request }),
  mergeCleanupPlan: (path: string, base: string | null = null) => invoke<WorktreeCleanupPlan>("merge_cleanup_plan", { path, base }),
  mergeCleanup: (path: string, branch: string, base: string | null = null) =>
    invoke<WorktreeCleanupOutcome>("merge_cleanup", { path, branch, base }),
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

export interface BrowserViewHandlers {
  state: (s: BrowserViewState) => void;
  focus: (paneId: string) => void;
  shortcut: (s: BrowserViewShortcut) => void;
  newWindow: (r: BrowserViewNewWindow) => void;
  download: (d: BrowserViewDownload) => void;
}

/** Events of the native browser panes. Resolves one function that removes every listener. */
export async function onBrowserViewEvents(h: BrowserViewHandlers): Promise<UnlistenFn> {
  const offs = await Promise.all([
    listen<BrowserViewState>(EVT_BROWSER_VIEW_STATE, (e) => h.state(e.payload)),
    listen<{ paneId: string }>(EVT_BROWSER_VIEW_FOCUS, (e) => h.focus(e.payload.paneId)),
    listen<BrowserViewShortcut>(EVT_BROWSER_VIEW_SHORTCUT, (e) => h.shortcut(e.payload)),
    listen<BrowserViewNewWindow>(EVT_BROWSER_VIEW_NEW_WINDOW, (e) => h.newWindow(e.payload)),
    listen<BrowserViewDownload>(EVT_BROWSER_VIEW_DOWNLOAD, (e) => h.download(e.payload)),
  ]);
  return () => offs.forEach((off) => off());
}

export function onTestRun(cb: (info: TestRunInfo) => void): Promise<UnlistenFn> {
  return listen<TestRunInfo>(EVT_TEST_RUN, (e) => cb(e.payload));
}

// ---- Agent browser (shared browser, a tab per agent; src-tauri/src/agent_browser) ---------------------------
// Screencast frames arrive on the watch channel as `[u32 LE header length][header JSON][JPEG]`.

export const agentBrowserIpc = {
  state: () => invoke<AgentBrowserState>("agent_browser_state"),
  /** "Give this agent a browser" (applies at the session's next launch). */
  setSession: (id: SessionId, enabled: boolean) => invoke<void>("agent_browser_set_session", { id, enabled }),
  /** Returns the normalized allowlist. */
  setAllowlist: (entries: string[]) => invoke<string[]>("agent_browser_set_allowlist", { entries }),
  setIdleMinutes: (minutes: number) => invoke<void>("agent_browser_set_idle_minutes", { minutes }),
  /** "Stop agent browsing" (closes the tab, refuses calls) / allow again. */
  setStopped: (id: SessionId, stopped: boolean) => invoke<void>("agent_browser_set_stopped", { id, stopped }),
  takeOver: (id: SessionId, on: boolean) => invoke<void>("agent_browser_take_over", { id, on }),
  answer: (promptId: number, allow: boolean, remember: boolean) => invoke<void>("agent_browser_answer", { promptId, allow, remember }),
  /** `token` identifies this view: an unwatch from an older view never stops a newer one. */
  watch: (id: SessionId, channel: Channel<ArrayBuffer>, maxWidth: number, maxHeight: number, token: number) =>
    invoke<void>("agent_browser_watch", { id, channel, maxWidth, maxHeight, token }),
  unwatch: (id: SessionId, token: number) => invoke<void>("agent_browser_unwatch", { id, token }),
  input: (id: SessionId, event: AgentBrowserInput) => invoke<void>("agent_browser_input", { id, event }),
  stopBrowser: () => invoke<void>("agent_browser_stop_browser"),
};

export function onAgentBrowserState(cb: (s: AgentBrowserState) => void): Promise<UnlistenFn> {
  return listen<AgentBrowserState>(EVT_AGENT_BROWSER_STATE, (e) => cb(e.payload));
}

export function onAgentBrowserActivity(cb: (a: AgentBrowserActivity) => void): Promise<UnlistenFn> {
  return listen<AgentBrowserActivity>(EVT_AGENT_BROWSER_ACTIVITY, (e) => cb(e.payload));
}

export function onMemoryStatus(cb: (s: MemoryStatus) => void): Promise<UnlistenFn> {
  return listen<MemoryStatus>(EVT_MEMORY_STATUS, (e) => cb(e.payload));
}
