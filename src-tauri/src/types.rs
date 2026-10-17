//! Shared data types — the IPC contract between the Rust backend and the
//! TypeScript frontend (mirrored in `src/lib/types.ts`). Field names are
//! serialized camelCase. Change both sides together.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;

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
}

/// Desktop / in-app attention notifications (decided in the frontend).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NotificationSettings {
    pub enabled: bool,
    /// Notify when a session goes quiet after working ("finished").
    pub on_idle: bool,
    /// Notify on BEL / notification escapes / "waiting for you" status.
    pub on_bell: bool,
    /// Short in-app sound with each alert.
    pub sound: bool,
}

impl Default for NotificationSettings {
    fn default() -> Self {
        Self { enabled: true, on_idle: true, on_bell: true, sound: false }
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

/// Persisted session metadata (NOT a running process). No secrets.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMeta {
    pub id: SessionId,
    pub name: String,
    pub agent: AgentKind,
    pub cwd: String,
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
