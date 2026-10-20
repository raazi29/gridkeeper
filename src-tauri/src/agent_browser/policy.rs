//! What agents may open, and where an action needs the user's confirmation.
//!
//! - [`navigable`]: the only URLs the navigate tool opens are http(s) with a host and `about:blank`,
//!   without embedded credentials. `file:`, `chrome:`, `edge:`, `javascript:`, `data:` ... are refused.
//! - [`origin_allowed`]: hosts where submitting a form or running a script needs no confirmation:
//!   loopback (`localhost`, `*.localhost`, 127.0.0.0/8, `::1`), the user's allowlist entries
//!   (`host`, `host:port`, `*.domain`, `*.domain:port`), and a private-range address (RFC 1918,
//!   link-local, IPv6 ULA) on a port a session's dev server listens on (`crate::ports`).

use std::net::IpAddr;

use url::{Host, Url};

/// Longest URL the navigate tool accepts.
pub const MAX_URL: usize = 8192;
/// Most allowlist entries kept.
pub const MAX_ALLOW_ENTRIES: usize = 200;

/// A URL the agent may open. Bare `host[:port][/path]` gets `http://`.
pub fn navigable(raw: &str) -> Result<Url, String> {
    let s = raw.trim();
    if s.is_empty() {
        return Err("The URL is empty.".into());
    }
    if s.len() > MAX_URL || s.chars().any(char::is_control) {
        return Err("The URL is too long or contains control characters.".into());
    }
    let candidate = if s.contains("://") || s.starts_with("about:") { s.to_string() } else { format!("http://{s}") };
    let u = Url::parse(&candidate).map_err(|e| format!("Not a valid URL ({e})."))?;
    match u.scheme() {
        "http" | "https" => {
            if u.host_str().is_none_or(str::is_empty) {
                return Err("The URL has no host.".into());
            }
        }
        "about" if u.as_str() == "about:blank" => return Ok(u),
        other => return Err(format!("Only http, https and about:blank can be opened (not {other}:).")),
    }
    if !u.username().is_empty() || u.password().is_some() {
        return Err("URLs with embedded credentials are refused.".into());
    }
    Ok(u)
}

/// One parsed allowlist entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AllowEntry {
    /// `*.example.com`: example.com and every subdomain.
    pub wildcard: bool,
    /// Lowercase host as the url crate prints it (IPv6 in brackets).
    pub host: String,
    pub port: Option<u16>,
}

impl AllowEntry {
    pub fn matches(&self, host: &str, port: Option<u16>) -> bool {
        if self.port.is_some() && self.port != port {
            return false;
        }
        let host = host.trim_end_matches('.');
        if self.wildcard {
            host == self.host || host.strip_suffix(self.host.as_str()).is_some_and(|rest| rest.ends_with('.'))
        } else {
            host == self.host
        }
    }
}

/// Parse an entry the user typed (a pasted URL works too: scheme, path, query and fragment are dropped).
pub fn parse_entry(raw: &str) -> Option<AllowEntry> {
    let lower = raw.trim().to_ascii_lowercase();
    let mut s = lower.as_str();
    for scheme in ["http://", "https://"] {
        if let Some(rest) = s.strip_prefix(scheme) {
            s = rest;
        }
    }
    let s = s.split(['/', '?', '#']).next().unwrap_or("");
    if s.is_empty() || s.len() > 260 || s.contains('@') || s.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return None;
    }
    let (wildcard, rest) = match s.strip_prefix("*.") {
        Some(r) => (true, r),
        None => (false, s),
    };
    if rest.contains('*') {
        return None;
    }
    let u = Url::parse(&format!("http://{rest}/")).ok()?;
    let host = u.host()?;
    if wildcard && !matches!(host, Host::Domain(_)) {
        return None;
    }
    let host_str = u.host_str()?.trim_end_matches('.').to_string();
    if host_str.is_empty() {
        return None;
    }
    Some(AllowEntry { wildcard, host: host_str, port: u.port() })
}

/// The canonical text of an entry (`*.host:port`), or `None` when it is not a valid entry.
pub fn normalize_entry(raw: &str) -> Option<String> {
    let e = parse_entry(raw)?;
    let mut out = String::new();
    if e.wildcard {
        out.push_str("*.");
    }
    out.push_str(&e.host);
    if let Some(p) = e.port {
        out.push(':');
        out.push_str(&p.to_string());
    }
    Some(out)
}

/// Normalize, drop invalid entries and duplicates (first wins), cap the count.
pub fn normalize_allowlist(entries: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for e in entries {
        if let Some(n) = normalize_entry(e) {
            if !out.contains(&n) {
                out.push(n);
            }
        }
        if out.len() >= MAX_ALLOW_ENTRIES {
            break;
        }
    }
    out
}

pub fn is_loopback(host: &Host<&str>) -> bool {
    match host {
        Host::Domain(d) => {
            let d = d.trim_end_matches('.').to_ascii_lowercase();
            d == "localhost" || d.ends_with(".localhost")
        }
        Host::Ipv4(ip) => ip.is_loopback() || ip.is_unspecified(),
        Host::Ipv6(ip) => {
            ip.is_loopback() || ip.is_unspecified() || ip.to_ipv4_mapped().is_some_and(|v4| v4.is_loopback())
        }
    }
}

/// RFC 1918 / link-local IPv4, unique-local / link-local IPv6.
pub fn is_private(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_private() || v4.is_link_local(),
        IpAddr::V6(v6) => {
            let first = v6.segments()[0];
            (first & 0xfe00) == 0xfc00 || (first & 0xffc0) == 0xfe80 || v6.to_ipv4_mapped().is_some_and(|m| m.is_private())
        }
    }
}

/// Whether actions on `u` (form submission, scripts) run without asking. `dev_ports` is only called
/// for a private-range address: the ports the workspace's sessions listen on.
pub fn origin_allowed(u: &Url, allowlist: &[String], dev_ports: impl FnOnce() -> Vec<u16>) -> bool {
    if u.as_str() == "about:blank" {
        return true;
    }
    if !matches!(u.scheme(), "http" | "https") {
        return false;
    }
    let Some(host) = u.host() else { return false };
    if is_loopback(&host) {
        return true;
    }
    let port = u.port_or_known_default();
    let host_str = u.host_str().unwrap_or("").to_ascii_lowercase();
    if allowlist.iter().filter_map(|e| parse_entry(e)).any(|e| e.matches(&host_str, port)) {
        return true;
    }
    let ip = match host {
        Host::Ipv4(v4) => Some(IpAddr::V4(v4)),
        Host::Ipv6(v6) => Some(IpAddr::V6(v6)),
        Host::Domain(_) => None,
    };
    match (ip, port) {
        (Some(ip), Some(p)) if is_private(ip) => dev_ports().contains(&p),
        _ => false,
    }
}

/// `scheme://host[:port]` for prompts and logs (no path, no query).
pub fn origin_label(u: &Url) -> String {
    if u.as_str() == "about:blank" {
        return "about:blank".into();
    }
    u.origin().ascii_serialization()
}

/// The host part an "always allow" answer adds to the allowlist (`host` or `host:port` for a
/// non-default port).
pub fn allow_entry_for(u: &Url) -> Option<String> {
    let host = u.host_str()?;
    let entry = match u.port() {
        Some(p) => format!("{host}:{p}"),
        None => host.to_string(),
    };
    normalize_entry(&entry)
}

/// A URL for logs: no query or fragment (they often carry tokens), at most 200 characters.
pub fn log_url(raw: &str) -> String {
    let cut = match Url::parse(raw) {
        Ok(mut u) if matches!(u.scheme(), "http" | "https") => {
            u.set_query(None);
            u.set_fragment(None);
            u.to_string()
        }
        _ => raw.split(['?', '#']).next().unwrap_or("").to_string(),
    };
    crate::redact::redact(&truncate(&cut, 200))
}

/// At most `max` characters (on a char boundary), with an ellipsis when cut.
pub fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}
