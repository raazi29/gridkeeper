//! IPC types of the agent browser (serde `camelCase`), mirrored in `src/lib/types.ts` (end of file).
//! Kept in this module so the shared `types.rs` contract stays untouched.

use serde::{Deserialize, Serialize};

use crate::types::SessionId;

/// Full state, emitted on every change (small: one row per opted-in session).
pub const EVT_STATE: &str = "agent-browser-state";
/// One logged browser action (also recorded in the session activity log by the frontend).
pub const EVT_ACTIVITY: &str = "agent-browser-activity";

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentBrowserState {
    /// The shared browser process is running.
    pub running: bool,
    /// "Microsoft Edge 141.0.…" once started.
    pub browser: Option<String>,
    pub pid: Option<u32>,
    /// Browser executable that would be (or is) used; `None` = none found.
    pub executable: Option<String>,
    /// Why the browser could not start last time.
    pub error: Option<String>,
    pub idle_minutes: u32,
    pub allowlist: Vec<String>,
    pub sessions: Vec<AgentBrowserSession>,
    /// Questions waiting for the user (oldest first).
    pub prompts: Vec<AgentBrowserPrompt>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentBrowserSession {
    pub session_id: SessionId,
    /// Opted in ("Give this agent a browser"); applies at the next launch.
    pub enabled: bool,
    /// The running process was launched with the browser tools.
    pub launched: bool,
    /// Why the last launch got no browser tools, if it did not.
    pub launch_note: Option<String>,
    /// The agent's MCP helper is connected.
    pub connected: bool,
    pub has_tab: bool,
    pub url: Option<String>,
    pub title: Option<String>,
    /// The user controls the tab; the agent's tool calls wait.
    pub taken_over: bool,
    /// The user stopped browsing for this agent (tool calls are refused until resumed).
    pub stopped: bool,
    /// A tool call is running.
    pub busy: bool,
    /// A JavaScript confirm / prompt dialog is open in the tab.
    pub dialog: Option<String>,
    pub last_action: Option<String>,
    pub last_action_ms: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PromptKind {
    /// Submitting a form on a host outside the allowlist.
    FormSubmit,
    /// Running a script (browser_evaluate) on a host outside the allowlist.
    Script,
    /// Giving files to a page.
    Upload,
    /// Keeping a file the page downloaded.
    Download,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentBrowserPrompt {
    pub id: u64,
    pub session_id: SessionId,
    pub kind: PromptKind,
    /// `https://host[:port]` of the page.
    pub origin: Option<String>,
    /// What exactly would happen (form target, file names, script preview ...).
    pub detail: String,
    pub created_ms: u64,
    pub expires_ms: u64,
    /// "Always allow <host>" is offered (adds the host to the allowlist).
    pub remember_host: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ActivityOutcome {
    Ok,
    Error,
    /// Refused by policy (URL scheme, stopped, ...).
    Blocked,
    /// The user said no (or did not answer).
    Denied,
    /// Waiting / informational (take-over, dialog, download ...).
    Info,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentBrowserActivity {
    pub session_id: SessionId,
    pub at_ms: u64,
    /// Tool name (`browser_click`) or an event name (`download`, `popup`, `takeover`).
    pub tool: String,
    /// One line, redacted, typed text truncated (never shown for password fields).
    pub summary: String,
    pub url: Option<String>,
    pub outcome: ActivityOutcome,
}

/// User input for a taken-over tab (CSS pixel coordinates of the page viewport).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum InputEvent {
    #[serde(rename_all = "camelCase")]
    Mouse {
        /// "down" | "up" | "move" | "wheel"
        action: String,
        x: f64,
        y: f64,
        /// "left" | "middle" | "right" | "none"
        #[serde(default)]
        button: Option<String>,
        #[serde(default)]
        click_count: Option<u32>,
        #[serde(default)]
        delta_x: Option<f64>,
        #[serde(default)]
        delta_y: Option<f64>,
        #[serde(default)]
        modifiers: u32,
    },
    #[serde(rename_all = "camelCase")]
    Key {
        /// "down" | "up"
        action: String,
        key: String,
        #[serde(default)]
        code: String,
        #[serde(default)]
        key_code: u32,
        /// Printable text the key produces (keydown only).
        #[serde(default)]
        text: Option<String>,
        #[serde(default)]
        modifiers: u32,
    },
    /// Insert text at the caret (the "type text" box; also how paste works).
    Text { text: String },
}
