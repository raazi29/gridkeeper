//! Agent accounts (`profiles.json`), historically "Claude account profiles".
//!
//! A record is a name + an optional home directory for one agent (see `accounts.rs` for the
//! per-agent spec table). `config_dir: None` is the agent's default home (for Claude Code
//! `%USERPROFILE%\.claude`), launched with the agent's home variable removed.
//!
//! On disk, Claude rows stay under the original `profiles` key (unchanged format, so an older
//! Gridkeeper still reads them); rows of other agents go under `accounts`, and homes the user
//! removed are remembered under `dismissed` so the automatic scan does not bring them back.
//! The public API (`list`, `get`, `default_profile`, `create`, ...) keeps its Claude meaning;
//! `list_all` / `create_in` / `create_new_home` / `merge_detected` cover every agent.
//!
//! Security: credential files are only ever checked for EXISTENCE by name.
//! Nothing under a profile directory is read, copied, modified or deleted;
//! deleting a profile removes the entry only. Account e-mails returned by
//! status commands go to the UI only — never to logs or to disk.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use crate::accounts::{self, AccountSpec, HomeSource, ScanEnv};
use crate::adapters::{discovery, process};
use crate::persistence::{atomic_write, preserve_corrupt};
use crate::types::*;

/// Stable id of the seeded default profile.
pub const DEFAULT_PROFILE_ID: &str = "default";
const PROFILES_VERSION: u32 = 1;
const AUTH_TIMEOUT: Duration = Duration::from_secs(15);
const NOT_SIGNED_IN: &str = "Not signed in — run `claude` in this profile and use /login";

/// Accent colors assigned to profiles, in order.
pub const PALETTE: [&str; 8] =
    ["#7B61FF", "#3FB950", "#58A6FF", "#D29922", "#F778BA", "#39C5CF", "#FF7B72", "#A371F7"];

fn is_claude(a: &AgentKind) -> bool {
    *a == AgentKind::Claude
}

fn is_false(b: &bool) -> bool {
    !*b
}

/// On-disk shape: no computed status.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredProfile {
    id: String,
    name: String,
    #[serde(default)]
    config_dir: Option<String>,
    color: String,
    #[serde(default = "default_account_agent", skip_serializing_if = "is_claude")]
    agent: AgentKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    preset: Option<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    auto_detected: bool,
}

impl StoredProfile {
    fn spec(&self) -> Option<&'static AccountSpec> {
        accounts::spec_for(self.agent, self.preset.as_deref())
    }
    fn is_spec(&self, spec: &AccountSpec) -> bool {
        self.spec().is_some_and(|s| s.key == spec.key)
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct ProfilesFile {
    version: u32,
    /// Claude accounts (original key and format).
    #[serde(default)]
    profiles: Vec<StoredProfile>,
    /// Accounts of other agents.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    accounts: Vec<StoredProfile>,
    /// Home keys (`accounts::home_key`) the user removed; `None` in files written before accounts existed.
    #[serde(default)]
    dismissed: Option<Vec<String>>,
}

struct Inner {
    list: Vec<StoredProfile>,
    dismissed: Vec<String>,
}

/// Config directory a profile resolves to (default profile → `<home>/.claude`).
pub fn config_root(profile: &ClaudeProfile) -> Option<PathBuf> {
    config_root_in(profile.config_dir.as_deref(), discovery::home_dir().as_deref())
}

fn config_root_in(config_dir: Option<&str>, home: Option<&Path>) -> Option<PathBuf> {
    match config_dir.map(str::trim).filter(|d| !d.is_empty()) {
        Some(d) => Some(PathBuf::from(d)),
        None => home.map(|h| h.join(".claude")),
    }
}

fn valid_color(c: &str) -> bool {
    c.len() == 7 && c.starts_with('#') && c[1..].chars().all(|ch| ch.is_ascii_hexdigit())
}

fn claude_spec() -> &'static AccountSpec {
    accounts::spec_for(AgentKind::Claude, None).expect("claude spec")
}

pub struct ProfileStore {
    path: PathBuf,
    env: ScanEnv,
    profiles: Mutex<Inner>,
}

impl ProfileStore {
    /// Load `profiles.json`, seeding it on first run from the user's home directory.
    pub fn load(path: PathBuf) -> Self {
        Self::load_with_env(path, ScanEnv::current())
    }

    /// Like `load`, with an explicit home directory for seeding/default-dir status.
    pub fn load_with_home(path: PathBuf, home: Option<PathBuf>) -> Self {
        Self::load_with_env(path, ScanEnv::with_home(home))
    }

    pub fn load_with_env(path: PathBuf, env: ScanEnv) -> Self {
        let existing = if path.exists() {
            match std::fs::read_to_string(&path).map_err(|e| e.to_string()).and_then(|t| {
                serde_json::from_str::<ProfilesFile>(&t).map_err(|e| e.to_string())
            }) {
                Ok(f) => {
                    if f.version > PROFILES_VERSION {
                        tracing::warn!(version = f.version, "profiles.json is from a newer Gridkeeper; loading best-effort");
                    }
                    Some(f)
                }
                Err(e) => {
                    tracing::error!(error = %e, "profiles.json unreadable; preserving it and re-seeding");
                    preserve_corrupt(&path, false);
                    None
                }
            }
        } else {
            None
        };
        let seeded = existing.is_none();
        let (mut list, dismissed, legacy) = match existing {
            Some(f) => {
                let mut list: Vec<StoredProfile> = f
                    .profiles
                    .into_iter()
                    .map(|mut p| {
                        // The `profiles` key only ever holds Claude rows.
                        p.agent = AgentKind::Claude;
                        p.preset = None;
                        p
                    })
                    .collect();
                list.extend(f.accounts.into_iter().filter(|p| p.agent != AgentKind::Claude));
                let legacy = f.dismissed.is_none();
                (list, f.dismissed.unwrap_or_default(), legacy)
            }
            None => (Self::seed(env.home.as_deref()), Vec::new(), false),
        };
        Self::dedupe(&mut list);
        let mut dismissed = dismissed;
        if legacy {
            // Written before accounts existed: first-run seeding added every Claude sibling that
            // existed then, so a sibling that is not listed now was most likely removed by the
            // user. Respect that; the UI offers "show hidden accounts" to bring them back.
            let spec = claude_spec();
            let known: HashSet<String> =
                list.iter().filter(|p| p.is_spec(spec)).map(|p| accounts::home_key(spec, p.config_dir.as_deref(), &env)).collect();
            for f in accounts::discover(spec, &env).into_iter().filter(|f| f.source == HomeSource::Sibling) {
                let key = accounts::home_key(spec, f.config_dir.as_deref(), &env);
                if !known.contains(&key) {
                    dismissed.push(key);
                }
            }
        }
        let store = Self { path, env, profiles: Mutex::new(Inner { list, dismissed }) };
        if seeded || legacy {
            let inner = store.profiles.lock();
            if seeded {
                tracing::info!(count = inner.list.len(), "seeded Claude profiles");
            }
            if let Err(e) = store.persist(&inner.list, &inner.dismissed) {
                tracing::error!(error = %e, "could not write profiles.json");
            }
        }
        store
    }

    fn seed(home: Option<&Path>) -> Vec<StoredProfile> {
        let mut out = vec![StoredProfile {
            id: DEFAULT_PROFILE_ID.into(),
            name: "Default".into(),
            config_dir: None,
            color: PALETTE[0].into(),
            agent: AgentKind::Claude,
            preset: None,
            auto_detected: false,
        }];
        let env = ScanEnv::with_home(home.map(Path::to_path_buf));
        let siblings = accounts::discover(claude_spec(), &env).into_iter().filter(|f| f.source == HomeSource::Sibling);
        for (i, f) in siblings.enumerate() {
            out.push(StoredProfile {
                id: uuid::Uuid::new_v4().to_string(),
                name: f.name,
                config_dir: f.config_dir,
                color: PALETTE[(i + 1) % PALETTE.len()].into(),
                agent: AgentKind::Claude,
                preset: None,
                auto_detected: false,
            });
        }
        out
    }

    /// Drop entries with duplicate ids or blank names (hand-edited files).
    fn dedupe(list: &mut Vec<StoredProfile>) {
        let mut seen = std::collections::HashSet::new();
        list.retain(|p| !p.id.is_empty() && !p.name.trim().is_empty() && seen.insert(p.id.clone()));
        for p in list.iter_mut() {
            if !valid_color(&p.color) {
                p.color = PALETTE[0].into();
            }
        }
    }

    fn persist(&self, list: &[StoredProfile], dismissed: &[String]) -> AppResult<()> {
        let (profiles, others): (Vec<StoredProfile>, Vec<StoredProfile>) =
            list.iter().cloned().partition(|p| p.agent == AgentKind::Claude);
        let file = ProfilesFile { version: PROFILES_VERSION, profiles, accounts: others, dismissed: Some(dismissed.to_vec()) };
        let bytes = serde_json::to_vec_pretty(&file).map_err(|e| AppError::Other(e.to_string()))?;
        atomic_write(&self.path, &bytes, true)?;
        Ok(())
    }

    fn to_account(&self, p: &StoredProfile) -> Account {
        let spec = p.spec();
        let root = match spec {
            Some(s) => accounts::resolve_home(s, p.config_dir.as_deref(), &self.env),
            None => config_root_in(p.config_dir.as_deref(), self.env.home.as_deref()),
        };
        Account {
            profile: ClaudeProfile {
                id: p.id.clone(),
                name: p.name.clone(),
                config_dir: p.config_dir.clone(),
                color: p.color.clone(),
                status: accounts::cheap_status(spec, root.as_deref()),
            },
            agent: p.agent,
            preset: p.preset.clone(),
            auto_detected: p.auto_detected,
            resolved_dir: root.map(|r| r.to_string_lossy().into_owned()),
        }
    }

    fn to_public(&self, p: &StoredProfile) -> ClaudeProfile {
        self.to_account(p).profile
    }

    /// Claude accounts (the historical meaning of "profiles").
    pub fn list(&self) -> Vec<ClaudeProfile> {
        self.profiles.lock().list.iter().filter(|p| p.agent == AgentKind::Claude).map(|p| self.to_public(p)).collect()
    }

    /// Accounts of every agent, grouped in spec-table order.
    pub fn list_all(&self) -> Vec<Account> {
        let inner = self.profiles.lock();
        let order = |p: &StoredProfile| {
            p.spec().and_then(|s| accounts::SPECS.iter().position(|x| x.key == s.key)).unwrap_or(usize::MAX)
        };
        let mut rows: Vec<&StoredProfile> = inner.list.iter().collect();
        rows.sort_by_key(|p| order(p));
        rows.into_iter().map(|p| self.to_account(p)).collect()
    }

    /// Profile record by id (any agent; use `get_account` to know which).
    pub fn get(&self, id: &str) -> Option<ClaudeProfile> {
        self.profiles.lock().list.iter().find(|p| p.id == id).map(|p| self.to_public(p))
    }

    /// Account of any agent by id.
    pub fn get_account(&self, id: &str) -> Option<Account> {
        self.profiles.lock().list.iter().find(|p| p.id == id).map(|p| self.to_account(p))
    }

    /// The profile using Claude's default location (no CLAUDE_CONFIG_DIR), if any.
    pub fn default_profile(&self) -> Option<ClaudeProfile> {
        let inner = self.profiles.lock();
        let claude = || inner.list.iter().filter(|p| p.agent == AgentKind::Claude);
        claude()
            .find(|p| p.config_dir.is_none())
            .or_else(|| claude().find(|p| p.id == DEFAULT_PROFILE_ID))
            .map(|p| self.to_public(p))
    }

    /// Directories used for discovery and default homes.
    pub fn scan_env(&self) -> &ScanEnv {
        &self.env
    }

    /// Number of remembered removed homes (for "show hidden accounts").
    pub fn dismissed_count(&self) -> usize {
        self.profiles.lock().dismissed.len()
    }

    fn validate_name(list: &[StoredProfile], spec: &AccountSpec, name: &str, except_id: Option<&str>) -> AppResult<String> {
        let name = name.trim();
        if name.is_empty() {
            return Err(AppError::Invalid("Profile name must not be empty".into()));
        }
        if name.chars().count() > 64 || name.contains('\0') {
            return Err(AppError::Invalid("Profile name is too long or contains invalid characters".into()));
        }
        if list
            .iter()
            .any(|p| Some(p.id.as_str()) != except_id && p.is_spec(spec) && p.name.trim().eq_ignore_ascii_case(name))
        {
            return Err(AppError::Invalid(format!("A profile named {name:?} already exists")));
        }
        Ok(name.to_string())
    }

    /// Validate (and create if missing) a profile directory. Existing directories
    /// are never modified.
    fn validate_dir(
        &self,
        list: &[StoredProfile],
        spec: &AccountSpec,
        config_dir: Option<String>,
        except_id: Option<&str>,
    ) -> AppResult<Option<String>> {
        let others = list.iter().filter(|p| Some(p.id.as_str()) != except_id && p.is_spec(spec));
        let Some(dir) = config_dir.map(|d| d.trim().to_string()).filter(|d| !d.is_empty()) else {
            if others.clone().any(|p| p.config_dir.is_none()) {
                return Err(AppError::Invalid(format!(
                    "Another {} account already uses its default location; choose a directory",
                    spec.label
                )));
            }
            return Ok(None);
        };
        if dir.contains('\0') {
            return Err(AppError::Invalid("Profile directory contains a NUL character".into()));
        }
        let path = PathBuf::from(&dir);
        if !path.is_absolute() {
            return Err(AppError::Invalid(format!("Profile directory must be an absolute path: {dir}")));
        }
        let norm = accounts::normalize_dir(&dir);
        if let Some(default_root) = accounts::default_home(spec, &self.env)
            && accounts::normalize_dir(&default_root.to_string_lossy()) == norm
            && others.clone().any(|p| p.config_dir.is_none())
        {
            return Err(AppError::Invalid(format!(
                "That directory is {}'s default location, already used by the default account",
                spec.label
            )));
        }
        if let Some(clash) =
            others.clone().find(|p| p.config_dir.as_deref().is_some_and(|d| accounts::normalize_dir(d) == norm))
        {
            return Err(AppError::Invalid(format!("Profile {:?} already uses that directory", clash.name)));
        }
        if path.exists() {
            if !path.is_dir() {
                return Err(AppError::Invalid(format!("Not a directory: {dir}")));
            }
        } else {
            std::fs::create_dir_all(&path)?;
            tracing::info!(agent = spec.key, "created new empty account directory");
        }
        Ok(Some(dir))
    }

    fn pick_color(list: &[StoredProfile], color: Option<String>) -> AppResult<String> {
        if let Some(c) = color.map(|c| c.trim().to_string()).filter(|c| !c.is_empty()) {
            if !valid_color(&c) {
                return Err(AppError::Invalid(format!("Invalid color {c:?}; expected #RRGGBB")));
            }
            return Ok(c.to_uppercase());
        }
        let used: Vec<String> = list.iter().map(|p| p.color.to_uppercase()).collect();
        Ok(PALETTE
            .iter()
            .find(|c| !used.contains(&c.to_string()))
            .unwrap_or(&PALETTE[list.len() % PALETTE.len()])
            .to_string())
    }

    /// Create a Claude profile (historical API).
    pub fn create(&self, name: String, config_dir: Option<String>, color: Option<String>) -> AppResult<ClaudeProfile> {
        self.create_in(claude_spec(), name, config_dir, color).map(|a| a.profile)
    }

    /// Create an account of any agent with an explicit (or default) home.
    pub fn create_in(
        &self,
        spec: &AccountSpec,
        name: String,
        config_dir: Option<String>,
        color: Option<String>,
    ) -> AppResult<Account> {
        let mut inner = self.profiles.lock();
        let name = Self::validate_name(&inner.list, spec, &name, None)?;
        let color = Self::pick_color(&inner.list, color)?;
        let config_dir = self.validate_dir(&inner.list, spec, config_dir, None)?;
        let stored = StoredProfile {
            id: uuid::Uuid::new_v4().to_string(),
            name,
            config_dir,
            color,
            agent: spec.agent,
            preset: spec.preset.map(String::from),
            auto_detected: false,
        };
        let key = accounts::home_key(spec, stored.config_dir.as_deref(), &self.env);
        let mut next = inner.list.clone();
        next.push(stored.clone());
        let dismissed: Vec<String> = inner.dismissed.iter().filter(|k| **k != key).cloned().collect();
        self.persist(&next, &dismissed)?;
        inner.list = next;
        inner.dismissed = dismissed;
        tracing::info!(profile = %stored.id, agent = spec.key, "created account");
        Ok(self.to_account(&stored))
    }

    /// Where "Add account" would put a new home for `name` (path preview for the UI).
    pub fn plan_home(&self, spec: &AccountSpec, name: &str) -> AppResult<accounts::PlannedHome> {
        Ok(accounts::describe_home(&accounts::planned_home(spec, name, &self.env)?))
    }

    /// "Add account": create an EMPTY home (`~/.codex-<name>`, ...) and its entry. An existing
    /// non-empty folder is refused unless `use_existing` (it is then used as is, never modified).
    pub fn create_new_home(
        &self,
        spec: &AccountSpec,
        name: String,
        use_existing: bool,
        home_dir: Option<String>,
        color: Option<String>,
    ) -> AppResult<Account> {
        let path = match home_dir.map(|d| d.trim().to_string()).filter(|d| !d.is_empty()) {
            Some(d) => PathBuf::from(d),
            None => accounts::planned_home(spec, &name, &self.env)?,
        };
        let info = accounts::describe_home(&path);
        if info.exists && !path.is_dir() {
            return Err(AppError::Invalid(format!("Not a directory: {}", info.path)));
        }
        if info.exists && !info.empty && !use_existing {
            return Err(AppError::Invalid(format!(
                "{} already exists and is not empty. Choose “Use existing folder” to add it as is, or pick another name.",
                info.path
            )));
        }
        self.create_in(spec, name, Some(info.path), color)
    }

    /// Add homes found by `accounts::discover` that are neither listed nor dismissed. A missing
    /// default home is only added when the agent is installed (so Sign in can create it).
    /// Returns whether anything was added.
    pub fn merge_detected(&self, installed: &HashSet<&'static str>) -> AppResult<bool> {
        let found: Vec<(&'static AccountSpec, Vec<accounts::FoundHome>)> =
            accounts::SPECS.iter().map(|s| (s, accounts::discover(s, &self.env))).collect();
        let mut inner = self.profiles.lock();
        let next = merge_found(&inner.list, &inner.dismissed, &found, installed, &self.env);
        if next.len() == inner.list.len() {
            return Ok(false);
        }
        self.persist(&next, &inner.dismissed)?;
        tracing::info!(added = next.len() - inner.list.len(), "auto-detected accounts");
        inner.list = next;
        Ok(true)
    }

    /// Forget all dismissed homes (the next scan lists them again).
    pub fn restore_dismissed(&self) -> AppResult<()> {
        let mut inner = self.profiles.lock();
        self.persist(&inner.list, &[])?;
        inner.dismissed.clear();
        Ok(())
    }

    pub fn update(&self, profile: ClaudeProfile) -> AppResult<ClaudeProfile> {
        let mut inner = self.profiles.lock();
        let idx = inner
            .list
            .iter()
            .position(|p| p.id == profile.id)
            .ok_or_else(|| AppError::NotFound(format!("Claude profile {}", profile.id)))?;
        // Agent and preset are fixed at creation (a `ClaudeProfile` does not carry them).
        let current = inner.list[idx].clone();
        let spec = current.spec().unwrap_or_else(claude_spec);
        let name = Self::validate_name(&inner.list, spec, &profile.name, Some(&profile.id))?;
        let config_dir = if profile.config_dir.as_deref().map(str::trim) == current.config_dir.as_deref() {
            current.config_dir.clone()
        } else {
            self.validate_dir(&inner.list, spec, profile.config_dir.clone(), Some(&profile.id))?
        };
        let color = if valid_color(profile.color.trim()) {
            profile.color.trim().to_uppercase()
        } else {
            return Err(AppError::Invalid(format!("Invalid color {:?}; expected #RRGGBB", profile.color)));
        };
        let mut next = inner.list.clone();
        next[idx] = StoredProfile {
            id: profile.id.clone(),
            name,
            config_dir,
            color,
            agent: current.agent,
            preset: current.preset.clone(),
            // A user edit makes the entry the user's own.
            auto_detected: false,
        };
        self.persist(&next, &inner.dismissed)?;
        inner.list = next;
        Ok(self.to_public(&inner.list[idx]))
    }

    /// Remove the entry only. The directory and its contents are never touched. The home is
    /// remembered as dismissed so the automatic scan does not add it again.
    pub fn delete(&self, id: &str) -> AppResult<()> {
        let mut inner = self.profiles.lock();
        let Some(removed) = inner.list.iter().find(|p| p.id == id).cloned() else {
            return Err(AppError::NotFound(format!("Claude profile {id}")));
        };
        let next: Vec<StoredProfile> = inner.list.iter().filter(|p| p.id != id).cloned().collect();
        let mut dismissed = inner.dismissed.clone();
        if let Some(spec) = removed.spec() {
            let key = accounts::home_key(spec, removed.config_dir.as_deref(), &self.env);
            if !dismissed.contains(&key) {
                dismissed.push(key);
            }
        }
        self.persist(&next, &dismissed)?;
        inner.list = next;
        inner.dismissed = dismissed;
        tracing::info!(profile = %id, "removed account entry");
        Ok(())
    }
}

/// Pure merge of discovered homes into the stored list (see `merge_detected`).
fn merge_found(
    list: &[StoredProfile],
    dismissed: &[String],
    found: &[(&'static AccountSpec, Vec<accounts::FoundHome>)],
    installed: &HashSet<&'static str>,
    env: &ScanEnv,
) -> Vec<StoredProfile> {
    let mut next = list.to_vec();
    for (spec, homes) in found {
        let mut known: HashSet<String> =
            next.iter().filter(|p| p.is_spec(spec)).map(|p| accounts::home_key(spec, p.config_dir.as_deref(), env)).collect();
        for f in homes {
            if f.source == HomeSource::Default && !f.exists && !installed.contains(spec.key) {
                continue;
            }
            let key = accounts::home_key(spec, f.config_dir.as_deref(), env);
            if known.contains(&key) || dismissed.contains(&key) {
                continue;
            }
            // Unique name within this agent.
            let taken = |n: &str| next.iter().any(|p| p.is_spec(spec) && p.name.trim().eq_ignore_ascii_case(n));
            let mut name = f.name.chars().take(64).collect::<String>();
            let mut i = 2;
            while taken(&name) {
                name = format!("{} {i}", f.name);
                i += 1;
            }
            let id = match f.source {
                HomeSource::Default => {
                    let want = if spec.agent == AgentKind::Claude { DEFAULT_PROFILE_ID.to_string() } else { format!("default-{}", spec.key) };
                    if next.iter().any(|p| p.id == want) { uuid::Uuid::new_v4().to_string() } else { want }
                }
                _ => uuid::Uuid::new_v4().to_string(),
            };
            let color = ProfileStore::pick_color(&next, None).unwrap_or_else(|_| PALETTE[0].into());
            next.push(StoredProfile {
                id,
                name,
                config_dir: f.config_dir.clone(),
                color,
                agent: spec.agent,
                preset: spec.preset.map(String::from),
                auto_detected: true,
            });
            known.insert(key);
        }
    }
    next
}

/// Interpret `claude auth status --json` output. Pure; unit-tested.
fn parse_auth_status(stdout: &[u8], exit_code: Option<i32>, base: ProfileStatus) -> ProfileStatus {
    let text = String::from_utf8_lossy(stdout);
    let json = match (text.find('{'), text.rfind('}')) {
        (Some(a), Some(b)) if b > a => serde_json::from_str::<serde_json::Value>(&text[a..=b]).ok(),
        _ => None,
    };
    if let Some(v) = json {
        let logged_in = v.get("loggedIn").and_then(|x| x.as_bool()).unwrap_or(exit_code == Some(0));
        let auth_method = v.get("authMethod").and_then(|x| x.as_str()).map(str::to_string);
        let account = v.get("email").and_then(|x| x.as_str()).filter(|s| !s.is_empty()).map(str::to_string);
        return ProfileStatus {
            verified: true,
            logged_in: Some(logged_in),
            auth_method,
            account,
            note: (!logged_in).then(|| NOT_SIGNED_IN.to_string()),
            ..base
        };
    }
    match exit_code {
        Some(1) => ProfileStatus {
            verified: true,
            logged_in: Some(false),
            note: Some(NOT_SIGNED_IN.into()),
            ..base
        },
        code => ProfileStatus {
            verified: false,
            note: Some(format!(
                "Could not read `claude auth status` output (exit code {})",
                code.map(|c| c.to_string()).unwrap_or_else(|| "unknown".into())
            )),
            ..base
        },
    }
}

/// Verify login state by running `claude auth status --json` with the
/// profile's environment. Only runs for existing directories (the command
/// would otherwise create files there).
/// (Claude only; `accounts::check_status` handles accounts of any agent.)
pub fn check_status(profile: &ClaudeProfile, settings: &Settings) -> AppResult<ProfileStatus> {
    let root = config_root(profile);
    let base = accounts::cheap_status(Some(claude_spec()), root.as_deref());
    if !root.as_deref().is_some_and(Path::is_dir) {
        return Ok(ProfileStatus { note: Some("Directory does not exist".into()), ..base });
    }
    let exe = crate::adapters::resolve_executable(AgentKind::Claude, settings, None)?;
    let (program, mut args) = exe.program_and_prefix();
    args.extend(["auth", "status", "--json"].map(String::from));

    let mut cmd = process::hidden_command(&program);
    // Neutral cwd: no project-level .claude settings, no project entry for the config dir.
    cmd.args(&args).current_dir(std::env::temp_dir());
    match profile.config_dir.as_deref().map(str::trim).filter(|d| !d.is_empty()) {
        Some(dir) => {
            cmd.env("CLAUDE_CONFIG_DIR", dir);
        }
        None => {
            cmd.env_remove("CLAUDE_CONFIG_DIR");
        }
    }
    for key in crate::adapters::CLAUDE_IDENTITY_ENV {
        cmd.env_remove(key);
    }
    // A parent Claude Code session's internal variables must not make the probe a sub-session.
    for key in crate::adapters::inherited_agent_session_vars(std::env::vars().map(|(k, _)| k)) {
        cmd.env_remove(key);
    }

    let status = match process::run_with_timeout(cmd, AUTH_TIMEOUT) {
        Ok(out) => parse_auth_status(&out.stdout, out.status.code(), base),
        Err(e) if e.kind() == std::io::ErrorKind::TimedOut => ProfileStatus {
            note: Some("`claude auth status` timed out".into()),
            ..base
        },
        Err(e) => return Err(AppError::Other(format!("Could not run Claude Code: {e}"))),
    };
    // Never log `status.account` (e-mail) — log only these fields.
    tracing::info!(
        profile = %profile.id,
        verified = status.verified,
        logged_in = ?status.logged_in,
        auth_method = ?status.auth_method,
        "checked Claude profile auth status"
    );
    Ok(status)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fake_home() -> tempfile::TempDir {
        let home = tempfile::tempdir().unwrap();
        let h = home.path();
        std::fs::create_dir_all(h.join(".claude")).unwrap();
        // Real-looking profile dirs (existence of marker files only).
        std::fs::create_dir_all(h.join(".claude-account1")).unwrap();
        std::fs::write(h.join(".claude-account1").join(".credentials.json"), b"{}").unwrap();
        std::fs::create_dir_all(h.join(".claude-work")).unwrap();
        std::fs::write(h.join(".claude-work").join("settings.json"), b"{}").unwrap();
        std::fs::create_dir_all(h.join(".claude-work").join("projects")).unwrap();
        // Tool dirs without marker files must be skipped (a lone settings.json is not enough).
        std::fs::create_dir_all(h.join(".claude-flow")).unwrap();
        std::fs::create_dir_all(h.join(".claude-mem").join("db")).unwrap();
        std::fs::write(h.join(".claude-mem").join("settings.json"), b"{}").unwrap();
        // A file, not a dir.
        std::fs::write(h.join(".claude-notes"), b"x").unwrap();
        home
    }

    #[test]
    fn seeds_default_and_discovers_siblings() {
        let home = fake_home();
        let data = tempfile::tempdir().unwrap();
        let path = data.path().join("profiles.json");
        let store = ProfileStore::load_with_home(path.clone(), Some(home.path().to_path_buf()));
        let list = store.list();
        let names: Vec<_> = list.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, vec!["Default", "account1", "work"]);
        assert_eq!(list[0].id, DEFAULT_PROFILE_ID);
        assert!(list[0].config_dir.is_none());
        assert!(list[0].status.dir_exists);
        assert!(list[1].status.likely_authenticated);
        assert!(!list[2].status.likely_authenticated);
        let colors: std::collections::HashSet<_> = list.iter().map(|p| p.color.clone()).collect();
        assert_eq!(colors.len(), 3, "distinct colors");
        assert!(path.exists());

        // Persisted without status; reload gives the same entries (no re-seed).
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(!text.contains("status") && !text.contains("likelyAuthenticated"));
        let again = ProfileStore::load_with_home(path, None);
        assert_eq!(again.list().len(), 3);
        assert_eq!(again.default_profile().unwrap().id, DEFAULT_PROFILE_ID);
    }

    #[test]
    fn create_update_delete() {
        let home = fake_home();
        let data = tempfile::tempdir().unwrap();
        let store = ProfileStore::load_with_home(data.path().join("profiles.json"), Some(home.path().to_path_buf()));

        // Validation.
        assert!(matches!(store.create("  ".into(), Some(data.path().join("x").to_string_lossy().into()), None), Err(AppError::Invalid(_))));
        assert!(matches!(store.create("work".into(), Some(data.path().join("x").to_string_lossy().into()), None), Err(AppError::Invalid(_))));
        assert!(matches!(store.create("rel".into(), Some("relative\\dir".into()), None), Err(AppError::Invalid(_))));
        assert!(matches!(store.create("dup-default".into(), None, None), Err(AppError::Invalid(_))));
        let existing = home.path().join(".claude-account1").to_string_lossy().to_uppercase();
        assert!(matches!(store.create("same".into(), Some(existing), None), Err(AppError::Invalid(_))));
        assert!(matches!(
            store.create("bad-color".into(), Some(data.path().join("y").to_string_lossy().into()), Some("red".into())),
            Err(AppError::Invalid(_))
        ));

        // Create makes a missing directory (empty).
        let new_dir = data.path().join("new-profile");
        let p = store.create("New".into(), Some(new_dir.to_string_lossy().into()), None).unwrap();
        assert!(new_dir.is_dir());
        assert_eq!(std::fs::read_dir(&new_dir).unwrap().count(), 0);
        assert!(p.status.dir_exists && !p.status.likely_authenticated);
        assert!(PALETTE.contains(&p.color.as_str()));

        // Update.
        let mut upd = p.clone();
        upd.name = "Renamed".into();
        upd.color = "#123abc".into();
        let u = store.update(upd).unwrap();
        assert_eq!(u.name, "Renamed");
        assert_eq!(u.color, "#123ABC");
        let mut clash = u.clone();
        clash.name = "Default".into();
        assert!(store.update(clash).is_err());

        // Delete removes the entry only.
        store.delete(&p.id).unwrap();
        assert!(store.get(&p.id).is_none());
        assert!(new_dir.is_dir(), "directory is never deleted");
        assert!(matches!(store.delete(&p.id), Err(AppError::NotFound(_))));
    }

    #[test]
    fn corrupt_profiles_file_preserved_and_reseeded() {
        let data = tempfile::tempdir().unwrap();
        let path = data.path().join("profiles.json");
        std::fs::write(&path, "nope").unwrap();
        let store = ProfileStore::load_with_home(path.clone(), None);
        assert_eq!(store.list().len(), 1);
        let preserved = std::fs::read_dir(data.path())
            .unwrap()
            .flatten()
            .any(|e| e.file_name().to_string_lossy().starts_with("profiles.corrupt-"));
        assert!(preserved);
    }

    #[test]
    fn missing_dir_status() {
        let p = ClaudeProfile {
            id: "x".into(),
            name: "x".into(),
            config_dir: Some(r"C:\definitely\missing\altera-profile".into()),
            color: PALETTE[0].into(),
            status: Default::default(),
        };
        let s = check_status(&p, &Settings::default()).unwrap();
        assert!(!s.dir_exists && !s.verified);
        assert_eq!(s.note.as_deref(), Some("Directory does not exist"));
    }

    #[test]
    fn parses_auth_status() {
        let base = ProfileStatus { dir_exists: true, likely_authenticated: true, ..Default::default() };
        let ok = br#"{"loggedIn":true,"authMethod":"claude.ai","email":"a@example.com","orgName":"x"}"#;
        let s = parse_auth_status(ok, Some(0), base.clone());
        assert!(s.verified && s.logged_in == Some(true) && s.note.is_none());
        assert_eq!(s.auth_method.as_deref(), Some("claude.ai"));
        assert_eq!(s.account.as_deref(), Some("a@example.com"));
        assert!(s.dir_exists);

        let out = br#"{"loggedIn":false,"authMethod":"none"}"#;
        let s = parse_auth_status(out, Some(1), base.clone());
        assert_eq!(s.logged_in, Some(false));
        assert_eq!(s.note.as_deref(), Some(NOT_SIGNED_IN));

        let s = parse_auth_status(b"", Some(1), base.clone());
        assert!(s.verified && s.logged_in == Some(false));

        let s = parse_auth_status(b"garbage", Some(3), base);
        assert!(!s.verified && s.logged_in.is_none());
    }

    /// A profiles.json written before accounts existed (exact v1 shape).
    const V1_FILE: &str = r##"{
  "version": 1,
  "profiles": [
    { "id": "default", "name": "Default", "configDir": null, "color": "#7B61FF" },
    { "id": "p1", "name": "account1", "configDir": "C:\\Users\\x\\.claude-account1", "color": "#3FB950" }
  ]
}"##;

    #[test]
    fn v1_profiles_file_loads_unchanged_and_round_trips_accounts() {
        let home = fake_home();
        let data = tempfile::tempdir().unwrap();
        let path = data.path().join("profiles.json");
        std::fs::write(&path, V1_FILE).unwrap();
        let store = ProfileStore::load_with_home(path.clone(), Some(home.path().to_path_buf()));
        let all = store.list_all();
        assert_eq!(all.len(), 2);
        assert!(all.iter().all(|p| p.agent == AgentKind::Claude && p.preset.is_none() && !p.auto_detected));
        assert_eq!(store.list().len(), 2);
        assert_eq!(store.default_profile().unwrap().id, "default");
        assert_eq!(store.get("p1").unwrap().config_dir.as_deref(), Some(r"C:\Users\x\.claude-account1"));

        // Legacy file: siblings not listed (account1/work in the fake home) count as removed by the user.
        let text = std::fs::read_to_string(&path).unwrap();
        let v: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(v["dismissed"].as_array().unwrap().len(), 2, "{text}");

        // A Codex account goes under `accounts`; `profiles` keeps only Claude rows (old readers).
        let codex = accounts::spec_for(AgentKind::Codex, None).unwrap();
        let acct = store.create_new_home(codex, "Work".into(), false, None, None).unwrap();
        assert_eq!(acct.agent, AgentKind::Codex);
        assert!(home.path().join(".codex-work").is_dir());
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(v["profiles"].as_array().unwrap().len(), 2);
        assert!(v["profiles"].as_array().unwrap().iter().all(|p| p.get("agent").is_none()));
        assert_eq!(v["accounts"][0]["agent"], "codex");

        // Reload keeps the agent; the Claude-only API does not see it.
        let again = ProfileStore::load_with_home(path, Some(home.path().to_path_buf()));
        assert_eq!(again.get_account(&acct.id).unwrap().agent, AgentKind::Codex);
        assert_eq!(again.list().len(), 2);
        assert_eq!(again.list_all().len(), 3);
        assert_eq!(again.dismissed_count(), 2);
    }

    #[test]
    fn update_never_changes_agent() {
        let home = fake_home();
        let data = tempfile::tempdir().unwrap();
        let store = ProfileStore::load_with_home(data.path().join("profiles.json"), Some(home.path().to_path_buf()));
        let codex = accounts::spec_for(AgentKind::Codex, None).unwrap();
        let a = store.create_new_home(codex, "w".into(), false, None, None).unwrap();
        // Callers send a plain ClaudeProfile (no agent): the account stays a Codex account.
        let json = serde_json::json!({ "id": a.id, "name": "renamed", "configDir": a.config_dir, "color": "#112233" });
        let incoming: ClaudeProfile = serde_json::from_value(json).unwrap();
        let u = store.update(incoming).unwrap();
        assert_eq!(u.name, "renamed");
        assert_eq!(store.get_account(&a.id).unwrap().agent, AgentKind::Codex);
        assert!(store.list().iter().all(|p| p.id != a.id), "never listed as a Claude profile");
        // The account JSON is flat: profile fields + agent fields.
        let v = serde_json::to_value(store.get_account(&a.id).unwrap()).unwrap();
        assert_eq!(v["agent"], "codex");
        assert_eq!(v["name"], "renamed");
        assert!(v.get("profile").is_none());
        // Names are unique per agent: a Claude "Default" and a Codex "Default" coexist.
        assert!(store.create_in(codex, "Default".into(), None, None).is_ok());
        assert!(store.create_in(codex, "default".into(), Some(data.path().join("z").to_string_lossy().into()), None).is_err());
    }

    #[test]
    fn scan_merge_respects_dismissed_and_renames() {
        let home = fake_home();
        let h = home.path();
        std::fs::create_dir_all(h.join(".codex")).unwrap();
        std::fs::create_dir_all(h.join(".codex-work")).unwrap();
        std::fs::write(h.join(".codex-work").join("config.toml"), b"").unwrap();
        let hermes_root = h.join(r"AppData\Local\hermes");
        std::fs::create_dir_all(&hermes_root).unwrap();
        std::fs::write(hermes_root.join("config.yaml"), b"").unwrap();
        let data = tempfile::tempdir().unwrap();
        let store = ProfileStore::load_with_home(data.path().join("profiles.json"), Some(h.to_path_buf()));
        assert_eq!(store.list_all().len(), 3, "first run seeds Claude only");

        let installed: HashSet<&'static str> = ["claude", "codex"].into_iter().collect();
        assert!(store.merge_detected(&installed).unwrap());
        let all = store.list_all();
        let summary: Vec<(AgentKind, String, bool)> = all.iter().map(|a| (a.agent, a.name.clone(), a.auto_detected)).collect();
        assert_eq!(
            summary,
            vec![
                (AgentKind::Claude, "Default".into(), false),
                (AgentKind::Claude, "account1".into(), false),
                (AgentKind::Claude, "work".into(), false),
                (AgentKind::Codex, "Default".into(), true),
                (AgentKind::Codex, "work".into(), true),
                (AgentKind::Generic, "Default".into(), true),
            ]
        );
        let codex_default = all.iter().find(|a| a.agent == AgentKind::Codex && a.config_dir.is_none()).unwrap();
        assert_eq!(codex_default.id, "default-codex");
        assert_eq!(codex_default.resolved_dir.as_deref().map(PathBuf::from), Some(h.join(".codex")));
        let hermes = all.iter().find(|a| a.agent == AgentKind::Generic).unwrap();
        assert_eq!(hermes.preset.as_deref(), Some("hermes"));
        assert!(!store.merge_detected(&installed).unwrap(), "idempotent");

        // Renamed entries are matched by folder, not by name.
        let work = all.iter().find(|a| a.agent == AgentKind::Codex && a.name == "work").unwrap().clone();
        store.update(ClaudeProfile { name: "Job".into(), ..work.profile.clone() }).unwrap();
        assert!(!store.merge_detected(&installed).unwrap());
        assert!(!store.get_account(&work.id).unwrap().auto_detected, "edited entries are the user's own");

        // Removed entries stay removed until restored; the folder is untouched.
        store.delete(&work.id).unwrap();
        assert!(!store.merge_detected(&installed).unwrap());
        assert!(h.join(".codex-work").join("config.toml").exists());
        store.restore_dismissed().unwrap();
        assert!(store.merge_detected(&installed).unwrap());
        assert_eq!(store.list_all().iter().filter(|a| a.agent == AgentKind::Codex).count(), 2);
    }

    #[test]
    fn missing_default_home_only_added_when_installed() {
        let home = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let store = ProfileStore::load_with_home(data.path().join("profiles.json"), Some(home.path().to_path_buf()));
        assert!(!store.merge_detected(&HashSet::new()).unwrap());
        let installed: HashSet<&'static str> = ["codex"].into_iter().collect();
        assert!(store.merge_detected(&installed).unwrap());
        let codex = store.list_all().into_iter().find(|a| a.agent == AgentKind::Codex).unwrap();
        assert!(!codex.status.dir_exists && codex.config_dir.is_none());
        assert!(!home.path().join(".codex").exists(), "scan never creates folders");
    }

    #[test]
    fn create_new_home_refuses_non_empty_unless_use_existing() {
        let home = fake_home();
        let data = tempfile::tempdir().unwrap();
        let store = ProfileStore::load_with_home(data.path().join("profiles.json"), Some(home.path().to_path_buf()));
        let codex = accounts::spec_for(AgentKind::Codex, None).unwrap();
        let dir = home.path().join(".codex-busy");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("config.toml"), b"model = 'x'").unwrap();
        let plan = store.plan_home(codex, "busy").unwrap();
        assert!(plan.exists && !plan.empty);
        assert!(matches!(store.create_new_home(codex, "busy".into(), false, None, None), Err(AppError::Invalid(_))));
        let a = store.create_new_home(codex, "busy".into(), true, None, None).unwrap();
        assert_eq!(std::fs::read(dir.join("config.toml")).unwrap(), b"model = 'x'", "never modified");
        assert!(a.status.dir_exists);
        // An existing EMPTY folder is fine without use_existing.
        std::fs::create_dir_all(home.path().join(".codex-fresh")).unwrap();
        assert!(store.create_new_home(codex, "fresh".into(), false, None, None).is_ok());
    }
}
