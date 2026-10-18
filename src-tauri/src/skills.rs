//! Agent Skills: find skill repositories on GitHub, review one skill, install it into a project.
//!
//! An Agent Skill is a folder with a `SKILL.md` (YAML frontmatter `name` / `description`) and optional
//! `references/`, `scripts/`, `assets/`. Claude Code reads project skills from `.claude/skills/<name>/`,
//! Codex and other Agent Skills hosts from `.agents/skills/<name>/`, so one install upgrades every agent
//! of a workspace.
//!
//! Network (user-initiated only: the panel opening, a search, a click; never in the background. The
//! second exception to ADR-018 after the browser-pane probe):
//! - [`search`]: GitHub repository search (`api.github.com`, unauthenticated, 10 requests/minute).
//! - [`inspect`]: repository metadata, ref → commit SHA, recursive tree, raw `SKILL.md` files.
//! - [`read_file`]: one raw file of a skill at a pinned commit (review before install).
//! - [`install`]: every file of one skill folder at a pinned commit (`raw.githubusercontent.com`).
//! - [`check_update`]: the default branch's current commit + tree; compares the skill folder's tree SHA.
//!
//! Every request goes through the system `curl.exe` (an argument array, never a shell; `-q` ignores
//! `.curlrc`; https only, to the two GitHub hosts; timeouts; output capped) behind the [`Fetcher`]
//! trait, so tests inject canned responses. Results are cached in memory for [`CACHE_TTL`].
//!
//! Files: a skill installs into `<project>/.claude/skills/<name>/` and/or `<project>/.agents/skills/<name>/`
//! (visible to git on purpose: the user decides whether to commit it) with a `.gridkeeper-skill.json`
//! provenance file, and is recorded in `<project>/.gridkeeper/skills.lock.json` (`.gridkeeper/` ignores
//! itself, like the mission file). Writes are staged in `.gridkeeper/tmp/` and renamed into place.
//! Never written: agent homes (`~/.claude`, `~/.codex`, `CLAUDE_CONFIG_DIR`, … and the user folder
//! itself, whose `.claude/skills` *is* Claude's user-level folder), anything reached through a junction
//! or symbolic link, paths with `..` or names Windows cannot hold. Nothing downloaded is ever executed.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use regex::Regex;
use serde::Deserialize;
use serde::de::DeserializeOwned;
use tauri::Url;

use crate::adapters::{discovery, process};
use crate::mission;
use crate::types::*;

pub const API_BASE: &str = "https://api.github.com";
pub const RAW_BASE: &str = "https://raw.githubusercontent.com";
/// GitHub topics that mark skill repositories (Trending / Top tabs, default search filter).
pub const SKILL_TOPICS: &[&str] = &["agent-skills", "claude-code-skills", "claude-skills", "agent-skill", "claude-code-plugin"];
/// Install targets, relative to the project folder.
pub const TARGET_DIRS: &[&str] = &[".claude/skills", ".agents/skills"];
pub const SKILL_FILE: &str = "SKILL.md";
pub const PROVENANCE_FILE: &str = ".gridkeeper-skill.json";
pub const LOCK_FILE: &str = "skills.lock.json";
pub const MAX_FILES: usize = 200;
pub const MAX_TOTAL_BYTES: u64 = 5 * 1024 * 1024;
pub const MAX_FILE_BYTES: u64 = 1024 * 1024;
/// Deepest folder a SKILL.md may sit in (`plugins/<p>/skills/<s>/SKILL.md` is 4).
pub const MAX_SKILL_DEPTH: usize = 4;
/// SKILL.md files fetched per inspect; further skills show their folder name until opened.
pub const MAX_SKILL_MD_FETCHES: usize = 60;
pub const CACHE_TTL: Duration = Duration::from_secs(600);
const MAX_SKILLS_LISTED: usize = 300;
const MAX_TEXT: usize = 256 * 1024;
const MAX_TREE_BYTES: usize = 16 * 1024 * 1024;
const MAX_META_BYTES: usize = 4 * 1024 * 1024;
const HEADER_ALLOWANCE: usize = 64 * 1024;
const PROCESS_TIMEOUT: Duration = Duration::from_secs(25);
const PER_PAGE: u32 = 30;
/// GitHub serves at most 1000 search results.
const MAX_PAGE: u32 = 33;
const PARALLEL_FETCHES: usize = 6;
const MAX_QUERY_CHARS: usize = 200;
const GITIGNORE: &str = "*\n";
const API_ACCEPT: &str = "application/vnd.github+json";
const SHA_ACCEPT: &str = "application/vnd.github.sha";
const RAW_ACCEPT: &str = "*/*";
/// File extensions shown with an "executable" warning in the review.
pub const EXECUTABLE_EXTS: &[&str] = &[
    "ps1", "psm1", "psd1", "sh", "bash", "zsh", "bat", "cmd", "exe", "com", "dll", "msi", "scr", "vbs", "js", "mjs",
    "cjs", "ts", "py", "rb", "pl", "php", "jar", "lua",
];

// ---------------------------------------------------------------------------
// HTTP through curl.exe
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default)]
pub struct HttpResponse {
    pub status: u16,
    /// Lower-cased names.
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl HttpResponse {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().rev().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }

    fn is_success(&self) -> bool {
        (200..300).contains(&self.status)
    }
}

/// One GET request. Injected so tests never touch the network.
pub trait Fetcher: Send + Sync {
    /// GET `url` with `Accept: accept`; a body larger than `cap` bytes is an error.
    fn get(&self, url: &str, accept: &str, cap: usize) -> AppResult<HttpResponse>;
}

/// The real fetcher: the system `curl.exe`.
pub struct CurlFetcher;

fn curl_exe() -> Option<PathBuf> {
    // Prefer the copy shipped with Windows (System32) over whatever is first on PATH.
    let sys = std::env::var_os("SystemRoot").map(|r| PathBuf::from(r).join("System32").join("curl.exe"));
    sys.filter(|p| p.is_file()).or_else(|| which::which("curl.exe").ok())
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

/// The final response of `curl -i -L` output. Header blocks of redirects, `1xx` and a proxy's
/// `Connection established` are skipped; parsing stops at the first final status, so a body that
/// itself starts with `HTTP/` is never mistaken for headers.
pub fn parse_curl_output(raw: &[u8]) -> Option<HttpResponse> {
    let mut rest = raw;
    let mut last: Option<(u16, Vec<(String, String)>)> = None;
    while rest.starts_with(b"HTTP/") {
        let end = find(rest, b"\r\n\r\n").map(|i| (i, 4)).or_else(|| find(rest, b"\n\n").map(|i| (i, 2)));
        let (head, after) = match end {
            Some((i, n)) => (&rest[..i], &rest[i + n..]),
            None => (rest, &rest[rest.len()..]),
        };
        let text = String::from_utf8_lossy(head);
        let mut lines = text.lines();
        let status_line = lines.next().unwrap_or("");
        let mut parts = status_line.splitn(3, ' ');
        let _version = parts.next();
        let status: u16 = parts.next().and_then(|s| s.trim().parse().ok()).unwrap_or(0);
        let reason = parts.next().unwrap_or("").to_ascii_lowercase();
        let headers = lines
            .filter_map(|l| l.split_once(':').map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string())))
            .collect();
        last = Some((status, headers));
        rest = after;
        let interim = (100..200).contains(&status)
            || (300..400).contains(&status)
            || (status == 200 && reason.contains("connection established"));
        if !interim {
            break;
        }
    }
    let (status, headers) = last?;
    Some(HttpResponse { status, headers, body: rest.to_vec() })
}

fn curl_error(code: Option<i32>, stderr: &[u8]) -> String {
    match code {
        Some(5) | Some(6) => "Could not reach GitHub (host not found: are you offline?)".into(),
        Some(7) => "Could not connect to GitHub".into(),
        Some(28) => "GitHub did not answer in time".into(),
        Some(35) | Some(60) => "TLS error while talking to GitHub".into(),
        _ => format!("Request failed: {}", process::first_line(stderr).unwrap_or_else(|| "no response".into())),
    }
}

fn allowed_url(url: &str) -> bool {
    url.starts_with("https://api.github.com/") || url.starts_with("https://raw.githubusercontent.com/")
}

impl Fetcher for CurlFetcher {
    fn get(&self, url: &str, accept: &str, cap: usize) -> AppResult<HttpResponse> {
        // Every URL is built by this module; the check keeps it that way. It also guarantees the URL
        // starts with "https://", so curl can never read it as an option.
        if !allowed_url(url) || url.chars().any(|c| c.is_whitespace() || c.is_control()) {
            return Err(AppError::Invalid("Only api.github.com and raw.githubusercontent.com are fetched".into()));
        }
        let curl = curl_exe().ok_or_else(|| AppError::MissingExecutable("curl.exe".into()))?;
        let accept_header = format!("Accept: {accept}");
        let mut cmd = process::hidden_command(curl);
        // `-q` must come first: it disables ~/.curlrc.
        cmd.args([
            "-q", "-sS", "-i", "-L", "--max-redirs", "3", "--connect-timeout", "8", "--max-time", "15",
            "--proto", "=https", "--proto-redir", "=https",
            "-H", &accept_header, "-H", "User-Agent: Gridkeeper",
        ]);
        if url.starts_with(API_BASE) {
            cmd.args(["-H", "X-GitHub-Api-Version: 2022-11-28"]);
        }
        cmd.arg(url);
        let out = match process::run_capped(cmd, PROCESS_TIMEOUT, cap.saturating_add(HEADER_ALLOWANCE)) {
            Ok(o) => o,
            Err(e) if e.kind() == io::ErrorKind::TimedOut => {
                return Err(AppError::Other("GitHub did not answer in time".into()));
            }
            Err(e) => return Err(AppError::Other(format!("Could not run curl.exe: {e}"))),
        };
        if out.truncated {
            return Err(too_large_response(cap));
        }
        match parse_curl_output(&out.stdout) {
            Some(r) if r.body.len() > cap => Err(too_large_response(cap)),
            Some(r) => Ok(r),
            None => Err(AppError::Other(curl_error(out.status.and_then(|s| s.code()), &out.stderr))),
        }
    }
}

fn too_large_response(cap: usize) -> AppError {
    AppError::Invalid(format!("The response is larger than {} KiB", cap / 1024))
}

// ---------------------------------------------------------------------------
// GitHub API helpers
// ---------------------------------------------------------------------------

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Control characters removed, whitespace collapsed, at most `max` characters.
fn clean_text(s: &str, max: usize) -> String {
    let t: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    t.chars().filter(|c| !c.is_control()).take(max).collect()
}

enum Fail {
    /// Epoch seconds when the limit resets, when GitHub said so.
    RateLimited(Option<u64>),
    App(AppError),
}

impl From<AppError> for Fail {
    fn from(e: AppError) -> Self {
        Fail::App(e)
    }
}

fn github_message(body: &[u8]) -> Option<String> {
    #[derive(Deserialize)]
    struct Msg {
        message: Option<String>,
    }
    serde_json::from_slice::<Msg>(body).ok()?.message.map(|m| clean_text(&m, 300))
}

/// `Some(reset)` when `resp` is GitHub's rate limit (primary: 403/429 with no requests remaining;
/// secondary: a "rate limit" message or `retry-after`).
pub fn rate_limit_reset(resp: &HttpResponse, now: u64) -> Option<Option<u64>> {
    if resp.status != 403 && resp.status != 429 {
        return None;
    }
    let exhausted = resp.header("x-ratelimit-remaining") == Some("0");
    let retry_after = resp.header("retry-after").and_then(|v| v.trim().parse::<u64>().ok());
    let says_so = github_message(&resp.body).is_some_and(|m| m.to_ascii_lowercase().contains("rate limit"));
    if !(exhausted || says_so || retry_after.is_some() || resp.status == 429) {
        return None;
    }
    let reset = resp
        .header("x-ratelimit-reset")
        .and_then(|v| v.trim().parse::<u64>().ok())
        .filter(|_| exhausted)
        .or_else(|| retry_after.map(|s| now + s));
    Some(reset)
}

fn rate_limit_error(reset: Option<u64>, now: u64) -> AppError {
    let when = match reset {
        Some(r) if r > now => {
            let mins = (r - now).div_ceil(60);
            format!(" Try again in about {mins} minute{}.", if mins == 1 { "" } else { "s" })
        }
        _ => " Try again in a few minutes.".into(),
    };
    AppError::Other(format!("GitHub's limit for requests without an account is used up (60 per hour).{when}"))
}

fn into_app(f: Fail) -> AppError {
    match f {
        Fail::RateLimited(reset) => rate_limit_error(reset, now_secs()),
        Fail::App(e) => e,
    }
}

fn api_get(f: &dyn Fetcher, url: &str, accept: &str, cap: usize, what: &str) -> Result<HttpResponse, Fail> {
    let resp = f.get(url, accept, cap)?;
    if resp.is_success() {
        return Ok(resp);
    }
    if let Some(reset) = rate_limit_reset(&resp, now_secs()) {
        return Err(Fail::RateLimited(reset));
    }
    let msg = github_message(&resp.body);
    Err(Fail::App(match resp.status {
        404 => AppError::NotFound(format!("{what} (private repositories are not supported)")),
        409 => AppError::Invalid(format!("{what}: the repository is empty")),
        422 => AppError::Invalid(msg.unwrap_or_else(|| "GitHub rejected the request".into())),
        s => AppError::Other(format!("GitHub answered {s}{}", msg.map(|m| format!(": {m}")).unwrap_or_default())),
    }))
}

fn api_json<T: DeserializeOwned>(f: &dyn Fetcher, url: &str, cap: usize, what: &str) -> Result<T, Fail> {
    let resp = api_get(f, url, API_ACCEPT, cap, what)?;
    serde_json::from_slice(&resp.body).map_err(|e| Fail::App(AppError::Other(format!("Unexpected answer from GitHub: {e}"))))
}

/// A small in-memory cache with a time-to-live (search pages, inspected repositories).
struct TtlCache<T> {
    entries: Mutex<Vec<(String, Instant, T)>>,
    cap: usize,
}

impl<T: Clone> TtlCache<T> {
    fn new(cap: usize) -> Self {
        Self { entries: Mutex::new(Vec::new()), cap }
    }

    fn get(&self, key: &str) -> Option<T> {
        let mut e = self.entries.lock();
        e.retain(|(_, at, _)| at.elapsed() < CACHE_TTL);
        e.iter().find(|(k, _, _)| k == key).map(|(_, _, v)| v.clone())
    }

    fn put(&self, key: String, value: T) {
        let mut e = self.entries.lock();
        e.retain(|(k, _, _)| *k != key);
        e.push((key, Instant::now(), value));
        while e.len() > self.cap {
            e.remove(0);
        }
    }
}

static SEARCH_CACHE: Lazy<TtlCache<SkillRepoPage>> = Lazy::new(|| TtlCache::new(48));
static INSPECT_CACHE: Lazy<TtlCache<RepoSkills>> = Lazy::new(|| TtlCache::new(12));
/// Trees by commit (immutable), so install / update checks right after an inspect cost no API call.
static TREE_CACHE: Lazy<TtlCache<Arc<RepoTree>>> = Lazy::new(|| TtlCache::new(4));
/// Trees with more entries are not cached (memory on a busy machine matters more than one API call).
const MAX_CACHED_TREE_ENTRIES: usize = 20_000;

/// Run `f` over `items` on up to `workers` threads; results keep the input order.
fn parallel_map<T: Sync, R: Send>(items: &[T], workers: usize, f: impl Fn(&T) -> R + Sync) -> Vec<R> {
    let next = AtomicUsize::new(0);
    let slots: Vec<Mutex<Option<R>>> = items.iter().map(|_| Mutex::new(None)).collect();
    std::thread::scope(|s| {
        for _ in 0..workers.clamp(1, items.len().max(1)) {
            s.spawn(|| {
                loop {
                    let i = next.fetch_add(1, Ordering::SeqCst);
                    if i >= items.len() {
                        break;
                    }
                    let r = f(&items[i]);
                    *slots[i].lock() = Some(r);
                }
            });
        }
    });
    slots.into_iter().map(|m| m.into_inner().expect("every slot is filled")).collect()
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

static REPO_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$").expect("repo regex"));
static SHA_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[0-9a-f]{40}$").expect("sha regex"));
static NAME_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$").expect("name regex"));

/// `owner/repo` → (owner, repo).
pub fn validate_repo(repo: &str) -> AppResult<(&str, &str)> {
    let bad = || AppError::Invalid(format!("Not a GitHub repository (owner/name): {repo:?}"));
    if repo.len() > 140 || !REPO_RE.is_match(repo) {
        return Err(bad());
    }
    let (owner, name) = repo.split_once('/').ok_or_else(bad)?;
    if name == "." || name == ".." || name.ends_with(".git") {
        return Err(bad());
    }
    Ok((owner, name))
}

/// A branch / tag name or commit SHA: `[A-Za-z0-9._/-]`, no `..`, `//`, leading `-` / `/` / `.`.
pub fn validate_ref(r: &str) -> AppResult<()> {
    let ok = !r.is_empty()
        && r.len() <= 200
        && r.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '/'))
        && !r.starts_with(['-', '/', '.'])
        && !r.ends_with(['/', '.'])
        && !r.contains("..")
        && !r.contains("//")
        && !r.contains("/.");
    if ok { Ok(()) } else { Err(AppError::Invalid(format!("Not a valid branch, tag or commit: {r:?}"))) }
}

pub fn validate_sha(sha: &str) -> AppResult<()> {
    if SHA_RE.is_match(sha) { Ok(()) } else { Err(AppError::Invalid(format!("Not a full commit SHA: {sha:?}"))) }
}

const RESERVED_NAMES: &[&str] = &[
    "con", "prn", "aux", "nul", "conin$", "conout$", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
    "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/// Why Windows cannot hold `seg` as a file or folder name (or why it is unsafe), if so.
pub fn segment_problem(seg: &str) -> Option<&'static str> {
    if seg.is_empty() {
        return Some("empty name");
    }
    if seg == "." || seg == ".." {
        return Some("relative path segment");
    }
    if seg.len() > 255 {
        return Some("name too long");
    }
    if seg.chars().any(|c| c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*' | '\\' | '/')) {
        return Some("character Windows does not allow in names");
    }
    if seg.ends_with('.') || seg.ends_with(' ') {
        return Some("name ends with a dot or a space");
    }
    let stem = seg.split('.').next().unwrap_or("").trim_end().to_ascii_lowercase();
    if RESERVED_NAMES.contains(&stem.as_str()) {
        return Some("reserved Windows device name");
    }
    None
}

/// A relative, forward-slash path that is safe to create under a folder on Windows.
pub fn validate_rel_path(path: &str) -> Result<(), String> {
    if path.is_empty() {
        return Err("empty path".into());
    }
    if path.len() > 400 {
        return Err(format!("{path}: path too long"));
    }
    if path.starts_with('/') || path.contains('\\') || path.contains(':') {
        return Err(format!("{path}: absolute or not a plain relative path"));
    }
    for seg in path.split('/') {
        if let Some(why) = segment_problem(seg) {
            return Err(format!("{path}: {why}"));
        }
    }
    Ok(())
}

/// A skill folder inside a repository: `""` (the repository root) or a safe relative path.
pub fn normalize_skill_path(path: &str) -> AppResult<String> {
    let p = path.trim().trim_matches('/');
    if p.is_empty() {
        return Ok(String::new());
    }
    validate_rel_path(p).map_err(|e| AppError::Invalid(format!("Not a valid skill folder: {e}")))?;
    Ok(p.to_string())
}

/// Requested install targets: non-empty, each one of [`TARGET_DIRS`]; duplicates removed.
pub fn validate_targets(targets: &[String]) -> AppResult<Vec<&'static str>> {
    let mut out: Vec<&'static str> = Vec::new();
    for t in targets {
        let norm = t.trim().replace('\\', "/");
        let norm = norm.trim_end_matches('/');
        let found = TARGET_DIRS
            .iter()
            .find(|d| **d == norm)
            .ok_or_else(|| AppError::Invalid(format!("Unknown install target {t:?} (use .claude/skills or .agents/skills)")))?;
        if !out.contains(found) {
            out.push(found);
        }
    }
    if out.is_empty() {
        return Err(AppError::Invalid("Choose where to install the skill".into()));
    }
    Ok(out)
}

pub fn is_executable_name(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or(path);
    match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => EXECUTABLE_EXTS.contains(&ext.to_ascii_lowercase().as_str()),
        _ => false,
    }
}

fn basename(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

fn join_path(dir: &str, rel: &str) -> String {
    if dir.is_empty() { rel.to_string() } else { format!("{dir}/{rel}") }
}

/// `rel` (forward slashes, already validated) under `base`.
fn join_rel(base: &Path, rel: &str) -> PathBuf {
    rel.split('/').filter(|s| !s.is_empty()).fold(base.to_path_buf(), |p, s| p.join(s))
}

fn sanitize_name(s: &str) -> String {
    let mut out = String::new();
    for c in s.trim().to_lowercase().chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            out.push(c);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    let t: String = out.trim_matches('-').chars().take(64).collect();
    t.trim_matches('-').to_string()
}

/// Folder name of an installed skill: the frontmatter `name` when it is a valid skill name
/// (lowercase letters, digits, hyphens, at most 64), else the skill's folder name, else a sanitized
/// form of either, else the repository name.
pub fn install_name(front: Option<&str>, skill_dir: &str, repo: &str) -> String {
    let repo_name = repo.split_once('/').map(|(_, n)| n).unwrap_or(repo);
    let own: Vec<&str> = [front, (!skill_dir.is_empty()).then(|| basename(skill_dir))].into_iter().flatten().collect();
    let usable = |c: &str| NAME_RE.is_match(c) && segment_problem(c).is_none();
    own.iter()
        .map(|c| c.to_string())
        .chain(own.iter().map(|c| sanitize_name(c)))
        .chain([repo_name.to_string(), sanitize_name(repo_name)])
        .find(|c| usable(c))
        .unwrap_or_else(|| "skill".into())
}

// ---------------------------------------------------------------------------
// SKILL.md frontmatter
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Frontmatter {
    pub name: Option<String>,
    pub description: Option<String>,
}

fn unquote_double(s: &str) -> String {
    let mut out = String::new();
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        match c {
            '"' => break,
            '\\' => match chars.next() {
                Some('n') => out.push('\n'),
                Some('t') => out.push('\t'),
                Some(other) => out.push(other),
                None => {}
            },
            c => out.push(c),
        }
    }
    out
}

fn unquote_single(s: &str) -> String {
    let mut out = String::new();
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\'' {
            if chars.peek() == Some(&'\'') {
                chars.next();
                out.push('\'');
            } else {
                break;
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// `|`, `>`, with optional chomping / indentation indicators (`|-`, `>+`, `>2`).
fn block_style(v: &str) -> Option<char> {
    let v = v.split(" #").next().unwrap_or(v).trim();
    let mut chars = v.chars();
    let first = chars.next()?;
    if (first == '|' || first == '>') && chars.all(|c| matches!(c, '-' | '+' | '1'..='9')) { Some(first) } else { None }
}

fn block_scalar(lines: &[&str], style: char) -> String {
    let indent = lines
        .iter()
        .filter(|l| !l.trim().is_empty())
        .map(|l| l.len() - l.trim_start().len())
        .min()
        .unwrap_or(0);
    let body: Vec<&str> = lines.iter().map(|l| if l.len() >= indent { &l[indent..] } else { l.trim_start() }).collect();
    if style == '|' {
        return body.join("\n").trim_end().to_string();
    }
    // Folded: lines join with spaces, blank lines become newlines.
    let mut out = String::new();
    for l in body {
        if l.trim().is_empty() {
            out.push('\n');
        } else {
            if !out.is_empty() && !out.ends_with('\n') {
                out.push(' ');
            }
            out.push_str(l.trim_end());
        }
    }
    out.trim().to_string()
}

/// Top-level `key: value` pairs of a small YAML mapping (plain, quoted and block scalars).
fn parse_simple_yaml(lines: &[&str]) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        i += 1;
        if line.trim().is_empty() || line.trim_start().starts_with('#') || line.starts_with([' ', '\t']) {
            continue;
        }
        let Some((key, rest)) = line.split_once(':') else { continue };
        let key = key.trim().trim_matches(['"', '\'']).to_string();
        let rest = rest.trim();
        let mut cont: Vec<&str> = Vec::new();
        while i < lines.len() && (lines[i].starts_with([' ', '\t']) || lines[i].trim().is_empty()) {
            cont.push(lines[i]);
            i += 1;
        }
        let value = if let Some(style) = block_style(rest) {
            block_scalar(&cont, style)
        } else {
            let joined = std::iter::once(rest)
                .chain(cont.iter().map(|l| l.trim()))
                .filter(|l| !l.is_empty())
                .collect::<Vec<_>>()
                .join(" ");
            if let Some(q) = joined.strip_prefix('"') {
                unquote_double(q)
            } else if let Some(q) = joined.strip_prefix('\'') {
                unquote_single(q)
            } else {
                joined.split(" #").next().unwrap_or("").trim().to_string()
            }
        };
        out.push((key, value));
    }
    out
}

/// `name` and `description` from a SKILL.md's YAML frontmatter (`---` … `---` at the top).
pub fn parse_frontmatter(text: &str) -> Frontmatter {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut lines = text.lines();
    if lines.next().map(str::trim_end) != Some("---") {
        return Frontmatter::default();
    }
    let mut body = Vec::new();
    let mut closed = false;
    for l in lines {
        let t = l.trim_end();
        if t == "---" || t == "..." {
            closed = true;
            break;
        }
        body.push(l);
    }
    if !closed {
        return Frontmatter::default();
    }
    let map = parse_simple_yaml(&body);
    let get = |k: &str| map.iter().find(|(key, _)| key == k).map(|(_, v)| v.clone());
    Frontmatter {
        name: get("name").map(|n| clean_text(&n, 120)).filter(|n| !n.is_empty()),
        description: get("description").map(|d| d.trim().chars().filter(|c| *c == '\n' || !c.is_control()).take(2000).collect::<String>()).filter(|d| !d.is_empty()),
    }
}

// ---------------------------------------------------------------------------
// Repository tree → skills
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntryKind {
    Blob,
    Tree,
    Link,
    Submodule,
}

#[derive(Debug, Clone)]
pub struct TreeEntry {
    pub path: String,
    pub kind: EntryKind,
    pub sha: String,
    pub size: u64,
    /// Git mode 100755.
    pub exec_bit: bool,
}

#[derive(Debug, Clone)]
pub struct RepoTree {
    /// SHA of the root tree.
    pub sha: String,
    pub entries: Vec<TreeEntry>,
    /// GitHub cut the listing (more than 100,000 entries or 7 MB).
    pub truncated: bool,
}

pub fn parse_tree(json: &[u8]) -> AppResult<RepoTree> {
    #[derive(Deserialize)]
    struct GhTree {
        sha: String,
        #[serde(default)]
        tree: Vec<GhEntry>,
        #[serde(default)]
        truncated: bool,
    }
    #[derive(Deserialize)]
    struct GhEntry {
        path: String,
        #[serde(default)]
        mode: String,
        #[serde(rename = "type")]
        kind: String,
        #[serde(default)]
        sha: String,
        #[serde(default)]
        size: Option<u64>,
    }
    let t: GhTree = serde_json::from_slice(json).map_err(|e| AppError::Other(format!("Unexpected tree from GitHub: {e}")))?;
    let entries = t
        .tree
        .into_iter()
        .map(|e| TreeEntry {
            kind: match (e.kind.as_str(), e.mode.as_str()) {
                (_, "120000") => EntryKind::Link,
                ("commit", _) => EntryKind::Submodule,
                ("tree", _) => EntryKind::Tree,
                _ => EntryKind::Blob,
            },
            exec_bit: e.mode == "100755",
            path: e.path,
            sha: e.sha,
            size: e.size.unwrap_or(0),
        })
        .collect();
    Ok(RepoTree { sha: t.sha, entries, truncated: t.truncated })
}

#[derive(Debug, Clone)]
pub struct FoundSkill {
    /// Folder in the repository ("" = root).
    pub dir: String,
    pub tree_sha: String,
    /// Paths relative to `dir`; SKILL.md first.
    pub files: Vec<SkillFile>,
    pub total_bytes: u64,
    pub has_scripts: bool,
    /// Why this skill cannot be installed (limits, unsafe names), if so.
    pub blocked: Option<String>,
    /// Symbolic links and submodules inside the folder (never installed).
    pub skipped: Vec<String>,
}

fn parent_dir(path: &str) -> &str {
    path.rsplit_once('/').map(|(d, _)| d).unwrap_or("")
}

fn dir_depth(dir: &str) -> usize {
    if dir.is_empty() { 0 } else { dir.split('/').count() }
}

fn ignored_segment(seg: &str) -> bool {
    seg == "node_modules" || seg == ".git"
}

/// Every skill in a repository tree: each folder (at most [`MAX_SKILL_DEPTH`] deep) holding a
/// `SKILL.md`. A file belongs to the deepest skill folder containing it, so a skill nested in
/// another (or every skill under a root-level one) is listed on its own, not twice.
pub fn discover_skills(tree: &RepoTree) -> Vec<FoundSkill> {
    let mut dirs: Vec<&str> = tree
        .entries
        .iter()
        .filter(|e| e.kind == EntryKind::Blob && basename(&e.path) == SKILL_FILE)
        .map(|e| parent_dir(&e.path))
        .filter(|d| dir_depth(d) <= MAX_SKILL_DEPTH && !d.split('/').any(ignored_segment))
        .collect();
    dirs.sort_unstable();
    dirs.dedup();
    let set: HashSet<&str> = dirs.iter().copied().collect();
    let mut by_dir: HashMap<&str, FoundSkill> = dirs
        .iter()
        .map(|d| {
            let tree_sha = if d.is_empty() {
                tree.sha.clone()
            } else {
                tree.entries.iter().find(|e| e.kind == EntryKind::Tree && e.path == *d).map(|e| e.sha.clone()).unwrap_or_default()
            };
            (*d, FoundSkill { dir: d.to_string(), tree_sha, files: Vec::new(), total_bytes: 0, has_scripts: false, blocked: None, skipped: Vec::new() })
        })
        .collect();

    for e in &tree.entries {
        if e.kind == EntryKind::Tree {
            continue;
        }
        // Owner: the deepest skill folder that contains the entry.
        let mut owner = None;
        let mut cur = parent_dir(&e.path);
        loop {
            if set.contains(cur) {
                owner = Some(cur);
                break;
            }
            if cur.is_empty() {
                break;
            }
            cur = parent_dir(cur);
        }
        let Some(owner) = owner else { continue };
        let rel = if owner.is_empty() { e.path.as_str() } else { &e.path[owner.len() + 1..] };
        if rel.split('/').any(|s| ignored_segment(s) || s.starts_with(".git")) {
            continue;
        }
        let skill = by_dir.get_mut(owner).expect("owner is a skill dir");
        match e.kind {
            EntryKind::Link | EntryKind::Submodule => skill.skipped.push(rel.to_string()),
            EntryKind::Tree => {}
            EntryKind::Blob => {
                if let Err(why) = validate_rel_path(rel) {
                    skill.blocked.get_or_insert_with(|| format!("Contains a file Windows cannot hold or that is unsafe to write ({why})"));
                }
                let executable = e.exec_bit || is_executable_name(rel);
                skill.has_scripts |= executable || rel.starts_with("scripts/");
                skill.total_bytes += e.size;
                skill.files.push(SkillFile { path: rel.to_string(), size: e.size, executable });
            }
        }
    }

    let mut out: Vec<FoundSkill> = dirs.iter().filter_map(|d| by_dir.remove(d)).collect();
    for s in &mut out {
        s.files.sort_by(|a, b| (a.path != SKILL_FILE, a.path.as_str()).cmp(&(b.path != SKILL_FILE, b.path.as_str())));
        if s.blocked.is_none() {
            if s.files.len() > MAX_FILES {
                s.blocked = Some(format!("Too many files for a skill ({}; the limit is {MAX_FILES})", s.files.len()));
            } else if s.total_bytes > MAX_TOTAL_BYTES {
                s.blocked = Some(format!("Too large for a skill ({}; the limit is {})", fmt_bytes(s.total_bytes), fmt_bytes(MAX_TOTAL_BYTES)));
            } else if let Some(big) = s.files.iter().find(|f| f.size > MAX_FILE_BYTES) {
                s.blocked = Some(format!("{} is larger than {}", big.path, fmt_bytes(MAX_FILE_BYTES)));
            }
        }
    }
    out
}

fn fmt_bytes(n: u64) -> String {
    if n >= 1024 * 1024 {
        format!("{:.1} MB", n as f64 / (1024.0 * 1024.0))
    } else if n >= 1024 {
        format!("{} KB", n.div_ceil(1024))
    } else {
        format!("{n} B")
    }
}

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

fn url_with_segments<'a>(base: &str, segments: impl IntoIterator<Item = &'a str>) -> Url {
    let mut u = Url::parse(base).expect("static base URL");
    u.path_segments_mut().expect("https base URL").extend(segments);
    u
}

pub fn repo_api_url(repo: &str) -> String {
    let (o, n) = repo.split_once('/').unwrap_or((repo, ""));
    url_with_segments(API_BASE, ["repos", o, n]).to_string()
}

/// `GET /repos/{o}/{r}/commits/{ref}`; slashes of a branch name stay path separators.
pub fn commit_api_url(repo: &str, git_ref: &str) -> String {
    let (o, n) = repo.split_once('/').unwrap_or((repo, ""));
    url_with_segments(API_BASE, ["repos", o, n, "commits"].into_iter().chain(git_ref.split('/'))).to_string()
}

pub fn tree_api_url(repo: &str, sha: &str) -> String {
    let (o, n) = repo.split_once('/').unwrap_or((repo, ""));
    let mut u = url_with_segments(API_BASE, ["repos", o, n, "git", "trees", sha]);
    u.query_pairs_mut().append_pair("recursive", "1");
    u.to_string()
}

/// `https://raw.githubusercontent.com/{o}/{r}/{sha}/{path}` with every segment percent-encoded.
pub fn raw_url(repo: &str, sha: &str, path: &str) -> String {
    let (o, n) = repo.split_once('/').unwrap_or((repo, ""));
    url_with_segments(RAW_BASE, [o, n, sha].into_iter().chain(path.split('/'))).to_string()
}

pub fn search_url(q: &str, by_stars: bool, page: u32) -> String {
    let mut u = url_with_segments(API_BASE, ["search", "repositories"]);
    {
        let mut qp = u.query_pairs_mut();
        qp.append_pair("q", q);
        if by_stars {
            qp.append_pair("sort", "stars");
            qp.append_pair("order", "desc");
        }
        qp.append_pair("per_page", &PER_PAGE.to_string());
        qp.append_pair("page", &page.to_string());
    }
    u.to_string()
}

/// Repositories with any of the [`SKILL_TOPICS`]. GitHub's REST search rejects `topic:a OR topic:b`
/// (422) and ignores parentheses, but keyword `OR` restricted to topics is a union (verified live).
pub fn skill_topics_query() -> String {
    format!("{} in:topics", SKILL_TOPICS.join(" OR "))
}

/// Default narrowing of free-text searches. Text cannot be combined with the topic union above (the
/// `OR` then binds to the text), so free text must also match "skill" in name, description or topics.
const TEXT_SCOPE: &str = "skill in:name,description,topics";

/// GitHub search query and "sort by stars" for a tab:
/// - `trending`: skill topics, pushed in the last 30 days (which includes every repository created in
///   that window), not archived, by stars;
/// - `top`: skill topics, all time, not archived, by stars;
/// - `best` / `stars`: the user's text (required). Text with its own qualifiers (`topic:`, `user:`,
///   `in:` …) is sent as typed; plain words get [`TEXT_SCOPE`]. Best match or by stars.
///
/// `text` is ignored by `trending` / `top`.
pub fn build_query(text: &str, sort: &str, today: chrono::NaiveDate) -> AppResult<(String, bool)> {
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.chars().any(char::is_control) || text.chars().count() > MAX_QUERY_CHARS {
        return Err(AppError::Invalid(format!("Search text must be at most {MAX_QUERY_CHARS} characters")));
    }
    let topics = skill_topics_query();
    match sort {
        "trending" => {
            let since = today - chrono::Duration::days(30);
            Ok((format!("{topics} pushed:>={} archived:false", since.format("%Y-%m-%d")), true))
        }
        "top" => Ok((format!("{topics} archived:false"), true)),
        "best" | "stars" => {
            if text.is_empty() {
                return Err(AppError::Invalid("Type something to search for".into()));
            }
            let own_qualifiers = text.contains(':');
            let q = if own_qualifiers { text } else { format!("{text} {TEXT_SCOPE}") };
            Ok((q, sort == "stars"))
        }
        other => Err(AppError::Invalid(format!("Unknown sort {other:?}"))),
    }
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct GhLicense {
    spdx_id: Option<String>,
    name: Option<String>,
}

#[derive(Deserialize)]
struct GhRepo {
    full_name: String,
    description: Option<String>,
    #[serde(default)]
    stargazers_count: u64,
    pushed_at: Option<String>,
    license: Option<GhLicense>,
    #[serde(default)]
    topics: Vec<String>,
    #[serde(default)]
    html_url: String,
    #[serde(default)]
    default_branch: String,
    #[serde(default)]
    archived: bool,
}

impl GhRepo {
    fn license_name(&self) -> Option<String> {
        let l = self.license.as_ref()?;
        l.spdx_id
            .clone()
            .filter(|s| !s.is_empty() && s != "NOASSERTION")
            .or_else(|| l.name.clone())
            .map(|s| clean_text(&s, 80))
    }

    fn into_skill_repo(self) -> SkillRepo {
        SkillRepo {
            license: self.license_name(),
            description: self.description.as_deref().map(|d| clean_text(d, 500)).filter(|d| !d.is_empty()),
            full_name: self.full_name,
            stars: self.stargazers_count,
            pushed_at: self.pushed_at,
            topics: self.topics.into_iter().take(20).map(|t| clean_text(&t, 50)).collect(),
            html_url: self.html_url,
            default_branch: self.default_branch,
            archived: self.archived,
        }
    }
}

/// One page of skill repositories (see [`build_query`] for `sort`). Rate limits are a result
/// (`rate_limited`), not an error. Cached for [`CACHE_TTL`].
pub fn search(f: &dyn Fetcher, text: &str, sort: &str, page: u32) -> AppResult<SkillRepoPage> {
    #[derive(Deserialize)]
    struct GhSearch {
        #[serde(default)]
        total_count: u64,
        #[serde(default)]
        items: Vec<GhRepo>,
    }
    let (q, by_stars) = build_query(text, sort, chrono::Utc::now().date_naive())?;
    let page = page.clamp(1, MAX_PAGE);
    let url = search_url(&q, by_stars, page);
    if let Some(mut hit) = SEARCH_CACHE.get(&url) {
        hit.cached = true;
        return Ok(hit);
    }
    match api_get(f, &url, API_ACCEPT, MAX_META_BYTES, "Search") {
        Ok(resp) => {
            let parsed: GhSearch = serde_json::from_slice(&resp.body)
                .map_err(|e| AppError::Other(format!("Unexpected answer from GitHub search: {e}")))?;
            let items: Vec<SkillRepo> = parsed
                .items
                .into_iter()
                .filter(|r| validate_repo(&r.full_name).is_ok())
                .map(GhRepo::into_skill_repo)
                .collect();
            let result = SkillRepoPage {
                items,
                total: parsed.total_count,
                page,
                rate_limited: false,
                reset_at: None,
                message: None,
                query: q,
                fetched_at_ms: now_ms(),
                cached: false,
            };
            SEARCH_CACHE.put(url, result.clone());
            Ok(result)
        }
        Err(Fail::RateLimited(reset_at)) => Ok(SkillRepoPage {
            items: Vec::new(),
            total: 0,
            page,
            rate_limited: true,
            reset_at,
            message: Some("GitHub's search limit for requests without an account is used up (10 per minute).".into()),
            query: q,
            fetched_at_ms: now_ms(),
            cached: false,
        }),
        Err(Fail::App(e)) => Err(e),
    }
}

// ---------------------------------------------------------------------------
// Inspect
// ---------------------------------------------------------------------------

/// The commit SHA `git_ref` points to (`HEAD` = the default branch).
fn resolve_commit(f: &dyn Fetcher, repo: &str, git_ref: &str) -> Result<String, Fail> {
    let resp = api_get(f, &commit_api_url(repo, git_ref), SHA_ACCEPT, MAX_META_BYTES, &format!("{repo} at {git_ref}"))?;
    #[derive(Deserialize)]
    struct Commit {
        sha: String,
    }
    let text = String::from_utf8_lossy(&resp.body);
    let text = text.trim();
    // A full commit object when the sha media type was not honoured.
    let raw = if text.starts_with('{') { serde_json::from_str::<Commit>(text).map(|c| c.sha).unwrap_or_default() } else { text.to_string() };
    let sha = raw.to_ascii_lowercase();
    validate_sha(&sha).map_err(|_| Fail::App(AppError::Other("GitHub returned an unexpected commit id".into())))?;
    Ok(sha)
}

fn fetch_tree(f: &dyn Fetcher, repo: &str, sha: &str) -> Result<Arc<RepoTree>, Fail> {
    let key = format!("{}@{sha}", repo.to_ascii_lowercase());
    if let Some(t) = TREE_CACHE.get(&key) {
        return Ok(t);
    }
    let resp = api_get(f, &tree_api_url(repo, sha), API_ACCEPT, MAX_TREE_BYTES, &format!("Commit {} of {repo}", &sha[..sha.len().min(7)]))?;
    let tree = Arc::new(parse_tree(&resp.body)?);
    if tree.entries.len() <= MAX_CACHED_TREE_ENTRIES {
        TREE_CACHE.put(key, Arc::clone(&tree));
    }
    Ok(tree)
}

fn looks_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8000).any(|b| *b == 0)
}

/// UTF-8 text (BOM stripped), cut at `max` bytes on a character boundary. Returns (text, cut).
fn text_of(bytes: &[u8], max: usize) -> (String, bool) {
    let s = mission::decode(bytes);
    if s.len() <= max {
        return (s, false);
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    (s[..end].to_string(), true)
}

fn fetch_raw(f: &dyn Fetcher, repo: &str, sha: &str, path: &str, cap: usize) -> AppResult<Vec<u8>> {
    let resp = f.get(&raw_url(repo, sha, path), RAW_ACCEPT, cap)?;
    match resp.status {
        200 => Ok(resp.body),
        404 => Err(AppError::NotFound(format!("{path} at {}", &sha[..7]))),
        s => Err(AppError::Other(format!("{path}: GitHub answered {s}"))),
    }
}

/// Skills of `repo` at `git_ref` (default: the default branch), pinned to a commit SHA, with the
/// repository's metadata and each skill's SKILL.md (the first [`MAX_SKILL_MD_FETCHES`]).
pub fn inspect(f: &dyn Fetcher, repo: &str, git_ref: Option<&str>) -> AppResult<RepoSkills> {
    validate_repo(repo)?;
    let git_ref = git_ref.map(str::trim).filter(|r| !r.is_empty());
    if let Some(r) = git_ref {
        validate_ref(r)?;
    }
    let key = format!("{}#{}", repo.to_ascii_lowercase(), git_ref.unwrap_or(""));
    if let Some(hit) = INSPECT_CACHE.get(&key) {
        return Ok(hit);
    }
    let meta: GhRepo = api_json(f, &repo_api_url(repo), MAX_META_BYTES, &format!("Repository {repo}")).map_err(into_app)?;
    let resolved = git_ref.map(str::to_string).unwrap_or_else(|| meta.default_branch.clone());
    if resolved.is_empty() {
        return Err(AppError::Invalid(format!("{repo} has no default branch (is it empty?)")));
    }
    let sha = resolve_commit(f, repo, &resolved).map_err(into_app)?;
    let tree = fetch_tree(f, repo, &sha).map_err(into_app)?;
    let mut found = discover_skills(&tree);
    let mut warnings = Vec::new();
    if tree.truncated {
        warnings.push("The repository is too large for GitHub to list completely; some skills may be missing.".to_string());
    }
    if found.is_empty() {
        warnings.push("No SKILL.md found. This may be a list of links or a different kind of repository: open it on GitHub.".to_string());
    }
    if found.len() > MAX_SKILLS_LISTED {
        warnings.push(format!("Showing the first {MAX_SKILLS_LISTED} of {} skills.", found.len()));
        found.truncate(MAX_SKILLS_LISTED);
    }
    let fetch_n = found.len().min(MAX_SKILL_MD_FETCHES);
    if found.len() > fetch_n {
        warnings.push(format!("Descriptions are shown for the first {fetch_n} skills; open a skill to read its SKILL.md."));
    }
    let texts = parallel_map(&found[..fetch_n], PARALLEL_FETCHES, |s| {
        fetch_raw(f, repo, &sha, &join_path(&s.dir, SKILL_FILE), MAX_TEXT).map(|b| text_of(&b, MAX_TEXT).0)
    });
    let mut failed = 0;
    let repo_name = repo.split_once('/').map(|(_, n)| n).unwrap_or(repo);
    let skills = found
        .into_iter()
        .enumerate()
        .map(|(i, s)| {
            let text = match texts.get(i) {
                Some(Ok(t)) => Some(t.clone()),
                Some(Err(_)) => {
                    failed += 1;
                    None
                }
                None => None,
            };
            let fm = text.as_deref().map(parse_frontmatter).unwrap_or_default();
            let fallback = if s.dir.is_empty() { repo_name.to_string() } else { basename(&s.dir).to_string() };
            if !s.skipped.is_empty() {
                warnings.push(format!(
                    "{}: {} symbolic link(s) or submodule(s) are not installed.",
                    if s.dir.is_empty() { "(root)" } else { &s.dir },
                    s.skipped.len()
                ));
            }
            SkillInfo {
                install_name: install_name(fm.name.as_deref(), &s.dir, repo),
                name: fm.name.unwrap_or(fallback),
                description: fm.description,
                path: s.dir,
                files: s.files,
                total_bytes: s.total_bytes,
                has_scripts: s.has_scripts,
                skill_md: text,
                tree_sha: s.tree_sha,
                blocked: s.blocked,
            }
        })
        .collect();
    if failed > 0 {
        warnings.push(format!("Could not read {failed} SKILL.md file(s)."));
    }
    let result = RepoSkills {
        repo: meta.full_name.clone().chars().take(140).collect(),
        git_ref: resolved,
        commit_sha: sha,
        default_branch: Some(meta.default_branch.clone()).filter(|b| !b.is_empty()),
        description: meta.description.as_deref().map(|d| clean_text(d, 500)).filter(|d| !d.is_empty()),
        stars: Some(meta.stargazers_count),
        license: meta.license_name(),
        pushed_at: meta.pushed_at.clone(),
        html_url: meta.html_url.clone(),
        archived: meta.archived,
        skills,
        warnings,
        fetched_at_ms: now_ms(),
    };
    // A renamed repository answers under its new name; keep the caller's spelling usable.
    let result = if validate_repo(&result.repo).is_ok() { result } else { RepoSkills { repo: repo.to_string(), ..result } };
    INSPECT_CACHE.put(key, result.clone());
    Ok(result)
}

/// One file of a repository at a pinned commit, for reading before install (text up to 256 KiB).
pub fn read_file(f: &dyn Fetcher, repo: &str, commit_sha: &str, path: &str) -> AppResult<SkillFileText> {
    validate_repo(repo)?;
    validate_sha(commit_sha)?;
    validate_rel_path(path).map_err(AppError::Invalid)?;
    let bytes = fetch_raw(f, repo, commit_sha, path, MAX_FILE_BYTES as usize)?;
    let binary = looks_binary(&bytes);
    let (text, truncated) = if binary { (String::new(), false) } else { text_of(&bytes, MAX_TEXT) };
    Ok(SkillFileText { path: path.to_string(), size: bytes.len() as u64, binary, truncated, text })
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

/// Folders that belong to the agent CLIs themselves: `CLAUDE_CONFIG_DIR`, `CODEX_HOME`,
/// `HERMES_HOME` and Hermes' default home. (`~/.claude*`, `~/.codex*`, `~/.agents` are checked by
/// [`agent_home_conflict`] relative to the user folder.)
fn agent_home_roots() -> (Option<PathBuf>, Vec<PathBuf>) {
    let mut roots: Vec<PathBuf> = ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "HERMES_HOME"]
        .iter()
        .filter_map(|k| std::env::var_os(k))
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .collect();
    if let Some(l) = discovery::local_app_data() {
        roots.push(l.join("hermes"));
    }
    (discovery::home_dir(), roots)
}

fn norm_path(p: &Path) -> String {
    let c = fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    let s = c.to_string_lossy().replace('/', "\\");
    let s = s.strip_prefix(r"\\?\UNC\").map(|r| format!(r"\\{r}")).unwrap_or_else(|| s.trim_start_matches(r"\\?\").to_string());
    s.trim_end_matches('\\').to_lowercase()
}

/// Why skills must not be written under `project` (it is, or is inside, an agent's own folder).
pub fn agent_home_conflict(project: &Path, home: Option<&Path>, roots: &[PathBuf]) -> Option<String> {
    let proj = norm_path(project);
    if let Some(h) = home {
        let h = norm_path(h);
        if !h.is_empty() && proj == h {
            return Some(
                "This workspace's project folder is your user folder, where .claude\\skills and .agents\\skills are the agents' own user-level folders.".into(),
            );
        }
        if let Some(rest) = proj.strip_prefix(&format!("{h}\\")) {
            let first = rest.split('\\').next().unwrap_or("");
            if first.starts_with(".claude") || first.starts_with(".codex") || first == ".agents" {
                return Some(format!("The project folder is inside ~\\{first}, an agent's own folder."));
            }
        }
    }
    for r in roots {
        let r = norm_path(r);
        if !r.is_empty() && (proj == r || proj.starts_with(&format!("{r}\\"))) {
            return Some("The project folder is inside an agent's home folder.".into());
        }
    }
    None
}

fn guard_project(project: &Path) -> AppResult<()> {
    let (home, roots) = agent_home_roots();
    match agent_home_conflict(project, home.as_deref(), &roots) {
        Some(why) => Err(AppError::Invalid(format!("{why} Gridkeeper never writes into agent home folders."))),
        None => Ok(()),
    }
}

/// Junction or symbolic link (Rust reports both as symlinks on Windows: name-surrogate reparse points).
fn is_link(p: &Path) -> bool {
    fs::symlink_metadata(p).map(|m| m.file_type().is_symlink()).unwrap_or(false)
}

/// Refuse when any existing component of `rel` under `base` is a junction or symbolic link.
fn check_no_links(base: &Path, rel: &str) -> AppResult<()> {
    let mut p = base.to_path_buf();
    for seg in rel.split('/').filter(|s| !s.is_empty()) {
        p.push(seg);
        if is_link(&p) {
            return Err(AppError::Invalid(format!(
                "{} is a junction or symbolic link; Gridkeeper does not write through links",
                p.display()
            )));
        }
    }
    Ok(())
}

/// Create `<project>/.gridkeeper/` (with its self-ignoring `.gitignore`) when missing. Same rules
/// as the mission file's folder (`crate::mission`).
fn ensure_gk_dir(project: &Path) -> AppResult<PathBuf> {
    let dir = project.join(mission::DIR_NAME);
    match fs::create_dir(&dir) {
        Ok(()) => {
            if let Err(e) = fs::write(dir.join(".gitignore"), GITIGNORE) {
                tracing::warn!(error = %e, "could not write .gridkeeper/.gitignore");
            }
        }
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
            if !dir.is_dir() {
                return Err(AppError::Invalid(format!("{} exists but is not a folder", dir.display())));
            }
        }
        Err(e) => return Err(e.into()),
    }
    check_no_links(project, mission::DIR_NAME)?;
    Ok(dir)
}

fn rename_retry(from: &Path, to: &Path) -> io::Result<()> {
    // Antivirus / indexers / editors can hold a folder briefly.
    let mut attempt = 0;
    loop {
        match fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(e) if attempt < 5 && e.kind() == io::ErrorKind::PermissionDenied => {
                attempt += 1;
                std::thread::sleep(Duration::from_millis(60 * attempt));
            }
            Err(e) => return Err(e),
        }
    }
}

/// Write `<path>.<pid>.<n>.tmp`, fsync, rename over `path`.
fn atomic_write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let tmp = path.with_file_name(format!(".{name}.{}.{}.tmp", std::process::id(), SEQ.fetch_add(1, Ordering::Relaxed)));
    let written = (|| {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()
    })();
    if let Err(e) = written {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    rename_retry(&tmp, path).inspect_err(|_| {
        let _ = fs::remove_file(&tmp);
    })
}

/// A fresh, empty staging folder in `<project>/.gridkeeper/tmp/` (same volume as the targets, so
/// the final move is a rename).
fn staging_dir(project: &Path) -> AppResult<PathBuf> {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let gk = ensure_gk_dir(project)?;
    let tmp = gk.join("tmp");
    fs::create_dir_all(&tmp)?;
    check_no_links(project, &format!("{}/tmp", mission::DIR_NAME))?;
    let dir = tmp.join(format!("skill-{}-{}-{}", std::process::id(), now_ms(), SEQ.fetch_add(1, Ordering::Relaxed)));
    fs::create_dir(&dir)?;
    Ok(dir)
}

fn write_files(dir: &Path, files: &[(String, Vec<u8>)]) -> io::Result<()> {
    for (rel, bytes) in files {
        let p = join_rel(dir, rel);
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut f = fs::File::create_new(&p)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    Ok(())
}

/// Move `content` to `dest`; an existing `dest` is moved aside into `staging` first and restored
/// when the move fails (it is deleted with the staging folder afterwards).
fn swap_into_place(content: &Path, dest: &Path, exists: bool, staging: &Path) -> io::Result<()> {
    if !exists {
        return rename_retry(content, dest);
    }
    let old = staging.join("previous");
    rename_retry(dest, &old)?;
    if let Err(e) = rename_retry(content, dest) {
        let _ = rename_retry(&old, dest);
        return Err(e);
    }
    Ok(())
}

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct LockFile {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    skills: Vec<LockEntry>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct LockEntry {
    /// Installed folder relative to the project, e.g. `.claude/skills/pdf`.
    dir: String,
    name: String,
    repo: String,
    commit_sha: String,
    path: String,
    #[serde(default)]
    tree_sha: Option<String>,
    installed_at: String,
}

static LOCK_WRITE: Mutex<()> = parking_lot::const_mutex(());

/// Read-modify-write `<project>/.gridkeeper/skills.lock.json`. A file that does not parse is kept
/// as `skills.lock.corrupt-<ms>.json` and a new one started (never destructive).
fn update_lock(project: &Path, create: bool, edit: impl FnOnce(&mut Vec<LockEntry>)) -> AppResult<()> {
    let _g = LOCK_WRITE.lock();
    let path = project.join(mission::DIR_NAME).join(LOCK_FILE);
    if !create && !path.is_file() {
        return Ok(());
    }
    let dir = ensure_gk_dir(project)?;
    let mut lock = match fs::read(&path) {
        Ok(b) => match serde_json::from_slice::<LockFile>(&b) {
            Ok(l) if b.len() <= 4 * 1024 * 1024 => l,
            _ => {
                let _ = fs::rename(&path, dir.join(format!("skills.lock.corrupt-{}.json", now_ms())));
                LockFile::default()
            }
        },
        Err(e) if e.kind() == io::ErrorKind::NotFound => LockFile::default(),
        Err(e) => return Err(e.into()),
    };
    lock.version = 1;
    edit(&mut lock.skills);
    lock.skills.sort_by(|a, b| a.dir.cmp(&b.dir));
    let bytes = serde_json::to_vec_pretty(&lock).map_err(|e| AppError::Other(e.to_string()))?;
    atomic_write(&path, &bytes)?;
    Ok(())
}

fn download_files(f: &dyn Fetcher, repo: &str, sha: &str, skill: &FoundSkill) -> AppResult<Vec<(String, Vec<u8>)>> {
    let results = parallel_map(&skill.files, PARALLEL_FETCHES, |file| {
        fetch_raw(f, repo, sha, &join_path(&skill.dir, &file.path), MAX_FILE_BYTES as usize).map(|b| (file.path.clone(), b))
    });
    let mut out = Vec::with_capacity(results.len());
    let mut total = 0u64;
    for r in results {
        let (path, bytes) = r?;
        if bytes.len() as u64 > MAX_FILE_BYTES {
            return Err(AppError::Invalid(format!("{path} is larger than {}", fmt_bytes(MAX_FILE_BYTES))));
        }
        total += bytes.len() as u64;
        if total > MAX_TOTAL_BYTES {
            return Err(AppError::Invalid(format!("The skill is larger than {}", fmt_bytes(MAX_TOTAL_BYTES))));
        }
        out.push((path, bytes));
    }
    Ok(out)
}

pub struct InstallRequest<'a> {
    pub project_dir: &'a str,
    pub repo: &'a str,
    pub commit_sha: &'a str,
    /// Skill folder in the repository ("" = root).
    pub skill_path: &'a str,
    /// Subset of [`TARGET_DIRS`].
    pub targets: &'a [String],
    /// The user confirmed replacing existing folders of the same name.
    pub replace: bool,
}

/// Download one skill folder at a pinned commit and install it into each target of the project.
/// Existing folders are only replaced with `replace`; otherwise the call fails with code `conflict`
/// before anything is written.
pub fn install(f: &dyn Fetcher, req: &InstallRequest<'_>) -> AppResult<InstallResult> {
    let project = mission::validate_project_dir(req.project_dir)?;
    validate_repo(req.repo)?;
    validate_sha(req.commit_sha)?;
    let skill_path = normalize_skill_path(req.skill_path)?;
    let targets = validate_targets(req.targets)?;
    guard_project(&project)?;

    let tree = fetch_tree(f, req.repo, req.commit_sha).map_err(into_app)?;
    let skill = discover_skills(&tree)
        .into_iter()
        .find(|s| s.dir == skill_path)
        .ok_or_else(|| AppError::NotFound(format!("No SKILL.md in {:?} at this commit", if skill_path.is_empty() { "/" } else { &skill_path })))?;
    if let Some(why) = &skill.blocked {
        return Err(AppError::Invalid(why.clone()));
    }
    let files = download_files(f, req.repo, req.commit_sha, &skill)?;
    let md = files.iter().find(|(p, _)| p == SKILL_FILE).map(|(_, b)| mission::decode(b)).unwrap_or_default();
    let fm = parse_frontmatter(&md);
    let name = install_name(fm.name.as_deref(), &skill.dir, req.repo);

    // Pre-flight every target before writing anything.
    let mut plan = Vec::new();
    for t in &targets {
        let rel = format!("{t}/{name}");
        check_no_links(&project, &rel)?;
        let dest = join_rel(&project, &rel);
        let exists = match fs::symlink_metadata(&dest) {
            Ok(m) if m.is_dir() => true,
            Ok(_) => return Err(AppError::Invalid(format!("{rel} exists and is not a folder"))),
            Err(_) => false,
        };
        if exists && !req.replace {
            return Err(AppError::Conflict(format!("{rel} already exists")));
        }
        plan.push((rel, dest, exists));
    }

    let installed_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let provenance = SkillProvenance {
        repo: req.repo.to_string(),
        commit_sha: req.commit_sha.to_string(),
        path: skill_path.clone(),
        tree_sha: Some(skill.tree_sha.clone()).filter(|s| !s.is_empty()),
        name: Some(name.clone()),
        installed_at: installed_at.clone(),
    };
    let prov_bytes = serde_json::to_vec_pretty(&provenance).map_err(|e| AppError::Other(e.to_string()))?;
    let total_bytes = files.iter().map(|(_, b)| b.len() as u64).sum();
    let mut result = InstallResult {
        name: name.clone(),
        installed: Vec::new(),
        replaced: Vec::new(),
        files: files.len(),
        total_bytes,
        commit_sha: req.commit_sha.to_string(),
        warnings: Vec::new(),
    };
    for (rel, dest, exists) in plan {
        let staging = staging_dir(&project)?;
        let content = staging.join("skill");
        let written = (|| {
            fs::create_dir(&content)?;
            write_files(&content, &files)?;
            fs::write(content.join(PROVENANCE_FILE), &prov_bytes)?;
            if let Some(parent) = dest.parent() {
                fs::create_dir_all(parent)?;
            }
            swap_into_place(&content, &dest, exists, &staging)
        })();
        let _ = fs::remove_dir_all(&staging);
        if let Err(e) = written {
            result.warnings.push(format!("Could not write {rel}: {e}"));
            if result.installed.is_empty() {
                return Err(AppError::Other(format!("Could not write {rel}: {e}")));
            }
            continue;
        }
        if exists {
            result.replaced.push(rel.clone());
        }
        result.installed.push(rel);
    }
    let entries: Vec<LockEntry> = result
        .installed
        .iter()
        .map(|dir| LockEntry {
            dir: dir.clone(),
            name: name.clone(),
            repo: req.repo.to_string(),
            commit_sha: req.commit_sha.to_string(),
            path: skill_path.clone(),
            tree_sha: provenance.tree_sha.clone(),
            installed_at: installed_at.clone(),
        })
        .collect();
    if let Err(e) = update_lock(&project, true, |skills| {
        skills.retain(|s| !entries.iter().any(|n| n.dir == s.dir));
        skills.extend(entries);
    }) {
        result.warnings.push(format!("Installed, but could not update .gridkeeper/{LOCK_FILE}: {e}"));
    }
    tracing::info!(repo = req.repo, skill = %name, targets = result.installed.len(), "installed skill");
    Ok(result)
}

// ---------------------------------------------------------------------------
// Installed skills, remove, update check
// ---------------------------------------------------------------------------

fn read_capped(path: &Path, max: usize) -> Option<String> {
    let f = fs::File::open(path).ok()?;
    if !f.metadata().ok()?.is_file() {
        return None;
    }
    let mut bytes = Vec::new();
    f.take(max as u64).read_to_end(&mut bytes).ok()?;
    Some(mission::decode(&bytes))
}

/// (file count, has scripts) of a folder, never following links; bounded.
fn scan_dir(root: &Path) -> (usize, bool) {
    let mut count = 0;
    let mut scripts = false;
    let mut stack = vec![(root.to_path_buf(), String::new(), 0usize)];
    while let Some((dir, rel, depth)) = stack.pop() {
        let Ok(rd) = fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            let Ok(ft) = e.file_type() else { continue };
            let name = e.file_name().to_string_lossy().into_owned();
            let rel_path = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
            if ft.is_symlink() {
                continue;
            }
            if ft.is_dir() {
                if depth < 8 && count < 2000 {
                    stack.push((e.path(), rel_path, depth + 1));
                }
            } else if !(rel.is_empty() && name == PROVENANCE_FILE) {
                count += 1;
                scripts |= is_executable_name(&rel_path) || rel_path.starts_with("scripts/");
            }
        }
    }
    (count, scripts)
}

/// Skills in the project's `.claude/skills/*/SKILL.md` and `.agents/skills/*/SKILL.md` (read-only).
pub fn installed(project_dir: &str) -> AppResult<Vec<InstalledSkill>> {
    let project = mission::validate_project_dir(project_dir)?;
    let mut out = Vec::new();
    for t in TARGET_DIRS {
        let root = join_rel(&project, t);
        let Ok(rd) = fs::read_dir(&root) else { continue };
        for e in rd.flatten().take(500) {
            let path = e.path();
            if !path.is_dir() {
                continue;
            }
            let folder = e.file_name().to_string_lossy().into_owned();
            let Some(md) = read_capped(&path.join(SKILL_FILE), MAX_TEXT) else { continue };
            let fm = parse_frontmatter(&md);
            let provenance = read_capped(&path.join(PROVENANCE_FILE), 64 * 1024)
                .and_then(|s| serde_json::from_str::<SkillProvenance>(&s).ok())
                .filter(|p| validate_repo(&p.repo).is_ok() && validate_sha(&p.commit_sha).is_ok() && normalize_skill_path(&p.path).is_ok());
            let link = is_link(&path);
            let (file_count, has_scripts) = if link { (0, false) } else { scan_dir(&path) };
            out.push(InstalledSkill {
                name: fm.name.unwrap_or_else(|| folder.clone()),
                description: fm.description,
                target: t.to_string(),
                dir_rel: format!("{t}/{folder}"),
                dir_abs: path.to_string_lossy().into_owned(),
                folder,
                provenance,
                has_scripts,
                file_count,
                is_link: link,
            });
        }
    }
    out.sort_by(|a, b| (a.name.to_lowercase(), &a.target).cmp(&(b.name.to_lowercase(), &b.target)));
    Ok(out)
}

/// `.claude/skills/<folder>` or `.agents/skills/<folder>` (either slash) → (target, folder).
pub fn parse_installed_rel(rel: &str) -> AppResult<(&'static str, String)> {
    let norm = rel.trim().replace('\\', "/");
    let norm = norm.trim_end_matches('/');
    for t in TARGET_DIRS {
        if let Some(folder) = norm.strip_prefix(t).and_then(|r| r.strip_prefix('/'))
            && !folder.contains('/')
            && segment_problem(folder).is_none()
        {
            return Ok((t, folder.to_string()));
        }
    }
    Err(AppError::Invalid(format!("Not a skill folder Gridkeeper manages (.claude/skills/<name> or .agents/skills/<name>): {rel:?}")))
}

/// Delete one installed skill folder. Only `<project>/.claude/skills/<name>` or
/// `<project>/.agents/skills/<name>`, only a real folder with a SKILL.md, never through a junction or
/// symbolic link, never in an agent home.
pub fn remove(project_dir: &str, target_dir_rel: &str) -> AppResult<()> {
    let project = mission::validate_project_dir(project_dir)?;
    let (target, folder) = parse_installed_rel(target_dir_rel)?;
    guard_project(&project)?;
    let rel = format!("{target}/{folder}");
    check_no_links(&project, &rel)?;
    let dir = join_rel(&project, &rel);
    match fs::symlink_metadata(&dir) {
        Ok(m) if m.is_dir() => {}
        Ok(_) => return Err(AppError::Invalid(format!("{rel} is not a folder"))),
        Err(_) => return Err(AppError::NotFound(rel)),
    }
    if !dir.join(SKILL_FILE).is_file() {
        return Err(AppError::Invalid(format!("{rel} has no SKILL.md; not removing a folder that is not a skill")));
    }
    fs::remove_dir_all(&dir)?;
    if let Err(e) = update_lock(&project, false, |skills| skills.retain(|s| s.dir != rel)) {
        tracing::warn!(error = %e, "could not update skills.lock.json after remove");
    }
    tracing::info!(dir = %rel, "removed skill");
    Ok(())
}

/// Is a newer version of an installed skill on the repository's default branch? Compares the skill
/// folder's tree SHA at the pinned commit with today's (when the provenance recorded one).
pub fn check_update(f: &dyn Fetcher, repo: &str, skill_path: &str, commit_sha: &str, tree_sha: Option<&str>) -> AppResult<SkillUpdateCheck> {
    validate_repo(repo)?;
    validate_sha(commit_sha)?;
    let path = normalize_skill_path(skill_path)?;
    let current = resolve_commit(f, repo, "HEAD").map_err(into_app)?;
    let mut out = SkillUpdateCheck {
        repo: repo.to_string(),
        path: path.clone(),
        status: SkillUpdateStatus::Current,
        pinned_sha: commit_sha.to_string(),
        current_sha: current.clone(),
    };
    if current == commit_sha {
        return Ok(out);
    }
    let tree = fetch_tree(f, repo, &current).map_err(into_app)?;
    out.status = match discover_skills(&tree).into_iter().find(|s| s.dir == path) {
        None => SkillUpdateStatus::Missing,
        Some(s) => match tree_sha.filter(|t| !t.is_empty()) {
            Some(t) if t == s.tree_sha => SkillUpdateStatus::Current,
            _ => SkillUpdateStatus::Update,
        },
    };
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- fixtures -------------------------------------------------------------------------------

    fn blob(path: &str, size: u64) -> TreeEntry {
        TreeEntry { path: path.into(), kind: EntryKind::Blob, sha: format!("b-{path}"), size, exec_bit: false }
    }

    fn dir(path: &str) -> TreeEntry {
        TreeEntry { path: path.into(), kind: EntryKind::Tree, sha: format!("t-{path}"), size: 0, exec_bit: false }
    }

    fn tree(entries: Vec<TreeEntry>) -> RepoTree {
        RepoTree { sha: "root-tree".into(), entries, truncated: false }
    }

    /// Canned responses by exact URL; everything else is a 404. Counts calls.
    #[derive(Default)]
    struct Mock {
        routes: Mutex<HashMap<String, HttpResponse>>,
        calls: Mutex<Vec<String>>,
    }

    impl Mock {
        fn route(&self, url: String, status: u16, body: impl Into<Vec<u8>>) {
            self.routes.lock().insert(url, HttpResponse { status, headers: Vec::new(), body: body.into() });
        }
        fn route_resp(&self, url: String, resp: HttpResponse) {
            self.routes.lock().insert(url, resp);
        }
        fn count(&self, needle: &str) -> usize {
            self.calls.lock().iter().filter(|u| u.contains(needle)).count()
        }
    }

    impl Fetcher for Mock {
        fn get(&self, url: &str, _accept: &str, cap: usize) -> AppResult<HttpResponse> {
            self.calls.lock().push(url.to_string());
            let r = self.routes.lock().get(url).cloned().unwrap_or(HttpResponse { status: 404, headers: Vec::new(), body: b"{\"message\":\"Not Found\"}".to_vec() });
            if r.body.len() > cap {
                return Err(too_large_response(cap));
            }
            Ok(r)
        }
    }

    const SHA: &str = "0123456789abcdef0123456789abcdef01234567";
    const SHA2: &str = "fedcba9876543210fedcba9876543210fedcba98";

    fn tree_json(root: &str, entries: &[(&str, &str, &str, u64)]) -> String {
        let items: Vec<serde_json::Value> = entries
            .iter()
            .map(|(path, kind, sha, size)| {
                let mode = match *kind {
                    "tree" => "040000",
                    "exec" => "100755",
                    "link" => "120000",
                    _ => "100644",
                };
                let ty = if *kind == "tree" { "tree" } else { "blob" };
                serde_json::json!({ "path": path, "mode": mode, "type": ty, "sha": sha, "size": size })
            })
            .collect();
        serde_json::json!({ "sha": root, "tree": items, "truncated": false }).to_string()
    }

    fn project() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    fn s(p: &Path) -> String {
        p.to_string_lossy().into_owned()
    }

    /// A mock repo `repo` at SHA with skill `skills/pdf` (SKILL.md, references/guide.md, scripts/run.ps1).
    fn mock_pdf_repo(repo: &str) -> Mock {
        let m = Mock::default();
        m.route(
            tree_api_url(repo, SHA),
            200,
            tree_json("root1", &[
                ("README.md", "blob", "r", 10),
                ("skills", "tree", "t-skills", 0),
                ("skills/pdf", "tree", "t-pdf-v1", 0),
                ("skills/pdf/SKILL.md", "blob", "a", 60),
                ("skills/pdf/references", "tree", "x", 0),
                ("skills/pdf/references/guide.md", "blob", "b", 5),
                ("skills/pdf/scripts", "tree", "y", 0),
                ("skills/pdf/scripts/run.ps1", "exec", "c", 7),
            ]),
        );
        m.route(raw_url(repo, SHA, "skills/pdf/SKILL.md"), 200, "---\nname: pdf\ndescription: Work with PDFs\n---\n# PDF\n");
        m.route(raw_url(repo, SHA, "skills/pdf/references/guide.md"), 200, "guide");
        m.route(raw_url(repo, SHA, "skills/pdf/scripts/run.ps1"), 200, "echo hi");
        m
    }

    // ---- discovery ------------------------------------------------------------------------------

    #[test]
    fn discovers_skills_in_common_layouts() {
        let t = tree(vec![
            blob("README.md", 5),
            dir("skills"),
            dir("skills/pdf"),
            blob("skills/pdf/SKILL.md", 100),
            blob("skills/pdf/scripts/fill.py", 50),
            blob("skills/pdf/reference.md", 20),
            dir(".claude/skills/review"),
            blob(".claude/skills/review/SKILL.md", 10),
            dir("plugins/p/skills/deep"),
            blob("plugins/p/skills/deep/SKILL.md", 10),
            blob("a/b/c/d/e/SKILL.md", 10),                // depth 5: too deep
            blob("node_modules/x/SKILL.md", 10),           // ignored
            blob("skills/pdf/node_modules/y/index.js", 9), // ignored inside a skill
            blob("skills/notes/skill.md", 1),              // wrong case: not a skill
        ]);
        let found = discover_skills(&t);
        let dirs: Vec<&str> = found.iter().map(|s| s.dir.as_str()).collect();
        assert_eq!(dirs, vec![".claude/skills/review", "plugins/p/skills/deep", "skills/pdf"]);
        let pdf = &found[2];
        assert_eq!(pdf.tree_sha, "t-skills/pdf");
        let files: Vec<&str> = pdf.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(files, vec!["SKILL.md", "reference.md", "scripts/fill.py"], "SKILL.md first");
        assert_eq!(pdf.total_bytes, 170);
        assert!(pdf.has_scripts);
        assert!(pdf.files.iter().find(|f| f.path == "scripts/fill.py").unwrap().executable);
        assert!(pdf.blocked.is_none());
        assert!(!found[0].has_scripts);
    }

    #[test]
    fn nested_and_root_skills_do_not_share_files() {
        let t = tree(vec![
            blob("SKILL.md", 10),
            blob("LICENSE", 1),
            blob(".github/workflows/ci.yml", 1),
            blob(".gitignore", 1),
            dir("skills/inner"),
            blob("skills/inner/SKILL.md", 10),
            blob("skills/inner/x.md", 3),
            TreeEntry { path: "link.md".into(), kind: EntryKind::Link, sha: "l".into(), size: 4, exec_bit: false },
        ]);
        let found = discover_skills(&t);
        assert_eq!(found.len(), 2);
        let root = &found[0];
        assert_eq!(root.dir, "");
        assert_eq!(root.tree_sha, "root-tree", "root skill uses the root tree SHA");
        let files: Vec<&str> = root.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(files, vec!["SKILL.md", "LICENSE"], ".git* paths and the nested skill are excluded");
        assert_eq!(root.skipped, vec!["link.md".to_string()]);
        let inner: Vec<&str> = found[1].files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(inner, vec!["SKILL.md", "x.md"]);
    }

    #[test]
    fn limits_and_unsafe_names_block_install() {
        let mut entries = vec![blob("big/SKILL.md", 10)];
        for i in 0..MAX_FILES {
            entries.push(blob(&format!("big/f{i}.md"), 1));
        }
        entries.push(blob("huge/SKILL.md", 10));
        entries.push(blob("huge/model.bin", MAX_FILE_BYTES + 1));
        entries.push(blob("total/SKILL.md", 10));
        for i in 0..6 {
            entries.push(blob(&format!("total/part{i}.bin"), MAX_FILE_BYTES));
        }
        entries.push(blob("names/SKILL.md", 10));
        entries.push(blob("names/aux.md", 1));
        entries.push(blob("ok/SKILL.md", 10));
        let found = discover_skills(&tree(entries));
        let by = |d: &str| found.iter().find(|s| s.dir == d).unwrap();
        assert!(by("big").blocked.as_deref().unwrap().contains("Too many files"));
        assert!(by("huge").blocked.as_deref().unwrap().contains("larger than"));
        assert!(by("total").blocked.as_deref().unwrap().contains("Too large"));
        assert!(by("names").blocked.as_deref().unwrap().contains("reserved"));
        assert!(by("ok").blocked.is_none());
    }

    #[test]
    fn parses_github_tree_json() {
        let json = tree_json("abc", &[("s", "tree", "t1", 0), ("s/SKILL.md", "blob", "b1", 12), ("s/run.sh", "exec", "b2", 3), ("s/l", "link", "b3", 1)]);
        let t = parse_tree(json.as_bytes()).unwrap();
        assert_eq!(t.sha, "abc");
        assert_eq!(t.entries.len(), 4);
        assert_eq!(t.entries[0].kind, EntryKind::Tree);
        assert!(t.entries[2].exec_bit);
        assert_eq!(t.entries[3].kind, EntryKind::Link);
        assert!(parse_tree(b"not json").is_err());
    }

    // ---- frontmatter ----------------------------------------------------------------------------

    #[test]
    fn parses_frontmatter_variants() {
        let fm = parse_frontmatter("---\nname: pdf-tools\ndescription: Fill and merge PDFs. Use when the user asks.\nlicense: MIT\n---\n# Body\n");
        assert_eq!(fm.name.as_deref(), Some("pdf-tools"));
        assert_eq!(fm.description.as_deref(), Some("Fill and merge PDFs. Use when the user asks."));

        let fm = parse_frontmatter("\u{feff}---\r\nname: \"quoted: name\"\r\ndescription: 'It''s here'\r\n---\r\n");
        assert_eq!(fm.name.as_deref(), Some("quoted: name"));
        assert_eq!(fm.description.as_deref(), Some("It's here"));

        let fm = parse_frontmatter("---\nname: x\ndescription: >\n  Folded line one\n  and two.\n\n  New paragraph.\nother: y\n---\n");
        assert_eq!(fm.description.as_deref(), Some("Folded line one and two.\nNew paragraph."));

        let fm = parse_frontmatter("---\nname: x\ndescription: |-\n  Line one\n  Line two\n---\n");
        assert_eq!(fm.description.as_deref(), Some("Line one\nLine two"));

        let fm = parse_frontmatter("---\nname: x # comment\ndescription: plain\n  continued here\nmetadata:\n  version: 1\n---\n");
        assert_eq!(fm.name.as_deref(), Some("x"));
        assert_eq!(fm.description.as_deref(), Some("plain continued here"));

        let fm = parse_frontmatter("---\ndescription: \"Escaped \\\"quote\\\" and\\nnewline\"\n---");
        assert_eq!(fm.description.as_deref(), Some("Escaped \"quote\" and\nnewline"));

        assert_eq!(parse_frontmatter("# No frontmatter\nname: x"), Frontmatter::default());
        assert_eq!(parse_frontmatter("---\nname: unclosed\n"), Frontmatter::default());
        assert_eq!(parse_frontmatter(""), Frontmatter::default());
    }

    #[test]
    fn install_names() {
        assert_eq!(install_name(Some("pdf"), "skills/whatever", "o/r"), "pdf");
        assert_eq!(install_name(Some("PDF Tools!"), "skills/pdf-tools", "o/r"), "pdf-tools", "invalid name → folder");
        assert_eq!(install_name(Some("PDF Tools!"), "skills/Bad Folder", "o/r"), "pdf-tools", "sanitized name");
        assert_eq!(install_name(Some("Ünïcode Name"), "", "o/R_epo"), "n-code-name");
        assert_eq!(install_name(Some("!!!"), "", "o/R_epo"), "r-epo", "sanitized repository name last");
        assert_eq!(install_name(Some("con"), "skills/con", "o/con"), "skill", "reserved names never become folders");
        assert_eq!(install_name(None, "", "o/diagram-design"), "diagram-design");
    }

    // ---- validation -----------------------------------------------------------------------------

    #[test]
    fn validates_repos_refs_shas() {
        assert_eq!(validate_repo("anthropics/skills").unwrap(), ("anthropics", "skills"));
        assert!(validate_repo("heygen-com/hyperframes").is_ok());
        assert!(validate_repo("a/b.c_d-e").is_ok());
        for bad in ["", "a", "a/b/c", "a b/c", "../x", "a/..", "a/b.git", "-;rm/x", "a/b?x", "a/b#c", "https://github.com/a/b"] {
            assert!(validate_repo(bad).is_err(), "{bad:?}");
        }
        for ok in ["main", "v1.2.3", "feature/x", SHA, "release-2026_10"] {
            assert!(validate_ref(ok).is_ok(), "{ok:?}");
        }
        for bad in ["", "-x", "/x", "x/", "a..b", "a//b", "a b", "a;b", "x/.hidden", ".x", "x."] {
            assert!(validate_ref(bad).is_err(), "{bad:?}");
        }
        assert!(validate_sha(SHA).is_ok());
        assert!(validate_sha(&SHA.to_uppercase()).is_err());
        assert!(validate_sha("abc").is_err());
    }

    #[test]
    fn validates_paths_for_windows() {
        for ok in ["SKILL.md", "references/guide.md", "assets/logo v2.png", "scripts/fill_form.py", "a/b/c/d.txt", "Ünïcode.md"] {
            assert!(validate_rel_path(ok).is_ok(), "{ok:?}");
        }
        for bad in [
            "", "/abs", "../x", "a/../b", "a/./b", "a//b", "C:/x", "c:x", "a\\b", "a/b:stream", "con", "a/NUL.txt", "lpt1.md",
            "COM9", "a/trailing.", "a/trailing ", "a/<x>", "a/x|y", "a/x?y", "a/x*y", "a/\u{1}x",
        ] {
            assert!(validate_rel_path(bad).is_err(), "{bad:?}");
        }
        assert!(validate_rel_path(&"a/".repeat(201)).is_err());
        assert_eq!(normalize_skill_path("/skills/pdf/").unwrap(), "skills/pdf");
        assert_eq!(normalize_skill_path("").unwrap(), "");
        assert!(normalize_skill_path("../x").is_err());
        assert_eq!(validate_targets(&[".claude/skills".into(), ".claude\\skills\\".into()]).unwrap(), vec![".claude/skills"]);
        assert!(validate_targets(&[]).is_err());
        assert!(validate_targets(&["~/.claude/skills".into()]).is_err());
        assert!(validate_targets(&[".claude".into()]).is_err());
        assert!(is_executable_name("scripts/run.PS1"));
        assert!(is_executable_name("x.py"));
        assert!(!is_executable_name("README.md"));
        assert!(!is_executable_name(".py"));
    }

    // ---- URLs -----------------------------------------------------------------------------------

    #[test]
    fn builds_and_encodes_urls() {
        assert_eq!(repo_api_url("o/r"), "https://api.github.com/repos/o/r");
        assert_eq!(commit_api_url("o/r", "feature/x"), "https://api.github.com/repos/o/r/commits/feature/x");
        assert_eq!(tree_api_url("o/r", SHA), format!("https://api.github.com/repos/o/r/git/trees/{SHA}?recursive=1"));
        assert_eq!(
            raw_url("o/r", SHA, "skills/my skill/a#b?c%.md"),
            format!("https://raw.githubusercontent.com/o/r/{SHA}/skills/my%20skill/a%23b%3Fc%25.md")
        );
        assert_eq!(raw_url("o/r", SHA, "Ünï.md"), format!("https://raw.githubusercontent.com/o/r/{SHA}/%C3%9Cn%C3%AF.md"));
        let u = search_url("agent-skills OR claude-skills in:topics pushed:>=2026-09-18", true, 2);
        assert!(u.starts_with("https://api.github.com/search/repositories?q=agent-skills+OR+claude-skills+in%3Atopics+pushed%3A%3E%3D2026-09-18"), "{u}");
        assert!(u.ends_with("&sort=stars&order=desc&per_page=30&page=2"), "{u}");
        let u = search_url("a&b=c#d", false, 1);
        assert!(u.contains("q=a%26b%3Dc%23d&per_page=30"), "{u}");
        assert!(!u.contains("sort="));
        assert!(allowed_url(&u));
        assert!(!allowed_url("https://evil.example/api.github.com/"));
        assert!(!allowed_url("http://api.github.com/x"));
    }

    #[test]
    fn builds_search_queries() {
        let today = chrono::NaiveDate::from_ymd_opt(2026, 10, 18).unwrap();
        let topics = skill_topics_query();
        assert_eq!(topics, "agent-skills OR claude-code-skills OR claude-skills OR agent-skill OR claude-code-plugin in:topics");
        let (q, stars) = build_query("", "trending", today).unwrap();
        assert_eq!(q, format!("{topics} pushed:>=2026-09-18 archived:false"));
        assert!(stars);
        let (q, stars) = build_query("ignored", "top", today).unwrap();
        assert_eq!(q, format!("{topics} archived:false"));
        assert!(stars);
        let (q, stars) = build_query("  diagram   tools ", "best", today).unwrap();
        assert_eq!(q, "diagram tools skill in:name,description,topics");
        assert!(!stars);
        let (q, _) = build_query("pdf topic:mcp", "stars", today).unwrap();
        assert_eq!(q, "pdf topic:mcp", "own qualifiers replace the default scope");
        assert!(build_query("", "best", today).is_err());
        assert!(build_query("x", "weird", today).is_err());
        assert!(build_query(&"x".repeat(MAX_QUERY_CHARS + 1), "best", today).is_err());
    }

    // ---- HTTP parsing -----------------------------------------------------------------------------

    #[test]
    fn parses_curl_output_and_rate_limits() {
        let raw = b"HTTP/1.1 200 Connection established\r\n\r\nHTTP/2 301\r\nlocation: x\r\n\r\nHTTP/2 200\r\nX-RateLimit-Remaining: 59\r\n\r\nHTTP/1.1 200 OK\r\nbody that looks like headers";
        let r = parse_curl_output(raw).unwrap();
        assert_eq!(r.status, 200);
        assert_eq!(r.header("x-ratelimit-remaining"), Some("59"));
        assert_eq!(r.body, b"HTTP/1.1 200 OK\r\nbody that looks like headers", "a body starting with HTTP/ stays the body");
        assert!(parse_curl_output(b"").is_none());

        let limited = HttpResponse {
            status: 403,
            headers: vec![("x-ratelimit-remaining".into(), "0".into()), ("x-ratelimit-reset".into(), "1000600".into())],
            body: br#"{"message":"API rate limit exceeded for 1.2.3.4."}"#.to_vec(),
        };
        assert_eq!(rate_limit_reset(&limited, 1_000_000), Some(Some(1_000_600)));
        let secondary = HttpResponse { status: 403, headers: vec![("retry-after".into(), "60".into())], body: Vec::new() };
        assert_eq!(rate_limit_reset(&secondary, 1_000_000), Some(Some(1_000_060)));
        let forbidden = HttpResponse { status: 403, headers: Vec::new(), body: br#"{"message":"Repository access blocked"}"#.to_vec() };
        assert_eq!(rate_limit_reset(&forbidden, 0), None);
        let msg = rate_limit_error(Some(1_000_600), 1_000_000).to_string();
        assert!(msg.contains("10 minutes"), "{msg}");
    }

    // ---- search / inspect / file with a mocked fetcher ----------------------------------------------

    #[test]
    fn search_parses_caches_and_reports_rate_limits() {
        let m = Mock::default();
        let today = chrono::Utc::now().date_naive();
        let (q, stars) = build_query("mock-search-unique-1", "top", today).unwrap();
        let body = serde_json::json!({
            "total_count": 2,
            "items": [
                { "full_name": "o/skills", "description": "Some\u{0007} skills", "stargazers_count": 1200, "pushed_at": "2026-10-01T00:00:00Z",
                  "license": { "spdx_id": "MIT", "name": "MIT License" }, "topics": ["agent-skills"], "html_url": "https://github.com/o/skills",
                  "default_branch": "main", "archived": false },
                { "full_name": "bad name/x", "stargazers_count": 1, "html_url": "", "default_branch": "main" }
            ]
        });
        m.route(search_url(&q, stars, 1), 200, body.to_string());
        let page = search(&m, "mock-search-unique-1", "top", 1).unwrap();
        assert!(!page.rate_limited);
        assert!(!page.cached);
        assert_eq!(page.total, 2);
        assert_eq!(page.items.len(), 1, "invalid repo names are dropped");
        let item = &page.items[0];
        assert_eq!(item.full_name, "o/skills");
        assert_eq!(item.description.as_deref(), Some("Some skills"));
        assert_eq!(item.license.as_deref(), Some("MIT"));
        assert_eq!(item.stars, 1200);
        // Second call: served from the cache.
        let again = search(&m, "mock-search-unique-1", "top", 1).unwrap();
        assert!(again.cached);
        assert_eq!(m.count("search/repositories"), 1);

        let (q2, s2) = build_query("mock-search-unique-2", "best", today).unwrap();
        m.route_resp(
            search_url(&q2, s2, 1),
            HttpResponse {
                status: 403,
                headers: vec![("x-ratelimit-remaining".into(), "0".into()), ("x-ratelimit-reset".into(), "1999999999".into())],
                body: br#"{"message":"API rate limit exceeded"}"#.to_vec(),
            },
        );
        let limited = search(&m, "mock-search-unique-2", "best", 1).unwrap();
        assert!(limited.rate_limited);
        assert_eq!(limited.reset_at, Some(1_999_999_999));
        assert!(limited.items.is_empty());
        let _ = search(&m, "mock-search-unique-2", "best", 1).unwrap();
        assert_eq!(m.count("mock-search-unique-2"), 2, "rate-limited answers are not cached");
    }

    #[test]
    fn inspect_resolves_sha_lists_skills_and_reads_frontmatter() {
        let repo = "mock-owner/inspect-repo";
        let m = mock_pdf_repo(repo);
        m.route(
            repo_api_url(repo),
            200,
            serde_json::json!({ "full_name": repo, "description": "Skills", "stargazers_count": 7, "default_branch": "main",
                "html_url": "https://github.com/mock-owner/inspect-repo", "license": { "spdx_id": "NOASSERTION", "name": "Other" } })
            .to_string(),
        );
        m.route(commit_api_url(repo, "main"), 200, format!("{SHA}\n"));
        let r = inspect(&m, repo, None).unwrap();
        assert_eq!(r.commit_sha, SHA);
        assert_eq!(r.git_ref, "main");
        assert_eq!(r.license.as_deref(), Some("Other"));
        assert_eq!(r.skills.len(), 1);
        let s = &r.skills[0];
        assert_eq!(s.path, "skills/pdf");
        assert_eq!(s.name, "pdf");
        assert_eq!(s.install_name, "pdf");
        assert_eq!(s.description.as_deref(), Some("Work with PDFs"));
        assert_eq!(s.tree_sha, "t-pdf-v1");
        assert!(s.has_scripts);
        assert!(s.skill_md.as_deref().unwrap().contains("# PDF"));
        assert!(r.warnings.is_empty(), "{:?}", r.warnings);
        // Cached: no further API calls.
        let calls = m.calls.lock().len();
        inspect(&m, repo, None).unwrap();
        assert_eq!(m.calls.lock().len(), calls);

        // A commit given as JSON (sha media type ignored) still resolves.
        m.route(commit_api_url(repo, "v1"), 200, format!("{{\"sha\":\"{SHA}\",\"files\":[]}}"));
        assert_eq!(inspect(&m, repo, Some("v1")).unwrap().commit_sha, SHA);

        assert!(matches!(inspect(&m, "mock-owner/missing", None), Err(AppError::NotFound(_))));
        assert!(inspect(&m, "not a repo", None).is_err());
        assert!(inspect(&m, repo, Some("../x")).is_err());

        let f = read_file(&m, repo, SHA, "skills/pdf/scripts/run.ps1").unwrap();
        assert_eq!(f.text, "echo hi");
        assert!(!f.binary);
        assert!(read_file(&m, repo, SHA, "../etc/passwd").is_err());
    }

    #[test]
    fn inspect_rate_limit_is_a_friendly_error() {
        let m = Mock::default();
        m.route_resp(
            repo_api_url("mock-owner/limited"),
            HttpResponse { status: 403, headers: vec![("x-ratelimit-remaining".into(), "0".into())], body: br#"{"message":"API rate limit exceeded"}"#.to_vec() },
        );
        let e = inspect(&m, "mock-owner/limited", None).unwrap_err().to_string();
        assert!(e.contains("limit"), "{e}");
    }

    // ---- install / installed / remove -------------------------------------------------------------

    #[test]
    fn installs_into_targets_with_provenance_and_lock() {
        let repo = "mock-owner/install-repo";
        let m = mock_pdf_repo(repo);
        let p = project();
        let targets = vec![".claude/skills".to_string(), ".agents/skills".to_string()];
        let req = InstallRequest { project_dir: &s(p.path()), repo, commit_sha: SHA, skill_path: "skills/pdf", targets: &targets, replace: false };
        let r = install(&m, &req).unwrap();
        assert_eq!(r.name, "pdf");
        assert_eq!(r.installed, vec![".claude/skills/pdf", ".agents/skills/pdf"]);
        assert!(r.replaced.is_empty());
        assert_eq!(r.files, 3);
        assert!(r.warnings.is_empty(), "{:?}", r.warnings);
        for t in [".claude/skills/pdf", ".agents/skills/pdf"] {
            let d = join_rel(p.path(), t);
            assert!(fs::read_to_string(d.join("SKILL.md")).unwrap().contains("name: pdf"));
            assert_eq!(fs::read_to_string(d.join("references").join("guide.md")).unwrap(), "guide");
            assert_eq!(fs::read_to_string(d.join("scripts").join("run.ps1")).unwrap(), "echo hi");
            let prov: SkillProvenance = serde_json::from_str(&fs::read_to_string(d.join(PROVENANCE_FILE)).unwrap()).unwrap();
            assert_eq!(prov.repo, repo);
            assert_eq!(prov.commit_sha, SHA);
            assert_eq!(prov.path, "skills/pdf");
            assert_eq!(prov.tree_sha.as_deref(), Some("t-pdf-v1"));
        }
        let gk = p.path().join(".gridkeeper");
        assert_eq!(fs::read_to_string(gk.join(".gitignore")).unwrap(), "*\n");
        let lock: serde_json::Value = serde_json::from_str(&fs::read_to_string(gk.join(LOCK_FILE)).unwrap()).unwrap();
        assert_eq!(lock["version"], 1);
        assert_eq!(lock["skills"].as_array().unwrap().len(), 2);
        assert_eq!(lock["skills"][0]["dir"], ".agents/skills/pdf");
        assert_eq!(lock["skills"][0]["commitSha"], SHA);
        let leftovers: Vec<_> = fs::read_dir(gk.join("tmp")).unwrap().collect();
        assert!(leftovers.is_empty(), "staging folders are cleaned up");

        // Again without replace: conflict, nothing touched.
        fs::write(join_rel(p.path(), ".claude/skills/pdf/local-note.md"), "mine").unwrap();
        let e = install(&m, &req).unwrap_err();
        assert_eq!(e.code(), "conflict", "{e}");
        assert!(join_rel(p.path(), ".claude/skills/pdf/local-note.md").exists());

        // Replace: the folder is swapped as a whole.
        let req2 = InstallRequest { replace: true, targets: &targets[..1], ..req };
        let r2 = install(&m, &req2).unwrap();
        assert_eq!(r2.replaced, vec![".claude/skills/pdf"]);
        assert!(!join_rel(p.path(), ".claude/skills/pdf/local-note.md").exists());
        assert!(join_rel(p.path(), ".claude/skills/pdf/SKILL.md").exists());

        // Listed as installed, with provenance.
        let list = installed(&s(p.path())).unwrap();
        assert_eq!(list.len(), 2);
        assert!(list.iter().all(|i| i.name == "pdf" && i.provenance.as_ref().is_some_and(|p| p.commit_sha == SHA)));
        assert_eq!(list[0].target, ".agents/skills");
        assert_eq!(list[0].dir_rel, ".agents/skills/pdf");
        assert_eq!(list[0].file_count, 3, "provenance file not counted");
        assert!(list[0].has_scripts);
    }

    #[test]
    fn install_refuses_bad_requests() {
        let repo = "mock-owner/refuse-repo";
        let m = mock_pdf_repo(repo);
        let p = project();
        let dir = s(p.path());
        let t = vec![".claude/skills".to_string()];
        let base = InstallRequest { project_dir: &dir, repo, commit_sha: SHA, skill_path: "skills/pdf", targets: &t, replace: false };
        assert!(install(&m, &InstallRequest { skill_path: "../skills/pdf", ..base }).is_err());
        assert!(matches!(install(&m, &InstallRequest { skill_path: "skills/none", ..base }), Err(AppError::NotFound(_))));
        let bad_t = vec!["../outside".to_string()];
        assert!(install(&m, &InstallRequest { targets: &bad_t, ..base }).is_err());
        assert!(install(&m, &InstallRequest { commit_sha: "main", ..base }).is_err());
        assert!(install(&m, &InstallRequest { project_dir: "relative", ..base }).is_err());
        assert!(!p.path().join(".claude").exists(), "nothing written");

        // A download failure leaves no partial install.
        let m2 = mock_pdf_repo("mock-owner/broken-repo");
        m2.routes.lock().remove(&raw_url("mock-owner/broken-repo", SHA, "skills/pdf/scripts/run.ps1"));
        let e = install(&m2, &InstallRequest { repo: "mock-owner/broken-repo", ..base }).unwrap_err();
        assert!(matches!(e, AppError::NotFound(_)), "{e}");
        assert!(!p.path().join(".claude").exists());
    }

    #[test]
    fn agent_homes_are_refused() {
        let h = project();
        let home = h.path();
        fs::create_dir_all(home.join(".claude").join("projects")).unwrap();
        fs::create_dir_all(home.join("code").join("app")).unwrap();
        let other = project();
        assert!(agent_home_conflict(home, Some(home), &[]).is_some(), "the user folder itself");
        assert!(agent_home_conflict(&home.join(".claude").join("projects"), Some(home), &[]).is_some());
        assert!(agent_home_conflict(&home.join("code").join("app"), Some(home), &[]).is_none());
        assert!(agent_home_conflict(&home.join("code"), Some(home), &[home.join("code")]).is_some(), "CODEX_HOME etc.");
        assert!(agent_home_conflict(other.path(), Some(home), &[home.join("code")]).is_none());
    }

    #[test]
    fn remove_only_touches_skill_folders() {
        let repo = "mock-owner/remove-repo";
        let m = mock_pdf_repo(repo);
        let p = project();
        let dir = s(p.path());
        let t = vec![".claude/skills".to_string()];
        install(&m, &InstallRequest { project_dir: &dir, repo, commit_sha: SHA, skill_path: "skills/pdf", targets: &t, replace: false }).unwrap();
        fs::create_dir_all(p.path().join("src")).unwrap();
        fs::write(p.path().join("src").join("SKILL.md"), "x").unwrap();
        fs::create_dir_all(join_rel(p.path(), ".claude/skills/notaskill")).unwrap();
        for bad in ["src", "..", "../x", ".claude", ".claude/skills", ".claude/skills/../../src", ".claude/skills/pdf/references", "C:/Windows", "/x", ".claude/other/pdf", ".claude/skills/con"] {
            assert!(remove(&dir, bad).is_err(), "{bad:?}");
        }
        assert!(remove(&dir, ".claude/skills/notaskill").is_err(), "no SKILL.md");
        assert!(matches!(remove(&dir, ".claude/skills/missing"), Err(AppError::NotFound(_))));
        assert!(p.path().join("src").join("SKILL.md").exists());

        remove(&dir, ".claude\\skills\\pdf").unwrap();
        assert!(!join_rel(p.path(), ".claude/skills/pdf").exists());
        assert!(join_rel(p.path(), ".claude/skills").exists(), "only the skill folder is removed");
        let lock: serde_json::Value = serde_json::from_str(&fs::read_to_string(p.path().join(".gridkeeper").join(LOCK_FILE)).unwrap()).unwrap();
        assert!(lock["skills"].as_array().unwrap().is_empty());
        assert!(installed(&dir).unwrap().is_empty());
    }

    #[cfg(windows)]
    fn junction(link: &Path, target: &Path) -> bool {
        let mut cmd = process::hidden_command("cmd.exe");
        cmd.args(["/d", "/c", "mklink", "/J"]).arg(link).arg(target);
        process::run_with_timeout(cmd, Duration::from_secs(10)).is_ok_and(|o| o.status.success())
    }

    #[cfg(windows)]
    #[test]
    fn junctions_are_never_written_through_or_removed() {
        let repo = "mock-owner/junction-repo";
        let m = mock_pdf_repo(repo);
        let p = project();
        let outside = project();
        fs::create_dir_all(outside.path().join("victim")).unwrap();
        fs::write(outside.path().join("victim").join("SKILL.md"), "keep me").unwrap();
        fs::create_dir_all(p.path().join(".claude").join("skills")).unwrap();
        if !junction(&join_rel(p.path(), ".claude/skills/victim"), &outside.path().join("victim")) {
            eprintln!("mklink /J unavailable; skipping");
            return;
        }
        let dir = s(p.path());
        assert!(remove(&dir, ".claude/skills/victim").unwrap_err().to_string().contains("junction"));
        assert!(outside.path().join("victim").join("SKILL.md").exists());
        let list = installed(&dir).unwrap();
        assert!(list.iter().any(|i| i.folder == "victim" && i.is_link));

        // A junctioned .agents folder: install refuses before writing.
        if junction(&p.path().join(".agents"), outside.path()) {
            let t = vec![".agents/skills".to_string()];
            let e = install(&m, &InstallRequest { project_dir: &dir, repo, commit_sha: SHA, skill_path: "skills/pdf", targets: &t, replace: false }).unwrap_err();
            assert!(e.to_string().contains("junction"), "{e}");
            assert!(!outside.path().join("skills").exists());
        }
    }

    #[test]
    fn checks_for_updates() {
        let repo = "mock-owner/update-repo";
        let m = mock_pdf_repo(repo);
        m.route(commit_api_url(repo, "HEAD"), 200, SHA);
        let r = check_update(&m, repo, "skills/pdf", SHA, Some("t-pdf-v1")).unwrap();
        assert_eq!(r.status, SkillUpdateStatus::Current);
        assert_eq!(m.count("/git/trees/"), 0, "same commit: no tree needed");

        // The repository moved on; the skill folder did not.
        m.route(commit_api_url(repo, "HEAD"), 200, SHA2);
        m.route(
            tree_api_url(repo, SHA2),
            200,
            tree_json("root2", &[("skills/pdf", "tree", "t-pdf-v1", 0), ("skills/pdf/SKILL.md", "blob", "a", 60), ("other/SKILL.md", "blob", "z", 1)]),
        );
        assert_eq!(check_update(&m, repo, "skills/pdf", SHA, Some("t-pdf-v1")).unwrap().status, SkillUpdateStatus::Current);
        assert_eq!(check_update(&m, repo, "skills/pdf", SHA, Some("t-pdf-v0")).unwrap().status, SkillUpdateStatus::Update);
        assert_eq!(check_update(&m, repo, "skills/pdf", SHA, None).unwrap().status, SkillUpdateStatus::Update);
        let gone = check_update(&m, repo, "skills/gone", SHA, None).unwrap();
        assert_eq!(gone.status, SkillUpdateStatus::Missing);
        assert_eq!(gone.current_sha, SHA2);
        assert!(check_update(&m, repo, "../x", SHA, None).is_err());
    }

    #[test]
    fn parallel_map_keeps_order() {
        let items: Vec<u32> = (0..50).collect();
        let out = parallel_map(&items, 6, |i| i * 2);
        assert_eq!(out, items.iter().map(|i| i * 2).collect::<Vec<_>>());
        assert!(parallel_map(&Vec::<u32>::new(), 6, |i| *i).is_empty());
    }

    // ---- real network (manual) --------------------------------------------------------------------

    #[test]
    #[ignore = "real network: cargo test --lib skills -- --ignored --nocapture"]
    fn live_github_shapes() {
        let f = CurlFetcher;
        let found = search(&f, "diagram", "best", 1).unwrap();
        eprintln!("search {:?}: total {} first {:?}", found.query, found.total, found.items.iter().take(3).map(|r| &r.full_name).collect::<Vec<_>>());
        let page = search(&f, "", "trending", 1).unwrap();
        eprintln!("trending: total {} first {:?}", page.total, page.items.iter().take(5).map(|r| (&r.full_name, r.stars)).collect::<Vec<_>>());
        assert!(page.rate_limited || !page.items.is_empty());

        let r = inspect(&f, "anthropics/skills", None).unwrap();
        eprintln!("anthropics/skills @ {} ({}): {} skills, warnings {:?}", r.commit_sha, r.git_ref, r.skills.len(), r.warnings);
        for s in r.skills.iter().take(5) {
            eprintln!("  {} [{}] {} files, scripts {}, {:?}", s.name, s.path, s.files.len(), s.has_scripts, s.description.as_deref().map(|d| d.chars().take(60).collect::<String>()));
        }
        assert!(!r.skills.is_empty());
        let head = check_update(&f, "anthropics/skills", &r.skills[0].path, &r.commit_sha, Some(&r.skills[0].tree_sha)).unwrap();
        eprintln!("update check via HEAD: {:?}", head.status);
        assert_eq!(head.current_sha, r.commit_sha);
        let mine = inspect(&f, "raazi29/gridkeeper", None).unwrap();
        eprintln!("raazi29/gridkeeper: {:?}", mine.skills.iter().map(|s| (&s.name, &s.path)).collect::<Vec<_>>());
    }
}
