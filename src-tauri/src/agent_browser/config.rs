//! `<data>\agent-browser\config.json`: which sessions get a browser, the user's allowlist and the idle
//! timeout. Owned by this module (the workspace file and its IPC types are untouched), read leniently
//! (a damaged file means defaults), written atomically.

use std::io::Read;
use std::path::Path;

use serde::{Deserialize, Serialize};

use super::policy;

pub const FILE_NAME: &str = "config.json";
pub const VERSION: u32 = 1;
/// Config files larger than this are ignored.
const MAX_BYTES: u64 = 256 * 1024;
/// Most opted-in sessions remembered.
pub const MAX_SESSIONS: usize = 512;
pub const DEFAULT_IDLE_MINUTES: u32 = 10;
pub const MAX_IDLE_MINUTES: u32 = 240;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    pub version: u32,
    /// Sessions given a browser ("Give this agent a browser"). Applied when the agent is launched.
    pub sessions: Vec<String>,
    /// Hosts where forms may be submitted and scripts run without asking (see `policy`).
    pub allowlist: Vec<String>,
    /// Stop the shared browser after this many minutes without a tool call and without a viewer.
    pub idle_minutes: u32,
    /// Run the browser with a visible window instead of headless (advanced, file only).
    pub show_window: bool,
    /// Browser executable to use instead of the detected Edge / Chrome / Chromium (advanced, file only).
    pub browser_path: Option<String>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            version: VERSION,
            sessions: Vec::new(),
            allowlist: Vec::new(),
            idle_minutes: DEFAULT_IDLE_MINUTES,
            show_window: false,
            browser_path: None,
        }
    }
}

impl Config {
    /// Read `path`; defaults when missing, too large or unparseable (never fails).
    pub fn load(path: &Path) -> Self {
        let Some(bytes) = read_capped(path) else { return Self::default() };
        let bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(&bytes);
        match serde_json::from_slice::<Config>(bytes) {
            Ok(mut c) => {
                c.sanitize();
                c
            }
            Err(e) => {
                tracing::warn!(error = %e, "agent browser config unreadable; using defaults");
                Self::default()
            }
        }
    }

    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let text = serde_json::to_string_pretty(self).map_err(std::io::Error::other)?;
        crate::meter::write_atomic(path, text.as_bytes())
    }

    /// Valid ids only (deduplicated, capped), canonical allowlist, idle minutes in range.
    pub fn sanitize(&mut self) {
        self.version = VERSION;
        let mut seen: Vec<String> = Vec::new();
        for id in self.sessions.drain(..) {
            if super::valid_session_id(&id) && !seen.contains(&id) && seen.len() < MAX_SESSIONS {
                seen.push(id);
            }
        }
        self.sessions = seen;
        self.allowlist = policy::normalize_allowlist(&self.allowlist);
        self.idle_minutes = self.idle_minutes.clamp(1, MAX_IDLE_MINUTES);
        if self.browser_path.as_deref().is_some_and(|p| p.trim().is_empty()) {
            self.browser_path = None;
        }
    }

    pub fn enabled(&self, id: &str) -> bool {
        self.sessions.iter().any(|s| s == id)
    }

    /// Turn the browser on / off for a session. Returns whether anything changed.
    pub fn set_session(&mut self, id: &str, on: bool) -> bool {
        let has = self.enabled(id);
        if on && !has && super::valid_session_id(id) && self.sessions.len() < MAX_SESSIONS {
            self.sessions.push(id.to_string());
            true
        } else if !on && has {
            self.sessions.retain(|s| s != id);
            true
        } else {
            false
        }
    }

    /// Forget sessions that no longer exist (startup, against the saved workspaces). Returns the count.
    pub fn prune(&mut self, existing: &[String]) -> usize {
        let before = self.sessions.len();
        self.sessions.retain(|s| existing.contains(s));
        before - self.sessions.len()
    }

    /// Add one entry (an "always allow" answer). Returns whether it was new.
    pub fn allow(&mut self, entry: &str) -> bool {
        match policy::normalize_entry(entry) {
            Some(n) if !self.allowlist.contains(&n) && self.allowlist.len() < policy::MAX_ALLOW_ENTRIES => {
                self.allowlist.push(n);
                true
            }
            _ => false,
        }
    }
}

fn read_capped(path: &Path) -> Option<Vec<u8>> {
    let f = std::fs::File::open(path).ok()?;
    if !f.metadata().ok()?.is_file() {
        return None;
    }
    let mut bytes = Vec::new();
    f.take(MAX_BYTES + 1).read_to_end(&mut bytes).ok()?;
    (bytes.len() as u64 <= MAX_BYTES).then_some(bytes)
}
