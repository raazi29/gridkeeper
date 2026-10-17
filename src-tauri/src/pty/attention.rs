//! Attention detection: notice when a session needs the user, without a view
//! being attached and without interpreting anything beyond a few signals.
//!
//! * [`AttentionScanner`] — a streaming, split-safe byte scanner run on the
//!   PTY reader thread. It recognises only:
//!   - a bare BEL (0x07 outside of any OSC/DCS/APC/PM/SOS string),
//!   - OSC 9 notifications (`ESC ] 9 ; text ST`), ignoring ConEmu-style
//!     numeric sub-commands such as `9;4;…` progress and `9;9;…` cwd,
//!   - OSC 777 (`ESC ] 777 ; notify ; title ; body ST`),
//!   - OSC 99 (kitty desktop notifications, best effort),
//!   - OSC 7501 program status (`ESC ] 7501 ; state=…:kind=…:title=b64:msg=b64 ST`)
//!     and its feature probe `ESC ] 7501 ; ? ST`, which the session answers,
//!   - OSC 0/2 title changes (used only as activity evidence, never emitted).
//!
//!   Everything else is skipped. Captured text is capped and stripped of
//!   control characters.
//! * [`Activity`] — pure "working → quiet" state machine (time injected).
//! * [`AttentionHub`] / [`Tracker`] — per-session rate limiting and one shared
//!   monitor thread that sleeps on a condvar, with a timeout only while some
//!   session is active (fully parked when every session is quiet).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};

use base64::Engine as _;
use parking_lot::{Condvar, Mutex};

use crate::types::{AttentionKind, SessionAttention, SessionId};

const ESC: u8 = 0x1b;
const BEL: u8 = 0x07;
const CAN: u8 = 0x18;
const SUB: u8 = 0x1a;

/// Longest OSC payload kept (the OSC 7501 spec limit). Longer strings (e.g.
/// OSC 52 clipboard payloads) are skipped until their terminator.
pub const MAX_OSC: usize = 4096;
/// Maximum characters of captured title/body text.
pub const MAX_TEXT: usize = 200;
/// Minimum spacing between bell/notify events of one session.
pub const ALERT_INTERVAL: Duration = Duration::from_secs(2);

/// Reply to the OSC 7501 feature probe (`ESC ] 7501 ; ? ST`).
pub const STATUS_PROBE_REPLY: &[u8] =
    b"\x1b]7501;?:states=idle,working,done,blocked,error,clear:kinds=permission,question,auth\x1b\\";

/// Encode text as win32-input-mode key events (`CSI Vk;Sc;Uc;Kd;Cs;Rc _`,
/// key down + key up per UTF-16 unit). ConPTY enables this mode (`CSI ?9001h`)
/// and its input parser drops OSC strings written raw, so a reply to an OSC
/// query only reaches the program when "typed" this way; a VT-input client
/// (Node, crossterm) then reads the original characters.
pub fn win32_input_encode(text: &[u8]) -> Vec<u8> {
    let s = String::from_utf8_lossy(text);
    let mut out = Vec::with_capacity(s.len() * 24);
    // Every event is exactly 16 bytes (`ESC [ VV ; ; UUUU ; K ; ; 1 _`, empty
    // params = 0): conhost reads its input pipe in 256-byte pieces and does
    // not resume a sequence split across two reads, so the events must tile
    // those reads exactly.
    for unit in s.encode_utf16() {
        // Fixed width needs UTF-16 units <= 9999 (the probe reply is ASCII).
        debug_assert!(unit <= 9999, "win32_input_encode: unit {unit} too wide");
        let vk = if unit == 0x1b { 27 } else { 0 };
        for kd in [1, 0] {
            out.extend_from_slice(format!("\x1b[{vk:02};;{unit:04};{kd};;1_").as_bytes());
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Signal {
    Bell,
    Notify { title: Option<String>, body: Option<String> },
    /// OSC 7501 report. `state` is lower-case; `reason` is the blocked `kind`.
    Status { state: String, reason: Option<String>, title: Option<String>, body: Option<String> },
    /// OSC 7501 feature probe: the host must answer before its DA1 reply.
    StatusProbe,
    /// OSC 0/2 window title changed (activity evidence only).
    Title,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum St {
    Ground,
    Esc,
    Csi,
    Osc,
    OscEsc,
    /// DCS / SOS / PM / APC: skipped until ST (BEL/CAN/SUB also end it).
    Str,
    StrEsc,
}

#[derive(Default)]
struct KittyPending {
    id: String,
    title: Option<String>,
    body: Option<String>,
}

pub struct AttentionScanner {
    st: St,
    osc: Vec<u8>,
    osc_overflow: bool,
    last_title: Option<Vec<u8>>,
    kitty: Option<KittyPending>,
}

impl Default for AttentionScanner {
    fn default() -> Self {
        Self::new()
    }
}

impl AttentionScanner {
    pub fn new() -> Self {
        Self { st: St::Ground, osc: Vec::new(), osc_overflow: false, last_title: None, kitty: None }
    }

    /// Feed a chunk of raw PTY output; returns the signals completed in it.
    /// Allocates only when a signal is found or an OSC string is captured.
    pub fn feed(&mut self, data: &[u8]) -> Vec<Signal> {
        let mut out = Vec::new();
        let mut i = 0;
        while i < data.len() {
            if self.st == St::Ground {
                // Fast path: jump to the next byte that can matter.
                match data[i..].iter().position(|&b| b == ESC || b == BEL) {
                    Some(p) => i += p,
                    None => break,
                }
            }
            let b = data[i];
            i += 1;
            self.step(b, &mut out);
        }
        out
    }

    fn step(&mut self, b: u8, out: &mut Vec<Signal>) {
        match self.st {
            St::Ground => match b {
                BEL => out.push(Signal::Bell),
                ESC => self.st = St::Esc,
                _ => {}
            },
            St::Esc => self.after_esc(b, out),
            St::Csi => match b {
                // C0 controls inside a CSI are executed by terminals.
                BEL => out.push(Signal::Bell),
                ESC => self.st = St::Esc,
                CAN | SUB => self.st = St::Ground,
                0x40..=0x7e => self.st = St::Ground,
                _ => {}
            },
            St::Osc => match b {
                BEL => self.finish_osc(out),
                ESC => self.st = St::OscEsc,
                CAN | SUB => self.st = St::Ground,
                _ => {
                    if self.osc.len() < MAX_OSC {
                        self.osc.push(b);
                    } else {
                        self.osc_overflow = true;
                    }
                }
            },
            St::OscEsc => {
                if b == b'\\' {
                    self.finish_osc(out);
                } else {
                    // A new escape aborts the string.
                    self.after_esc(b, out);
                }
            }
            St::Str => match b {
                BEL | CAN | SUB => self.st = St::Ground,
                ESC => self.st = St::StrEsc,
                _ => {}
            },
            St::StrEsc => {
                if b == b'\\' {
                    self.st = St::Ground;
                } else {
                    self.after_esc(b, out);
                }
            }
        }
    }

    fn after_esc(&mut self, b: u8, out: &mut Vec<Signal>) {
        self.st = match b {
            b']' => {
                self.osc.clear();
                self.osc_overflow = false;
                St::Osc
            }
            b'[' => St::Csi,
            b'P' | b'X' | b'^' | b'_' => St::Str,
            ESC => St::Esc,
            BEL => {
                out.push(Signal::Bell);
                St::Ground
            }
            // nF intermediates (ESC ( B …) and two-byte escapes: the rest is
            // printable and harmless in Ground.
            _ => St::Ground,
        };
    }

    fn finish_osc(&mut self, out: &mut Vec<Signal>) {
        self.st = St::Ground;
        if self.osc_overflow {
            self.osc.clear();
            return;
        }
        let payload = std::mem::take(&mut self.osc);
        if let Some(sig) = self.parse_osc(&payload) {
            out.push(sig);
        }
        // Keep the allocation for the next string.
        self.osc = payload;
        self.osc.clear();
    }

    fn parse_osc(&mut self, p: &[u8]) -> Option<Signal> {
        let semi = p.iter().position(|&b| b == b';');
        let (ps, rest) = match semi {
            Some(i) => (&p[..i], &p[i + 1..]),
            None => (p, &p[p.len()..]),
        };
        match ps {
            b"0" | b"2" => {
                if self.last_title.as_deref() == Some(rest) {
                    return None;
                }
                self.last_title = Some(rest.to_vec());
                Some(Signal::Title)
            }
            b"9" => {
                if is_conemu_subcommand(rest) {
                    return None;
                }
                let body = clean_text(rest)?;
                Some(Signal::Notify { title: None, body: Some(body) })
            }
            b"777" => {
                let mut parts = rest.splitn(3, |&b| b == b';');
                if parts.next()? != b"notify" {
                    return None;
                }
                let title = parts.next().and_then(clean_text);
                let body = parts.next().and_then(clean_text);
                if title.is_none() && body.is_none() {
                    return None;
                }
                Some(Signal::Notify { title, body })
            }
            b"99" => self.parse_kitty(rest),
            b"7501" => parse_status(rest),
            _ => None,
        }
    }

    /// Kitty OSC 99: `99 ; k=v:k=v ; payload`. Supports `p=title|body`,
    /// `d=0` chunking (accumulated per id) and `e=1` base64 payloads.
    fn parse_kitty(&mut self, rest: &[u8]) -> Option<Signal> {
        let semi = rest.iter().position(|&b| b == b';')?;
        let (meta, payload) = (&rest[..semi], &rest[semi + 1..]);
        let mut id = String::new();
        let mut done = true;
        let mut part = "title".to_string();
        let mut b64 = false;
        for kv in meta.split(|&b| b == b':') {
            let Some(eq) = kv.iter().position(|&b| b == b'=') else { continue };
            let (k, v) = (&kv[..eq], &kv[eq + 1..]);
            let v = String::from_utf8_lossy(v).into_owned();
            match k {
                b"i" => id = v.chars().take(64).collect(),
                b"d" => done = v != "0",
                b"p" => part = v,
                b"e" => b64 = v == "1",
                _ => {}
            }
        }
        if part != "title" && part != "body" {
            return None; // close / icon / query / alive …
        }
        let text = if b64 { decode_b64_text(payload) } else { clean_text(payload) };
        let pending = match self.kitty.take() {
            Some(k) if k.id == id => k,
            _ => KittyPending { id: id.clone(), ..Default::default() },
        };
        let mut pending = pending;
        if let Some(t) = text {
            let slot = if part == "title" { &mut pending.title } else { &mut pending.body };
            *slot = Some(match slot.take() {
                Some(prev) => cap_chars(&format!("{prev}{t}")),
                None => t,
            });
        }
        if !done {
            self.kitty = Some(pending);
            return None;
        }
        if pending.title.is_none() && pending.body.is_none() {
            return None;
        }
        Some(Signal::Notify { title: pending.title, body: pending.body })
    }
}

/// ConEmu OSC 9 sub-commands (`9;1` … `9;12`, e.g. `9;4;st;pct` progress,
/// `9;9;cwd`) are not notifications.
fn is_conemu_subcommand(rest: &[u8]) -> bool {
    let digits = rest.iter().take_while(|b| b.is_ascii_digit()).count();
    if digits == 0 || digits > 2 {
        return false;
    }
    let n: u32 = std::str::from_utf8(&rest[..digits]).ok().and_then(|s| s.parse().ok()).unwrap_or(0);
    (1..=12).contains(&n) && (rest.len() == digits || rest[digits] == b';')
}

fn parse_status(rest: &[u8]) -> Option<Signal> {
    if rest.first() == Some(&b'?') {
        return Some(Signal::StatusProbe);
    }
    let mut state = None;
    let mut reason = None;
    let mut title = None;
    let mut body = None;
    for kv in rest.split(|&b| b == b':') {
        let Some(eq) = kv.iter().position(|&b| b == b'=') else { continue };
        let (k, v) = (&kv[..eq], &kv[eq + 1..]);
        match k {
            b"state" => state = Some(token(v)),
            b"kind" => reason = Some(token(v)).filter(|s| !s.is_empty()),
            b"title" => title = decode_b64_text(v),
            b"msg" => body = decode_b64_text(v),
            _ => {}
        }
    }
    let state = state.filter(|s| !s.is_empty())?;
    Some(Signal::Status { state, reason, title, body })
}

/// Lower-case `[a-z0-9_-]` token, at most 32 chars.
fn token(v: &[u8]) -> String {
    v.iter()
        .take(32)
        .map(|b| b.to_ascii_lowercase())
        .filter(|b| b.is_ascii_alphanumeric() || *b == b'_' || *b == b'-')
        .map(char::from)
        .collect()
}

fn decode_b64_text(v: &[u8]) -> Option<String> {
    let v: Vec<u8> = v.iter().copied().filter(|b| !b.is_ascii_whitespace()).take(MAX_OSC).collect();
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&v)
        .or_else(|_| base64::engine::general_purpose::STANDARD_NO_PAD.decode(&v))
        .ok()?;
    clean_text(&bytes)
}

fn cap_chars(s: &str) -> String {
    s.chars().take(MAX_TEXT).collect()
}

/// Lossy UTF-8, control characters removed, whitespace trimmed, capped.
pub fn clean_text(raw: &[u8]) -> Option<String> {
    let s = String::from_utf8_lossy(raw);
    let cleaned: String = s.chars().filter(|c| !c.is_control()).collect();
    let t = cleaned.trim();
    if t.is_empty() { None } else { Some(cap_chars(t)) }
}

// ---------------------------------------------------------------------------
// Activity state machine
// ---------------------------------------------------------------------------

/// Two counted chunks this close together start an active run.
pub const ACTIVE_GAP: Duration = Duration::from_millis(1500);
/// An active run ends after this long without output.
pub const IDLE_AFTER: Duration = Duration::from_secs(4);
/// A run at least this long is reported as "done" when it ends.
pub const MIN_RUN_FOR_DONE: Duration = Duration::from_secs(3);
/// Runs starting this soon after launch are start-up noise, never "done".
pub const STARTUP_GRACE: Duration = Duration::from_secs(8);
/// Output this soon after user input / resize is treated as echo / repaint.
pub const ECHO_WINDOW: Duration = Duration::from_millis(250);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActivityEvent {
    Active,
    Idle { active_for: Duration, done: bool },
}

#[derive(Debug, Clone)]
pub struct Activity {
    started: Instant,
    active: bool,
    run_start: Option<Instant>,
    last_chunk: Option<Instant>,
}

impl Activity {
    pub fn new(started: Instant) -> Self {
        Self { started, active: false, run_start: None, last_chunk: None }
    }

    pub fn is_active(&self) -> bool {
        self.active
    }

    /// Record a chunk. `counts` is false for echo / repaint output, which can
    /// keep an active run alive but never starts one.
    pub fn on_chunk(&mut self, now: Instant, counts: bool) -> Option<ActivityEvent> {
        if self.active {
            self.last_chunk = Some(now);
            return None;
        }
        if !counts {
            return None;
        }
        match self.last_chunk {
            Some(prev) if now.saturating_duration_since(prev) <= ACTIVE_GAP => {
                self.active = true;
                self.run_start = Some(prev);
                self.last_chunk = Some(now);
                Some(ActivityEvent::Active)
            }
            _ => {
                self.last_chunk = Some(now);
                None
            }
        }
    }

    /// When the current run will time out (None when not active).
    pub fn deadline(&self) -> Option<Instant> {
        if self.active { self.last_chunk.map(|t| t + IDLE_AFTER) } else { None }
    }

    /// Advance time; ends the run once it has been quiet for `IDLE_AFTER`.
    pub fn poll(&mut self, now: Instant) -> Option<ActivityEvent> {
        let deadline = self.deadline()?;
        if now < deadline {
            return None;
        }
        let last = self.last_chunk.unwrap_or(now);
        let start = self.run_start.unwrap_or(last);
        let active_for = last.saturating_duration_since(start);
        let after_startup = start.saturating_duration_since(self.started) >= STARTUP_GRACE;
        self.active = false;
        self.run_start = None;
        self.last_chunk = None;
        Some(ActivityEvent::Idle { active_for, done: active_for >= MIN_RUN_FOR_DONE && after_startup })
    }
}

// ---------------------------------------------------------------------------
// Per-session tracker + shared monitor
// ---------------------------------------------------------------------------

pub type AttentionSink = Arc<dyn Fn(&SessionAttention) + Send + Sync>;

struct TrackerState {
    activity: Activity,
    last_alert: Option<Instant>,
    last_status: Option<(String, Option<String>)>,
    last_input: Option<Instant>,
    /// The program speaks OSC 7501: its own status replaces the heuristic.
    status_protocol: bool,
}

/// Attention state of one session run. Created by [`AttentionHub::tracker`].
pub struct Tracker {
    id: SessionId,
    hub: Weak<HubShared>,
    st: Mutex<TrackerState>,
    closed: AtomicBool,
}

fn event(id: &str, kind: AttentionKind) -> SessionAttention {
    SessionAttention { id: id.to_string(), kind, title: None, body: None, status: None, reason: None, active_ms: None }
}

impl Tracker {
    /// User input or a resize just happened: the next output is likely echo.
    pub fn note_input(&self, now: Instant) {
        self.st.lock().last_input = Some(now);
    }

    /// No more events for this run (exited, removed or replaced).
    pub fn close(&self) {
        self.closed.store(true, Ordering::Release);
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Acquire)
    }

    /// Reader thread: a chunk arrived with the scanner's `signals`.
    pub fn on_output(self: &Arc<Self>, signals: &[Signal], now: Instant) {
        if self.is_closed() {
            return;
        }
        let Some(hub) = self.hub.upgrade() else { return };
        let mut events: Vec<SessionAttention> = Vec::new();
        let became_active;
        {
            let mut st = self.st.lock();
            let echo = st.last_input.is_some_and(|t| now.saturating_duration_since(t) < ECHO_WINDOW);
            let title_change = signals.iter().any(|s| matches!(s, Signal::Title));
            if signals.iter().any(|s| matches!(s, Signal::Status { .. })) {
                st.status_protocol = true;
            }
            let ev = st.activity.on_chunk(now, !echo || title_change);
            // With OSC 7501 the program's own status replaces the heuristic.
            became_active = ev == Some(ActivityEvent::Active) && !st.status_protocol;
            if became_active {
                events.push(event(&self.id, AttentionKind::Active));
            }
            for sig in signals {
                match sig {
                    Signal::Bell | Signal::Notify { .. } => {
                        if st.last_alert.is_some_and(|t| now.saturating_duration_since(t) < ALERT_INTERVAL) {
                            continue;
                        }
                        st.last_alert = Some(now);
                        let mut e = event(&self.id, if matches!(sig, Signal::Bell) { AttentionKind::Bell } else { AttentionKind::Notify });
                        if let Signal::Notify { title, body } = sig {
                            e.title = title.clone();
                            e.body = body.clone();
                        }
                        events.push(e);
                    }
                    Signal::Status { state, reason, title, body } => {
                        let key = (state.clone(), reason.clone());
                        if st.last_status.as_ref() == Some(&key) && title.is_none() && body.is_none() {
                            continue;
                        }
                        st.last_status = Some(key);
                        let mut e = event(&self.id, AttentionKind::Status);
                        e.status = Some(state.clone());
                        e.reason = reason.clone();
                        e.title = title.clone();
                        e.body = body.clone();
                        events.push(e);
                    }
                    Signal::StatusProbe | Signal::Title => {}
                }
            }
        }
        if became_active {
            hub.activate(Arc::clone(self));
        }
        for e in &events {
            hub.emit(e);
        }
    }

    /// Monitor thread: advance time. Returns the idle event (if the run ended)
    /// and whether the tracker is still active.
    fn poll(&self, now: Instant) -> (Option<SessionAttention>, Option<Instant>) {
        let mut st = self.st.lock();
        match st.activity.poll(now) {
            Some(ActivityEvent::Idle { active_for, done }) => {
                if st.status_protocol || self.is_closed() {
                    return (None, None);
                }
                let mut e = event(&self.id, AttentionKind::Idle);
                e.status = done.then(|| "done".to_string());
                e.active_ms = Some(active_for.as_millis() as u64);
                (Some(e), None)
            }
            _ => (None, st.activity.deadline()),
        }
    }
}

struct HubState {
    active: Vec<Arc<Tracker>>,
    thread_started: bool,
    shutdown: bool,
}

struct HubShared {
    st: Mutex<HubState>,
    cv: Condvar,
    sink: AttentionSink,
}

impl HubShared {
    fn emit(&self, e: &SessionAttention) {
        (self.sink)(e);
    }

    fn activate(self: &Arc<Self>, t: Arc<Tracker>) {
        let mut st = self.st.lock();
        if st.shutdown {
            return;
        }
        if !st.active.iter().any(|x| Arc::ptr_eq(x, &t)) {
            st.active.push(t);
        }
        if !st.thread_started {
            st.thread_started = true;
            let weak = Arc::downgrade(self);
            let spawned = super::session::spawn_guarded("pty-attention".into(), move || monitor_loop(weak));
            if let Err(e) = spawned {
                st.thread_started = false;
                tracing::warn!(error = %e, "could not start attention monitor");
            }
        }
        self.cv.notify_one();
    }
}

fn monitor_loop(weak: Weak<HubShared>) {
    // The thread keeps the shared state alive; `AttentionHub::drop` sets
    // `shutdown` and wakes it, which ends the loop and releases it.
    let Some(shared) = weak.upgrade() else { return };
    drop(weak);
    let mut st = shared.st.lock();
    loop {
        if st.shutdown {
            return;
        }
        st.active.retain(|t| !t.is_closed());
        if st.active.is_empty() {
            shared.cv.wait(&mut st);
            continue;
        }
        let now = Instant::now();
        let mut fired = Vec::new();
        let mut next: Option<Instant> = None;
        st.active.retain(|t| {
            let (ev, deadline) = t.poll(now);
            if let Some(e) = ev {
                fired.push(e);
            }
            if let Some(d) = deadline {
                next = Some(next.map_or(d, |n| n.min(d)));
                true
            } else {
                false
            }
        });
        if !fired.is_empty() {
            parking_lot::MutexGuard::unlocked(&mut st, || {
                for e in &fired {
                    shared.emit(e);
                }
            });
            continue;
        }
        if let Some(d) = next {
            shared.cv.wait_until(&mut st, d);
        }
    }
}

/// Owner of the shared monitor thread; one per `SessionCore`.
pub struct AttentionHub {
    shared: Arc<HubShared>,
}

impl AttentionHub {
    pub fn new(sink: AttentionSink) -> Self {
        Self {
            shared: Arc::new(HubShared {
                st: Mutex::new(HubState { active: Vec::new(), thread_started: false, shutdown: false }),
                cv: Condvar::new(),
                sink,
            }),
        }
    }

    pub fn tracker(&self, id: &str, started: Instant) -> Arc<Tracker> {
        Arc::new(Tracker {
            id: id.to_string(),
            hub: Arc::downgrade(&self.shared),
            st: Mutex::new(TrackerState {
                activity: Activity::new(started),
                last_alert: None,
                last_status: None,
                last_input: None,
                status_protocol: false,
            }),
            closed: AtomicBool::new(false),
        })
    }

    /// Number of sessions currently tracked as active (tests / diagnostics).
    pub fn active_count(&self) -> usize {
        self.shared.st.lock().active.iter().filter(|t| !t.is_closed()).count()
    }
}

impl Drop for AttentionHub {
    fn drop(&mut self) {
        let mut st = self.shared.st.lock();
        st.shutdown = true;
        st.active.clear();
        self.shared.cv.notify_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed_all(s: &mut AttentionScanner, parts: &[&[u8]]) -> Vec<Signal> {
        parts.iter().flat_map(|p| s.feed(p)).collect()
    }

    fn notify(title: Option<&str>, body: Option<&str>) -> Signal {
        Signal::Notify { title: title.map(Into::into), body: body.map(Into::into) }
    }

    #[test]
    fn bare_bell_detected() {
        let mut s = AttentionScanner::new();
        assert_eq!(s.feed(b"hello\x07world"), vec![Signal::Bell]);
        assert_eq!(s.feed(b"\x07\x07"), vec![Signal::Bell, Signal::Bell]);
        assert!(s.feed(b"plain text, no controls").is_empty());
    }

    #[test]
    fn bel_terminating_osc_is_not_a_bell() {
        let mut s = AttentionScanner::new();
        assert!(s.feed(b"\x1b]0;my title\x07").contains(&Signal::Title));
        assert!(!s.feed(b"\x1b]8;;https://x\x07link\x1b]8;;\x07").contains(&Signal::Bell));
        // DCS / APC strings
        assert!(s.feed(b"\x1bPq#0;2;0;0;0\x07").is_empty());
        assert!(s.feed(b"\x1b_Gf=24;AAAA\x07").is_empty());
        // ...but a BEL after the string is a bell
        assert_eq!(s.feed(b"\x1b]2;t2\x1b\\\x07"), vec![Signal::Title, Signal::Bell]);
    }

    #[test]
    fn bel_inside_csi_is_executed() {
        let mut s = AttentionScanner::new();
        assert_eq!(s.feed(b"\x1b[1\x07;2m"), vec![Signal::Bell]);
    }

    #[test]
    fn osc9_notification_both_terminators() {
        let mut s = AttentionScanner::new();
        assert_eq!(s.feed(b"\x1b]9;Build finished\x07"), vec![notify(None, Some("Build finished"))]);
        assert_eq!(s.feed(b"\x1b]9;Tests done\x1b\\"), vec![notify(None, Some("Tests done"))]);
    }

    #[test]
    fn osc9_conemu_subcommands_ignored() {
        let mut s = AttentionScanner::new();
        assert!(s.feed(b"\x1b]9;4;1;50\x07").is_empty());
        assert!(s.feed(b"\x1b]9;4;0\x1b\\").is_empty());
        assert!(s.feed(b"\x1b]9;9;C:\\Users\\me\x07").is_empty());
        assert!(s.feed(b"\x1b]9;12\x07").is_empty());
        // A message that merely starts with a number is still a notification.
        assert_eq!(s.feed(b"\x1b]9;4 tests failed\x07"), vec![notify(None, Some("4 tests failed"))]);
    }

    #[test]
    fn osc777_notify() {
        let mut s = AttentionScanner::new();
        assert_eq!(s.feed(b"\x1b]777;notify;Claude;Needs approval; really\x07"), vec![notify(Some("Claude"), Some("Needs approval; really"))]);
        assert!(s.feed(b"\x1b]777;preexec\x07").is_empty());
    }

    #[test]
    fn osc99_kitty_best_effort() {
        let mut s = AttentionScanner::new();
        assert_eq!(s.feed(b"\x1b]99;;Hello\x1b\\"), vec![notify(Some("Hello"), None)]);
        // chunked title + body with the same id
        let sig = feed_all(&mut s, &[b"\x1b]99;i=1:d=0;Title\x1b\\", b"\x1b]99;i=1:p=body;Body text\x1b\\"]);
        assert_eq!(sig, vec![notify(Some("Title"), Some("Body text"))]);
        // base64 payload
        assert_eq!(s.feed(b"\x1b]99;e=1;SGk=\x1b\\"), vec![notify(Some("Hi"), None)]);
        // non-text parts ignored
        assert!(s.feed(b"\x1b]99;p=close;\x1b\\").is_empty());
    }

    #[test]
    fn osc7501_status_and_probe() {
        let mut s = AttentionScanner::new();
        assert_eq!(s.feed(b"\x1b]7501;?\x1b\\"), vec![Signal::StatusProbe]);
        assert_eq!(
            s.feed(b"\x1b]7501;state=working:progress=40\x1b\\"),
            vec![Signal::Status { state: "working".into(), reason: None, title: None, body: None }]
        );
        // title "Deploy", msg "Apply plan?"
        assert_eq!(
            s.feed(b"\x1b]7501;state=Blocked:kind=permission:app=tf:title=RGVwbG95:msg=QXBwbHkgcGxhbj8=\x07"),
            vec![Signal::Status {
                state: "blocked".into(),
                reason: Some("permission".into()),
                title: Some("Deploy".into()),
                body: Some("Apply plan?".into())
            }]
        );
        // missing state is discarded
        assert!(s.feed(b"\x1b]7501;kind=question\x1b\\").is_empty());
    }

    #[test]
    fn sequences_split_across_reads() {
        let mut s = AttentionScanner::new();
        let whole: &[u8] = b"ab\x1b]777;notify;T;B\x1b\\cd\x1b]9;4;1;5\x07\x07\x1b]7501;state=done\x07";
        let expect = vec![notify(Some("T"), Some("B")), Signal::Bell, Signal::Status { state: "done".into(), reason: None, title: None, body: None }];
        // every split point, byte by byte included
        for cut in 0..whole.len() {
            let mut s2 = AttentionScanner::new();
            assert_eq!(feed_all(&mut s2, &[&whole[..cut], &whole[cut..]]), expect, "cut at {cut}");
        }
        let bytes: Vec<&[u8]> = whole.chunks(1).collect();
        assert_eq!(feed_all(&mut s, &bytes), expect);
    }

    #[test]
    fn esc_then_bel_split() {
        let mut s = AttentionScanner::new();
        // OSC terminated by BEL split right before the BEL: still not a bell.
        assert_eq!(feed_all(&mut s, &[b"\x1b]0;x", b"\x07"]), vec![Signal::Title]);
        // OSC ST split between ESC and backslash.
        assert_eq!(feed_all(&mut s, &[b"\x1b]9;hi\x1b", b"\\"]), vec![notify(None, Some("hi"))]);
    }

    #[test]
    fn text_is_capped_and_stripped() {
        let mut s = AttentionScanner::new();
        let long = format!("\x1b]9;{}\x07", "x".repeat(1000));
        match &s.feed(long.as_bytes())[..] {
            [Signal::Notify { body: Some(b), .. }] => assert_eq!(b.chars().count(), MAX_TEXT),
            other => panic!("unexpected {other:?}"),
        }
        assert_eq!(s.feed(b"\x1b]9;a\tb\x01c\x07"), vec![notify(None, Some("abc"))]);
        // oversize OSC (e.g. OSC 52) is skipped entirely, and parsing recovers
        let huge = format!("\x1b]9;{}\x07after\x07", "y".repeat(MAX_OSC * 2));
        assert_eq!(s.feed(huge.as_bytes()), vec![Signal::Bell]);
    }

    #[test]
    fn win32_input_events_are_fixed_width() {
        let enc = win32_input_encode(STATUS_PROBE_REPLY);
        assert_eq!(enc.len(), STATUS_PROBE_REPLY.len() * 2 * 16);
        assert!(enc.starts_with(b"\x1b[27;;0027;1;;1_\x1b[27;;0027;0;;1_\x1b[00;;0093;1;;1_"));
        for ev in enc.chunks(16) {
            assert_eq!(ev[0], 0x1b);
            assert_eq!(ev[15], b'_');
        }
    }

    #[test]
    fn titles_dedupe() {
        let mut s = AttentionScanner::new();
        assert_eq!(s.feed(b"\x1b]0;a\x07"), vec![Signal::Title]);
        assert!(s.feed(b"\x1b]2;a\x07").is_empty());
        assert_eq!(s.feed(b"\x1b]2;b\x07"), vec![Signal::Title]);
    }

    #[test]
    fn can_aborts_osc() {
        let mut s = AttentionScanner::new();
        assert_eq!(s.feed(b"\x1b]9;abc\x18\x07"), vec![Signal::Bell]);
    }

    // ---- activity -----------------------------------------------------------

    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }

    #[test]
    fn single_chunk_does_not_activate() {
        let t0 = Instant::now();
        let mut a = Activity::new(t0);
        assert_eq!(a.on_chunk(t0 + ms(10_000), true), None);
        assert_eq!(a.on_chunk(t0 + ms(12_000), true), None); // 2 s gap
        assert!(!a.is_active());
    }

    #[test]
    fn run_then_idle_done() {
        let t0 = Instant::now();
        let mut a = Activity::new(t0);
        let s = t0 + ms(10_000);
        assert_eq!(a.on_chunk(s, true), None);
        assert_eq!(a.on_chunk(s + ms(500), true), Some(ActivityEvent::Active));
        for i in 1..=8 {
            assert_eq!(a.on_chunk(s + ms(500 + i * 500), true), None);
        }
        let last = s + ms(4500);
        assert_eq!(a.deadline(), Some(last + IDLE_AFTER));
        assert_eq!(a.poll(last + ms(3999)), None);
        assert_eq!(a.poll(last + IDLE_AFTER), Some(ActivityEvent::Idle { active_for: ms(4500), done: true }));
        assert!(!a.is_active());
        assert_eq!(a.deadline(), None);
    }

    #[test]
    fn short_run_is_not_done() {
        let t0 = Instant::now();
        let mut a = Activity::new(t0);
        let s = t0 + ms(20_000);
        a.on_chunk(s, true);
        assert_eq!(a.on_chunk(s + ms(1000), true), Some(ActivityEvent::Active));
        assert_eq!(a.poll(s + ms(5000)), Some(ActivityEvent::Idle { active_for: ms(1000), done: false }));
    }

    #[test]
    fn startup_burst_is_not_done() {
        let t0 = Instant::now();
        let mut a = Activity::new(t0);
        for i in 0..20 {
            a.on_chunk(t0 + ms(i * 300), true);
        }
        let ev = a.poll(t0 + ms(19 * 300) + IDLE_AFTER);
        assert!(matches!(ev, Some(ActivityEvent::Idle { done: false, .. })));
    }

    #[test]
    fn echo_never_starts_but_extends_a_run() {
        let t0 = Instant::now();
        let mut a = Activity::new(t0);
        let s = t0 + ms(10_000);
        assert_eq!(a.on_chunk(s, false), None);
        assert_eq!(a.on_chunk(s + ms(100), false), None);
        assert!(!a.is_active());
        a.on_chunk(s + ms(200), true);
        assert_eq!(a.on_chunk(s + ms(300), true), Some(ActivityEvent::Active));
        a.on_chunk(s + ms(3000), false);
        assert_eq!(a.deadline(), Some(s + ms(3000) + IDLE_AFTER));
    }

    // ---- tracker / hub --------------------------------------------------------

    fn recording_hub() -> (AttentionHub, Arc<Mutex<Vec<SessionAttention>>>) {
        let log = Arc::new(Mutex::new(Vec::new()));
        let l = Arc::clone(&log);
        (AttentionHub::new(Arc::new(move |e: &SessionAttention| l.lock().push(e.clone()))), log)
    }

    #[test]
    fn alerts_are_rate_limited_per_session() {
        let (hub, log) = recording_hub();
        let t0 = Instant::now();
        let a = hub.tracker("a", t0);
        let b = hub.tracker("b", t0);
        a.on_output(&[Signal::Bell], t0 + ms(100));
        a.on_output(&[Signal::Bell, notify(None, Some("x"))], t0 + ms(900));
        b.on_output(&[Signal::Bell], t0 + ms(1000)); // other session: own budget
        a.on_output(&[notify(Some("t"), None)], t0 + ms(2200));
        let alerts: Vec<SessionAttention> =
            log.lock().iter().filter(|e| matches!(e.kind, AttentionKind::Bell | AttentionKind::Notify)).cloned().collect();
        let got: Vec<(String, AttentionKind)> = alerts.iter().map(|e| (e.id.clone(), e.kind)).collect();
        assert_eq!(
            got,
            vec![("a".into(), AttentionKind::Bell), ("b".into(), AttentionKind::Bell), ("a".into(), AttentionKind::Notify)]
        );
        assert_eq!(alerts[2].title.as_deref(), Some("t"));
    }

    #[test]
    fn status_dedupes_and_suppresses_heuristic() {
        let (hub, log) = recording_hub();
        let t0 = Instant::now();
        let a = hub.tracker("a", t0);
        let st = |s: &str| Signal::Status { state: s.into(), reason: None, title: None, body: None };
        a.on_output(&[st("working")], t0 + ms(20_000));
        a.on_output(&[st("working")], t0 + ms(20_100)); // duplicate + would activate
        a.on_output(&[st("done")], t0 + ms(20_200));
        let kinds: Vec<_> = log.lock().iter().map(|e| (e.kind, e.status.clone())).collect();
        assert_eq!(kinds, vec![(AttentionKind::Status, Some("working".into())), (AttentionKind::Status, Some("done".into()))]);
    }

    #[test]
    fn echo_after_input_does_not_activate() {
        let (hub, log) = recording_hub();
        let t0 = Instant::now();
        let a = hub.tracker("a", t0);
        let s = t0 + ms(20_000);
        for i in 0..5 {
            a.note_input(s + ms(i * 200));
            a.on_output(&[], s + ms(i * 200 + 20));
        }
        assert!(log.lock().is_empty());
        assert_eq!(hub.active_count(), 0);
    }

    #[test]
    fn monitor_emits_idle_and_parks() {
        let (hub, log) = recording_hub();
        // started long ago so the run counts as "done"
        let started = Instant::now() - Duration::from_secs(60);
        let a = hub.tracker("a", started);
        let now = Instant::now();
        // Simulate a 3.2 s run that ended 3.9 s ago: the monitor fires ~0.1 s later.
        a.on_output(&[], now - ms(7100));
        a.on_output(&[], now - ms(6600));
        a.on_output(&[], now - ms(3900));
        assert_eq!(hub.active_count(), 1);
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline && log.lock().len() < 2 {
            std::thread::sleep(ms(20));
        }
        let events = log.lock().clone();
        assert_eq!(events.len(), 2, "{events:?}");
        assert_eq!(events[0].kind, AttentionKind::Active);
        assert_eq!(events[1].kind, AttentionKind::Idle);
        assert_eq!(events[1].status.as_deref(), Some("done"));
        assert_eq!(events[1].active_ms, Some(3200));
        assert_eq!(hub.active_count(), 0);
    }

    #[test]
    fn closed_tracker_is_silent() {
        let (hub, log) = recording_hub();
        let t0 = Instant::now();
        let a = hub.tracker("a", t0);
        a.close();
        a.on_output(&[Signal::Bell], t0);
        assert!(log.lock().is_empty());
    }
}
