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
fn ensure_dir(dir: &Path) -> AppResult<()> {
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
// Watchers
// ---------------------------------------------------------------------------

/// Receives the project folder (as the frontend spelled it) after a debounced change.
pub type EmitFn = Arc<dyn Fn(&str) + Send + Sync>;

/// Registry key: one watch per folder, case-insensitive, `/` and trailing separators ignored.
pub fn normalize_key(project_dir: &str) -> String {
    let s = project_dir.replace('/', "\\");
    let mut s = s.as_str();
    // Keep the root separator of `C:\` / `\\server\share\` style paths meaningful.
    while s.len() > 3 && s.ends_with('\\') {
        s = &s[..s.len() - 1];
    }
    s.to_lowercase()
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
    /// `.gridkeeper` appeared, vanished or was replaced: re-establish its watch before emitting.
    rearm: bool,
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
    fn poke(&self, rearm: bool) {
        let mut st = self.state.lock();
        let now = Instant::now();
        st.first.get_or_insert(now);
        st.last = Some(now);
        st.rearm |= rearm;
        self.cv.notify_one();
    }
}

#[derive(Debug, PartialEq, Eq)]
enum Relevance {
    Ignore,
    Mission,
    Rearm,
}

fn same_path(a: &Path, b: &Path) -> bool {
    a.as_os_str().to_string_lossy().eq_ignore_ascii_case(&b.as_os_str().to_string_lossy())
}

fn is_name(path: &Path, name: &str) -> bool {
    path.file_name().is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case(name))
}

/// Which watcher events matter: the mission file itself, or `.gridkeeper` coming and going
/// (its content-driven "modified" events are ignored; the inner watch reports those).
fn classify(event: &notify::Event, project: &Path, gk: &Path) -> Relevance {
    let mut out = Relevance::Ignore;
    for path in &event.paths {
        let parent = path.parent().unwrap_or(Path::new(""));
        if is_name(path, FILE_NAME) && same_path(parent, gk) {
            out = Relevance::Mission;
        } else if is_name(path, DIR_NAME) && same_path(parent, project) {
            let structural = matches!(
                event.kind,
                EventKind::Create(_)
                    | EventKind::Remove(_)
                    | EventKind::Modify(notify::event::ModifyKind::Name(_))
                    | EventKind::Any
                    | EventKind::Other
            );
            if structural {
                return Relevance::Rearm;
            }
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
        let shared = Arc::new(Shared::default());
        let gk = project.join(DIR_NAME);
        let mut watcher = {
            let shared = Arc::clone(&shared);
            let (project, gk) = (project.clone(), gk.clone());
            notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
                let relevance = match &res {
                    Ok(ev) => classify(ev, &project, &gk),
                    // Lost events / dead handle: re-check the folder and let the UI re-read.
                    Err(_) => Relevance::Rearm,
                };
                if relevance != Relevance::Ignore {
                    shared.poke(relevance == Relevance::Rearm);
                }
            })
            .map_err(watch_err)?
        };
        watcher.watch(&project, RecursiveMode::NonRecursive).map_err(watch_err)?;
        let gk_watched = gk.is_dir() && watcher.watch(&gk, RecursiveMode::NonRecursive).is_ok();
        let thread_shared = Arc::clone(&shared);
        let thread = crate::pty::spawn_guarded("mission-watch".into(), move || {
            debounce_loop(watcher, gk, gk_watched, &thread_shared, &names, &emit)
        })?;
        Ok(Self { shared, thread: Some(thread) })
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

fn debounce_loop(
    mut watcher: notify::RecommendedWatcher,
    gk: PathBuf,
    mut gk_watched: bool,
    shared: &Shared,
    names: &Mutex<Vec<(String, usize)>>,
    emit: &EmitFn,
) {
    loop {
        let rearm = {
            let mut st = shared.state.lock();
            loop {
                if st.stop {
                    return; // drops the watcher (closes the directory handles)
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
            std::mem::take(&mut st.rearm)
        };
        if rearm {
            // The old handle may be dead (folder deleted / replaced): always start over.
            if gk_watched {
                let _ = watcher.unwatch(&gk);
            }
            gk_watched = gk.is_dir() && watcher.watch(&gk, RecursiveMode::NonRecursive).is_ok();
        }
        let targets: Vec<String> = names.lock().iter().map(|(n, _)| n.clone()).collect();
        for name in targets {
            if catch_unwind(AssertUnwindSafe(|| emit(&name))).is_err() {
                tracing::error!("mission-changed emit panicked");
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

    #[test]
    fn normalizes_keys() {
        assert_eq!(normalize_key(r"D:\Repo\"), normalize_key("d:/repo"));
        assert_eq!(normalize_key(r"D:\Repo\\"), r"d:\repo");
        assert_eq!(normalize_key(r"C:\"), r"c:\");
        assert_ne!(normalize_key(r"D:\repo"), normalize_key(r"D:\repo2"));
    }

    #[test]
    fn classifies_events() {
        use notify::event::{CreateKind, ModifyKind, RemoveKind, RenameMode};
        let project = Path::new(r"D:\proj");
        let gk = project.join(DIR_NAME);
        let ev = |kind, p: PathBuf| notify::Event::new(kind).add_path(p);
        let modify = EventKind::Modify(ModifyKind::Any);
        assert_eq!(classify(&ev(modify, gk.join(FILE_NAME)), project, &gk), Relevance::Mission);
        assert_eq!(classify(&ev(modify, gk.join("MISSION.MD")), project, &gk), Relevance::Mission);
        assert_eq!(classify(&ev(modify, gk.join(".mission.md.1.0.tmp")), project, &gk), Relevance::Ignore);
        assert_eq!(classify(&ev(modify, gk.join(".gitignore")), project, &gk), Relevance::Ignore);
        assert_eq!(classify(&ev(modify, project.join("package.json")), project, &gk), Relevance::Ignore);
        assert_eq!(classify(&ev(modify, project.join(FILE_NAME)), project, &gk), Relevance::Ignore);
        // The folder's own last-write time changes on every save: not structural.
        assert_eq!(classify(&ev(modify, gk.clone()), project, &gk), Relevance::Ignore);
        assert_eq!(classify(&ev(EventKind::Create(CreateKind::Any), gk.clone()), project, &gk), Relevance::Rearm);
        assert_eq!(classify(&ev(EventKind::Remove(RemoveKind::Any), gk.clone()), project, &gk), Relevance::Rearm);
        assert_eq!(
            classify(&ev(EventKind::Modify(ModifyKind::Name(RenameMode::To)), gk.clone()), project, &gk),
            Relevance::Rearm
        );
    }

    fn recv_within(rx: &mpsc::Receiver<String>, ms: u64) -> Option<String> {
        rx.recv_timeout(Duration::from_millis(ms)).ok()
    }

    fn drain(rx: &mpsc::Receiver<String>, ms: u64) -> usize {
        let mut n = 0;
        while rx.recv_timeout(Duration::from_millis(ms)).is_ok() {
            n += 1;
        }
        n
    }

    #[test]
    fn watcher_emits_debounced_changes() {
        let t = tempfile::tempdir().unwrap();
        let project = dir_s(t.path());
        let (tx, rx) = mpsc::channel::<String>();
        let tx = std::sync::Mutex::new(tx);
        let watchers = MissionWatchers::new(Arc::new(move |dir: &str| {
            let _ = tx.lock().unwrap().send(dir.to_string());
        }));

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
        let other_spelling = format!("{}\\", project.to_uppercase());
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
        let (tx, rx) = mpsc::channel::<String>();
        let tx = std::sync::Mutex::new(tx);
        let watchers = MissionWatchers::new(Arc::new(move |dir: &str| {
            let _ = tx.lock().unwrap().send(dir.to_string());
        }));
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
    fn watch_requires_an_existing_folder() {
        let watchers = MissionWatchers::new(Arc::new(|_: &str| {}));
        assert!(watchers.watch("relative").is_err());
        assert!(watchers.watch(r"C:\definitely\missing\gridkeeper\dir").is_err());
        assert!(watchers.is_empty());
        assert!(watchers.unwatch(r"C:\never\watched").is_ok());
    }
}
