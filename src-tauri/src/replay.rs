//! Mission replay: recordings in `<projectDir>/.gridkeeper/replay/*.jsonl` and exported videos / GIFs.
//!
//! - Recordings are compact JSON lines written by the frontend recorder (`src/replay/recorder.ts`): one
//!   object per line with at least `t` (ms epoch) and `k` (kind). Lines are validated before they are
//!   appended, so a file only ever holds whole JSON objects (a torn tail from a crash is isolated by a
//!   newline before the next append; readers skip unparsable lines).
//! - File names must match `^[A-Za-z0-9._-]+\.jsonl$` (at most 128 chars, no Windows device names):
//!   no command can reach outside the replay folder. The folder is created next to `mission.md` with
//!   the same self-ignoring `.gridkeeper/.gitignore`, and refused when it is a junction / symlink.
//! - A recording is capped at [`MAX_RECORDING_BYTES`]: an append that would cross it writes nothing and
//!   reports `full`, and the frontend stops recording. Reads are capped the same way.
//! - Exports: [`pick_save_path`] runs the native save dialog from Rust and registers the chosen path
//!   under a one-time token; [`save_export`] writes only to a registered path (extension .mp4 / .webm /
//!   .gif, or .json for a team template, matching the export kind, absolute, at most [`MAX_EXPORT_BYTES`]). A webview can therefore never
//!   name an arbitrary destination: the bytes go where the user pointed the dialog, or nowhere.

use std::collections::HashMap;
use std::fs;
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, UNIX_EPOCH};

use once_cell::sync::Lazy;
use parking_lot::Mutex;

use crate::mission::{DIR_NAME, ensure_dir, validate_project_dir};
use crate::types::*;

pub const REPLAY_DIR: &str = "replay";
pub const MAX_RECORDING_BYTES: u64 = 5 * 1024 * 1024;
/// One event line (the recorder keeps them far smaller: text fields are cut at 120–160 chars).
pub const MAX_LINE_BYTES: usize = 16 * 1024;
pub const MAX_NAME_LEN: usize = 128;
pub const MAX_EXPORT_BYTES: usize = 200 * 1024 * 1024;
/// Export formats; "json" is a team template (`<name>.gridkeeper-team.json`, src/actions/teamTemplates.ts).
pub const EXPORT_KINDS: &[&str] = &["mp4", "webm", "gif", "json"];
/// A save-dialog token expires if no export arrives in time (a 60 s video plus encoding fits easily).
pub const TOKEN_TTL: Duration = Duration::from_secs(30 * 60);
const MAX_TOKENS: usize = 16;

/// Serializes appends within this process (the recorder flushes one batch at a time, but be safe).
static APPEND_LOCK: Mutex<()> = Mutex::new(());

const DEVICE_NAMES: &[&str] = &[
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9", "lpt1",
    "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/// `^[A-Za-z0-9._-]+\.jsonl$`, at most [`MAX_NAME_LEN`] chars, not a Windows device name.
pub fn validate_name(name: &str) -> AppResult<()> {
    let bad = || AppError::Invalid(format!("Invalid recording name: {name:?}"));
    if name.len() > MAX_NAME_LEN || name.len() <= ".jsonl".len() {
        return Err(bad());
    }
    let Some(stem) = name.strip_suffix(".jsonl") else {
        return Err(bad());
    };
    if !name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'_' || b == b'-') {
        return Err(bad());
    }
    let base = stem.split('.').next().unwrap_or("").to_ascii_lowercase();
    if DEVICE_NAMES.contains(&base.as_str()) || stem.chars().all(|c| c == '.') {
        return Err(bad());
    }
    Ok(())
}

pub fn replay_dir(project: &Path) -> PathBuf {
    project.join(DIR_NAME).join(REPLAY_DIR)
}

fn is_link(meta: &fs::Metadata) -> bool {
    if meta.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return true;
        }
    }
    false
}

/// The replay folder when it exists as a real folder; `None` when missing.
fn existing_dir(project: &Path) -> AppResult<Option<PathBuf>> {
    let dir = replay_dir(project);
    match fs::symlink_metadata(&dir) {
        Ok(m) if is_link(&m) => Err(AppError::Invalid(format!("{} is a link; refusing to use it", dir.display()))),
        Ok(m) if m.is_dir() => Ok(Some(dir)),
        Ok(_) => Err(AppError::Invalid(format!("{} exists but is not a folder", dir.display()))),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// Create `.gridkeeper/` (with its self-ignoring `.gitignore`) and `.gridkeeper/replay/` when missing.
fn ensure_replay_dir(project: &Path) -> AppResult<PathBuf> {
    if let Some(dir) = existing_dir(project)? {
        return Ok(dir);
    }
    ensure_dir(&project.join(DIR_NAME))?;
    let dir = replay_dir(project);
    match fs::create_dir(&dir) {
        Ok(()) => Ok(dir),
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => existing_dir(project)?
            .ok_or_else(|| AppError::Invalid(format!("{} is not a folder", dir.display()))),
        Err(e) => Err(e.into()),
    }
}

/// A recording file inside an existing replay folder; rejects links and non-files.
fn recording_path(project: &Path, name: &str) -> AppResult<Option<PathBuf>> {
    validate_name(name)?;
    let Some(dir) = existing_dir(project)? else {
        return Ok(None);
    };
    let path = dir.join(name);
    match fs::symlink_metadata(&path) {
        Ok(m) if is_link(&m) || !m.is_file() => {
            Err(AppError::Invalid(format!("Not a recording file: {}", path.display())))
        }
        Ok(_) => Ok(Some(path)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// One single-line JSON object with a numeric `t` and a string `k`.
pub fn validate_line(line: &str) -> AppResult<()> {
    if line.is_empty() || line.len() > MAX_LINE_BYTES || line.contains(['\n', '\r']) {
        return Err(AppError::Invalid("A replay event must be one non-empty line of at most 16 KiB".into()));
    }
    let v: serde_json::Value = serde_json::from_str(line)
        .map_err(|e| AppError::Invalid(format!("A replay event is not valid JSON: {e}")))?;
    let ok = v.as_object().is_some_and(|o| {
        o.get("t").is_some_and(serde_json::Value::is_number) && o.get("k").is_some_and(serde_json::Value::is_string)
    });
    if !ok {
        return Err(AppError::Invalid("A replay event must be an object with a numeric \"t\" and a string \"k\"".into()));
    }
    Ok(())
}

fn modified_ms(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|m| m.duration_since(UNIX_EPOCH).ok())
        .and_then(|d| u64::try_from(d.as_millis()).ok())
        .unwrap_or(0)
}

/// Append whole lines to a recording (created on first append). Nothing is written when the batch would
/// push the file past [`MAX_RECORDING_BYTES`]; the result then says `full`.
pub fn append(project_dir: &str, file_name: &str, lines: &[String]) -> AppResult<ReplayAppend> {
    let project = validate_project_dir(project_dir)?;
    validate_name(file_name)?;
    for l in lines {
        validate_line(l)?;
    }
    let _guard = APPEND_LOCK.lock();
    let dir = ensure_replay_dir(&project)?;
    let path = dir.join(file_name);
    let size = match fs::symlink_metadata(&path) {
        Ok(m) if is_link(&m) || !m.is_file() => {
            return Err(AppError::Invalid(format!("Not a recording file: {}", path.display())));
        }
        Ok(m) => m.len(),
        Err(e) if e.kind() == io::ErrorKind::NotFound => 0,
        Err(e) => return Err(e.into()),
    };
    if lines.is_empty() {
        return Ok(ReplayAppend { size_bytes: size, full: size >= MAX_RECORDING_BYTES });
    }
    let mut payload = String::with_capacity(lines.iter().map(|l| l.len() + 1).sum::<usize>() + 1);
    let mut f = fs::OpenOptions::new().create(true).read(true).append(true).open(&path)?;
    if size > 0 {
        // A torn last line (crash mid-write) must not swallow the first new event.
        let mut last = [0u8; 1];
        f.seek(SeekFrom::End(-1))?;
        f.read_exact(&mut last)?;
        if last[0] != b'\n' {
            payload.push('\n');
        }
    }
    for l in lines {
        payload.push_str(l);
        payload.push('\n');
    }
    if size + payload.len() as u64 > MAX_RECORDING_BYTES {
        return Ok(ReplayAppend { size_bytes: size, full: true });
    }
    f.write_all(payload.as_bytes())?;
    f.flush()?;
    Ok(ReplayAppend { size_bytes: size + payload.len() as u64, full: false })
}

/// Recordings of a project, newest first. A missing replay folder is an empty list.
pub fn list(project_dir: &str) -> AppResult<Vec<ReplayInfo>> {
    let project = validate_project_dir(project_dir)?;
    let Some(dir) = existing_dir(&project)? else {
        return Ok(Vec::new());
    };
    let mut out = Vec::new();
    for entry in fs::read_dir(&dir)? {
        let Ok(entry) = entry else { continue };
        let name = entry.file_name().to_string_lossy().into_owned();
        if validate_name(&name).is_err() {
            continue;
        }
        let Ok(meta) = fs::symlink_metadata(entry.path()) else { continue };
        if is_link(&meta) || !meta.is_file() {
            continue;
        }
        out.push(ReplayInfo { name, size_bytes: meta.len(), modified_ms: modified_ms(&meta) });
    }
    out.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms).then_with(|| b.name.cmp(&a.name)));
    Ok(out)
}

/// Whole recording as text (lossy UTF-8), at most [`MAX_RECORDING_BYTES`].
pub fn read(project_dir: &str, name: &str) -> AppResult<String> {
    let project = validate_project_dir(project_dir)?;
    let Some(path) = recording_path(&project, name)? else {
        return Err(AppError::NotFound(format!("recording {name}")));
    };
    let f = fs::File::open(&path)?;
    let mut bytes = Vec::with_capacity((f.metadata()?.len() as usize).min(MAX_RECORDING_BYTES as usize) + 1);
    f.take(MAX_RECORDING_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_RECORDING_BYTES {
        return Err(AppError::Invalid(format!("The recording is larger than {} MB", MAX_RECORDING_BYTES >> 20)));
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// Delete a recording (a missing one is not an error).
pub fn delete(project_dir: &str, name: &str) -> AppResult<()> {
    let project = validate_project_dir(project_dir)?;
    match recording_path(&project, name)? {
        Some(path) => match fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.into()),
        },
        None => Ok(()),
    }
}

// ---------------------------------------------------------------------------
// Export: save-dialog tokens and the write
// ---------------------------------------------------------------------------

struct SaveTarget {
    path: PathBuf,
    at: Instant,
}

static SAVE_TARGETS: Lazy<Mutex<HashMap<String, SaveTarget>>> = Lazy::new(|| Mutex::new(HashMap::new()));

pub fn validate_kind(kind: &str) -> AppResult<&'static str> {
    EXPORT_KINDS
        .iter()
        .copied()
        .find(|k| k.eq_ignore_ascii_case(kind))
        .ok_or_else(|| AppError::Invalid(format!("Unknown export format: {kind:?}")))
}

/// Default file name for the dialog: `[A-Za-z0-9._-]`, at most 80 chars, with the export extension.
pub fn default_file_name(raw: &str, kind: &str) -> String {
    let stem = raw.rsplit(['/', '\\']).next().unwrap_or("");
    let stem = stem.strip_suffix(&format!(".{kind}")).unwrap_or(stem);
    let mut s: String = stem
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '-' })
        .take(80)
        .collect();
    s = s.trim_matches(['-', '.']).to_string();
    if s.is_empty() {
        s = "mission-replay".into();
    }
    format!("{s}.{kind}")
}

/// A destination the user picked: absolute, existing parent folder, not a folder itself, extension
/// equal to the export kind (added when the user typed none).
pub fn validate_export_path(path: &Path, kind: &str) -> AppResult<PathBuf> {
    let kind = validate_kind(kind)?;
    if !path.is_absolute() || path.as_os_str().to_string_lossy().contains('\0') {
        return Err(AppError::Invalid(format!("Not an absolute path: {}", path.display())));
    }
    let mut path = path.to_path_buf();
    match path.extension().map(|e| e.to_string_lossy().to_ascii_lowercase()) {
        None => {
            let name = format!("{}.{kind}", path.file_name().map(|n| n.to_string_lossy()).unwrap_or_default());
            path.set_file_name(name);
        }
        Some(ext) if ext == kind => {}
        Some(_) => return Err(AppError::Invalid(format!("The file name must end in .{kind}"))),
    }
    if path.file_stem().is_none_or(|s| s.is_empty()) {
        return Err(AppError::Invalid("The file needs a name".into()));
    }
    if !path.parent().is_some_and(Path::is_dir) {
        return Err(AppError::Invalid(format!("The folder does not exist: {}", path.display())));
    }
    if path.is_dir() {
        return Err(AppError::Invalid(format!("{} is a folder", path.display())));
    }
    Ok(path)
}

/// Remember a dialog-chosen destination; the returned token authorizes exactly one write to it.
pub fn register_save_target(path: &Path, kind: &str) -> AppResult<ReplaySaveTarget> {
    let path = validate_export_path(path, kind)?;
    let token = uuid::Uuid::new_v4().simple().to_string();
    let mut map = SAVE_TARGETS.lock();
    map.retain(|_, t| t.at.elapsed() < TOKEN_TTL);
    while map.len() >= MAX_TOKENS {
        let Some(oldest) = map.iter().min_by_key(|(_, t)| t.at).map(|(k, _)| k.clone()) else { break };
        map.remove(&oldest);
    }
    map.insert(token.clone(), SaveTarget { path: path.clone(), at: Instant::now() });
    Ok(ReplaySaveTarget { token, path: path.to_string_lossy().into_owned() })
}

/// Write an export to the path registered under `token` (consumed). Returns the path written.
pub fn save_export(token: &str, bytes: &[u8]) -> AppResult<String> {
    if bytes.is_empty() {
        return Err(AppError::Invalid("Nothing to save (empty export)".into()));
    }
    if bytes.len() > MAX_EXPORT_BYTES {
        return Err(AppError::Invalid(format!("The export is larger than {} MB", MAX_EXPORT_BYTES >> 20)));
    }
    let target = SAVE_TARGETS.lock().remove(token);
    let Some(target) = target.filter(|t| t.at.elapsed() < TOKEN_TTL) else {
        return Err(AppError::Invalid("The save location expired or was never chosen; export again".into()));
    };
    let path = target.path;
    let tmp = path.with_file_name(format!(
        ".{}.{}.partial",
        path.file_name().map(|n| n.to_string_lossy()).unwrap_or_default(),
        std::process::id()
    ));
    let written = (|| {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()
    })();
    if let Err(e) = written {
        let _ = fs::remove_file(&tmp);
        return Err(e.into());
    }
    if let Err(e) = fs::rename(&tmp, &path) {
        let _ = fs::remove_file(&tmp);
        return Err(e.into());
    }
    Ok(path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir_s(p: &Path) -> String {
        p.to_string_lossy().into_owned()
    }

    fn line(t: u64, k: &str) -> String {
        format!(r#"{{"t":{t},"k":"{k}"}}"#)
    }

    #[test]
    fn validates_names() {
        for ok in ["2026-10-18-1042-add-oauth.jsonl", "a.jsonl", "x_y-z.1.jsonl", "..x.jsonl"] {
            assert!(validate_name(ok).is_ok(), "{ok}");
        }
        for bad in [
            "",
            ".jsonl",
            "..jsonl",
            "a.json",
            "a.jsonl.txt",
            "../a.jsonl",
            "a/b.jsonl",
            "a\\b.jsonl",
            "C:a.jsonl",
            "a b.jsonl",
            "é.jsonl",
            "CON.jsonl",
            "nul.x.jsonl",
            "Lpt1.jsonl",
        ] {
            assert!(validate_name(bad).is_err(), "{bad}");
        }
        assert!(validate_name(&format!("{}.jsonl", "a".repeat(MAX_NAME_LEN))).is_err());
    }

    #[test]
    fn validates_lines() {
        assert!(validate_line(&line(1, "start")).is_ok());
        assert!(validate_line(r#"{"t":1.5,"k":"x","extra":[1,2]}"#).is_ok());
        assert!(validate_line("").is_err());
        assert!(validate_line("not json").is_err());
        assert!(validate_line("[1,2]").is_err());
        assert!(validate_line(r#"{"k":"x"}"#).is_err());
        assert!(validate_line(r#"{"t":"1","k":"x"}"#).is_err());
        assert!(validate_line(r#"{"t":1,"k":2}"#).is_err());
        assert!(validate_line("{\"t\":1,\n\"k\":\"x\"}").is_err());
        let long = format!(r#"{{"t":1,"k":"x","s":"{}"}}"#, "a".repeat(MAX_LINE_BYTES));
        assert!(validate_line(&long).is_err());
    }

    #[test]
    fn append_list_read_delete() {
        let t = tempfile::tempdir().unwrap();
        let project = dir_s(t.path());
        assert!(list(&project).unwrap().is_empty(), "no folder yet = empty list");
        assert!(matches!(read(&project, "a.jsonl"), Err(AppError::NotFound(_))));

        let r = append(&project, "a.jsonl", &[line(1, "start"), line(2, "attn")]).unwrap();
        assert!(!r.full);
        let gk = t.path().join(DIR_NAME);
        assert_eq!(fs::read_to_string(gk.join(".gitignore")).unwrap(), "*\n", "self-ignoring folder");
        let text = read(&project, "a.jsonl").unwrap();
        assert_eq!(text, format!("{}\n{}\n", line(1, "start"), line(2, "attn")));
        assert_eq!(r.size_bytes, text.len() as u64);

        append(&project, "a.jsonl", &[line(3, "end")]).unwrap();
        assert!(read(&project, "a.jsonl").unwrap().ends_with(&format!("{}\n", line(3, "end"))));
        // Empty batch: no write, reports the size.
        assert_eq!(append(&project, "a.jsonl", &[]).unwrap().size_bytes, read(&project, "a.jsonl").unwrap().len() as u64);

        std::thread::sleep(Duration::from_millis(20));
        append(&project, "b.jsonl", &[line(9, "start")]).unwrap();
        fs::write(replay_dir(t.path()).join("notes.txt"), "x").unwrap();
        fs::create_dir(replay_dir(t.path()).join("dir.jsonl")).unwrap();
        let names: Vec<String> = list(&project).unwrap().into_iter().map(|i| i.name).collect();
        assert_eq!(names, vec!["b.jsonl".to_string(), "a.jsonl".to_string()], "newest first, only recordings");
        assert!(read(&project, "dir.jsonl").is_err());

        // Invalid input never writes.
        assert!(append(&project, "a.jsonl", &[line(4, "x"), "oops".into()]).is_err());
        assert!(!read(&project, "a.jsonl").unwrap().contains("\"t\":4"));
        assert!(append(&project, "../a.jsonl", &[line(1, "x")]).is_err());
        assert!(append("relative", "a.jsonl", &[line(1, "x")]).is_err());

        delete(&project, "a.jsonl").unwrap();
        delete(&project, "a.jsonl").unwrap(); // idempotent
        assert!(delete(&project, "..\\b.jsonl").is_err());
        assert_eq!(list(&project).unwrap().len(), 1);
    }

    #[test]
    fn append_isolates_a_torn_tail() {
        let t = tempfile::tempdir().unwrap();
        let project = dir_s(t.path());
        append(&project, "a.jsonl", &[line(1, "start")]).unwrap();
        let path = replay_dir(t.path()).join("a.jsonl");
        let mut f = fs::OpenOptions::new().append(true).open(&path).unwrap();
        f.write_all(br#"{"t":2,"k":"at"#).unwrap();
        drop(f);
        append(&project, "a.jsonl", &[line(3, "end")]).unwrap();
        let text = read(&project, "a.jsonl").unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[2], line(3, "end"));
    }

    #[test]
    fn append_caps_the_recording() {
        let t = tempfile::tempdir().unwrap();
        let project = dir_s(t.path());
        let pad = "a".repeat(MAX_LINE_BYTES - 64);
        let big = format!(r#"{{"t":1,"k":"msg","s":"{pad}"}}"#);
        let batch: Vec<String> = vec![big.clone(); 32];
        let mut full = false;
        for _ in 0..200 {
            let r = append(&project, "a.jsonl", &batch).unwrap();
            assert!(r.size_bytes <= MAX_RECORDING_BYTES);
            if r.full {
                full = true;
                break;
            }
        }
        assert!(full, "the cap is reached");
        let size = fs::metadata(replay_dir(t.path()).join("a.jsonl")).unwrap().len();
        assert!(size <= MAX_RECORDING_BYTES);
        assert!(read(&project, "a.jsonl").is_ok());
    }

    #[test]
    fn rejects_a_file_where_the_folder_should_be() {
        let t = tempfile::tempdir().unwrap();
        let gk = t.path().join(DIR_NAME);
        fs::create_dir(&gk).unwrap();
        fs::write(gk.join(REPLAY_DIR), "not a folder").unwrap();
        assert!(append(&dir_s(t.path()), "a.jsonl", &[line(1, "x")]).is_err());
        assert!(list(&dir_s(t.path())).is_err());
    }

    #[test]
    fn export_paths_and_names() {
        let t = tempfile::tempdir().unwrap();
        let base = t.path();
        assert_eq!(validate_export_path(&base.join("a.mp4"), "mp4").unwrap(), base.join("a.mp4"));
        assert_eq!(validate_export_path(&base.join("a.MP4"), "mp4").unwrap(), base.join("a.MP4"));
        assert_eq!(validate_export_path(&base.join("clip"), "gif").unwrap(), base.join("clip.gif"));
        assert!(validate_export_path(&base.join("a.gif"), "mp4").is_err(), "extension must match the format");
        assert!(validate_export_path(&base.join("a.exe"), "mp4").is_err());
        assert!(validate_export_path(Path::new("relative.mp4"), "mp4").is_err());
        assert!(validate_export_path(&base.join("missing").join("a.mp4"), "mp4").is_err());
        assert!(validate_export_path(&base.join("a.mp4"), "mov").is_err());
        fs::create_dir(base.join("d.webm")).unwrap();
        assert!(validate_export_path(&base.join("d.webm"), "webm").is_err());

        assert_eq!(default_file_name("add-oauth-replay", "mp4"), "add-oauth-replay.mp4");
        assert_eq!(default_file_name("..\\..\\evil name.gif", "gif"), "evil-name.gif");
        assert_eq!(default_file_name("", "webm"), "mission-replay.webm");
        assert_eq!(default_file_name("feature-squad.gridkeeper-team", "json"), "feature-squad.gridkeeper-team.json");
        assert_eq!(validate_export_path(&base.join("t.gridkeeper-team.json"), "json").unwrap(), base.join("t.gridkeeper-team.json"));
    }

    #[test]
    fn export_tokens_are_one_time() {
        let t = tempfile::tempdir().unwrap();
        let target = register_save_target(&t.path().join("out.gif"), "gif").unwrap();
        assert!(target.path.ends_with("out.gif"));
        assert!(save_export(&target.token, b"").is_err(), "empty export refused (before the token is used)");
        let written = save_export(&target.token, b"GIF89a;").unwrap();
        assert_eq!(fs::read(&written).unwrap(), b"GIF89a;");
        assert!(save_export(&target.token, b"GIF89a;").is_err(), "a token works once");
        assert!(save_export("made-up", b"x").is_err(), "unknown token");
        let names: Vec<String> =
            fs::read_dir(t.path()).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(names, vec!["out.gif".to_string()], "no partial files left");
        let too_big = vec![0u8; MAX_EXPORT_BYTES + 1];
        let target = register_save_target(&t.path().join("big.mp4"), "mp4").unwrap();
        assert!(save_export(&target.token, &too_big).is_err());
    }
}
