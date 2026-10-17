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
    /// Claude account profile id (Claude adapter only).
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

/// Binary frame types on the per-session output `Channel` (first byte of each message).
pub mod frame {
    /// Followed by raw terminal bytes.
    pub const DATA: u8 = 0;
    /// Terminal must be reset; replayed bytes follow in subsequent DATA frames.
    pub const RESET: u8 = 1;
}

// ---------------------------------------------------------------------------
// Claude profiles
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeProfile {
    pub id: String,
    pub name: String,
    /// `None` = Claude Code's default config location (no CLAUDE_CONFIG_DIR set).
    pub config_dir: Option<String>,
    /// Hex accent used for the account badge.
    pub color: String,
    /// Computed on read; never persisted.
    #[serde(default)]
    pub status: ProfileStatus,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileStatus {
    pub dir_exists: bool,
    /// Best-effort: a credentials file is present (checked by filename only, never read).
    pub likely_authenticated: bool,
    /// True when `claude auth status` was actually run (vs. filename heuristic only).
    pub verified: bool,
    pub logged_in: Option<bool>,
    /// e.g. "claude.ai", "api_key", "none". Never a token.
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
