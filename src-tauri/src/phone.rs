//! Phone alerts (opt-in): a short, generic push notification to the user's phone through ntfy
//! (<https://ntfy.sh> or a self-hosted server) when an agent needs them.
//!
//! Network: off by default. Nothing is sent until the user turns phone alerts on (or presses "Send
//! test") in Settings › Notifications; then one HTTPS POST per alert, to the server the user chose,
//! and nothing else (no polling, no retries). This is the third exception to ADR-018, after the
//! browser-pane probe and the Skills panel (docs/TECHNICAL_DECISIONS.md, ADR-020).
//!
//! Privacy model:
//! - The frontend (`src/lib/phoneAlerts.ts`) decides *whether* an event qualifies (event filter, Do not
//!   disturb, muted panes, phone quiet hours, minimum priority) and builds generic text: a pane name, a
//!   workspace name, a fixed sentence. Never terminal output; task names / the mission goal only when
//!   the user turned "include task names" on.
//! - Rust re-checks the switches, then scrubs every field again ([`sanitize_text`]: URLs, e-mail
//!   addresses, Windows / Unix paths, control characters, then [`crate::redact::redact`]) and caps lengths.
//! - Settings live in `<data_dir>/phone-alerts.json`, not in `workspaces.json`, so the topic (which acts
//!   as a password on a public server) never lands in a diagnostics bundle. The topic and the token are
//!   never logged; errors are scrubbed of both.
//! - The access token is write-only from the UI (the frontend only learns `hasToken`). Windows: Credential
//!   Manager (generic credential, `CredWriteW`, through the existing `windows-sys` dependency). macOS /
//!   Linux: `<data_dir>/phone-alerts.token` with mode 0600 (no keychain integration yet; the UI says so).
//!
//! Delivery: the system curl (same as `skills.rs`: an argument array, never a shell, `-q` first). The URL,
//! headers (including `Authorization`) and the JSON body go through a curl config on **stdin** (`-K -`),
//! so the token never appears on a command line; `--proto` limits the scheme, no redirects are followed,
//! timeouts cap the process. Rate limits ([`RateLimiter`]): one alert per key (≈ per pane) per 2 minutes,
//! at most 10 per rolling hour, suppressed alerts are counted into the next one ("+3 more"). A failure
//! pauses sending for a minute (an HTTP 429 for 10 minutes); nothing is ever retried.

use std::collections::{HashMap, VecDeque};
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use regex::Regex;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::adapters::process;
use crate::state::AppCtx;
use crate::types::{AppError, AppResult};

pub const DEFAULT_SERVER: &str = "https://ntfy.sh";
pub const CONFIG_FILE: &str = "phone-alerts.json";
#[cfg(not(windows))]
pub const TOKEN_FILE: &str = "phone-alerts.token";
/// One alert per key (pane, project folder) per 2 minutes.
pub const PER_KEY_GAP_MS: u64 = 2 * 60 * 1000;
/// At most this many alerts per rolling hour (ntfy.sh allows 250 messages a day per visitor).
pub const HOURLY_MAX: usize = 10;
pub const HOUR_MS: u64 = 60 * 60 * 1000;
/// After a failed send nothing is attempted for this long.
pub const FAILURE_PAUSE_MS: u64 = 60 * 1000;
/// After an HTTP 429 from the server.
pub const RATE_LIMITED_PAUSE_MS: u64 = 10 * 60 * 1000;
/// "Send test" at most this often.
pub const TEST_GAP_MS: u64 = 5 * 1000;
pub const MAX_TITLE: usize = 120;
pub const MAX_MESSAGE: usize = 240;
pub const MAX_SERVER_LEN: usize = 200;
pub const MAX_TOPIC_LEN: usize = 64;
const MAX_TAGS: usize = 4;
const MAX_KEY_LEN: usize = 300;
const PROCESS_TIMEOUT: Duration = Duration::from_secs(20);
const RESPONSE_CAP: usize = 64 * 1024;
const KINDS: &[&str] = &["needsInput", "error", "done", "proposal", "missionDone"];

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/// Which events reach the phone.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PhoneEvents {
    /// Permission prompts, questions, "waiting for you", terminal bells.
    pub needs_input: bool,
    pub error: bool,
    /// Lead control: a proposal waits for approval.
    pub proposal: bool,
    /// Every task of a mission is checked off.
    pub mission_done: bool,
    /// A pane went quiet after working (noisy; off by default).
    pub done: bool,
}

impl Default for PhoneEvents {
    fn default() -> Self {
        Self { needs_input: true, error: true, proposal: true, mission_done: true, done: false }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PhoneQuietHours {
    pub enabled: bool,
    /// "HH:MM", local time; the range may cross midnight.
    pub start: String,
    pub end: String,
}

impl Default for PhoneQuietHours {
    fn default() -> Self {
        Self { enabled: false, start: "22:00".into(), end: "07:00".into() }
    }
}

/// `<data_dir>/phone-alerts.json`. Mirrored by `PhoneConfig` in `src/lib/phoneAlerts.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PhoneConfig {
    pub enabled: bool,
    /// ntfy server base URL, no trailing slash.
    pub server: String,
    /// Empty until generated (turning phone alerts on, or "New topic").
    pub topic: String,
    pub events: PhoneEvents,
    /// 1 (min) … 5 (max); alerts below it are not sent.
    pub min_priority: u8,
    pub quiet_hours: PhoneQuietHours,
    /// Pane and workspace names in the text ("builder-1 needs you · OAuth demo").
    pub include_names: bool,
    /// Task names and the mission goal in the text (off by default).
    pub include_task_names: bool,
    /// Only while the Gridkeeper window is in the background.
    pub only_when_away: bool,
}

impl Default for PhoneConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            server: DEFAULT_SERVER.into(),
            topic: String::new(),
            events: PhoneEvents::default(),
            min_priority: 3,
            quiet_hours: PhoneQuietHours::default(),
            include_names: true,
            include_task_names: false,
            only_when_away: true,
        }
    }
}

static TOPIC_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[A-Za-z0-9_-]{1,64}$").expect("topic regex"));
static TOKEN_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^tk_[A-Za-z0-9]{8,64}$").expect("token regex"));
static HHMM_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^([01]?\d|2[0-3]):[0-5]\d$").expect("hhmm regex"));

/// Hosts where plain `http://` is accepted (a self-hosted server on this machine or the local network).
pub fn is_private_host(host: &str) -> bool {
    let h = host.to_ascii_lowercase();
    if h == "localhost" || [".localhost", ".local", ".lan", ".home.arpa", ".internal"].iter().any(|s| h.ends_with(s)) {
        return true;
    }
    if let Some(v6) = h.strip_prefix('[').and_then(|r| r.strip_suffix(']')) {
        return v6 == "::1" || v6.starts_with("fc") || v6.starts_with("fd") || v6.starts_with("fe80:");
    }
    let parts: Vec<u8> = h.split('.').filter_map(|p| p.parse().ok()).collect();
    if parts.len() != 4 || h.split('.').count() != 4 {
        return false;
    }
    matches!(
        (parts[0], parts[1]),
        (127, _) | (10, _) | (192, 168) | (169, 254)
    ) || (parts[0] == 172 && (16..=31).contains(&parts[1]))
        || (parts[0] == 100 && (64..=127).contains(&parts[1]))
}

/// A normalized server URL (`https://host[:port][/path]`, no trailing slash), or why it is refused.
/// The character whitelist also keeps the value safe inside a quoted curl config string.
pub fn validate_server(raw: &str) -> Result<String, String> {
    let s = raw.trim().trim_end_matches('/');
    if s.is_empty() {
        return Err("Enter the ntfy server address, e.g. https://ntfy.sh".into());
    }
    if s.len() > MAX_SERVER_LEN {
        return Err(format!("The server address is longer than {MAX_SERVER_LEN} characters"));
    }
    let (rest, http) = if let Some(r) = s.strip_prefix("https://") {
        (r, false)
    } else if let Some(r) = s.strip_prefix("http://") {
        (r, true)
    } else {
        return Err("The server address must start with https://".into());
    };
    if !rest.bytes().all(|b| b.is_ascii_alphanumeric() || b"-._~:/[]%".contains(&b)) {
        return Err("The server address may only contain letters, digits and - . _ ~ : / (no spaces, ?, # or user names)".into());
    }
    let (authority, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, ""),
    };
    if path.contains("//") || path.contains("/../") || path.ends_with("/..") || path.contains(':') || path.contains('[') || path.contains(']') {
        return Err("The server address has an unusual path".into());
    }
    let (host, port) = if authority.starts_with('[') {
        match authority.find(']') {
            Some(i) => (&authority[..=i], authority[i + 1..].strip_prefix(':')),
            None => return Err("The server address has a malformed IPv6 host".into()),
        }
    } else {
        match authority.rsplit_once(':') {
            Some((h, p)) => (h, Some(p)),
            None => (authority, None),
        }
    };
    let host_ok = if host.starts_with('[') {
        host.len() > 2 && host[1..host.len() - 1].bytes().all(|b| b.is_ascii_hexdigit() || b == b':')
    } else {
        !host.is_empty()
            && host.split('.').all(|l| !l.is_empty() && !l.starts_with('-') && !l.ends_with('-'))
            && host.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'.')
    };
    if !host_ok {
        return Err("The server address has an invalid host name".into());
    }
    if let Some(p) = port
        && (p.is_empty() || p.len() > 5 || !p.bytes().all(|b| b.is_ascii_digit()) || p.parse::<u32>().map_or(true, |n| n == 0 || n > 65535))
    {
        return Err("The server address has an invalid port".into());
    }
    if http && !is_private_host(host) {
        return Err("Plain http:// is only allowed for servers on this computer or your local network; use https://".into());
    }
    Ok(s.to_string())
}

pub fn validate_topic(raw: &str) -> Result<String, String> {
    let t = raw.trim();
    if TOPIC_RE.is_match(t) {
        Ok(t.to_string())
    } else {
        Err("A topic is 1–64 letters, digits, - or _".into())
    }
}

pub fn validate_token(raw: &str) -> Result<String, String> {
    let t = raw.trim();
    if TOKEN_RE.is_match(t) {
        Ok(t.to_string())
    } else {
        Err("An ntfy access token looks like tk_ followed by letters and digits (create one with `ntfy token add`)".into())
    }
}

/// Validate and normalize settings the UI sends. An empty topic is allowed while phone alerts are off.
pub fn validate_config(cfg: &PhoneConfig) -> Result<PhoneConfig, String> {
    let mut out = cfg.clone();
    out.server = validate_server(&cfg.server)?;
    out.topic = if cfg.topic.trim().is_empty() { String::new() } else { validate_topic(&cfg.topic)? };
    if out.enabled && out.topic.is_empty() {
        return Err("Generate a topic before turning phone alerts on".into());
    }
    if !(1..=5).contains(&cfg.min_priority) {
        return Err("The minimum priority is 1 (min) to 5 (max)".into());
    }
    for v in [&cfg.quiet_hours.start, &cfg.quiet_hours.end] {
        if !HHMM_RE.is_match(v.trim()) {
            return Err("Quiet hours need times as HH:MM".into());
        }
    }
    out.quiet_hours.start = cfg.quiet_hours.start.trim().to_string();
    out.quiet_hours.end = cfg.quiet_hours.end.trim().to_string();
    Ok(out)
}

/// A new random topic: `gk-` + 24 base62 characters (≈ 143 bits), from the OS random source (uuid v4).
pub fn new_topic() -> String {
    const ALPHABET: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    let mut out = String::from("gk-");
    while out.len() < 3 + 24 {
        let bytes = *uuid::Uuid::new_v4().as_bytes();
        for (i, b) in bytes.iter().enumerate() {
            // Bytes 6 and 8 carry the uuid version / variant bits; 248.. would bias the modulo.
            if i == 6 || i == 8 || *b >= 248 || out.len() >= 3 + 24 {
                continue;
            }
            out.push(ALPHABET[(*b % 62) as usize] as char);
        }
    }
    out
}

/// The saved settings (defaults when missing or damaged). Never writes.
pub fn load_config(data_dir: &Path) -> PhoneConfig {
    let path = data_dir.join(CONFIG_FILE);
    let Ok(text) = std::fs::read_to_string(&path) else { return PhoneConfig::default() };
    match serde_json::from_str::<PhoneConfig>(&text) {
        Ok(c) => match validate_config(&c) {
            Ok(v) => v,
            // Hand-edited into something invalid: keep it off until the user fixes it in Settings.
            Err(_) => PhoneConfig { enabled: false, ..c },
        },
        Err(_) => PhoneConfig::default(),
    }
}

pub fn save_config(data_dir: &Path, cfg: &PhoneConfig) -> AppResult<()> {
    let json = serde_json::to_string_pretty(cfg).map_err(|e| AppError::Other(e.to_string()))?;
    crate::persistence::atomic_write(&data_dir.join(CONFIG_FILE), json.as_bytes(), false)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Access token storage
// ---------------------------------------------------------------------------

/// Where the token lives on this OS (shown in the UI).
pub fn token_storage() -> &'static str {
    if cfg!(windows) { "credentialManager" } else { "file" }
}

#[cfg(windows)]
fn credential_target() -> String {
    match crate::sandbox::name() {
        Some(n) => format!("Gridkeeper/phone-alerts/ntfy-token/sandbox-{n}"),
        None => "Gridkeeper/phone-alerts/ntfy-token".into(),
    }
}

#[cfg(windows)]
mod cred {
    use windows_sys::Win32::Foundation::{ERROR_NOT_FOUND, GetLastError};
    use windows_sys::Win32::Security::Credentials::{
        CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC, CREDENTIALW, CredDeleteW, CredFree, CredReadW, CredWriteW,
    };

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(Some(0)).collect()
    }

    pub fn read(target: &str) -> Result<Option<String>, String> {
        let t = wide(target);
        let mut p: *mut CREDENTIALW = std::ptr::null_mut();
        // SAFETY: `t` is NUL-terminated and outlives the call; `p` receives a buffer we free below.
        let ok = unsafe { CredReadW(t.as_ptr(), CRED_TYPE_GENERIC, 0, &mut p) };
        if ok == 0 || p.is_null() {
            // SAFETY: plain FFI call.
            let e = unsafe { GetLastError() };
            return if e == ERROR_NOT_FOUND { Ok(None) } else { Err(format!("Credential Manager read failed (error {e})")) };
        }
        // SAFETY: CredReadW succeeded, so `p` points to a valid CREDENTIALW whose blob has
        // `CredentialBlobSize` bytes; it stays valid until CredFree.
        let bytes = unsafe {
            let c = &*p;
            if c.CredentialBlob.is_null() || c.CredentialBlobSize == 0 {
                Vec::new()
            } else {
                std::slice::from_raw_parts(c.CredentialBlob, c.CredentialBlobSize as usize).to_vec()
            }
        };
        // SAFETY: `p` came from CredReadW.
        unsafe { CredFree(p as *const core::ffi::c_void) };
        Ok(String::from_utf8(bytes).ok().filter(|s| !s.is_empty()))
    }

    pub fn write(target: &str, secret: &str) -> Result<(), String> {
        let t = wide(target);
        let user = wide("gridkeeper");
        let mut blob = secret.as_bytes().to_vec();
        // SAFETY: an all-zero CREDENTIALW is a valid "empty" value (null pointers, zero sizes).
        let mut c: CREDENTIALW = unsafe { std::mem::zeroed() };
        c.Type = CRED_TYPE_GENERIC;
        c.TargetName = t.as_ptr() as *mut u16;
        c.UserName = user.as_ptr() as *mut u16;
        c.CredentialBlobSize = blob.len() as u32;
        c.CredentialBlob = blob.as_mut_ptr();
        c.Persist = CRED_PERSIST_LOCAL_MACHINE;
        // SAFETY: every pointer in `c` refers to a live local buffer for the duration of the call.
        let ok = unsafe { CredWriteW(&c, 0) };
        blob.iter_mut().for_each(|b| *b = 0);
        if ok == 0 {
            // SAFETY: plain FFI call.
            let e = unsafe { GetLastError() };
            return Err(format!("Credential Manager write failed (error {e})"));
        }
        Ok(())
    }

    pub fn delete(target: &str) -> Result<(), String> {
        let t = wide(target);
        // SAFETY: `t` is NUL-terminated and outlives the call.
        let ok = unsafe { CredDeleteW(t.as_ptr(), CRED_TYPE_GENERIC, 0) };
        if ok == 0 {
            // SAFETY: plain FFI call.
            let e = unsafe { GetLastError() };
            if e != ERROR_NOT_FOUND {
                return Err(format!("Credential Manager delete failed (error {e})"));
            }
        }
        Ok(())
    }
}

/// The stored access token, if any. Never sent to the frontend.
pub fn token_load(data_dir: &Path) -> Option<String> {
    #[cfg(windows)]
    {
        let _ = data_dir;
        match cred::read(&credential_target()) {
            Ok(t) => t,
            Err(e) => {
                tracing::warn!(error = %e, "phone alerts: could not read the access token");
                None
            }
        }
    }
    #[cfg(not(windows))]
    {
        std::fs::read_to_string(data_dir.join(TOKEN_FILE)).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
    }
}

/// Store (Some) or remove (None) the access token.
pub fn token_save(data_dir: &Path, token: Option<&str>) -> AppResult<()> {
    #[cfg(windows)]
    {
        let _ = data_dir;
        let target = credential_target();
        match token {
            Some(t) => cred::write(&target, t),
            None => cred::delete(&target),
        }
        .map_err(AppError::Other)
    }
    #[cfg(not(windows))]
    {
        let path = data_dir.join(TOKEN_FILE);
        match token {
            None => match std::fs::remove_file(&path) {
                Ok(()) => Ok(()),
                Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
                Err(e) => Err(e.into()),
            },
            Some(t) => {
                use std::io::Write;
                use std::os::unix::fs::OpenOptionsExt;
                std::fs::create_dir_all(data_dir)?;
                let tmp = data_dir.join(format!("{TOKEN_FILE}.tmp"));
                let _ = std::fs::remove_file(&tmp);
                let mut f = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&tmp)?;
                f.write_all(t.as_bytes())?;
                f.sync_all()?;
                drop(f);
                std::fs::rename(&tmp, &path)?;
                Ok(())
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

static URL_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)\b[a-z][a-z0-9+.\-]*://\S+").expect("url regex"));
static EMAIL_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)*\.[A-Za-z]{2,}").expect("email regex"));
/// `C:\x`, `C:/x`, `\\server\share`.
static WIN_PATH_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r#"(?i)(?:\b[a-z]:[\\/]|\\\\)[^\s"'<>|]*"#).expect("win path regex"));
/// `/home/x`, `~/x`, `./a/b`, `src\a\b`: at least two separators, or a leading root / home / dot.
static POSIX_PATH_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"(?:^|[\s(\["'=:,])((?:~|\.{1,2})?/[^\s/"']+/[^\s"']*|~/[^\s"']*|[\w.\-]+(?:[\\/][\w.\-]+){2,}|[\w.\-]+(?:\\[\w.\-]+)+)"#)
        .expect("posix path regex")
});
const ELLIPSIS: &str = "…";

/// Generic, safe text: control characters gone, whitespace collapsed, URLs / e-mail addresses / paths
/// replaced by "…", secrets redacted, at most `max` characters.
pub fn sanitize_text(raw: &str, max: usize) -> String {
    let cleaned: String = raw.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    let s = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let s = URL_RE.replace_all(&s, ELLIPSIS);
    let s = EMAIL_RE.replace_all(&s, ELLIPSIS);
    let s = WIN_PATH_RE.replace_all(&s, ELLIPSIS);
    let s = POSIX_PATH_RE.replace_all(&s, |c: &regex::Captures| {
        let whole = &c[0];
        let path = &c[1];
        format!("{}{ELLIPSIS}", &whole[..whole.len() - path.len()])
    });
    let s = crate::redact::redact(&s);
    truncate_chars(s.trim(), max)
}

fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max.saturating_sub(1)).collect();
    out.push_str(ELLIPSIS);
    out
}

/// What the frontend asks to send (already generic; re-sanitized here).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhoneAlert {
    /// Rate-limit key ("s:<session id>", "p:<folder>", "m:<folder>"). Never sent anywhere.
    pub key: String,
    /// "needsInput" | "error" | "done" | "proposal" | "missionDone".
    pub kind: String,
    pub title: String,
    pub message: String,
    /// 1 … 5.
    pub priority: u8,
    #[serde(default)]
    pub tags: Vec<String>,
}

/// The JSON body for ntfy's JSON publishing (`POST <server>/` with the topic inside).
pub fn build_body(topic: &str, title: &str, message: &str, priority: u8, tags: &[String]) -> String {
    let tags: Vec<String> = tags
        .iter()
        .filter(|t| !t.is_empty() && t.len() <= 32 && t.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-'))
        .take(MAX_TAGS)
        .cloned()
        .collect();
    let mut message = sanitize_text(message, MAX_MESSAGE);
    if message.is_empty() {
        message = "Open Gridkeeper.".into();
    }
    serde_json::json!({
        "topic": topic,
        "title": sanitize_text(title, MAX_TITLE),
        "message": message,
        "priority": priority.clamp(1, 5),
        "tags": tags,
    })
    .to_string()
}

fn kind_enabled(kind: &str, e: &PhoneEvents) -> bool {
    match kind {
        "needsInput" => e.needs_input,
        "error" => e.error,
        "done" => e.done,
        "proposal" => e.proposal,
        "missionDone" => e.mission_done,
        _ => false,
    }
}

// ---------------------------------------------------------------------------
// curl
// ---------------------------------------------------------------------------

/// One prepared POST. `token` is only ever written to curl's stdin.
#[derive(Debug, Clone)]
pub struct PreparedRequest {
    /// Validated server URL + "/".
    pub url: String,
    pub body: String,
    pub token: Option<String>,
}

/// Escape a value for a double-quoted curl config string (`\\`, `\"`, `\n`, `\r`, `\t`).
pub fn curl_quote(v: &str) -> String {
    let mut out = String::with_capacity(v.len() + 2);
    out.push('"');
    for c in v.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c.is_control() => {}
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// The fixed command line. Everything request-specific goes into the config on stdin.
pub fn curl_args(url: &str) -> Vec<&'static str> {
    let proto = if url.starts_with("http://") { "=http,https" } else { "=https" };
    // `-q` must come first: it disables ~/.curlrc. No `-L`: a redirect is never followed (it could
    // carry the Authorization header elsewhere).
    vec![
        "-q", "-sS", "-i", "--max-redirs", "0", "--connect-timeout", "6", "--max-time", "12", "--proto", proto, "-K", "-",
    ]
}

/// The curl config fed on stdin: URL, headers and the body (`data-raw`: a leading `@` is never read as a file).
pub fn curl_config(req: &PreparedRequest) -> String {
    let mut lines = vec![
        format!("url = {}", curl_quote(&req.url)),
        format!("header = {}", curl_quote("Content-Type: application/json")),
        format!("header = {}", curl_quote("User-Agent: Gridkeeper")),
    ];
    if let Some(t) = &req.token {
        lines.push(format!("header = {}", curl_quote(&format!("Authorization: Bearer {t}"))));
    }
    lines.push(format!("data-raw = {}", curl_quote(&req.body)));
    let mut s = lines.join("\n");
    s.push('\n');
    s
}

/// Sends one request; returns the HTTP status and body, or a (generic) error. Injected so tests never
/// touch the network.
pub trait Transport: Send + Sync {
    fn post(&self, req: &PreparedRequest) -> Result<(u16, Vec<u8>), String>;
}

pub struct CurlTransport;

#[cfg(windows)]
fn curl_exe() -> Option<PathBuf> {
    let sys = std::env::var_os("SystemRoot").map(|r| PathBuf::from(r).join("System32").join("curl.exe"));
    sys.filter(|p| p.is_file()).or_else(|| which::which("curl.exe").ok())
}

#[cfg(not(windows))]
fn curl_exe() -> Option<PathBuf> {
    let sys = PathBuf::from("/usr/bin/curl");
    if sys.is_file() { Some(sys) } else { which::which("curl").ok() }
}

fn curl_error(code: Option<i32>) -> String {
    match code {
        Some(5) | Some(6) => "Could not reach the ntfy server (host not found: are you offline?)".into(),
        Some(7) => "Could not connect to the ntfy server".into(),
        Some(28) => "The ntfy server did not answer in time".into(),
        Some(35) | Some(60) => "TLS error while talking to the ntfy server".into(),
        Some(47) => "The ntfy server answered with a redirect (use its final address)".into(),
        Some(c) => format!("The request failed (curl exit code {c})"),
        None => "The request failed (no response)".into(),
    }
}

impl Transport for CurlTransport {
    fn post(&self, req: &PreparedRequest) -> Result<(u16, Vec<u8>), String> {
        // The URL was validated; re-check the scheme so nothing else can ever reach curl.
        if !(req.url.starts_with("https://") || req.url.starts_with("http://")) {
            return Err("Invalid server address".into());
        }
        let curl = curl_exe().ok_or_else(|| "curl was not found on this system".to_string())?;
        let mut cmd = process::hidden_command(curl);
        cmd.args(curl_args(&req.url));
        let out = match process::run_capped_with_input(cmd, PROCESS_TIMEOUT, RESPONSE_CAP, curl_config(req).into_bytes()) {
            Ok(o) => o,
            Err(e) if e.kind() == io::ErrorKind::TimedOut => return Err("The ntfy server did not answer in time".into()),
            Err(_) => return Err("Could not run curl".into()),
        };
        match crate::skills::parse_curl_output(&out.stdout) {
            Some(r) => Ok((r.status, r.body)),
            None => Err(curl_error(out.status.and_then(|s| s.code()))),
        }
    }
}

// ---------------------------------------------------------------------------
// Rate limiting and status
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Gate {
    /// Send; `coalesced` alerts were suppressed since the last one that went out.
    Allow { coalesced: u32 },
    PerKey,
    Hourly,
    Paused,
}

#[derive(Debug, Default)]
pub struct RateLimiter {
    last_by_key: HashMap<String, u64>,
    sent: VecDeque<u64>,
    suppressed: u32,
    paused_until: u64,
}

impl RateLimiter {
    /// Decide and, when allowed, record the send (before it happens: a failure still uses the slot).
    /// `user_initiated` ("Send test") skips the per-key gap, the hourly cap and a failure pause.
    pub fn check(&mut self, key: &str, now: u64, user_initiated: bool) -> Gate {
        while self.sent.front().is_some_and(|&t| now.saturating_sub(t) >= HOUR_MS) {
            self.sent.pop_front();
        }
        self.last_by_key.retain(|_, t| now.saturating_sub(*t) < PER_KEY_GAP_MS);
        if !user_initiated {
            let gate = if now < self.paused_until {
                Some(Gate::Paused)
            } else if self.last_by_key.contains_key(key) {
                Some(Gate::PerKey)
            } else if self.sent.len() >= HOURLY_MAX {
                Some(Gate::Hourly)
            } else {
                None
            };
            if let Some(g) = gate {
                self.suppressed = self.suppressed.saturating_add(1);
                return g;
            }
            self.last_by_key.insert(key.chars().take(MAX_KEY_LEN).collect(), now);
        }
        self.sent.push_back(now);
        Gate::Allow { coalesced: if user_initiated { 0 } else { std::mem::take(&mut self.suppressed) } }
    }

    pub fn pause(&mut self, now: u64, ms: u64) {
        self.paused_until = self.paused_until.max(now + ms);
    }

    pub fn paused_until(&self, now: u64) -> Option<u64> {
        (self.paused_until > now).then_some(self.paused_until)
    }

    pub fn suppressed(&self) -> u32 {
        self.suppressed
    }
}

/// Shown in Settings and Diagnostics. Errors are generic and scrubbed of the topic and the token.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhoneStatus {
    pub sent: u32,
    pub failures: u32,
    /// Alerts held back by the rate limits since the app started.
    pub suppressed: u32,
    pub last_sent_ms: Option<u64>,
    pub last_error: Option<String>,
    pub last_error_ms: Option<u64>,
    /// The last attempt failed (cleared by the next success).
    pub failing: bool,
    pub paused_until_ms: Option<u64>,
}

#[derive(Debug, Default)]
pub struct Hub {
    pub limiter: RateLimiter,
    pub status: PhoneStatus,
    last_test_ms: u64,
}

static HUB: Lazy<Mutex<Hub>> = Lazy::new(|| Mutex::new(Hub::default()));

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// What happened to one alert.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PhoneSendResult {
    /// "sent" | "skipped" (off / filtered) | "rateLimited" | "paused" | "failed".
    pub outcome: String,
    pub detail: Option<String>,
    /// This failure follows a success (or is the first one): the UI tells the user once.
    pub first_failure: bool,
}

impl PhoneSendResult {
    fn of(outcome: &str, detail: Option<String>) -> Self {
        Self { outcome: outcome.into(), detail, first_failure: false }
    }
}

/// Remove the topic and the token from a message, then redact.
fn scrub(msg: &str, topic: &str, token: Option<&str>) -> String {
    let mut s = msg.to_string();
    if !topic.is_empty() {
        s = s.replace(topic, "<topic>");
    }
    if let Some(t) = token.filter(|t| !t.is_empty()) {
        s = s.replace(t, crate::redact::MASK);
    }
    crate::redact::redact(&s)
}

/// HTTP status → Ok, or a user-facing reason plus how long to pause.
pub fn classify(status: u16, body: &[u8]) -> Result<(), (String, u64)> {
    if (200..300).contains(&status) {
        return Ok(());
    }
    let server_says = serde_json::from_slice::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(|e| sanitize_text(e, 160)))
        .filter(|e| !e.is_empty());
    let base = match status {
        401 | 403 => format!("The ntfy server refused the alert (HTTP {status}): check the access token, or whether the topic is reserved"),
        413 => "The ntfy server rejected the alert as too large (HTTP 413)".into(),
        429 => "The ntfy server's rate limit was reached (HTTP 429); phone alerts pause for 10 minutes".into(),
        s if s >= 500 => format!("The ntfy server had an error (HTTP {s})"),
        s => format!("The ntfy server answered HTTP {s}"),
    };
    let msg = match server_says {
        Some(e) => format!("{base}: {e}"),
        None => base,
    };
    Err((msg, if status == 429 { RATE_LIMITED_PAUSE_MS } else { FAILURE_PAUSE_MS }))
}

fn deliver(hub: &Mutex<Hub>, transport: &dyn Transport, req: PreparedRequest, topic: &str, now: u64) -> PhoneSendResult {
    let token = req.token.clone();
    let result = transport.post(&req).map_err(|e| (e, FAILURE_PAUSE_MS)).and_then(|(status, body)| classify(status, &body));
    let mut h = hub.lock();
    match result {
        Ok(()) => {
            if h.status.failing {
                tracing::info!("phone alerts: delivery works again");
            }
            h.status.sent += 1;
            h.status.last_sent_ms = Some(now);
            h.status.failing = false;
            h.status.paused_until_ms = None;
            PhoneSendResult::of("sent", None)
        }
        Err((msg, pause)) => {
            let msg = scrub(&msg, topic, token.as_deref());
            let first = !h.status.failing;
            if first {
                tracing::warn!(error = %msg, "phone alert failed");
            }
            h.status.failures += 1;
            h.status.failing = true;
            h.status.last_error = Some(msg.clone());
            h.status.last_error_ms = Some(now);
            h.limiter.pause(now, pause);
            h.status.paused_until_ms = h.limiter.paused_until(now);
            PhoneSendResult { outcome: "failed".into(), detail: Some(msg), first_failure: first }
        }
    }
}

/// One alert from the attention pipeline: switches, rate limits, sanitize, send.
/// `token` is only called when a request is actually made (it reads the credential store).
pub fn send_alert(data_dir: &Path, hub: &Mutex<Hub>, transport: &dyn Transport, alert: &PhoneAlert, token: &dyn Fn() -> Option<String>, now: u64) -> PhoneSendResult {
    let cfg = load_config(data_dir);
    if !cfg.enabled || cfg.topic.is_empty() {
        return PhoneSendResult::of("skipped", Some("Phone alerts are off".into()));
    }
    if !KINDS.contains(&alert.kind.as_str()) || !kind_enabled(&alert.kind, &cfg.events) {
        return PhoneSendResult::of("skipped", Some("This event is off".into()));
    }
    if alert.priority.clamp(1, 5) < cfg.min_priority {
        return PhoneSendResult::of("skipped", Some("Below the minimum priority".into()));
    }
    let gate = {
        let mut h = hub.lock();
        let g = h.limiter.check(&alert.key, now, false);
        if !matches!(g, Gate::Allow { .. }) {
            h.status.suppressed += 1;
        }
        g
    };
    let coalesced = match gate {
        Gate::Allow { coalesced } => coalesced,
        Gate::Paused => return PhoneSendResult::of("paused", Some("Paused after a failed alert".into())),
        Gate::PerKey | Gate::Hourly => return PhoneSendResult::of("rateLimited", None),
    };
    let mut message = alert.message.clone();
    if coalesced > 0 {
        message.push_str(&format!(" (+{coalesced} more since the last alert)"));
    }
    let req = PreparedRequest {
        url: format!("{}/", cfg.server),
        body: build_body(&cfg.topic, &alert.title, &message, alert.priority, &alert.tags),
        token: token(),
    };
    deliver(hub, transport, req, &cfg.topic, now)
}

/// "Send test": uses the saved server / topic / token even while phone alerts are off.
pub fn send_test(data_dir: &Path, hub: &Mutex<Hub>, transport: &dyn Transport, token: &dyn Fn() -> Option<String>, now: u64) -> PhoneSendResult {
    let cfg = load_config(data_dir);
    if cfg.topic.is_empty() {
        return PhoneSendResult::of("skipped", Some("Generate a topic first".into()));
    }
    {
        let mut h = hub.lock();
        if h.last_test_ms != 0 && now.saturating_sub(h.last_test_ms) < TEST_GAP_MS {
            return PhoneSendResult::of("rateLimited", Some("Wait a few seconds between tests".into()));
        }
        h.last_test_ms = now;
        h.limiter.check("test", now, true);
    }
    let req = PreparedRequest {
        url: format!("{}/", cfg.server),
        body: build_body(
            &cfg.topic,
            "Gridkeeper test alert",
            "Phone alerts work. You will get a short note like this when an agent needs you.",
            3,
            &["white_check_mark".to_string()],
        ),
        token: token(),
    };
    deliver(hub, transport, req, &cfg.topic, now)
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Settings as the UI sees them (the token only as `hasToken`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhoneAlertsView {
    pub config: PhoneConfig,
    pub has_token: bool,
    /// "credentialManager" | "file".
    pub token_storage: &'static str,
    pub status: PhoneStatus,
}

fn view(data_dir: &Path) -> PhoneAlertsView {
    let now = now_ms();
    let status = {
        let h = HUB.lock();
        let mut s = h.status.clone();
        s.paused_until_ms = h.limiter.paused_until(now);
        s
    };
    PhoneAlertsView { config: load_config(data_dir), has_token: token_load(data_dir).is_some(), token_storage: token_storage(), status }
}

fn join_err(e: impl std::fmt::Display) -> AppError {
    AppError::Other(e.to_string())
}

#[tauri::command]
pub async fn phone_alerts_get(ctx: State<'_, AppCtx>) -> AppResult<PhoneAlertsView> {
    let dir = ctx.paths.data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || view(&dir)).await.map_err(join_err)
}

/// Validate and save. Turning alerts on with no topic yet generates one.
#[tauri::command]
pub async fn phone_alerts_set(ctx: State<'_, AppCtx>, config: PhoneConfig) -> AppResult<PhoneAlertsView> {
    let dir = ctx.paths.data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut c = config;
        if c.enabled && c.topic.trim().is_empty() {
            c.topic = new_topic();
        }
        let c = validate_config(&c).map_err(AppError::Invalid)?;
        save_config(&dir, &c)?;
        Ok(view(&dir))
    })
    .await
    .map_err(join_err)?
}

/// Replace the topic with a new random one (the phone must subscribe again).
#[tauri::command]
pub async fn phone_alerts_new_topic(ctx: State<'_, AppCtx>) -> AppResult<PhoneAlertsView> {
    let dir = ctx.paths.data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let c = PhoneConfig { topic: new_topic(), ..load_config(&dir) };
        save_config(&dir, &c)?;
        Ok(view(&dir))
    })
    .await
    .map_err(join_err)?
}

/// Store (non-empty) or remove (null / empty) the access token.
#[tauri::command]
pub async fn phone_alerts_set_token(ctx: State<'_, AppCtx>, token: Option<String>) -> AppResult<PhoneAlertsView> {
    let dir = ctx.paths.data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        match token.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
            Some(t) => token_save(&dir, Some(&validate_token(t).map_err(AppError::Invalid)?))?,
            None => token_save(&dir, None)?,
        }
        Ok(view(&dir))
    })
    .await
    .map_err(join_err)?
}

#[tauri::command]
pub async fn phone_alert_send(ctx: State<'_, AppCtx>, alert: PhoneAlert) -> AppResult<PhoneSendResult> {
    let dir = ctx.paths.data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || send_alert(&dir, &HUB, &CurlTransport, &alert, &|| token_load(&dir), now_ms())).await.map_err(join_err)
}

#[tauri::command]
pub async fn phone_alerts_test(ctx: State<'_, AppCtx>) -> AppResult<PhoneSendResult> {
    let dir = ctx.paths.data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || send_test(&dir, &HUB, &CurlTransport, &|| token_load(&dir), now_ms())).await.map_err(join_err)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    /// Records every request; answers with a fixed result.
    struct Mock {
        reply: Result<(u16, Vec<u8>), String>,
        seen: Arc<Mutex<Vec<PreparedRequest>>>,
    }

    impl Mock {
        fn ok() -> Self {
            Self { reply: Ok((200, b"{\"id\":\"x\"}".to_vec())), seen: Arc::default() }
        }
        fn status(code: u16, body: &str) -> Self {
            Self { reply: Ok((code, body.as_bytes().to_vec())), seen: Arc::default() }
        }
        fn count(&self) -> usize {
            self.seen.lock().len()
        }
        fn last_body(&self) -> serde_json::Value {
            serde_json::from_str(&self.seen.lock().last().expect("a request").body).expect("json body")
        }
    }

    impl Transport for Mock {
        fn post(&self, req: &PreparedRequest) -> Result<(u16, Vec<u8>), String> {
            self.seen.lock().push(req.clone());
            self.reply.clone()
        }
    }

    const TOPIC: &str = "gk-abcdefghijklmnopqrstuvwx";

    fn no_token() -> Option<String> {
        None
    }

    fn enabled_dir() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let cfg = PhoneConfig { enabled: true, topic: TOPIC.into(), ..PhoneConfig::default() };
        save_config(dir.path(), &cfg).unwrap();
        dir
    }

    fn alert(key: &str, kind: &str, priority: u8) -> PhoneAlert {
        PhoneAlert {
            key: key.into(),
            kind: kind.into(),
            title: "builder-1 needs you · OAuth demo".into(),
            message: "Waiting for input.".into(),
            priority,
            tags: vec!["bell".into()],
        }
    }

    // ---- settings validation ----

    #[test]
    fn server_validation() {
        assert_eq!(validate_server("https://ntfy.sh/").unwrap(), "https://ntfy.sh");
        assert_eq!(validate_server("  https://push.example.com:8443/ntfy ").unwrap(), "https://push.example.com:8443/ntfy");
        assert_eq!(validate_server("http://192.168.1.10:8080").unwrap(), "http://192.168.1.10:8080");
        assert_eq!(validate_server("http://localhost:2586").unwrap(), "http://localhost:2586");
        assert_eq!(validate_server("http://nas.local").unwrap(), "http://nas.local");
        assert_eq!(validate_server("http://[::1]:80").unwrap(), "http://[::1]:80");
        assert_eq!(validate_server("https://[2001:db8::1]").unwrap(), "https://[2001:db8::1]");
        for bad in [
            "",
            "ntfy.sh",
            "ftp://ntfy.sh",
            "http://ntfy.sh",
            "http://8.8.8.8",
            "https://user:pw@ntfy.sh",
            "https://ntfy.sh/?x=1",
            "https://ntfy.sh/#frag",
            "https://ntfy .sh",
            "https://ntfy.sh\"\nurl = \"https://evil.example",
            "https://ntfy.sh\\x",
            "https://-bad.example",
            "https://ntfy.sh:99999",
            "https://ntfy.sh:",
            "https://ntfy.sh//x",
            "https://ntfy.sh/a/../b",
            "https://",
        ] {
            assert!(validate_server(bad).is_err(), "{bad:?} should be refused");
        }
        assert!(validate_server(&format!("https://{}.com", "a".repeat(250))).is_err());
    }

    #[test]
    fn private_hosts() {
        for h in ["localhost", "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.1", "192.168.0.5", "100.100.1.1", "box.lan", "nas.local", "x.home.arpa", "[fd00::1]"] {
            assert!(is_private_host(h), "{h}");
        }
        for h in ["ntfy.sh", "8.8.8.8", "172.32.0.1", "192.169.0.1", "100.128.0.1", "1.2.3", "localhost.example.com", "[2001:db8::1]"] {
            assert!(!is_private_host(h), "{h}");
        }
    }

    #[test]
    fn topic_and_token_validation() {
        assert!(validate_topic("gk-Abc_123").is_ok());
        assert!(validate_topic(&"a".repeat(64)).is_ok());
        for bad in ["", "has space", "a/b", "x?y", "ümlaut", &"a".repeat(65)] {
            assert!(validate_topic(bad).is_err(), "{bad:?}");
        }
        assert_eq!(validate_token(" tk_AgQdq7mVBoFD37zQVN29RhuMzNIz2 ").unwrap(), "tk_AgQdq7mVBoFD37zQVN29RhuMzNIz2");
        for bad in ["", "tk_", "tk_short", "AgQdq7mVBoFD37zQVN29RhuMzNIz2", "tk_abc\r\nX-Evil: 1aaaaa", "tk_abc def ghijkl", "tk_\"aaaaaaaaaa"] {
            assert!(validate_token(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn config_validation() {
        let ok = PhoneConfig { enabled: true, topic: TOPIC.into(), ..PhoneConfig::default() };
        assert_eq!(validate_config(&ok).unwrap(), ok);
        // Off with no topic is fine; on with no topic is not.
        assert!(validate_config(&PhoneConfig::default()).is_ok());
        assert!(validate_config(&PhoneConfig { enabled: true, ..PhoneConfig::default() }).is_err());
        assert!(validate_config(&PhoneConfig { min_priority: 0, ..ok.clone() }).is_err());
        assert!(validate_config(&PhoneConfig { min_priority: 6, ..ok.clone() }).is_err());
        let bad_quiet = PhoneConfig { quiet_hours: PhoneQuietHours { enabled: true, start: "25:00".into(), end: "07:00".into() }, ..ok.clone() };
        assert!(validate_config(&bad_quiet).is_err());
        assert!(validate_config(&PhoneConfig { server: "http://ntfy.sh".into(), ..ok.clone() }).is_err());
        assert!(validate_config(&PhoneConfig { topic: "bad topic".into(), ..ok }).is_err());
    }

    #[test]
    fn new_topics_are_long_random_and_valid() {
        let a = new_topic();
        let b = new_topic();
        assert_ne!(a, b);
        assert_eq!(a.len(), 27);
        assert!(a.starts_with("gk-"));
        assert!(validate_topic(&a).is_ok());
    }

    #[test]
    fn config_round_trip_and_damaged_file() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(load_config(dir.path()), PhoneConfig::default());
        let cfg = PhoneConfig { enabled: true, topic: TOPIC.into(), min_priority: 4, ..PhoneConfig::default() };
        save_config(dir.path(), &cfg).unwrap();
        assert_eq!(load_config(dir.path()), cfg);
        // Older / partial file: defaults fill the gaps.
        std::fs::write(dir.path().join(CONFIG_FILE), r#"{"enabled":true,"topic":"gk-x1234567"}"#).unwrap();
        let c = load_config(dir.path());
        assert!(c.enabled && c.server == DEFAULT_SERVER && c.events.needs_input && !c.events.done);
        // Hand-edited into something invalid: kept, but off.
        std::fs::write(dir.path().join(CONFIG_FILE), r#"{"enabled":true,"topic":"gk-x","server":"http://example.com"}"#).unwrap();
        assert!(!load_config(dir.path()).enabled);
        std::fs::write(dir.path().join(CONFIG_FILE), "not json").unwrap();
        assert_eq!(load_config(dir.path()), PhoneConfig::default());
    }

    // ---- payload ----

    #[test]
    fn sanitize_removes_paths_urls_emails_and_secrets() {
        let cases = [
            ("fix D:\\work\\acme\\src\\main.rs now", "D:\\work"),
            ("see C:/Users/me/secret.txt", "C:/Users"),
            ("share \\\\server\\share\\x", "\\\\server"),
            ("in /home/alice/project/x.rs", "/home/alice"),
            ("in ~/code/app", "~/code"),
            ("edit src/components/settings/PhoneAlerts.tsx", "src/components"),
            ("edit src\\lib\\x.ts", "src\\lib"),
            ("mail bob@example.com", "bob@example.com"),
            ("open https://github.com/acme/private?token=1", "github.com"),
            ("key sk-ant-api03-AbCdEf0123456789_xyz-QQ", "AbCdEf0123456789"),
            ("password=hunter2hunter2", "hunter2hunter2"),
        ];
        for (input, secret) in cases {
            let out = sanitize_text(input, 200);
            assert!(!out.contains(secret), "{input:?} -> {out:?}");
        }
        // Plain generic text is unchanged (fractions and "a/b" survive).
        assert_eq!(sanitize_text("Mission done: Add OAuth login (8/8)", 200), "Mission done: Add OAuth login (8/8)");
        assert_eq!(sanitize_text("builder-1 needs you · client/server demo", 200), "builder-1 needs you · client/server demo");
        // Control characters and whitespace runs collapse.
        assert_eq!(sanitize_text("a\u{1b}[31m\n\tb   c", 200), "a [31m b c");
        // Length cap with an ellipsis.
        let long = sanitize_text(&"x".repeat(500), 20);
        assert_eq!(long.chars().count(), 20);
        assert!(long.ends_with('…'));
    }

    #[test]
    fn body_is_json_with_clamped_fields() {
        let body = build_body(TOPIC, "t \"quoted\"\nline", "", 9, &["bell".into(), "Bad Tag".into(), "x\"y".into(), "warning".into()]);
        let v: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["topic"], TOPIC);
        assert_eq!(v["title"], "t \"quoted\" line");
        assert_eq!(v["message"], "Open Gridkeeper.");
        assert_eq!(v["priority"], 5);
        assert_eq!(v["tags"], serde_json::json!(["bell", "warning"]));
    }

    // ---- curl ----

    /// Minimal reader for the config lines we write: `name = "value"` with curl's escapes.
    fn parse_config(cfg: &str) -> Vec<(String, String)> {
        cfg.lines()
            .map(|l| {
                let (name, rest) = l.split_once(" = ").expect("name = value");
                let inner = rest.strip_prefix('"').and_then(|r| r.strip_suffix('"')).expect("quoted");
                let mut out = String::new();
                let mut chars = inner.chars();
                while let Some(c) = chars.next() {
                    if c == '\\' {
                        match chars.next().expect("escape") {
                            'n' => out.push('\n'),
                            'r' => out.push('\r'),
                            't' => out.push('\t'),
                            other => out.push(other),
                        }
                    } else {
                        assert_ne!(c, '"', "unescaped quote in {l}");
                        out.push(c);
                    }
                }
                (name.to_string(), out)
            })
            .collect()
    }

    #[test]
    fn curl_command_line_is_fixed_and_secret_free() {
        let args = curl_args("https://ntfy.sh/");
        assert_eq!(args[0], "-q", "-q must be first");
        assert_eq!(&args[args.len() - 2..], &["-K", "-"]);
        assert!(args.windows(2).any(|w| w == ["--proto", "=https"]));
        assert!(!args.iter().any(|a| *a == "-L" || a.contains("location")));
        assert!(curl_args("http://192.168.1.2/").windows(2).any(|w| w == ["--proto", "=http,https"]));
    }

    #[test]
    fn curl_config_escapes_everything() {
        let nasty_title = "x\"\nurl = \"https://evil.example/\"\nheader = \"X: 1\\";
        let body = build_body(TOPIC, nasty_title, "msg \\ \" end", 4, &[]);
        let req = PreparedRequest { url: "https://ntfy.sh/".into(), body: body.clone(), token: Some("tk_AgQdq7mVBoFD37zQVN29RhuMzNIz2".into()) };
        let cfg = curl_config(&req);
        let entries = parse_config(&cfg);
        let names: Vec<&str> = entries.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(names, ["url", "header", "header", "header", "data-raw"]);
        assert_eq!(entries[0].1, "https://ntfy.sh/");
        assert_eq!(entries[3].1, "Authorization: Bearer tk_AgQdq7mVBoFD37zQVN29RhuMzNIz2");
        // The body survives the round trip byte for byte and is still the JSON we built.
        assert_eq!(entries[4].1, body);
        assert_eq!(cfg.lines().count(), 5, "no injected lines");
        let v: serde_json::Value = serde_json::from_str(&entries[4].1).unwrap();
        assert_eq!(v["message"], "msg \\ \" end");
        // Without a token there is no Authorization header at all.
        let cfg = curl_config(&PreparedRequest { token: None, ..req });
        assert!(!cfg.contains("Authorization"));
    }

    #[test]
    fn quote_drops_other_control_characters() {
        assert_eq!(curl_quote("a\u{0}b\u{7f}c"), "\"abc\"");
        assert_eq!(curl_quote("@file"), "\"@file\"");
    }

    // ---- rate limiter ----

    #[test]
    fn rate_limiter_per_key_hourly_and_coalescing() {
        let mut r = RateLimiter::default();
        let t0 = 1_000_000;
        assert_eq!(r.check("s:a", t0, false), Gate::Allow { coalesced: 0 });
        // Same key within 2 minutes: held back and counted.
        assert_eq!(r.check("s:a", t0 + 1_000, false), Gate::PerKey);
        assert_eq!(r.check("s:a", t0 + PER_KEY_GAP_MS - 1, false), Gate::PerKey);
        // Another key goes through and carries the two suppressed alerts.
        assert_eq!(r.check("s:b", t0 + 2_000, false), Gate::Allow { coalesced: 2 });
        assert_eq!(r.check("s:a", t0 + PER_KEY_GAP_MS, false), Gate::Allow { coalesced: 0 });
        // Hourly cap: 10 per rolling hour, whatever the keys.
        let mut r = RateLimiter::default();
        for i in 0..HOURLY_MAX {
            assert!(matches!(r.check(&format!("k{i}"), t0 + i as u64, false), Gate::Allow { .. }));
        }
        assert_eq!(r.check("fresh", t0 + 100, false), Gate::Hourly);
        assert_eq!(r.check("fresh", t0 + HOUR_MS - 1, false), Gate::Hourly);
        assert_eq!(r.check("fresh", t0 + HOUR_MS, false), Gate::Allow { coalesced: 2 });
        // A storm of 1000 events in a minute sends at most 10.
        let mut r = RateLimiter::default();
        let sent = (0..1000).filter(|i| matches!(r.check(&format!("s:{}", i % 50), t0 + i * 60, false), Gate::Allow { .. })).count();
        assert_eq!(sent, HOURLY_MAX);
    }

    #[test]
    fn rate_limiter_pause_and_user_initiated() {
        let mut r = RateLimiter::default();
        let t0 = 5_000_000;
        r.pause(t0, FAILURE_PAUSE_MS);
        assert_eq!(r.check("s:a", t0 + 10, false), Gate::Paused);
        assert_eq!(r.paused_until(t0), Some(t0 + FAILURE_PAUSE_MS));
        // A test from the user goes through a pause.
        assert_eq!(r.check("test", t0 + 20, true), Gate::Allow { coalesced: 0 });
        assert_eq!(r.check("s:a", t0 + FAILURE_PAUSE_MS, false), Gate::Allow { coalesced: 1 });
        assert_eq!(r.paused_until(t0 + FAILURE_PAUSE_MS), None);
    }

    #[test]
    fn limiter_memory_stays_bounded() {
        let mut r = RateLimiter::default();
        for i in 0..10_000u64 {
            r.check(&format!("k{i}"), i * PER_KEY_GAP_MS, false);
        }
        assert!(r.last_by_key.len() <= 1 && r.sent.len() <= HOURLY_MAX);
    }

    // ---- send pipeline (mocked transport) ----

    #[test]
    fn sends_sanitized_alert_through_transport() {
        let dir = enabled_dir();
        let hub = Mutex::new(Hub::default());
        let mock = Mock::ok();
        let mut a = alert("s:1", "needsInput", 4);
        a.message = "Waiting in D:\\work\\acme for bob@example.com sk-ant-api03-AbCdEf0123456789_xyz".into();
        let r = send_alert(dir.path(), &hub, &mock, &a, &no_token, 10_000_000);
        assert_eq!(r.outcome, "sent", "{r:?}");
        let seen = mock.seen.lock().clone();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].url, "https://ntfy.sh/");
        let body = &seen[0].body;
        for leak in ["D:\\\\work", "acme", "bob@example.com", "AbCdEf0123456789"] {
            assert!(!body.contains(leak), "{leak} leaked: {body}");
        }
        let v = mock.last_body();
        assert_eq!(v["topic"], TOPIC);
        assert_eq!(v["priority"], 4);
        assert_eq!(hub.lock().status.sent, 1);
    }

    #[test]
    fn switches_filter_before_any_request() {
        let dir = tempfile::tempdir().unwrap();
        let hub = Mutex::new(Hub::default());
        let mock = Mock::ok();
        // Off (default): nothing is sent.
        assert_eq!(send_alert(dir.path(), &hub, &mock, &alert("s:1", "needsInput", 4), &no_token, 1).outcome, "skipped");
        let dir = enabled_dir();
        // "done" is off by default; unknown kinds are refused; priority below the minimum (3).
        assert_eq!(send_alert(dir.path(), &hub, &mock, &alert("s:1", "done", 3), &no_token, 1).outcome, "skipped");
        assert_eq!(send_alert(dir.path(), &hub, &mock, &alert("s:1", "nonsense", 5), &no_token, 1).outcome, "skipped");
        assert_eq!(send_alert(dir.path(), &hub, &mock, &alert("s:1", "error", 2), &no_token, 1).outcome, "skipped");
        assert_eq!(mock.count(), 0);
    }

    #[test]
    fn coalesced_count_is_appended() {
        let dir = enabled_dir();
        let hub = Mutex::new(Hub::default());
        let mock = Mock::ok();
        let t = 50_000_000;
        assert_eq!(send_alert(dir.path(), &hub, &mock, &alert("s:1", "needsInput", 4), &no_token, t).outcome, "sent");
        assert_eq!(send_alert(dir.path(), &hub, &mock, &alert("s:1", "needsInput", 4), &no_token, t + 1).outcome, "rateLimited");
        assert_eq!(send_alert(dir.path(), &hub, &mock, &alert("s:1", "error", 4), &no_token, t + 2).outcome, "rateLimited");
        assert_eq!(send_alert(dir.path(), &hub, &mock, &alert("s:2", "needsInput", 4), &no_token, t + 3).outcome, "sent");
        assert_eq!(mock.count(), 2);
        assert!(mock.last_body()["message"].as_str().unwrap().ends_with("(+2 more since the last alert)"));
        assert_eq!(hub.lock().status.suppressed, 2);
    }

    #[test]
    fn failures_pause_report_once_and_never_retry() {
        let dir = enabled_dir();
        let hub = Mutex::new(Hub::default());
        let mock = Mock::status(429, r#"{"code":42901,"http":429,"error":"limit reached: too many requests"}"#);
        let t = 70_000_000;
        let r = send_alert(dir.path(), &hub, &mock, &alert("s:1", "needsInput", 4), &no_token, t);
        assert_eq!(r.outcome, "failed");
        assert!(r.first_failure);
        assert!(r.detail.as_deref().unwrap().contains("429"));
        // Paused for 10 minutes: nothing reaches the transport, even for other panes.
        assert_eq!(send_alert(dir.path(), &hub, &mock, &alert("s:2", "error", 4), &no_token, t + 1000).outcome, "paused");
        assert_eq!(mock.count(), 1, "no retry");
        // The next failure after the pause is not "first" again.
        let r = send_alert(dir.path(), &hub, &mock, &alert("s:3", "error", 4), &no_token, t + RATE_LIMITED_PAUSE_MS);
        assert_eq!(r.outcome, "failed");
        assert!(!r.first_failure);
        let st = hub.lock().status.clone();
        assert_eq!(st.failures, 2);
        assert!(st.failing && st.last_error.is_some());
    }

    #[test]
    fn transport_errors_are_scrubbed_of_topic_and_token() {
        let dir = enabled_dir();
        let hub = Mutex::new(Hub::default());
        let mock = Mock { reply: Err(format!("could not post to https://ntfy.sh/{TOPIC} with tk_AgQdq7mVBoFD37zQVN29RhuMzNIz2")), seen: Arc::default() };
        let r = send_alert(dir.path(), &hub, &mock, &alert("s:1", "needsInput", 4), &no_token, 90_000_000);
        assert!(!r.detail.as_deref().unwrap().contains(TOPIC), "{r:?}");
        let s = scrub(&format!("x {TOPIC} tk_AgQdq7mVBoFD37zQVN29RhuMzNIz2"), TOPIC, Some("tk_AgQdq7mVBoFD37zQVN29RhuMzNIz2"));
        assert!(!s.contains(TOPIC) && !s.contains("tk_AgQd"), "{s}");
    }

    #[test]
    fn classify_statuses() {
        assert!(classify(200, b"{}").is_ok());
        let (m, p) = classify(403, br#"{"error":"forbidden"}"#).unwrap_err();
        assert!(m.contains("403") && m.contains("forbidden") && p == FAILURE_PAUSE_MS);
        assert_eq!(classify(429, b"").unwrap_err().1, RATE_LIMITED_PAUSE_MS);
        assert!(classify(502, b"<html>").unwrap_err().0.contains("502"));
    }

    #[test]
    fn test_send_ignores_enabled_but_is_throttled() {
        let dir = tempfile::tempdir().unwrap();
        let hub = Mutex::new(Hub::default());
        let mock = Mock::ok();
        assert_eq!(send_test(dir.path(), &hub, &mock, &no_token, 1_000).outcome, "skipped", "no topic yet");
        save_config(dir.path(), &PhoneConfig { topic: TOPIC.into(), ..PhoneConfig::default() }).unwrap();
        assert_eq!(send_test(dir.path(), &hub, &mock, &no_token, 2_000).outcome, "sent");
        assert_eq!(send_test(dir.path(), &hub, &mock, &no_token, 3_000).outcome, "rateLimited");
        assert_eq!(send_test(dir.path(), &hub, &mock, &no_token, 2_000 + TEST_GAP_MS).outcome, "sent");
        assert_eq!(mock.count(), 2);
    }

    #[cfg(not(windows))]
    #[test]
    fn token_file_is_private() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        assert!(token_load(dir.path()).is_none());
        token_save(dir.path(), Some("tk_AgQdq7mVBoFD37zQVN29RhuMzNIz2")).unwrap();
        assert_eq!(token_load(dir.path()).as_deref(), Some("tk_AgQdq7mVBoFD37zQVN29RhuMzNIz2"));
        let mode = std::fs::metadata(dir.path().join(TOKEN_FILE)).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
        token_save(dir.path(), None).unwrap();
        assert!(token_load(dir.path()).is_none());
    }

    /// Writes to the real Windows Credential Manager (a throwaway target). Run by hand:
    /// `cargo test --lib phone::tests::credential_manager_round_trip -- --ignored`
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn credential_manager_round_trip() {
        let target = "Gridkeeper/phone-alerts/test-only";
        cred::write(target, "tk_AgQdq7mVBoFD37zQVN29RhuMzNIz2").unwrap();
        assert_eq!(cred::read(target).unwrap().as_deref(), Some("tk_AgQdq7mVBoFD37zQVN29RhuMzNIz2"));
        cred::delete(target).unwrap();
        assert_eq!(cred::read(target).unwrap(), None);
        cred::delete(target).unwrap();
    }

    /// One real alert through the system curl. Never runs in CI. The integrator runs it by hand:
    /// `$env:GK_NTFY_TOPIC='<a throwaway topic>'; cargo test --lib phone::tests::live_ntfy_send -- --ignored`
    /// (optional `GK_NTFY_SERVER`, default https://ntfy.sh), then checks the phone / the topic's web page.
    #[test]
    #[ignore]
    fn live_ntfy_send() {
        let topic = std::env::var("GK_NTFY_TOPIC").expect("set GK_NTFY_TOPIC to a throwaway topic");
        let server = validate_server(&std::env::var("GK_NTFY_SERVER").unwrap_or_else(|_| DEFAULT_SERVER.into())).unwrap();
        let topic = validate_topic(&topic).unwrap();
        let req = PreparedRequest {
            url: format!("{server}/"),
            body: build_body(&topic, "Gridkeeper live test", "If you can read this, curl delivery works.", 3, &["white_check_mark".into()]),
            token: std::env::var("GK_NTFY_TOKEN").ok().filter(|t| !t.is_empty()),
        };
        let (status, body) = CurlTransport.post(&req).expect("curl ran");
        assert!(classify(status, &body).is_ok(), "HTTP {status}: {}", String::from_utf8_lossy(&body));
    }
}
