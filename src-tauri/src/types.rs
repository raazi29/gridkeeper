//! Shared data types — the IPC contract between the Rust backend and the
//! TypeScript frontend (mirrored in `src/lib/types.ts`). Field names are
//! serialized camelCase. Change both sides together.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;

pub use crate::gpu::{EnginePercent, GpuAdapter, GpuStats};

pub type SessionId = String;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("not found: {0}")]
    NotFound(String),
    #[error("invalid input: {0}")]
    Invalid(String),
    #[error("executable not found: {0}")]
    MissingExecutable(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    /// Optimistic-concurrency failure (e.g. the mission file changed since it was read).
    #[error("conflict: {0}")]
    Conflict(String),
    #[error("{0}")]
    Other(String),
}

impl From<anyhow::Error> for AppError {
    fn from(e: anyhow::Error) -> Self {
        AppError::Other(format!("{e:#}"))
    }
}

impl AppError {
    pub fn code(&self) -> &'static str {
        match self {
            AppError::NotFound(_) => "not_found",
            AppError::Invalid(_) => "invalid",
            AppError::MissingExecutable(_) => "missing_executable",
            AppError::Io(_) => "io",
            AppError::Conflict(_) => "conflict",
            AppError::Other(_) => "other",
        }
    }
}

/// Serialized to the frontend as `{ code, message }`.
impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut st = s.serialize_struct("AppError", 2)?;
        st.serialize_field("code", self.code())?;
        st.serialize_field("message", &crate::redact::redact(&self.to_string()))?;
        st.end()
    }
}

pub type AppResult<T> = Result<T, AppError>;

// ---------------------------------------------------------------------------
// Agents & sessions
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentKind {
    Powershell,
    Claude,
    Codex,
    Generic,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "camelCase")]
pub enum ResumeMode {
    /// Start a fresh conversation / shell.
    #[default]
    None,
    /// Continue the most recent conversation in this cwd (claude --continue, codex resume --last).
    Continue,
    /// Resume a specific conversation id.
    Session { id: String },
    /// Open the agent's own interactive conversation picker (claude --resume, codex resume).
    Pick,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EnvVar {
    pub key: String,
    pub value: String,
}

/// Everything needed to launch one session. Sent by the frontend on start.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSpec {
    pub id: SessionId,
    pub name: String,
    pub agent: AgentKind,
    pub cwd: String,
    /// Account id (see `profiles::ProfileStore`). Historically Claude-only; now the account of
    /// whichever agent this session runs (Claude, Codex, or a catalog tool with account support).
    #[serde(default)]
    pub profile_id: Option<String>,
    /// Executable override (all adapters) / required executable (generic).
    #[serde(default)]
    pub command: Option<String>,
    /// Extra user arguments appended after adapter arguments.
    #[serde(default)]
    pub args: Vec<String>,
    /// Extra non-secret environment variables.
    #[serde(default)]
    pub env: Vec<EnvVar>,
    #[serde(default)]
    pub resume: ResumeMode,
    /// Agent conversation id to pin for a NEW conversation (claude --session-id <uuid>).
    #[serde(default)]
    pub agent_session_id: Option<String>,
    /// Catalog tool id for generic sessions (see adapters::catalog), e.g. "hermes".
    #[serde(default)]
    pub preset: Option<String>,
    pub cols: u16,
    pub rows: u16,
}

/// Fully resolved process launch, produced by `adapters::resolve_launch`.
#[derive(Debug, Clone)]
pub struct LaunchPlan {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub env_set: Vec<(String, String)>,
    pub env_remove: Vec<String>,
    pub cwd: PathBuf,
    /// Human-readable, redacted command line for UI/logs.
    pub display: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum SessionState {
    Starting,
    Running,
    Stopping,
    Exited { code: Option<u32> },
    Failed { message: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: SessionId,
    pub name: String,
    pub agent: AgentKind,
    pub pid: Option<u32>,
    pub state: SessionState,
    pub cwd: String,
    pub profile_id: Option<String>,
    pub command_display: String,
    /// RFC 3339
    pub started_at: Option<String>,
    pub ended_at: Option<String>,
    /// Total bytes received from the PTY since start.
    pub bytes_out: u64,
}

/// Emitted with payload `SessionInfo` whenever a session's state changes.
pub const EVT_SESSION_STATE: &str = "session-state";

/// Emitted with payload `SessionAttention` when a session asks for attention
/// (BEL / OSC 9 / OSC 777 / OSC 99), reports a status (OSC 7501), or its
/// output activity starts / stops (heuristic).
pub const EVT_SESSION_ATTENTION: &str = "session-attention";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AttentionKind {
    /// Bare BEL (rate-limited).
    Bell,
    /// Desktop-notification escape (OSC 9 / 777 / 99), rate-limited.
    Notify,
    /// OSC 7501 program status; `status` = state (idle|working|done|blocked|error|clear|…).
    Status,
    /// Output went quiet after an active run. `status = "done"` when the run
    /// lasted >= 3 s (and was not start-up output); otherwise absent.
    Idle,
    /// Output started arriving steadily.
    Active,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionAttention {
    pub id: SessionId,
    pub kind: AttentionKind,
    /// Notification title (control characters stripped, <= 200 chars).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    /// OSC 7501 `kind` for blocked states: permission | question | auth.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// Idle events: how long the active run lasted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_ms: Option<u64>,
}

/// Binary frame types on the per-session output `Channel` (first byte of each message).
pub mod frame {
    /// Followed by raw terminal bytes.
    pub const DATA: u8 = 0;
    /// Terminal must be reset; replayed bytes follow in subsequent DATA frames.
    pub const RESET: u8 = 1;
}

// ---------------------------------------------------------------------------
// Accounts (historically "Claude profiles")
// ---------------------------------------------------------------------------

/// Agent kind of records written before accounts existed (all were Claude profiles).
pub fn default_account_agent() -> AgentKind {
    AgentKind::Claude
}

/// A Claude Code account profile (unchanged shape; see [`Account`] for every agent).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeProfile {
    pub id: String,
    pub name: String,
    /// `None` = Claude Code's default config location (no CLAUDE_CONFIG_DIR set).
    /// For an [`Account`] of another agent: that agent's default home.
    pub config_dir: Option<String>,
    /// Hex accent used for the account badge.
    pub color: String,
    /// Computed on read; never persisted.
    #[serde(default)]
    pub status: ProfileStatus,
}

/// One agent account: a name + an isolated home directory for one agent CLI
/// (Claude: `CLAUDE_CONFIG_DIR`, Codex: `CODEX_HOME`, Hermes: `HERMES_HOME`).
/// Serialized flat: the `ClaudeProfile` fields plus the ones below.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    #[serde(flatten)]
    pub profile: ClaudeProfile,
    /// Which agent this account belongs to. Missing = Claude.
    #[serde(default = "default_account_agent")]
    pub agent: AgentKind,
    /// Catalog tool id when `agent` is Generic (e.g. "hermes").
    #[serde(default)]
    pub preset: Option<String>,
    /// Added by the automatic scan rather than by the user.
    #[serde(default)]
    pub auto_detected: bool,
    /// Resolved home directory (default home expanded). Computed on read; never persisted.
    #[serde(default)]
    pub resolved_dir: Option<String>,
}

impl std::ops::Deref for Account {
    type Target = ClaudeProfile;
    fn deref(&self) -> &ClaudeProfile {
        &self.profile
    }
}

impl std::ops::DerefMut for Account {
    fn deref_mut(&mut self) -> &mut ClaudeProfile {
        &mut self.profile
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileStatus {
    pub dir_exists: bool,
    /// Best-effort: a credentials file is present (checked by filename only, never read).
    pub likely_authenticated: bool,
    /// True when the agent's own status command (`claude auth status`, `codex login status`)
    /// actually ran (vs. filename heuristic only).
    pub verified: bool,
    pub logged_in: Option<bool>,
    /// e.g. "claude.ai", "chatgpt", "api_key", "none". Never a token.
    pub auth_method: Option<String>,
    /// Account e-mail for UI display only; never logged or persisted.
    pub account: Option<String>,
    pub note: Option<String>,
}

// ---------------------------------------------------------------------------
// Agent discovery
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentAvailability {
    pub kind: AgentKind,
    pub path: Option<String>,
    pub version: Option<String>,
    pub error: Option<String>,
    /// Catalog tool id (kind = Generic), e.g. "hermes". `None` for built-in kinds.
    #[serde(default)]
    pub preset: Option<String>,
    /// Display name for catalog tools.
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub supports_resume: bool,
}

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitInfo {
    pub is_repo: bool,
    pub root: Option<String>,
    pub branch: Option<String>,
    pub dirty: bool,
    pub worktrees: Vec<WorktreeInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    pub path: String,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub is_main: bool,
}

/// One changed path from `git status --porcelain=v2`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    /// Repository-relative path (forward slashes, as git prints it).
    pub path: String,
    /// Rename / copy source.
    pub orig_path: Option<String>,
    /// Index (staged) status letter: `.` = unchanged, M, A, D, R, C, T, U.
    pub index: String,
    /// Work-tree status letter (same alphabet).
    pub worktree: String,
    /// "changed" | "renamed" | "unmerged" | "untracked".
    pub kind: String,
}

/// Read-only snapshot of a repository's working state.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoChanges {
    pub is_repo: bool,
    pub root: Option<String>,
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub files: Vec<ChangedFile>,
    /// More than `git::MAX_STATUS_FILES` entries: the list was cut.
    pub truncated: bool,
}

/// Unified diff text for one file, capped at `git::MAX_DIFF_BYTES`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub text: String,
    pub truncated: bool,
    pub binary: bool,
}

/// A worktree's branch measured against a base branch (read-only; `git::branch_summary`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchSummary {
    pub is_repo: bool,
    pub branch: Option<String>,
    /// The base actually used: the requested one, else the main worktree's branch; `None` when unresolvable.
    pub base: Option<String>,
    /// Commits on HEAD not on base / on base not on HEAD.
    pub ahead: u32,
    pub behind: u32,
    /// `git diff --shortstat base...HEAD` (committed work only).
    pub files_changed: u32,
    pub insertions: u32,
    pub deletions: u32,
    /// Entries in `git status --porcelain` (uncommitted, incl. untracked).
    pub uncommitted: u32,
    pub last_commit_subject: Option<String>,
    /// Last commit time in ms since the epoch.
    pub last_commit_ms: Option<u64>,
}

/// One file changed by the commits on HEAD since it left a base (`git diff -M base...HEAD`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchFile {
    /// Repository-relative path on HEAD (forward slashes, as git prints it).
    pub path: String,
    /// Rename / copy source.
    pub orig_path: Option<String>,
    /// Status letter from `--name-status`: A, M, D, R, C, T (similarity score dropped).
    pub status: String,
    pub insertions: u32,
    pub deletions: u32,
    /// numstat printed `-\t-` (no line counts).
    pub binary: bool,
}

/// The committed work of a worktree's branch against a base (read-only; `git::branch_files`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchFiles {
    pub is_repo: bool,
    pub branch: Option<String>,
    /// The base actually used: the requested one, else the main worktree's branch; `None` when unresolvable.
    pub base: Option<String>,
    /// Commits on HEAD not on base.
    pub ahead: u32,
    /// Empty when HEAD is the base, there is no base, or nothing differs.
    pub files: Vec<BranchFile>,
    /// More than `git::MAX_BRANCH_FILES` files: the list was cut.
    pub truncated: bool,
}

// ---------------------------------------------------------------------------
// Mission file (`mission`)
// ---------------------------------------------------------------------------

/// `<projectDir>/.gridkeeper/mission.md`, read by `mission_read` / written by `mission_write`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MissionFile {
    /// Absolute path of the mission file (whether or not it exists).
    pub path: String,
    pub exists: bool,
    /// File contents (UTF-8 lossy, BOM stripped, at most 256 KiB; "" when missing).
    pub text: String,
    /// Last-write time in ms since the epoch; `None` when missing. Passed back to `mission_write`.
    pub modified_ms: Option<u64>,
}

/// Emitted with payload `MissionChanged` when the mission file of a watched project folder changes.
pub const EVT_MISSION_CHANGED: &str = "mission-changed";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MissionChanged {
    /// The folder exactly as the frontend passed it to `mission_watch`.
    pub project_dir: String,
    /// What changed: the mission file, or the lead control outbox (`.gridkeeper/outbox/`).
    pub file: MissionChangeKind,
}

/// `MissionChanged.file`: `"mission"` (`.gridkeeper/mission.md`) or `"outbox"` (a file created in or
/// renamed into `.gridkeeper/outbox/`). `team.md` (written by Gridkeeper) never produces an event.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MissionChangeKind {
    Mission,
    Outbox,
}

/// One instruction file directly in `<projectDir>/.gridkeeper/outbox/` (`mission_outbox_list`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutboxItem {
    /// File name only (no folder), e.g. `0007-builder-1.md`.
    pub name: String,
    /// Contents (UTF-8 lossy, BOM stripped), at most `mission::MAX_OUTBOX_FILE_BYTES`.
    pub text: String,
    /// Last-write time in ms since the epoch (0 when unknown).
    pub modified_ms: u64,
    /// The file is larger than the cap: `text` is only its beginning.
    pub truncated: bool,
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcStats {
    /// Percent of ONE logical core summed over processes (Task-Manager style is /logical cores).
    pub cpu_percent: f32,
    pub memory_bytes: u64,
    pub process_count: u32,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStats {
    pub id: SessionId,
    pub stats: ProcStats,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostics {
    /// The Tauri host process only.
    pub host: ProcStats,
    /// msedgewebview2.exe processes belonging to this app.
    pub webview: ProcStats,
    /// Process trees of all sessions, aggregated.
    pub sessions_total: ProcStats,
    pub sessions: Vec<SessionStats>,
    pub logical_cores: u32,
    pub system_memory_total: u64,
    pub system_memory_used: u64,
    pub running_sessions: u32,
    /// GPU engine / memory counters (Windows PDH). None only where never sampled.
    pub gpu: Option<GpuStats>,
}

// ---------------------------------------------------------------------------
// Persisted state (workspaces.json)
// ---------------------------------------------------------------------------

pub const STATE_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RendererPref {
    #[default]
    Auto,
    Webgl,
    Dom,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LayoutPreset {
    /// Near-square grid sized to the session count.
    #[default]
    Grid,
    /// All panes side by side.
    Columns,
    /// All panes stacked.
    Rows,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentPaths {
    pub claude: Option<String>,
    pub codex: Option<String>,
    pub powershell: Option<String>,
}

impl Default for AgentPaths {
    fn default() -> Self {
        Self { claude: None, codex: None, powershell: None }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub scrollback_lines: u32,
    /// Per-session raw output buffer kept in Rust (replay / copy), KiB.
    pub buffer_kib: u32,
    pub font_size: f32,
    pub font_family: String,
    pub line_height: f32,
    pub renderer: RendererPref,
    pub cursor_blink: bool,
    pub default_layout: LayoutPreset,
    pub agent_paths: AgentPaths,
    pub sidebar_collapsed: bool,
    pub inspector_open: bool,
    pub status_bar_diagnostics: bool,
    /// command id -> shortcut string (e.g. "ctrl+shift+t"). Missing = default.
    pub keybindings: BTreeMap<String, String>,
    /// UI theme id (frontend registry). Unknown ids fall back to the default theme in the UI.
    pub theme: String,
    pub reduce_motion: bool,
    /// "compact" | "comfortable". A string, not an enum, so an unknown value never fails loading the state file.
    pub ui_density: String,
    pub notifications: NotificationSettings,
    /// Confirm before pasting large text (>64 KiB or >20 lines) into a program without bracketed paste.
    pub paste_warning: bool,
    /// Blade colour preset for the Saber Duel theme (frontend registry; unknown = default blade).
    pub saber_color: String,
    /// Workspace-switch star-streak transition: "auto" | "on" | "off" (string so unknown values never fail loading).
    pub hyperspace_transition: String,
    /// Terminal right-click: "menu" (context menu, default) | "paste" (copy selection / paste). String so unknown values never fail loading.
    #[serde(default = "default_right_click_action")]
    pub right_click_action: String,
    /// Saber effects: "auto" | "off" | "subtle" | "full" (string so unknown values never fail loading).
    #[serde(default = "default_saber_effects")]
    pub saber_effects: String,
    /// Outside Saber Duel the blade follows the theme accent until the user picks a blade colour.
    #[serde(default = "default_saber_blade_from_theme")]
    pub saber_blade_from_theme: bool,
    /// Synthesized ignite / retract sound with the saber effects (off by default).
    #[serde(default)]
    pub saber_sound: bool,
}

fn default_right_click_action() -> String {
    "menu".into()
}

fn default_saber_effects() -> String {
    "auto".into()
}

fn default_saber_blade_from_theme() -> bool {
    true
}

/// Desktop / in-app attention notifications (decided in the frontend: src/actions/attentionNotify.ts).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NotificationSettings {
    pub enabled: bool,
    /// Notify when a session goes quiet after working ("finished").
    pub on_idle: bool,
    /// Notify on BEL / notification escapes.
    pub on_bell: bool,
    /// Short in-app sound with each alert (master switch; the set is `sound_set`).
    pub sound: bool,
    /// An agent is blocked on the user (permission / question / "waiting" status).
    pub on_input: bool,
    /// Crashes, failed starts, reported errors.
    pub on_error: bool,
    /// "toast" | "inApp" | "off".
    pub delivery: String,
    /// "comm" | "console" | "droid" | "none".
    pub sound_set: String,
    /// 0-100.
    pub volume: u8,
    /// Do not disturb: alerts only reach the in-app feed.
    pub dnd: bool,
    pub quiet_hours: QuietHours,
    pub only_when_unfocused: bool,
    pub agents: AgentNotifyFilter,
    pub muted_sessions: Vec<SessionId>,
    pub muted_workspaces: Vec<String>,
}

impl Default for NotificationSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            on_idle: true,
            on_bell: true,
            sound: false,
            on_input: true,
            on_error: true,
            delivery: "toast".into(),
            sound_set: "comm".into(),
            volume: 50,
            dnd: false,
            quiet_hours: QuietHours::default(),
            only_when_unfocused: false,
            agents: AgentNotifyFilter::default(),
            muted_sessions: Vec::new(),
            muted_workspaces: Vec::new(),
        }
    }
}

/// Daily quiet window ("HH:MM" local time; may cross midnight).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct QuietHours {
    pub enabled: bool,
    pub start: String,
    pub end: String,
}

impl Default for QuietHours {
    fn default() -> Self {
        Self { enabled: false, start: "22:00".into(), end: "07:00".into() }
    }
}

/// Which agent kinds may raise notifications.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentNotifyFilter {
    pub claude: bool,
    pub codex: bool,
    pub powershell: bool,
    pub other: bool,
}

impl Default for AgentNotifyFilter {
    fn default() -> Self {
        Self { claude: true, codex: true, powershell: true, other: true }
    }
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            scrollback_lines: 5000,
            buffer_kib: 2048,
            font_size: 13.0,
            font_family: "\"Cascadia Mono\", \"Cascadia Code\", Consolas, monospace".into(),
            line_height: 1.15,
            renderer: RendererPref::Auto,
            cursor_blink: false,
            default_layout: LayoutPreset::Grid,
            agent_paths: AgentPaths::default(),
            sidebar_collapsed: false,
            inspector_open: false,
            status_bar_diagnostics: true,
            keybindings: BTreeMap::new(),
            theme: "deep-space".into(),
            reduce_motion: false,
            ui_density: "compact".into(),
            notifications: NotificationSettings::default(),
            paste_warning: true,
            saber_color: "blue".into(),
            hyperspace_transition: "auto".into(),
            right_click_action: default_right_click_action(),
            saber_effects: default_saber_effects(),
            saber_blade_from_theme: default_saber_blade_from_theme(),
            saber_sound: false,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Layout {
    pub preset: LayoutPreset,
    /// Session shown maximized (focus mode), if any.
    pub maximized: Option<SessionId>,
    /// Relative column/row sizes (percent), keyed by a layout signature; optional.
    pub sizes: BTreeMap<String, Vec<f32>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub layout: Layout,
    /// Ordered pane membership.
    #[serde(default)]
    pub session_ids: Vec<SessionId>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub project_dir: Option<String>,
    #[serde(default)]
    pub groups: Vec<Group>,
    #[serde(default)]
    pub active_group_id: Option<String>,
    #[serde(default)]
    pub created_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeRef {
    pub path: String,
    pub branch: Option<String>,
}

/// What a pane shows. Missing in older state files = `Terminal`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PaneKind {
    /// A ConPTY session (the only kind before browser panes existed).
    #[default]
    Terminal,
    /// An embedded web page. No process: never started, never counted as a running session.
    Browser,
}

/// Persisted session metadata (NOT a running process). No secrets.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMeta {
    pub id: SessionId,
    pub name: String,
    pub agent: AgentKind,
    pub cwd: String,
    /// Terminal (default) or browser pane.
    #[serde(default)]
    pub kind: PaneKind,
    /// Browser panes: the page to (re)open. http / https / file only, <= 2048 chars
    /// (validated by `persistence::sanitize`). Always `None` for terminals.
    #[serde(default)]
    pub url: Option<String>,
    /// Browser panes: the pane name follows the page title.
    #[serde(default)]
    pub title_as_name: bool,
    #[serde(default)]
    pub profile_id: Option<String>,
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: Vec<EnvVar>,
    /// Start automatically when the workspace is restored.
    #[serde(default)]
    pub auto_start: bool,
    /// On restore, how to resume the agent conversation.
    #[serde(default)]
    pub resume_on_restore: ResumeMode,
    /// Pinned agent conversation id (Claude --session-id), used to resume precisely.
    #[serde(default)]
    pub agent_session_id: Option<String>,
    /// Catalog tool id for generic sessions, e.g. "hermes".
    #[serde(default)]
    pub preset: Option<String>,
    #[serde(default)]
    pub worktree: Option<WorktreeRef>,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub last_exit_code: Option<u32>,
    /// Team role shown in Mission Control (lead, scout, builder, reviewer, verifier or custom).
    /// `[a-z0-9-]`, at most 24 chars (normalized by `persistence::sanitize`).
    #[serde(default)]
    pub role: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedState {
    pub version: u32,
    #[serde(default)]
    pub settings: Settings,
    #[serde(default)]
    pub workspaces: Vec<Workspace>,
    #[serde(default)]
    pub sessions: Vec<SessionMeta>,
    #[serde(default)]
    pub active_workspace_id: Option<String>,
}

impl Default for PersistedState {
    fn default() -> Self {
        Self {
            version: STATE_VERSION,
            settings: Settings::default(),
            workspaces: Vec::new(),
            sessions: Vec::new(),
            active_workspace_id: None,
        }
    }
}

// ---------------------------------------------------------------------------
// Skills: Agent Skills from GitHub (user-initiated discovery) installed into a project (crate::skills)
// ---------------------------------------------------------------------------

/// A GitHub repository from a skills search.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillRepo {
    /// `owner/name`.
    pub full_name: String,
    pub description: Option<String>,
    pub stars: u64,
    /// ISO 8601.
    pub pushed_at: Option<String>,
    /// SPDX id (or license name).
    pub license: Option<String>,
    pub topics: Vec<String>,
    pub html_url: String,
    pub default_branch: String,
    pub archived: bool,
}

/// One page of `skills_search`. A rate limit is a result, not an error.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillRepoPage {
    pub items: Vec<SkillRepo>,
    /// Total matches GitHub reports (it serves at most 1000).
    pub total: u64,
    pub page: u32,
    pub rate_limited: bool,
    /// Epoch seconds when the rate limit resets (`rate_limited` only, when GitHub said).
    pub reset_at: Option<u64>,
    pub message: Option<String>,
    /// The search query sent to api.github.com (shown in the UI).
    pub query: String,
    /// When GitHub answered (epoch ms).
    pub fetched_at_ms: u64,
    /// Served from the 10-minute in-memory cache.
    pub cached: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillFile {
    /// Relative to the skill folder, forward slashes.
    pub path: String,
    pub size: u64,
    /// Script / binary by extension (.ps1 .sh .bat .cmd .exe .js .py ...) or git's executable bit.
    pub executable: bool,
}

/// One skill (a folder with a SKILL.md) in a repository at a pinned commit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInfo {
    /// Folder in the repository ("" = the repository root), forward slashes.
    pub path: String,
    /// Frontmatter `name`, else the folder name.
    pub name: String,
    /// Folder name used on install (`.claude/skills/<installName>`).
    pub install_name: String,
    pub description: Option<String>,
    /// SKILL.md first.
    pub files: Vec<SkillFile>,
    pub total_bytes: u64,
    /// Has `scripts/` or executable-looking files.
    pub has_scripts: bool,
    /// Full SKILL.md text; None when not fetched (many skills) or unreadable: use `skills_file`.
    pub skill_md: Option<String>,
    /// Git tree SHA of the skill folder (recorded on install, compared by update checks).
    pub tree_sha: String,
    /// Why it cannot be installed (over 200 files / 5 MB / 1 MB per file, unsafe names), if so.
    pub blocked: Option<String>,
}

/// `skills_inspect`: a repository's skills, pinned to one commit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoSkills {
    pub repo: String,
    /// The ref that was resolved (the default branch when none was given).
    pub git_ref: String,
    pub commit_sha: String,
    pub default_branch: Option<String>,
    pub description: Option<String>,
    pub stars: Option<u64>,
    pub license: Option<String>,
    pub pushed_at: Option<String>,
    pub html_url: String,
    pub archived: bool,
    pub skills: Vec<SkillInfo>,
    pub warnings: Vec<String>,
    pub fetched_at_ms: u64,
}

/// `skills_file`: one file of a repository at a pinned commit, for reading before install.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillFileText {
    pub path: String,
    /// UTF-8 text (empty for binary files), at most 256 KiB.
    pub text: String,
    pub size: u64,
    pub binary: bool,
    pub truncated: bool,
}

/// `<skill folder>/.gridkeeper-skill.json`: where an installed skill came from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillProvenance {
    pub repo: String,
    pub commit_sha: String,
    /// Skill folder in the repository ("" = root).
    pub path: String,
    #[serde(default)]
    pub tree_sha: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    /// RFC 3339 (UTC).
    pub installed_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallResult {
    pub name: String,
    /// Installed folders relative to the project, e.g. `.claude/skills/pdf`.
    pub installed: Vec<String>,
    /// The subset of `installed` that replaced an existing folder.
    pub replaced: Vec<String>,
    pub files: usize,
    pub total_bytes: u64,
    pub commit_sha: String,
    pub warnings: Vec<String>,
}

/// A skill found in the project's `.claude/skills/*/SKILL.md` or `.agents/skills/*/SKILL.md`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledSkill {
    /// Frontmatter `name`, else the folder name.
    pub name: String,
    /// Folder name.
    pub folder: String,
    pub description: Option<String>,
    /// `.claude/skills` or `.agents/skills`.
    pub target: String,
    /// `<target>/<folder>` (forward slashes): pass to `skills_remove`.
    pub dir_rel: String,
    pub dir_abs: String,
    /// None: a local skill (not installed by Gridkeeper, or provenance missing).
    pub provenance: Option<SkillProvenance>,
    pub has_scripts: bool,
    pub file_count: usize,
    /// The folder is a junction / symbolic link: listed, never removed.
    pub is_link: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SkillUpdateStatus {
    /// Same commit, or the skill folder is unchanged since the pinned commit.
    Current,
    /// The skill folder changed on the default branch (or could not be compared).
    Update,
    /// The skill folder no longer exists on the default branch.
    Missing,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillUpdateCheck {
    pub repo: String,
    pub path: String,
    pub status: SkillUpdateStatus,
    pub pinned_sha: String,
    /// The default branch's commit now.
    pub current_sha: String,
}
