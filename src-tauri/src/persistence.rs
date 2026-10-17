//! Workspace state persistence (`workspaces.json`).
//!
//! Guarantees:
//! - Versioned: `migrate` upgrades older files; a file written by a NEWER
//!   version is loaded best-effort and the store becomes read-only so we
//!   never clobber data we do not understand.
//! - Never silently deletes: an unparseable file is renamed to
//!   `workspaces.corrupt-<timestamp>.json`; a file that parses but contains
//!   invalid entries is copied there before the invalid entries are dropped.
//! - Atomic: write `<file>.tmp`, fsync, keep one `<file>.bak` of the previous
//!   good file, rename over.
//! - Self-healing: `sanitize` dedupes ids, drops dangling references and
//!   orphans, clamps settings, and strips secret-looking env vars.

use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use parking_lot::Mutex;
use serde_json::{Map, Value};

use crate::types::*;

// ---------------------------------------------------------------------------
// File helpers (shared with `profiles`)
// ---------------------------------------------------------------------------

fn sibling_with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    name.push(suffix);
    path.with_file_name(name)
}

/// Atomically replace `path` with `bytes`. With `backup`, the previous file is
/// copied to `<file>.bak` first if it is valid JSON (at most one backup kept).
pub fn atomic_write(path: &Path, bytes: &[u8], backup: bool) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = sibling_with_suffix(path, ".tmp");
    {
        let mut f = File::create(&tmp)?;
        f.write_all(bytes)?;
        f.flush()?;
        f.sync_all()?;
    }
    if backup && path.is_file() {
        let previous_is_good = fs::read_to_string(path)
            .ok()
            .map(|s| serde_json::from_str::<serde::de::IgnoredAny>(&s).is_ok())
            .unwrap_or(false);
        if previous_is_good
            && let Err(e) = fs::copy(path, sibling_with_suffix(path, ".bak"))
        {
            tracing::warn!(error = %e, "could not write state backup");
        }
    }
    // Antivirus / indexers can hold the destination briefly; retry a few times.
    let mut attempt = 0;
    loop {
        match fs::rename(&tmp, path) {
            Ok(()) => return Ok(()),
            Err(e) if attempt < 4 && e.kind() == io::ErrorKind::PermissionDenied => {
                attempt += 1;
                std::thread::sleep(std::time::Duration::from_millis(50 * attempt));
            }
            Err(e) => {
                let _ = fs::remove_file(&tmp);
                return Err(e);
            }
        }
    }
}

/// `<dir>/<stem>.corrupt-<timestamp>.json`, unique.
fn corrupt_path(path: &Path) -> PathBuf {
    let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "state".into());
    let ts = chrono::Local::now().format("%Y%m%d-%H%M%S%3f");
    let mut candidate = path.with_file_name(format!("{stem}.corrupt-{ts}.json"));
    let mut n = 1;
    while candidate.exists() {
        candidate = path.with_file_name(format!("{stem}.corrupt-{ts}-{n}.json"));
        n += 1;
    }
    candidate
}

/// Move (or copy, when `keep_original`) a damaged file aside. Returns the new path.
pub fn preserve_corrupt(path: &Path, keep_original: bool) -> Option<PathBuf> {
    let dest = corrupt_path(path);
    let res = if keep_original { fs::copy(path, &dest).map(|_| ()) } else { fs::rename(path, &dest) };
    match res {
        Ok(()) => {
            tracing::warn!(file = %path.display(), preserved = %dest.display(), "preserved damaged state file");
            Some(dest)
        }
        Err(e) => {
            tracing::error!(file = %path.display(), error = %e, "could not preserve damaged state file");
            None
        }
    }
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

/// Result of interpreting a parsed `workspaces.json`.
#[derive(Debug)]
pub struct Migrated {
    pub state: PersistedState,
    /// The file came from a newer Altera; do not overwrite it.
    pub read_only: bool,
    /// Some entries could not be deserialized and were dropped.
    pub lossy: bool,
    /// The on-disk version before migration.
    pub from_version: u64,
}

fn lenient_vec<T: serde::de::DeserializeOwned>(v: Option<&Value>, lossy: &mut bool) -> Vec<T> {
    match v {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|item| {
                let r = serde_json::from_value(item.clone()).ok();
                if r.is_none() {
                    *lossy = true;
                }
                r
            })
            .collect(),
        Some(_) => {
            *lossy = true;
            Vec::new()
        }
    }
}

fn lenient_settings(v: Option<&Value>, lossy: &mut bool) -> Settings {
    let Some(Value::Object(input)) = v else {
        if v.is_some_and(|v| !v.is_null()) {
            *lossy = true;
        }
        return Settings::default();
    };
    let mut merged = match serde_json::to_value(Settings::default()) {
        Ok(Value::Object(m)) => m,
        _ => return Settings::default(),
    };
    for (k, val) in input {
        let previous = merged.insert(k.clone(), val.clone());
        if serde_json::from_value::<Settings>(Value::Object(merged.clone())).is_err() {
            *lossy = true;
            match previous {
                Some(p) => merged.insert(k.clone(), p),
                None => merged.remove(k),
            };
        }
    }
    serde_json::from_value(Value::Object(merged)).unwrap_or_default()
}

fn lenient_state(obj: &Map<String, Value>, lossy: &mut bool) -> PersistedState {
    PersistedState {
        version: STATE_VERSION,
        settings: lenient_settings(obj.get("settings"), lossy),
        workspaces: lenient_vec(obj.get("workspaces"), lossy),
        sessions: lenient_vec(obj.get("sessions"), lossy),
        active_workspace_id: obj
            .get("activeWorkspaceId")
            .and_then(|v| serde_json::from_value(v.clone()).ok())
            .flatten(),
    }
}

/// Upgrade a parsed state document to the current schema.
///
/// - missing / 0 → v1 (v0 had the same shape without a version field)
/// - `STATE_VERSION` → as is
/// - newer → best-effort read, `read_only = true`
pub fn migrate(value: Value) -> Result<Migrated, String> {
    let Value::Object(mut obj) = value else {
        return Err("top-level JSON value is not an object".into());
    };
    let from_version = obj.get("version").and_then(Value::as_u64).unwrap_or(0);
    let read_only = from_version > STATE_VERSION as u64;
    if from_version < 1 {
        obj.insert("version".into(), Value::from(1u32));
    }
    // Future migrations: `if from_version < 2 { ...transform obj... }`

    let mut lossy = false;
    let mut state = match serde_json::from_value::<PersistedState>(Value::Object(obj.clone())) {
        Ok(s) => s,
        Err(_) => lenient_state(&obj, &mut lossy),
    };
    state.version = STATE_VERSION;
    Ok(Migrated { state, read_only, lossy, from_version })
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

fn has_nul(s: &str) -> bool {
    s.contains('\0')
}

fn session_has_nul(m: &SessionMeta) -> bool {
    has_nul(&m.cwd)
        || m.command.as_deref().is_some_and(has_nul)
        || m.args.iter().any(|a| has_nul(a))
        || m.worktree.as_ref().is_some_and(|w| has_nul(&w.path))
}

/// Reject state that contains NUL characters in any path (used by `save`).
pub fn check_paths(state: &PersistedState) -> AppResult<()> {
    if let Some(m) = state.sessions.iter().find(|m| session_has_nul(m)) {
        return Err(AppError::Invalid(format!("Session {:?} has a path containing a NUL character", m.name)));
    }
    if let Some(w) = state.workspaces.iter().find(|w| w.project_dir.as_deref().is_some_and(has_nul)) {
        return Err(AppError::Invalid(format!("Workspace {:?} has a path containing a NUL character", w.name)));
    }
    let p = &state.settings.agent_paths;
    if [&p.claude, &p.codex, &p.powershell].iter().any(|o| o.as_deref().is_some_and(has_nul)) {
        return Err(AppError::Invalid("An agent path contains a NUL character".into()));
    }
    Ok(())
}

fn sanitize_settings(s: &mut Settings) {
    let d = Settings::default();
    s.scrollback_lines = s.scrollback_lines.clamp(100, 200_000);
    s.buffer_kib = s.buffer_kib.clamp(256, 65_536);
    s.font_size = if s.font_size.is_finite() { s.font_size.clamp(8.0, 32.0) } else { d.font_size };
    s.line_height = if s.line_height.is_finite() { s.line_height.clamp(1.0, 2.0) } else { d.line_height };
    if s.font_family.trim().is_empty() || has_nul(&s.font_family) {
        s.font_family = d.font_family;
    }
    for p in [&mut s.agent_paths.claude, &mut s.agent_paths.codex, &mut s.agent_paths.powershell] {
        if p.as_deref().is_some_and(|v| v.trim().is_empty() || has_nul(v)) {
            *p = None;
        }
    }
    s.keybindings.retain(|k, v| !has_nul(k) && !has_nul(v));
}

/// Repair a state document in place-ish. Returns the repaired state and a
/// list of human-readable notes about what was changed (for logs; no values).
pub fn sanitize(mut state: PersistedState) -> (PersistedState, Vec<String>) {
    use std::collections::HashSet;
    let mut notes = Vec::new();
    state.version = STATE_VERSION;
    sanitize_settings(&mut state.settings);

    // Sessions: unique, non-empty ids; no NUL paths; no secret env.
    let mut seen = HashSet::new();
    let before = state.sessions.len();
    state.sessions.retain(|m| !m.id.is_empty() && !session_has_nul(m) && seen.insert(m.id.clone()));
    if state.sessions.len() != before {
        notes.push(format!("dropped {} duplicate/invalid sessions", before - state.sessions.len()));
    }
    for m in &mut state.sessions {
        let n = m.env.len();
        m.env.retain(|e| {
            !e.key.is_empty()
                && !e.key.contains('=')
                && !has_nul(&e.key)
                && !has_nul(&e.value)
                && !crate::redact::is_secret_key(&e.key)
        });
        if m.env.len() != n {
            notes.push(format!("stripped {} secret/invalid env vars from a session", n - m.env.len()));
        }
        if m.worktree.as_ref().is_some_and(|w| w.path.trim().is_empty()) {
            m.worktree = None;
        }
    }
    let known: HashSet<String> = state.sessions.iter().map(|m| m.id.clone()).collect();

    // Workspaces & groups: unique ids; each session in at most one group.
    let mut ws_seen = HashSet::new();
    let mut group_seen = HashSet::new();
    let mut placed: HashSet<String> = HashSet::new();
    let before = state.workspaces.len();
    state.workspaces.retain(|w| !w.id.is_empty() && ws_seen.insert(w.id.clone()));
    if state.workspaces.len() != before {
        notes.push(format!("dropped {} duplicate/invalid workspaces", before - state.workspaces.len()));
    }
    for w in &mut state.workspaces {
        if w.project_dir.as_deref().is_some_and(|p| has_nul(p) || p.trim().is_empty()) {
            w.project_dir = None;
        }
        let gb = w.groups.len();
        w.groups.retain(|g| !g.id.is_empty() && group_seen.insert(g.id.clone()));
        if w.groups.len() != gb {
            notes.push(format!("dropped {} duplicate/invalid groups", gb - w.groups.len()));
        }
        for g in &mut w.groups {
            let sb = g.session_ids.len();
            g.session_ids.retain(|id| known.contains(id) && placed.insert(id.clone()));
            if g.session_ids.len() != sb {
                notes.push(format!("dropped {} dangling/duplicate pane references", sb - g.session_ids.len()));
            }
            if g.layout.maximized.as_ref().is_some_and(|m| !g.session_ids.contains(m)) {
                g.layout.maximized = None;
            }
        }
        if w.active_group_id.as_ref().is_none_or(|a| !w.groups.iter().any(|g| &g.id == a)) {
            let fixed = w.groups.first().map(|g| g.id.clone());
            if w.active_group_id.is_some() && w.active_group_id != fixed {
                notes.push("fixed dangling active group".into());
            }
            w.active_group_id = fixed;
        }
    }

    // Orphans: sessions not shown in any group.
    let before = state.sessions.len();
    state.sessions.retain(|m| placed.contains(&m.id));
    if state.sessions.len() != before {
        notes.push(format!("dropped {} orphan sessions", before - state.sessions.len()));
    }

    if state.active_workspace_id.as_ref().is_none_or(|a| !state.workspaces.iter().any(|w| &w.id == a)) {
        let fixed = state.workspaces.first().map(|w| w.id.clone());
        if state.active_workspace_id.is_some() && state.active_workspace_id != fixed {
            notes.push("fixed dangling active workspace".into());
        }
        state.active_workspace_id = fixed;
    }
    (state, notes)
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

pub struct StateStore {
    path: PathBuf,
    state: Mutex<PersistedState>,
    /// Serializes writers so concurrent saves never share the temp file.
    write_lock: Mutex<()>,
    /// `Some(reason)` when saving must be refused.
    read_only: Option<String>,
}

impl StateStore {
    pub fn load(path: PathBuf) -> Self {
        let (state, read_only) = Self::read(&path);
        Self { path, state: Mutex::new(state), write_lock: Mutex::new(()), read_only }
    }

    fn read(path: &Path) -> (PersistedState, Option<String>) {
        if !path.exists() {
            tracing::info!("no workspace state yet; starting with defaults");
            return (PersistedState::default(), None);
        }
        let text = match fs::read_to_string(path) {
            Ok(t) => t,
            Err(e) => {
                // Unreadable (locked, permissions, invalid UTF-8): keep it untouched.
                tracing::error!(error = %e, "cannot read workspace state; continuing read-only with defaults");
                return (
                    PersistedState::default(),
                    Some(format!("Workspace state file could not be read ({e}); saving is disabled to avoid overwriting it")),
                );
            }
        };
        let value: Value = match serde_json::from_str(&text) {
            Ok(v) => v,
            Err(e) => {
                tracing::error!(error = %e, "workspace state is not valid JSON");
                preserve_corrupt(path, false);
                return (PersistedState::default(), None);
            }
        };
        let migrated = match migrate(value) {
            Ok(m) => m,
            Err(e) => {
                tracing::error!(error = %e, "workspace state has an unexpected shape");
                preserve_corrupt(path, false);
                return (PersistedState::default(), None);
            }
        };
        if migrated.lossy {
            tracing::warn!("some workspace entries could not be read and were dropped; original preserved");
            preserve_corrupt(path, true);
        }
        let read_only = migrated.read_only.then(|| {
            tracing::warn!(
                file_version = migrated.from_version,
                supported = STATE_VERSION,
                "workspace state written by a newer Altera; loaded read-only"
            );
            format!(
                "The workspace file was written by a newer version of Altera (format v{}, this build supports v{}). \
                 Changes are not saved to avoid overwriting it; update Altera.",
                migrated.from_version, STATE_VERSION
            )
        });
        if migrated.from_version < STATE_VERSION as u64 {
            tracing::info!(from = migrated.from_version, to = STATE_VERSION, "migrated workspace state");
        }
        let (state, notes) = sanitize(migrated.state);
        for n in notes {
            tracing::warn!(note = %n, "workspace state repaired on load");
        }
        (state, read_only)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn is_read_only(&self) -> bool {
        self.read_only.is_some()
    }

    pub fn get(&self) -> PersistedState {
        self.state.lock().clone()
    }

    pub fn settings(&self) -> Settings {
        self.state.lock().settings.clone()
    }

    pub fn save(&self, state: PersistedState) -> AppResult<()> {
        if let Some(reason) = &self.read_only {
            return Err(AppError::Invalid(reason.clone()));
        }
        check_paths(&state)?;
        let (state, notes) = sanitize(state);
        for n in notes {
            tracing::debug!(note = %n, "workspace state normalized on save");
        }
        let bytes = serde_json::to_vec_pretty(&state).map_err(|e| AppError::Other(e.to_string()))?;
        {
            let _w = self.write_lock.lock();
            atomic_write(&self.path, &bytes, true)?;
        }
        *self.state.lock() = state;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn session(id: &str) -> SessionMeta {
        SessionMeta {
            id: id.into(),
            name: format!("s-{id}"),
            agent: AgentKind::Powershell,
            cwd: r"C:\work".into(),
            profile_id: None,
            command: None,
            args: vec![],
            env: vec![],
            auto_start: false,
            resume_on_restore: ResumeMode::None,
            agent_session_id: None,
            worktree: None,
            created_at: None,
            last_exit_code: None,
        }
    }

    fn sample() -> PersistedState {
        PersistedState {
            version: STATE_VERSION,
            settings: Settings::default(),
            workspaces: vec![Workspace {
                id: "w1".into(),
                name: "Main".into(),
                project_dir: Some(r"C:\work".into()),
                groups: vec![Group {
                    id: "g1".into(),
                    name: "G".into(),
                    layout: Layout::default(),
                    session_ids: vec!["a".into(), "b".into()],
                }],
                active_group_id: Some("g1".into()),
                created_at: None,
            }],
            sessions: vec![session("a"), session("b")],
            active_workspace_id: Some("w1".into()),
        }
    }

    fn files_in(dir: &Path) -> Vec<String> {
        let mut v: Vec<String> =
            fs::read_dir(dir).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        v.sort();
        v
    }

    #[test]
    fn missing_file_gives_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let store = StateStore::load(dir.path().join("workspaces.json"));
        assert_eq!(store.get().version, STATE_VERSION);
        assert!(store.get().workspaces.is_empty());
        assert!(!store.is_read_only());
    }

    #[test]
    fn roundtrip_and_backup() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workspaces.json");
        let store = StateStore::load(path.clone());
        store.save(sample()).unwrap();
        assert!(!path.with_file_name("workspaces.json.bak").exists(), "no backup on first save");

        let mut second = sample();
        second.workspaces[0].name = "Renamed".into();
        store.save(second).unwrap();
        assert!(path.with_file_name("workspaces.json.bak").exists());
        assert!(!path.with_file_name("workspaces.json.tmp").exists());

        let reloaded = StateStore::load(path.clone()).get();
        assert_eq!(reloaded.workspaces[0].name, "Renamed");
        assert_eq!(reloaded.sessions.len(), 2);
        let bak: Value = serde_json::from_str(&fs::read_to_string(path.with_file_name("workspaces.json.bak")).unwrap()).unwrap();
        assert_eq!(bak["workspaces"][0]["name"], "Main");
    }

    #[test]
    fn corrupt_file_is_preserved() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workspaces.json");
        fs::write(&path, "{ not json").unwrap();
        let store = StateStore::load(path.clone());
        assert!(store.get().workspaces.is_empty());
        assert!(!path.exists());
        let files = files_in(dir.path());
        let corrupt: Vec<_> = files.iter().filter(|f| f.starts_with("workspaces.corrupt-")).collect();
        assert_eq!(corrupt.len(), 1, "{files:?}");
        assert_eq!(fs::read_to_string(dir.path().join(corrupt[0])).unwrap(), "{ not json");
        // Saving afterwards works and does not touch the preserved copy.
        store.save(sample()).unwrap();
        assert!(path.exists());
    }

    #[test]
    fn migrates_v0() {
        let v0 = json!({
            "workspaces": [{ "id": "w1", "name": "Old", "groups": [{ "id": "g1", "name": "G", "sessionIds": ["a"] }] }],
            "sessions": [{ "id": "a", "name": "A", "agent": "claude", "cwd": "C:\\x" }],
            "settings": { "fontSize": 14 }
        });
        let m = migrate(v0).unwrap();
        assert_eq!(m.from_version, 0);
        assert!(!m.read_only && !m.lossy);
        assert_eq!(m.state.version, STATE_VERSION);
        assert_eq!(m.state.settings.font_size, 14.0);
        assert_eq!(m.state.settings.scrollback_lines, Settings::default().scrollback_lines);
        assert_eq!(m.state.sessions[0].agent, AgentKind::Claude);
    }

    #[test]
    fn lenient_load_keeps_good_entries_and_preserves_original() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workspaces.json");
        let doc = json!({
            "version": 1,
            "settings": { "fontSize": "huge", "scrollbackLines": 9000 },
            "workspaces": [{ "id": "w1", "name": "W", "groups": [{ "id": "g1", "name": "G", "sessionIds": ["a", "bad"] }] }],
            "sessions": [
                { "id": "a", "name": "A", "agent": "codex", "cwd": "C:\\x" },
                { "id": "bad", "name": "B", "agent": "not-an-agent", "cwd": "C:\\x" }
            ]
        });
        fs::write(&path, doc.to_string()).unwrap();
        let st = StateStore::load(path.clone()).get();
        assert_eq!(st.sessions.len(), 1);
        assert_eq!(st.workspaces[0].groups[0].session_ids, vec!["a".to_string()]);
        assert_eq!(st.settings.scrollback_lines, 9000);
        assert_eq!(st.settings.font_size, Settings::default().font_size);
        assert!(path.exists(), "original stays in place");
        assert!(files_in(dir.path()).iter().any(|f| f.starts_with("workspaces.corrupt-")));
    }

    #[test]
    fn newer_version_is_read_only() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workspaces.json");
        let mut doc = serde_json::to_value(sample()).unwrap();
        doc["version"] = json!(STATE_VERSION + 1);
        doc["futureField"] = json!({ "x": 1 });
        let original = doc.to_string();
        fs::write(&path, &original).unwrap();
        let store = StateStore::load(path.clone());
        assert!(store.is_read_only());
        assert_eq!(store.get().workspaces.len(), 1);
        let err = store.save(sample()).unwrap_err();
        assert!(matches!(err, AppError::Invalid(_)));
        assert_eq!(fs::read_to_string(&path).unwrap(), original, "newer file untouched");
    }

    #[test]
    fn sanitize_repairs_references_and_clamps() {
        let mut st = sample();
        st.sessions.push(session("a")); // duplicate id
        st.sessions.push(session("orphan"));
        st.workspaces[0].groups[0].session_ids.push("ghost".into());
        st.workspaces[0].groups[0].session_ids.push("a".into()); // duplicate placement
        st.workspaces[0].groups[0].layout.maximized = Some("ghost".into());
        st.workspaces.push(st.workspaces[0].clone()); // duplicate workspace id
        st.workspaces[0].active_group_id = Some("nope".into());
        st.active_workspace_id = Some("nope".into());
        st.settings.scrollback_lines = 10;
        st.settings.buffer_kib = 1_000_000;
        st.settings.font_size = f32::NAN;
        st.settings.line_height = 5.0;
        st.sessions[0].env = vec![
            EnvVar { key: "ANTHROPIC_API_KEY".into(), value: "sk-ant-xxx".into() },
            EnvVar { key: "GITHUB_TOKEN".into(), value: "ghp_x".into() },
            EnvVar { key: "MY_FLAG".into(), value: "1".into() },
        ];

        let (st, notes) = sanitize(st);
        assert!(!notes.is_empty());
        assert_eq!(st.workspaces.len(), 1);
        assert_eq!(st.sessions.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), vec!["a", "b"]);
        let g = &st.workspaces[0].groups[0];
        assert_eq!(g.session_ids, vec!["a".to_string(), "b".to_string()]);
        assert_eq!(g.layout.maximized, None);
        assert_eq!(st.workspaces[0].active_group_id.as_deref(), Some("g1"));
        assert_eq!(st.active_workspace_id.as_deref(), Some("w1"));
        assert_eq!(st.settings.scrollback_lines, 100);
        assert_eq!(st.settings.buffer_kib, 65_536);
        assert_eq!(st.settings.font_size, Settings::default().font_size);
        assert_eq!(st.settings.line_height, 2.0);
        assert_eq!(st.sessions[0].env, vec![EnvVar { key: "MY_FLAG".into(), value: "1".into() }]);
    }

    #[test]
    fn save_rejects_nul_and_strips_secrets_on_disk() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workspaces.json");
        let store = StateStore::load(path.clone());
        let mut bad = sample();
        bad.sessions[0].cwd = "C:\\a\0b".into();
        assert!(matches!(store.save(bad), Err(AppError::Invalid(_))));
        assert!(!path.exists());

        let mut st = sample();
        st.sessions[0].env = vec![EnvVar { key: "OPENAI_API_KEY".into(), value: "sk-supersecretvalue".into() }];
        store.save(st).unwrap();
        let text = fs::read_to_string(&path).unwrap();
        assert!(!text.contains("sk-supersecretvalue"));
        assert!(!text.contains("OPENAI_API_KEY"));
    }

    #[test]
    fn non_object_json_is_preserved() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workspaces.json");
        fs::write(&path, "[1,2,3]").unwrap();
        let store = StateStore::load(path.clone());
        assert!(store.get().workspaces.is_empty());
        assert!(files_in(dir.path()).iter().any(|f| f.starts_with("workspaces.corrupt-")));
    }
}
