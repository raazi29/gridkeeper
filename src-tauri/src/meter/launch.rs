//! Claude launch side of the meter: decide whether a pane is metered, write its settings file and
//! hand the Claude adapter the `--settings` argument.
//!
//! Reads (read-only, config only, never credentials or transcripts) to keep the user's own status
//! line working: `statusLine` and `disableAllHooks` from the account's `settings.json` (under its
//! `CLAUDE_CONFIG_DIR`, or `~/.claude`) and the project's `.claude/settings.json` /
//! `.claude/settings.local.json`; `statusLine` / `allowManagedHooksOnly` / `disableAllHooks` from
//! Claude Code's managed settings files. Only those keys are deserialized; the rest of each file is
//! skipped by the parser. Nothing is ever written into the agent's home or the project.

use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::Value;

use super::helper;
use super::shell::{self, StatusShell};
use crate::types::{MeterStatus, SessionSpec, Settings};

/// Claude settings files larger than this are not looked at.
const MAX_SETTINGS_BYTES: u64 = 1024 * 1024;

pub const NOTE_CUSTOM_SETTINGS: &str = "meter off: custom --settings";

pub struct LaunchInput<'a> {
    /// Gridkeeper's session id (names the meter files).
    pub session_id: &'a str,
    /// The session's own extra arguments.
    pub user_args: &'a [String],
    pub cwd: &'a Path,
    /// The account's Claude config folder (`CLAUDE_CONFIG_DIR` or `~/.claude`).
    pub config_root: Option<&'a Path>,
    pub meter_dir: &'a Path,
    /// The helper executable.
    pub exe: &'a Path,
    pub shell: &'a StatusShell,
    pub managed: &'a [PathBuf],
}

#[derive(Debug, Clone, PartialEq)]
pub enum LaunchDecision {
    Inject {
        settings_path: PathBuf,
        /// `{"statusLine":{...}}`: exactly what `--settings` points at.
        settings_json: String,
        chained: bool,
        note: Option<String>,
    },
    Skip {
        status: MeterStatus,
        note: String,
    },
}

/// The session already passes its own `--settings` (then Gridkeeper stays out of the way).
pub fn user_passes_settings(args: &[String]) -> bool {
    args.iter().any(|a| a == "--settings" || a.starts_with("--settings="))
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct SettingsSubset {
    #[serde(rename = "statusLine")]
    status_line: Option<Value>,
    #[serde(rename = "disableAllHooks")]
    disable_all_hooks: Option<bool>,
    #[serde(rename = "allowManagedHooksOnly")]
    allow_managed_hooks_only: Option<bool>,
}

fn read_subset(path: &Path) -> Option<SettingsSubset> {
    let f = std::fs::File::open(path).ok()?;
    if !f.metadata().ok()?.is_file() {
        return None;
    }
    let mut bytes = Vec::new();
    f.take(MAX_SETTINGS_BYTES + 1).read_to_end(&mut bytes).ok()?;
    if bytes.len() as u64 > MAX_SETTINGS_BYTES {
        return None;
    }
    let bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(&bytes);
    serde_json::from_slice(bytes).ok()
}

/// The status line the user would see without Gridkeeper (effective across their settings files).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct UserStatusLine {
    /// `statusLine.command` when the effective status line is a command.
    pub command: Option<String>,
    /// Claude's `disableAllHooks` is on (status lines don't run at all).
    pub hooks_disabled: bool,
}

/// Settings files in Claude Code's precedence order, highest first (below managed and `--settings`).
pub fn settings_files(config_root: Option<&Path>, cwd: &Path) -> Vec<PathBuf> {
    let mut v = vec![cwd.join(".claude").join("settings.local.json"), cwd.join(".claude").join("settings.json")];
    if let Some(root) = config_root {
        v.push(root.join("settings.json"));
    }
    v
}

pub fn user_status_line(config_root: Option<&Path>, cwd: &Path) -> UserStatusLine {
    let mut out = UserStatusLine::default();
    let mut status_seen = false;
    let mut hooks_seen = false;
    for path in settings_files(config_root, cwd) {
        let Some(s) = read_subset(&path) else { continue };
        if !status_seen {
            if let Some(sl) = s.status_line {
                status_seen = true;
                let is_command = sl.get("type").and_then(Value::as_str).is_none_or(|t| t == "command");
                out.command = sl
                    .get("command")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|c| is_command && !c.is_empty())
                    .map(str::to_string);
            }
        }
        if !hooks_seen {
            if let Some(d) = s.disable_all_hooks {
                hooks_seen = true;
                out.hooks_disabled = d;
            }
        }
    }
    out
}

/// Claude Code's managed settings files (best effort: MDM, registry and server-managed policies
/// can't be seen from here).
pub fn default_managed_paths() -> Vec<PathBuf> {
    let mut v = Vec::new();
    #[cfg(windows)]
    {
        let pf = std::env::var_os("ProgramFiles").map(PathBuf::from).unwrap_or_else(|| r"C:\Program Files".into());
        v.push(pf.join("ClaudeCode").join("managed-settings.json"));
        let pd = std::env::var_os("ProgramData").map(PathBuf::from).unwrap_or_else(|| r"C:\ProgramData".into());
        v.push(pd.join("ClaudeCode").join("managed-settings.json"));
    }
    #[cfg(target_os = "macos")]
    v.push(PathBuf::from("/Library/Application Support/ClaudeCode/managed-settings.json"));
    #[cfg(all(unix, not(target_os = "macos")))]
    v.push(PathBuf::from("/etc/claude-code/managed-settings.json"));
    v
}

/// Why managed settings keep Gridkeeper's status line from running, if they do.
pub fn managed_block(managed: &[PathBuf]) -> Option<String> {
    for path in managed {
        let Some(s) = read_subset(path) else { continue };
        if s.status_line.is_some_and(|v| !v.is_null()) {
            return Some("meter unavailable: your organization's managed settings set the status line".into());
        }
        if s.allow_managed_hooks_only == Some(true) || s.disable_all_hooks == Some(true) {
            return Some("meter unavailable: your organization's managed settings turn off status line commands".into());
        }
    }
    None
}

/// The `statusLine.command` Claude Code runs: `<exe> --gk-statusline --meter-file <file> [--chain-b64 <b64>]`,
/// paths with forward slashes, quoted for `shell` only when needed.
pub fn statusline_command(exe: &Path, meter_file: &Path, chain: Option<&str>, sh: &StatusShell) -> Result<String, String> {
    let mut args = vec![helper::FLAG.to_string(), helper::METER_FILE_FLAG.to_string(), shell::command_path(meter_file)];
    if let Some(c) = chain {
        args.push(helper::CHAIN_FLAG.to_string());
        args.push(helper::encode_chain(c));
    }
    shell::command_line(sh, &shell::command_path(exe), &args)
}

/// The whole `--settings` file: only `statusLine` (every other key keeps its file-based value).
pub fn settings_json(command: &str) -> String {
    serde_json::json!({ "statusLine": { "type": "command", "command": command, "padding": 0 } }).to_string()
}

pub fn decide(input: &LaunchInput<'_>) -> LaunchDecision {
    let skip = |status, note: &str| LaunchDecision::Skip { status, note: note.to_string() };
    if user_passes_settings(input.user_args) {
        return skip(MeterStatus::CustomSettings, NOTE_CUSTOM_SETTINGS);
    }
    if !super::valid_session_id(input.session_id) {
        return skip(MeterStatus::Unavailable, "meter unavailable: this session id can't name a file");
    }
    if let Some(reason) = managed_block(input.managed) {
        return skip(MeterStatus::Managed, &reason);
    }
    let user = user_status_line(input.config_root, input.cwd);
    if user.hooks_disabled {
        return skip(MeterStatus::Unavailable, "meter off: Claude's disableAllHooks setting turns status lines off");
    }
    let mut notes = Vec::new();
    let chain = match user.command {
        Some(c) if c.contains(helper::FLAG) => None, // never chain to ourselves
        Some(c) if c.len() > helper::MAX_CHAIN_COMMAND => {
            notes.push("your own status line command is longer than 4 KiB, so it is hidden in this pane while the meter is on");
            None
        }
        other => other,
    };
    let meter_file = input.meter_dir.join(super::record_name(input.session_id));
    let command = match statusline_command(input.exe, &meter_file, chain.as_deref(), input.shell) {
        Ok(c) => c,
        Err(_) => {
            return skip(
                MeterStatus::Unavailable,
                "meter unavailable: Gridkeeper's install or data folder path contains a quote or control character",
            );
        }
    };
    LaunchDecision::Inject {
        settings_path: input.meter_dir.join(super::settings_name(input.session_id)),
        settings_json: settings_json(&command),
        chained: chain.is_some(),
        note: (!notes.is_empty()).then(|| notes.join("; ")),
    }
}

/// Called by the Claude adapter while it builds the launch plan. Returns the settings file to pass
/// with `--settings`, or `None` (meter off, not available, or the pane passes its own `--settings`).
/// Every outcome is reported to the UI through the hub.
pub fn prepare_claude(spec: &SessionSpec, settings: &Settings, config_root: Option<&Path>, via_cmd: bool) -> Option<PathBuf> {
    if !settings.cost_meter {
        return None;
    }
    let hub = super::hub()?;
    let unavailable = |note: &str| {
        hub.note_launch(&spec.id, MeterStatus::Unavailable, Some(note.to_string()), false);
        None
    };
    let Some(exe) = hub.exe() else {
        return unavailable("meter unavailable: Gridkeeper could not locate its own executable");
    };
    // The session's own environment wins over the app's (as in the launched process).
    let env = |k: &str| {
        spec.env
            .iter()
            .rev()
            .find(|e| e.key.eq_ignore_ascii_case(k))
            .map(|e| e.value.clone())
            .filter(|v| !v.trim().is_empty())
            .or_else(|| shell::process_env(k))
    };
    let sh = shell::detect(&env);
    let input = LaunchInput {
        session_id: &spec.id,
        user_args: &spec.args,
        cwd: Path::new(spec.cwd.trim()),
        config_root,
        meter_dir: hub.dir(),
        exe,
        shell: &sh,
        managed: hub.managed_settings(),
    };
    match decide(&input) {
        LaunchDecision::Inject { settings_path, settings_json, chained, note } => {
            let arg = settings_path.to_string_lossy().into_owned();
            if via_cmd && crate::adapters::discovery::validate_cmd_args(std::slice::from_ref(&arg)).is_err() {
                return unavailable("meter unavailable: the data folder path can't pass through the claude.cmd shim");
            }
            if let Err(e) = std::fs::create_dir_all(hub.dir()).and_then(|()| super::write_atomic(&settings_path, settings_json.as_bytes())) {
                tracing::warn!(error = %e, "could not write the meter settings file");
                return unavailable("meter unavailable: could not write its settings file");
            }
            hub.note_launch(&spec.id, MeterStatus::Metered, note, chained);
            Some(settings_path)
        }
        LaunchDecision::Skip { status, note } => {
            hub.note_launch(&spec.id, status, Some(note), false);
            None
        }
    }
}
