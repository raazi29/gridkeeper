//! Exact agent status for Claude panes from Claude Code hooks (Settings › Agents › "Exact status for
//! Claude panes (hooks)"; applies while the cost meter is on, through the same `--settings` file).
//!
//! Research and sources: `docs/research-notes/claude-hooks-status.md`.
//! - **Launch** ([`hooks_json`], used by [`super::launch`]): the meter's `--settings` file also gets a
//!   `hooks` key with one async command hook per event in [`EVENTS`]:
//!   `gridkeeper.exe --gk-hook <event> --state-file <data>\meter\<session>.hooks.json`. Claude Code
//!   merges hooks from all settings sources (they add up instead of replacing each other), so the
//!   user's own hooks keep running exactly as before; they are never read or copied.
//! - **Helper** ([`run`]): reads the hook's stdin JSON, keeps the event name, the Claude session id,
//!   the tool name, the notification type, a short token (stop failure type, session start / end
//!   reason) and two flags ([`extract`]). `transcript_path`, `cwd`, `prompt`, `tool_input`,
//!   `tool_response`, messages, titles and error text are skipped by the parser and never stored. The
//!   record is written atomically unless a newer one is already there. It prints nothing (stdout of
//!   some events becomes Claude's context) and always exits 0 (exit 2 would block a tool call or a stop).
//! - **Host** ([`PaneHooks`]): the meter folder watch hands each record to a per-pane state machine that
//!   emits `session-attention` events with `kind = hook`. Keystrokes typed while Claude waits on a
//!   permission or question prompt end the wait ([`PaneHooks::on_input`]); no hook reports that.

use std::ffi::OsStr;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::shell::{self, StatusShell};
use crate::types::{AttentionKind, SessionAttention};

/// argv[1] that selects hook helper mode.
pub const FLAG: &str = "--gk-hook";
pub const STATE_FILE_FLAG: &str = "--state-file";
/// `<session>.hooks.json` in the meter folder.
pub const SUFFIX: &str = ".hooks.json";
pub const RECORD_VERSION: u32 = 1;
/// Hook stdin read at most. Tool inputs and responses can be large: they are streamed past, never kept.
pub const MAX_INPUT: u64 = 64 * 1024 * 1024;
/// `timeout` of each hook (seconds). Claude Code doesn't enforce it on async hooks; it caps a version
/// that runs them synchronously.
pub const HOOK_TIMEOUT_S: u64 = 10;

/// Events Gridkeeper subscribes to.
pub const EVENTS: &[&str] = &[
    "SessionStart",
    "SessionEnd",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
    "PermissionRequest",
    "PermissionDenied",
    "Notification",
    "Stop",
    "StopFailure",
    "SubagentStop",
];

/// Events that support a matcher (`"*"` = everything); the others get none.
const MATCHER_EVENTS: &[&str] = &[
    "SessionStart",
    "SessionEnd",
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
    "PermissionRequest",
    "PermissionDenied",
    "Notification",
    "StopFailure",
];

/// Tools whose call itself waits for the user (a question, a plan to approve).
pub const ASKING_TOOLS: &[&str] = &["AskUserQuestion", "ExitPlanMode"];

/// A `PreToolUse` this soon after a prompt started belongs to the same batch of tool calls (or is the
/// prompting call itself, reported late): it doesn't end the wait.
const SAME_BATCH_US: u64 = 1_500_000;
/// A tool seen this recently names a permission prompt that came without one.
const RECENT_TOOL_US: u64 = 10_000_000;

/// Microseconds since the epoch (orders records written by helpers that run at the same time).
pub fn now_us() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_micros() as u64).unwrap_or(0)
}

pub fn hooks_name(id: &str) -> String {
    format!("{id}{SUFFIX}")
}

/// The session id of a hook state file name (`<id>.hooks.json`), if it is one.
pub fn session_of_hooks_name(name: &str) -> Option<&str> {
    name.strip_suffix(SUFFIX).filter(|id| super::valid_session_id(id))
}

/// What the helper writes to `<data>\meter\<session>.hooks.json` (and nothing more).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HookRecord {
    pub v: u32,
    /// One of [`EVENTS`].
    pub event: String,
    /// When the helper started (µs since the epoch).
    pub t: u64,
    pub claude_session_id: Option<String>,
    /// `tool_name` (tool events only).
    pub tool: Option<String>,
    /// `notification_type` (Notification only).
    pub notification: Option<String>,
    /// StopFailure `error` type, SessionStart `source`, SessionEnd `reason` (a token, never free text).
    pub detail: Option<String>,
    /// PostToolUseFailure `is_interrupt`.
    pub interrupt: bool,
    /// The hook fired inside a subagent (`agent_id` present).
    pub subagent: bool,
}

/// The only stdin keys the parser keeps; serde skips everything else (`transcript_path`, `cwd`,
/// `prompt`, `tool_input`, `tool_response`, `message`, `last_assistant_message`, ...) without storing it.
#[derive(Deserialize, Default)]
#[serde(default)]
struct HookInput {
    hook_event_name: Option<Value>,
    session_id: Option<Value>,
    tool_name: Option<Value>,
    notification_type: Option<Value>,
    /// StopFailure: error type. PostToolUseFailure: error *text*, never kept.
    error: Option<Value>,
    source: Option<Value>,
    /// SessionEnd: reason token. PermissionDenied: free text, never kept.
    reason: Option<Value>,
    is_interrupt: Option<Value>,
    agent_id: Option<Value>,
}

/// `[A-Za-z0-9_-]{1,max}`.
fn token(v: Option<&Value>, max: usize) -> Option<String> {
    let s = v?.as_str()?;
    (!s.is_empty() && s.len() <= max && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')).then(|| s.to_string())
}

/// Tool names: built-in (`Bash`) and MCP (`mcp__server__tool`), `[A-Za-z0-9_.:-]{1,96}`.
pub fn valid_tool_name(s: &str) -> bool {
    !s.is_empty() && s.len() <= 96 && s.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.' | b':'))
}

/// Parse a hook's stdin and keep the whitelisted fields. `None` = unknown event, or the payload names a
/// different event. A payload that isn't JSON still yields the event (from the command line).
pub fn extract(event: &str, input: &mut dyn Read, now_us: u64) -> Option<HookRecord> {
    let event = *EVENTS.iter().find(|e| **e == event)?;
    let reader = io::BufReader::new(Read::take(&mut *input, MAX_INPUT));
    let s: HookInput = serde_json::from_reader(reader).unwrap_or_default();
    if let Some(name) = s.hook_event_name.as_ref().and_then(Value::as_str) {
        if name != event {
            return None;
        }
    }
    let tool_event = matches!(
        event,
        "PreToolUse" | "PostToolUse" | "PostToolUseFailure" | "PermissionRequest" | "PermissionDenied"
    );
    let mut rec = HookRecord {
        v: RECORD_VERSION,
        event: event.to_string(),
        t: now_us,
        claude_session_id: s
            .session_id
            .as_ref()
            .and_then(Value::as_str)
            .filter(|id| super::helper::valid_claude_session_id(id))
            .map(str::to_string),
        subagent: s.agent_id.as_ref().and_then(Value::as_str).is_some_and(|a| !a.is_empty()),
        ..HookRecord::default()
    };
    if tool_event {
        rec.tool = s.tool_name.as_ref().and_then(Value::as_str).filter(|n| valid_tool_name(n)).map(str::to_string);
    }
    match event {
        "Notification" => rec.notification = token(s.notification_type.as_ref(), 40),
        "StopFailure" => rec.detail = token(s.error.as_ref(), 40),
        "SessionStart" => rec.detail = token(s.source.as_ref(), 40),
        "SessionEnd" => rec.detail = token(s.reason.as_ref(), 40),
        "PostToolUseFailure" => rec.interrupt = s.is_interrupt.as_ref().and_then(Value::as_bool) == Some(true),
        _ => {}
    }
    Some(rec)
}

/// The state file must be `<base>\...\meter\<session>.hooks.json` (see [`super::helper::validate_data_file`]).
pub fn validate_state_path(path: &Path, base: &Path) -> Result<PathBuf, String> {
    super::helper::validate_data_file(path, base, &|name| session_of_hooks_name(name).is_some())
}

/// Capped read + parse of a state file. `None` for anything unexpected.
pub fn read_record(path: &Path) -> Option<HookRecord> {
    let f = std::fs::File::open(path).ok()?;
    if !f.metadata().ok()?.is_file() {
        return None;
    }
    let mut bytes = Vec::new();
    Read::take(f, super::MAX_RECORD_BYTES + 1).read_to_end(&mut bytes).ok()?;
    if bytes.len() as u64 > super::MAX_RECORD_BYTES {
        return None;
    }
    serde_json::from_slice(&bytes).ok()
}

/// Atomic write of `rec`, unless the file already holds a record from a helper that started later
/// (hooks run concurrently; the last one to finish isn't always the newest event).
pub fn write_if_newer(path: &Path, rec: &HookRecord) -> io::Result<bool> {
    if read_record(path).is_some_and(|cur| cur.t >= rec.t) {
        return Ok(false);
    }
    let bytes = serde_json::to_vec(rec).map_err(io::Error::other)?;
    super::write_atomic(path, &bytes)?;
    Ok(true)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HookArgs {
    pub event: String,
    pub state_file: PathBuf,
}

/// `<event> --state-file <path>` (the arguments after [`FLAG`]).
pub fn parse_args(args: &[String]) -> Result<HookArgs, String> {
    let mut it = args.iter();
    let event = it.next().ok_or("the event name is required")?;
    if !EVENTS.contains(&event.as_str()) {
        return Err(format!("unknown hook event {event:?}"));
    }
    let mut state_file = None;
    while let Some(a) = it.next() {
        match a.as_str() {
            STATE_FILE_FLAG => state_file = Some(PathBuf::from(it.next().ok_or("--state-file needs a value")?)),
            other => return Err(format!("unknown argument {other:?}")),
        }
    }
    Ok(HookArgs { event: event.clone(), state_file: state_file.ok_or("--state-file is required")? })
}

/// The helper. Never prints, always returns 0. `base` = the allowed data folder (`None`: nothing is written).
pub fn run(args: &[String], input: &mut dyn Read, base: Option<&Path>, now_us: u64) -> i32 {
    if let Ok(a) = parse_args(args) {
        if let (Some(rec), Some(base)) = (extract(&a.event, input, now_us), base) {
            if let Ok(path) = validate_state_path(&a.state_file, base) {
                let _ = write_if_newer(&path, &rec);
            }
        }
    }
    // Take the rest of stdin so Claude Code's write never fails on a closed pipe.
    let _ = io::copy(&mut Read::take(&mut *input, MAX_INPUT), &mut io::sink());
    0
}

/// Whether this process was started as the hook helper.
pub fn is_invocation(arg1: Option<&OsStr>) -> bool {
    arg1.is_some_and(|a| a == FLAG)
}

/// `main()` entry: runs the helper when argv[1] is [`FLAG`] and returns its exit code (always 0).
pub fn main_from_env() -> Option<i32> {
    let t = now_us();
    let mut args = std::env::args_os();
    let _exe = args.next();
    let first = args.next();
    if !is_invocation(first.as_deref()) {
        return None;
    }
    let rest: Vec<String> = args.map(|a| a.to_string_lossy().into_owned()).collect();
    let base = super::helper::allowed_base();
    let stdin = io::stdin();
    Some(run(&rest, &mut stdin.lock(), base.as_deref(), t))
}

/// The `hooks` value of the injected settings file: per event one matcher group with one async
/// command hook. Paths use forward slashes and are quoted for `sh` only when needed (as the status line).
pub fn hooks_json(exe: &Path, state_file: &Path, sh: &StatusShell) -> Result<Value, String> {
    let program = shell::command_path(exe);
    let file = shell::command_path(state_file);
    let mut map = serde_json::Map::new();
    for ev in EVENTS {
        let args = [FLAG.to_string(), (*ev).to_string(), STATE_FILE_FLAG.to_string(), file.clone()];
        let command = shell::command_line(sh, &program, &args)?;
        let handler = json!({ "type": "command", "command": command, "async": true, "timeout": HOOK_TIMEOUT_S });
        let group = if MATCHER_EVENTS.contains(ev) {
            json!({ "matcher": "*", "hooks": [handler] })
        } else {
            json!({ "hooks": [handler] })
        };
        map.insert((*ev).to_string(), json!([group]));
    }
    Ok(Value::Object(map))
}

// ---------------------------------------------------------------------------
// Host: per-pane state machine
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HookState {
    /// A session started (or `/clear`ed): hooks work, nothing is running.
    Ready,
    /// A turn is running (prompt submitted, a tool finished, a subagent finished).
    Working,
    /// A tool is running (`tool` names it).
    Tool,
    /// Claude asks for permission to use `tool`. Never type into it.
    Permission,
    /// Claude waits on a question, a plan approval or an MCP input dialog. Never type into it.
    Input,
    /// Claude finished about 60 s ago and the user hasn't typed since.
    IdlePrompt,
    /// The turn ended (`reason`: none = finished, `interrupt`, or a stop failure type).
    Stopped,
    /// The Claude session ended (`/clear`, exit, ...).
    Ended,
}

impl HookState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ready => "ready",
            Self::Working => "working",
            Self::Tool => "tool",
            Self::Permission => "permission",
            Self::Input => "input",
            Self::IdlePrompt => "idle-prompt",
            Self::Stopped => "stopped",
            Self::Ended => "ended",
        }
    }
}

/// One state change for the UI.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HookUpdate {
    pub state: HookState,
    pub tool: Option<String>,
    pub reason: Option<String>,
    /// `Stopped`: how long the turn took (from the prompt), when known.
    pub active_ms: Option<u64>,
}

impl HookUpdate {
    fn new(state: HookState, tool: Option<String>) -> Self {
        Self { state, tool, reason: None, active_ms: None }
    }

    fn because(state: HookState, reason: Option<String>) -> Self {
        Self { state, tool: None, reason, active_ms: None }
    }

    pub fn to_attention(&self, id: &str) -> SessionAttention {
        SessionAttention {
            id: id.to_string(),
            kind: AttentionKind::Hook,
            title: None,
            body: None,
            status: Some(self.state.as_str().to_string()),
            reason: self.reason.clone(),
            active_ms: self.active_ms,
            tool: self.tool.clone(),
        }
    }

    fn same_as(&self, other: &HookUpdate) -> bool {
        self.state == other.state && self.tool == other.tool && self.reason == other.reason
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WaitKind {
    Permission,
    Input,
}

#[derive(Debug, Clone)]
struct Wait {
    kind: WaitKind,
    tool: Option<String>,
    /// When the prompt was first reported (µs).
    t: u64,
}

/// Hook state of one pane run (reset at each launch).
#[derive(Debug, Default)]
pub struct PaneHooks {
    /// Newest record applied (µs); older ones are stale.
    last_t: u64,
    wait: Option<Wait>,
    recent_tool: Option<(String, u64)>,
    turn_start: Option<u64>,
    shown: Option<HookUpdate>,
}

/// Keys that answer a prompt: Enter, Esc, Ctrl+C, a digit or y / n.
pub fn is_answer_key(data: &[u8]) -> bool {
    data.contains(&b'\r')
        || data.contains(&0x03)
        || data == b"\x1b"
        || (data.len() == 1 && (data[0].is_ascii_digit() || b"yYnN".contains(&data[0])))
}

/// Keys that interrupt a running turn in Claude Code: Esc, Ctrl+C.
pub fn is_interrupt_key(data: &[u8]) -> bool {
    data == b"\x1b" || data.contains(&0x03)
}

impl PaneHooks {
    /// The last state shown to the UI.
    pub fn state(&self) -> Option<HookState> {
        self.shown.as_ref().map(|u| u.state)
    }

    pub fn is_waiting(&self) -> bool {
        self.wait.is_some()
    }

    fn recent(&self, t: u64) -> Option<String> {
        self.recent_tool.as_ref().filter(|(_, at)| t.saturating_sub(*at) <= RECENT_TOOL_US).map(|(n, _)| n.clone())
    }

    fn show(&mut self, u: HookUpdate) -> Option<HookUpdate> {
        if self.shown.as_ref().is_some_and(|s| s.same_as(&u)) {
            return None;
        }
        self.shown = Some(u.clone());
        Some(u)
    }

    /// Apply one record. Returns the change to show, if any.
    pub fn apply(&mut self, rec: &HookRecord) -> Option<HookUpdate> {
        if rec.t <= self.last_t {
            return None;
        }
        self.last_t = rec.t;
        let t = rec.t;
        let tool = rec.tool.clone();
        let next = match rec.event.as_str() {
            "SessionStart" | "SessionEnd" => {
                self.wait = None;
                self.turn_start = None;
                self.recent_tool = None;
                let state = if rec.event == "SessionStart" { HookState::Ready } else { HookState::Ended };
                Some(HookUpdate::because(state, rec.detail.clone()))
            }
            "UserPromptSubmit" => {
                self.wait = None;
                self.turn_start = Some(t);
                Some(HookUpdate::new(HookState::Working, None))
            }
            "PreToolUse" => {
                if let Some(name) = &tool {
                    self.recent_tool = Some((name.clone(), t));
                }
                if let Some(w) = &self.wait {
                    // The prompt still stands: the prompting call reported late, or another call of its batch.
                    if w.tool == tool || t < w.t + SAME_BATCH_US {
                        return None;
                    }
                }
                self.wait = None;
                if tool.as_deref().is_some_and(|n| ASKING_TOOLS.contains(&n)) {
                    self.wait = Some(Wait { kind: WaitKind::Input, tool: tool.clone(), t });
                    Some(HookUpdate::new(HookState::Input, tool))
                } else {
                    Some(HookUpdate::new(HookState::Tool, tool))
                }
            }
            "PermissionRequest" => {
                let tool = tool.or_else(|| self.recent(t));
                self.wait = Some(Wait { kind: WaitKind::Permission, tool: tool.clone(), t });
                Some(HookUpdate::new(HookState::Permission, tool))
            }
            "Notification" => match rec.notification.as_deref() {
                // Sent about 6 s after the prompt appeared, if nobody typed: the prompt is still up.
                Some("permission_prompt") => {
                    let prev = self.wait.as_ref().filter(|w| w.kind == WaitKind::Permission);
                    let tool = prev.and_then(|w| w.tool.clone()).or_else(|| self.recent(t));
                    let since = prev.map_or(t, |w| w.t);
                    self.wait = Some(Wait { kind: WaitKind::Permission, tool: tool.clone(), t: since });
                    Some(HookUpdate::new(HookState::Permission, tool))
                }
                Some("elicitation_dialog" | "elicitation_url_dialog") => {
                    self.wait = Some(Wait { kind: WaitKind::Input, tool: None, t });
                    Some(HookUpdate::new(HookState::Input, None))
                }
                Some("elicitation_complete" | "elicitation_response") => {
                    if self.wait.as_ref().is_some_and(|w| w.kind == WaitKind::Input && w.tool.is_none()) {
                        self.wait = None;
                        Some(HookUpdate::new(HookState::Working, None))
                    } else {
                        None
                    }
                }
                Some("idle_prompt") if self.wait.is_none() => Some(HookUpdate::new(HookState::IdlePrompt, None)),
                _ => None,
            },
            "PostToolUse" | "PostToolUseFailure" => {
                if rec.interrupt {
                    self.wait = None;
                    self.turn_start = None;
                    Some(HookUpdate::because(HookState::Stopped, Some("interrupt".into())))
                } else {
                    match self.wait.as_ref().map(|w| w.tool.is_none() || w.tool == tool) {
                        // The waiting call finished (approved, answered).
                        Some(true) => {
                            self.wait = None;
                            Some(HookUpdate::new(HookState::Working, None))
                        }
                        // Another call of the batch finished; the prompt still stands.
                        Some(false) => None,
                        None => Some(HookUpdate::new(HookState::Working, None)),
                    }
                }
            }
            "PermissionDenied" => {
                if self.wait.as_ref().is_some_and(|w| w.tool == tool) {
                    self.wait = None;
                }
                self.wait.is_none().then(|| HookUpdate::new(HookState::Working, None))
            }
            "SubagentStop" => self.wait.is_none().then(|| HookUpdate::new(HookState::Working, None)),
            "Stop" => {
                self.wait = None;
                let active_ms = self.turn_start.take().map(|s| t.saturating_sub(s) / 1000);
                Some(HookUpdate { state: HookState::Stopped, tool: None, reason: None, active_ms })
            }
            "StopFailure" => {
                self.wait = None;
                self.turn_start = None;
                Some(HookUpdate::because(HookState::Stopped, Some(rec.detail.clone().unwrap_or_else(|| "error".into()))))
            }
            _ => None,
        };
        next.and_then(|u| self.show(u))
    }

    /// The user typed into the pane. While a prompt waits, an answering key ends the wait (Esc / Ctrl+C
    /// decline and stop the turn); while Claude works, Esc / Ctrl+C interrupt it (Claude Code reports
    /// neither through a hook).
    pub fn on_input(&mut self, data: &[u8]) -> Option<HookUpdate> {
        if let Some(w) = &self.wait {
            if !is_answer_key(data) {
                return None;
            }
            let kind = w.kind;
            let tool = w.tool.clone();
            self.wait = None;
            if is_interrupt_key(data) {
                self.turn_start = None;
                return self.show(HookUpdate::because(HookState::Stopped, Some("interrupt".into())));
            }
            return match kind {
                WaitKind::Permission => self.show(HookUpdate::new(HookState::Tool, tool)),
                WaitKind::Input => self.show(HookUpdate::new(HookState::Working, None)),
            };
        }
        if matches!(self.state(), Some(HookState::Working | HookState::Tool)) && is_interrupt_key(data) {
            self.turn_start = None;
            return self.show(HookUpdate::because(HookState::Stopped, Some("interrupt".into())));
        }
        None
    }
}

#[cfg(test)]
#[path = "hooks_tests.rs"]
mod tests;
