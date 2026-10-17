//! Agent adapters: how to find, launch and resume each kind of agent.
//!
//! Every agent is one `AgentAdapter` implementation registered in
//! [`ADAPTERS`]. Adding an agent = add an `AgentKind` variant, one impl file
//! and one registry entry; `detect` and `resolve_launch` pick it up
//! automatically.
//!
//! `resolve_launch` produces a [`LaunchPlan`]: program, args, environment
//! changes and cwd. The PTY layer applies `env_remove` then `env_set` on top
//! of the app's own environment.

pub mod catalog;
mod claude;
mod codex;
pub mod discovery;
mod generic;
mod powershell;
pub mod process;

use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::profiles::ProfileStore;
use crate::types::*;

pub use claude::{transcript_exists as claude_transcript_exists, CLAUDE_IDENTITY_ENV};
pub use discovery::Executable;

/// What an adapter supports (surfaced to the UI via `detect` in future versions).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Capabilities {
    /// Can continue / resume a previous conversation.
    pub supports_resume: bool,
    /// Uses accounts (`SessionSpec.profile_id`: CLAUDE_CONFIG_DIR / CODEX_HOME).
    pub supports_profiles: bool,
}

/// Inputs available to an adapter while building a launch plan.
pub struct LaunchContext<'a> {
    pub spec: &'a SessionSpec,
    pub profiles: &'a ProfileStore,
    pub settings: &'a Settings,
}

/// One agent type.
pub trait AgentAdapter: Send + Sync {
    fn kind(&self) -> AgentKind;
    fn display_name(&self) -> &'static str;
    fn capabilities(&self) -> Capabilities;

    /// The executable override configured in settings for this agent, if any.
    fn settings_override<'s>(&self, _settings: &'s Settings) -> Option<&'s str> {
        None
    }

    /// Find the executable without any user override. `None` = not installed.
    fn discover(&self) -> Option<Executable>;

    /// Arguments used to query the version in `detect`. `None` = no version probe.
    fn version_args(&self, _exe: &Executable) -> Option<Vec<String>> {
        Some(vec!["--version".into()])
    }

    /// Adapter-specific arguments and environment (resume flags, profile env, ...).
    /// User arguments from the spec are appended by the caller afterwards.
    fn configure(&self, ctx: &LaunchContext<'_>, exe: &Executable, plan: &mut PlanBuilder) -> AppResult<()>;
}

/// The adapter registry. Order = order shown by `detect`.
pub static ADAPTERS: &[&dyn AgentAdapter] = &[
    &powershell::PowerShellAdapter,
    &claude::ClaudeAdapter,
    &codex::CodexAdapter,
    &generic::GenericAdapter,
];

pub fn adapter_for(kind: AgentKind) -> &'static dyn AgentAdapter {
    ADAPTERS
        .iter()
        .copied()
        .find(|a| a.kind() == kind)
        .expect("every AgentKind has a registered adapter")
}

/// Resolve the executable for `kind`: explicit `command` → settings override → discovery.
pub fn resolve_executable(kind: AgentKind, settings: &Settings, command: Option<&str>) -> AppResult<Executable> {
    let adapter = adapter_for(kind);
    if let Some(cmd) = command.map(str::trim).filter(|c| !c.is_empty()) {
        return discovery::resolve_user_program(cmd);
    }
    if let Some(ov) = adapter.settings_override(settings).map(str::trim).filter(|c| !c.is_empty()) {
        return discovery::resolve_user_program(ov);
    }
    adapter
        .discover()
        .ok_or_else(|| AppError::MissingExecutable(format!("{} is not installed or not on PATH", adapter.display_name())))
}

// ---------------------------------------------------------------------------
// Plan builder
// ---------------------------------------------------------------------------

/// Accumulates args and environment changes. Environment keys compare
/// case-insensitively (Windows semantics); a later `set` cancels an earlier
/// `remove` of the same key and vice versa.
#[derive(Debug, Default)]
pub struct PlanBuilder {
    pub args: Vec<String>,
    env_set: Vec<(String, String)>,
    env_remove: Vec<String>,
}

impl PlanBuilder {
    pub fn arg(&mut self, a: impl Into<String>) -> &mut Self {
        self.args.push(a.into());
        self
    }

    pub fn set_env(&mut self, key: impl Into<String>, value: impl Into<String>) -> &mut Self {
        let key = key.into();
        self.env_remove.retain(|k| !k.eq_ignore_ascii_case(&key));
        if let Some(slot) = self.env_set.iter_mut().find(|(k, _)| k.eq_ignore_ascii_case(&key)) {
            *slot = (key, value.into());
        } else {
            self.env_set.push((key, value.into()));
        }
        self
    }

    pub fn remove_env(&mut self, key: impl Into<String>) -> &mut Self {
        let key = key.into();
        self.env_set.retain(|(k, _)| !k.eq_ignore_ascii_case(&key));
        if !self.env_remove.iter().any(|k| k.eq_ignore_ascii_case(&key)) {
            self.env_remove.push(key);
        }
        self
    }

    pub fn env_value(&self, key: &str) -> Option<&str> {
        self.env_set.iter().find(|(k, _)| k.eq_ignore_ascii_case(key)).map(|(_, v)| v.as_str())
    }

    pub fn is_removed(&self, key: &str) -> bool {
        self.env_remove.iter().any(|k| k.eq_ignore_ascii_case(key))
    }
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/// Conversation ids passed to agents: UUID-ish only (hex and dashes, 8..=64 chars).
pub fn validate_session_id(id: &str) -> AppResult<()> {
    let ok = (8..=64).contains(&id.len()) && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-');
    if ok {
        Ok(())
    } else {
        Err(AppError::Invalid(format!("Invalid conversation id: {id:?}")))
    }
}

fn validate_spec(spec: &SessionSpec) -> AppResult<PathBuf> {
    if spec.cwd.contains('\0') {
        return Err(AppError::Invalid("Working directory contains a NUL character".into()));
    }
    let cwd = PathBuf::from(spec.cwd.trim());
    if spec.cwd.trim().is_empty() || !cwd.is_dir() {
        return Err(AppError::Invalid(format!("Working directory does not exist: {}", spec.cwd)));
    }
    if spec.args.iter().any(|a| a.contains('\0')) {
        return Err(AppError::Invalid("Arguments must not contain NUL characters".into()));
    }
    for EnvVar { key, value } in &spec.env {
        if key.is_empty() || key.contains('=') || key.contains('\0') {
            return Err(AppError::Invalid(format!("Invalid environment variable name: {key:?}")));
        }
        if value.contains('\0') {
            return Err(AppError::Invalid(format!("Environment variable {key} contains a NUL character")));
        }
    }
    Ok(cwd)
}

fn quote_for_display(s: &str) -> String {
    if s.is_empty() || s.contains(char::is_whitespace) || s.contains('"') {
        format!("\"{}\"", s.replace('"', "\\\""))
    } else {
        s.to_string()
    }
}

/// Redacted, human-readable command line.
pub fn display_command(program: &Path, args: &[String]) -> String {
    let mut parts = vec![quote_for_display(&program.to_string_lossy())];
    parts.extend(args.iter().map(|a| quote_for_display(a)));
    crate::redact::redact(&parts.join(" "))
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Resolve executable, arguments, environment and cwd for a session.
pub fn resolve_launch(spec: &SessionSpec, profiles: &ProfileStore, settings: &Settings) -> AppResult<LaunchPlan> {
    let cwd = validate_spec(spec)?;
    let adapter = adapter_for(spec.agent);
    let has_command = !spec.command.as_deref().map(str::trim).unwrap_or("").is_empty();
    let preset = match spec.preset.as_deref().filter(|p| !p.is_empty()) {
        Some(id) if spec.agent == AgentKind::Generic => Some(
            catalog::entry(id).ok_or_else(|| AppError::Invalid(format!("Unknown agent preset '{id}'")))?,
        ),
        _ => None,
    };
    if spec.agent == AgentKind::Generic && !has_command && preset.is_none() {
        return Err(AppError::Invalid("A command is required for a generic session".into()));
    }
    let exe = match preset {
        // Catalog tool: an explicit command (custom path) wins, else PATH discovery.
        Some(entry) if !has_command => catalog::discover(entry)
            .ok_or_else(|| AppError::MissingExecutable(format!("{} is not installed or not on PATH", entry.name)))?,
        _ => resolve_executable(spec.agent, settings, spec.command.as_deref())?,
    };

    let mut plan = PlanBuilder::default();
    plan.set_env("TERM", "xterm-256color")
        .set_env("COLORTERM", "truecolor")
        .set_env("TERM_PROGRAM", "Gridkeeper")
        .set_env("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION"))
        .remove_env("WT_SESSION")
        .remove_env("WT_PROFILE_ID");
    // If Gridkeeper itself was launched from inside a Claude Code session, that session's internal
    // variables (session id, messaging socket/TOKEN, entrypoint...) would leak into every child and
    // make a nested `claude` believe it is a sub-session (e.g. "Transcript saving is off").
    for key in inherited_agent_session_vars(std::env::vars().map(|(k, _)| k)) {
        plan.remove_env(key);
    }

    let ctx = LaunchContext { spec, profiles, settings };
    match preset {
        Some(entry) => {
            plan.args.extend(catalog::launch_args(entry, &spec.resume)?);
            // Catalog tools with account support (e.g. Hermes → HERMES_HOME).
            if let Some(id) = spec.profile_id.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                let acct_spec = crate::accounts::spec_for(AgentKind::Generic, Some(entry.id))
                    .ok_or_else(|| AppError::Invalid(format!("{} has no account isolation", entry.name)))?;
                let account = crate::accounts::resolve_account(profiles, acct_spec, id)?;
                crate::accounts::apply_launch_env(acct_spec, &account, &mut plan)?;
            }
        }
        None => adapter.configure(&ctx, &exe, &mut plan)?,
    }
    plan.args.extend(spec.args.iter().cloned());

    // User environment last: it may intentionally override anything above,
    // including re-adding a variable an adapter removed.
    for EnvVar { key, value } in &spec.env {
        plan.set_env(key.clone(), value.clone());
    }

    let (program, mut args) = exe.program_and_prefix();
    if exe.via_cmd {
        discovery::validate_cmd_args(&plan.args)?;
    }
    args.extend(plan.args);
    let display = display_command(&program, &args);
    Ok(LaunchPlan { program, args, env_set: plan.env_set, env_remove: plan.env_remove, cwd, display })
}

/// Names of inherited variables that belong to a *parent* agent session, not to the user's environment.
/// `CLAUDE_CONFIG_DIR` is deliberately not included (handled per profile by the Claude adapter).
pub fn inherited_agent_session_vars(names: impl Iterator<Item = String>) -> Vec<String> {
    const EXACT: &[&str] = &["CLAUDECODE", "CLAUDE_PID", "CLAUDE_EFFORT", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_EXECPATH", "CLAUDE_CODE_SSE_PORT", "CLAUDE_CODE_CHILD_SESSION"];
    const PREFIXES: &[&str] = &["CLAUDE_CODE_SESSION_", "CLAUDE_CODE_MESSAGING_"];
    names
        .filter(|k| {
            let u = k.to_ascii_uppercase();
            EXACT.contains(&u.as_str()) || PREFIXES.iter().any(|p| u.starts_with(p)) || u == "CLAUDE_CODE_SESSION_ID"
        })
        .collect()
}

const VERSION_TIMEOUT: Duration = Duration::from_secs(10);

fn detect_one(adapter: &dyn AgentAdapter, settings: &Settings) -> AgentAvailability {
    let kind = adapter.kind();
    let exe = match resolve_executable(kind, settings, None) {
        Ok(exe) => exe,
        Err(e) => {
            // Generic has no executable of its own; that is not an error.
            let error = if kind == AgentKind::Generic { None } else { Some(e.to_string()) };
            return AgentAvailability { error, ..base(kind) };
        }
    };
    let path = Some(exe.path.to_string_lossy().into_owned());
    let Some(vargs) = adapter.version_args(&exe) else {
        return AgentAvailability { path, ..base(kind) };
    };
    let (program, mut args) = exe.program_and_prefix();
    args.extend(vargs);
    let mut cmd = process::hidden_command(&program);
    cmd.args(&args);
    // Never let an inherited config dir or key influence a version probe.
    cmd.env_remove("CLAUDE_CONFIG_DIR");
    match process::run_with_timeout(cmd, VERSION_TIMEOUT) {
        Ok(out) => {
            let version = process::first_line(&out.stdout).or_else(|| process::first_line(&out.stderr));
            let error = (!out.status.success() && version.is_none())
                .then(|| format!("`--version` exited with {}", out.status));
            AgentAvailability { path, version: version.map(|v| crate::redact::redact(&v)), error, ..base(kind) }
        }
        Err(e) => AgentAvailability { path, error: Some(e.to_string()), ..base(kind) },
    }
}

fn base(kind: AgentKind) -> AgentAvailability {
    AgentAvailability {
        kind,
        path: None,
        version: None,
        error: None,
        preset: None,
        label: None,
        supports_resume: adapter_for(kind).capabilities().supports_resume,
    }
}

/// Probe one catalog tool already found on PATH. Broken npm shims fail here (their package is gone).
fn detect_catalog(entry: &catalog::CatalogEntry, exe: Executable) -> AgentAvailability {
    let path = Some(exe.path.to_string_lossy().into_owned());
    let (program, mut args) = exe.program_and_prefix();
    args.push("--version".into());
    let mut cmd = process::hidden_command(&program);
    cmd.args(&args);
    let (version, error) = match process::run_with_timeout(cmd, VERSION_TIMEOUT) {
        Ok(out) => {
            let v = process::first_line(&out.stdout).filter(|_| out.status.success());
            let err = v.is_none().then(|| format!("not working (version check exited with {})", out.status));
            (v.map(|v| crate::redact::redact(&v)), err)
        }
        Err(e) => (None, Some(e.to_string())),
    };
    AgentAvailability {
        kind: AgentKind::Generic,
        path,
        version,
        error,
        preset: Some(entry.id.to_string()),
        label: Some(entry.name.to_string()),
        supports_resume: entry.continue_args.is_some() || entry.session_flag.is_some(),
    }
}

/// Discover installed agent executables and versions (probes run in parallel).
pub fn detect(settings: &Settings) -> Vec<AgentAvailability> {
    std::thread::scope(|s| {
        let handles: Vec<_> = ADAPTERS
            .iter()
            .map(|a| {
                let a = *a;
                (a.kind(), s.spawn(move || detect_one(a, settings)))
            })
            .collect();
        // Only tools actually on PATH are probed and listed (no clutter for uninstalled ones).
        let tools: Vec<_> = catalog::CATALOG
            .iter()
            .filter_map(|e| catalog::discover(e).map(|exe| (e, exe)))
            .map(|(e, exe)| s.spawn(move || detect_catalog(e, exe)))
            .collect();
        let mut out: Vec<AgentAvailability> = handles
            .into_iter()
            .map(|(kind, h)| {
                h.join().unwrap_or_else(|_| AgentAvailability { error: Some("detection panicked".into()), ..base(kind) })
            })
            .collect();
        out.extend(tools.into_iter().filter_map(|h| h.join().ok()));
        out
    })
}

#[cfg(test)]
mod tests;
