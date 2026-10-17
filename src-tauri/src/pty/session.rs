//! One ConPTY session: process launch, Job Object, reader / writer / waiter
//! threads, and lifecycle transitions.
//!
//! Threads per session (all named with the session's short id):
//! * `pty-read-*`  blocking reads from the ConPTY output pipe into [`Output`].
//! * `pty-write-*` drains an unbounded mpsc queue of input into the ConPTY
//!   input pipe, so IPC handlers never block on a full pipe.
//! * `pty-wait-*`  blocks in `WaitForSingleObject` on the root process, then
//!   runs the exit sequence (record state, let ConPTY drain, close the
//!   pseudoconsole, reap the job).
//! * `pty-pump-*`  one per attachment (see `stream.rs`).
//! * `pty-stop-*`  short-lived, only during a graceful stop.
//!
//! All thread bodies are wrapped in `catch_unwind` and use drop guards, so a
//! panic ends only that thread and leaves the session in a consistent state.

use std::io::{Read, Write};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use parking_lot::{Condvar, Mutex};
use portable_pty::{Child, ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};

use super::attention::{AttentionScanner, STATUS_PROBE_REPLY, Signal, Tracker, win32_input_encode};
use super::job::Job;
use super::stream::Output;
use super::text::CprScanner;
use crate::types::*;

/// Callback invoked on every state transition.
pub type EventSink = Arc<dyn Fn(&SessionInfo) + Send + Sync>;

const READ_BUF: usize = 64 * 1024;
/// Maximum queued (not yet written) user input per session.
pub const MAX_INPUT_QUEUE: usize = 8 * 1024 * 1024;
/// Large pastes are written to the ConPTY input pipe in chunks of this size.
const WRITE_CHUNK: usize = 16 * 1024;
/// Graceful stop: time allowed after Ctrl+C before closing the console.
const STOP_CTRL_C_GRACE: Duration = Duration::from_secs(2);
/// Graceful stop: time allowed after CTRL_CLOSE_EVENT before killing the job.
const STOP_CLOSE_GRACE: Duration = Duration::from_secs(3);
/// On exit, wait for ConPTY output to go quiet this long before closing it...
const DRAIN_IDLE: Duration = Duration::from_millis(100);
/// ...but never longer than this.
const DRAIN_MAX: Duration = Duration::from_millis(1500);
/// After the root exits and the console is closed, descendants still in the
/// job get this long to exit before the job is terminated.
const ORPHAN_GRACE: Duration = Duration::from_secs(2);
/// How long the waiter waits for the reader to hit EOF after closing ConPTY.
const READER_EOF_WAIT: Duration = Duration::from_secs(3);
/// Exit code used when Gridkeeper terminates a session's processes.
const KILL_EXIT_CODE: u32 = 1;
/// Reply to `ESC[6n` when no view is attached.
const CPR_REPLY: &[u8] = b"\x1b[1;1R";

pub const MIN_COLS: u16 = 2;
pub const MAX_COLS: u16 = 1000;
pub const MIN_ROWS: u16 = 1;
pub const MAX_ROWS: u16 = 500;

/// Clamp a terminal size to sane bounds; 0 means "unknown" (80x24).
pub fn clamp_size(cols: u16, rows: u16) -> (u16, u16) {
    let cols = if cols == 0 { 80 } else { cols };
    let rows = if rows == 0 { 24 } else { rows };
    (cols.clamp(MIN_COLS, MAX_COLS), rows.clamp(MIN_ROWS, MAX_ROWS))
}

pub fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Spawn a named thread whose body cannot unwind past the thread boundary.
pub(crate) fn spawn_guarded<F>(name: String, f: F) -> std::io::Result<std::thread::JoinHandle<()>>
where
    F: FnOnce() + Send + 'static,
{
    std::thread::Builder::new().name(name.clone()).spawn(move || {
        if let Err(p) = catch_unwind(AssertUnwindSafe(f)) {
            tracing::error!(thread = %name, panic = %super::panic_message(&p), "session thread panicked");
        }
    })
}

// ---------------------------------------------------------------------------
// Input queue
// ---------------------------------------------------------------------------

enum InputMsg {
    /// User input; counted against MAX_INPUT_QUEUE.
    User(Vec<u8>),
    /// Internally generated (CPR replies, Ctrl+C on stop); never refused.
    Internal(Vec<u8>),
}

pub(crate) struct InputHandle {
    tx: Mutex<Option<Sender<InputMsg>>>,
    queued: AtomicUsize,
}

impl InputHandle {
    fn new(tx: Sender<InputMsg>) -> Self {
        Self { tx: Mutex::new(Some(tx)), queued: AtomicUsize::new(0) }
    }

    fn send_user(&self, data: Vec<u8>) -> AppResult<()> {
        let len = data.len();
        let prev = self.queued.fetch_add(len, Ordering::AcqRel);
        if prev + len > MAX_INPUT_QUEUE {
            self.queued.fetch_sub(len, Ordering::AcqRel);
            return Err(AppError::Invalid("input queue full".into()));
        }
        let sent = self.tx.lock().as_ref().map(|tx| tx.send(InputMsg::User(data)).is_ok()).unwrap_or(false);
        if !sent {
            self.queued.fetch_sub(len, Ordering::AcqRel);
            return Err(AppError::Invalid("session is not running".into()));
        }
        Ok(())
    }

    fn send_internal(&self, data: &[u8]) -> bool {
        self.tx.lock().as_ref().map(|tx| tx.send(InputMsg::Internal(data.to_vec())).is_ok()).unwrap_or(false)
    }

    /// Drop the sender; the writer thread exits after draining the queue.
    fn close(&self) {
        self.tx.lock().take();
    }
}

fn writer_loop(rx: Receiver<InputMsg>, mut w: Box<dyn Write + Send>, input: &InputHandle, label: &str) {
    for msg in rx {
        let (data, counted) = match msg {
            InputMsg::User(d) => (d, true),
            InputMsg::Internal(d) => (d, false),
        };
        let mut result = Ok(());
        for chunk in data.chunks(WRITE_CHUNK) {
            result = w.write_all(chunk).and_then(|_| w.flush());
            if result.is_err() {
                break;
            }
        }
        if counted {
            input.queued.fetch_sub(data.len(), Ordering::AcqRel);
        }
        if let Err(e) = result {
            tracing::debug!(session = %label, error = %e, "pty input pipe closed");
            // Refuse further input instead of queueing it forever.
            input.close();
            break;
        }
    }
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

struct Meta {
    state: SessionState,
    pid: Option<u32>,
    started_at: Option<String>,
    ended_at: Option<String>,
}

pub(crate) struct Session {
    pub id: SessionId,
    /// Short id used in thread names and logs.
    pub label: String,
    /// Creation order, for stable listing.
    pub seq: u64,
    name: String,
    agent: AgentKind,
    cwd: String,
    profile_id: Option<String>,
    display: String,
    meta: Mutex<Meta>,
    pub out: Arc<Output>,
    input: Arc<InputHandle>,
    /// Receiver end of the input queue until the writer thread takes it.
    input_rx: Mutex<Option<Receiver<InputMsg>>>,
    /// Owning the master owns the pseudoconsole: dropping it calls
    /// ClosePseudoConsole (the slave's reference is dropped right after spawn).
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    size: Mutex<(u16, u16)>,
    /// Set only when the root process was successfully assigned to it, so
    /// terminating it can never miss the root nor touch unrelated processes.
    pub job: OnceLock<Job>,
    killer: Mutex<Option<Box<dyn ChildKiller + Send + Sync>>>,
    exited: Mutex<bool>,
    exit_cv: Condvar,
    events: EventSink,
    /// Held across snapshot + callback in [`Session::emit`] so state events
    /// from the launch, reader and waiter threads are delivered in the order
    /// their snapshots were taken (a stale `Running` can never follow `Exited`).
    emit_lock: Mutex<()>,
    /// Attention signals / activity of this run (see `attention.rs`).
    attention: Arc<Tracker>,
}

fn short_label(id: &str) -> String {
    let s: String = id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').take(8).collect();
    if s.is_empty() { "session".into() } else { s }
}

impl Session {
    pub fn new(
        spec: &SessionSpec,
        plan: &LaunchPlan,
        buffer_bytes: usize,
        seq: u64,
        events: EventSink,
        attention: Arc<Tracker>,
    ) -> Arc<Self> {
        let label = short_label(&spec.id);
        let (tx, rx) = mpsc::channel();
        let input = Arc::new(InputHandle::new(tx));
        let responder_input = Arc::clone(&input);
        let out = Arc::new(Output::new(
            buffer_bytes,
            label.clone(),
            Box::new(move |n| {
                for _ in 0..n {
                    responder_input.send_internal(CPR_REPLY);
                }
            }),
        ));
        Arc::new(Self {
            id: spec.id.clone(),
            label,
            seq,
            name: spec.name.clone(),
            agent: spec.agent,
            cwd: plan.cwd.to_string_lossy().into_owned(),
            profile_id: spec.profile_id.clone(),
            display: crate::redact::redact(&plan.display),
            meta: Mutex::new(Meta { state: SessionState::Starting, pid: None, started_at: None, ended_at: None }),
            out,
            input,
            input_rx: Mutex::new(Some(rx)),
            master: Mutex::new(None),
            size: Mutex::new(clamp_size(spec.cols, spec.rows)),
            job: OnceLock::new(),
            killer: Mutex::new(None),
            exited: Mutex::new(false),
            exit_cv: Condvar::new(),
            events,
            emit_lock: Mutex::new(()),
            attention,
        })
    }

    // -- info & state -------------------------------------------------------

    pub fn info(&self) -> SessionInfo {
        let m = self.meta.lock();
        SessionInfo {
            id: self.id.clone(),
            name: self.name.clone(),
            agent: self.agent,
            pid: m.pid,
            state: m.state.clone(),
            cwd: self.cwd.clone(),
            profile_id: self.profile_id.clone(),
            command_display: self.display.clone(),
            started_at: m.started_at.clone(),
            ended_at: m.ended_at.clone(),
            bytes_out: self.out.bytes_out(),
        }
    }

    pub fn is_live(&self) -> bool {
        matches!(self.meta.lock().state, SessionState::Starting | SessionState::Running | SessionState::Stopping)
    }

    pub fn pid(&self) -> Option<u32> {
        self.meta.lock().pid
    }

    /// Report the current state. Lock order: `emit_lock` → `meta`; callers
    /// must not hold `meta`. The sink must not block or call back into the session.
    pub fn emit(&self) {
        let _ordered = self.emit_lock.lock();
        let info = self.info();
        (self.events)(&info);
    }

    /// Move to `Stopping` if currently starting/running. Returns whether the
    /// state changed (false if already stopping or not live).
    fn begin_stopping(&self) -> bool {
        let changed = {
            let mut m = self.meta.lock();
            match m.state {
                SessionState::Starting | SessionState::Running => {
                    m.state = SessionState::Stopping;
                    true
                }
                _ => false,
            }
        };
        if changed {
            tracing::info!(session = %self.id, "session stopping");
            self.emit();
        }
        changed
    }

    pub fn fail(&self, message: String) {
        {
            let mut m = self.meta.lock();
            m.state = SessionState::Failed { message: crate::redact::redact(&message) };
            m.ended_at = Some(now_rfc3339());
        }
        self.input.close();
        self.attention.close();
        self.out.mark_eof();
        self.signal_exited();
        self.emit();
    }

    fn signal_exited(&self) {
        let mut done = self.exited.lock();
        *done = true;
        self.exit_cv.notify_all();
    }

    fn mark_exited(&self, code: Option<u32>) {
        let transitioned = {
            let mut m = self.meta.lock();
            if matches!(m.state, SessionState::Exited { .. } | SessionState::Failed { .. }) {
                false
            } else {
                m.state = SessionState::Exited { code };
                m.ended_at = Some(now_rfc3339());
                true
            }
        };
        self.attention.close();
        self.signal_exited();
        if transitioned {
            tracing::info!(session = %self.id, pid = ?self.pid(), exit_code = ?code, "session exited");
            self.emit();
        }
    }

    /// Wait until the root process has exited (or launch failed).
    pub fn wait_exit(&self, timeout: Duration) -> bool {
        self.wait_exit_until(Instant::now() + timeout)
    }

    pub fn wait_exit_until(&self, deadline: Instant) -> bool {
        let mut done = self.exited.lock();
        while !*done {
            if self.exit_cv.wait_until(&mut done, deadline).timed_out() {
                break;
            }
        }
        *done
    }

    pub fn has_exited(&self) -> bool {
        *self.exited.lock()
    }

    // -- launch -------------------------------------------------------------

    /// Spawn the process described by `plan` in a new pseudoconsole. On error
    /// the caller marks the session failed.
    pub fn launch(self: &Arc<Self>, plan: &LaunchPlan) -> AppResult<()> {
        let cwd = &plan.cwd;
        if !cwd.exists() {
            return Err(AppError::Invalid(format!("Working directory does not exist: {}", cwd.display())));
        }
        if !cwd.is_dir() {
            return Err(AppError::Invalid(format!("Working directory is not a directory: {}", cwd.display())));
        }

        // Environment: portable-pty's base environment is this process's
        // environment refreshed with the user/system environment from the
        // registry (like Windows Terminal, so newly installed tools are found).
        // The plan's removals and assignments are applied on top, in that order.
        let mut cmd = CommandBuilder::new(&plan.program);
        for key in &plan.env_remove {
            cmd.env_remove(key);
        }
        for (key, value) in &plan.env_set {
            cmd.env(key, value);
        }
        let program = resolve_program(&plan.program, cmd.get_env("PATH"), cwd)?;
        cmd.get_argv_mut()[0] = program.clone().into_os_string();
        cmd.args(&plan.args);
        cmd.cwd(cwd);

        let (cols, rows) = *self.size.lock();
        let pair = native_pty_system()
            .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| AppError::Other(format!("Failed to create pseudo console: {e:#}")))?;
        let reader = pair.master.try_clone_reader().map_err(|e| AppError::Other(format!("PTY reader: {e:#}")))?;
        let writer = pair.master.take_writer().map_err(|e| AppError::Other(format!("PTY writer: {e:#}")))?;

        let child = match pair.slave.spawn_command(cmd) {
            Ok(c) => c,
            Err(e) => {
                // Dropping the pair closes the pseudoconsole (no conhost leak).
                drop(pair);
                return Err(AppError::Other(format!("Failed to start {}: {e:#}", program.display())));
            }
        };
        // The master is now the only owner of the pseudoconsole.
        drop(pair.slave);
        let pid = child.process_id();

        if let Some(pid) = pid {
            match Job::new().and_then(|job| job.assign_pid(pid).map(|_| job)) {
                Ok(job) => {
                    let _ = self.job.set(job);
                }
                Err(e) => tracing::warn!(session = %self.id, pid, error = %e, "could not assign session to a job object"),
            }
        }

        *self.killer.lock() = Some(child.clone_killer());
        *self.master.lock() = Some(pair.master);
        {
            let mut m = self.meta.lock();
            m.pid = pid;
            m.started_at = Some(now_rfc3339());
        }

        if let Err(e) = self.spawn_threads(reader, writer, child) {
            self.kill_tree();
            self.release_pty();
            return Err(AppError::Other(format!("Failed to start session threads: {e}")));
        }

        let (running, stop_requested) = {
            let mut m = self.meta.lock();
            match m.state {
                SessionState::Starting => {
                    m.state = SessionState::Running;
                    (true, false)
                }
                // stop() arrived while we were spawning (nothing to kill yet
                // at that point): honour it now.
                SessionState::Stopping => (false, true),
                _ => (false, false), // already exited (very short-lived process)
            }
        };
        if stop_requested {
            self.kill_tree();
        }
        tracing::info!(
            session = %self.id,
            pid = ?pid,
            cols, rows,
            command = %crate::redact::redact(&self.display),
            "session started"
        );
        if running {
            self.emit();
        }
        Ok(())
    }

    fn spawn_threads(
        self: &Arc<Self>,
        mut reader: Box<dyn Read + Send>,
        writer: Box<dyn Write + Send>,
        child: Box<dyn Child + Send + Sync>,
    ) -> std::io::Result<()> {
        // Writer.
        let rx = self.input_rx.lock().take().expect("input receiver taken twice");
        let input = Arc::clone(&self.input);
        let label = self.label.clone();
        spawn_guarded(format!("pty-write-{}", self.label), move || {
            writer_loop(rx, writer, &input, &label);
        })?;

        // Reader.
        let out = Arc::clone(&self.out);
        let label = self.label.clone();
        let weak = Arc::downgrade(self);
        let input = Arc::clone(&self.input);
        let attention = Arc::clone(&self.attention);
        spawn_guarded(format!("pty-read-{}", self.label), move || {
            struct EofGuard(Arc<Output>);
            impl Drop for EofGuard {
                fn drop(&mut self) {
                    self.0.mark_eof();
                }
            }
            let _eof = EofGuard(Arc::clone(&out));
            let mut buf = vec![0u8; READ_BUF];
            let mut cpr = CprScanner::new();
            let mut att = AttentionScanner::new();
            let status_reply = win32_input_encode(STATUS_PROBE_REPLY);
            let reply_status_probe = std::env::var_os("GRIDKEEPER_OSC7501_REPLY").is_some_and(|v| v == "1");
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let chunk = &buf[..n];
                        let signals = att.feed(chunk);
                        // OSC 7501 feature probe: answer at once, before the view (if any) can
                        // answer the DA1 that follows it. OFF by default: the reply has to be injected
                        // as synthetic key events into the child's input, and the system ConPTY answers
                        // DA1 itself first anyway, so the protocol rarely activates. Opt in with
                        // GRIDKEEPER_OSC7501_REPLY=1 to experiment. Passive detection works regardless.
                        if reply_status_probe {
                            for _ in signals.iter().filter(|s| matches!(s, Signal::StatusProbe)) {
                                input.send_internal(&status_reply);
                            }
                        }
                        attention.on_output(&signals, Instant::now());
                        let cprs = cpr.feed(chunk);
                        let first = out.bytes_out() == 0;
                        out.ingest(chunk, cprs);
                        if first {
                            // One extra state event so the UI knows output has begun (no-output watchdog).
                            if let Some(s) = weak.upgrade() {
                                s.emit();
                            }
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(e) => {
                        tracing::debug!(session = %label, error = %e, "pty output read ended");
                        break;
                    }
                }
            }
            tracing::debug!(session = %label, "pty reader finished");
        })?;

        // Waiter.
        let me = Arc::clone(self);
        spawn_guarded(format!("pty-wait-{}", self.label), move || me.waiter(child))?;
        Ok(())
    }

    fn waiter(self: Arc<Self>, mut child: Box<dyn Child + Send + Sync>) {
        // If anything below panics, still report the session as exited.
        struct ExitGuard<'a>(&'a Session);
        impl Drop for ExitGuard<'_> {
            fn drop(&mut self) {
                if !self.0.has_exited() {
                    self.0.mark_exited(None);
                }
                self.0.input.close();
            }
        }
        let _guard = ExitGuard(&self);

        let code = match child.wait() {
            Ok(status) => Some(status.exit_code()),
            Err(e) => {
                tracing::warn!(session = %self.id, error = %e, "waiting for session process failed");
                None
            }
        };
        drop(child);
        self.mark_exited(code);

        // ConPTY may still be rendering the final output: wait for it to go
        // quiet, then close the pseudoconsole so the reader drains to EOF.
        // (Never closed from the reader thread: before Windows 11 24H2,
        // ClosePseudoConsole blocks until the output pipe is drained.)
        self.out.wait_quiet(DRAIN_IDLE, DRAIN_MAX);
        self.release_pty();
        self.input.close();

        // Closing the console sent CTRL_CLOSE_EVENT to remaining console
        // clients. Give stragglers a moment, then reap whatever is left of the
        // session's tree so nothing outlives the session.
        if let Some(job) = self.job.get() {
            let deadline = Instant::now() + ORPHAN_GRACE;
            loop {
                match job.active_processes() {
                    Ok(0) | Err(_) => break,
                    Ok(n) if Instant::now() >= deadline => {
                        tracing::info!(session = %self.id, remaining = n, "terminating leftover session processes");
                        let _ = job.terminate(KILL_EXIT_CODE);
                        break;
                    }
                    Ok(_) => std::thread::sleep(Duration::from_millis(50)),
                }
            }
        }
        self.killer.lock().take();

        if !self.out.wait_eof(READER_EOF_WAIT) {
            tracing::warn!(session = %self.id, "pty reader did not reach EOF after close");
        }
    }

    // -- control ------------------------------------------------------------

    /// Close the pseudoconsole (idempotent). Sends CTRL_CLOSE_EVENT to the
    /// processes attached to it and makes the reader reach EOF.
    pub fn release_pty(&self) {
        let master = self.master.lock().take();
        drop(master);
    }

    /// Terminate the whole process tree (job), falling back to the root.
    pub fn kill_tree(&self) {
        if let Some(job) = self.job.get() {
            match job.terminate(KILL_EXIT_CODE) {
                Ok(()) => return,
                Err(e) => tracing::warn!(session = %self.id, error = %e, "TerminateJobObject failed; killing root"),
            }
        }
        if let Some(killer) = self.killer.lock().as_mut() {
            let _ = killer.kill();
        }
    }

    pub fn write(&self, data: Vec<u8>) -> AppResult<()> {
        if data.is_empty() {
            return Ok(());
        }
        if !self.is_live() {
            return Err(AppError::Invalid("session is not running".into()));
        }
        self.attention.note_input(Instant::now());
        self.input.send_user(data)
    }

    pub fn resize(&self, cols: u16, rows: u16) -> AppResult<()> {
        let (cols, rows) = clamp_size(cols, rows);
        let mut size = self.size.lock();
        if *size == (cols, rows) {
            return Ok(());
        }
        let master = self.master.lock();
        if let Some(m) = master.as_ref() {
            // The program repaints after a resize: not "activity".
            self.attention.note_input(Instant::now());
            m.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
                .map_err(|e| AppError::Other(format!("resize failed: {e:#}")))?;
        }
        *size = (cols, rows);
        Ok(())
    }

    /// Stop the session. Never blocks the caller.
    pub fn stop(self: &Arc<Self>, force: bool) -> AppResult<()> {
        if !self.is_live() {
            return Ok(());
        }
        let first = self.begin_stopping();
        if force {
            tracing::info!(session = %self.id, "force-stopping session");
            self.kill_tree();
            return Ok(());
        }
        if !first {
            return Ok(()); // graceful stop already in progress
        }
        self.input.send_internal(b"\x03");
        let me = Arc::clone(self);
        spawn_guarded(format!("pty-stop-{}", self.label), move || {
            if me.wait_exit(STOP_CTRL_C_GRACE) {
                return;
            }
            tracing::info!(session = %me.id, "closing pseudoconsole (CTRL_CLOSE_EVENT)");
            me.release_pty();
            if me.wait_exit(STOP_CLOSE_GRACE) {
                return;
            }
            tracing::warn!(session = %me.id, "session ignored stop request; terminating its job");
            me.kill_tree();
        })
        .map_err(AppError::Io)?;
        Ok(())
    }

    /// First phase of a shutdown: Ctrl+C, no background thread.
    pub fn begin_shutdown(&self) {
        if self.is_live() {
            self.begin_stopping();
            self.input.send_internal(b"\x03");
        }
    }

    /// The entry is being dropped from the manager (remove or restart).
    pub fn close(&self) {
        self.attention.close();
        self.out.close();
    }
}

/// Resolve the executable to an absolute path, or `MissingExecutable`.
fn resolve_program(program: &Path, path_env: Option<&std::ffi::OsStr>, cwd: &Path) -> AppResult<PathBuf> {
    let missing = || AppError::MissingExecutable(program.display().to_string());
    if program.as_os_str().is_empty() {
        return Err(missing());
    }
    let has_dir = program.is_absolute() || program.components().count() > 1;
    if has_dir {
        let p = if program.is_absolute() { program.to_path_buf() } else { cwd.join(program) };
        if p.is_file() {
            return Ok(p);
        }
        // Allow "C:\tools\foo" meaning foo.exe.
        return which::which_in(&p, None::<&str>, cwd).map_err(|_| missing());
    }
    which::which_in(program, path_env, cwd).map_err(|_| missing())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clamp_size_bounds() {
        assert_eq!(clamp_size(0, 0), (80, 24));
        assert_eq!(clamp_size(1, 1), (2, 1));
        assert_eq!(clamp_size(5000, 5000), (1000, 500));
        assert_eq!(clamp_size(120, 40), (120, 40));
    }

    #[test]
    fn resolve_program_variants() {
        let cwd = std::env::temp_dir();
        let path = std::env::var_os("PATH");
        let cmd = resolve_program(Path::new("cmd.exe"), path.as_deref(), &cwd).unwrap();
        assert!(cmd.is_absolute());
        let cmd2 = resolve_program(Path::new("cmd"), path.as_deref(), &cwd).unwrap();
        assert!(cmd2.is_file());
        assert!(matches!(
            resolve_program(Path::new("definitely-not-a-real-program-xyz"), path.as_deref(), &cwd),
            Err(AppError::MissingExecutable(_))
        ));
        assert!(matches!(
            resolve_program(Path::new(r"C:\nope\missing.exe"), path.as_deref(), &cwd),
            Err(AppError::MissingExecutable(_))
        ));
        let sys = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
        let abs = PathBuf::from(sys).join("System32").join("cmd.exe");
        assert_eq!(resolve_program(&abs, None, &cwd).unwrap(), abs);
    }

    #[test]
    fn short_labels() {
        assert_eq!(short_label("0123456789abcdef"), "01234567");
        assert_eq!(short_label("a/b\\c"), "abc");
        assert_eq!(short_label("///"), "session");
    }
}
