//! The host side of the agent browser: one shared browser, one tab (browser context + page) per
//! opted-in session, the helper endpoint, confirmations, take-over, screencast and the UI state.
//!
//! Locking: one `Mutex<Inner>` + one `Condvar` (take-over waits, confirmations, page-load waits,
//! the janitor tick). The lock is never held across a CDP call or a UI emit. Tool calls of one
//! session run one at a time (`Sess::busy`); different sessions run in parallel.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock, Weak, mpsc};
use std::time::{Duration, Instant};

use parking_lot::{Condvar, Mutex};
use serde_json::{Value, json};

use super::cdp::{Cdp, CdpEvent};
use super::chrome::{self, BrowserProcess};
use super::config::{self, Config};
use super::ipc::{self, Conn, Request, RequestKind, Response};
use super::launch::{self, Cli, Injection};
use super::model::*;
use super::{policy, tools};
use crate::types::SessionId;

/// How long a confirmation waits for the user before it counts as "no".
pub const CONFIRM_TIMEOUT: Duration = Duration::from_secs(120);
/// How long a tool call waits while the user has taken over the tab.
pub const TAKEOVER_WAIT: Duration = Duration::from_secs(9 * 60);
/// A tab whose agent helper disconnected is closed after this.
pub const TAB_GRACE: Duration = Duration::from_secs(60);
/// The browser stops when no tab has existed for this long.
pub const NO_TAB_STOP: Duration = Duration::from_secs(60);
pub const JANITOR_TICK: Duration = Duration::from_secs(15);
/// At most ~10 screencast frames per second per watched tab.
pub const FRAME_INTERVAL: Duration = Duration::from_millis(100);
pub const CONSOLE_MAX: usize = 200;
pub const NETWORK_MAX: usize = 300;
const NOTICES_MAX: usize = 20;
/// A verified (pid, session) pair is trusted for this long without a new process-tree walk.
const VERIFY_TTL: Duration = Duration::from_secs(600);
pub(crate) const CDP_TIMEOUT: Duration = Duration::from_secs(30);

pub enum UiEvent {
    State(AgentBrowserState),
    Activity(AgentBrowserActivity),
}

pub type UiEmit = Arc<dyn Fn(UiEvent) + Send + Sync>;
/// Live sessions' root pids (`SessionManager::root_pids`).
pub type RootsFn = Arc<dyn Fn() -> Vec<(SessionId, u32)> + Send + Sync>;
/// Ports the sessions' dev servers listen on (`ports::session_ports`).
pub type PortsFn = Arc<dyn Fn() -> Vec<u16> + Send + Sync>;

/// Receives encoded screencast frames (see `events::encode_frame`). `false` = the viewer is gone.
pub trait FrameSink: Send + Sync {
    fn send(&self, bytes: Vec<u8>) -> bool;
}

pub struct HubOptions {
    pub data_dir: PathBuf,
    /// The helper executable (this binary).
    pub exe: Option<PathBuf>,
    pub emit: UiEmit,
    pub roots: RootsFn,
    pub dev_ports: PortsFn,
    /// Session ids of the saved workspaces (opt-ins of other ids are forgotten).
    pub existing_sessions: Option<Vec<String>>,
    /// Start the helper endpoint (false in unit tests that only exercise state).
    pub serve: bool,
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub(crate) struct ConsoleEntry {
    pub level: String,
    pub text: String,
}

#[derive(Debug, Clone)]
pub(crate) struct NetEntry {
    pub id: String,
    pub method: String,
    pub url: String,
    pub kind: String,
    pub status: Option<u16>,
    pub failed: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct Dialog {
    pub kind: String,
    pub message: String,
}

pub(crate) struct Tab {
    pub generation: u64,
    pub target_id: String,
    pub cdp_session: String,
    pub context_id: String,
    pub console: VecDeque<ConsoleEntry>,
    pub network: VecDeque<NetEntry>,
    pub loading: bool,
    pub nav_started: u64,
    pub nav_done: u64,
    /// Execution context of Gridkeeper's isolated world in the current document.
    pub world: Option<i64>,
    pub dialog: Option<Dialog>,
    pub screencast: bool,
    pub next_ack: Option<Instant>,
}

impl Tab {
    fn new(generation: u64, target_id: String, cdp_session: String, context_id: String) -> Self {
        Self {
            generation,
            target_id,
            cdp_session,
            context_id,
            console: VecDeque::new(),
            network: VecDeque::new(),
            loading: false,
            nav_started: 0,
            nav_done: 0,
            world: None,
            dialog: None,
            screencast: false,
            next_ack: None,
        }
    }

    pub fn push_console(&mut self, level: &str, text: String) {
        if self.console.len() >= CONSOLE_MAX {
            self.console.pop_front();
        }
        self.console.push_back(ConsoleEntry { level: level.to_string(), text });
    }
}

pub(crate) struct Watch {
    /// Chosen by the view; an unwatch for an older view (a late IPC call) leaves a newer one alone.
    pub token: u32,
    pub sink: Arc<dyn FrameSink>,
    pub max_w: u32,
    pub max_h: u32,
}

#[derive(Default)]
pub(crate) struct Sess {
    pub token: Option<String>,
    pub launched: bool,
    pub launch_note: Option<String>,
    pub presence: u32,
    pub last_disconnect: Option<Instant>,
    pub stopped: bool,
    pub taken_over: bool,
    pub busy: bool,
    pub tab: Option<Tab>,
    pub last_url: Option<String>,
    pub title: Option<String>,
    pub watch: Option<Watch>,
    pub last_action: Option<(String, u64)>,
    pub last_action_at: Option<Instant>,
    pub notices: Vec<String>,
    /// A tab of this session was lost (idle stop, crash): the next call reopens `last_url`.
    pub reopen: bool,
}

impl Sess {
    pub fn notice(&mut self, text: impl Into<String>) {
        if self.notices.len() >= NOTICES_MAX {
            self.notices.remove(0);
        }
        self.notices.push(text.into());
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Answer {
    Allow { remember: bool },
    Deny,
}

pub(crate) struct Prompt {
    pub view: AgentBrowserPrompt,
    pub answer: Option<Answer>,
}

pub(crate) struct Download {
    pub sid: SessionId,
    pub url: String,
    pub file_name: String,
    pub context_id: Option<String>,
    pub decision: Option<bool>,
    pub completed: bool,
    pub finished: bool,
}

pub(crate) struct BrowserHandle {
    pub generation: u64,
    pub cdp: Arc<Cdp>,
    pub process: BrowserProcess,
    pub label: String,
}

pub(crate) struct Inner {
    pub sessions: HashMap<SessionId, Sess>,
    pub browser: Option<Arc<BrowserHandle>>,
    pub by_cdp: HashMap<String, SessionId>,
    pub by_target: HashMap<String, SessionId>,
    pub popups: HashMap<String, SessionId>,
    pub prompts: BTreeMap<u64, Prompt>,
    pub downloads: HashMap<String, Download>,
    pub next_prompt: u64,
    pub last_use: Instant,
    pub no_tabs_since: Option<Instant>,
    pub error: Option<String>,
    pub verified: HashMap<(u32, SessionId), Instant>,
    pub janitor_gen: u64,
    /// Generation being stopped on purpose (its pipe closing is not an error).
    pub stopping_gen: u64,
}

/// A tab to send commands to (cloned out of the lock).
#[derive(Clone)]
pub(crate) struct TabRef {
    pub sid: SessionId,
    pub cdp: Arc<Cdp>,
    pub session: String,
    pub target: String,
    pub generation: u64,
}

pub struct Hub {
    pub(crate) dir: PathBuf,
    exe: Option<PathBuf>,
    endpoint: String,
    server: Mutex<Option<ipc::Server>>,
    pub(crate) config: Mutex<Config>,
    pub(crate) inner: Mutex<Inner>,
    pub(crate) cv: Condvar,
    browser_start: Mutex<()>,
    emit: UiEmit,
    roots: RootsFn,
    pub(crate) dev_ports: PortsFn,
    generation: std::sync::atomic::AtomicU64,
}

static HUB: OnceLock<Arc<Hub>> = OnceLock::new();

/// The app's hub (installed by `app::install`).
pub fn hub() -> Option<&'static Arc<Hub>> {
    HUB.get()
}

pub(crate) fn install_global(h: Arc<Hub>) {
    let _ = HUB.set(h);
}

/// App exit: stop the endpoint and the browser.
pub fn shutdown() {
    if let Some(h) = HUB.get() {
        h.shutdown();
    }
}

impl Hub {
    pub fn new(opts: HubOptions) -> Arc<Self> {
        let dir = super::dir(&opts.data_dir);
        if let Err(e) = std::fs::create_dir_all(&dir) {
            tracing::warn!(error = %e, "could not create the agent browser folder");
        }
        cleanup_launch_files(&dir);
        let cfg_path = dir.join(config::FILE_NAME);
        let mut cfg = Config::load(&cfg_path);
        if let Some(existing) = &opts.existing_sessions {
            if cfg.prune(existing) > 0 {
                let _ = cfg.save(&cfg_path);
            }
        }
        let endpoint = ipc::new_endpoint(&opts.data_dir).unwrap_or_else(|e| {
            tracing::warn!(error = %e, "no agent browser endpoint");
            String::new()
        });
        let hub = Arc::new(Self {
            dir,
            exe: opts.exe,
            endpoint,
            server: Mutex::new(None),
            config: Mutex::new(cfg),
            inner: Mutex::new(Inner {
                sessions: HashMap::new(),
                browser: None,
                by_cdp: HashMap::new(),
                by_target: HashMap::new(),
                popups: HashMap::new(),
                prompts: BTreeMap::new(),
                downloads: HashMap::new(),
                next_prompt: 1,
                last_use: Instant::now(),
                no_tabs_since: None,
                error: None,
                verified: HashMap::new(),
                janitor_gen: 0,
                stopping_gen: 0,
            }),
            cv: Condvar::new(),
            browser_start: Mutex::new(()),
            emit: opts.emit,
            roots: opts.roots,
            dev_ports: opts.dev_ports,
            generation: std::sync::atomic::AtomicU64::new(0),
        });
        if opts.serve && !hub.endpoint.is_empty() {
            let weak = Arc::downgrade(&hub);
            let handler: ipc::Handler = Arc::new(move |conn: Conn| {
                if let Some(h) = weak.upgrade() {
                    h.handle_conn(conn);
                }
            });
            match ipc::serve(&hub.endpoint, handler) {
                Ok(s) => *hub.server.lock() = Some(s),
                Err(e) => tracing::warn!(error = %e, "agent browser endpoint failed to start"),
            }
        }
        hub
    }

    pub fn endpoint(&self) -> &str {
        &self.endpoint
    }

    fn config_path(&self) -> PathBuf {
        self.dir.join(config::FILE_NAME)
    }

    pub(crate) fn downloads_dir(&self, sid: &str) -> PathBuf {
        self.dir.join("downloads").join(sid)
    }

    // -----------------------------------------------------------------------
    // UI state
    // -----------------------------------------------------------------------

    pub fn state(&self) -> AgentBrowserState {
        let cfg = self.config.lock().clone();
        let g = self.inner.lock();
        let mut ids: Vec<String> = cfg.sessions.clone();
        let mut extra: Vec<&String> = g.sessions.iter().filter(|(_, s)| s.launched || s.tab.is_some() || s.launch_note.is_some()).map(|(id, _)| id).collect();
        extra.sort();
        for id in extra {
            if !ids.contains(id) {
                ids.push(id.clone());
            }
        }
        let sessions = ids
            .iter()
            .map(|id| {
                let s = g.sessions.get(id);
                AgentBrowserSession {
                    session_id: id.clone(),
                    enabled: cfg.enabled(id),
                    launched: s.is_some_and(|s| s.launched),
                    launch_note: s.and_then(|s| s.launch_note.clone()),
                    connected: s.is_some_and(|s| s.presence > 0),
                    has_tab: s.is_some_and(|s| s.tab.is_some()),
                    url: s.and_then(|s| s.last_url.clone()),
                    title: s.and_then(|s| s.title.clone()),
                    taken_over: s.is_some_and(|s| s.taken_over),
                    stopped: s.is_some_and(|s| s.stopped),
                    busy: s.is_some_and(|s| s.busy),
                    dialog: s.and_then(|s| s.tab.as_ref()).and_then(|t| t.dialog.as_ref()).map(|d| format!("{}: {}", d.kind, policy::truncate(&d.message, 200))),
                    last_action: s.and_then(|s| s.last_action.as_ref().map(|a| a.0.clone())),
                    last_action_ms: s.and_then(|s| s.last_action.as_ref().map(|a| a.1)),
                }
            })
            .collect();
        AgentBrowserState {
            running: g.browser.is_some(),
            browser: g.browser.as_ref().map(|b| b.label.clone()),
            pid: g.browser.as_ref().map(|b| b.process.pid),
            executable: chrome::find_browser(cfg.browser_path.as_deref()).map(|p| p.to_string_lossy().into_owned()),
            error: g.error.clone(),
            idle_minutes: cfg.idle_minutes,
            allowlist: cfg.allowlist.clone(),
            sessions,
            prompts: g.prompts.values().map(|p| p.view.clone()).collect(),
        }
    }

    pub(crate) fn emit_state(&self) {
        let st = self.state();
        let emit = Arc::clone(&self.emit);
        if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| emit(UiEvent::State(st)))).is_err() {
            tracing::error!("agent-browser-state emit panicked");
        }
    }

    /// Log one action: activity event + structured log (redacted).
    pub(crate) fn activity(&self, sid: &str, tool: &str, summary: &str, url: Option<String>, outcome: ActivityOutcome) {
        let summary = crate::redact::redact(&policy::truncate(summary, 300));
        let now = super::now_ms();
        {
            let mut g = self.inner.lock();
            if let Some(s) = g.sessions.get_mut(sid) {
                s.last_action = Some((summary.clone(), now));
                s.last_action_at = Some(Instant::now());
            }
        }
        tracing::info!(session = %sid, tool, outcome = ?outcome, summary = %summary, "agent browser");
        let ev = AgentBrowserActivity { session_id: sid.to_string(), at_ms: now, tool: tool.to_string(), summary, url, outcome };
        let emit = Arc::clone(&self.emit);
        if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| emit(UiEvent::Activity(ev)))).is_err() {
            tracing::error!("agent-browser-activity emit panicked");
        }
    }

    // -----------------------------------------------------------------------
    // Settings
    // -----------------------------------------------------------------------

    pub fn set_session(&self, id: &str, enabled: bool) -> Result<(), String> {
        if !super::valid_session_id(id) {
            return Err("invalid session id".into());
        }
        {
            let mut cfg = self.config.lock();
            if cfg.set_session(id, enabled) {
                cfg.save(&self.config_path()).map_err(|e| format!("could not save the agent browser settings: {e}"))?;
            }
        }
        self.emit_state();
        Ok(())
    }

    pub fn set_allowlist(&self, entries: &[String]) -> Result<Vec<String>, String> {
        let list = {
            let mut cfg = self.config.lock();
            cfg.allowlist = policy::normalize_allowlist(entries);
            cfg.save(&self.config_path()).map_err(|e| format!("could not save the agent browser settings: {e}"))?;
            cfg.allowlist.clone()
        };
        self.emit_state();
        Ok(list)
    }

    pub fn set_idle_minutes(&self, minutes: u32) -> Result<(), String> {
        {
            let mut cfg = self.config.lock();
            cfg.idle_minutes = minutes.clamp(1, config::MAX_IDLE_MINUTES);
            cfg.save(&self.config_path()).map_err(|e| format!("could not save the agent browser settings: {e}"))?;
        }
        self.emit_state();
        Ok(())
    }

    pub(crate) fn allowlist(&self) -> Vec<String> {
        self.config.lock().allowlist.clone()
    }

    /// "Always allow <host>" from a confirmation.
    fn remember_host(&self, entry: &str) {
        let mut cfg = self.config.lock();
        if cfg.allow(entry) {
            if let Err(e) = cfg.save(&self.config_path()) {
                tracing::warn!(error = %e, "could not save the agent browser allowlist");
            }
        }
    }

    // -----------------------------------------------------------------------
    // Launch injection
    // -----------------------------------------------------------------------

    /// Called by the Claude / Codex adapters at launch: the extra arguments (empty when the session has
    /// no browser or it is not possible; the reason then shows in the UI).
    pub fn prepare_launch(&self, id: &str, cli: Cli, via_cmd: bool) -> Vec<String> {
        let enabled = self.config.lock().enabled(id);
        let outcome = (|| -> Result<(Vec<String>, String), String> {
            if !enabled {
                return Err(String::new());
            }
            let exe = self.exe.as_deref().ok_or("Gridkeeper could not locate its own executable")?;
            if !super::valid_session_id(id) {
                return Err("this session id can't be passed to the helper".into());
            }
            if self.server.lock().is_none() {
                return Err("the agent browser endpoint is not running".into());
            }
            let token = ipc::new_token();
            let inj = Injection { exe, session_id: id, endpoint: &self.endpoint, token: &token };
            let args = match cli {
                Cli::Claude => {
                    if let Some(p) = launch::claude_managed_mcp_paths().into_iter().find(|p| p.is_file()) {
                        return Err(format!("Claude Code's managed MCP policy ({}) does not allow extra MCP servers", p.display()));
                    }
                    let path = self.dir.join(launch::config_file_name(id));
                    std::fs::create_dir_all(&self.dir)
                        .and_then(|()| crate::meter::write_atomic(&path, launch::claude_mcp_json(&inj).as_bytes()))
                        .map_err(|e| format!("could not write the MCP config file ({e})"))?;
                    let a = launch::claude_args(&path);
                    if via_cmd {
                        crate::adapters::discovery::validate_cmd_args(&a).map_err(|_| "the data folder path can't pass through the claude.cmd shim".to_string())?;
                    }
                    a
                }
                Cli::Codex => launch::codex_args(&inj, via_cmd)?,
            };
            Ok((args, token))
        })();
        let args = {
            let mut g = self.inner.lock();
            let s = g.sessions.entry(id.to_string()).or_default();
            match outcome {
                Ok((args, token)) => {
                    s.token = Some(token);
                    s.launched = true;
                    s.launch_note = None;
                    s.stopped = false;
                    s.taken_over = false;
                    args
                }
                Err(note) => {
                    s.token = None;
                    s.launched = false;
                    s.launch_note = (!note.is_empty()).then(|| format!("no browser tools in this run: {note}"));
                    Vec::new()
                }
            }
        };
        self.inner.lock().verified.retain(|(_, sid), _| sid != id);
        if enabled || !args.is_empty() {
            self.emit_state();
        }
        args
    }

    // -----------------------------------------------------------------------
    // Helper connections
    // -----------------------------------------------------------------------

    fn handle_conn(self: &Arc<Self>, conn: Conn) {
        let mut reader = std::io::BufReader::new(&conn);
        let line = match ipc::read_line_capped(&mut reader, ipc::MAX_LINE) {
            Ok(Some(l)) => l,
            _ => return,
        };
        drop(reader);
        let mut w = &conn;
        let req: Request = match serde_json::from_str(&line) {
            Ok(r) => r,
            Err(_) => {
                let _ = ipc::write_json_line(&mut w, &Response::err("malformed request"));
                return;
            }
        };
        if let Err(msg) = self.authenticate(&req, conn.peer_pid) {
            tracing::warn!(session = %req.session, reason = %msg, "agent browser connection refused");
            let _ = ipc::write_json_line(&mut w, &Response::err(msg));
            return;
        }
        match req.kind {
            RequestKind::Presence => {
                self.presence(&req.session, true);
                if ipc::write_json_line(&mut w, &Response::ok(None)).is_ok() {
                    let mut sink = [0u8; 256];
                    let mut r = &conn;
                    while matches!(std::io::Read::read(&mut r, &mut sink), Ok(n) if n > 0) {}
                }
                self.presence(&req.session, false);
            }
            RequestKind::Call => {
                let tool = req.tool.clone().unwrap_or_default();
                let result = self.call_tool(&req.session, &tool, &req.args);
                let _ = ipc::write_json_line(&mut w, &Response::ok(Some(result)));
            }
        }
    }

    /// Token of the current launch AND (when the OS reports the peer) a process inside the session.
    pub(crate) fn authenticate(&self, req: &Request, peer_pid: Option<u32>) -> Result<(), String> {
        if req.v != ipc::PROTOCOL_VERSION {
            return Err("helper and Gridkeeper versions differ; restart the agent".into());
        }
        {
            let g = self.inner.lock();
            let Some(s) = g.sessions.get(&req.session) else {
                return Err("this session was not launched with the agent browser".into());
            };
            match s.token.as_deref() {
                Some(t) if ipc::ct_eq(t, &req.token) => {}
                Some(_) => return Err("stale or wrong token (the agent was restarted?)".into()),
                None => return Err("this session was not launched with the agent browser".into()),
            }
            if let Some(pid) = peer_pid {
                if g.verified.get(&(pid, req.session.clone())).is_some_and(|t| t.elapsed() < VERIFY_TTL) {
                    return Ok(());
                }
            }
        }
        let Some(pid) = peer_pid else { return Ok(()) };
        if !self.pid_in_session(&req.session, pid) {
            return Err("the connecting process does not belong to this session".into());
        }
        self.inner.lock().verified.insert((pid, req.session.clone()), Instant::now());
        Ok(())
    }

    fn pid_in_session(&self, sid: &str, pid: u32) -> bool {
        let roots = (self.roots)();
        let Some(root) = roots.iter().find(|(id, _)| id == sid).map(|(_, p)| *p) else { return false };
        if root == pid {
            return true;
        }
        crate::diagnostics::session_trees(&[(sid.to_string(), root)]).iter().any(|(_, pids)| pids.contains(&pid))
    }

    fn presence(&self, sid: &str, connected: bool) {
        {
            let mut g = self.inner.lock();
            let s = g.sessions.entry(sid.to_string()).or_default();
            if connected {
                s.presence += 1;
            } else {
                s.presence = s.presence.saturating_sub(1);
                if s.presence == 0 {
                    s.last_disconnect = Some(Instant::now());
                }
            }
        }
        self.cv.notify_all();
        self.emit_state();
    }

    // -----------------------------------------------------------------------
    // Tool calls
    // -----------------------------------------------------------------------

    pub fn call_tool(self: &Arc<Self>, sid: &str, tool: &str, args: &Value) -> Value {
        if !tools::tool_names().iter().any(|t| t == tool) {
            return tools::text_result(format!("Unknown tool {tool}."), true);
        }
        let out = if tools::is_log_only(tool) {
            self.log_tool(sid, tool, args)
        } else {
            match self.acquire(sid) {
                Err(msg) => super::actions::ToolOut::blocked(msg.clone(), msg),
                Ok(()) => {
                    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| self.run_tool(sid, tool, args)));
                    self.release(sid);
                    match r {
                        Ok(Ok(o)) | Ok(Err(o)) => o,
                        Err(p) => {
                            let msg = crate::pty::panic_message(&p);
                            tracing::error!(tool, panic = %msg, "agent browser tool panicked");
                            super::actions::ToolOut::error(format!("Internal error in {tool}."))
                        }
                    }
                }
            }
        };
        self.inner.lock().last_use = Instant::now();
        self.activity(sid, tool, &out.summary, out.url.clone(), out.outcome);
        let notices: Vec<String> = {
            let mut g = self.inner.lock();
            g.sessions.get_mut(sid).map(|s| std::mem::take(&mut s.notices)).unwrap_or_default()
        };
        self.emit_state();
        out.into_result(&notices)
    }

    /// Wait for this session's turn (one call at a time, none while the user has taken over).
    pub(crate) fn acquire(&self, sid: &str) -> Result<(), String> {
        let deadline = Instant::now() + TAKEOVER_WAIT;
        let mut announced = false;
        let mut g = self.inner.lock();
        loop {
            let s = g.sessions.entry(sid.to_string()).or_default();
            if s.stopped {
                return Err("The user turned off the browser for this agent in Gridkeeper. Don't retry; ask the user if you need it.".into());
            }
            if !s.busy && !s.taken_over {
                s.busy = true;
                return Ok(());
            }
            if s.taken_over && !announced {
                announced = true;
                drop(g);
                self.activity(sid, "takeover", "agent is waiting: the user controls the tab", None, ActivityOutcome::Info);
                g = self.inner.lock();
                continue;
            }
            if self.cv.wait_until(&mut g, deadline).timed_out() {
                let taken = g.sessions.get(sid).is_some_and(|s| s.taken_over);
                return Err(if taken {
                    "The user is still controlling this browser tab in Gridkeeper. Try again later or ask the user.".into()
                } else {
                    "Another browser action of this agent is still running.".into()
                });
            }
        }
    }

    pub(crate) fn release(&self, sid: &str) {
        if let Some(s) = self.inner.lock().sessions.get_mut(sid) {
            s.busy = false;
        }
        self.cv.notify_all();
    }

    /// Ask the user (the tool call waits). `Ok` = allowed.
    pub(crate) fn confirm(&self, sid: &str, kind: PromptKind, origin: Option<String>, detail: String, remember_host: Option<String>) -> Result<(), String> {
        let now = super::now_ms();
        let id = {
            let mut g = self.inner.lock();
            let id = g.next_prompt;
            g.next_prompt += 1;
            let view = AgentBrowserPrompt {
                id,
                session_id: sid.to_string(),
                kind,
                origin,
                detail: policy::truncate(&detail, 1200),
                created_ms: now,
                expires_ms: now + CONFIRM_TIMEOUT.as_millis() as u64,
                remember_host,
            };
            g.prompts.insert(id, Prompt { view, answer: None });
            id
        };
        self.emit_state();
        let answer = self.wait_answer(id, sid);
        self.emit_state();
        match answer {
            Some(Answer::Allow { .. }) => Ok(()),
            Some(Answer::Deny) => Err("The user declined this action in Gridkeeper.".into()),
            None => Err("No answer from the user within 2 minutes, so the action was not performed.".into()),
        }
    }

    /// Wait for prompt `id` (or the session being stopped / the timeout); removes it.
    pub(crate) fn wait_answer(&self, id: u64, sid: &str) -> Option<Answer> {
        let deadline = Instant::now() + CONFIRM_TIMEOUT;
        let mut g = self.inner.lock();
        let answer = loop {
            match g.prompts.get(&id) {
                None => break None,
                Some(p) if p.answer.is_some() => break p.answer,
                Some(_) => {}
            }
            if g.sessions.get(sid).is_some_and(|s| s.stopped) {
                break Some(Answer::Deny);
            }
            if self.cv.wait_until(&mut g, deadline).timed_out() {
                break g.prompts.get(&id).and_then(|p| p.answer);
            }
        };
        let prompt = g.prompts.remove(&id);
        drop(g);
        if let (Some(Answer::Allow { remember: true }), Some(p)) = (answer, prompt) {
            if let Some(host) = p.view.remember_host {
                self.remember_host(&host);
            }
        }
        answer
    }

    pub fn answer(&self, prompt_id: u64, allow: bool, remember: bool) -> Result<(), String> {
        {
            let mut g = self.inner.lock();
            let p = g.prompts.get_mut(&prompt_id).ok_or("this question is no longer open")?;
            p.answer = Some(if allow { Answer::Allow { remember } } else { Answer::Deny });
        }
        self.cv.notify_all();
        Ok(())
    }

    // -----------------------------------------------------------------------
    // User controls
    // -----------------------------------------------------------------------

    pub fn take_over(&self, sid: &str, on: bool) -> Result<(), String> {
        {
            let mut g = self.inner.lock();
            let s = g.sessions.get_mut(sid).ok_or("this agent has no browser tab")?;
            if s.taken_over == on {
                return Ok(());
            }
            s.taken_over = on;
        }
        self.cv.notify_all();
        self.activity(
            sid,
            "takeover",
            if on { "the user took over the tab (agent calls wait)" } else { "the user handed the tab back to the agent" },
            None,
            ActivityOutcome::Info,
        );
        self.emit_state();
        Ok(())
    }

    /// "Stop agent browsing": close the tab and refuse calls until resumed (or the agent restarts).
    pub fn set_stopped(&self, sid: &str, stopped: bool) -> Result<(), String> {
        {
            let mut g = self.inner.lock();
            let s = g.sessions.entry(sid.to_string()).or_default();
            s.stopped = stopped;
            if stopped {
                s.taken_over = false;
            }
        }
        self.cv.notify_all();
        if stopped {
            self.close_tab(sid);
        }
        self.activity(
            sid,
            "stop",
            if stopped { "the user stopped browsing for this agent" } else { "the user allowed browsing again" },
            None,
            ActivityOutcome::Info,
        );
        self.emit_state();
        Ok(())
    }

    pub fn watch(&self, sid: &str, sink: Arc<dyn FrameSink>, max_w: u32, max_h: u32, token: u32) {
        let (max_w, max_h) = (max_w.clamp(160, 1920), max_h.clamp(100, 1200));
        let tab = {
            let mut g = self.inner.lock();
            let s = g.sessions.entry(sid.to_string()).or_default();
            s.watch = Some(Watch { token, sink, max_w, max_h });
            g.last_use = Instant::now();
            self.tab_ref_locked(&g, sid)
        };
        if let Some(t) = tab {
            self.start_screencast(&t, max_w, max_h);
        }
    }

    pub fn unwatch(&self, sid: &str, token: u32) {
        let tab = {
            let mut g = self.inner.lock();
            let had = match g.sessions.get_mut(sid) {
                Some(s) if s.watch.as_ref().is_some_and(|w| w.token == token) => s.watch.take().is_some(),
                _ => false,
            };
            if had { self.tab_ref_locked(&g, sid) } else { None }
        };
        if let Some(t) = tab {
            let _ = t.cdp.send("Page.stopScreencast", json!({}), Some(&t.session));
            if let Some(tab) = self.inner.lock().sessions.get_mut(sid).and_then(|s| s.tab.as_mut()) {
                tab.screencast = false;
            }
        }
    }

    pub(crate) fn start_screencast(&self, t: &TabRef, max_w: u32, max_h: u32) {
        let params = json!({ "format": "jpeg", "quality": 60, "maxWidth": max_w, "maxHeight": max_h, "everyNthFrame": 1 });
        if t.cdp.send("Page.startScreencast", params, Some(&t.session)).is_ok() {
            if let Some(tab) = self.inner.lock().sessions.get_mut(&t.sid).and_then(|s| s.tab.as_mut()) {
                tab.screencast = true;
                tab.next_ack = None;
            }
        }
    }

    /// Input from the Agent browser view while the user has taken over the tab.
    pub fn input(&self, sid: &str, ev: &InputEvent) -> Result<(), String> {
        let t = {
            let g = self.inner.lock();
            let s = g.sessions.get(sid).ok_or("this agent has no browser tab")?;
            if !s.taken_over {
                return Err("take over the tab first".into());
            }
            self.tab_ref_locked(&g, sid).ok_or("this agent has no browser tab")?
        };
        let send = |m: &str, p: Value| t.cdp.send(m, p, Some(&t.session));
        match ev {
            InputEvent::Mouse { action, x, y, button, click_count, delta_x, delta_y, modifiers } => {
                let kind = match action.as_str() {
                    "down" => "mousePressed",
                    "up" => "mouseReleased",
                    "move" => "mouseMoved",
                    "wheel" => "mouseWheel",
                    _ => return Err("unknown mouse action".into()),
                };
                let button = match button.as_deref() {
                    Some(b @ ("left" | "middle" | "right")) => b,
                    _ => "none",
                };
                let mut p = json!({ "type": kind, "x": x, "y": y, "modifiers": modifiers, "button": button });
                if matches!(kind, "mousePressed" | "mouseReleased") {
                    p["clickCount"] = json!(click_count.unwrap_or(1).clamp(1, 3));
                }
                if kind == "mouseWheel" {
                    p["deltaX"] = json!(delta_x.unwrap_or(0.0));
                    p["deltaY"] = json!(delta_y.unwrap_or(0.0));
                    p["button"] = json!("none");
                }
                send("Input.dispatchMouseEvent", p)
            }
            InputEvent::Key { action, key, code, key_code, text, modifiers } => {
                let text = text.as_deref().filter(|t| !t.is_empty() && t.chars().count() <= 4);
                let kind = match (action.as_str(), text) {
                    ("down", Some(_)) => "keyDown",
                    ("down", None) => "rawKeyDown",
                    ("up", _) => "keyUp",
                    _ => return Err("unknown key action".into()),
                };
                let mut p = json!({ "type": kind, "key": key, "code": code, "windowsVirtualKeyCode": key_code, "modifiers": modifiers });
                if kind == "keyDown" {
                    p["text"] = json!(text);
                }
                send("Input.dispatchKeyEvent", p)
            }
            InputEvent::Text { text } => {
                if text.len() > 100_000 {
                    return Err("text too long".into());
                }
                send("Input.insertText", json!({ "text": text }))
            }
        }
    }

    /// Stop the shared browser now (the UI's "Close browser"; tabs reopen on the next tool call).
    pub fn stop_browser(&self, reason: &str) {
        let b = {
            let mut g = self.inner.lock();
            let Some(b) = g.browser.take() else { return };
            g.stopping_gen = b.generation;
            Self::forget_tabs_locked(&mut g, true);
            b
        };
        let _ = b.cdp.send("Browser.close", json!({}), None);
        if !b.process.wait_exit(Duration::from_millis(1500)) {
            b.process.kill();
        }
        tracing::info!(reason, "agent browser stopped");
        self.cv.notify_all();
        self.emit_state();
    }

    pub fn shutdown(&self) {
        if let Some(mut s) = self.server.lock().take() {
            s.stop();
        }
        let b = {
            let mut g = self.inner.lock();
            let b = g.browser.take();
            if let Some(b) = &b {
                g.stopping_gen = b.generation;
            }
            b
        };
        if let Some(b) = b {
            let _ = b.cdp.send("Browser.close", json!({}), None);
            if !b.process.wait_exit(Duration::from_millis(800)) {
                b.process.kill();
            }
        }
        cleanup_launch_files(&self.dir);
    }

    // -----------------------------------------------------------------------
    // Browser and tabs
    // -----------------------------------------------------------------------

    /// Drop every tab (browser gone). `reopen`: the next call reopens the last URL.
    pub(crate) fn forget_tabs_locked(g: &mut Inner, reopen: bool) {
        g.by_cdp.clear();
        g.by_target.clear();
        g.popups.clear();
        for s in g.sessions.values_mut() {
            if s.tab.take().is_some() && reopen {
                s.reopen = true;
            }
        }
        g.no_tabs_since = Some(Instant::now());
    }

    pub(crate) fn tab_ref_locked(&self, g: &Inner, sid: &str) -> Option<TabRef> {
        let b = g.browser.as_ref()?;
        let t = g.sessions.get(sid)?.tab.as_ref().filter(|t| t.generation == b.generation)?;
        Some(TabRef { sid: sid.to_string(), cdp: Arc::clone(&b.cdp), session: t.cdp_session.clone(), target: t.target_id.clone(), generation: t.generation })
    }

    pub(crate) fn ensure_browser(self: &Arc<Self>) -> Result<Arc<BrowserHandle>, String> {
        if let Some(b) = self.inner.lock().browser.clone().filter(|b| !b.cdp.is_closed()) {
            return Ok(b);
        }
        let _starting = self.browser_start.lock();
        if let Some(b) = self.inner.lock().browser.clone().filter(|b| !b.cdp.is_closed()) {
            return Ok(b);
        }
        let r = self.start_browser();
        match &r {
            Ok(_) => self.inner.lock().error = None,
            Err(e) => self.inner.lock().error = Some(e.clone()),
        }
        self.emit_state();
        r
    }

    fn start_browser(self: &Arc<Self>) -> Result<Arc<BrowserHandle>, String> {
        let cfg = self.config.lock().clone();
        let exe = chrome::find_browser(cfg.browser_path.as_deref()).ok_or(
            "No Chromium-based browser found (Microsoft Edge, Google Chrome or Chromium). Install one, or set browserPath in Gridkeeper's agent-browser/config.json.",
        )?;
        let profile = self.dir.join("profile");
        std::fs::create_dir_all(&profile).map_err(|e| format!("could not create the browser profile folder: {e}"))?;
        let generation = self.generation.fetch_add(1, std::sync::atomic::Ordering::AcqRel) + 1;
        let args = chrome::launch_args(&profile, !cfg.show_window);
        let launched = chrome::launch(&exe, &args).map_err(|e| format!("could not start {}: {e}", chrome::label(&exe)))?;
        let (tx, rx) = mpsc::channel::<super::events::Ev>();
        let tx_close = tx.clone();
        let cdp = Cdp::start(
            launched.reader,
            launched.writer,
            Box::new(move |ev: CdpEvent| {
                let _ = tx.send(super::events::Ev::Cdp(ev));
            }),
            Box::new(move || {
                let _ = tx_close.send(super::events::Ev::Closed);
            }),
        )
        .map_err(|e| format!("could not start the DevTools reader: {e}"))?;
        let weak = Arc::downgrade(self);
        crate::pty::spawn_guarded("agent-browser-events".into(), move || super::events::event_loop(weak, generation, rx))
            .map_err(|e| format!("could not start the event thread: {e}"))?;
        let version = match cdp.call("Browser.getVersion", json!({}), None, Duration::from_secs(20)) {
            Ok(v) => v,
            Err(e) => {
                launched.process.kill();
                return Err(format!(
                    "{} did not answer on the DevTools pipe ({e}). A policy may disable remote debugging (RemoteDebuggingAllowed).",
                    chrome::label(&exe)
                ));
            }
        };
        if let Err(e) = cdp.call("Target.setDiscoverTargets", json!({ "discover": true }), None, CDP_TIMEOUT) {
            tracing::warn!(error = %e, "Target.setDiscoverTargets failed");
        }
        let product = version.get("product").and_then(Value::as_str).unwrap_or("");
        let label = match product.split_once('/') {
            Some((_, v)) => format!("{} {v}", chrome::label(&exe)),
            None => chrome::label(&exe).to_string(),
        };
        let pid = launched.process.pid;
        let handle = Arc::new(BrowserHandle { generation, cdp, process: launched.process, label });
        let start_janitor = {
            let mut g = self.inner.lock();
            Self::forget_tabs_locked(&mut g, true);
            g.browser = Some(Arc::clone(&handle));
            g.last_use = Instant::now();
            g.no_tabs_since = Some(Instant::now());
            let start = g.janitor_gen != generation;
            g.janitor_gen = generation;
            start
        };
        tracing::info!(pid, browser = %handle.label, "agent browser started");
        if start_janitor {
            let weak = Arc::downgrade(self);
            let _ = crate::pty::spawn_guarded("agent-browser-janitor".into(), move || janitor_loop(weak, generation));
        }
        Ok(handle)
    }

    /// The session's tab in the running browser, created (and reopened at its last URL) if needed.
    pub(crate) fn ensure_tab(self: &Arc<Self>, sid: &str) -> Result<TabRef, String> {
        let b = self.ensure_browser()?;
        let reopen_url = {
            let g = self.inner.lock();
            if let Some(t) = self.tab_ref_locked(&g, sid) {
                return Ok(t);
            }
            g.sessions.get(sid).filter(|s| s.reopen).and_then(|s| s.last_url.clone())
        };
        let cdp = &b.cdp;
        let ctx = cdp
            .call("Target.createBrowserContext", json!({ "disposeOnDetach": false }), None, CDP_TIMEOUT)?
            .get("browserContextId")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or("the browser returned no context id")?;
        let created = cdp
            .call("Target.createTarget", json!({ "url": "about:blank", "browserContextId": ctx, "newWindow": true }), None, CDP_TIMEOUT)
            .or_else(|_| cdp.call("Target.createTarget", json!({ "url": "about:blank", "browserContextId": ctx }), None, CDP_TIMEOUT));
        let target = match created.ok().and_then(|v| v.get("targetId").and_then(Value::as_str).map(str::to_string)) {
            Some(t) => t,
            None => {
                let _ = cdp.send("Target.disposeBrowserContext", json!({ "browserContextId": ctx }), None);
                return Err("the browser could not open a tab".into());
            }
        };
        self.inner.lock().by_target.insert(target.clone(), sid.to_string());
        let session = cdp
            .call("Target.attachToTarget", json!({ "targetId": target, "flatten": true }), None, CDP_TIMEOUT)?
            .get("sessionId")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or("the browser returned no session id")?;
        let watch = {
            let mut g = self.inner.lock();
            g.by_cdp.insert(session.clone(), sid.to_string());
            g.no_tabs_since = None;
            let s = g.sessions.entry(sid.to_string()).or_default();
            s.tab = Some(Tab::new(b.generation, target.clone(), session.clone(), ctx.clone()));
            s.watch.as_ref().map(|w| (w.max_w, w.max_h))
        };
        for (m, p) in [
            ("Page.enable", json!({})),
            ("Runtime.enable", json!({})),
            ("Network.enable", json!({ "maxTotalBufferSize": 1_048_576, "maxResourceBufferSize": 262_144 })),
            ("Log.enable", json!({})),
            ("Inspector.enable", json!({})),
            ("Emulation.setFocusEmulationEnabled", json!({ "enabled": true })),
            ("Page.setInterceptFileChooserDialog", json!({ "enabled": true })),
        ] {
            if let Err(e) = cdp.call(m, p, Some(&session), CDP_TIMEOUT) {
                if matches!(m, "Page.enable" | "Runtime.enable") {
                    return Err(format!("could not prepare the tab ({m}: {e})"));
                }
                tracing::debug!(method = m, error = %e, "optional tab setup failed");
            }
        }
        let downloads = self.downloads_dir(sid);
        let _ = std::fs::create_dir_all(&downloads);
        let _ = cdp.call(
            "Browser.setDownloadBehavior",
            json!({ "behavior": "allowAndName", "browserContextId": ctx, "downloadPath": downloads.to_string_lossy(), "eventsEnabled": true }),
            None,
            CDP_TIMEOUT,
        );
        let t = TabRef { sid: sid.to_string(), cdp: Arc::clone(cdp), session, target, generation: b.generation };
        if let Some((w, h)) = watch {
            self.start_screencast(&t, w, h);
        }
        {
            let mut g = self.inner.lock();
            if let Some(s) = g.sessions.get_mut(sid) {
                if s.reopen {
                    s.reopen = false;
                    if let Some(u) = &reopen_url {
                        s.notice(format!(
                            "The browser had been closed (idle timeout or restart), so your tab was reopened at {}. Page state such as logins or form input was lost.",
                            policy::log_url(u)
                        ));
                    }
                }
            }
        }
        if let Some(u) = reopen_url.filter(|u| policy::navigable(u).is_ok() && u != "about:blank") {
            let _ = self.navigate_and_wait(&t, &u);
        }
        self.emit_state();
        Ok(t)
    }

    /// Close a session's tab (dispose its browser context).
    pub(crate) fn close_tab(&self, sid: &str) {
        let (tab, cdp) = {
            let mut g = self.inner.lock();
            let cdp = g.browser.as_ref().map(|b| Arc::clone(&b.cdp));
            let tab = g.sessions.get_mut(sid).and_then(|s| s.tab.take());
            if let Some(t) = &tab {
                g.by_cdp.remove(&t.cdp_session);
                g.by_target.remove(&t.target_id);
                g.popups.retain(|_, s| s != sid);
            }
            if g.sessions.values().all(|s| s.tab.is_none()) {
                g.no_tabs_since = Some(Instant::now());
            }
            (tab, cdp)
        };
        if let (Some(t), Some(cdp)) = (tab, cdp) {
            let _ = cdp.send("Target.disposeBrowserContext", json!({ "browserContextId": t.context_id }), None);
        }
        self.cv.notify_all();
    }

    /// The browser pipe closed.
    pub(crate) fn on_browser_closed(&self, generation: u64) {
        let lost: Vec<String> = {
            let mut g = self.inner.lock();
            if !g.browser.as_ref().is_some_and(|b| b.generation == generation) {
                return; // an older browser, or stopped on purpose
            }
            let had: Vec<String> = g.sessions.iter().filter(|(_, s)| s.tab.is_some()).map(|(id, _)| id.clone()).collect();
            g.browser = None;
            Self::forget_tabs_locked(&mut g, true);
            if g.stopping_gen != generation {
                g.error = Some("The browser exited unexpectedly; it restarts on the next tool call.".into());
            }
            had
        };
        tracing::warn!("agent browser exited");
        for sid in lost {
            self.activity(&sid, "browser", "the browser exited; the tab reopens on the next call", None, ActivityOutcome::Error);
        }
        self.cv.notify_all();
        self.emit_state();
    }

    fn janitor_tick(&self, generation: u64) -> bool {
        let idle = Duration::from_secs(u64::from(self.config.lock().idle_minutes) * 60);
        let now = Instant::now();
        let (close, stop) = {
            let g = self.inner.lock();
            if !g.browser.as_ref().is_some_and(|b| b.generation == generation) {
                return false;
            }
            let rows: Vec<JanitorRow> = g
                .sessions
                .iter()
                .map(|(id, s)| JanitorRow {
                    id: id.clone(),
                    has_tab: s.tab.is_some(),
                    presence: s.presence,
                    busy: s.busy,
                    watched: s.watch.is_some(),
                    last_disconnect: s.last_disconnect,
                })
                .collect();
            plan_janitor(&rows, now, g.last_use, g.no_tabs_since, !g.prompts.is_empty(), idle)
        };
        for sid in close {
            self.close_tab(&sid);
            self.emit_state();
        }
        if let Some(reason) = stop {
            self.stop_browser(reason);
            return false;
        }
        true
    }
}

/// One session as the janitor sees it.
#[derive(Debug, Clone)]
pub(crate) struct JanitorRow {
    pub id: SessionId,
    pub has_tab: bool,
    pub presence: u32,
    pub busy: bool,
    pub watched: bool,
    pub last_disconnect: Option<Instant>,
}

/// Lifecycle decisions (pure): tabs to close (their agent's helper has been gone for `TAB_GRACE`),
/// and whether to stop the browser ("idle": no tool call for `idle` and nobody watching; "no agent
/// tabs": no tab for `NO_TAB_STOP`). Nothing stops while a call runs, a viewer watches or a question
/// is open.
pub(crate) fn plan_janitor(
    rows: &[JanitorRow],
    now: Instant,
    last_use: Instant,
    no_tabs_since: Option<Instant>,
    prompts_open: bool,
    idle: Duration,
) -> (Vec<SessionId>, Option<&'static str>) {
    let close: Vec<SessionId> = rows
        .iter()
        .filter(|r| r.has_tab && r.presence == 0 && !r.busy && !r.watched && r.last_disconnect.is_some_and(|t| now.duration_since(t) > TAB_GRACE))
        .map(|r| r.id.clone())
        .collect();
    let active = prompts_open || rows.iter().any(|r| r.busy || r.watched);
    let idle_stop = !active && now.duration_since(last_use) > idle;
    let empty_stop = !active && rows.iter().all(|r| !r.has_tab) && no_tabs_since.is_some_and(|t| now.duration_since(t) > NO_TAB_STOP);
    (close, if idle_stop { Some("idle") } else if empty_stop { Some("no agent tabs") } else { None })
}

fn janitor_loop(weak: Weak<Hub>, generation: u64) {
    loop {
        {
            let Some(hub) = weak.upgrade() else { return };
            let mut g = hub.inner.lock();
            if !g.browser.as_ref().is_some_and(|b| b.generation == generation) {
                return;
            }
            let _ = hub.cv.wait_for(&mut g, JANITOR_TICK);
        }
        let Some(hub) = weak.upgrade() else { return };
        if !hub.janitor_tick(generation) {
            return;
        }
    }
}

/// Delete the per-launch MCP config files (no session survives an app restart).
fn cleanup_launch_files(dir: &Path) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if name.starts_with("mcp-") && name.ends_with(".json") {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

#[cfg(test)]
pub(crate) mod tests_support {
    /// A tab record without a browser (event routing tests).
    pub fn tab(generation: u64, target: &str, session: &str) -> super::Tab {
        super::Tab::new(generation, target.to_string(), session.to_string(), format!("ctx-{target}"))
    }
}
