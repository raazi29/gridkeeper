//! Browser panes: URL validation, the embeddability probe and pop-out browser windows.
//!
//! In-pane pages render in a sandboxed `<iframe>` in the main webview (frontend); see
//! docs/TECHNICAL_DECISIONS.md ADR-019 for why and for the security analysis. This module covers
//! what the iframe cannot do:
//! - `probe`: one user-initiated request (curl.exe, HEAD-less GET capped at 512 KiB) to the URL the
//!   pane is about to show, to learn whether the site forbids framing (X-Frame-Options /
//!   CSP frame-ancestors), whether a dev server is up yet, and the page `<title>`.
//! - `open_window`: a separate Tauri `WebviewWindow` ("pop-out") for sites that refuse framing and for
//!   `file:` URLs. Its label (`browser-*`) is NOT covered by any capability (capabilities/default.json
//!   targets the `main` webview only), and Tauri rejects custom commands from remote origins, so the
//!   page gets no IPC. Navigation to the app's own origins is refused because Tauri treats those as
//!   local (ACL-free) origins.

use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder};

use crate::adapters::process;
use crate::types::{AppError, AppResult};

pub const MAX_URL_LEN: usize = 2048;
const PROBE_TIMEOUT: Duration = Duration::from_secs(8);
const PROBE_CAP: usize = 512 * 1024;
const WINDOW_PREFIX: &str = "browser-";

/// Hosts Tauri serves its own protocols on (Windows form `http://<protocol>.localhost`).
const APP_PROTOCOL_HOSTS: &[&str] = &["tauri.localhost", "ipc.localhost", "asset.localhost"];

/// A URL a browser pane may open: http / https (with a host) or file, at most 2048 characters,
/// no whitespace / control characters, no embedded password. Returns the normalized URL.
pub fn validate_url(raw: &str) -> Option<String> {
    let s = raw.trim();
    if s.is_empty() || s.len() > MAX_URL_LEN || s.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return None;
    }
    let u = Url::parse(s).ok()?;
    let ok = match u.scheme() {
        "http" | "https" => u.host_str().is_some_and(|h| !h.is_empty()),
        "file" => true,
        _ => false,
    };
    if !ok || u.password().is_some() {
        return None;
    }
    let out = u.to_string();
    (out.len() <= MAX_URL_LEN).then_some(out)
}

/// True for origins Tauri would treat as the app itself (and so exempt from the IPC ACL):
/// its protocol hosts and, in dev builds, the dev server origin.
pub fn is_app_origin(u: &Url, dev_url: Option<&Url>) -> bool {
    if matches!(u.scheme(), "tauri" | "ipc" | "asset") {
        return true;
    }
    let host = u.host_str().unwrap_or("").to_ascii_lowercase();
    let host = host.trim_end_matches('.');
    if APP_PROTOCOL_HOSTS.contains(&host) {
        return true;
    }
    dev_url.is_some_and(|d| d.scheme() == u.scheme() && d.host_str() == u.host_str() && d.port_or_known_default() == u.port_or_known_default())
}

/// Top-level navigations allowed inside a pop-out window.
pub fn navigation_allowed(u: &Url, dev_url: Option<&Url>) -> bool {
    if u.as_str() == "about:blank" {
        return true;
    }
    matches!(u.scheme(), "http" | "https" | "file") && !is_app_origin(u, dev_url)
}

fn dev_url(app: &AppHandle) -> Option<Url> {
    if cfg!(debug_assertions) { app.config().build.dev_url.clone() } else { None }
}

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameProbe {
    /// A response arrived (any status).
    pub reachable: bool,
    pub status: Option<u16>,
    /// `Some(false)`: the site forbids framing. `None`: unknown (no response / probe unavailable).
    pub frameable: Option<bool>,
    /// Why framing is refused, e.g. "X-Frame-Options: DENY".
    pub reason: Option<String>,
    /// Static `<title>` of the HTML, if any.
    pub title: Option<String>,
    /// Short error (connection refused, timeout, curl missing).
    pub error: Option<String>,
}

/// Header blocks (one per response, redirects included) and the body, from `curl -i -L` output.
fn split_responses(raw: &[u8]) -> (Vec<Vec<(String, String)>>, Vec<u8>, Vec<u16>) {
    let mut blocks = Vec::new();
    let mut statuses = Vec::new();
    let mut rest = raw;
    while rest.starts_with(b"HTTP/") {
        let end = rest.windows(4).position(|w| w == b"\r\n\r\n").map(|i| (i, 4)).or_else(|| rest.windows(2).position(|w| w == b"\n\n").map(|i| (i, 2)));
        let (head, after) = match end {
            Some((i, n)) => (&rest[..i], &rest[i + n..]),
            None => (rest, &rest[rest.len()..]),
        };
        let text = String::from_utf8_lossy(head);
        let mut lines = text.lines();
        let status = lines.next().and_then(|l| l.split_whitespace().nth(1)).and_then(|s| s.parse().ok()).unwrap_or(0);
        statuses.push(status);
        blocks.push(
            lines
                .filter_map(|l| l.split_once(':').map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string())))
                .collect(),
        );
        rest = after;
    }
    (blocks, rest.to_vec(), statuses)
}

/// Embeddability verdict from the final response's headers. CSP `frame-ancestors` (enforced, not
/// report-only) wins over X-Frame-Options, as in Chromium.
pub fn frame_verdict(headers: &[(String, String)]) -> (bool, Option<String>) {
    for (k, v) in headers {
        if k != "content-security-policy" {
            continue;
        }
        for directive in v.split(';') {
            let mut parts = directive.split_whitespace();
            if !parts.next().is_some_and(|d| d.eq_ignore_ascii_case("frame-ancestors")) {
                continue;
            }
            let sources: Vec<String> = parts.map(|s| s.to_ascii_lowercase()).collect();
            let open = sources.iter().any(|s| s == "*" || s == "http:" || s == "http://tauri.localhost");
            return if open { (true, None) } else { (false, Some(format!("Content-Security-Policy: frame-ancestors {}", sources.join(" ")))) };
        }
    }
    for (k, v) in headers {
        if k == "x-frame-options" {
            let val = v.trim().to_ascii_lowercase();
            if val == "deny" || val == "sameorigin" {
                return (false, Some(format!("X-Frame-Options: {}", v.trim().to_ascii_uppercase())));
            }
        }
    }
    (true, None)
}

/// Static `<title>` of an HTML document: entities decoded, whitespace collapsed, <= 200 chars.
pub fn html_title(body: &[u8]) -> Option<String> {
    static RE: once_cell::sync::Lazy<regex::Regex> =
        once_cell::sync::Lazy::new(|| regex::Regex::new(r"(?is)<title[^>]*>(.*?)</title>").expect("title regex"));
    let text = String::from_utf8_lossy(body);
    let raw = RE.captures(&text)?.get(1)?.as_str();
    let decoded = raw
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&#x27;", "'")
        .replace("&nbsp;", " ")
        .replace("&amp;", "&");
    let t: String = decoded.split_whitespace().collect::<Vec<_>>().join(" ");
    let t: String = t.chars().filter(|c| !c.is_control()).take(200).collect();
    (!t.is_empty()).then_some(t)
}

/// Turn curl's output into a probe result.
pub fn interpret_probe(stdout: &[u8], exit_code: Option<i32>, truncated: bool) -> FrameProbe {
    let (blocks, body, statuses) = split_responses(stdout);
    let Some(last) = blocks.last() else {
        let error = match exit_code {
            Some(6) => "Host not found",
            Some(7) => "Connection refused — is the server running?",
            Some(28) => "Timed out",
            Some(35) | Some(60) => "TLS error",
            _ => "No response",
        };
        return FrameProbe { error: Some(error.into()), ..Default::default() };
    };
    let (frameable, reason) = frame_verdict(last);
    let is_html = last.iter().any(|(k, v)| k == "content-type" && v.to_ascii_lowercase().contains("html"));
    let _ = truncated;
    FrameProbe {
        reachable: true,
        status: statuses.last().copied().filter(|s| *s > 0),
        frameable: Some(frameable),
        reason,
        title: if is_html { html_title(&body) } else { None },
        error: None,
    }
}

fn curl_exe() -> Option<std::path::PathBuf> {
    // Prefer the copy shipped with Windows (System32) over whatever is first on PATH.
    let sys = std::env::var_os("SystemRoot").map(|r| std::path::PathBuf::from(r).join("System32").join("curl.exe"));
    sys.filter(|p| p.is_file()).or_else(|| which::which("curl.exe").ok())
}

/// Probe an http(s) URL (see module docs). `file:` and invalid URLs are rejected.
pub fn probe(url: &str) -> AppResult<FrameProbe> {
    let url = validate_url(url).ok_or_else(|| AppError::Invalid("Only http, https and file URLs are allowed".into()))?;
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err(AppError::Invalid("Only http and https URLs can be probed".into()));
    }
    let Some(curl) = curl_exe() else {
        return Ok(FrameProbe { error: Some("curl.exe not available".into()), ..Default::default() });
    };
    let mut cmd = process::hidden_command(curl);
    // `-q` must come first: it disables ~/.curlrc. The URL is validated to start with http(s)://,
    // so it can never be read as an option.
    cmd.args([
        "-q", "-sS", "-i", "-L", "--max-redirs", "5", "--connect-timeout", "3", "--max-time", "6",
        "--proto", "=http,https", "--proto-redir", "=http,https",
        // A corporate HTTP(S)_PROXY must not swallow local dev servers.
        "--noproxy", "localhost,127.0.0.1,::1,.localhost",
        "-A", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Gridkeeper",
        "-H", "Accept: text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
    ])
    .arg(&url);
    match process::run_capped(cmd, PROBE_TIMEOUT, PROBE_CAP) {
        Ok(out) => Ok(interpret_probe(&out.stdout, out.status.and_then(|s| s.code()), out.truncated)),
        Err(e) if e.kind() == std::io::ErrorKind::TimedOut => Ok(FrameProbe { error: Some("Timed out".into()), ..Default::default() }),
        Err(e) => Ok(FrameProbe { error: Some(format!("Probe failed: {e}")), ..Default::default() }),
    }
}

// ---------------------------------------------------------------------------
// Pop-out windows
// ---------------------------------------------------------------------------

fn is_browser_label(label: &str) -> bool {
    label.starts_with(WINDOW_PREFIX) && label.len() <= 64 && label[WINDOW_PREFIX.len()..].chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// Open `url` in a pop-out browser window, or navigate + focus the existing window `label`.
/// Returns the window label. Must not run on the main thread (window creation would deadlock on
/// Windows): call from an async command.
pub fn open_window(app: &AppHandle, url: &str, label: Option<&str>) -> AppResult<String> {
    let url = validate_url(url).ok_or_else(|| AppError::Invalid("Only http, https and file URLs are allowed".into()))?;
    let parsed = Url::parse(&url).map_err(|e| AppError::Invalid(e.to_string()))?;
    let dev = dev_url(app);
    if is_app_origin(&parsed, dev.as_ref()) {
        return Err(AppError::Invalid("That address belongs to Gridkeeper itself".into()));
    }
    if let Some(existing) = label.filter(|l| is_browser_label(l)).and_then(|l| app.get_webview_window(l)) {
        existing.navigate(parsed).map_err(|e| AppError::Other(e.to_string()))?;
        let _ = existing.unminimize();
        let _ = existing.set_focus();
        return Ok(existing.label().to_string());
    }
    let new_label = format!("{WINDOW_PREFIX}{}", &uuid::Uuid::new_v4().simple().to_string()[..12]);
    let nav_dev = dev.clone();
    let popup_dev = dev.clone();
    let opener_app = app.clone();
    WebviewWindowBuilder::new(app, &new_label, WebviewUrl::External(parsed))
        .title(format!("{url} — Gridkeeper browser"))
        .inner_size(1180.0, 820.0)
        .min_inner_size(360.0, 240.0)
        .on_navigation(move |u| navigation_allowed(u, nav_dev.as_ref()))
        .on_new_window(move |u, _features| {
            // target=_blank / window.open: hand http(s) links to the user's browser, never a bare popup.
            if matches!(u.scheme(), "http" | "https") && !is_app_origin(&u, popup_dev.as_ref()) {
                use tauri_plugin_opener::OpenerExt;
                let _ = opener_app.opener().open_url(u.as_str(), None::<&str>);
            }
            tauri::webview::NewWindowResponse::Deny
        })
        .on_document_title_changed(|w, title| {
            let t: String = title.chars().filter(|c| !c.is_control()).take(200).collect();
            let _ = w.set_title(&if t.is_empty() { "Gridkeeper browser".to_string() } else { format!("{t} — Gridkeeper browser") });
        })
        .build()
        .map_err(|e| AppError::Other(format!("Could not open a browser window: {e}")))?;
    tracing::info!("opened pop-out browser window");
    Ok(new_label)
}

pub fn close_window(app: &AppHandle, label: &str) -> AppResult<bool> {
    if !is_browser_label(label) {
        return Err(AppError::Invalid("Not a browser window".into()));
    }
    Ok(match app.get_webview_window(label) {
        Some(w) => w.close().is_ok(),
        None => false,
    })
}

/// Developer tools of a pop-out window (debug builds only; the release build ships without the
/// `devtools` feature so the main window never exposes them).
pub fn devtools(app: &AppHandle, label: &str) -> AppResult<()> {
    if !is_browser_label(label) {
        return Err(AppError::Invalid("Not a browser window".into()));
    }
    let w = app.get_webview_window(label).ok_or_else(|| AppError::NotFound("browser window".into()))?;
    #[cfg(debug_assertions)]
    {
        w.open_devtools();
        Ok(())
    }
    #[cfg(not(debug_assertions))]
    {
        let _ = w;
        Err(AppError::Invalid("Developer tools are only available in debug builds".into()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_urls() {
        assert_eq!(validate_url("http://localhost:5173").as_deref(), Some("http://localhost:5173/"));
        assert_eq!(validate_url("  https://example.com/a?b=c#d ").as_deref(), Some("https://example.com/a?b=c#d"));
        assert!(validate_url("file:///C:/work/docs/index.html").is_some());
        for bad in [
            "",
            "javascript:alert(1)",
            "data:text/html,hi",
            "tauri://localhost",
            "ftp://example.com",
            "http://",
            "http://exa mple.com",
            "http://example.com/\nx",
            "https://user:secret@example.com/",
            "localhost:5173",
            "about:blank",
        ] {
            assert!(validate_url(bad).is_none(), "{bad:?}");
        }
        let long = format!("https://example.com/{}", "a".repeat(MAX_URL_LEN));
        assert!(validate_url(&long).is_none());
    }

    #[test]
    fn app_origins_are_blocked() {
        let dev = Url::parse("http://localhost:1420").unwrap();
        let u = |s: &str| Url::parse(s).unwrap();
        assert!(is_app_origin(&u("http://tauri.localhost/index.html"), None));
        assert!(is_app_origin(&u("https://ipc.localhost/x"), None));
        assert!(is_app_origin(&u("tauri://localhost/"), None));
        assert!(is_app_origin(&u("http://localhost:1420/"), Some(&dev)));
        assert!(!is_app_origin(&u("http://localhost:5173/"), Some(&dev)));
        assert!(!is_app_origin(&u("http://myapp.localhost:3000/"), Some(&dev)));
        assert!(!is_app_origin(&u("https://example.com/"), Some(&dev)));
        assert!(navigation_allowed(&u("about:blank"), None));
        assert!(navigation_allowed(&u("file:///C:/x.html"), None));
        assert!(!navigation_allowed(&u("javascript:alert(1)"), None));
        assert!(!navigation_allowed(&u("http://tauri.localhost/"), None));
        assert!(is_browser_label("browser-abc123"));
        assert!(!is_browser_label("main"));
        assert!(!is_browser_label("browser-../x"));
    }

    #[test]
    fn frame_verdicts() {
        let h = |pairs: &[(&str, &str)]| pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect::<Vec<_>>();
        assert_eq!(frame_verdict(&h(&[])), (true, None));
        assert!(!frame_verdict(&h(&[("x-frame-options", "DENY")])).0);
        assert!(!frame_verdict(&h(&[("x-frame-options", "sameorigin")])).0);
        assert!(frame_verdict(&h(&[("x-frame-options", "ALLOW-FROM https://a")])).0, "obsolete value is ignored");
        assert!(!frame_verdict(&h(&[("content-security-policy", "default-src 'self'; frame-ancestors 'none'")])).0);
        assert!(!frame_verdict(&h(&[("content-security-policy", "frame-ancestors 'self' https://github.com")])).0);
        // CSP wins over XFO.
        assert!(frame_verdict(&h(&[("x-frame-options", "DENY"), ("content-security-policy", "frame-ancestors *")])).0);
        assert!(frame_verdict(&h(&[("content-security-policy", "default-src 'self'")])).0);
    }

    #[test]
    fn interprets_curl_output() {
        let raw = b"HTTP/1.1 301 Moved Permanently\r\nLocation: https://x/\r\nX-Frame-Options: DENY\r\n\r\nHTTP/2 200\r\ncontent-type: text/html; charset=utf-8\r\n\r\n<html><head><title>  Vite &amp; React\n App </title></head></html>";
        let p = interpret_probe(raw, Some(0), false);
        assert!(p.reachable);
        assert_eq!(p.status, Some(200));
        assert_eq!(p.frameable, Some(true), "only the final response counts");
        assert_eq!(p.title.as_deref(), Some("Vite & React App"));

        let raw = b"HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\nx-frame-options: sameorigin\r\ncontent-type: text/plain\r\n\r\n<title>no</title>";
        let p = interpret_probe(raw, Some(0), false);
        assert_eq!(p.frameable, Some(false));
        assert_eq!(p.reason.as_deref(), Some("X-Frame-Options: SAMEORIGIN"));
        assert_eq!(p.title, None, "not HTML");

        let p = interpret_probe(b"", Some(7), false);
        assert!(!p.reachable);
        assert_eq!(p.frameable, None);
        assert!(p.error.unwrap().contains("refused"));
    }

    #[test]
    fn probe_rejects_non_http() {
        assert!(probe("file:///C:/x.html").is_err());
        assert!(probe("javascript:alert(1)").is_err());
    }

    #[test]
    fn probe_against_local_server() {
        use std::io::{Read, Write};
        if curl_exe().is_none() {
            eprintln!("curl.exe not available; skipping");
            return;
        }
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        std::thread::spawn(move || {
            if let Ok((mut s, _)) = l.accept() {
                let mut buf = [0u8; 2048];
                let _ = s.read(&mut buf);
                let _ = s.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nX-Frame-Options: DENY\r\nConnection: close\r\n\r\n<title>Local</title>");
            }
        });
        let p = probe(&format!("http://127.0.0.1:{port}/")).unwrap();
        assert!(p.reachable, "{p:?}");
        assert_eq!(p.frameable, Some(false));
        assert_eq!(p.title.as_deref(), Some("Local"));

        // Nothing listening: refused, not an error.
        let free = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let p = probe(&format!("http://127.0.0.1:{free}/")).unwrap();
        assert!(!p.reachable);
    }
}
