//! Brain: the team's long-term project memory, plain Markdown in `<project>/.gridkeeper/brain/`.
//!
//! Layout (agents read and write these files directly; format documented in
//! `skills/agent-mission/SKILL.md`):
//! - `notes/<slug>.md`: one confirmed memory per file, a tiny front matter plus a few lines of body.
//! - `inbox/<slug>.md`: suggested memories (same format, `confidence: suggested`) waiting for the user.
//! - `INDEX.md`: generated from both folders, never edited by hand. Regenerated after every change made
//!   through these commands (debounced, [`schedule_index`]), by the mission watcher when an agent edits a
//!   note directly ([`regenerate_index`]) and by [`list`] when it is stale. Written only when its content
//!   changes, and deterministic (no clock in it), so a team that shares the brain through git gets
//!   stable diffs.
//!
//! Note format:
//! ```text
//! ---
//! title: Refresh tokens live in the OS keychain
//! kind: decision            (decision | convention | gotcha | howto | fact | context)
//! tags: [auth, security]
//! source: task "Design the token storage"
//! created: 2026-10-18
//! updated: 2026-10-18
//! confidence: confirmed     (confirmed | suggested)
//! supersedes: token-file    (optional: slug of the note this one replaces)
//! ---
//! We store refresh tokens in the OS keychain, never on disk.
//! ```
//! Parsing is lenient (agents write these by hand): no front matter, unknown keys, YAML block lists,
//! quoted values, CRLF and a BOM are all fine. Unknown kinds count as `fact`; `person-free-context` is
//! read as `context`. Without a `title:` the first `# heading` (else the first line) is the title.
//!
//! Safety: slugs are bare file stems (`[A-Za-z0-9][A-Za-z0-9._-]*`, no `..`, no device names), notes are
//! capped at [`MAX_NOTE_BYTES`], links are never followed, writes are atomic with an optional conflict
//! check and redacted (secret-looking values masked) like team.md.
//!
//! Sharing: `.gridkeeper/` ignores itself (`.gitignore` = `*`). [`set_shared`] adds a marked block of
//! exceptions so `brain/notes/*.md`, `brain/INDEX.md` and the `.gitignore` itself can be committed; the
//! inbox (and the mission board, team file, outbox and replays) always stay local.

use std::collections::HashMap;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, UNIX_EPOCH};

use once_cell::sync::Lazy;
use parking_lot::{Condvar, Mutex};

use crate::mission::{DIR_NAME, atomic_replace, decode, ensure_dir, validate_project_dir};
use crate::types::*;

pub const BRAIN_DIR: &str = "brain";
pub const NOTES_DIR: &str = "notes";
pub const INBOX_DIR: &str = "inbox";
pub const INDEX_FILE: &str = "INDEX.md";
/// Notes are meant to be small: a few concrete lines.
pub const MAX_NOTE_BYTES: usize = 16 * 1024;
/// At most this many notes are read per folder (by file name).
pub const MAX_NOTES: usize = 1000;
pub const MAX_SLUG_LEN: usize = 80;
pub const MAX_QUERY_CHARS: usize = 200;
pub const MAX_HITS: usize = 50;
/// File names in notes/ or inbox/ that are not valid slugs are reported (up to this many), not read.
pub const MAX_IGNORED: usize = 20;
pub const EXCERPT_CHARS: usize = 160;
pub const MAX_TAGS: usize = 12;
pub const MAX_TAG_CHARS: usize = 32;
pub const MAX_TITLE_CHARS: usize = 120;
/// Trailing debounce of [`schedule_index`].
pub const INDEX_DEBOUNCE: Duration = Duration::from_millis(250);
/// Display order (INDEX.md sections, UI filters).
pub const KINDS: [&str; 6] = ["decision", "convention", "gotcha", "howto", "fact", "context"];
/// Deleted notes are returned (for Undo) up to this many bytes.
const MAX_DELETE_READ: usize = 256 * 1024;
/// The parsed-note cache stops growing beyond this many bytes of note text.
const CACHE_MAX_BYTES: usize = 4 * 1024 * 1024;

const SHARE_BEGIN: &str = "# >>> gridkeeper brain: shared through git (Brain panel). The inbox, mission board, team file, outbox and replays stay local.";
const SHARE_BEGIN_PREFIX: &str = "# >>> gridkeeper brain";
const SHARE_END: &str = "# <<< gridkeeper brain";
const SHARE_RULES: [&str; 5] = ["!.gitignore", "!brain/", "!brain/notes/", "!brain/notes/*.md", "!brain/INDEX.md"];

/// Serializes writes, moves and deletes within this process.
static WRITE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
/// Serializes INDEX.md regeneration (commands, the debounce thread and the mission watcher).
static INDEX_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn lock(m: &std::sync::Mutex<()>) -> std::sync::MutexGuard<'_, ()> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

pub fn brain_path(project: &Path) -> PathBuf {
    project.join(DIR_NAME).join(BRAIN_DIR)
}

fn folder(project: &Path, inbox: bool) -> PathBuf {
    brain_path(project).join(if inbox { INBOX_DIR } else { NOTES_DIR })
}

fn note_path(project: &Path, slug: &str, inbox: bool) -> PathBuf {
    folder(project, inbox).join(format!("{slug}.md"))
}

fn modified_ms(meta: &fs::Metadata) -> Option<u64> {
    let d = meta.modified().ok()?.duration_since(UNIX_EPOCH).ok()?;
    u64::try_from(d.as_millis()).ok()
}

fn too_large(bytes: u64) -> AppError {
    AppError::Invalid(format!(
        "The note is larger than {} KiB ({} KiB); keep memories short",
        MAX_NOTE_BYTES / 1024,
        bytes.div_ceil(1024)
    ))
}

fn today() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

const RESERVED: [&str; 4] = ["con", "prn", "aux", "nul"];

/// A bare, portable file stem: `[A-Za-z0-9][A-Za-z0-9._-]*`, at most [`MAX_SLUG_LEN`], no `..`, not
/// ending in `.`, not a Windows device name (`con`, `nul`, `com1`, …).
pub fn is_valid_slug(s: &str) -> bool {
    let b = s.as_bytes();
    if b.is_empty() || b.len() > MAX_SLUG_LEN || !b[0].is_ascii_alphanumeric() || s.contains("..") || s.ends_with('.') {
        return false;
    }
    if !b.iter().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.')) {
        return false;
    }
    let stem = s.split('.').next().unwrap_or("").to_ascii_lowercase();
    let device = RESERVED.contains(&stem.as_str())
        || ((stem.starts_with("com") || stem.starts_with("lpt")) && stem.len() == 4 && stem.as_bytes()[3].is_ascii_digit());
    !device
}

pub fn validate_slug(slug: &str) -> AppResult<()> {
    if is_valid_slug(slug) {
        Ok(())
    } else {
        Err(AppError::Invalid(format!(
            "Not a brain note name: {slug:?} (letters, digits, '-', '_' or '.', at most {MAX_SLUG_LEN} characters)"
        )))
    }
}

/// `<slug>.md` with a valid slug → the slug.
fn slug_of_file(name: &str) -> Option<&str> {
    let stem = name.len().checked_sub(3).filter(|&i| name.is_char_boundary(i) && name[i..].eq_ignore_ascii_case(".md")).map(|i| &name[..i])?;
    is_valid_slug(stem).then_some(stem)
}

/// A note file the watcher should report: `*.md`, not hidden or temporary.
pub fn is_note_file_name(path: &Path) -> bool {
    path.file_name().and_then(|n| n.to_str()).is_some_and(|n| slug_of_file(n).is_some())
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/// A note split into its front matter (lowercased keys in file order; block lists joined with ", ")
/// and its body.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ParsedNote {
    pub fields: Vec<(String, String)>,
    pub body: String,
    pub has_front_matter: bool,
}

impl ParsedNote {
    /// First value of `key` (lowercase), trimmed; `None` when missing or empty.
    pub fn get(&self, key: &str) -> Option<&str> {
        self.fields.iter().find(|(k, _)| k == key).map(|(_, v)| v.trim()).filter(|v| !v.is_empty())
    }
}

fn is_key(k: &str) -> bool {
    let b = k.as_bytes();
    !b.is_empty() && b.len() <= 32 && b[0].is_ascii_alphabetic() && b.iter().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-'))
}

fn unquote(v: &str) -> &str {
    let v = v.trim();
    for q in ['"', '\''] {
        if v.len() >= 2 && v.starts_with(q) && v.ends_with(q) {
            return &v[1..v.len() - 1];
        }
    }
    v
}

/// Split front matter and body. Never fails: anything that is not a closed `---` block is body.
pub fn parse_note(text: &str) -> ParsedNote {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let lines: Vec<&str> = text.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).collect();
    if lines.first().is_some_and(|l| l.trim_end() == "---") {
        let close = lines.iter().enumerate().skip(1).take(64).find(|(_, l)| matches!(l.trim_end(), "---" | "...")).map(|(i, _)| i);
        if let Some(end) = close {
            let mut fields: Vec<(String, String)> = Vec::new();
            let mut list_key: Option<usize> = None;
            for l in &lines[1..end] {
                let t = l.trim();
                if let (Some(i), Some(item)) = (list_key, t.strip_prefix("- ").or_else(|| (t == "-").then_some(""))) {
                    let item = unquote(item);
                    if !item.is_empty() {
                        let v = &mut fields[i].1;
                        if !v.is_empty() {
                            v.push_str(", ");
                        }
                        v.push_str(item);
                    }
                    continue;
                }
                list_key = None;
                if let Some((k, v)) = l.split_once(':') {
                    let k = k.trim().to_ascii_lowercase();
                    if is_key(&k) {
                        let v = unquote(v).to_string();
                        if v.is_empty() {
                            list_key = Some(fields.len());
                        }
                        fields.push((k, v));
                    }
                }
            }
            let body = lines[end + 1..].join("\n");
            return ParsedNote { fields, body: body.trim_matches('\n').to_string(), has_front_matter: true };
        }
    }
    ParsedNote { fields: Vec::new(), body: lines.join("\n").trim_matches('\n').to_string(), has_front_matter: false }
}

/// `decision`, `convention`, `gotcha`, `howto`, `fact` or `context` (unknown → `fact`).
pub fn normalize_kind(raw: &str) -> &'static str {
    let k: String = raw.trim().to_ascii_lowercase().chars().filter(|c| c.is_ascii_alphanumeric()).collect();
    match k.as_str() {
        "decision" | "decisions" | "adr" => "decision",
        "convention" | "conventions" | "rule" | "rules" | "style" => "convention",
        "gotcha" | "gotchas" | "pitfall" | "pitfalls" | "warning" | "caveat" => "gotcha",
        "howto" | "howtos" | "recipe" | "guide" => "howto",
        "context" | "personfreecontext" | "background" => "context",
        _ => "fact",
    }
}

fn normalize_tag(raw: &str) -> Option<String> {
    let t = unquote(raw).trim().trim_start_matches('#').trim().to_lowercase();
    let mut out = String::new();
    for c in t.chars() {
        if c.is_alphanumeric() || matches!(c, '.' | '/' | '+' | '-') {
            out.push(c);
        } else if (c == ' ' || c == '_') && !out.ends_with('-') {
            out.push('-');
        }
    }
    let out: String = out.trim_matches('-').chars().take(MAX_TAG_CHARS).collect();
    (!out.is_empty()).then_some(out)
}

/// `[a, b]`, `a, b` or a joined block list → normalized, unique tags (at most [`MAX_TAGS`]).
pub fn parse_tags(raw: &str) -> Vec<String> {
    let inner = raw.trim().trim_start_matches('[').trim_end_matches(']');
    let mut out: Vec<String> = Vec::new();
    for t in inner.split(',').filter_map(normalize_tag) {
        if !out.contains(&t) {
            out.push(t);
        }
        if out.len() == MAX_TAGS {
            break;
        }
    }
    out
}

fn clip(s: &str, max: usize) -> String {
    let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if s.chars().count() <= max {
        return s;
    }
    let mut out: String = s.chars().take(max.saturating_sub(1)).collect();
    out.truncate(out.trim_end().len());
    out.push('…');
    out
}

fn date_of(v: Option<&str>) -> Option<String> {
    let v = v?.trim();
    let b = v.as_bytes();
    let ok = b.len() >= 10
        && b[..4].iter().all(u8::is_ascii_digit)
        && b[4] == b'-'
        && b[5..7].iter().all(u8::is_ascii_digit)
        && b[7] == b'-'
        && b[8..10].iter().all(u8::is_ascii_digit);
    ok.then(|| v[..10].to_string())
}

fn heading_text(line: &str) -> Option<&str> {
    let t = line.trim_start();
    let hashes = t.len() - t.trim_start_matches('#').len();
    (1..=6).contains(&hashes).then(|| t[hashes..].trim()).filter(|h| !h.is_empty())
}

/// Index entry of one note file.
pub fn meta_from(slug: &str, inbox: bool, text: &str, modified_ms: u64, bytes: u64) -> BrainNoteMeta {
    let p = parse_note(text);
    let lines: Vec<&str> = p.body.lines().collect();
    let first = lines.iter().position(|l| !l.trim().is_empty());
    let (title, skip) = match p.get("title") {
        Some(t) => (clip(t, MAX_TITLE_CHARS), None),
        None => match first {
            Some(i) => (clip(heading_text(lines[i]).unwrap_or(lines[i].trim()), MAX_TITLE_CHARS), Some(i)),
            None => (slug.to_string(), None),
        },
    };
    // A title taken from a heading is not repeated in the excerpt; one taken from a plain line is.
    let skip = skip.filter(|&i| heading_text(lines[i]).is_some());
    let excerpt_src: Vec<&str> = lines
        .iter()
        .enumerate()
        .filter(|(i, l)| Some(*i) != skip && !l.trim().is_empty())
        .map(|(_, l)| heading_text(l).unwrap_or(l.trim()))
        .collect();
    let confidence = match p.get("confidence").map(|c| c.to_ascii_lowercase()) {
        Some(c) if c == "confirmed" || c == "suggested" => c,
        _ => (if inbox { "suggested" } else { "confirmed" }).to_string(),
    };
    BrainNoteMeta {
        slug: slug.to_string(),
        inbox,
        title,
        kind: normalize_kind(p.get("kind").unwrap_or("")).to_string(),
        tags: p.get("tags").map(parse_tags).unwrap_or_default(),
        source: p.get("source").map(|s| clip(s, 200)),
        created: date_of(p.get("created")),
        updated: date_of(p.get("updated")).or_else(|| date_of(p.get("created"))),
        confidence,
        supersedes: p.get("supersedes").map(|s| s.trim_end_matches(".md").to_string()).filter(|s| is_valid_slug(s)),
        superseded_by: None,
        excerpt: clip(&excerpt_src.join(" "), EXCERPT_CHARS),
        modified_ms,
        bytes,
    }
}

/// Set front matter fields (keys lowercase), keeping every other line, the key order and the file's line
/// endings. Missing keys are added before the closing `---`; a note without front matter gets one.
pub fn set_fields(text: &str, set: &[(&str, &str)]) -> String {
    let bom = text.starts_with('\u{feff}');
    let body = text.strip_prefix('\u{feff}').unwrap_or(text);
    let eol = if body.contains("\r\n") { "\r\n" } else { "\n" };
    let mut lines: Vec<String> = body.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l).to_string()).collect();
    let close = if lines.first().is_some_and(|l| l.trim_end() == "---") {
        lines.iter().enumerate().skip(1).take(64).find(|(_, l)| matches!(l.trim_end(), "---" | "...")).map(|(i, _)| i)
    } else {
        None
    };
    let mut out = match close {
        Some(mut end) => {
            for (key, value) in set {
                let found = lines[1..end].iter().position(|l| l.split_once(':').is_some_and(|(k, _)| k.trim().eq_ignore_ascii_case(key)));
                match found {
                    Some(i) => {
                        let line = &mut lines[i + 1];
                        let k = line.split_once(':').map(|(k, _)| k.to_string()).unwrap_or_else(|| key.to_string());
                        *line = format!("{k}: {value}");
                        // A block list under the key belongs to the old value.
                        while i + 2 < end && lines[i + 2].trim_start().starts_with('-') && lines[i + 2].trim() != "---" {
                            lines.remove(i + 2);
                            end -= 1;
                        }
                    }
                    None => {
                        lines.insert(end, format!("{key}: {value}"));
                        end += 1;
                    }
                }
            }
            lines.join(eol)
        }
        None => {
            let mut fm = vec!["---".to_string()];
            fm.extend(set.iter().map(|(k, v)| format!("{k}: {v}")));
            fm.push("---".to_string());
            format!("{}{eol}{}", fm.join(eol), lines.join(eol))
        }
    };
    if bom {
        out.insert(0, '\u{feff}');
    }
    out
}

// ---------------------------------------------------------------------------
// Reading folders (with a small parsed-note cache keyed by path + size + modified time)
// ---------------------------------------------------------------------------

struct Loaded {
    meta: BrainNoteMeta,
    text: String,
}

struct Cached {
    modified_ms: u64,
    len: u64,
    inbox: bool,
    meta: BrainNoteMeta,
    text: String,
}

#[derive(Default)]
struct Cache {
    map: HashMap<PathBuf, Cached>,
    bytes: usize,
}

static CACHE: Lazy<Mutex<Cache>> = Lazy::new(|| Mutex::new(Cache::default()));

fn read_capped(path: &Path, cap: usize) -> io::Result<(Vec<u8>, fs::Metadata)> {
    let file = fs::File::open(path)?;
    let meta = file.metadata()?;
    let mut bytes = Vec::with_capacity((meta.len() as usize).min(cap));
    file.take(cap as u64).read_to_end(&mut bytes)?;
    Ok((bytes, meta))
}

fn load_one(path: &Path, slug: &str, inbox: bool, len: u64, ms: u64) -> Option<Loaded> {
    {
        let cache = CACHE.lock();
        if let Some(c) = cache.map.get(path).filter(|c| c.len == len && c.modified_ms == ms && c.inbox == inbox && c.meta.slug == slug) {
            return Some(Loaded { meta: c.meta.clone(), text: c.text.clone() });
        }
    }
    // Locked by its writer for a moment, or gone: skipped this time (the next event lists it again).
    let (bytes, meta) = read_capped(path, MAX_NOTE_BYTES).ok()?;
    let ms = modified_ms(&meta).unwrap_or(ms);
    let text = decode(&bytes);
    let m = meta_from(slug, inbox, &text, ms, meta.len());
    let mut cache = CACHE.lock();
    if cache.bytes + text.len() <= CACHE_MAX_BYTES {
        cache.bytes += text.len();
        let old = cache.map.insert(
            path.to_path_buf(),
            Cached { modified_ms: ms, len: meta.len(), inbox, meta: m.clone(), text: text.clone() },
        );
        if let Some(old) = old {
            cache.bytes -= old.text.len();
        }
    }
    Some(Loaded { meta: m, text })
}

struct Folder {
    notes: Vec<Loaded>,
    ignored: Vec<String>,
    truncated: bool,
}

fn load_folder(dir: &Path, inbox: bool) -> AppResult<Folder> {
    let mut out = Folder { notes: Vec::new(), ignored: Vec::new(), truncated: false };
    let rd = match fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(out),
        Err(e) => return Err(e.into()),
    };
    let mut found: Vec<(String, PathBuf, u64, u64)> = Vec::new();
    for entry in rd {
        let Ok(entry) = entry else { continue };
        // Links (and folders) are never followed.
        if !entry.file_type().is_ok_and(|t| t.is_file()) {
            continue;
        }
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else { continue };
        if name.starts_with('.') || name.starts_with('~') {
            continue; // hidden, temporary or editor lock files
        }
        match slug_of_file(&name) {
            Some(slug) => {
                let m = entry.metadata().ok();
                let len = m.as_ref().map_or(0, fs::Metadata::len);
                let ms = m.as_ref().and_then(modified_ms).unwrap_or(0);
                found.push((slug.to_string(), entry.path(), len, ms));
            }
            None => {
                if name.to_ascii_lowercase().ends_with(".md") && out.ignored.len() < MAX_IGNORED {
                    out.ignored.push(format!("{}/{name}", if inbox { INBOX_DIR } else { NOTES_DIR }));
                }
            }
        }
    }
    found.sort_by(|a, b| a.0.cmp(&b.0));
    if found.len() > MAX_NOTES {
        found.truncate(MAX_NOTES);
        out.truncated = true;
    }
    for (slug, path, len, ms) in found {
        if let Some(l) = load_one(&path, &slug, inbox, len, ms) {
            out.notes.push(l);
        }
    }
    Ok(out)
}

struct All {
    notes: Vec<Loaded>,
    inbox: Vec<Loaded>,
    ignored: Vec<String>,
    truncated: bool,
}

fn load_all(project: &Path) -> AppResult<All> {
    let brain = brain_path(project);
    let notes = load_folder(&brain.join(NOTES_DIR), false)?;
    let inbox = load_folder(&brain.join(INBOX_DIR), true)?;
    let mut all = All {
        notes: notes.notes,
        inbox: inbox.notes,
        ignored: notes.ignored,
        truncated: notes.truncated || inbox.truncated,
    };
    all.ignored.extend(inbox.ignored);
    all.ignored.truncate(MAX_IGNORED);
    // superseded_by: a confirmed note that names another one in `supersedes` (the newest one wins).
    let mut by_slug: HashMap<String, usize> = HashMap::new();
    for (i, n) in all.notes.iter().enumerate() {
        by_slug.insert(n.meta.slug.to_ascii_lowercase(), i);
    }
    let mut links: Vec<(usize, String, Option<String>)> = Vec::new();
    for n in &all.notes {
        if let Some(s) = &n.meta.supersedes {
            if let Some(&i) = by_slug.get(&s.to_ascii_lowercase()) {
                if !n.meta.slug.eq_ignore_ascii_case(s) {
                    links.push((i, n.meta.slug.clone(), n.meta.updated.clone()));
                }
            }
        }
    }
    links.sort_by(|a, b| a.2.cmp(&b.2).then_with(|| a.1.cmp(&b.1)));
    for (i, by, _) in links {
        all.notes[i].meta.superseded_by = Some(by);
    }
    // Notes: newest `updated` date first, then by title. Suggestions: newest file first.
    let by_title = |a: &Loaded, b: &Loaded| a.meta.title.to_lowercase().cmp(&b.meta.title.to_lowercase()).then_with(|| a.meta.slug.cmp(&b.meta.slug));
    all.notes.sort_by(|a, b| b.meta.updated.cmp(&a.meta.updated).then_with(|| by_title(a, b)));
    all.inbox.sort_by(|a, b| b.meta.modified_ms.cmp(&a.meta.modified_ms).then_with(|| by_title(a, b)));
    Ok(all)
}

fn index_of(project: &Path) -> AppResult<BrainIndex> {
    let brain = brain_path(project);
    let shared = is_shared(project);
    if !brain.is_dir() {
        return Ok(BrainIndex { dir: brain.to_string_lossy().into_owned(), shared, ..Default::default() });
    }
    let all = load_all(project)?;
    Ok(BrainIndex {
        dir: brain.to_string_lossy().into_owned(),
        exists: true,
        shared,
        notes: all.notes.into_iter().map(|l| l.meta).collect(),
        inbox: all.inbox.into_iter().map(|l| l.meta).collect(),
        ignored: all.ignored,
        truncated: all.truncated,
    })
}

/// Every note and suggestion of the project (missing brain folder = `exists: false`). Also brings
/// INDEX.md up to date when it is stale (a no-op otherwise).
pub fn list(project_dir: &str) -> AppResult<BrainIndex> {
    let project = validate_project_dir(project_dir)?;
    let idx = index_of(&project)?;
    if idx.exists {
        if let Err(e) = write_index(&project, &idx) {
            tracing::warn!(error = %e, "could not write brain INDEX.md");
        }
    }
    Ok(idx)
}

// ---------------------------------------------------------------------------
// Single notes
// ---------------------------------------------------------------------------

fn read_note_at(path: &Path, slug: &str, inbox: bool) -> AppResult<BrainNoteFile> {
    let path_s = path.to_string_lossy().into_owned();
    let missing = || BrainNoteFile { slug: slug.to_string(), inbox, path: path_s.clone(), exists: false, text: String::new(), modified_ms: None };
    match fs::symlink_metadata(path) {
        Ok(m) if m.file_type().is_symlink() => return Err(AppError::Invalid(format!("Links are not followed: {path_s}"))),
        Ok(m) if !m.is_file() => return Err(AppError::Invalid(format!("Not a file: {path_s}"))),
        Ok(m) if m.len() > MAX_NOTE_BYTES as u64 => return Err(too_large(m.len())),
        Ok(_) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(missing()),
        Err(e) => return Err(e.into()),
    }
    let (bytes, meta) = match read_capped(path, MAX_NOTE_BYTES + 1) {
        Ok(r) => r,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(missing()),
        Err(e) => return Err(e.into()),
    };
    if bytes.len() > MAX_NOTE_BYTES {
        return Err(too_large(bytes.len() as u64));
    }
    Ok(BrainNoteFile { slug: slug.to_string(), inbox, path: path_s, exists: true, text: decode(&bytes), modified_ms: modified_ms(&meta) })
}

/// One note (`inbox` = from inbox/). Missing = `exists: false`.
pub fn read(project_dir: &str, slug: &str, inbox: bool) -> AppResult<BrainNoteFile> {
    let project = validate_project_dir(project_dir)?;
    validate_slug(slug)?;
    read_note_at(&note_path(&project, slug, inbox), slug, inbox)
}

/// Create `.gridkeeper/` (self-ignoring), `brain/` and the note folder.
fn ensure_folder(project: &Path, inbox: bool) -> AppResult<PathBuf> {
    ensure_dir(&project.join(DIR_NAME))?;
    let dir = folder(project, inbox);
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// Not a link and not a folder (missing is fine).
fn refuse_non_file(path: &Path) -> AppResult<Option<fs::Metadata>> {
    match fs::symlink_metadata(path) {
        Ok(m) if m.file_type().is_symlink() => Err(AppError::Invalid(format!("Links are not followed: {}", path.display()))),
        Ok(m) if !m.is_file() => Err(AppError::Invalid(format!("Not a file: {}", path.display()))),
        Ok(m) => Ok(Some(m)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// Atomically write a note. With `check_expected`, the file must still be the version the caller read:
/// `expected_modified_ms == None` means "must not exist yet", `Some(ms)` "its last-write time is still
/// `ms`"; otherwise `AppError::Conflict`. The text is redacted (secret-looking values masked) and capped
/// at [`MAX_NOTE_BYTES`]. Schedules an INDEX.md regeneration.
pub fn write(
    project_dir: &str,
    slug: &str,
    text: &str,
    inbox: bool,
    expected_modified_ms: Option<u64>,
    check_expected: bool,
) -> AppResult<BrainNoteFile> {
    let project = validate_project_dir(project_dir)?;
    validate_slug(slug)?;
    if text.contains('\0') {
        return Err(AppError::Invalid("The note contains a NUL character".into()));
    }
    let clean = crate::redact::redact(text);
    if clean.len() > MAX_NOTE_BYTES {
        return Err(too_large(clean.len() as u64));
    }
    let path = {
        let _guard = lock(&WRITE_LOCK);
        let dir = ensure_folder(&project, inbox)?;
        let path = dir.join(format!("{slug}.md"));
        let current = refuse_non_file(&path)?;
        if check_expected {
            match (expected_modified_ms, current.as_ref().map(modified_ms)) {
                (None, None) => {}
                (Some(want), Some(Some(have))) if want == have => {}
                (None, Some(_)) => return Err(AppError::Conflict(format!("a note named {slug} already exists"))),
                (Some(_), None) => return Err(AppError::Conflict(format!("the note {slug} was deleted"))),
                (Some(_), Some(_)) => return Err(AppError::Conflict(format!("the note {slug} changed since it was read"))),
            }
        }
        atomic_replace(&path, clean.as_bytes())?;
        path
    };
    schedule_index(&project);
    read_note_at(&path, slug, inbox)
}

/// `dir/<slug>.md`, or `<slug>-2`, `<slug>-3`, … when taken.
fn free_slug(dir: &Path, slug: &str) -> String {
    let taken = |s: &str| fs::symlink_metadata(dir.join(format!("{s}.md"))).is_ok();
    if !taken(slug) {
        return slug.to_string();
    }
    for n in 2..10_000 {
        let suffix = format!("-{n}");
        let base: String = slug.chars().take(MAX_SLUG_LEN - suffix.len()).collect();
        let s = format!("{}{suffix}", base.trim_end_matches(['.', '-']));
        if is_valid_slug(&s) && !taken(&s) {
            return s;
        }
    }
    format!("note-{}", chrono::Local::now().timestamp_millis())
}

fn remove_with_retry(path: &Path) -> io::Result<()> {
    let mut attempt = 0;
    loop {
        match fs::remove_file(path) {
            Ok(()) => return Ok(()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Err(e),
            Err(_) if attempt < 4 => {
                attempt += 1;
                std::thread::sleep(Duration::from_millis(50 * attempt));
            }
            Err(e) => return Err(e),
        }
    }
}

/// Move a suggestion from inbox/ to notes/ as confirmed (`confidence: confirmed`, `updated: <today>`,
/// `created` added when missing). A name clash in notes/ gets a `-<n>` suffix. Returns the note's slug.
pub fn approve(project_dir: &str, slug: &str) -> AppResult<String> {
    let project = validate_project_dir(project_dir)?;
    validate_slug(slug)?;
    let target = {
        let _guard = lock(&WRITE_LOCK);
        let src = note_path(&project, slug, true);
        match refuse_non_file(&src)? {
            Some(m) if m.len() > MAX_NOTE_BYTES as u64 => return Err(too_large(m.len())),
            Some(_) => {}
            None => return Err(AppError::NotFound(format!("inbox note {slug}"))),
        }
        let text = decode(&read_capped(&src, MAX_NOTE_BYTES)?.0);
        let day = today();
        let parsed = parse_note(&text);
        let mut set: Vec<(&str, &str)> = vec![("confidence", "confirmed"), ("updated", &day)];
        if parsed.get("created").is_none() {
            set.push(("created", &day));
        }
        let next = crate::redact::redact(&set_fields(&text, &set));
        let dir = ensure_folder(&project, false)?;
        let target = free_slug(&dir, slug);
        atomic_replace(&dir.join(format!("{target}.md")), next.as_bytes())?;
        if let Err(e) = remove_with_retry(&src) {
            if e.kind() != io::ErrorKind::NotFound {
                tracing::warn!(error = %e, "approved brain note stays in the inbox too");
            }
        }
        target
    };
    schedule_index(&project);
    Ok(target)
}

/// Delete a note; returns the text it had (for Undo). `AppError::NotFound` when it is gone already.
pub fn delete(project_dir: &str, slug: &str, inbox: bool) -> AppResult<String> {
    let project = validate_project_dir(project_dir)?;
    validate_slug(slug)?;
    let text = {
        let _guard = lock(&WRITE_LOCK);
        let path = note_path(&project, slug, inbox);
        if refuse_non_file(&path)?.is_none() {
            return Err(AppError::NotFound(format!("brain note {slug}")));
        }
        let text = read_capped(&path, MAX_DELETE_READ).map(|(b, _)| decode(&b)).unwrap_or_default();
        match remove_with_retry(&path) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Err(AppError::NotFound(format!("brain note {slug}"))),
            Err(e) => return Err(e.into()),
        }
        text
    };
    schedule_index(&project);
    Ok(text)
}

// ---------------------------------------------------------------------------
// Search: local full text, BM25-style over title / tags / kind / source / body, with prefix matching
// ---------------------------------------------------------------------------

const STOP: [&str; 24] = [
    "the", "an", "and", "or", "of", "to", "in", "on", "for", "is", "it", "we", "be", "with", "at", "by", "as", "this", "that", "are",
    "was", "not", "but", "our",
];

/// Lowercase words (Unicode letters / digits); single letters and a few stop words dropped.
pub fn tokenize(text: &str) -> Vec<String> {
    text.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| !t.is_empty())
        .filter(|t| t.chars().count() > 1 || t.chars().all(|c| c.is_ascii_digit()))
        .filter(|t| !STOP.contains(t))
        .map(str::to_string)
        .collect()
}

struct Doc<'a> {
    meta: &'a BrainNoteMeta,
    body: String,
    /// title, tags, kind, source, body
    fields: [Vec<String>; 5],
}

const WEIGHTS: [f64; 5] = [3.0, 2.5, 1.5, 0.5, 1.0];
const K1: f64 = 1.2;
const B: f64 = 0.75;
/// A word that only starts with a query term counts this much of an exact match.
const PREFIX_CREDIT: f64 = 0.6;

fn term_freq(tokens: &[String], term: &str) -> f64 {
    let prefix_ok = term.chars().count() >= 2;
    tokens
        .iter()
        .map(|t| {
            if t == term {
                1.0
            } else if prefix_ok && t.starts_with(term) {
                PREFIX_CREDIT
            } else {
                0.0
            }
        })
        .sum()
}

fn snippet(doc: &Doc, terms: &[String]) -> String {
    for line in doc.body.lines() {
        let lower = line.to_lowercase();
        let Some(pos) = terms.iter().filter_map(|t| lower.find(t.as_str())).min() else { continue };
        let text = heading_text(line).unwrap_or(line.trim());
        if text.chars().count() <= EXCERPT_CHARS {
            return clip(text, EXCERPT_CHARS);
        }
        // Around the match: up to 40 characters before it.
        let before = lower[..pos.min(lower.len())].chars().count();
        let start = before.saturating_sub(40);
        let tail: String = line.chars().skip(start).collect();
        let s = clip(&tail, EXCERPT_CHARS);
        return if start > 0 { format!("…{s}") } else { s };
    }
    doc.meta.excerpt.clone()
}

/// Ranked hits for `query` over notes and suggestions (at most [`MAX_HITS`]). Empty query = no hits.
pub fn search(project_dir: &str, query: &str) -> AppResult<Vec<BrainHit>> {
    let project = validate_project_dir(project_dir)?;
    let q: String = query.chars().take(MAX_QUERY_CHARS).collect();
    let mut terms: Vec<String> = Vec::new();
    for t in tokenize(&q) {
        if !terms.contains(&t) {
            terms.push(t);
        }
    }
    if terms.is_empty() || !brain_path(&project).is_dir() {
        return Ok(Vec::new());
    }
    let all = load_all(&project)?;
    Ok(rank(all.notes.iter().chain(all.inbox.iter()), &terms))
}

fn rank<'a>(loaded: impl Iterator<Item = &'a Loaded>, terms: &[String]) -> Vec<BrainHit> {
    let docs: Vec<Doc> = loaded
        .map(|l| {
            let body = parse_note(&l.text).body;
            Doc {
                meta: &l.meta,
                fields: [
                    tokenize(&l.meta.title),
                    tokenize(&l.meta.tags.join(" ")),
                    tokenize(&l.meta.kind),
                    tokenize(l.meta.source.as_deref().unwrap_or("")),
                    tokenize(&body),
                ],
                body,
            }
        })
        .collect();
    if docs.is_empty() {
        return Vec::new();
    }
    let n = docs.len() as f64;
    let avg: Vec<f64> = (0..5).map(|f| (docs.iter().map(|d| d.fields[f].len()).sum::<usize>() as f64 / n).max(1.0)).collect();
    let mut scores = vec![0.0f64; docs.len()];
    let mut matched = vec![0usize; docs.len()];
    for term in terms {
        let tfs: Vec<[f64; 5]> = docs.iter().map(|d| std::array::from_fn(|f| term_freq(&d.fields[f], term))).collect();
        let df = tfs.iter().filter(|tf| tf.iter().any(|&x| x > 0.0)).count() as f64;
        if df == 0.0 {
            continue;
        }
        let idf = (1.0 + (n - df + 0.5) / (df + 0.5)).ln();
        for (i, tf) in tfs.iter().enumerate() {
            let mut w = 0.0;
            for f in 0..5 {
                if tf[f] > 0.0 {
                    let len = docs[i].fields[f].len() as f64;
                    w += WEIGHTS[f] * tf[f] / (1.0 - B + B * len / avg[f]);
                }
            }
            if w > 0.0 {
                scores[i] += idf * w * (K1 + 1.0) / (w + K1);
                matched[i] += 1;
            }
        }
    }
    let mut hits: Vec<BrainHit> = Vec::new();
    for (i, d) in docs.iter().enumerate() {
        if matched[i] == 0 {
            continue;
        }
        let mut score = scores[i] * (0.5 + 0.5 * matched[i] as f64 / terms.len() as f64);
        if d.meta.inbox {
            score *= 0.85;
        }
        if d.meta.superseded_by.is_some() {
            score *= 0.7;
        }
        hits.push(BrainHit {
            slug: d.meta.slug.clone(),
            inbox: d.meta.inbox,
            title: d.meta.title.clone(),
            kind: d.meta.kind.clone(),
            tags: d.meta.tags.clone(),
            score: (score * 1000.0).round() / 1000.0,
            snippet: snippet(d, terms),
            superseded: d.meta.superseded_by.is_some(),
        });
    }
    hits.sort_by(|a, b| b.score.total_cmp(&a.score).then_with(|| a.title.to_lowercase().cmp(&b.title.to_lowercase())).then_with(|| a.slug.cmp(&b.slug)));
    hits.truncate(MAX_HITS);
    hits
}

// ---------------------------------------------------------------------------
// INDEX.md
// ---------------------------------------------------------------------------

fn kind_heading(kind: &str) -> &'static str {
    match kind {
        "decision" => "Decisions",
        "convention" => "Conventions",
        "gotcha" => "Gotchas",
        "howto" => "How-tos",
        "context" => "Context",
        _ => "Facts",
    }
}

fn link_text(s: &str) -> String {
    s.replace(['[', ']'], "").replace('\n', " ")
}

fn entry_line(n: &BrainNoteMeta, folder: &str) -> String {
    let mut parts = vec![n.kind.clone()];
    if !n.tags.is_empty() {
        parts.push(n.tags.join(", "));
    }
    if let Some(u) = &n.updated {
        parts.push(u.clone());
    }
    format!("- [{}]({folder}/{}.md) — {}", link_text(&n.title), n.slug, parts.join(" · "))
}

/// The generated index (LF endings, no clock: identical input gives identical bytes).
pub fn render_index(notes: &[BrainNoteMeta], inbox: &[BrainNoteMeta]) -> String {
    let mut out: Vec<String> = vec![
        "<!-- Generated by Gridkeeper from notes/ and inbox/. Do not edit: it is rewritten whenever a note changes. -->".into(),
        "# Project brain".into(),
        String::new(),
        "Read me first. This folder is the team's long-term memory for this project: decisions, conventions, gotchas, how-tos, facts and context that earlier agents and the user wrote down.".into(),
        String::new(),
        "1. Skim this index, then open the notes relevant to your task (links are relative to this folder).".into(),
        "2. Learned something the next agent must know? Create ONE new file `inbox/<short-slug>.md` in the format at the end of this file. The user approves it into `notes/`.".into(),
        "3. Never edit or delete confirmed notes in `notes/`. To correct one, write an inbox note with `supersedes: <its slug>`.".into(),
        "4. Keep notes small, concrete and factual. Never write secrets, tokens, passwords, e-mail addresses or personal data.".into(),
        String::new(),
    ];
    let current: Vec<&BrainNoteMeta> = notes.iter().filter(|n| n.superseded_by.is_none()).collect();
    let old: Vec<&BrainNoteMeta> = notes.iter().filter(|n| n.superseded_by.is_some()).collect();
    let plural = |n: usize, one: &str, many: &str| format!("{n} {}", if n == 1 { one } else { many });
    out.push(format!(
        "{} · {} waiting in inbox/",
        plural(current.len(), "memory", "memories"),
        plural(inbox.len(), "suggestion", "suggestions")
    ));
    if current.is_empty() {
        out.extend([String::new(), "No memories yet.".into()]);
    }
    let by_title = |a: &&BrainNoteMeta, b: &&BrainNoteMeta| a.title.to_lowercase().cmp(&b.title.to_lowercase()).then_with(|| a.slug.cmp(&b.slug));
    for kind in KINDS {
        let mut group: Vec<&BrainNoteMeta> = current.iter().copied().filter(|n| n.kind == kind).collect();
        if group.is_empty() {
            continue;
        }
        group.sort_by(by_title);
        out.extend([String::new(), format!("## {}", kind_heading(kind)), String::new()]);
        out.extend(group.iter().map(|n| entry_line(n, NOTES_DIR)));
    }
    if !old.is_empty() {
        let mut old = old;
        old.sort_by(by_title);
        out.extend([String::new(), "## Superseded (history; read the newer note instead)".into(), String::new()]);
        for n in old {
            let by = n.superseded_by.as_deref().unwrap_or_default();
            out.push(format!("{} — superseded by [{by}]({NOTES_DIR}/{by}.md)", entry_line(n, NOTES_DIR)));
        }
    }
    if !inbox.is_empty() {
        let mut sug: Vec<&BrainNoteMeta> = inbox.iter().collect();
        sug.sort_by(by_title);
        out.extend([String::new(), "## Inbox (suggested, not approved yet)".into(), String::new()]);
        out.extend(sug.iter().map(|n| entry_line(n, INBOX_DIR)));
    }
    out.extend(
        [
            "",
            "## Note format",
            "",
            "One memory per file, named with a short lowercase slug (`notes/refresh-tokens.md`):",
            "",
            "```markdown",
            "---",
            "title: Refresh tokens live in the OS keychain",
            "kind: decision            # decision | convention | gotcha | howto | fact | context",
            "tags: [auth, security]",
            "source: task \"Design the token storage\"",
            "created: 2026-10-18",
            "updated: 2026-10-18",
            "confidence: suggested     # suggested in inbox/, confirmed in notes/",
            "supersedes: token-file    # optional: the slug this note replaces",
            "---",
            "We store refresh tokens in the OS keychain, never on disk (decided after the review of the auth branch).",
            "```",
            "",
        ]
        .map(String::from),
    );
    out.join("\n")
}

fn write_index(project: &Path, idx: &BrainIndex) -> AppResult<bool> {
    let text = render_index(&idx.notes, &idx.inbox);
    let brain = brain_path(project);
    let path = brain.join(INDEX_FILE);
    let _guard = lock(&INDEX_LOCK);
    if fs::read(&path).is_ok_and(|old| old == text.as_bytes()) || !brain.is_dir() {
        return Ok(false);
    }
    if fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_symlink() || m.is_dir()) {
        return Err(AppError::Invalid(format!("{} is not a regular file", path.display())));
    }
    atomic_replace(&path, text.as_bytes())?;
    Ok(true)
}

/// Rewrite `brain/INDEX.md` from the notes when it differs. No brain folder = nothing to do (`false`).
pub fn regenerate_index(project: &Path) -> AppResult<bool> {
    if !brain_path(project).is_dir() {
        return Ok(false);
    }
    let idx = index_of(project)?;
    write_index(project, &idx)
}

struct IndexQueue {
    pending: Mutex<HashMap<PathBuf, Instant>>,
    cv: Condvar,
    started: AtomicBool,
}

static QUEUE: Lazy<IndexQueue> =
    Lazy::new(|| IndexQueue { pending: Mutex::new(HashMap::new()), cv: Condvar::new(), started: AtomicBool::new(false) });

/// Regenerate the project's INDEX.md [`INDEX_DEBOUNCE`] after the last change (one background thread,
/// started on first use, idle on a condition variable while nothing is pending).
pub fn schedule_index(project: &Path) {
    let q = &*QUEUE;
    q.pending.lock().insert(project.to_path_buf(), Instant::now() + INDEX_DEBOUNCE);
    if !q.started.swap(true, Ordering::SeqCst) && crate::pty::spawn_guarded("brain-index".into(), || index_loop(&QUEUE)).is_err() {
        q.started.store(false, Ordering::SeqCst);
        q.pending.lock().remove(project);
        if let Err(e) = regenerate_index(project) {
            tracing::warn!(error = %e, "could not write brain INDEX.md");
        }
        return;
    }
    q.cv.notify_one();
}

fn index_loop(q: &IndexQueue) {
    loop {
        let due: Vec<PathBuf> = {
            let mut p = q.pending.lock();
            loop {
                let now = Instant::now();
                let due: Vec<PathBuf> = p.iter().filter(|(_, d)| **d <= now).map(|(k, _)| k.clone()).collect();
                if !due.is_empty() {
                    for k in &due {
                        p.remove(k);
                    }
                    break due;
                }
                match p.values().min().copied() {
                    None => q.cv.wait(&mut p),
                    Some(d) => {
                        q.cv.wait_until(&mut p, d);
                    }
                }
            }
        };
        for project in due {
            if let Err(e) = regenerate_index(&project) {
                tracing::warn!(error = %e, "could not write brain INDEX.md");
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Sharing through git
// ---------------------------------------------------------------------------

fn gitignore_path(project: &Path) -> PathBuf {
    project.join(DIR_NAME).join(".gitignore")
}

/// `.gridkeeper/.gitignore` carries Gridkeeper's "share the brain" block.
pub fn is_shared(project: &Path) -> bool {
    fs::read(gitignore_path(project)).is_ok_and(|b| decode(&b).lines().any(|l| l.trim_start().starts_with(SHARE_BEGIN_PREFIX)))
}

/// The text without Gridkeeper's block (from its begin line through its end line).
fn without_share_block(text: &str) -> String {
    let mut out: Vec<&str> = Vec::new();
    let mut inside = false;
    for l in text.split_inclusive('\n') {
        let t = l.trim();
        if !inside && t.starts_with(SHARE_BEGIN_PREFIX) {
            inside = true;
            continue;
        }
        if inside {
            if t == SHARE_END {
                inside = false;
            }
            continue;
        }
        out.push(l);
    }
    out.concat()
}

/// Share the brain through git (`share`), or keep it local again. Rewrites only Gridkeeper's marked block
/// in `.gridkeeper/.gitignore`; other lines the user added stay. Sharing un-ignores the `.gitignore` itself,
/// `brain/notes/*.md` and `brain/INDEX.md`; everything else in `.gridkeeper/` stays ignored.
pub fn set_shared(project_dir: &str, share: bool) -> AppResult<BrainShare> {
    let project = validate_project_dir(project_dir)?;
    let _guard = lock(&WRITE_LOCK);
    ensure_dir(&project.join(DIR_NAME))?;
    let path = gitignore_path(&project);
    let current = match fs::read(&path) {
        Ok(b) => decode(&b),
        Err(e) if e.kind() == io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(e.into()),
    };
    let eol = if current.contains("\r\n") { "\r\n" } else { "\n" };
    let base = without_share_block(&current);
    let next = if share {
        let mut s = if base.trim().is_empty() { format!("*{eol}") } else { base };
        if !s.ends_with('\n') {
            s.push_str(eol);
        }
        s.push_str(SHARE_BEGIN);
        s.push_str(eol);
        for r in SHARE_RULES {
            s.push_str(r);
            s.push_str(eol);
        }
        s.push_str(SHARE_END);
        s.push_str(eol);
        s
    } else if base.trim().is_empty() {
        format!("*{eol}")
    } else {
        base
    };
    if next != current {
        atomic_replace(&path, next.as_bytes())?;
    }
    Ok(BrainShare { shared: share, gitignore_path: path.to_string_lossy().into_owned() })
}

/// Test hook: forget cached notes.
#[cfg(test)]
fn clear_cache() {
    let mut c = CACHE.lock();
    c.map.clear();
    c.bytes = 0;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir_s(p: &Path) -> String {
        p.to_string_lossy().into_owned()
    }

    fn note(title: &str, kind: &str, tags: &str, body: &str) -> String {
        format!("---\ntitle: {title}\nkind: {kind}\ntags: [{tags}]\nsource: user\ncreated: 2026-10-18\nupdated: 2026-10-18\nconfidence: confirmed\n---\n{body}\n")
    }

    fn put(project: &Path, inbox: bool, slug: &str, text: &str) {
        let dir = folder(project, inbox);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(format!("{slug}.md")), text).unwrap();
    }

    fn tmp_files(dir: &Path) -> Vec<String> {
        fs::read_dir(dir)
            .map(|rd| rd.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| n.ends_with(".tmp")).collect())
            .unwrap_or_default()
    }

    #[test]
    fn slugs_are_bare_portable_stems() {
        for ok in ["a", "token-storage", "ci_cache", "v2.1-notes", "A1", &"x".repeat(MAX_SLUG_LEN)] {
            assert!(is_valid_slug(ok), "{ok}");
        }
        for bad in [
            "", "-a", ".a", "_a", "a..b", "a.", "a/b", "a\\b", "a:b", "a b", "../x", "é", "con", "NUL", "com1", "lpt9.txt", "aux.notes",
            &"x".repeat(MAX_SLUG_LEN + 1),
        ] {
            assert!(!is_valid_slug(bad), "{bad:?}");
        }
        assert!(is_valid_slug("console") && is_valid_slug("com10") && is_valid_slug("lpt"), "only exact device names");
        assert_eq!(validate_slug("a/b").unwrap_err().code(), "invalid");
        assert_eq!(slug_of_file("a-b.md"), Some("a-b"));
        assert_eq!(slug_of_file("A-B.MD"), Some("A-B"));
        assert_eq!(slug_of_file(".a.md"), None);
        assert_eq!(slug_of_file("a.md.12.0.tmp"), None);
        assert_eq!(slug_of_file("My Note.md"), None);
        assert_eq!(slug_of_file("INDEX.txt"), None);
        assert!(is_note_file_name(Path::new("x/notes/a.md")));
        assert!(!is_note_file_name(Path::new("x/notes/.a.md.1.0.tmp")));
    }

    #[test]
    fn parses_front_matter_leniently() {
        let p = parse_note("\u{feff}---\r\nTitle: \"Quoted: title\"\r\nkind: Gotcha\r\ntags:\r\n  - CI\r\n  - 'build cache'\r\nweird line\r\n---\r\n\r\nBody line 1\r\nline 2\r\n");
        assert!(p.has_front_matter);
        assert_eq!(p.get("title"), Some("Quoted: title"));
        assert_eq!(p.get("kind"), Some("Gotcha"));
        assert_eq!(p.get("tags"), Some("CI, build cache"));
        assert_eq!(parse_tags(p.get("tags").unwrap()), vec!["ci", "build-cache"]);
        assert_eq!(p.body, "Body line 1\nline 2");
        assert_eq!(p.get("missing"), None);

        let p = parse_note("# Heading\nno front matter");
        assert!(!p.has_front_matter);
        assert_eq!(p.body, "# Heading\nno front matter");
        // Unclosed front matter: all body.
        let p = parse_note("---\ntitle: x\nbody without close");
        assert!(!p.has_front_matter);
        assert!(p.body.starts_with("---"));
        // `...` closes too; empty file.
        assert_eq!(parse_note("---\nkind: fact\n...\nb").get("kind"), Some("fact"));
        assert_eq!(parse_note(""), ParsedNote::default());
    }

    #[test]
    fn kinds_and_tags_normalize() {
        assert_eq!(normalize_kind("Decision"), "decision");
        assert_eq!(normalize_kind("how-to"), "howto");
        assert_eq!(normalize_kind("person-free-context"), "context");
        assert_eq!(normalize_kind("pitfall"), "gotcha");
        assert_eq!(normalize_kind("whatever"), "fact");
        assert_eq!(normalize_kind(""), "fact");
        assert_eq!(parse_tags("[Auth, #CI, auth, \"Build Cache\", , x_y]"), vec!["auth", "ci", "build-cache", "x-y"]);
        assert_eq!(parse_tags("a, b"), vec!["a", "b"]);
        let many: Vec<String> = (0..20).map(|i| format!("t{i}")).collect();
        assert_eq!(parse_tags(&many.join(",")).len(), MAX_TAGS);
        assert_eq!(parse_tags(&"y".repeat(50))[0].len(), MAX_TAG_CHARS);
    }

    #[test]
    fn meta_titles_excerpts_and_defaults() {
        let m = meta_from("a", false, &note("Keychain only", "decision", "auth, security", "We store refresh tokens in the OS keychain."), 5, 9);
        assert_eq!(m.title, "Keychain only");
        assert_eq!(m.kind, "decision");
        assert_eq!(m.tags, vec!["auth", "security"]);
        assert_eq!(m.source.as_deref(), Some("user"));
        assert_eq!(m.created.as_deref(), Some("2026-10-18"));
        assert_eq!(m.updated.as_deref(), Some("2026-10-18"));
        assert_eq!(m.confidence, "confirmed");
        assert_eq!(m.excerpt, "We store refresh tokens in the OS keychain.");
        assert_eq!((m.modified_ms, m.bytes), (5, 9));

        // Heading as title (not repeated in the excerpt); inbox defaults to suggested; created stands in for updated.
        let m = meta_from("b", true, "---\ncreated: 2026-01-02T10:00\nsupersedes: a.md\n---\n# Use pnpm\n\nNever npm install in this repo.", 0, 0);
        assert_eq!(m.title, "Use pnpm");
        assert_eq!(m.excerpt, "Never npm install in this repo.");
        assert_eq!(m.confidence, "suggested");
        assert_eq!(m.updated.as_deref(), Some("2026-01-02"));
        assert_eq!(m.supersedes.as_deref(), Some("a"));
        assert_eq!(m.kind, "fact");

        // No front matter, plain first line: title and excerpt both from the body.
        let m = meta_from("c", false, "Ports 1420 and 9333 are taken by the dev tools.", 0, 0);
        assert_eq!(m.title, "Ports 1420 and 9333 are taken by the dev tools.");
        assert_eq!(m.excerpt, m.title);
        // Empty note: the slug is the title.
        assert_eq!(meta_from("empty-one", false, "", 0, 0).title, "empty-one");
        // Long text is clipped on characters.
        let m = meta_from("d", false, &format!("---\ntitle: {}\n---\n{}", "t".repeat(300), "é".repeat(400)), 0, 0);
        assert_eq!(m.title.chars().count(), MAX_TITLE_CHARS);
        assert!(m.title.ends_with('…'));
        assert_eq!(m.excerpt.chars().count(), EXCERPT_CHARS);
    }

    #[test]
    fn set_fields_keeps_everything_else() {
        let t = "---\r\ntitle: X\r\nconfidence: suggested\r\ntags:\r\n  - a\r\nextra: keep\r\n---\r\nbody\r\n";
        let out = set_fields(t, &[("confidence", "confirmed"), ("updated", "2026-10-19"), ("tags", "[b]")]);
        assert_eq!(out, "---\r\ntitle: X\r\nconfidence: confirmed\r\ntags: [b]\r\nextra: keep\r\nupdated: 2026-10-19\r\n---\r\nbody\r\n");
        let out = set_fields("just a body\n", &[("kind", "fact")]);
        assert_eq!(out, "---\nkind: fact\n---\njust a body\n");
        let out = set_fields("\u{feff}---\nKind: x\n---\nb", &[("kind", "gotcha")]);
        assert_eq!(out, "\u{feff}---\nKind: gotcha\n---\nb");
    }

    #[test]
    fn list_reads_notes_inbox_and_reports_odd_names() {
        clear_cache();
        let t = tempfile::tempdir().unwrap();
        let project = dir_s(t.path());
        let idx = list(&project).unwrap();
        assert!(!idx.exists);
        assert!(idx.notes.is_empty() && idx.inbox.is_empty());
        assert!(PathBuf::from(&idx.dir).ends_with(Path::new(".gridkeeper").join("brain")));
        assert!(!brain_path(t.path()).exists(), "listing never creates the brain");

        put(t.path(), false, "keychain", &note("Keychain", "decision", "auth", "Tokens in the keychain."));
        put(t.path(), false, "old-tokens", &note("Token file", "decision", "auth", "Tokens in a file.").replace("2026-10-18", "2026-09-01"));
        put(t.path(), false, "newer", &note("Keychain v2", "decision", "auth", "Still the keychain.").replace("confidence: confirmed", "supersedes: old-tokens"));
        put(t.path(), true, "pnpm", "---\nkind: convention\n---\nUse pnpm.");
        let notes = folder(t.path(), false);
        fs::write(notes.join("My Note.md"), "x").unwrap();
        fs::write(notes.join(".keychain.md.1.0.tmp"), "x").unwrap();
        fs::write(notes.join("readme.txt"), "x").unwrap();
        fs::create_dir(notes.join("folder.md")).unwrap();

        let idx = list(&project).unwrap();
        assert!(idx.exists);
        let slugs: Vec<&str> = idx.notes.iter().map(|n| n.slug.as_str()).collect();
        assert_eq!(slugs, vec!["keychain", "newer", "old-tokens"], "newest first, then title");
        assert_eq!(idx.inbox.len(), 1);
        assert_eq!(idx.inbox[0].confidence, "suggested");
        assert_eq!(idx.inbox[0].kind, "convention");
        assert_eq!(idx.ignored, vec!["notes/My Note.md".to_string()]);
        let old = idx.notes.iter().find(|n| n.slug == "old-tokens").unwrap();
        assert_eq!(old.superseded_by.as_deref(), Some("newer"));
        assert!(idx.notes.iter().filter(|n| n.slug != "old-tokens").all(|n| n.superseded_by.is_none()));
        // The listing brought INDEX.md up to date.
        let index = fs::read_to_string(brain_path(t.path()).join(INDEX_FILE)).unwrap();
        assert!(index.contains("- [Keychain](notes/keychain.md) — decision · auth · 2026-10-18"), "{index}");
        assert!(list("relative").is_err());
    }

    #[test]
    fn oversize_notes_are_listed_but_not_read() {
        clear_cache();
        let t = tempfile::tempdir().unwrap();
        let project = dir_s(t.path());
        put(t.path(), false, "big", &format!("---\ntitle: Big\n---\n{}", "x".repeat(MAX_NOTE_BYTES)));
        let idx = list(&project).unwrap();
        assert_eq!(idx.notes[0].title, "Big");
        assert!(idx.notes[0].bytes > MAX_NOTE_BYTES as u64);
        assert_eq!(read(&project, "big", false).unwrap_err().code(), "invalid");
    }

    #[test]
    fn write_read_and_conflicts() {
        let t = tempfile::tempdir().unwrap();
        let project = dir_s(t.path());
        let missing = read(&project, "a", false).unwrap();
        assert!(!missing.exists);
        assert_eq!(missing.modified_ms, None);

        let f = write(&project, "a", "---\nkind: fact\n---\nv1", false, None, true).unwrap();
        assert!(f.exists);
        assert_eq!(f.text, "---\nkind: fact\n---\nv1");
        let gk = t.path().join(DIR_NAME);
        assert_eq!(fs::read_to_string(gk.join(".gitignore")).unwrap(), "*\n", "self-ignoring .gridkeeper");
        assert!(tmp_files(&folder(t.path(), false)).is_empty());
        let ms = f.modified_ms.unwrap();

        assert_eq!(write(&project, "a", "v2", false, None, true).unwrap_err().code(), "conflict", "must not exist yet");
        assert_eq!(write(&project, "a", "v2", false, Some(ms.wrapping_sub(5000)), true).unwrap_err().code(), "conflict");
        assert_eq!(read(&project, "a", false).unwrap().text, "---\nkind: fact\n---\nv1", "a conflict never writes");
        let f2 = write(&project, "a", "v2", false, Some(ms), true).unwrap();
        assert_eq!(f2.text, "v2");
        assert_eq!(write(&project, "a", "v3", false, None, false).unwrap().text, "v3", "no check: always written");
        fs::remove_file(note_path(t.path(), "a", false)).unwrap();
        assert_eq!(write(&project, "a", "v4", false, f2.modified_ms, true).unwrap_err().code(), "conflict", "deleted since read");

        // Inbox is a separate folder.
        let s = write(&project, "a", "suggestion", true, None, true).unwrap();
        assert!(s.inbox && PathBuf::from(&s.path).starts_with(folder(t.path(), true)));

        // Secrets are masked, sizes and names validated.
        let r = write(&project, "secret", "Use ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnop in CI", false, None, false).unwrap();
        assert!(!r.text.contains("abcdefghijklmnop"), "{}", r.text);
        assert_eq!(write(&project, "big", &"x".repeat(MAX_NOTE_BYTES + 1), false, None, false).unwrap_err().code(), "invalid");
        assert!(write(&project, "fits", &"x".repeat(MAX_NOTE_BYTES), false, None, false).is_ok());
        assert_eq!(write(&project, "../x", "x", false, None, false).unwrap_err().code(), "invalid");
        assert_eq!(write(&project, "nul", "x", false, None, false).unwrap_err().code(), "invalid");
        assert_eq!(write(&project, "z", "a\0b", false, None, false).unwrap_err().code(), "invalid");
        assert!(write("relative", "z", "x", false, None, false).is_err());
        assert!(tmp_files(&folder(t.path(), false)).is_empty());
    }

    #[test]
    fn write_refuses_folders_named_like_notes() {
        let t = tempfile::tempdir().unwrap();
        let project = dir_s(t.path());
        fs::create_dir_all(folder(t.path(), false).join("dir.md")).unwrap();
        assert_eq!(write(&project, "dir", "x", false, None, false).unwrap_err().code(), "invalid");
        assert_eq!(read(&project, "dir", false).unwrap_err().code(), "invalid");
    }

    #[test]
    fn approve_moves_and_confirms() {
        let t = tempfile::tempdir().unwrap();
        let project = dir_s(t.path());
        put(t.path(), true, "pnpm", "---\ntitle: Use pnpm\nkind: convention\nconfidence: suggested\n---\nNever npm install.\n");
        let slug = approve(&project, "pnpm").unwrap();
        assert_eq!(slug, "pnpm");
        assert!(!note_path(t.path(), "pnpm", true).exists());
        let text = fs::read_to_string(note_path(t.path(), "pnpm", false)).unwrap();
        let day = today();
        assert_eq!(text, format!("---\ntitle: Use pnpm\nkind: convention\nconfidence: confirmed\nupdated: {day}\ncreated: {day}\n---\nNever npm install.\n"));

        // A clash in notes/ gets a suffix; nothing is overwritten.
        put(t.path(), true, "pnpm", "Second suggestion");
        assert_eq!(approve(&project, "pnpm").unwrap(), "pnpm-2");
        put(t.path(), true, "pnpm", "Third");
        assert_eq!(approve(&project, "pnpm").unwrap(), "pnpm-3");
        assert!(fs::read_to_string(note_path(t.path(), "pnpm-2", false)).unwrap().contains("Second suggestion"));
        assert!(fs::read_to_string(note_path(t.path(), "pnpm", false)).unwrap().contains("Never npm install."));

        assert_eq!(approve(&project, "gone").unwrap_err().code(), "not_found");
        assert_eq!(approve(&project, "../pnpm").unwrap_err().code(), "invalid");
    }

    #[test]
    fn free_slug_respects_the_length_limit() {
        let t = tempfile::tempdir().unwrap();
        let long = "a".repeat(MAX_SLUG_LEN);
        fs::write(t.path().join(format!("{long}.md")), "x").unwrap();
        let s = free_slug(t.path(), &long);
        assert!(is_valid_slug(&s) && s.ends_with("-2") && s.len() == MAX_SLUG_LEN, "{s}");
    }

    #[test]
    fn delete_returns_the_text() {
        let t = tempfile::tempdir().unwrap();
        let project = dir_s(t.path());
        put(t.path(), false, "a", "remember me");
        assert_eq!(delete(&project, "a", false).unwrap(), "remember me");
        assert!(!note_path(t.path(), "a", false).exists());
        assert_eq!(delete(&project, "a", false).unwrap_err().code(), "not_found");
        put(t.path(), true, "s", "suggestion");
        assert_eq!(delete(&project, "s", true).unwrap(), "suggestion");
        assert_eq!(delete(&project, "a/b", true).unwrap_err().code(), "invalid");
        // Undo = write it back as a new file.
        write(&project, "a", "remember me", false, None, true).unwrap();
        assert_eq!(read(&project, "a", false).unwrap().text, "remember me");
    }

    #[test]
    fn tokenizer() {
        assert_eq!(tokenize("The CI-cache is in ~/.cache, see PR #42 (a b)"), vec!["ci", "cache", "cache", "see", "pr", "42"]);
        assert_eq!(tokenize("Größe Überprüfung"), vec!["größe", "überprüfung"]);
        assert!(tokenize("  ,, a ").is_empty());
    }

    #[test]
    fn search_ranks_title_and_tags_over_body_with_prefixes() {
        clear_cache();
        let t = tempfile::tempdir().unwrap();
        let project = dir_s(t.path());
        assert!(search(&project, "anything").unwrap().is_empty(), "no brain");
        put(t.path(), false, "keychain", &note("Refresh tokens in the keychain", "decision", "auth, security", "Never write tokens to disk."));
        put(t.path(), false, "ci-cache", &note("CI cache key", "gotcha", "ci", "The cache key must include the lock file hash."));
        put(t.path(), false, "body-only", &note("Release steps", "howto", "release", "Bump the version. Tokens for the store live in the CI secrets."));
        put(t.path(), true, "auth-idea", "---\ntitle: Auth middleware order\nkind: convention\ntags: [auth]\n---\nAuth runs before logging.");

        let hits = search(&project, "tokens").unwrap();
        let slugs: Vec<&str> = hits.iter().map(|h| h.slug.as_str()).collect();
        assert_eq!(slugs[0], "keychain", "title match first: {hits:?}");
        assert!(slugs.contains(&"body-only"));
        assert!(!slugs.contains(&"ci-cache"));
        assert!(hits.windows(2).all(|w| w[0].score >= w[1].score));

        // Prefix: "auth" matches the tag "auth", "secur" matches "security".
        let hits = search(&project, "secur").unwrap();
        assert_eq!(hits.iter().map(|h| h.slug.as_str()).collect::<Vec<_>>(), vec!["keychain"]);
        let hits = search(&project, "auth").unwrap();
        assert!(hits.iter().any(|h| h.slug == "auth-idea" && h.inbox), "inbox suggestions are searchable: {hits:?}");
        assert!(hits.iter().any(|h| h.slug == "keychain"));

        // More matching terms rank higher; snippets come from the matching body line.
        let hits = search(&project, "cache lock").unwrap();
        assert_eq!(hits[0].slug, "ci-cache");
        assert_eq!(hits[0].snippet, "The cache key must include the lock file hash.");
        assert!(search(&project, "  ").unwrap().is_empty());
        assert!(search(&project, "zzzz").unwrap().is_empty());
        assert!(search(&project, &"q".repeat(10_000)).is_ok(), "long queries are cut");
    }

    #[test]
    fn index_is_grouped_deterministic_and_written_only_on_change() {
        clear_cache();
        let t = tempfile::tempdir().unwrap();
        assert!(!regenerate_index(t.path()).unwrap(), "no brain folder: nothing written");
        assert!(!brain_path(t.path()).exists());

        put(t.path(), false, "b", &note("Beta [draft]", "gotcha", "ci", "x"));
        put(t.path(), false, "a", &note("Alpha", "decision", "", "y"));
        put(t.path(), false, "c", &note("Gamma", "decision", "auth, ci", "z").replace("confidence: confirmed", "supersedes: a"));
        put(t.path(), true, "s", "---\ntitle: Suggested one\nkind: howto\n---\nw");
        assert!(regenerate_index(t.path()).unwrap());
        let path = brain_path(t.path()).join(INDEX_FILE);
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.starts_with("<!-- Generated by Gridkeeper"), "{text}");
        assert!(text.contains("Read me first."));
        assert!(text.contains("2 memories · 1 suggestion waiting in inbox/"), "{text}");
        let dec = text.find("## Decisions").unwrap();
        let got = text.find("## Gotchas").unwrap();
        assert!(dec < got, "kind order");
        assert!(text.contains("- [Gamma](notes/c.md) — decision · auth, ci · 2026-10-18"));
        assert!(text.contains("- [Beta draft](notes/b.md) — gotcha · ci · 2026-10-18"), "brackets dropped from link text: {text}");
        assert!(text.contains("## Superseded"));
        assert!(text.contains("- [Alpha](notes/a.md) — decision · 2026-10-18 — superseded by [c](notes/c.md)"), "{text}");
        assert!(text.contains("## Inbox (suggested, not approved yet)\n\n- [Suggested one](inbox/s.md) — howto"), "{text}");
        assert!(text.contains("## Note format"));
        assert!(!text.contains('\r'));

        // Same notes: not rewritten (mtime unchanged).
        let f = fs::File::options().write(true).open(&path).unwrap();
        let old = std::time::SystemTime::now() - Duration::from_secs(100);
        f.set_modified(old).unwrap();
        drop(f);
        assert!(!regenerate_index(t.path()).unwrap());
        assert_eq!(fs::metadata(&path).unwrap().modified().unwrap(), old);
        // A changed note: rewritten.
        put(t.path(), false, "a", &note("Alpha renamed", "decision", "", "y"));
        assert!(regenerate_index(t.path()).unwrap());
        assert!(fs::read_to_string(&path).unwrap().contains("[Alpha renamed]"));
        assert!(tmp_files(&brain_path(t.path())).is_empty());

        let empty = render_index(&[], &[]);
        assert!(empty.contains("0 memories · 0 suggestions waiting in inbox/") && empty.contains("No memories yet."));
        assert_eq!(render_index(&[], &[]), empty, "deterministic");
    }

    #[test]
    fn schedule_index_writes_after_the_debounce() {
        let t = tempfile::tempdir().unwrap();
        let project = dir_s(t.path());
        write(&project, "a", "---\ntitle: Scheduled\n---\nx", false, None, false).unwrap();
        let path = brain_path(t.path()).join(INDEX_FILE);
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline && !fs::read_to_string(&path).is_ok_and(|s| s.contains("[Scheduled]")) {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(fs::read_to_string(&path).unwrap().contains("[Scheduled]"));
    }

    #[test]
    fn share_block_round_trip() {
        let t = tempfile::tempdir().unwrap();
        let project = dir_s(t.path());
        assert!(!is_shared(t.path()));
        let r = set_shared(&project, true).unwrap();
        assert!(r.shared && is_shared(t.path()));
        let gi = fs::read_to_string(gitignore_path(t.path())).unwrap();
        assert!(gi.starts_with("*\n# >>> gridkeeper brain"), "{gi}");
        assert!(gi.contains("\n!brain/notes/*.md\n!brain/INDEX.md\n# <<< gridkeeper brain\n"), "{gi}");
        assert_eq!(set_shared(&project, true).unwrap().shared, true);
        assert_eq!(fs::read_to_string(gitignore_path(t.path())).unwrap(), gi, "idempotent");
        set_shared(&project, false).unwrap();
        assert_eq!(fs::read_to_string(gitignore_path(t.path())).unwrap(), "*\n");
        assert!(!is_shared(t.path()));

        // A user's own lines survive both directions (CRLF kept).
        fs::write(gitignore_path(t.path()), "*\r\n!keep.md\r\n").unwrap();
        set_shared(&project, true).unwrap();
        let gi = fs::read_to_string(gitignore_path(t.path())).unwrap();
        assert!(gi.starts_with("*\r\n!keep.md\r\n# >>> gridkeeper brain") && gi.ends_with("# <<< gridkeeper brain\r\n"), "{gi:?}");
        set_shared(&project, false).unwrap();
        assert_eq!(fs::read_to_string(gitignore_path(t.path())).unwrap(), "*\r\n!keep.md\r\n");
        assert!(set_shared("relative", true).is_err());
    }

    /// The shared .gitignore really makes git see notes and INDEX.md and nothing else (skipped without git).
    #[test]
    fn share_block_works_with_git() {
        let t = tempfile::tempdir().unwrap();
        let run = |args: &[&str]| std::process::Command::new("git").args(args).current_dir(t.path()).output();
        let Ok(init) = run(&["init", "-q"]) else { return };
        if !init.status.success() {
            return;
        }
        let project = dir_s(t.path());
        crate::mission::write(&project, "# Mission: x\n", None, false).unwrap();
        put(t.path(), false, "a", "note");
        put(t.path(), true, "b", "suggestion");
        let index = brain_path(t.path()).join(INDEX_FILE);
        fs::write(&index, "index").unwrap();
        let ignored = |rel: &str| run(&["check-ignore", "-q", rel]).unwrap().status.code() == Some(0);
        assert!(ignored(".gridkeeper/brain/notes/a.md"), "local by default");
        set_shared(&project, true).unwrap();
        assert!(!ignored(".gridkeeper/brain/notes/a.md"));
        assert!(!ignored(".gridkeeper/brain/INDEX.md"));
        assert!(!ignored(".gridkeeper/.gitignore"));
        assert!(ignored(".gridkeeper/brain/inbox/b.md"), "the inbox stays local");
        assert!(ignored(".gridkeeper/mission.md"));
        assert!(ignored(".gridkeeper/team.md"));
        assert!(ignored(".gridkeeper/brain/notes/.a.md.1.0.tmp"));
        set_shared(&project, false).unwrap();
        assert!(ignored(".gridkeeper/brain/notes/a.md"));
    }

    #[cfg(unix)]
    #[test]
    fn links_are_not_followed() {
        let t = tempfile::tempdir().unwrap();
        let project = dir_s(t.path());
        let outside = t.path().join("outside.md");
        fs::write(&outside, "secret outside").unwrap();
        fs::create_dir_all(folder(t.path(), false)).unwrap();
        std::os::unix::fs::symlink(&outside, note_path(t.path(), "link", false)).unwrap();
        assert!(list(&project).unwrap().notes.is_empty());
        assert_eq!(read(&project, "link", false).unwrap_err().code(), "invalid");
        assert_eq!(write(&project, "link", "x", false, None, false).unwrap_err().code(), "invalid");
        assert_eq!(fs::read_to_string(&outside).unwrap(), "secret outside");
    }
}
