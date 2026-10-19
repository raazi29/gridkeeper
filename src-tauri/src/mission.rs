//! Mission file: `<projectDir>/.gridkeeper/mission.md`, a shared task board every agent can edit.
//!
//! - Reads are capped at [`MAX_MISSION_BYTES`], decoded as lossy UTF-8 with a BOM stripped.
//! - Writes are atomic (unique temp file in the same folder, then rename over) and optionally
//!   checked against the last-write time the caller saw (`AppError::Conflict`, code `"conflict"`).
//!   Creating `.gridkeeper/` also writes `.gridkeeper/.gitignore` = `*`, so the folder ignores
//!   itself and never shows up in the user's `git status`.
//! - [`MissionWatchers`]: ref-counted filesystem watches (ReadDirectoryChangesW through `notify`,
//!   no polling). Each watch observes `<dir>` (non-recursive, only to notice `.gridkeeper` appearing,
//!   disappearing or being replaced) and `<dir>/.gridkeeper` (non-recursive) while it exists.
//!   Events for the mission file are debounced (trailing [`DEBOUNCE`], at most [`MAX_DEBOUNCE_DELAY`]
//!   under a continuous stream) on one background thread per watched folder, then handed to the
//!   injected emit callback once per spelling of the folder the frontend registered.
//!
//! Lead control (the lead coordinates its teammates through files):
//! - `.gridkeeper/outbox/`: any agent creates ONE new `.md` / `.txt` file per instruction. The watch also
//!   observes this folder (non-recursive, re-armed when it appears) and emits
//!   [`MissionChangeKind::Outbox`] for files created, written or renamed INTO it. [`outbox_list`] reads
//!   them (oldest first, capped), [`outbox_archive`] moves a handled file to `outbox/sent/` or
//!   `outbox/dismissed/` (a rename, so an agent creating a new file never races with it).
//! - `.gridkeeper/team.md`: written only by Gridkeeper ([`team_write`], redacted, atomic). It never
//!   produces an event, so regenerating it cannot trigger itself.

use std::collections::HashMap;
use std::fs;
use std::io::{self, Read, Write};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, UNIX_EPOCH};

use notify::{EventKind, RecursiveMode, Watcher};
use parking_lot::{Condvar, Mutex};

use crate::types::*;

pub const DIR_NAME: &str = ".gridkeeper";
pub const FILE_NAME: &str = "mission.md";
pub const MAX_MISSION_BYTES: usize = 256 * 1024;
/// Lead control instruction folder inside `.gridkeeper/`.
pub const OUTBOX_DIR: &str = "outbox";
/// Generated team status file inside `.gridkeeper/` (agents read it, Gridkeeper writes it).
pub const TEAM_FILE: &str = "team.md";
/// At most this many outbox files are returned per listing (the oldest ones).
pub const MAX_OUTBOX_FILES: usize = 50;
/// Each outbox file is read up to this many bytes (`OutboxItem::truncated` beyond).
pub const MAX_OUTBOX_FILE_BYTES: usize = 16 * 1024;
pub const MAX_TEAM_BYTES: usize = 256 * 1024;
/// Archive subfolders of the outbox.
pub const OUTBOX_DISPOSITIONS: [&str; 2] = ["sent", "dismissed"];
/// Trailing debounce for watcher events.
pub const DEBOUNCE: Duration = Duration::from_millis(150);
/// Upper bound on the delay while events keep arriving (a continuous stream still notifies).
pub const MAX_DEBOUNCE_DELAY: Duration = Duration::from_secs(1);
const GITIGNORE: &str = "*\n";
const UTF8_BOM: &[u8] = &[0xEF, 0xBB, 0xBF];

/// Serializes check-then-write within this process (two windows / quick double saves).
static WRITE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// An existing absolute directory.
pub fn validate_project_dir(project_dir: &str) -> AppResult<PathBuf> {
    if project_dir.contains('\0') {
        return Err(AppError::Invalid("Project folder contains a NUL character".into()));
    }
    let dir = PathBuf::from(project_dir);
    if project_dir.trim().is_empty() || !dir.is_absolute() {
        return Err(AppError::Invalid(format!("Project folder must be an absolute path: {project_dir:?}")));
    }
    if !dir.is_dir() {
        return Err(AppError::Invalid(format!("Project folder does not exist: {project_dir}")));
    }
    Ok(dir)
}

pub fn mission_path(project: &Path) -> PathBuf {
    project.join(DIR_NAME).join(FILE_NAME)
}

fn modified_ms(meta: &fs::Metadata) -> Option<u64> {
    let d = meta.modified().ok()?.duration_since(UNIX_EPOCH).ok()?;
    u64::try_from(d.as_millis()).ok()
}

fn too_large(bytes: u64) -> AppError {
    AppError::Invalid(format!(
        "The mission file is larger than {} KiB ({} KiB)",
        MAX_MISSION_BYTES / 1024,
        bytes.div_ceil(1024)
    ))
}

/// Lossy UTF-8 with a leading BOM removed.
pub fn decode(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes.strip_prefix(UTF8_BOM).unwrap_or(bytes)).into_owned()
}

/// Read the mission file of `project_dir` (missing file = `exists: false`, not an error).
pub fn read(project_dir: &str) -> AppResult<MissionFile> {
    let project = validate_project_dir(project_dir)?;
    read_at(&mission_path(&project))
}

fn read_at(path: &Path) -> AppResult<MissionFile> {
    let path_s = path.to_string_lossy().into_owned();
    match fs::metadata(path) {
        Ok(m) if !m.is_file() => return Err(AppError::Invalid(format!("Not a file: {path_s}"))),
        Ok(m) if m.len() > MAX_MISSION_BYTES as u64 => return Err(too_large(m.len())),
        Ok(_) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            return Ok(MissionFile { path: path_s, exists: false, text: String::new(), modified_ms: None });
        }
        Err(e) => return Err(e.into()),
    }
    // Text and time come from the same handle: an atomic replace mid-read cannot mix two versions.
    let file = match fs::File::open(path) {
        Ok(f) => f,
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            return Ok(MissionFile { path: path_s, exists: false, text: String::new(), modified_ms: None });
        }
        Err(e) => return Err(e.into()),
    };
    let meta = file.metadata()?;
    let mut bytes = Vec::with_capacity((meta.len() as usize).min(MAX_MISSION_BYTES) + 1);
    file.take(MAX_MISSION_BYTES as u64 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > MAX_MISSION_BYTES {
        return Err(too_large(bytes.len() as u64));
    }
    Ok(MissionFile { path: path_s, exists: true, text: decode(&bytes), modified_ms: modified_ms(&meta) })
}

/// Atomically write the mission file. With `check_expected`, the file must still be the version the
/// caller read: `expected_modified_ms == None` means "must not exist yet", `Some(ms)` means "its
/// last-write time (ms precision) is still `ms`". Otherwise `AppError::Conflict`.
pub fn write(
    project_dir: &str,
    text: &str,
    expected_modified_ms: Option<u64>,
    check_expected: bool,
) -> AppResult<MissionFile> {
    let project = validate_project_dir(project_dir)?;
    if text.len() > MAX_MISSION_BYTES {
        return Err(too_large(text.len() as u64));
    }
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let dir = project.join(DIR_NAME);
    ensure_dir(&dir)?;
    let path = dir.join(FILE_NAME);
    if check_expected {
        let current = match fs::metadata(&path) {
            Ok(m) if m.is_file() => Some(modified_ms(&m)),
            Ok(_) => return Err(AppError::Invalid(format!("Not a file: {}", path.display()))),
            Err(e) if e.kind() == io::ErrorKind::NotFound => None,
            Err(e) => return Err(e.into()),
        };
        match (expected_modified_ms, current) {
            (None, None) => {}
            (Some(want), Some(Some(have))) if want == have => {}
            (None, Some(_)) => {
                return Err(AppError::Conflict("the mission file was created by someone else".into()));
            }
            (Some(_), None) => return Err(AppError::Conflict("the mission file was deleted".into())),
            (Some(_), Some(_)) => {
                return Err(AppError::Conflict("the mission file changed since it was read".into()));
            }
        }
    }
    atomic_replace(&path, text.as_bytes())?;
    read_at(&path)
}

/// Create `.gridkeeper/` (with its self-ignoring `.gitignore`) when missing.
pub(crate) fn ensure_dir(dir: &Path) -> AppResult<()> {
    match fs::create_dir(dir) {
        Ok(()) => {
            if let Err(e) = fs::write(dir.join(".gitignore"), GITIGNORE) {
                tracing::warn!(error = %e, "could not write .gridkeeper/.gitignore");
            }
            Ok(())
        }
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
            if dir.is_dir() {
                Ok(())
            } else {
                Err(AppError::Invalid(format!("{} exists but is not a folder", dir.display())))
            }
        }
        Err(e) => Err(e.into()),
    }
}

/// Write `<dir>/.<name>.<pid>.<n>.tmp`, fsync, rename over `path` (replaces atomically on NTFS).
fn atomic_replace(path: &Path, bytes: &[u8]) -> io::Result<()> {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let tmp = path.with_file_name(format!(
        ".{name}.{}.{}.tmp",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    let written = (|| {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()
    })();
    if let Err(e) = written {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    // Antivirus / indexers / editors can hold the destination briefly; retry a few times.
    let mut attempt = 0;
    loop {
        match fs::rename(&tmp, path) {
            Ok(()) => return Ok(()),
            Err(e) if attempt < 4 && e.kind() == io::ErrorKind::PermissionDenied => {
                attempt += 1;
                std::thread::sleep(Duration::from_millis(50 * attempt));
            }
            Err(e) => {
                let _ = fs::remove_file(&tmp);
                return Err(e);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Lead control: outbox + team file
// ---------------------------------------------------------------------------

pub fn outbox_path(project: &Path) -> PathBuf {
    project.join(DIR_NAME).join(OUTBOX_DIR)
}

/// An instruction file name: `.md` / `.txt`, not hidden / temporary (`.x.md`, `~x.md`).
fn is_outbox_file_name(path: &Path) -> bool {
    let Some(name) = path.file_name().map(|n| n.to_string_lossy()) else {
        return false;
    };
    if name.starts_with('.') || name.starts_with('~') {
        return false;
    }
    path.extension().is_some_and(|e| e.eq_ignore_ascii_case("md") || e.eq_ignore_ascii_case("txt"))
}

/// Regular instruction files directly in `<project>/.gridkeeper/outbox/`, oldest first (then by name),
/// at most [`MAX_OUTBOX_FILES`], each read up to [`MAX_OUTBOX_FILE_BYTES`]. Missing folder = empty.
/// Folders (`sent/`, `dismissed/`), links and files that cannot be opened right now (still being
/// written and locked) are skipped; the next change event lists them again.
pub fn outbox_list(project_dir: &str) -> AppResult<Vec<OutboxItem>> {
    let project = validate_project_dir(project_dir)?;
    let dir = outbox_path(&project);
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut found: Vec<(u64, String, PathBuf)> = Vec::new();
    for entry in fs::read_dir(&dir)? {
        let Ok(entry) = entry else { continue };
        if !entry.file_type().is_ok_and(|t| t.is_file()) {
            continue;
        }
        let path = entry.path();
        if !is_outbox_file_name(&path) {
            continue;
        }
        // Names that are not valid Unicode could not be passed back to `outbox_archive`.
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else { continue };
        let ms = entry.metadata().ok().as_ref().and_then(modified_ms).unwrap_or(0);
        found.push((ms, name, path));
    }
    found.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
    found.truncate(MAX_OUTBOX_FILES);
    let mut out = Vec::with_capacity(found.len());
    for (modified_ms, name, path) in found {
        let Ok(file) = fs::File::open(&path) else { continue };
        let mut bytes = Vec::new();
        if file.take(MAX_OUTBOX_FILE_BYTES as u64 + 1).read_to_end(&mut bytes).is_err() {
            continue;
        }
        let truncated = bytes.len() > MAX_OUTBOX_FILE_BYTES;
        bytes.truncate(MAX_OUTBOX_FILE_BYTES);
        out.push(OutboxItem { name, text: decode(&bytes), modified_ms, truncated });
    }
    Ok(out)
}

/// A bare file name: no separators, drive / stream colons, `..`, control characters.
fn validate_outbox_name(name: &str) -> AppResult<()> {
    let bad = name.trim().is_empty()
        || name.len() > 255
        || name.contains("..")
        || name.chars().any(|c| matches!(c, '/' | '\\' | ':') || c.is_control());
    if bad {
        return Err(AppError::Invalid(format!("Not an outbox file name: {name:?}")));
    }
    Ok(())
}

/// `dir/name`, or `dir/<stem>-<n><.ext>` when that is taken.
fn free_name(dir: &Path, name: &str) -> PathBuf {
    let taken = |p: &Path| fs::symlink_metadata(p).is_ok();
    let first = dir.join(name);
    if !taken(&first) {
        return first;
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    for n in 1..10_000 {
        let p = dir.join(format!("{stem}-{n}{ext}"));
        if !taken(&p) {
            return p;
        }
    }
    let ms = std::time::SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    dir.join(format!("{stem}-{ms}{ext}"))
}

/// Move a handled instruction file from `outbox/` to `outbox/sent/` or `outbox/dismissed/` (created
/// on demand; a name clash gets a `-<n>` suffix). Returns the archived path. The file must exist
/// directly in the outbox (`AppError::NotFound` otherwise, e.g. when its author deleted it).
pub fn outbox_archive(project_dir: &str, name: &str, disposition: &str) -> AppResult<String> {
    let project = validate_project_dir(project_dir)?;
    let Some(sub) = OUTBOX_DISPOSITIONS.iter().find(|d| **d == disposition) else {
        return Err(AppError::Invalid(format!("Unknown outbox disposition: {disposition:?}")));
    };
    validate_outbox_name(name)?;
    let dir = outbox_path(&project);
    let src = dir.join(name);
    match fs::symlink_metadata(&src) {
        Ok(m) if m.is_file() => {}
        Ok(_) => return Err(AppError::Invalid(format!("Not a file in the outbox: {name}"))),
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            return Err(AppError::NotFound(format!("outbox file {name}")));
        }
        Err(e) => return Err(e.into()),
    }
    let target_dir = dir.join(sub);
    fs::create_dir_all(&target_dir)?;
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let dest = free_name(&target_dir, name);
    // Its author (or an indexer) may still hold the file open for a moment.
    let mut attempt = 0;
    loop {
        match fs::rename(&src, &dest) {
            Ok(()) => return Ok(dest.to_string_lossy().into_owned()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                return Err(AppError::NotFound(format!("outbox file {name}")));
            }
            Err(_) if attempt < 4 => {
                attempt += 1;
                std::thread::sleep(Duration::from_millis(50 * attempt));
            }
            Err(e) => return Err(e.into()),
        }
    }
}

/// Atomically write `<project>/.gridkeeper/team.md` (creating the folder with its self-ignoring
/// `.gitignore`). The text is redacted first; at most [`MAX_TEAM_BYTES`]. Identical content is not
/// rewritten. The watcher never reports this file.
pub fn team_write(project_dir: &str, text: &str) -> AppResult<()> {
    let project = validate_project_dir(project_dir)?;
    let clean = crate::redact::redact(text);
    if clean.len() > MAX_TEAM_BYTES {
        return Err(AppError::Invalid(format!(
            "The team file is larger than {} KiB ({} KiB)",
            MAX_TEAM_BYTES / 1024,
            clean.len().div_ceil(1024)
        )));
    }
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let dir = project.join(DIR_NAME);
    ensure_dir(&dir)?;
    let path = dir.join(TEAM_FILE);
    if fs::read(&path).is_ok_and(|old| old == clean.as_bytes()) {
        return Ok(());
    }
    atomic_replace(&path, clean.as_bytes())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Watchers
// ---------------------------------------------------------------------------

/// Receives the project folder (as the frontend spelled it) and what changed, after a debounced change.
pub type EmitFn = Arc<dyn Fn(&str, MissionChangeKind) + Send + Sync>;

/// Registry key: one watch per folder, case-insensitive, `/` and trailing separators ignored.
#[cfg(windows)]
pub fn normalize_key(project_dir: &str) -> String {
    let s = project_dir.replace('/', "\\");
    let mut s = s.as_str();
    // Keep the root separator of `C:\` / `\\server\share\` style paths meaningful.
    while s.len() > 3 && s.ends_with('\\') {
        s = &s[..s.len() - 1];
    }
    s.to_lowercase()
}

/// Registry key on macOS / Linux: trailing `/` ignored (the root stays `/`); case kept, since the
/// frontend sends the folder as the user picked it and Linux file systems are case-sensitive.
#[cfg(not(windows))]
pub fn normalize_key(project_dir: &str) -> String {
    let trimmed = project_dir.trim_end_matches('/');
    if trimmed.is_empty() && project_dir.starts_with('/') { "/".to_string() } else { trimmed.to_string() }
}

struct WatchEntry {
    /// Ref count per spelling the frontend used for this folder.
    names: Arc<Mutex<Vec<(String, usize)>>>,
    _watch: DirWatch,
}

/// Ref-counted mission file watches, shared by all windows (lives in `AppCtx`).
pub struct MissionWatchers {
    emit: EmitFn,
    entries: Mutex<HashMap<String, WatchEntry>>,
}

impl MissionWatchers {
    pub fn new(emit: EmitFn) -> Self {
        Self { emit, entries: Mutex::new(HashMap::new()) }
    }

    pub fn watch(&self, project_dir: &str) -> AppResult<()> {
        let project = validate_project_dir(project_dir)?;
        let key = normalize_key(project_dir);
        let mut map = self.entries.lock();
        if let Some(entry) = map.get(&key) {
            let mut names = entry.names.lock();
            match names.iter_mut().find(|(n, _)| n == project_dir) {
                Some((_, count)) => *count += 1,
                None => names.push((project_dir.to_string(), 1)),
            }
            return Ok(());
        }
        let names = Arc::new(Mutex::new(vec![(project_dir.to_string(), 1)]));
        let watch = DirWatch::start(project, Arc::clone(&names), Arc::clone(&self.emit))?;
        map.insert(key, WatchEntry { names, _watch: watch });
        Ok(())
    }

    /// Drops one reference; the watch stops with the last one. Unknown folders are a no-op.
    pub fn unwatch(&self, project_dir: &str) -> AppResult<()> {
        if project_dir.contains('\0') {
            return Err(AppError::Invalid("Project folder contains a NUL character".into()));
        }
        let key = normalize_key(project_dir);
        let removed = {
            let mut map = self.entries.lock();
            let Some(entry) = map.get(&key) else {
                return Ok(());
            };
            let empty = {
                let mut names = entry.names.lock();
                // Prefer the exact spelling; otherwise any spelling of the same folder.
                let i = names.iter().position(|(n, _)| n == project_dir).unwrap_or(0);
                if let Some((_, count)) = names.get_mut(i) {
                    *count -= 1;
                    if *count == 0 {
                        names.remove(i);
                    }
                }
                names.is_empty()
            };
            if empty { map.remove(&key) } else { None }
        };
        // Joining the watcher thread happens outside the registry lock.
        drop(removed);
        Ok(())
    }

    /// Stop every watch (app exit).
    pub fn clear(&self) {
        let all: Vec<WatchEntry> = self.entries.lock().drain().map(|(_, e)| e).collect();
        drop(all);
    }

    /// Number of watched folders.
    pub fn len(&self) -> usize {
        self.entries.lock().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

impl Drop for MissionWatchers {
    fn drop(&mut self) {
        self.clear();
    }
}

#[derive(Default)]
struct Pending {
    stop: bool,
    first: Option<Instant>,
    last: Option<Instant>,
    /// What the events since the last emit were about (merged).
    fired: Relevance,
}

impl Pending {
    fn deadline(&self) -> Option<Instant> {
        Some((self.last? + DEBOUNCE).min(self.first? + MAX_DEBOUNCE_DELAY))
    }
}

#[derive(Default)]
struct Shared {
    state: Mutex<Pending>,
    cv: Condvar,
}

impl Shared {
    fn poke(&self, rel: Relevance) {
        let mut st = self.state.lock();
        let now = Instant::now();
        st.first.get_or_insert(now);
        st.last = Some(now);
        st.fired.merge(rel);
        self.cv.notify_one();
    }
}

/// What a watcher event is about. Several flags can be set (a debounced batch merges them).
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
struct Relevance {
    /// `.gridkeeper/mission.md` changed.
    mission: bool,
    /// An instruction file arrived in (or was written in) `.gridkeeper/outbox/`.
    outbox: bool,
    /// `.gridkeeper` appeared, vanished or was replaced: re-establish its watch (and the outbox's)
    /// before emitting both kinds.
    rearm: bool,
    /// `.gridkeeper/outbox` appeared, vanished or was replaced: re-establish its watch.
    rearm_outbox: bool,
}

impl Relevance {
    const IGNORE: Self = Self { mission: false, outbox: false, rearm: false, rearm_outbox: false };

    fn any(&self) -> bool {
        self.mission || self.outbox || self.rearm || self.rearm_outbox
    }

    fn merge(&mut self, o: Relevance) {
        self.mission |= o.mission;
        self.outbox |= o.outbox;
        self.rearm |= o.rearm;
        self.rearm_outbox |= o.rearm_outbox;
    }

    /// The `mission-changed` kinds to emit for this batch.
    fn kinds(&self) -> Vec<MissionChangeKind> {
        let mut out = Vec::with_capacity(2);
        if self.mission || self.rearm {
            out.push(MissionChangeKind::Mission);
        }
        if self.outbox || self.rearm || self.rearm_outbox {
            out.push(MissionChangeKind::Outbox);
        }
        out
    }
}

fn same_path(a: &Path, b: &Path) -> bool {
    a.as_os_str().to_string_lossy().eq_ignore_ascii_case(&b.as_os_str().to_string_lossy())
}

fn is_name(path: &Path, name: &str) -> bool {
    path.file_name().is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case(name))
}

/// Which watcher events matter: the mission file itself, `.gridkeeper` or `.gridkeeper/outbox` coming
/// and going (their content-driven "modified" events are ignored; the inner watches report those), and
/// instruction files arriving in the outbox (created, written, renamed in; never removals or the old
/// name of a rename, so archiving a file to `outbox/sent/` stays silent). `team.md` never matters.
fn classify(event: &notify::Event, project: &Path, gk: &Path, outbox: &Path) -> Relevance {
    use notify::event::{ModifyKind, RenameMode};
    let structural = matches!(
        event.kind,
        EventKind::Create(_) | EventKind::Remove(_) | EventKind::Modify(ModifyKind::Name(_)) | EventKind::Any | EventKind::Other
    );
    let leaving = matches!(
        event.kind,
        EventKind::Remove(_) | EventKind::Modify(ModifyKind::Name(RenameMode::From))
    );
    let rename_pair = matches!(event.kind, EventKind::Modify(ModifyKind::Name(RenameMode::Both)));
    let mut out = Relevance::IGNORE;
    for (i, path) in event.paths.iter().enumerate() {
        let parent = path.parent().unwrap_or(Path::new(""));
        if is_name(path, FILE_NAME) && same_path(parent, gk) {
            out.mission = true;
        } else if is_name(path, DIR_NAME) && same_path(parent, project) {
            out.rearm |= structural;
        } else if is_name(path, OUTBOX_DIR) && same_path(parent, gk) {
            out.rearm_outbox |= structural;
        } else if same_path(parent, outbox) && is_outbox_file_name(path) {
            // A rename pair lists [from, to]: only the destination arrives. FSEvents (macOS) reports each
            // side of a rename on its own as Name(Any), so there only a file that still exists has arrived.
            let unpaired = matches!(event.kind, EventKind::Modify(ModifyKind::Name(RenameMode::Any)));
            out.outbox |= !leaving && !(rename_pair && i == 0) && (!unpaired || path.exists());
        }
    }
    out
}

fn watch_err(e: notify::Error) -> AppError {
    AppError::Other(format!("could not watch the mission folder: {e}"))
}

/// One folder's watcher + debounce thread. Dropping it stops both.
struct DirWatch {
    shared: Arc<Shared>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl DirWatch {
    fn start(project: PathBuf, names: Arc<Mutex<Vec<(String, usize)>>>, emit: EmitFn) -> AppResult<Self> {
        // FSEvents reports resolved paths (`/var/...` arrives as `/private/var/...`), so watch and match the
        // real path. The UI still gets the spelling it passed in (`names`). Not on Windows, where
        // canonicalize adds a `\\?\` prefix that event paths don't have.
        #[cfg(target_os = "macos")]
        let project = std::fs::canonicalize(&project).unwrap_or(project);
        let shared = Arc::new(Shared::default());
        let gk = project.join(DIR_NAME);
        let outbox = gk.join(OUTBOX_DIR);
        let mut watcher = {
            let shared = Arc::clone(&shared);
            let (project, gk, outbox) = (project.clone(), gk.clone(), outbox.clone());
            notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
                let relevance = match &res {
                    Ok(ev) => classify(ev, &project, &gk, &outbox),
                    // Lost events / dead handle: re-check the folders and let the UI re-read.
                    Err(_) => Relevance { rearm: true, rearm_outbox: true, ..Relevance::IGNORE },
                };
                if relevance.any() {
                    shared.poke(relevance);
                }
            })
            .map_err(watch_err)?
        };
        watcher.watch(&project, RecursiveMode::NonRecursive).map_err(watch_err)?;
        let gk_watched = gk.is_dir() && watcher.watch(&gk, RecursiveMode::NonRecursive).is_ok();
        let outbox_watched = outbox.is_dir() && watcher.watch(&outbox, RecursiveMode::NonRecursive).is_ok();
        let thread_shared = Arc::clone(&shared);
        let thread = crate::pty::spawn_guarded("mission-watch".into(), move || {
            let mut armed = Armed { watcher, gk, outbox, gk_watched, outbox_watched };
            debounce_loop(&mut armed, &thread_shared, &names, &emit)
        })?;
        Ok(Self { shared, thread: Some(thread) })
    }
}

/// The watcher plus which inner folders it currently observes.
struct Armed {
    watcher: notify::RecommendedWatcher,
    gk: PathBuf,
    outbox: PathBuf,
    gk_watched: bool,
    outbox_watched: bool,
}

impl Armed {
    /// The old handles may be dead (folder deleted / replaced): always start over.
    fn rearm(&mut self, gk: bool, outbox: bool) {
        if gk {
            if self.gk_watched {
                let _ = self.watcher.unwatch(&self.gk);
            }
            self.gk_watched = self.gk.is_dir() && self.watcher.watch(&self.gk, RecursiveMode::NonRecursive).is_ok();
        }
        if gk || outbox {
            if self.outbox_watched {
                let _ = self.watcher.unwatch(&self.outbox);
            }
            self.outbox_watched =
                self.outbox.is_dir() && self.watcher.watch(&self.outbox, RecursiveMode::NonRecursive).is_ok();
        }
    }
}

impl Drop for DirWatch {
    fn drop(&mut self) {
        self.shared.state.lock().stop = true;
        self.shared.cv.notify_all();
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

fn debounce_loop(armed: &mut Armed, shared: &Shared, names: &Mutex<Vec<(String, usize)>>, emit: &EmitFn) {
    loop {
        let fired = {
            let mut st = shared.state.lock();
            loop {
                if st.stop {
                    return; // the caller drops the watcher (closes the directory handles)
                }
                match st.deadline() {
                    None => shared.cv.wait(&mut st),
                    Some(d) if Instant::now() >= d => break,
                    Some(d) => {
                        shared.cv.wait_until(&mut st, d);
                    }
                }
            }
            st.first = None;
            st.last = None;
            std::mem::take(&mut st.fired)
        };
        armed.rearm(fired.rearm, fired.rearm_outbox);
        let kinds = fired.kinds();
        let targets: Vec<String> = names.lock().iter().map(|(n, _)| n.clone()).collect();
        for name in targets {
            for &kind in &kinds {
                if catch_unwind(AssertUnwindSafe(|| emit(&name, kind))).is_err() {
                    tracing::error!("mission-changed emit panicked");
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    fn dir_s(p: &Path) -> String {
        p.to_string_lossy().into_owned()
    }

    fn tmp_files(dir: &Path) -> Vec<String> {
        fs::read_dir(dir)
            .map(|rd| {
                rd.filter_map(|e| e.ok())
                    .map(|e| e.file_name().to_string_lossy().into_owned())
                    .filter(|n| n.ends_with(".tmp"))
                    .collect()
            })
            .unwrap_or_default()
    }

    #[test]
    fn validates_project_dir() {
        assert!(validate_project_dir("relative\\dir").is_err());
        assert!(validate_project_dir("").is_err());
        assert!(validate_project_dir("C:\\a\0b").is_err());
        assert!(validate_project_dir(r"C:\definitely\missing\gridkeeper\dir").is_err());
        let t = tempfile::tempdir().unwrap();
        assert!(validate_project_dir(&dir_s(t.path())).is_ok());
        let f = t.path().join("file.txt");
        fs::write(&f, "x").unwrap();
        assert!(validate_project_dir(&dir_s(&f)).is_err());
    }

    #[test]
    fn read_missing_existing_bom_and_oversize() {
        let t = tempfile::tempdir().unwrap();
        let project = dir_s(t.path());
        let m = read(&project).unwrap();
        assert!(!m.exists);
        assert_eq!(m.text, "");
        assert_eq!(m.modified_ms, None);
        assert_eq!(PathBuf::from(&m.path), mission_path(t.path()));

        let gk = t.path().join(DIR_NAME);
        fs::create_dir(&gk).unwrap();
        fs::write(gk.join(FILE_NAME), "# Goal\r\n- [ ] ship\r\n").unwrap();
        let m = read(&project).unwrap();
        assert!(m.exists);
        assert_eq!(m.text, "# Goal\r\n- [ ] ship\r\n");
        assert!(m.modified_ms.is_some_and(|ms| ms > 1_600_000_000_000));

        let mut bom = UTF8_BOM.to_vec();
        bom.extend_from_slice("héllo \u{2713}".as_bytes());
        bom.push(0xFF); // invalid UTF-8 → replacement character
        fs::write(gk.join(FILE_NAME), &bom).unwrap();
        assert_eq!(read(&project).unwrap().text, "héllo \u{2713}\u{FFFD}");

        fs::write(gk.join(FILE_NAME), vec![b'a'; MAX_MISSION_BYTES]).unwrap();
        assert_eq!(read(&project).unwrap().text.len(), MAX_MISSION_BYTES);
        fs::write(gk.join(FILE_NAME), vec![b'a'; MAX_MISSION_BYTES + 1]).unwrap();
        assert!(matches!(read(&project), Err(AppError::Invalid(_))));

        fs::remove_file(gk.join(FILE_NAME)).unwrap();
        fs::create_dir(gk.join(FILE_NAME)).unwrap();
        assert!(read(&project).is_err(), "a folder named mission.md is not a mission file");
    }

    #[test]
    fn write_creates_dir_and_gitignore() {
        let t = tempfile::tempdir().unwrap();
        let project = dir_s(t.path());
        let m = write(&project, "first", None, true).unwrap();
        assert!(m.exists);
        assert_eq!(m.text, "first");
        assert!(m.modified_ms.is_some());
        let gk = t.path().join(DIR_NAME);
        assert_eq!(fs::read_to_string(gk.join(".gitignore")).unwrap(), "*\n");
        assert_eq!(fs::read_to_string(gk.join(FILE_NAME)).unwrap(), "first");
        assert!(tmp_files(&gk).is_empty(), "{:?}", tmp_files(&gk));

        // An existing folder keeps whatever .gitignore the user made of it.
        fs::write(gk.join(".gitignore"), "custom\n").unwrap();
        let m2 = write(&project, "second", m.modified_ms, true).unwrap();
        assert_eq!(m2.text, "second");
        assert_eq!(fs::read_to_string(gk.join(".gitignore")).unwrap(), "custom\n");

        // No check: always written.
        assert_eq!(write(&project, "third", None, false).unwrap().text, "third");
        assert!(tmp_files(&gk).is_empty());

        assert!(matches!(write(&project, &"x".repeat(MAX_MISSION_BYTES + 1), None, false), Err(AppError::Invalid(_))));
        assert!(write("relative", "x", None, false).is_err());
    }

    #[test]
    fn write_rejects_a_file_named_gridkeeper() {
        let t = tempfile::tempdir().unwrap();
        fs::write(t.path().join(DIR_NAME), "not a folder").unwrap();
        assert!(matches!(write(&dir_s(t.path()), "x", None, false), Err(AppError::Invalid(_))));
    }

    #[test]
    fn write_conflicts() {
        let t = tempfile::tempdir().unwrap();
        let project = dir_s(t.path());
        let m = write(&project, "v1", None, true).unwrap();
        let ms = m.modified_ms.unwrap();

        // Expected "missing", but it exists.
        let e = write(&project, "v2", None, true).unwrap_err();
        assert_eq!(e.code(), "conflict", "{e}");
        // mtime differs.
        let e = write(&project, "v2", Some(ms.wrapping_sub(5000)), true).unwrap_err();
        assert_eq!(e.code(), "conflict");
        assert_eq!(read(&project).unwrap().text, "v1", "a conflict never writes");
        // Matches.
        let m2 = write(&project, "v2", Some(ms), true).unwrap();
        assert_eq!(m2.text, "v2");
        // Deleted since read.
        fs::remove_file(mission_path(t.path())).unwrap();
        let e = write(&project, "v3", m2.modified_ms, true).unwrap_err();
        assert_eq!(e.code(), "conflict");
        // Serialized for the frontend as { code: "conflict", message }.
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["code"], "conflict");
    }

    #[test]
    fn atomic_write_leaves_no_temp_files() {
        let t = tempfile::tempdir().unwrap();
        let project = dir_s(t.path());
        for i in 0..20 {
            write(&project, &format!("rev {i}\n"), None, false).unwrap();
        }
        let gk = t.path().join(DIR_NAME);
        assert!(tmp_files(&gk).is_empty());
        let mut names: Vec<String> =
            fs::read_dir(&gk).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        assert_eq!(names, vec![".gitignore".to_string(), FILE_NAME.to_string()]);
        assert_eq!(read(&project).unwrap().text, "rev 19\n");
    }

    #[cfg(not(windows))]
    #[test]
    fn normalizes_keys_unix() {
        assert_eq!(normalize_key("/home/u/repo/"), normalize_key("/home/u/repo"));
        assert_eq!(normalize_key("/home/u/repo//"), "/home/u/repo");
        assert_eq!(normalize_key("/"), "/");
        assert_ne!(normalize_key("/home/u/repo"), normalize_key("/home/u/repo2"));
        assert_ne!(normalize_key("/home/u/Repo"), normalize_key("/home/u/repo"), "case-sensitive");
    }

    #[cfg(windows)]
    #[test]
    fn normalizes_keys() {
        assert_eq!(normalize_key(r"D:\Repo\"), normalize_key("d:/repo"));
        assert_eq!(normalize_key(r"D:\Repo\\"), r"d:\repo");
        assert_eq!(normalize_key(r"C:\"), r"c:\");
        assert_ne!(normalize_key(r"D:\repo"), normalize_key(r"D:\repo2"));
    }

    const IGNORE: Relevance = Relevance::IGNORE;
    const MISSION: Relevance = Relevance { mission: true, ..Relevance::IGNORE };
    const OUTBOX: Relevance = Relevance { outbox: true, ..Relevance::IGNORE };
    const REARM: Relevance = Relevance { rearm: true, ..Relevance::IGNORE };
    const REARM_OUTBOX: Relevance = Relevance { rearm_outbox: true, ..Relevance::IGNORE };

    #[test]
    fn classifies_events() {
        use notify::event::{CreateKind, ModifyKind, RemoveKind, RenameMode};
        let project = Path::new(r"D:\proj");
        let gk = project.join(DIR_NAME);
        let ob = gk.join(OUTBOX_DIR);
        let classify = |e: &notify::Event| classify(e, project, &gk, &ob);
        let ev = |kind, p: PathBuf| notify::Event::new(kind).add_path(p);
        let modify = EventKind::Modify(ModifyKind::Any);
        assert_eq!(classify(&ev(modify, gk.join(FILE_NAME))), MISSION);
        assert_eq!(classify(&ev(modify, gk.join("MISSION.MD"))), MISSION);
        assert_eq!(classify(&ev(modify, gk.join(".mission.md.1.0.tmp"))), IGNORE);
        assert_eq!(classify(&ev(modify, gk.join(".gitignore"))), IGNORE);
        assert_eq!(classify(&ev(modify, project.join("package.json"))), IGNORE);
        assert_eq!(classify(&ev(modify, project.join(FILE_NAME))), IGNORE);
        // The folder's own last-write time changes on every save: not structural.
        assert_eq!(classify(&ev(modify, gk.clone())), IGNORE);
        assert_eq!(classify(&ev(EventKind::Create(CreateKind::Any), gk.clone())), REARM);
        assert_eq!(classify(&ev(EventKind::Remove(RemoveKind::Any), gk.clone())), REARM);
        assert_eq!(classify(&ev(EventKind::Modify(ModifyKind::Name(RenameMode::To)), gk.clone())), REARM);
    }

    #[test]
    fn classifies_outbox_and_team_events() {
        use notify::event::{CreateKind, ModifyKind, RemoveKind, RenameMode};
        let project = Path::new(r"D:\proj");
        let gk = project.join(DIR_NAME);
        let ob = gk.join(OUTBOX_DIR);
        let classify = |e: &notify::Event| classify(e, project, &gk, &ob);
        let ev = |kind, p: PathBuf| notify::Event::new(kind).add_path(p);
        let create = EventKind::Create(CreateKind::File);
        let modify = EventKind::Modify(ModifyKind::Any);
        // team.md (and its temp file) is written by Gridkeeper itself: never an event.
        for kind in [create, modify, EventKind::Modify(ModifyKind::Name(RenameMode::To))] {
            assert_eq!(classify(&ev(kind, gk.join(TEAM_FILE))), IGNORE);
            assert_eq!(classify(&ev(kind, gk.join(".team.md.7.0.tmp"))), IGNORE);
        }
        // Instruction files arriving in the outbox.
        assert_eq!(classify(&ev(create, ob.join("0007-builder-1.md"))), OUTBOX);
        assert_eq!(classify(&ev(create, ob.join("note.TXT"))), OUTBOX);
        assert_eq!(classify(&ev(modify, ob.join("0007-builder-1.md"))), OUTBOX, "written after creation");
        assert_eq!(classify(&ev(EventKind::Modify(ModifyKind::Name(RenameMode::To)), ob.join("a.md"))), OUTBOX);
        let pair = notify::Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::Both)))
            .add_path(ob.join("a.tmp"))
            .add_path(ob.join("a.md"));
        assert_eq!(classify(&pair), OUTBOX, "renamed into an instruction name");
        let away = notify::Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::Both)))
            .add_path(ob.join("a.md"))
            .add_path(ob.join("a.bak"));
        assert_eq!(classify(&away), IGNORE, "renamed away from an instruction name");
        // Leaving the outbox (archived to sent/ or deleted) is silent; so are other names.
        assert_eq!(classify(&ev(EventKind::Remove(RemoveKind::Any), ob.join("a.md"))), IGNORE);
        assert_eq!(classify(&ev(EventKind::Modify(ModifyKind::Name(RenameMode::From)), ob.join("a.md"))), IGNORE);
        // Unpaired rename (FSEvents): a file that is no longer there has left.
        assert_eq!(classify(&ev(EventKind::Modify(ModifyKind::Name(RenameMode::Any)), ob.join("a.md"))), IGNORE);
        assert_eq!(classify(&ev(create, ob.join(".a.md"))), IGNORE);
        assert_eq!(classify(&ev(create, ob.join("~a.md"))), IGNORE);
        assert_eq!(classify(&ev(create, ob.join("a.json"))), IGNORE);
        assert_eq!(classify(&ev(create, ob.join("sent"))), IGNORE);
        assert_eq!(classify(&ev(modify, ob.join("sent"))), IGNORE);
        assert_eq!(classify(&ev(create, ob.join("sent").join("a.md"))), IGNORE);
        assert_eq!(classify(&ev(create, gk.join("a.md"))), IGNORE, "not in the outbox");
        // The outbox folder itself coming and going.
        assert_eq!(classify(&ev(EventKind::Create(CreateKind::Folder), ob.clone())), REARM_OUTBOX);
        assert_eq!(classify(&ev(EventKind::Remove(RemoveKind::Any), ob.clone())), REARM_OUTBOX);
        assert_eq!(classify(&ev(modify, ob.clone())), IGNORE);
        assert_eq!(classify(&ev(EventKind::Create(CreateKind::Folder), project.join(OUTBOX_DIR))), IGNORE);
    }

    #[test]
    fn relevance_kinds() {
        assert_eq!(MISSION.kinds(), vec![MissionChangeKind::Mission]);
        assert_eq!(OUTBOX.kinds(), vec![MissionChangeKind::Outbox]);
        assert_eq!(REARM_OUTBOX.kinds(), vec![MissionChangeKind::Outbox]);
        assert_eq!(REARM.kinds(), vec![MissionChangeKind::Mission, MissionChangeKind::Outbox]);
        assert!(IGNORE.kinds().is_empty());
        let mut m = MISSION;
        m.merge(OUTBOX);
        assert_eq!(m.kinds(), vec![MissionChangeKind::Mission, MissionChangeKind::Outbox]);
        let v = serde_json::to_value(MissionChanged { project_dir: "D:\\p".into(), file: MissionChangeKind::Outbox }).unwrap();
        assert_eq!(v, serde_json::json!({ "projectDir": "D:\\p", "file": "outbox" }));
    }

    fn recv_within<T>(rx: &mpsc::Receiver<T>, ms: u64) -> Option<T> {
        rx.recv_timeout(Duration::from_millis(ms)).ok()
    }

    fn drain<T>(rx: &mpsc::Receiver<T>, ms: u64) -> usize {
        let mut n = 0;
        while rx.recv_timeout(Duration::from_millis(ms)).is_ok() {
            n += 1;
        }
        n
    }

    /// Watchers whose emits of `only` (all kinds when `None`) arrive on the returned channel.
    fn channel_watchers(only: Option<MissionChangeKind>) -> (MissionWatchers, mpsc::Receiver<(String, MissionChangeKind)>) {
        let (tx, rx) = mpsc::channel();
        let tx = std::sync::Mutex::new(tx);
        let watchers = MissionWatchers::new(Arc::new(move |dir: &str, kind: MissionChangeKind| {
            if only.is_none_or(|k| k == kind) {
                let _ = tx.lock().unwrap().send((dir.to_string(), kind));
            }
        }));
        (watchers, rx)
    }

    /// Mission-file watchers reporting only the folder name (the shape the original tests use).
    fn mission_watchers() -> (MissionWatchers, mpsc::Receiver<String>) {
        let (watchers, rx) = channel_watchers(Some(MissionChangeKind::Mission));
        let (tx, names) = mpsc::channel();
        std::thread::spawn(move || {
            while let Ok((dir, _)) = rx.recv() {
                if tx.send(dir).is_err() {
                    break;
                }
            }
        });
        (watchers, names)
    }

    #[test]
    fn unpaired_rename_into_the_outbox_arrives() {
        use notify::event::{ModifyKind, RenameMode};
        let t = tempfile::tempdir().unwrap();
        let gk = t.path().join(DIR_NAME);
        let ob = gk.join(OUTBOX_DIR);
        fs::create_dir_all(&ob).unwrap();
        fs::write(ob.join("0003-lead.md"), "to: lead\n---\nhi").unwrap();
        let ev = notify::Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::Any))).add_path(ob.join("0003-lead.md"));
        assert_eq!(classify(&ev, t.path(), &gk, &ob), OUTBOX);
    }

    #[test]
    fn watcher_emits_debounced_changes() {
        let t = tempfile::tempdir().unwrap();
        let project = dir_s(t.path());
        let (watchers, rx) = mission_watchers();

        // .gridkeeper does not exist yet: the folder watch must notice it and re-arm.
        watchers.watch(&project).unwrap();
        assert_eq!(watchers.len(), 1);
        write(&project, "one", None, false).unwrap();
        assert_eq!(recv_within(&rx, 3000).as_deref(), Some(project.as_str()));
        drain(&rx, 400);

        // Now inside the re-armed .gridkeeper watch.
        write(&project, "two", None, false).unwrap();
        assert_eq!(recv_within(&rx, 3000).as_deref(), Some(project.as_str()));
        drain(&rx, 400);

        // A burst collapses into far fewer notifications.
        for i in 0..5 {
            write(&project, &format!("burst {i}"), None, false).unwrap();
        }
        let n = drain(&rx, 600);
        assert!((1..5).contains(&n), "burst produced {n} events");

        // Unrelated files are ignored.
        fs::write(t.path().join(DIR_NAME).join("notes.txt"), "x").unwrap();
        fs::write(t.path().join("other.txt"), "x").unwrap();
        assert_eq!(drain(&rx, 500), 0);

        // Ref counting: a second spelling of the same folder shares the watch and is notified too.
        // Windows: another case plus a trailing separator; Unix: a trailing separator.
        let other_spelling = if cfg!(windows) { format!("{}\\", project.to_uppercase()) } else { format!("{project}/") };
        watchers.watch(&other_spelling).unwrap();
        assert_eq!(watchers.len(), 1);
        write(&project, "three", None, false).unwrap();
        let mut got = vec![recv_within(&rx, 3000).unwrap(), recv_within(&rx, 1000).unwrap()];
        got.sort();
        let mut want = vec![project.clone(), other_spelling.clone()];
        want.sort();
        assert_eq!(got, want);
        drain(&rx, 400);

        watchers.unwatch(&other_spelling).unwrap();
        assert_eq!(watchers.len(), 1);
        watchers.unwatch(&project).unwrap();
        assert!(watchers.is_empty());
        watchers.unwatch(&project).unwrap(); // extra unwatch is a no-op
        write(&project, "four", None, false).unwrap();
        assert_eq!(drain(&rx, 500), 0, "no events after the last unwatch");
    }

    #[test]
    fn watcher_survives_folder_replacement() {
        let t = tempfile::tempdir().unwrap();
        let project = dir_s(t.path());
        write(&project, "one", None, false).unwrap();
        let (watchers, rx) = mission_watchers();
        watchers.watch(&project).unwrap();

        fs::remove_dir_all(t.path().join(DIR_NAME)).unwrap();
        assert!(recv_within(&rx, 3000).is_some(), "deleting the folder notifies");
        drain(&rx, 400);
        write(&project, "again", None, false).unwrap();
        assert!(recv_within(&rx, 3000).is_some(), "re-created folder is watched again");
        drain(&rx, 400);
        write(&project, "and again", None, false).unwrap();
        assert!(recv_within(&rx, 3000).is_some());
        watchers.clear();
        assert!(watchers.is_empty());
    }

    #[test]
    fn watcher_reports_outbox_files_but_not_team_or_archives() {
        use MissionChangeKind::{Mission, Outbox};
        let t = tempfile::tempdir().unwrap();
        let project = dir_s(t.path());
        write(&project, "mission", None, false).unwrap();
        let (watchers, rx) = channel_watchers(None);
        watchers.watch(&project).unwrap();
        // FSEvents (macOS) can still deliver the mission.md write made just before the watch started.
        drain(&rx, 600);
        let gk = t.path().join(DIR_NAME);
        let ob = gk.join(OUTBOX_DIR);

        // The outbox does not exist yet: creating it re-arms its watch and notifies.
        fs::create_dir(&ob).unwrap();
        assert_eq!(recv_within(&rx, 3000), Some((project.clone(), Outbox)));
        drain(&rx, 400);

        // A new instruction file in the (now watched) outbox.
        fs::write(ob.join("0001-builder-1.md"), "to: builder-1\n---\nhi").unwrap();
        assert_eq!(recv_within(&rx, 3000), Some((project.clone(), Outbox)));
        assert_eq!(drain(&rx, 400), 0, "one debounced event, no mission event");

        // Written elsewhere, then renamed into the outbox (how careful agents write files).
        fs::write(gk.join("draft.tmp"), "to: all\n---\nstop and commit").unwrap();
        drain(&rx, 400);
        fs::rename(gk.join("draft.tmp"), ob.join("0002-all.md")).unwrap();
        assert_eq!(recv_within(&rx, 3000), Some((project.clone(), Outbox)));
        drain(&rx, 400);

        // team.md never notifies (no self-trigger loop), nor do other files in the outbox.
        team_write(&project, "# Team\n").unwrap();
        team_write(&project, "# Team v2\n").unwrap();
        fs::write(ob.join("notes.json"), "{}").unwrap();
        assert_eq!(drain(&rx, 600), 0, "team.md / non-instruction files are silent");

        // Archiving a handled file (rename into outbox/sent/) is silent too.
        outbox_archive(&project, "0001-builder-1.md", "sent").unwrap();
        outbox_archive(&project, "0002-all.md", "dismissed").unwrap();
        assert_eq!(drain(&rx, 600), 0, "archiving is silent");

        // The mission file still reports as "mission" only.
        write(&project, "mission 2", None, false).unwrap();
        assert_eq!(recv_within(&rx, 3000), Some((project.clone(), Mission)));
        assert_eq!(drain(&rx, 400), 0);

        // The outbox deleted and re-created: still watched. (Deleting a watched folder may also surface
        // as a watcher error, which re-arms everything and reports both kinds.)
        fs::remove_dir_all(&ob).unwrap();
        let mut kinds = vec![recv_within(&rx, 3000).expect("deleting the outbox notifies").1];
        while let Some((_, k)) = recv_within(&rx, 600) {
            kinds.push(k);
        }
        assert!(kinds.contains(&Outbox), "{kinds:?}");
        fs::create_dir(&ob).unwrap();
        drain(&rx, 600);
        fs::write(ob.join("0003-lead.txt"), "to: lead\n---\ndone").unwrap();
        assert_eq!(recv_within(&rx, 3000), Some((project.clone(), Outbox)));
        watchers.clear();
    }

    #[test]
    fn watcher_rearm_of_gridkeeper_reports_both_kinds() {
        let t = tempfile::tempdir().unwrap();
        let project = dir_s(t.path());
        let (watchers, rx) = channel_watchers(None);
        watchers.watch(&project).unwrap();
        // `.gridkeeper/outbox/x.md` created in one go before any inner watch exists.
        let ob = outbox_path(t.path());
        fs::create_dir_all(&ob).unwrap();
        fs::write(ob.join("x.md"), "to: all\n---\nhi").unwrap();
        let mut got = vec![recv_within(&rx, 3000).unwrap().1];
        while let Some((_, k)) = recv_within(&rx, 600) {
            got.push(k);
        }
        assert!(got.contains(&MissionChangeKind::Mission) && got.contains(&MissionChangeKind::Outbox), "{got:?}");
        // The re-armed outbox watch reports new files.
        fs::write(ob.join("y.md"), "to: all\n---\nhi").unwrap();
        assert_eq!(recv_within(&rx, 3000).map(|e| e.1), Some(MissionChangeKind::Outbox));
        watchers.clear();
    }

    // ---- outbox / team file ----

    fn set_mtime(path: &Path, secs_ago: u64) {
        let f = fs::File::options().write(true).open(path).unwrap();
        f.set_modified(std::time::SystemTime::now() - Duration::from_secs(secs_ago)).unwrap();
    }

    #[test]
    fn outbox_list_reads_instruction_files_oldest_first() {
        let t = tempfile::tempdir().unwrap();
        let project = dir_s(t.path());
        assert!(outbox_list(&project).unwrap().is_empty(), "no .gridkeeper yet");
        let ob = outbox_path(t.path());
        fs::create_dir_all(ob.join("sent")).unwrap();
        assert!(outbox_list(&project).unwrap().is_empty(), "empty outbox");

        fs::write(ob.join("b.md"), "to: builder-1\n---\nsecond").unwrap();
        fs::write(ob.join("a.txt"), "to: lead\n---\nfirst").unwrap();
        let mut bom = UTF8_BOM.to_vec();
        bom.extend_from_slice("to: all\n---\nthird ✓".as_bytes());
        fs::write(ob.join("C.MD"), &bom).unwrap();
        set_mtime(&ob.join("a.txt"), 30);
        set_mtime(&ob.join("b.md"), 20);
        set_mtime(&ob.join("C.MD"), 10);
        // Skipped: hidden / temp names, other extensions, folders, archived files.
        fs::write(ob.join(".hidden.md"), "x").unwrap();
        fs::write(ob.join("~lock.md"), "x").unwrap();
        fs::write(ob.join("data.json"), "x").unwrap();
        fs::write(ob.join(".b.md.12.0.tmp"), "x").unwrap();
        fs::create_dir(ob.join("folder.md")).unwrap();
        fs::write(ob.join("sent").join("old.md"), "x").unwrap();

        let items = outbox_list(&project).unwrap();
        let names: Vec<&str> = items.iter().map(|i| i.name.as_str()).collect();
        assert_eq!(names, vec!["a.txt", "b.md", "C.MD"]);
        assert_eq!(items[0].text, "to: lead\n---\nfirst");
        assert_eq!(items[2].text, "to: all\n---\nthird ✓", "BOM stripped");
        assert!(items.iter().all(|i| !i.truncated && i.modified_ms > 1_600_000_000_000));
        assert!(items[0].modified_ms < items[1].modified_ms && items[1].modified_ms < items[2].modified_ms);
        assert!(outbox_list("relative").is_err());
    }

    #[test]
    fn outbox_list_caps_count_and_size() {
        let t = tempfile::tempdir().unwrap();
        let project = dir_s(t.path());
        let ob = outbox_path(t.path());
        fs::create_dir_all(&ob).unwrap();
        for i in 0..(MAX_OUTBOX_FILES + 5) {
            let p = ob.join(format!("{i:03}.md"));
            fs::write(&p, format!("to: all\n---\n{i}")).unwrap();
            set_mtime(&p, 1000 - i as u64);
        }
        fs::write(ob.join("big.md"), vec![b'x'; MAX_OUTBOX_FILE_BYTES + 10]).unwrap();
        set_mtime(&ob.join("big.md"), 5000); // the oldest
        let items = outbox_list(&project).unwrap();
        assert_eq!(items.len(), MAX_OUTBOX_FILES);
        assert_eq!(items[0].name, "big.md");
        assert!(items[0].truncated);
        assert_eq!(items[0].text.len(), MAX_OUTBOX_FILE_BYTES);
        assert_eq!(items[1].name, "000.md");
        assert!(!items[1].truncated);
        assert_eq!(items.last().unwrap().name, format!("{:03}.md", MAX_OUTBOX_FILES - 2));

        // Exactly at the cap is not truncated.
        fs::write(ob.join("big.md"), vec![b'y'; MAX_OUTBOX_FILE_BYTES]).unwrap();
        set_mtime(&ob.join("big.md"), 5000);
        let items = outbox_list(&project).unwrap();
        assert!(!items[0].truncated);
        assert_eq!(items[0].text.len(), MAX_OUTBOX_FILE_BYTES);
    }

    #[test]
    fn outbox_archive_moves_files_with_validation() {
        let t = tempfile::tempdir().unwrap();
        let project = dir_s(t.path());
        let ob = outbox_path(t.path());
        fs::create_dir_all(&ob).unwrap();
        fs::write(ob.join("0001-a.md"), "one").unwrap();

        let dest = outbox_archive(&project, "0001-a.md", "sent").unwrap();
        assert_eq!(PathBuf::from(&dest), ob.join("sent").join("0001-a.md"));
        assert!(!ob.join("0001-a.md").exists());
        assert_eq!(fs::read_to_string(ob.join("sent").join("0001-a.md")).unwrap(), "one");

        // Same name again: a counter is appended, nothing is overwritten.
        fs::write(ob.join("0001-a.md"), "two").unwrap();
        let dest = outbox_archive(&project, "0001-a.md", "sent").unwrap();
        assert_eq!(PathBuf::from(&dest), ob.join("sent").join("0001-a-1.md"));
        fs::write(ob.join("0001-a.md"), "three").unwrap();
        outbox_archive(&project, "0001-a.md", "sent").unwrap();
        assert_eq!(fs::read_to_string(ob.join("sent").join("0001-a.md")).unwrap(), "one");
        assert_eq!(fs::read_to_string(ob.join("sent").join("0001-a-1.md")).unwrap(), "two");
        assert_eq!(fs::read_to_string(ob.join("sent").join("0001-a-2.md")).unwrap(), "three");

        fs::write(ob.join("noext"), "x").unwrap();
        outbox_archive(&project, "noext", "dismissed").unwrap();
        fs::write(ob.join("noext"), "y").unwrap();
        let d = outbox_archive(&project, "noext", "dismissed").unwrap();
        assert_eq!(PathBuf::from(&d), ob.join("dismissed").join("noext-1"));

        // Missing file: not_found (its author deleted it).
        let e = outbox_archive(&project, "gone.md", "sent").unwrap_err();
        assert_eq!(e.code(), "not_found");
        // Bad dispositions and names never touch the file system outside the outbox.
        fs::write(ob.join("keep.md"), "k").unwrap();
        assert_eq!(outbox_archive(&project, "keep.md", "deleted").unwrap_err().code(), "invalid");
        fs::write(t.path().join(DIR_NAME).join(FILE_NAME), "m").unwrap();
        for bad in ["", " ", "..", "../mission.md", "..\\mission.md", "sub/x.md", "sub\\x.md", "C:x.md", "a.md:stream", "a\0b.md", "a\nb.md"] {
            let e = outbox_archive(&project, bad, "sent").unwrap_err();
            assert_eq!(e.code(), "invalid", "{bad:?}");
        }
        assert!(t.path().join(DIR_NAME).join(FILE_NAME).exists());
        // Folders are not files.
        assert_eq!(outbox_archive(&project, "sent", "dismissed").unwrap_err().code(), "invalid");
        assert!(ob.join("keep.md").exists());
        assert!(outbox_archive("relative", "keep.md", "sent").is_err());
    }

    #[test]
    fn team_write_is_atomic_redacted_and_capped() {
        let t = tempfile::tempdir().unwrap();
        let project = dir_s(t.path());
        team_write(&project, "# Team\n@builder-1 — working\nANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnop\n").unwrap();
        let gk = t.path().join(DIR_NAME);
        assert_eq!(fs::read_to_string(gk.join(".gitignore")).unwrap(), "*\n", "self-ignoring folder");
        let text = fs::read_to_string(gk.join(TEAM_FILE)).unwrap();
        assert!(text.starts_with("# Team\n@builder-1 — working\n"), "{text}");
        assert!(!text.contains("abcdefghijklmnop"), "redacted: {text}");
        assert!(tmp_files(&gk).is_empty());

        // Identical content: not rewritten (mtime unchanged).
        let p = gk.join(TEAM_FILE);
        set_mtime(&p, 100);
        let before = fs::metadata(&p).unwrap().modified().unwrap();
        team_write(&project, &text).unwrap();
        assert_eq!(fs::metadata(&p).unwrap().modified().unwrap(), before);
        team_write(&project, "v2").unwrap();
        assert_eq!(fs::read_to_string(&p).unwrap(), "v2");

        assert_eq!(team_write(&project, &"x".repeat(MAX_TEAM_BYTES + 1)).unwrap_err().code(), "invalid");
        assert_eq!(fs::read_to_string(&p).unwrap(), "v2", "oversize never writes");
        team_write(&project, &"x".repeat(MAX_TEAM_BYTES)).unwrap();
        assert!(team_write("relative", "x").is_err());
        // The mission file is untouched by team writes.
        assert!(!mission_path(t.path()).exists());
    }

    #[test]
    fn watch_requires_an_existing_folder() {
        let watchers = MissionWatchers::new(Arc::new(|_: &str, _: MissionChangeKind| {}));
        assert!(watchers.watch("relative").is_err());
        assert!(watchers.watch(r"C:\definitely\missing\gridkeeper\dir").is_err());
        assert!(watchers.is_empty());
        assert!(watchers.unwatch(r"C:\never\watched").is_ok());
    }
}
