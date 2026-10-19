//! Agent browser: agents drive ONE shared Chromium-family browser (a tab per agent) through MCP tools,
//! and the user watches each tab live inside Gridkeeper and can take over.
//!
//! Research and the comparison with Playwright MCP / chrome-devtools-mcp:
//! `docs/research-notes/agent-browser.md`. Moving parts:
//!
//! - **Browser** ([`chrome`]): Microsoft Edge, Google Chrome or Chromium, started by the Gridkeeper
//!   host on first use, headless, with an isolated profile in `<data>\agent-browser\profile` and
//!   `--remote-debugging-pipe` (no debugging port: only Gridkeeper holds the pipe). Contained like a
//!   session (Windows: its own kill-on-close Job Object; macOS / Linux: its own POSIX session).
//!   Stopped after `idleMinutes` without tool calls, when no agent has a tab, and on app exit.
//! - **CDP** ([`cdp`]): NUL-delimited JSON over the two pipes, flat sessions.
//! - **Tabs** ([`hub`]): each opted-in session gets its own browser context (separate cookies and
//!   storage) with one page; tools act only on that page. Popups are closed and reported.
//! - **MCP helper** ([`mcp`]): `gridkeeper --gk-mcp-browser --session <id> --endpoint <name>`,
//!   started by the agent CLI as a stdio MCP server (dual-era: `initialize` and `server/discover`).
//!   It holds no browser connection: every tool call goes to the host over a per-user named pipe
//!   (Unix: a socket in a 0700 folder) ([`ipc`]), authenticated by a per-launch token AND by the
//!   connecting process being inside that session's process tree.
//! - **Injection** ([`launch`]): Claude Code gets `--mcp-config=<data>\agent-browser\mcp-<session>.json`
//!   (additive: the user's own servers stay), Codex gets `-c mcp_servers.gk-browser.*` overrides.
//!   Nothing is written into agent homes or user config.
//! - **Safety** ([`policy`]): navigation is http / https / about:blank only; submitting a form or running
//!   a script on a host outside the allowlist (default: loopback, plus this machine's private
//!   addresses on a session's dev-server port), every file upload and every download wait for the
//!   user's answer in Gridkeeper; every action is logged to the session activity log.
//! - **Opt-in** ([`config`]): `<data>\agent-browser\config.json` (sessions, allowlist, idle minutes).

pub mod app;
pub mod cdp;
pub mod chrome;
pub mod config;
pub mod hub;
pub mod ipc;
pub mod launch;
pub mod mcp;
pub mod model;
pub mod policy;
pub mod tools;

mod actions;
mod events;
mod page;

#[cfg(test)]
mod tests;

use std::path::{Path, PathBuf};

pub use hub::{Hub, hub, shutdown};

/// Folder inside the data folder.
pub const DIR_NAME: &str = "agent-browser";
/// MCP server name the agents see (Claude Code: `mcp__gk-browser__browser_navigate`).
pub const SERVER_NAME: &str = "gk-browser";
/// argv[1] that selects the MCP helper mode.
pub const HELPER_FLAG: &str = "--gk-mcp-browser";
/// Environment variable that carries the per-launch token to the helper (set through the MCP config).
pub const TOKEN_ENV: &str = "GK_AGENT_BROWSER_TOKEN";

pub fn dir(data_dir: &Path) -> PathBuf {
    data_dir.join(DIR_NAME)
}

/// Gridkeeper session ids usable in file names and on helper command lines: `[A-Za-z0-9_-]{1,64}`.
pub fn valid_session_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

pub fn now_ms() -> u64 {
    crate::meter::now_ms()
}
