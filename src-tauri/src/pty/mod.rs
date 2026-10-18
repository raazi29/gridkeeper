//! ConPTY session management.
//!
//! Layout:
//! - [`SessionManager`] — the Tauri-facing API used by `commands::session`.
//!   A thin wrapper that wires [`SessionCore`] to `AppHandle::emit` and wraps
//!   IPC channels as output sinks.
//! - [`SessionCore`] — AppHandle-free session registry (testable).
//! - `session` — one ConPTY session: spawn, Job Object, reader/writer/waiter.
//! - `stream` — replay ring + attachment + coalescing pump + flow control.
//! - `ring` — bounded byte ring with absolute offsets.
//! - `job` — Windows Job Object wrapper (kill-on-close process trees).
//! - `text` — escape-sequence handling (plain-text export, query filter, CPR).
//! - `attention` — BEL / notification / OSC 7501 scanner and activity monitor
//!   (`session-attention` events, emitted even when no view is attached).
//!
//! Output framing (per-session `Channel<InvokeResponseBody>`): every message
//! is `InvokeResponseBody::Raw` whose first byte is `frame::DATA` (followed by
//! raw terminal bytes) or `frame::RESET` (terminal must be reset; replayed
//! bytes follow as DATA). Flow control: the frontend must call `ack(n)` with
//! the number of DATA *payload* bytes (excluding the type byte) it has
//! processed; the backend stops sending above 1 MiB unacknowledged and resumes
//! at 256 KiB.

pub mod attention;
mod job;
mod ring;
mod session;
mod stream;
pub mod text;

#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use parking_lot::{Mutex, RwLock};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter};

pub use job::Job;
use session::{EventSink, Session};
pub use stream::{FLUSH_BYTES, FLUSH_DELAY, HIGH_WATER, LOW_WATER, MAX_FRAME, OutputSink, SinkClosed};

use crate::types::*;

pub use session::{MAX_COLS, MAX_INPUT_QUEUE, MAX_ROWS, MIN_COLS, MIN_ROWS};
/// `catch_unwind`-wrapped named thread, also used by other modules' helper threads (e.g. `mission`).
pub(crate) use session::spawn_guarded;

/// Best-effort text of a panic payload, for logs.
pub(crate) fn panic_message(p: &Box<dyn std::any::Any + Send>) -> String {
    if let Some(s) = p.downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = p.downcast_ref::<String>() {
        s.clone()
    } else {
        "unknown panic".into()
    }
}

// ---------------------------------------------------------------------------
// SessionCore
// ---------------------------------------------------------------------------

/// Registry of sessions, independent of Tauri. State transitions are reported
/// through the callback given to [`SessionCore::new`]; attention events through
/// the second callback of [`SessionCore::with_attention`].
pub struct SessionCore {
    sessions: RwLock<HashMap<SessionId, Arc<Session>>>,
    /// Serializes `start` so duplicate-id checks and replacement are atomic.
    start_lock: Mutex<()>,
    events: EventSink,
    /// Shared attention monitor (one parked thread for all sessions).
    attention: attention::AttentionHub,
    /// Set during shutdown: stop emitting events (the webview may be gone).
    quiet: Arc<AtomicBool>,
    seq: AtomicU64,
}

impl SessionCore {
    pub fn new(on_state: impl Fn(&SessionInfo) + Send + Sync + 'static) -> Self {
        Self::with_attention(on_state, |_: &SessionAttention| {})
    }

    /// Like [`SessionCore::new`], also reporting attention events (bell,
    /// notifications, program status, activity start / stop).
    pub fn with_attention(
        on_state: impl Fn(&SessionInfo) + Send + Sync + 'static,
        on_attention: impl Fn(&SessionAttention) + Send + Sync + 'static,
    ) -> Self {
        let quiet = Arc::new(AtomicBool::new(false));
        let qa = Arc::clone(&quiet);
        let attention_sink: attention::AttentionSink = Arc::new(move |ev: &SessionAttention| {
            if qa.load(Ordering::Acquire) {
                return;
            }
            if let Err(p) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| on_attention(ev))) {
                tracing::error!(panic = %panic_message(&p), "session attention listener panicked");
            }
        });
        let q = Arc::clone(&quiet);
        let events: EventSink = Arc::new(move |info: &SessionInfo| {
            if q.load(Ordering::Acquire) {
                return;
            }
            // A misbehaving listener must not take a session thread down.
            if let Err(p) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| on_state(info))) {
                tracing::error!(panic = %panic_message(&p), "session state listener panicked");
            }
        });
        Self {
            sessions: RwLock::new(HashMap::new()),
            start_lock: Mutex::new(()),
            events,
            attention: attention::AttentionHub::new(attention_sink),
            quiet,
            seq: AtomicU64::new(0),
        }
    }

    fn get(&self, id: &str) -> AppResult<Arc<Session>> {
        self.sessions.read().get(id).cloned().ok_or_else(|| AppError::NotFound(format!("session {id}")))
    }

    /// Spawn a new session. A live session with the same id is an error; an
    /// exited/failed one is replaced (restart).
    pub fn start(&self, spec: SessionSpec, plan: LaunchPlan, buffer_bytes: usize) -> AppResult<SessionInfo> {
        if spec.id.trim().is_empty() {
            return Err(AppError::Invalid("session id must not be empty".into()));
        }
        let _serial = self.start_lock.lock();
        let previous = self.sessions.read().get(&spec.id).cloned();
        if let Some(prev) = &previous
            && prev.is_live()
        {
            return Err(AppError::Invalid(format!("Session '{}' is already running", spec.id)));
        }
        let seq = self.seq.fetch_add(1, Ordering::Relaxed);
        let tracker = self.attention.tracker(&spec.id, Instant::now());
        let session = Session::new(&spec, &plan, buffer_bytes, seq, Arc::clone(&self.events), tracker);
        self.sessions.write().insert(spec.id.clone(), Arc::clone(&session));
        if let Some(prev) = previous {
            // Views attached to the previous run stop; the frontend re-attaches.
            prev.close();
        }
        session.emit(); // Starting
        match session.launch(&plan) {
            Ok(()) => Ok(session.info()),
            Err(e) => {
                tracing::warn!(session = %spec.id, error = %crate::redact::redact(&e.to_string()), "session failed to start");
                session.fail(e.to_string());
                Err(e)
            }
        }
    }

    /// Attach an output sink (replacing any existing one). The sink receives a
    /// RESET frame, the replay of the ring, then live output.
    pub fn attach_sink(&self, id: &str, sink: Box<dyn OutputSink>) -> AppResult<SessionInfo> {
        let s = self.get(id)?;
        s.out.attach(sink).map_err(|e| match e.kind() {
            std::io::ErrorKind::NotConnected => AppError::NotFound(format!("session {id}")),
            _ => AppError::Io(e),
        })?;
        Ok(s.info())
    }

    pub fn detach(&self, id: &str) -> AppResult<()> {
        if let Ok(s) = self.get(id) {
            s.out.detach();
        }
        Ok(())
    }

    pub fn write(&self, id: &str, data: Vec<u8>) -> AppResult<()> {
        self.get(id)?.write(data)
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> AppResult<()> {
        self.get(id)?.resize(cols, rows)
    }

    pub fn ack(&self, id: &str, bytes: u64) -> AppResult<()> {
        self.get(id)?.out.ack(bytes);
        Ok(())
    }

    pub fn stop(&self, id: &str, force: bool) -> AppResult<()> {
        self.get(id)?.stop(force)
    }

    pub fn info(&self, id: &str) -> AppResult<SessionInfo> {
        Ok(self.get(id)?.info())
    }

    pub fn list(&self) -> Vec<SessionInfo> {
        let mut all: Vec<Arc<Session>> = self.sessions.read().values().cloned().collect();
        all.sort_by_key(|s| s.seq);
        all.iter().map(|s| s.info()).collect()
    }

    pub fn output_text(&self, id: &str) -> AppResult<String> {
        let bytes = self.get(id)?.out.contents();
        Ok(text::strip_ansi(&bytes))
    }

    /// Plain text of (roughly) the last `max_bytes` of retained output.
    pub fn output_tail(&self, id: &str, max_bytes: usize) -> AppResult<String> {
        let bytes = self.get(id)?.out.tail(max_bytes.clamp(256, 256 * 1024));
        Ok(text::strip_ansi(&bytes))
    }

    pub fn clear_buffer(&self, id: &str) -> AppResult<()> {
        self.get(id)?.out.clear();
        Ok(())
    }

    pub fn remove(&self, id: &str) -> AppResult<()> {
        let s = self.get(id)?;
        if s.is_live() {
            return Err(AppError::Invalid(format!("Session '{id}' is still running; stop it first")));
        }
        let removed = {
            let mut map = self.sessions.write();
            // Only remove the entry we checked (not a concurrent restart).
            match map.get(id) {
                Some(cur) if Arc::ptr_eq(cur, &s) => map.remove(id),
                _ => None,
            }
        };
        if let Some(s) = removed {
            s.close();
        }
        Ok(())
    }

    pub fn root_pids(&self) -> Vec<(SessionId, u32)> {
        let all: Vec<Arc<Session>> = self.sessions.read().values().cloned().collect();
        all.iter().filter(|s| s.is_live()).filter_map(|s| s.pid().map(|p| (s.id.clone(), p))).collect()
    }

    /// Block until the session's root process exited (or `timeout`).
    pub fn wait_exit(&self, id: &str, timeout: Duration) -> AppResult<bool> {
        Ok(self.get(id)?.wait_exit(timeout))
    }

    /// Block until the session's output stream reached EOF (or `timeout`).
    pub fn wait_output_eof(&self, id: &str, timeout: Duration) -> AppResult<bool> {
        Ok(self.get(id)?.out.wait_eof(timeout))
    }

    /// Number of live processes in the session's job (None if no job).
    pub fn job_process_count(&self, id: &str) -> AppResult<Option<u32>> {
        let s = self.get(id)?;
        Ok(s.job.get().and_then(|j| j.active_processes().ok()))
    }

    /// Stop every live session: Ctrl+C, then close the consoles at half the
    /// timeout, then terminate the remaining jobs at the deadline. Waits only
    /// on per-session condvars (no locks held, no events emitted), so it is
    /// safe to call from the Tauri `Exit` handler on the main thread.
    pub fn shutdown_all(&self, timeout: Duration) {
        self.quiet.store(true, Ordering::Release);
        let live: Vec<Arc<Session>> = self.sessions.read().values().filter(|s| s.is_live()).cloned().collect();
        if live.is_empty() {
            return;
        }
        let started = Instant::now();
        let half = started + timeout / 2;
        let deadline = started + timeout;
        for s in &live {
            s.begin_shutdown();
        }
        for s in &live {
            s.wait_exit_until(half);
        }
        for s in live.iter().filter(|s| !s.has_exited()) {
            s.release_pty();
        }
        for s in &live {
            s.wait_exit_until(deadline);
        }
        let stubborn: Vec<&Arc<Session>> = live.iter().filter(|s| !s.has_exited()).collect();
        for s in &stubborn {
            s.kill_tree();
        }
        let grace = Instant::now() + Duration::from_millis(500);
        for s in &stubborn {
            s.wait_exit_until(grace);
        }
        tracing::info!(
            sessions = live.len(),
            force_killed = stubborn.len(),
            elapsed_ms = started.elapsed().as_millis() as u64,
            "sessions shut down"
        );
    }
}

// ---------------------------------------------------------------------------
// SessionManager (Tauri wrapper)
// ---------------------------------------------------------------------------

/// Output sink over a Tauri IPC channel (binary frames).
struct ChannelSink(Channel<InvokeResponseBody>);

impl OutputSink for ChannelSink {
    fn send_frame(&mut self, frame: Vec<u8>) -> Result<(), SinkClosed> {
        self.0.send(InvokeResponseBody::Raw(frame)).map_err(|_| SinkClosed)
    }
}

pub struct SessionManager {
    core: SessionCore,
}

impl SessionManager {
    pub fn new(app: AppHandle) -> Self {
        let app2 = app.clone();
        let core = SessionCore::with_attention(
            move |info| {
                if let Err(e) = app.emit(EVT_SESSION_STATE, info) {
                    tracing::debug!(session = %info.id, error = %e, "failed to emit session state");
                }
            },
            move |ev| {
                if let Err(e) = app2.emit(EVT_SESSION_ATTENTION, ev) {
                    tracing::debug!(session = %ev.id, error = %e, "failed to emit session attention");
                }
            },
        );
        Self { core }
    }

    /// The AppHandle-free core (diagnostics, tests).
    pub fn core(&self) -> &SessionCore {
        &self.core
    }

    /// Spawn the process in a new pseudo console; `buffer_bytes` bounds the replay ring.
    pub fn start(&self, spec: SessionSpec, plan: LaunchPlan, buffer_bytes: usize) -> AppResult<SessionInfo> {
        self.core.start(spec, plan, buffer_bytes)
    }
    /// Attach the output channel, replacing any previous one. Sends RESET,
    /// replays the ring, then streams live output (see module docs for framing
    /// and flow control).
    pub fn attach(&self, id: &str, channel: Channel<InvokeResponseBody>) -> AppResult<SessionInfo> {
        self.core.attach_sink(id, Box::new(ChannelSink(channel)))
    }
    pub fn detach(&self, id: &str) -> AppResult<()> {
        self.core.detach(id)
    }
    pub fn write(&self, id: &str, data: Vec<u8>) -> AppResult<()> {
        self.core.write(id, data)
    }
    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> AppResult<()> {
        self.core.resize(id, cols, rows)
    }
    /// Flow control: the view processed `bytes` more DATA payload bytes.
    pub fn ack(&self, id: &str, bytes: u64) -> AppResult<()> {
        self.core.ack(id, bytes)
    }
    pub fn stop(&self, id: &str, force: bool) -> AppResult<()> {
        self.core.stop(id, force)
    }
    pub fn list(&self) -> Vec<SessionInfo> {
        self.core.list()
    }
    pub fn output_text(&self, id: &str) -> AppResult<String> {
        self.core.output_text(id)
    }
    pub fn output_tail(&self, id: &str, max_bytes: usize) -> AppResult<String> {
        self.core.output_tail(id, max_bytes)
    }
    pub fn clear_buffer(&self, id: &str) -> AppResult<()> {
        self.core.clear_buffer(id)
    }
    pub fn remove(&self, id: &str) -> AppResult<()> {
        self.core.remove(id)
    }
    /// (session id, root pid) of every live session — used for diagnostics.
    pub fn root_pids(&self) -> Vec<(SessionId, u32)> {
        self.core.root_pids()
    }
    /// Gracefully stop all sessions, force-killing whatever remains after `timeout`.
    pub fn shutdown_all(&self, timeout: Duration) {
        self.core.shutdown_all(timeout)
    }
}
