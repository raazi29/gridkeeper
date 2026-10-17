//! Claude account profiles (`profiles.json`).
//!
//! A profile is a name + an optional `CLAUDE_CONFIG_DIR`. `config_dir: None`
//! is the default profile: Claude Code's own default location
//! (`%USERPROFILE%\.claude`), launched with `CLAUDE_CONFIG_DIR` removed.
//!
//! Security: credential files are only ever checked for EXISTENCE by name.
//! Nothing under a profile directory is read, copied, modified or deleted;
//! deleting a profile removes the entry only. Account e-mails returned by
//! `claude auth status` go to the UI only — never to logs or to disk.

use std::path::{Path, PathBuf};
use std::time::Duration;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

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

/// On-disk shape: no computed status.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredProfile {
    id: String,
    name: String,
    #[serde(default)]
    config_dir: Option<String>,
    color: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct ProfilesFile {
    version: u32,
    #[serde(default)]
    profiles: Vec<StoredProfile>,
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

/// Cheap, filename-only status.
fn cheap_status(root: Option<&Path>) -> ProfileStatus {
    let dir_exists = root.is_some_and(Path::is_dir);
    ProfileStatus {
        dir_exists,
        likely_authenticated: dir_exists && root.is_some_and(|r| r.join(".credentials.json").is_file()),
        verified: false,
        note: (!dir_exists).then(|| "Directory does not exist".to_string()),
        ..Default::default()
    }
}

/// Lower-cased, separator-normalized form for equality checks.
fn normalize_dir(p: &str) -> String {
    let canon = std::fs::canonicalize(p)
        .map(|c| c.to_string_lossy().trim_start_matches(r"\\?\").to_string())
        .unwrap_or_else(|_| p.to_string());
    canon.replace('/', "\\").trim_end_matches('\\').to_lowercase()
}

fn valid_color(c: &str) -> bool {
    c.len() == 7 && c.starts_with('#') && c[1..].chars().all(|ch| ch.is_ascii_hexdigit())
}

/// Sibling `.claude-*` directories that look like real Claude config dirs.
fn discover_profile_dirs(home: &Path) -> Vec<(String, PathBuf)> {
    let Ok(entries) = std::fs::read_dir(home) else {
        return Vec::new();
    };
    let mut found: Vec<(String, PathBuf)> = entries
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let suffix = name.strip_prefix(".claude-")?.to_string();
            if suffix.is_empty() || !e.file_type().ok()?.is_dir() {
                return None;
            }
            let path = e.path();
            // Existence checks by name only. A credentials file is conclusive; a bare
            // settings.json is not (tool dirs like .claude-mem have their own), so it
            // must come with Claude's state file or transcript folder.
            let is_config = path.join(".credentials.json").is_file()
                || (path.join("settings.json").is_file()
                    && (path.join(".claude.json").is_file() || path.join("projects").is_dir()));
            is_config.then_some((suffix, path))
        })
        .collect();
    found.sort_by_key(|a| a.0.to_lowercase());
    found
}

pub struct ProfileStore {
    path: PathBuf,
    home: Option<PathBuf>,
    profiles: Mutex<Vec<StoredProfile>>,
}

impl ProfileStore {
    /// Load `profiles.json`, seeding it on first run from the user's home directory.
    pub fn load(path: PathBuf) -> Self {
        Self::load_with_home(path, discovery::home_dir())
    }

    /// Like `load`, with an explicit home directory for seeding/default-dir status.
    pub fn load_with_home(path: PathBuf, home: Option<PathBuf>) -> Self {
        let existing = if path.exists() {
            match std::fs::read_to_string(&path).map_err(|e| e.to_string()).and_then(|t| {
                serde_json::from_str::<ProfilesFile>(&t).map_err(|e| e.to_string())
            }) {
                Ok(f) => {
                    if f.version > PROFILES_VERSION {
                        tracing::warn!(version = f.version, "profiles.json is from a newer Gridkeeper; loading best-effort");
                    }
                    Some(f.profiles)
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
        let mut profiles = existing.unwrap_or_else(|| Self::seed(home.as_deref()));
        Self::dedupe(&mut profiles);
        let store = Self { path, home, profiles: Mutex::new(profiles) };
        if seeded {
            let list = store.profiles.lock().clone();
            tracing::info!(count = list.len(), "seeded Claude profiles");
            if let Err(e) = store.persist(&list) {
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
        }];
        if let Some(home) = home {
            for (i, (suffix, path)) in discover_profile_dirs(home).into_iter().enumerate() {
                out.push(StoredProfile {
                    id: uuid::Uuid::new_v4().to_string(),
                    name: suffix,
                    config_dir: Some(path.to_string_lossy().into_owned()),
                    color: PALETTE[(i + 1) % PALETTE.len()].into(),
                });
            }
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

    fn persist(&self, list: &[StoredProfile]) -> AppResult<()> {
        let file = ProfilesFile { version: PROFILES_VERSION, profiles: list.to_vec() };
        let bytes = serde_json::to_vec_pretty(&file).map_err(|e| AppError::Other(e.to_string()))?;
        atomic_write(&self.path, &bytes, true)?;
        Ok(())
    }

    fn to_public(&self, p: &StoredProfile) -> ClaudeProfile {
        let root = config_root_in(p.config_dir.as_deref(), self.home.as_deref());
        ClaudeProfile {
            id: p.id.clone(),
            name: p.name.clone(),
            config_dir: p.config_dir.clone(),
            color: p.color.clone(),
            status: cheap_status(root.as_deref()),
        }
    }

    pub fn list(&self) -> Vec<ClaudeProfile> {
        self.profiles.lock().iter().map(|p| self.to_public(p)).collect()
    }

    pub fn get(&self, id: &str) -> Option<ClaudeProfile> {
        self.profiles.lock().iter().find(|p| p.id == id).map(|p| self.to_public(p))
    }

    /// The profile using Claude's default location (no CLAUDE_CONFIG_DIR), if any.
    pub fn default_profile(&self) -> Option<ClaudeProfile> {
        let list = self.profiles.lock();
        list.iter()
            .find(|p| p.config_dir.is_none())
            .or_else(|| list.iter().find(|p| p.id == DEFAULT_PROFILE_ID))
            .map(|p| self.to_public(p))
    }

    fn validate_name(list: &[StoredProfile], name: &str, except_id: Option<&str>) -> AppResult<String> {
        let name = name.trim();
        if name.is_empty() {
            return Err(AppError::Invalid("Profile name must not be empty".into()));
        }
        if name.chars().count() > 64 || name.contains('\0') {
            return Err(AppError::Invalid("Profile name is too long or contains invalid characters".into()));
        }
        if list.iter().any(|p| Some(p.id.as_str()) != except_id && p.name.trim().eq_ignore_ascii_case(name)) {
            return Err(AppError::Invalid(format!("A profile named {name:?} already exists")));
        }
        Ok(name.to_string())
    }

    /// Validate (and create if missing) a profile directory. Existing directories
    /// are never modified.
    fn validate_dir(
        &self,
        list: &[StoredProfile],
        config_dir: Option<String>,
        except_id: Option<&str>,
    ) -> AppResult<Option<String>> {
        let others = list.iter().filter(|p| Some(p.id.as_str()) != except_id);
        let Some(dir) = config_dir.map(|d| d.trim().to_string()).filter(|d| !d.is_empty()) else {
            if others.clone().any(|p| p.config_dir.is_none()) {
                return Err(AppError::Invalid(
                    "Another profile already uses Claude's default location; choose a directory".into(),
                ));
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
        let norm = normalize_dir(&dir);
        if let Some(default_root) = self.home.as_ref().map(|h| h.join(".claude"))
            && normalize_dir(&default_root.to_string_lossy()) == norm
            && others.clone().any(|p| p.config_dir.is_none())
        {
            return Err(AppError::Invalid(
                "That directory is Claude's default location, already used by the default profile".into(),
            ));
        }
        if let Some(clash) = others.clone().find(|p| p.config_dir.as_deref().is_some_and(|d| normalize_dir(d) == norm)) {
            return Err(AppError::Invalid(format!("Profile {:?} already uses that directory", clash.name)));
        }
        if path.exists() {
            if !path.is_dir() {
                return Err(AppError::Invalid(format!("Not a directory: {dir}")));
            }
        } else {
            std::fs::create_dir_all(&path)?;
            tracing::info!("created new empty Claude profile directory");
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

    pub fn create(&self, name: String, config_dir: Option<String>, color: Option<String>) -> AppResult<ClaudeProfile> {
        let mut list = self.profiles.lock();
        let name = Self::validate_name(&list, &name, None)?;
        let color = Self::pick_color(&list, color)?;
        let config_dir = self.validate_dir(&list, config_dir, None)?;
        let stored = StoredProfile { id: uuid::Uuid::new_v4().to_string(), name, config_dir, color };
        let mut next = list.clone();
        next.push(stored.clone());
        self.persist(&next)?;
        *list = next;
        tracing::info!(profile = %stored.id, "created Claude profile");
        Ok(self.to_public(&stored))
    }

    pub fn update(&self, profile: ClaudeProfile) -> AppResult<ClaudeProfile> {
        let mut list = self.profiles.lock();
        let idx = list
            .iter()
            .position(|p| p.id == profile.id)
            .ok_or_else(|| AppError::NotFound(format!("Claude profile {}", profile.id)))?;
        let name = Self::validate_name(&list, &profile.name, Some(&profile.id))?;
        let config_dir = if profile.config_dir.as_deref().map(str::trim) == list[idx].config_dir.as_deref() {
            list[idx].config_dir.clone()
        } else {
            self.validate_dir(&list, profile.config_dir.clone(), Some(&profile.id))?
        };
        let color = if valid_color(profile.color.trim()) {
            profile.color.trim().to_uppercase()
        } else {
            return Err(AppError::Invalid(format!("Invalid color {:?}; expected #RRGGBB", profile.color)));
        };
        let mut next = list.clone();
        next[idx] = StoredProfile { id: profile.id.clone(), name, config_dir, color };
        self.persist(&next)?;
        *list = next;
        Ok(self.to_public(&list[idx]))
    }

    /// Remove the entry only. The directory and its contents are never touched.
    pub fn delete(&self, id: &str) -> AppResult<()> {
        let mut list = self.profiles.lock();
        let before = list.len();
        let next: Vec<StoredProfile> = list.iter().filter(|p| p.id != id).cloned().collect();
        if next.len() == before {
            return Err(AppError::NotFound(format!("Claude profile {id}")));
        }
        self.persist(&next)?;
        *list = next;
        tracing::info!(profile = %id, "removed Claude profile entry");
        Ok(())
    }
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
pub fn check_status(profile: &ClaudeProfile, settings: &Settings) -> AppResult<ProfileStatus> {
    let root = config_root(profile);
    let base = cheap_status(root.as_deref());
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
}
