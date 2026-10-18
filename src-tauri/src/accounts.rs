//! Accounts for every agent CLI that supports an isolated home directory.
//!
//! An *account* is a home directory selected with the agent's own, documented environment
//! variable. The records live in `profiles.json` (see [`crate::profiles::ProfileStore`]);
//! this module holds the per-agent spec table, home discovery, the official status commands
//! and the launch environment.
//!
//! | agent  | home env          | default home                 | extra homes                 | status command        |
//! |--------|-------------------|------------------------------|-----------------------------|-----------------------|
//! | Claude | CLAUDE_CONFIG_DIR | `~/.claude`                  | `~/.claude-*`               | `claude auth status --json` |
//! | Codex  | CODEX_HOME        | `~/.codex`                   | `~/.codex-*`                | `codex login status`  |
//! | Hermes | HERMES_HOME       | `%LOCALAPPDATA%\hermes` (macOS / Linux `~/.hermes`) | `<default>\profiles\<name>` | none (files present) |
//!
//! Verification (2026-10-17, this machine): CLAUDE_CONFIG_DIR — official docs + three isolated
//! logins in use. CODEX_HOME — official docs; `codex login status` prints `Logged in using …` /
//! `Not logged in` with exit code 0 / 1 (in a fresh home it may create its own PATH-alias helpers,
//! never credentials). HERMES_HOME —
//! official profile docs + `hermes_constants.py` (Windows default `%LOCALAPPDATA%\hermes`, named
//! profiles under `<root>\profiles\<name>`). Other installed agent CLIs have no documented home
//! variable (Kimi CLI 0.53 hard-codes `~/.kimi`) and are reported as "no account isolation".
//!
//! Default accounts: launching an agent's *default* account REMOVES its home variable (Claude,
//! Codex), so the agent uses its documented platform default; for Hermes it is SET to the resolved
//! default, as Hermes asks spawners to pass HERMES_HOME explicitly. A home variable inherited from the environment
//! that points somewhere else is discovered as an account of its own ("from CODEX_HOME").
//!
//! Security: everything here is directory listing and file-EXISTENCE checks by name. No file
//! under an account home is ever opened, read, copied, modified or deleted. Status comes only
//! from each CLI's own status command; e-mails it prints go to the UI only (never logged or
//! persisted), and only the login method word is kept from Codex output (an API-key login
//! prints a masked key fragment, which is discarded).

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

use once_cell::sync::Lazy;
use regex::Regex;
use serde::Serialize;

use crate::adapters::{self, catalog, discovery, process, PlanBuilder};
use crate::profiles::ProfileStore;
use crate::types::*;

pub const STATUS_TIMEOUT: Duration = Duration::from_secs(15);
pub const CODEX_NOT_SIGNED_IN: &str = "Not signed in — use Sign in (runs `codex login` for this account)";
pub const HERMES_NO_STATUS: &str = "Hermes has no login status command; status is based on which files exist";

/// Where an agent's default home lives.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DefaultHome {
    /// `<user home>\<name>`.
    UserHome(&'static str),
    /// `<%LOCALAPPDATA%>\<name>`.
    LocalAppData(&'static str),
}

/// Where additional homes of an agent are found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Siblings {
    /// Directories `<user home>\<prefix><suffix>`; the suffix names the account.
    HomePrefix(&'static str),
    /// Directories `<default home>\<subdir>\<name>` (names starting with '.' skipped).
    DefaultSubdir(&'static str),
}

/// How the DEFAULT account's home variable is handled at launch.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DefaultEnv {
    /// Remove it, so the agent uses its own default (Claude: also keeps `.claude.json` in the
    /// user profile; Codex: `~/.codex` is created by Codex when missing).
    Remove,
    /// Set it to the resolved default home (Hermes asks spawners to pass HERMES_HOME explicitly,
    /// otherwise a sticky non-default profile triggers its "HERMES_HOME fallback" warning).
    SetResolved,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StatusKind {
    ClaudeAuthStatus,
    CodexLoginStatus,
    /// No status command: existence of `likely_auth_markers` only.
    None,
}

/// One agent with account support.
pub struct AccountSpec {
    /// Stable key: the AgentKind name, or the catalog preset id.
    pub key: &'static str,
    pub agent: AgentKind,
    pub preset: Option<&'static str>,
    pub label: &'static str,
    /// Environment variable that selects the home directory.
    pub home_env: &'static str,
    pub default_home: DefaultHome,
    pub default_env: DefaultEnv,
    pub siblings: Siblings,
    /// Groups of file/dir names; a directory is a usable home when ALL names of ANY group exist.
    pub markers: &'static [&'static [&'static str]],
    /// Names whose existence suggests a stored login (never opened).
    pub likely_auth_markers: &'static [&'static str],
    pub status: StatusKind,
    /// Environment variables that would override the home's own login. Always stripped for
    /// status checks; at launch see `strip_identity_at_launch`.
    pub identity_env: &'static [&'static str],
    /// Arguments of the agent's official sign-in flow (empty = start the agent interactively).
    pub login_args: &'static [&'static str],
    /// Alternative sign-in for machines without a browser.
    pub device_login_args: Option<&'static [&'static str]>,
    /// Shown to the user while the sign-in pane runs.
    pub login_hint: &'static str,
    /// Whether the sign-in flow was exercised end to end (false = documented only).
    pub login_verified: bool,
}

pub static SPECS: &[AccountSpec] = &[
    AccountSpec {
        key: "claude",
        agent: AgentKind::Claude,
        preset: None,
        label: "Claude Code",
        home_env: "CLAUDE_CONFIG_DIR",
        default_home: DefaultHome::UserHome(".claude"),
        default_env: DefaultEnv::Remove,
        siblings: Siblings::HomePrefix(".claude-"),
        // A credentials file is conclusive; a bare settings.json is not (tool dirs like
        // .claude-mem have their own), so it must come with Claude's state file or transcripts.
        markers: &[&[".credentials.json"], &["settings.json", ".claude.json"], &["settings.json", "projects"]],
        likely_auth_markers: &[".credentials.json"],
        status: StatusKind::ClaudeAuthStatus,
        identity_env: adapters::CLAUDE_IDENTITY_ENV,
        login_args: &[],
        device_login_args: None,
        login_hint: "Type /login in this pane and finish signing in in your browser.",
        login_verified: true,
    },
    AccountSpec {
        key: "codex",
        agent: AgentKind::Codex,
        preset: None,
        label: "Codex",
        home_env: "CODEX_HOME",
        default_home: DefaultHome::UserHome(".codex"),
        default_env: DefaultEnv::Remove,
        siblings: Siblings::HomePrefix(".codex-"),
        markers: &[&["auth.json"], &["config.toml"]],
        likely_auth_markers: &["auth.json"],
        status: StatusKind::CodexLoginStatus,
        identity_env: &["OPENAI_API_KEY", "CODEX_API_KEY"],
        login_args: &["login"],
        device_login_args: Some(&["login", "--device-auth"]),
        login_hint: "Finish signing in in your browser; this pane closes when Codex reports success.",
        login_verified: false,
    },
    AccountSpec {
        key: "hermes",
        agent: AgentKind::Generic,
        preset: Some("hermes"),
        label: "Hermes Agent",
        home_env: "HERMES_HOME",
        // Windows: %LOCALAPPDATA%\hermes (hermes_constants.py). macOS / Linux: ~/.hermes (Hermes'
        // documented default there; not yet verified on a real install by this project).
        default_home: if cfg!(windows) { DefaultHome::LocalAppData("hermes") } else { DefaultHome::UserHome(".hermes") },
        default_env: DefaultEnv::SetResolved,
        siblings: Siblings::DefaultSubdir("profiles"),
        markers: &[&["config.yaml"], &["auth.json"], &[".env"]],
        likely_auth_markers: &["auth.json", ".env"],
        status: StatusKind::None,
        identity_env: &[],
        login_args: &["setup"],
        device_login_args: None,
        login_hint: "Follow the Hermes setup wizard (choose a provider and sign in).",
        login_verified: false,
    },
];

/// The spec for an agent (and catalog preset), if it supports accounts.
pub fn spec_for(agent: AgentKind, preset: Option<&str>) -> Option<&'static AccountSpec> {
    match agent {
        AgentKind::Generic => {
            let p = preset?;
            SPECS.iter().find(|s| s.agent == AgentKind::Generic && s.preset == Some(p))
        }
        _ => SPECS.iter().find(|s| s.agent == agent),
    }
}

pub fn spec_of(account: &Account) -> Option<&'static AccountSpec> {
    spec_for(account.agent, account.preset.as_deref())
}

/// Codex: identity variables are stripped at launch only for NAMED accounts. The default account
/// keeps the user's environment unchanged (someone relying on an exported key keeps working);
/// a named account must not be silently overridden by a global key. Claude strips always
/// (existing behaviour, see adapters/claude.rs).
pub fn strip_identity_at_launch(spec: &AccountSpec, is_default: bool) -> bool {
    match spec.agent {
        AgentKind::Codex => !is_default,
        _ => !spec.identity_env.is_empty(),
    }
}

// ---------------------------------------------------------------------------
// Environment used for discovery (injectable for tests)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default)]
pub struct ScanEnv {
    pub home: Option<PathBuf>,
    pub local_app_data: Option<PathBuf>,
    /// Inherited home variables (name, value), e.g. ("CODEX_HOME", "D:\\codex").
    pub inherited: Vec<(String, String)>,
}

impl ScanEnv {
    /// The real environment of this process.
    pub fn current() -> Self {
        let inherited = SPECS
            .iter()
            .filter_map(|s| std::env::var(s.home_env).ok().map(|v| (s.home_env.to_string(), v)))
            .collect();
        Self { home: discovery::home_dir(), local_app_data: discovery::local_app_data(), inherited }
    }

    /// Only a user home (tests, `ProfileStore::load_with_home`): local app data follows the
    /// standard Windows layout under it and nothing is inherited.
    pub fn with_home(home: Option<PathBuf>) -> Self {
        let local_app_data = home.as_ref().map(|h| h.join("AppData").join("Local"));
        Self { home, local_app_data, inherited: Vec::new() }
    }

    fn var(&self, key: &str) -> Option<&str> {
        self.inherited
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(key))
            .map(|(_, v)| v.trim())
            .filter(|v| !v.is_empty())
    }
}

/// The agent's documented default home on this machine.
pub fn default_home(spec: &AccountSpec, env: &ScanEnv) -> Option<PathBuf> {
    match spec.default_home {
        DefaultHome::UserHome(name) => env.home.as_ref().map(|h| h.join(name)),
        DefaultHome::LocalAppData(name) => env.local_app_data.as_ref().map(|l| l.join(name)),
    }
}

/// Home directory an account resolves to.
pub fn resolve_home(spec: &AccountSpec, config_dir: Option<&str>, env: &ScanEnv) -> Option<PathBuf> {
    match config_dir.map(str::trim).filter(|d| !d.is_empty()) {
        Some(d) => Some(PathBuf::from(d)),
        None => default_home(spec, env),
    }
}

/// Lower-cased, separator-normalized form for equality checks.
#[cfg(windows)]
pub fn normalize_dir(p: &str) -> String {
    let canon = std::fs::canonicalize(p)
        .map(|c| c.to_string_lossy().trim_start_matches(r"\\?\").to_string())
        .unwrap_or_else(|_| p.to_string());
    canon.replace('/', "\\").trim_end_matches('\\').to_lowercase()
}

/// Canonical form for equality checks: symlinks resolved, no trailing `/`. Case is kept on Linux
/// (case-sensitive file systems) and folded on macOS (APFS / HFS+ are case-insensitive by default).
#[cfg(not(windows))]
pub fn normalize_dir(p: &str) -> String {
    let canon = std::fs::canonicalize(p).map(|c| c.to_string_lossy().into_owned()).unwrap_or_else(|_| p.to_string());
    let trimmed = if canon.len() > 1 { canon.trim_end_matches('/') } else { canon.as_str() };
    if cfg!(target_os = "macos") { trimmed.to_lowercase() } else { trimmed.to_string() }
}

/// Identity of an account's home for matching and the dismissed list:
/// `<key>:default` for the default home (also when named by its full path), else `<key>:<normalized path>`.
pub fn home_key(spec: &AccountSpec, config_dir: Option<&str>, env: &ScanEnv) -> String {
    let default = default_home(spec, env).map(|d| normalize_dir(&d.to_string_lossy()));
    match config_dir.map(str::trim).filter(|d| !d.is_empty()) {
        None => format!("{}:default", spec.key),
        Some(d) => {
            let n = normalize_dir(d);
            if default.as_deref() == Some(n.as_str()) {
                format!("{}:default", spec.key)
            } else {
                format!("{}:{n}", spec.key)
            }
        }
    }
}

/// Existence-only marker check.
pub fn has_markers(spec: &AccountSpec, dir: &Path) -> bool {
    spec.markers.iter().any(|group| group.iter().all(|name| dir.join(name).exists()))
}

/// Cheap, filename-only status.
pub fn cheap_status(spec: Option<&AccountSpec>, root: Option<&Path>) -> ProfileStatus {
    let dir_exists = root.is_some_and(Path::is_dir);
    let likely = dir_exists
        && root.is_some_and(|r| {
            spec.map(|s| s.likely_auth_markers).unwrap_or(&[".credentials.json"]).iter().any(|m| r.join(m).is_file())
        });
    ProfileStatus {
        dir_exists,
        likely_authenticated: likely,
        verified: false,
        note: (!dir_exists).then(|| "Directory does not exist".to_string()),
        ..Default::default()
    }
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HomeSource {
    Default,
    Sibling,
    /// Inherited home environment variable pointing elsewhere.
    Env,
}

#[derive(Debug, Clone)]
pub struct FoundHome {
    /// Suggested account name ("Default", folder suffix, ...).
    pub name: String,
    /// `None` = the default home.
    pub config_dir: Option<String>,
    pub path: PathBuf,
    pub exists: bool,
    pub source: HomeSource,
}

/// Find the default home, sibling homes (with marker files) and an inherited home variable.
pub fn discover(spec: &AccountSpec, env: &ScanEnv) -> Vec<FoundHome> {
    let mut out = Vec::new();
    let default = default_home(spec, env);
    if let Some(d) = &default {
        out.push(FoundHome { name: "Default".into(), config_dir: None, exists: d.is_dir(), path: d.clone(), source: HomeSource::Default });
    }
    let (parent, prefix) = match spec.siblings {
        Siblings::HomePrefix(p) => (env.home.clone(), p),
        Siblings::DefaultSubdir(sub) => (default.as_ref().map(|d| d.join(sub)), ""),
    };
    let mut siblings: Vec<FoundHome> = parent
        .and_then(|p| std::fs::read_dir(p).ok())
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let suffix = name.strip_prefix(prefix)?.to_string();
            if suffix.is_empty() || suffix.starts_with('.') || !e.file_type().ok()?.is_dir() {
                return None;
            }
            let path = e.path();
            has_markers(spec, &path).then(|| FoundHome {
                name: suffix,
                config_dir: Some(path.to_string_lossy().into_owned()),
                exists: true,
                path,
                source: HomeSource::Sibling,
            })
        })
        .collect();
    siblings.sort_by_key(|f| f.name.to_lowercase());
    out.extend(siblings);

    if let Some(v) = env.var(spec.home_env) {
        let p = PathBuf::from(v);
        let n = normalize_dir(v);
        let known = out.iter().any(|f| normalize_dir(&f.path.to_string_lossy()) == n);
        if p.is_absolute() && p.is_dir() && !known {
            let folder = p.file_name().map(|f| f.to_string_lossy().trim_start_matches('.').to_string()).unwrap_or_default();
            out.push(FoundHome {
                name: if folder.is_empty() { format!("from {}", spec.home_env) } else { folder },
                config_dir: Some(v.to_string()),
                exists: true,
                path: p,
                source: HomeSource::Env,
            });
        }
    }
    out
}

// ---------------------------------------------------------------------------
// New homes ("Add account")
// ---------------------------------------------------------------------------

/// Folder-safe form of an account name: lower-case ASCII letters, digits, '-' and '_'.
pub fn slug(name: &str) -> String {
    let mut s = String::new();
    for ch in name.trim().chars() {
        let c = ch.to_ascii_lowercase();
        if c.is_ascii_alphanumeric() || c == '_' {
            s.push(c);
        } else if (c == '-' || c.is_whitespace() || c == '.') && !s.ends_with('-') {
            s.push('-');
        }
    }
    s.trim_matches('-').chars().take(40).collect::<String>().trim_end_matches('-').to_string()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannedHome {
    pub path: String,
    pub exists: bool,
    /// Exists and has no entries (listing only).
    pub empty: bool,
}

/// Where "Add account" puts a new home for `name`.
pub fn planned_home(spec: &AccountSpec, name: &str, env: &ScanEnv) -> AppResult<PathBuf> {
    let s = slug(name);
    if s.is_empty() {
        return Err(AppError::Invalid("Use at least one letter or digit in the account name".into()));
    }
    let base = match spec.siblings {
        Siblings::HomePrefix(prefix) => env.home.as_ref().map(|h| h.join(format!("{prefix}{s}"))),
        Siblings::DefaultSubdir(sub) => default_home(spec, env).map(|d| d.join(sub).join(&s)),
    };
    base.ok_or_else(|| AppError::Other("Could not determine the user's home folder".into()))
}

pub fn describe_home(path: &Path) -> PlannedHome {
    let exists = path.exists();
    let empty = path.is_dir() && std::fs::read_dir(path).map(|mut r| r.next().is_none()).unwrap_or(false);
    PlannedHome { path: path.to_string_lossy().into_owned(), exists, empty }
}

// ---------------------------------------------------------------------------
// Launch
// ---------------------------------------------------------------------------

/// Look up an account for a launch and make sure it belongs to this agent.
pub fn resolve_account(store: &ProfileStore, spec: &AccountSpec, id: &str) -> AppResult<Account> {
    let account = store.get_account(id).ok_or_else(|| AppError::NotFound(format!("Account {id}")))?;
    if account.agent != spec.agent || (spec.preset.is_some() && account.preset.as_deref() != spec.preset) {
        return Err(AppError::Invalid(format!(
            "Account {:?} belongs to another agent, not {}",
            account.name, spec.label
        )));
    }
    Ok(account)
}

/// Set the home variable (named account), or for the default account remove it / set it to the
/// resolved default per `AccountSpec::default_env`. A named home must exist
/// (Codex refuses a CODEX_HOME that does not). Returns the resolved home.
pub fn apply_launch_env(spec: &AccountSpec, account: &Account, plan: &mut PlanBuilder) -> AppResult<Option<PathBuf>> {
    let dir = account.config_dir.as_deref().map(str::trim).filter(|d| !d.is_empty());
    let root = match dir {
        Some(d) => {
            let p = PathBuf::from(d);
            if !p.is_dir() {
                return Err(AppError::Invalid(format!("Account folder missing: {d}")));
            }
            plan.set_env(spec.home_env, d);
            Some(p)
        }
        None => {
            let resolved = account.resolved_dir.as_ref().map(PathBuf::from);
            match (spec.default_env, &resolved) {
                (DefaultEnv::SetResolved, Some(r)) => {
                    plan.set_env(spec.home_env, r.to_string_lossy().into_owned());
                }
                _ => {
                    plan.remove_env(spec.home_env);
                }
            }
            resolved
        }
    };
    if strip_identity_at_launch(spec, dir.is_none()) {
        for key in spec.identity_env {
            plan.remove_env(*key);
        }
    }
    Ok(root)
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

static EMAIL_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}").expect("email regex"));

/// Only the method word of a `Logged in using …` line; anything after it (e.g. a masked key) is dropped.
fn codex_method(rest: &str) -> Option<String> {
    let lower = rest.to_ascii_lowercase();
    let after = lower.trim().strip_prefix("using").unwrap_or(lower.trim()).trim();
    let head = after.split(" - ").next().unwrap_or("").split('(').next().unwrap_or("").trim();
    if head.contains("api key") || head.contains("apikey") {
        return Some("api_key".into());
    }
    if head.contains("chatgpt") {
        return Some("chatgpt".into());
    }
    if head.contains("access token") {
        return Some("access_token".into());
    }
    let word: String = head
        .trim_start_matches("an ")
        .trim_start_matches("a ")
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
        .take(24)
        .collect();
    (!word.is_empty()).then_some(word)
}

/// Interpret `codex login status` output (stdout and stderr). Pure; unit-tested.
pub fn parse_codex_status(stdout: &[u8], stderr: &[u8], exit_code: Option<i32>, base: ProfileStatus) -> ProfileStatus {
    let text = format!("{}\n{}", String::from_utf8_lossy(stdout), String::from_utf8_lossy(stderr));
    for line in text.lines().map(str::trim) {
        let lower = line.to_ascii_lowercase();
        if lower.starts_with("not logged in") {
            return ProfileStatus { verified: true, logged_in: Some(false), note: Some(CODEX_NOT_SIGNED_IN.into()), ..base };
        }
        if let Some(rest) = lower.strip_prefix("logged in") {
            let rest_orig = &line[line.len() - rest.len()..];
            let account = EMAIL_RE.find(rest_orig.split(" - ").next().unwrap_or("")).map(|m| m.as_str().to_string());
            return ProfileStatus {
                verified: true,
                logged_in: Some(true),
                auth_method: codex_method(rest),
                account,
                note: None,
                ..base
            };
        }
    }
    match exit_code {
        Some(0) => ProfileStatus { verified: true, logged_in: Some(true), note: None, ..base },
        Some(1) => ProfileStatus { verified: true, logged_in: Some(false), note: Some(CODEX_NOT_SIGNED_IN.into()), ..base },
        code => ProfileStatus {
            verified: false,
            note: Some(format!(
                "Could not read `codex login status` output (exit code {})",
                code.map(|c| c.to_string()).unwrap_or_else(|| "unknown".into())
            )),
            ..base
        },
    }
}

/// Environment for a status command: home variable set/removed, identity and inherited
/// parent-agent session variables stripped, neutral cwd, no console window.
fn status_command(spec: &AccountSpec, exe: &discovery::Executable, args: &[&str], config_dir: Option<&str>) -> std::process::Command {
    let (program, mut full) = exe.program_and_prefix();
    full.extend(args.iter().map(|s| s.to_string()));
    let mut cmd = process::hidden_command(&program);
    cmd.args(&full).current_dir(std::env::temp_dir());
    match config_dir.map(str::trim).filter(|d| !d.is_empty()) {
        Some(d) => {
            cmd.env(spec.home_env, d);
        }
        None => {
            cmd.env_remove(spec.home_env);
        }
    }
    for key in spec.identity_env {
        cmd.env_remove(key);
    }
    for key in adapters::inherited_agent_session_vars(std::env::vars().map(|(k, _)| k)) {
        cmd.env_remove(key);
    }
    cmd
}

/// Status of an account of any agent (Claude delegates to `profiles::check_status`).
pub fn check_status(account: &Account, settings: &Settings) -> AppResult<ProfileStatus> {
    let Some(spec) = spec_of(account) else {
        return Ok(ProfileStatus { note: Some("This agent has no account support".into()), ..Default::default() });
    };
    let root = account.resolved_dir.as_ref().map(PathBuf::from);
    let base = cheap_status(Some(spec), root.as_deref());
    match spec.status {
        StatusKind::ClaudeAuthStatus => crate::profiles::check_status(&account.profile, settings),
        StatusKind::None => Ok(ProfileStatus { note: base.note.clone().or_else(|| Some(HERMES_NO_STATUS.into())), ..base }),
        StatusKind::CodexLoginStatus => {
            if !base.dir_exists {
                let note = if account.config_dir.is_none() {
                    "Not signed in — ~/.codex does not exist yet (Sign in creates it)"
                } else {
                    "Directory does not exist"
                };
                return Ok(ProfileStatus { logged_in: Some(false), note: Some(note.into()), ..base });
            }
            let exe = adapters::resolve_executable(AgentKind::Codex, settings, None)?;
            let cmd = status_command(spec, &exe, &["login", "status"], account.config_dir.as_deref());
            let status = match process::run_with_timeout(cmd, STATUS_TIMEOUT) {
                Ok(out) => parse_codex_status(&out.stdout, &out.stderr, out.status.code(), base),
                Err(e) if e.kind() == std::io::ErrorKind::TimedOut => {
                    ProfileStatus { note: Some("`codex login status` timed out".into()), ..base }
                }
                Err(e) => return Err(AppError::Other(format!("Could not run Codex: {e}"))),
            };
            // Never log `status.account` (e-mail).
            tracing::info!(
                account = %account.id,
                verified = status.verified,
                logged_in = ?status.logged_in,
                auth_method = ?status.auth_method,
                "checked Codex account login status"
            );
            Ok(status)
        }
    }
}

/// Which account-capable agents are installed (executable found), by spec key.
pub fn installed_keys(settings: &Settings) -> HashSet<&'static str> {
    SPECS
        .iter()
        .filter(|s| match s.preset {
            Some(p) => catalog::entry(p).and_then(catalog::discover).is_some(),
            None => adapters::resolve_executable(s.agent, settings, None).is_ok(),
        })
        .map(|s| s.key)
        .collect()
}

pub const IN_USE_NOTE: &str = "In use by a running session — not re-checked (avoids racing its token refresh)";

/// Verified status for every account, in parallel (each check has its own 15 s timeout).
/// Accounts with a live session are not re-checked (Claude Code #91708: concurrent token
/// refreshes in one config dir can force a re-login); they keep the filename-based status.
pub fn check_all(accounts: Vec<Account>, settings: &Settings, busy: &HashSet<String>, installed: &HashSet<&'static str>) -> Vec<Account> {
    std::thread::scope(|s| {
        let handles: Vec<_> = accounts
            .into_iter()
            .map(|mut a| {
                s.spawn(move || {
                    let Some(spec) = spec_of(&a) else { return a };
                    if busy.contains(&a.id) {
                        a.status.note = Some(IN_USE_NOTE.into());
                    } else if !installed.contains(spec.key) {
                        a.status.note = Some(format!("{} is not installed", spec.label));
                    } else {
                        match check_status(&a, settings) {
                            Ok(st) => a.status = st,
                            Err(e) => a.status.note = Some(crate::redact::redact(&e.to_string())),
                        }
                    }
                    a
                })
            })
            .collect();
        handles.into_iter().filter_map(|h| h.join().ok()).collect()
    })
}

// ---------------------------------------------------------------------------
// Spec info for the UI
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountAgentInfo {
    pub key: String,
    pub agent: AgentKind,
    pub preset: Option<String>,
    pub label: String,
    /// "verified" = home variable documented + checked here; "none" = installed, no isolation.
    pub isolation: String,
    pub home_env: Option<String>,
    pub default_home: Option<String>,
    pub installed: bool,
    pub has_status_command: bool,
    pub login_args: Vec<String>,
    pub device_login_args: Option<Vec<String>>,
    pub login_hint: Option<String>,
    pub login_verified: bool,
    pub note: Option<String>,
}

/// Agents with account support, followed by installed catalog tools without isolation.
pub fn agent_infos(settings: &Settings, env: &ScanEnv) -> Vec<AccountAgentInfo> {
    let installed = installed_keys(settings);
    let own = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    let mut out: Vec<AccountAgentInfo> = SPECS
        .iter()
        .map(|s| AccountAgentInfo {
            key: s.key.into(),
            agent: s.agent,
            preset: s.preset.map(String::from),
            label: s.label.into(),
            isolation: "verified".into(),
            home_env: Some(s.home_env.into()),
            default_home: default_home(s, env).map(|p| p.to_string_lossy().into_owned()),
            installed: installed.contains(s.key),
            has_status_command: s.status != StatusKind::None,
            login_args: own(s.login_args),
            device_login_args: s.device_login_args.map(own),
            login_hint: Some(s.login_hint.into()),
            login_verified: s.login_verified,
            note: None,
        })
        .collect();
    for e in catalog::CATALOG.iter().filter(|e| spec_for(AgentKind::Generic, Some(e.id)).is_none()) {
        if catalog::discover(e).is_none() {
            continue;
        }
        out.push(AccountAgentInfo {
            key: e.id.into(),
            agent: AgentKind::Generic,
            preset: Some(e.id.into()),
            label: e.name.into(),
            isolation: "none".into(),
            home_env: None,
            default_home: None,
            installed: true,
            has_status_command: false,
            login_args: Vec::new(),
            device_login_args: None,
            login_hint: None,
            login_verified: false,
            note: Some("Detected install; no documented way to keep separate accounts — it uses its single login".into()),
        });
    }
    out
}

/// Hermes' default home under a (fake) user home, as `ScanEnv::with_home` resolves it.
#[cfg(test)]
pub(crate) fn test_hermes_root(home: &Path) -> PathBuf {
    if cfg!(windows) { home.join("AppData").join("Local").join("hermes") } else { home.join(".hermes") }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn touch(p: &Path) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, b"{}").unwrap();
    }

    fn spec(key: &str) -> &'static AccountSpec {
        SPECS.iter().find(|s| s.key == key).unwrap()
    }

    #[test]
    fn spec_lookup() {
        assert_eq!(spec_for(AgentKind::Claude, None).unwrap().home_env, "CLAUDE_CONFIG_DIR");
        assert_eq!(spec_for(AgentKind::Codex, None).unwrap().home_env, "CODEX_HOME");
        assert_eq!(spec_for(AgentKind::Generic, Some("hermes")).unwrap().home_env, "HERMES_HOME");
        assert!(spec_for(AgentKind::Generic, Some("kimi")).is_none());
        assert!(spec_for(AgentKind::Generic, None).is_none());
        assert!(spec_for(AgentKind::Powershell, None).is_none());
        // Every preset spec refers to a catalog entry with the same home variable.
        for s in SPECS.iter().filter(|s| s.preset.is_some()) {
            assert_eq!(catalog::entry(s.preset.unwrap()).unwrap().home_env, Some(s.home_env));
        }
    }

    #[test]
    fn discovers_codex_homes_by_markers() {
        let home = tempfile::tempdir().unwrap();
        let h = home.path();
        std::fs::create_dir_all(h.join(".codex")).unwrap();
        touch(&h.join(".codex-work").join("config.toml"));
        touch(&h.join(".codex-personal").join("auth.json"));
        std::fs::create_dir_all(h.join(".codex-empty")).unwrap(); // no markers → skipped
        std::fs::write(h.join(".codex-file"), b"x").unwrap(); // not a dir
        std::fs::create_dir_all(h.join(".codex-").join("x")).unwrap(); // empty suffix
        let env = ScanEnv::with_home(Some(h.to_path_buf()));
        let found = discover(spec("codex"), &env);
        let names: Vec<_> = found.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, vec!["Default", "personal", "work"]);
        assert!(found[0].config_dir.is_none() && found[0].exists && found[0].source == HomeSource::Default);
        assert!(found[1].config_dir.as_deref().unwrap().ends_with(".codex-personal"));
    }

    #[test]
    fn discovers_claude_like_before() {
        let home = tempfile::tempdir().unwrap();
        let h = home.path();
        touch(&h.join(".claude-a").join(".credentials.json"));
        touch(&h.join(".claude-b").join("settings.json"));
        std::fs::create_dir_all(h.join(".claude-b").join("projects")).unwrap();
        touch(&h.join(".claude-mem").join("settings.json")); // lone settings.json → tool dir
        let env = ScanEnv::with_home(Some(h.to_path_buf()));
        let found = discover(spec("claude"), &env);
        let names: Vec<_> = found.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, vec!["Default", "a", "b"]);
        assert!(!found[0].exists, "default listed even when ~/.claude is missing");
    }

    #[test]
    fn discovers_hermes_profiles_and_inherited_env() {
        let home = tempfile::tempdir().unwrap();
        let h = home.path();
        let root = test_hermes_root(h);
        assert_eq!(default_home(spec("hermes"), &ScanEnv::with_home(Some(h.to_path_buf()))), Some(root.clone()));
        touch(&root.join("config.yaml"));
        touch(&root.join("profiles").join("work").join("config.yaml"));
        std::fs::create_dir_all(root.join("profiles").join(".hidden")).unwrap();
        std::fs::create_dir_all(root.join("profiles").join("bare")).unwrap(); // no markers
        let elsewhere = h.join("custom-hermes");
        std::fs::create_dir_all(&elsewhere).unwrap();
        let mut env = ScanEnv::with_home(Some(h.to_path_buf()));
        env.inherited = vec![("HERMES_HOME".into(), elsewhere.to_string_lossy().into())];
        let found = discover(spec("hermes"), &env);
        let names: Vec<_> = found.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, vec!["Default", "work", "custom-hermes"]);
        assert_eq!(found[2].source, HomeSource::Env);

        // Inherited variable equal to the default home is not a separate account.
        env.inherited = vec![("HERMES_HOME".into(), root.to_string_lossy().into())];
        assert_eq!(discover(spec("hermes"), &env).len(), 2);
    }

    #[test]
    fn home_keys_and_slugs() {
        let home = tempfile::tempdir().unwrap();
        let env = ScanEnv::with_home(Some(home.path().to_path_buf()));
        let s = spec("codex");
        std::fs::create_dir_all(home.path().join(".codex")).unwrap();
        assert_eq!(home_key(s, None, &env), "codex:default");
        // The default home named by its full path is still the default.
        let full_default = home.path().join(".codex").to_string_lossy().into_owned();
        assert_eq!(home_key(s, Some(&full_default), &env), "codex:default");
        #[cfg(windows)]
        {
            // Windows paths compare case-insensitively, with either separator.
            assert_eq!(home_key(s, Some(&full_default.to_uppercase()), &env), "codex:default");
            assert!(home_key(s, Some(r"C:\x\.codex-work"), &env).starts_with("codex:c:\\x"));
        }
        #[cfg(not(windows))]
        assert_eq!(home_key(s, Some("/nonexistent/x/.codex-work/"), &env), "codex:/nonexistent/x/.codex-work");

        assert_eq!(slug("  Work Account! "), "work-account");
        assert_eq!(slug("a.b_c"), "a-b_c");
        assert_eq!(slug("###"), "");
        assert_eq!(
            planned_home(s, "Work", &env).unwrap(),
            home.path().join(".codex-work")
        );
        assert_eq!(
            planned_home(spec("hermes"), "Side Project", &env).unwrap(),
            test_hermes_root(home.path()).join("profiles").join("side-project")
        );
        assert!(planned_home(s, "!!", &env).is_err());
        let d = describe_home(&home.path().join(".codex"));
        assert!(d.exists && d.empty);
    }

    #[test]
    fn parses_codex_status() {
        let base = ProfileStatus { dir_exists: true, ..Default::default() };
        let s = parse_codex_status(b"Logged in using ChatGPT\n", b"", Some(0), base.clone());
        assert!(s.verified && s.logged_in == Some(true));
        assert_eq!(s.auth_method.as_deref(), Some("chatgpt"));
        assert!(s.account.is_none());

        // API-key logins print a masked key: only the method survives.
        let s = parse_codex_status(b"Logged in using an API key - sk-proj-***ABCDE\n", b"", Some(0), base.clone());
        assert_eq!(s.auth_method.as_deref(), Some("api_key"));
        let dump = format!("{s:?}");
        assert!(!dump.contains("sk-") && !dump.contains("ABCDE"), "{dump}");

        // Status on stderr after a warning line.
        let s = parse_codex_status(b"", b"WARNING: proceeding, even though ...\nNot logged in\n", Some(1), base.clone());
        assert!(s.verified && s.logged_in == Some(false));
        assert_eq!(s.note.as_deref(), Some(CODEX_NOT_SIGNED_IN));

        // A future format with an e-mail keeps it for the UI.
        let s = parse_codex_status(b"Logged in using ChatGPT (dev@example.com)\n", b"", Some(0), base.clone());
        assert_eq!(s.account.as_deref(), Some("dev@example.com"));
        assert_eq!(s.auth_method.as_deref(), Some("chatgpt"));

        // Exit-code fallbacks.
        assert_eq!(parse_codex_status(b"", b"", Some(0), base.clone()).logged_in, Some(true));
        assert_eq!(parse_codex_status(b"???", b"", Some(1), base.clone()).logged_in, Some(false));
        let s = parse_codex_status(b"boom", b"", Some(2), base);
        assert!(!s.verified && s.logged_in.is_none());
    }

    #[test]
    fn cheap_status_uses_spec_markers() {
        let dir = tempfile::tempdir().unwrap();
        let s = spec("codex");
        assert!(!cheap_status(Some(s), Some(dir.path())).likely_authenticated);
        touch(&dir.path().join("auth.json"));
        let st = cheap_status(Some(s), Some(dir.path()));
        assert!(st.dir_exists && st.likely_authenticated && !st.verified);
        let missing = cheap_status(Some(s), Some(&dir.path().join("nope")));
        assert!(!missing.dir_exists && missing.note.is_some());
    }

    #[test]
    fn identity_strip_rule() {
        assert!(!strip_identity_at_launch(spec("codex"), true));
        assert!(strip_identity_at_launch(spec("codex"), false));
        assert!(strip_identity_at_launch(spec("claude"), true));
        assert!(!strip_identity_at_launch(spec("hermes"), false));
    }

    /// Live scan of THIS machine. Prints only agent, name, dirExists, loggedIn, method.
    /// Never prints e-mails or paths. Run: cargo test live_account_scan -- --ignored --nocapture
    #[test]
    #[ignore]
    fn live_account_scan() {
        let data = tempfile::tempdir().unwrap();
        let store = ProfileStore::load(data.path().join("profiles.json"));
        let settings = Settings::default();
        let installed = installed_keys(&settings);
        store.merge_detected(&installed).unwrap();
        let list = check_all(store.list_all(), &settings, &HashSet::new(), &installed);
        // The default Claude account must resolve to ~/.claude even when CLAUDE_CONFIG_DIR is inherited.
        let home = discovery::home_dir().unwrap();
        let claude_default = list.iter().find(|a| a.agent == AgentKind::Claude && a.config_dir.is_none()).unwrap();
        assert_eq!(claude_default.resolved_dir.as_deref().map(PathBuf::from), Some(home.join(".claude")));
        println!("installed account-capable agents: {:?}", { let mut v: Vec<_> = installed.iter().collect(); v.sort(); v });
        for a in &list {
            let agent = spec_of(a).map(|s| s.key).unwrap_or("?");
            println!(
                "{{agent: {agent}, name: {}, dirExists: {}, loggedIn: {:?}, method: {:?}}}",
                a.name, a.status.dir_exists, a.status.logged_in, a.status.auth_method
            );
        }
        for i in agent_infos(&settings, &ScanEnv::current()).iter().filter(|i| i.isolation == "none") {
            println!("{{agent: {}, isolation: none}}", i.key);
        }
    }
}
