//! Cost & context meter for Claude Code panes (opt-in: Settings › Agents › "Cost & context meter").
//!
//! Source: Claude Code's own status line JSON (see `docs/research-notes/cost-token-sources.md`).
//! - **Launch** ([`launch::prepare_claude`], called by the Claude adapter): writes
//!   `<data>\meter\settings-<session>.json` = `{"statusLine":{"type":"command","command":"<helper>","padding":0}}`
//!   and adds `--settings <that file>` (Claude's per-process settings layer; nothing in the agent's
//!   home is written). Skipped when the pane passes its own `--settings`.
//! - **Helper** ([`helper`], `gridkeeper.exe --gk-statusline ...`): run by Claude Code on each status line
//!   update; keeps a whitelisted subset of the JSON (never `transcript_path`) in `<data>\meter\<session>.json`
//!   and prints the user's own status line when one is chained.
//! - **Host** ([`MeterHub`]): watches `<data>\meter\` (ReadDirectoryChangesW through `notify`, no
//!   polling), keeps a running pane total across `/clear` (the sum of the last cost seen per Claude
//!   session id) and emits `session-meter` events. Files of removed sessions are deleted; files older
//!   than [`STALE_AFTER`] are cleaned up at startup.
//! - **Hooks** ([`hooks`], opt-in with the meter): the same settings file adds Claude Code hooks that
//!   write `<data>\meter\<session>.hooks.json`; the same watch turns them into exact `session-attention`
//!   states (`kind = hook`: permission, tool, stopped, ...).
//! - **Ledger** ([`ledger`]): the spend guard's small per-day file (`<data>\spend-ledger.json`), owned
//!   by the frontend (src/store/spend.ts); Rust only stores it.

pub mod helper;
pub mod hooks;
pub mod launch;
pub mod ledger;
pub mod shell;

use std::collections::{BTreeMap, HashMap};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use notify::{RecursiveMode, Watcher};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use crate::types::{AppError, AppResult, MeterStatus, SessionAttention, SessionId, SessionMeter};

/// Folder inside the data folder.
pub const DIR_NAME: &str = "meter";
/// Tauri bundle identifier = name of the data folder under `%APPDATA%` (checked against
/// `tauri.conf.json` by a test). The helper runs without Tauri, so it can't ask.
pub const APP_IDENTIFIER: &str = "app.gridkeeper.desktop";
/// Meter records larger than this are ignored.
pub const MAX_RECORD_BYTES: u64 = 64 * 1024;
/// Meter files untouched for this long are deleted at startup.
pub const STALE_AFTER: Duration = Duration::from_secs(7 * 24 * 3600);
/// Distinct Claude conversations remembered per pane before the oldest are folded into the bank.
const MAX_BUCKETS: usize = 64;
pub const RECORD_VERSION: u32 = 1;
const SETTINGS_PREFIX: &str = "settings-";

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

pub fn meter_dir(data_dir: &Path) -> PathBuf {
    data_dir.join(DIR_NAME)
}

/// Gridkeeper session ids usable in meter file names: `[A-Za-z0-9_-]{1,64}`, not `settings-…`.
pub fn valid_session_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && !id.starts_with(SETTINGS_PREFIX)
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

pub fn record_name(id: &str) -> String {
    format!("{id}.json")
}

pub fn settings_name(id: &str) -> String {
    format!("{SETTINGS_PREFIX}{id}.json")
}

/// The session id of a meter record file name (`<id>.json`), if it is one.
pub fn session_of_record_name(name: &str) -> Option<&str> {
    name.strip_suffix(".json").filter(|id| valid_session_id(id))
}

/// One rate-limit window (`rate_limits.<name>`): numbers and a short period name only.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RateWindow {
    pub used_pct: Option<f64>,
    /// Unix epoch seconds.
    pub resets_at: Option<u64>,
    pub used_usd: Option<f64>,
    pub limit_usd: Option<f64>,
    pub period: Option<String>,
}

/// What the helper writes to `<data>\meter\<session>.json` (and nothing more).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MeterRecord {
    pub v: u32,
    pub claude_session_id: Option<String>,
    /// `cost.total_cost_usd`: Claude Code's estimate at list price for the current conversation
    /// (resets on `/clear`).
    pub cost_usd: Option<f64>,
    pub duration_ms: Option<u64>,
    pub api_duration_ms: Option<u64>,
    pub context_size: Option<u64>,
    pub context_pct: Option<f64>,
    /// Tokens currently in the context window (not cumulative spend).
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    /// `context_window.current_usage.*` of the last API call.
    pub current_usage: BTreeMap<String, u64>,
    pub rate_limits: BTreeMap<String, RateWindow>,
    pub model: Option<String>,
    pub model_id: Option<String>,
    pub updated_ms: u64,
}

// ---------------------------------------------------------------------------
// Per-pane state
// ---------------------------------------------------------------------------

#[derive(Debug, Default)]
struct PaneMeter {
    status: MeterStatus,
    note: Option<String>,
    chained: bool,
    last: Option<MeterRecord>,
    /// Last cost seen per Claude conversation, oldest first.
    buckets: Vec<(String, f64)>,
    /// Cost folded away: conversations beyond `MAX_BUCKETS`, or a conversation whose cost went
    /// backwards (resumed with a fresh counter).
    banked: f64,
}

impl PaneMeter {
    /// Apply a record; `false` when it is the one already applied.
    fn apply(&mut self, rec: MeterRecord) -> bool {
        if self.last.as_ref().is_some_and(|l| l == &rec) {
            return false;
        }
        if let Some(cost) = rec.cost_usd {
            let sid = rec.claude_session_id.clone().unwrap_or_default();
            match self.buckets.iter_mut().find(|(s, _)| *s == sid) {
                Some((_, last)) => {
                    if cost + 1e-9 < *last {
                        self.banked += *last;
                    }
                    *last = cost;
                }
                None => {
                    self.buckets.push((sid, cost));
                    if self.buckets.len() > MAX_BUCKETS {
                        let (_, c) = self.buckets.remove(0);
                        self.banked += c;
                    }
                }
            }
        }
        self.last = Some(rec);
        true
    }

    fn pane_total(&self) -> Option<f64> {
        (!self.buckets.is_empty() || self.banked > 0.0)
            .then(|| self.banked + self.buckets.iter().map(|(_, c)| c).sum::<f64>())
    }

    fn view(&self, id: &str) -> SessionMeter {
        let r = self.last.as_ref();
        let window = |name: &str| r.and_then(|r| r.rate_limits.get(name)).and_then(|w| w.used_pct);
        SessionMeter {
            session_id: id.to_string(),
            status: self.status,
            note: self.note.clone(),
            chained: self.chained,
            claude_session_id: r.and_then(|r| r.claude_session_id.clone()),
            cost_usd: r.and_then(|r| r.cost_usd),
            pane_cost_usd: self.pane_total(),
            context_pct: r.and_then(|r| r.context_pct),
            context_size: r.and_then(|r| r.context_size),
            input_tokens: r.and_then(|r| r.input_tokens),
            output_tokens: r.and_then(|r| r.output_tokens),
            api_duration_ms: r.and_then(|r| r.api_duration_ms),
            duration_ms: r.and_then(|r| r.duration_ms),
            model: r.and_then(|r| r.model.clone().or_else(|| r.model_id.clone())),
            five_hour_pct: window("five_hour"),
            seven_day_pct: window("seven_day"),
            updated_ms: r.map(|r| r.updated_ms),
        }
    }
}

// ---------------------------------------------------------------------------
// Hub
// ---------------------------------------------------------------------------

/// Receives every changed meter.
pub type MeterEmit = Arc<dyn Fn(&SessionMeter) + Send + Sync>;
/// Receives hook states as `session-attention` events (`kind = hook`).
pub type HookSink = Arc<dyn Fn(&SessionAttention) + Send + Sync>;

pub struct MeterHub {
    dir: PathBuf,
    /// The helper executable (this binary).
    exe: Option<PathBuf>,
    /// Managed settings files checked for a status line Gridkeeper can't override.
    managed: Vec<PathBuf>,
    panes: Arc<Mutex<HashMap<SessionId, PaneMeter>>>,
    emit: MeterEmit,
    watch: Mutex<Option<MeterWatch>>,
    /// Hook state of panes launched with hooks in this app run (others' hook files are ignored).
    hooks: Mutex<HashMap<SessionId, hooks::PaneHooks>>,
    hook_sink: Mutex<Option<HookSink>>,
}

static HUB: OnceLock<Arc<MeterHub>> = OnceLock::new();

/// Make `hub` the one the Claude adapter uses (first call wins).
pub fn install(hub: Arc<MeterHub>) {
    let _ = HUB.set(hub);
}

pub fn hub() -> Option<&'static Arc<MeterHub>> {
    HUB.get()
}

impl MeterHub {
    /// Create `<data>\meter`, delete stale files and load the remaining records (no watch yet).
    pub fn new(data_dir: &Path, exe: Option<PathBuf>, managed: Vec<PathBuf>, emit: MeterEmit) -> Self {
        let dir = meter_dir(data_dir);
        if let Err(e) = std::fs::create_dir_all(&dir) {
            tracing::warn!(error = %e, "could not create the meter folder");
        }
        let hub = Self {
            dir,
            exe,
            managed,
            panes: Arc::new(Mutex::new(HashMap::new())),
            emit,
            watch: Mutex::new(None),
            hooks: Mutex::new(HashMap::new()),
            hook_sink: Mutex::new(None),
        };
        hub.cleanup_stale(SystemTime::now());
        hub.rescan(false);
        hub
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn exe(&self) -> Option<&Path> {
        self.exe.as_deref()
    }

    pub fn managed_settings(&self) -> &[PathBuf] {
        &self.managed
    }

    /// Start the folder watch (idempotent).
    pub fn start_watch(self: &Arc<Self>) -> AppResult<()> {
        let mut slot = self.watch.lock();
        if slot.is_none() {
            *slot = Some(MeterWatch::start(Arc::downgrade(self), &self.dir)?);
        }
        Ok(())
    }

    /// Stop the watch (app exit).
    pub fn stop(&self) {
        let w = self.watch.lock().take();
        drop(w);
    }

    pub fn snapshot(&self) -> Vec<SessionMeter> {
        let panes = self.panes.lock();
        let mut out: Vec<SessionMeter> = panes.iter().map(|(id, p)| p.view(id)).collect();
        out.sort_by(|a, b| a.session_id.cmp(&b.session_id));
        out
    }

    pub fn get(&self, id: &str) -> Option<SessionMeter> {
        self.panes.lock().get(id).map(|p| p.view(id))
    }

    /// Record how a Claude launch went (metered or why not) and tell the UI.
    pub fn note_launch(&self, id: &str, status: MeterStatus, note: Option<String>, chained: bool) {
        let view = {
            let mut panes = self.panes.lock();
            let p = panes.entry(id.to_string()).or_default();
            p.status = status;
            p.note = note;
            p.chained = chained;
            p.view(id)
        };
        self.emit_view(&view);
    }

    /// Where hook states go (`session-attention`). Set once at startup.
    pub fn set_hook_sink(&self, sink: HookSink) {
        *self.hook_sink.lock() = Some(sink);
    }

    /// A Claude pane is being launched with hooks: fresh hook state, and the previous run's state file
    /// is deleted before Claude can write a new one.
    pub fn hooks_launch(&self, id: &str) {
        self.remove_file(&hooks::hooks_name(id), id);
        self.hooks.lock().insert(id.to_string(), hooks::PaneHooks::default());
    }

    /// A Claude pane is being launched without hooks: hook files for it are ignored from now on.
    pub fn hooks_off(&self, id: &str) {
        self.hooks.lock().remove(id);
    }

    /// The pane has hook state in this app run.
    pub fn hooks_active(&self, id: &str) -> bool {
        self.hooks.lock().contains_key(id)
    }

    /// The user typed into a pane (`session_write`): may end a prompt's wait or interrupt a turn. Cheap
    /// when the pane has no hooks.
    pub fn note_input(&self, id: &str, data: &[u8]) {
        let update = self.hooks.lock().get_mut(id).and_then(|p| p.on_input(data));
        if let Some(u) = update {
            self.emit_hook(&u.to_attention(id));
        }
    }

    fn ingest_hook(&self, id: &str, path: &Path) -> Option<SessionAttention> {
        let rec = hooks::read_record(path)?;
        let attention = self.hooks.lock().get_mut(id)?.apply(&rec)?.to_attention(id);
        self.emit_hook(&attention);
        Some(attention)
    }

    fn emit_hook(&self, a: &SessionAttention) {
        let Some(sink) = self.hook_sink.lock().clone() else { return };
        if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| sink(a))).is_err() {
            tracing::error!("hook attention emit panicked");
        }
    }

    /// Read `path` if it is a meter record and apply it. Emits when something changed. A hook state
    /// file is handed to the pane's hook state machine instead (returns `None`).
    pub fn ingest(&self, path: &Path) -> Option<SessionMeter> {
        let name = path.file_name()?.to_str()?;
        if let Some(id) = hooks::session_of_hooks_name(name) {
            self.ingest_hook(id, path);
            return None;
        }
        let id = session_of_record_name(name)?;
        let rec = read_record(path)?;
        let view = {
            let mut panes = self.panes.lock();
            let p = panes.entry(id.to_string()).or_default();
            if !p.apply(rec) {
                return None;
            }
            p.view(id)
        };
        self.emit_view(&view);
        Some(view)
    }

    /// Re-read every record in the folder (startup, or after the watcher lost events).
    pub fn rescan(&self, emit: bool) {
        let Ok(rd) = std::fs::read_dir(&self.dir) else {
            return;
        };
        for e in rd.flatten() {
            let path = e.path();
            if emit {
                self.ingest(&path);
            } else if let (Some(id), Some(rec)) =
                (path.file_name().and_then(|n| n.to_str()).and_then(session_of_record_name), read_record(&path))
            {
                self.panes.lock().entry(id.to_string()).or_default().apply(rec);
            }
        }
    }

    /// A session was removed: forget it and delete its files.
    pub fn forget(&self, id: &str) {
        self.panes.lock().remove(id);
        self.hooks.lock().remove(id);
        for name in [record_name(id), settings_name(id), hooks::hooks_name(id)] {
            self.remove_file(&name, id);
        }
    }

    fn remove_file(&self, name: &str, id: &str) {
        if !valid_session_id(id) {
            return;
        }
        if let Err(e) = std::fs::remove_file(self.dir.join(name)) {
            if e.kind() != std::io::ErrorKind::NotFound {
                tracing::warn!(error = %e, "could not delete a meter file");
            }
        }
    }

    /// Delete meter files (records, settings, temp files) not modified within [`STALE_AFTER`].
    pub fn cleanup_stale(&self, now: SystemTime) -> usize {
        let Ok(rd) = std::fs::read_dir(&self.dir) else {
            return 0;
        };
        let mut removed = 0;
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            let ours = name.ends_with(".json") || name.ends_with(".tmp");
            let Ok(meta) = e.metadata() else { continue };
            if !ours || !meta.is_file() {
                continue;
            }
            let old = meta
                .modified()
                .ok()
                .and_then(|m| now.duration_since(m).ok())
                .is_some_and(|age| age > STALE_AFTER);
            if old && std::fs::remove_file(e.path()).is_ok() {
                removed += 1;
            }
        }
        if removed > 0 {
            tracing::info!(removed, "deleted stale meter files");
        }
        removed
    }

    fn emit_view(&self, view: &SessionMeter) {
        let emit = Arc::clone(&self.emit);
        if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| emit(view))).is_err() {
            tracing::error!("session-meter emit panicked");
        }
    }
}

impl Drop for MeterHub {
    fn drop(&mut self) {
        self.stop();
    }
}

/// `.<name>.<pid>.tmp` in the same folder, then rename over `path` (atomic replace on NTFS and POSIX).
/// No fsync: meter files are rewritten on every update and only need to be whole, not durable.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let tmp = path.with_file_name(format!(".{name}.{}.tmp", std::process::id()));
    if let Err(e) = std::fs::write(&tmp, bytes) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    let mut attempt = 0;
    loop {
        match std::fs::rename(&tmp, path) {
            Ok(()) => return Ok(()),
            // A reader (the host, an indexer) may hold the previous version for a moment.
            Err(e) if attempt < 3 && e.kind() == std::io::ErrorKind::PermissionDenied => {
                attempt += 1;
                std::thread::sleep(Duration::from_millis(5 * attempt));
            }
            Err(e) => {
                let _ = std::fs::remove_file(&tmp);
                return Err(e);
            }
        }
    }
}

/// Capped read + parse of one record. `None` for anything unexpected.
pub fn read_record(path: &Path) -> Option<MeterRecord> {
    let f = std::fs::File::open(path).ok()?;
    if !f.metadata().ok()?.is_file() {
        return None;
    }
    let mut bytes = Vec::new();
    f.take(MAX_RECORD_BYTES + 1).read_to_end(&mut bytes).ok()?;
    if bytes.len() as u64 > MAX_RECORD_BYTES {
        return None;
    }
    serde_json::from_slice(&bytes).ok()
}

// ---------------------------------------------------------------------------
// Folder watch
// ---------------------------------------------------------------------------

enum WatchMsg {
    Paths(Vec<PathBuf>),
    /// Events were lost: re-read everything.
    Rescan,
}

/// `<data>\meter` watch: the notify callback forwards paths to one worker thread, which coalesces a
/// burst (temp write + rename = several events) and ingests each record once. Dropping it stops both.
struct MeterWatch {
    watcher: Option<notify::RecommendedWatcher>,
    thread: Option<std::thread::JoinHandle<()>>,
}

const COALESCE: Duration = Duration::from_millis(25);

impl MeterWatch {
    fn start(hub: std::sync::Weak<MeterHub>, dir: &Path) -> AppResult<Self> {
        let (tx, rx) = mpsc::channel::<WatchMsg>();
        let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            let msg = match res {
                Ok(ev) if matches!(ev.kind, notify::EventKind::Access(_) | notify::EventKind::Remove(_)) => return,
                Ok(ev) => WatchMsg::Paths(ev.paths),
                Err(_) => WatchMsg::Rescan,
            };
            let _ = tx.send(msg);
        })
        .map_err(|e| AppError::Other(format!("could not watch the meter folder: {e}")))?;
        watcher
            .watch(dir, RecursiveMode::NonRecursive)
            .map_err(|e| AppError::Other(format!("could not watch the meter folder: {e}")))?;
        let thread = crate::pty::spawn_guarded("meter-watch".into(), move || watch_loop(&rx, &hub))?;
        Ok(Self { watcher: Some(watcher), thread: Some(thread) })
    }
}

fn watch_loop(rx: &mpsc::Receiver<WatchMsg>, hub: &std::sync::Weak<MeterHub>) {
    // Blocks until an event arrives; returns when the watcher (the only sender) is dropped.
    while let Ok(first) = rx.recv() {
        let mut paths: Vec<PathBuf> = Vec::new();
        let mut rescan = false;
        let mut take = |m: WatchMsg| match m {
            WatchMsg::Paths(p) => paths.extend(p),
            WatchMsg::Rescan => rescan = true,
        };
        take(first);
        while let Ok(m) = rx.recv_timeout(COALESCE) {
            take(m);
        }
        let Some(hub) = hub.upgrade() else { return };
        if rescan {
            hub.rescan(true);
            continue;
        }
        paths.sort();
        paths.dedup();
        for p in paths {
            hub.ingest(&p);
        }
    }
}

impl Drop for MeterWatch {
    fn drop(&mut self) {
        // Dropping the watcher drops the callback and with it the channel sender: the worker exits.
        drop(self.watcher.take());
        if let Some(t) = self.thread.take() {
            // The worker may itself drop the last hub reference; it then exits on its own.
            if t.thread().id() != std::thread::current().id() {
                let _ = t.join();
            }
        }
    }
}

#[cfg(test)]
mod tests;
