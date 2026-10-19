//! Per-process MCP injection for the agent browser (no user config is edited).
//!
//! - **Claude Code**: `--mcp-config=<data>\agent-browser\mcp-<session>.json`. Servers from
//!   `--mcp-config` are added to the user's own (user / project / local scopes stay; only
//!   `--strict-mcp-config` would drop them, and Gridkeeper never passes it). The `=` form is used
//!   because the flag is variadic (`--mcp-config <configs...>`): a following positional argument
//!   (a prompt in the session's own args) would otherwise be read as a second config.
//!   Skipped when an enterprise `managed-mcp.json` exists: Claude Code then refuses to start with
//!   any dynamic MCP configuration.
//! - **Codex**: `-c mcp_servers.gk-browser.<key>=<TOML>` overrides (a session-flags layer merged key
//!   by key over `config.toml`, so the user's `[mcp_servers.*]` stay). They go before any subcommand
//!   (`resume`). `tool_timeout_sec = 600` because a tool call may wait for the user's confirmation;
//!   values are TOML literal strings (`'...'`), which also pass cmd.exe when Codex is an npm shim.
//!
//! The token travels in the server's `env` (not on the helper's command line, so `/mcp` listings
//! don't show it); it only authorizes this launch and is rotated on every start.

use std::path::{Path, PathBuf};

use serde_json::json;

use super::{HELPER_FLAG, SERVER_NAME, TOKEN_ENV};

/// Codex: how long one tool call may take (a confirmation prompt waits up to 2 minutes, a take-over
/// up to 9).
pub const CODEX_TOOL_TIMEOUT_SEC: u32 = 600;
pub const CODEX_STARTUP_TIMEOUT_SEC: u32 = 20;

/// What a launch needs to reach the host.
#[derive(Debug, Clone)]
pub struct Injection<'a> {
    /// The helper executable (this binary).
    pub exe: &'a Path,
    pub session_id: &'a str,
    /// Named pipe name (Windows) or socket path (Unix).
    pub endpoint: &'a str,
    pub token: &'a str,
}

pub fn helper_args(inj: &Injection<'_>) -> Vec<String> {
    vec![HELPER_FLAG.into(), "--session".into(), inj.session_id.into(), "--endpoint".into(), inj.endpoint.into()]
}

/// The file `--mcp-config` points at.
pub fn claude_mcp_json(inj: &Injection<'_>) -> String {
    let server = json!({
        "type": "stdio",
        "command": inj.exe.to_string_lossy(),
        "args": helper_args(inj),
        "env": { TOKEN_ENV: inj.token },
    });
    let mut servers = serde_json::Map::new();
    servers.insert(SERVER_NAME.into(), server);
    json!({ "mcpServers": servers }).to_string()
}

pub fn claude_args(config_file: &Path) -> Vec<String> {
    vec![format!("--mcp-config={}", config_file.to_string_lossy())]
}

pub fn config_file_name(session_id: &str) -> String {
    format!("mcp-{session_id}.json")
}

/// A TOML string: literal (`'...'`) when possible, else a basic string with escapes. `None` when
/// only a basic string works and `literal_only` is set (cmd.exe would mangle `"`).
pub fn toml_string(s: &str, literal_only: bool) -> Option<String> {
    if !s.contains('\'') && !s.chars().any(char::is_control) {
        return Some(format!("'{s}'"));
    }
    if literal_only {
        return None;
    }
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if c.is_control() => out.push_str(&format!("\\u{:04X}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    Some(out)
}

/// `-c key=value` pairs for Codex. `via_cmd`: Codex runs through an npm `.cmd` shim, so only
/// cmd-safe values are possible.
pub fn codex_args(inj: &Injection<'_>, via_cmd: bool) -> Result<Vec<String>, String> {
    let lit = |s: &str| toml_string(s, via_cmd).ok_or_else(|| format!("{s:?} can't be passed through the codex.cmd shim"));
    let key = format!("mcp_servers.{SERVER_NAME}");
    let exe = inj.exe.to_string_lossy();
    let args = helper_args(inj).iter().map(|a| lit(a)).collect::<Result<Vec<_>, _>>()?;
    let pairs = [
        format!("{key}.command={}", lit(&exe)?),
        format!("{key}.args=[{}]", args.join(",")),
        format!("{key}.env.{TOKEN_ENV}={}", lit(inj.token)?),
        format!("{key}.startup_timeout_sec={CODEX_STARTUP_TIMEOUT_SEC}"),
        format!("{key}.tool_timeout_sec={CODEX_TOOL_TIMEOUT_SEC}"),
    ];
    let mut out = Vec::with_capacity(pairs.len() * 2);
    for p in pairs {
        out.push("-c".to_string());
        out.push(p);
    }
    if via_cmd {
        crate::adapters::discovery::validate_cmd_args(&out).map_err(|e| e.to_string())?;
    }
    Ok(out)
}

/// Claude Code's enterprise MCP file. When present, Claude Code exits on any `--mcp-config`.
pub fn claude_managed_mcp_paths() -> Vec<PathBuf> {
    let mut v = Vec::new();
    #[cfg(windows)]
    {
        let pf = std::env::var_os("ProgramFiles").map(PathBuf::from).unwrap_or_else(|| r"C:\Program Files".into());
        v.push(pf.join("ClaudeCode").join("managed-mcp.json"));
        let pd = std::env::var_os("ProgramData").map(PathBuf::from).unwrap_or_else(|| r"C:\ProgramData".into());
        v.push(pd.join("ClaudeCode").join("managed-mcp.json"));
    }
    #[cfg(target_os = "macos")]
    v.push(PathBuf::from("/Library/Application Support/ClaudeCode/managed-mcp.json"));
    #[cfg(all(unix, not(target_os = "macos")))]
    v.push(PathBuf::from("/etc/claude-code/managed-mcp.json"));
    v
}

/// Which CLI is being launched.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Cli {
    Claude,
    Codex,
}

/// Called by the Claude adapter: arguments to add (empty when the session has no browser).
pub fn prepare_claude(spec: &crate::types::SessionSpec, via_cmd: bool) -> Vec<String> {
    super::hub().map(|h| h.prepare_launch(&spec.id, Cli::Claude, via_cmd)).unwrap_or_default()
}

/// Called by the Codex adapter before any subcommand: arguments to add (empty when off).
pub fn prepare_codex(spec: &crate::types::SessionSpec, via_cmd: bool) -> Vec<String> {
    super::hub().map(|h| h.prepare_launch(&spec.id, Cli::Codex, via_cmd)).unwrap_or_default()
}
