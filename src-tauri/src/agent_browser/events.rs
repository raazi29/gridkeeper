//! CDP events of the shared browser, handled on one thread per browser: page load tracking, URL /
//! title, console and network rings, JavaScript dialogs, popups (closed and reported), downloads
//! (kept only after the user allows them), crashes, and screencast frames for the Agent browser view
//! (acknowledged at most every `FRAME_INTERVAL`, which is what throttles Chromium's encoder).

use std::path::PathBuf;
use std::sync::{Arc, Weak, mpsc};
use std::time::{Duration, Instant};

use base64::Engine;
use serde_json::{Value, json};

use super::cdp::CdpEvent;
use super::hub::{Download, FRAME_INTERVAL, Hub, NETWORK_MAX, NetEntry, Prompt};
use super::model::{ActivityOutcome, AgentBrowserPrompt, PromptKind};
use super::policy;

pub(crate) enum Ev {
    Cdp(CdpEvent),
    Closed,
}

/// A screencast frame for the view: `[u32 LE header length][header JSON][JPEG bytes]`. The header
/// carries the page viewport in CSS pixels (`w`, `h`) the frontend maps pointer positions to.
pub fn encode_frame(jpeg: &[u8], metadata: &Value) -> Vec<u8> {
    let header = json!({
        "w": metadata.get("deviceWidth").and_then(Value::as_f64).unwrap_or(0.0),
        "h": metadata.get("deviceHeight").and_then(Value::as_f64).unwrap_or(0.0),
        "top": metadata.get("offsetTop").and_then(Value::as_f64).unwrap_or(0.0),
        "scale": metadata.get("pageScaleFactor").and_then(Value::as_f64).unwrap_or(1.0),
        "ts": metadata.get("timestamp").and_then(Value::as_f64).unwrap_or(0.0),
    })
    .to_string();
    let mut out = Vec::with_capacity(4 + header.len() + jpeg.len());
    out.extend_from_slice(&(header.len() as u32).to_le_bytes());
    out.extend_from_slice(header.as_bytes());
    out.extend_from_slice(jpeg);
    out
}

/// A safe file name for a download (`[A-Za-z0-9._ -]`, at most 120 characters).
pub fn sanitize_file_name(name: &str) -> String {
    let mut s: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | ' ') { c } else { '_' })
        .collect();
    s = s.trim_matches(|c| c == '.' || c == ' ').to_string();
    if s.chars().count() > 120 {
        s = s.chars().take(120).collect();
    }
    if s.is_empty() { "download".into() } else { s }
}

pub(crate) struct PendingAck {
    due: Instant,
    session: String,
    frame: Value,
}

pub(crate) fn event_loop(weak: Weak<Hub>, gen: u64, rx: mpsc::Receiver<Ev>) {
    let mut acks: Vec<PendingAck> = Vec::new();
    loop {
        let wait = acks.iter().map(|a| a.due).min().map(|d| d.saturating_duration_since(Instant::now())).unwrap_or(Duration::from_secs(3600));
        match rx.recv_timeout(wait) {
            Ok(Ev::Cdp(ev)) => {
                let Some(hub) = weak.upgrade() else { return };
                hub.on_event(gen, ev, &mut acks);
            }
            Ok(Ev::Closed) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                if let Some(hub) = weak.upgrade() {
                    hub.on_browser_closed(gen);
                }
                return;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        if acks.is_empty() {
            continue;
        }
        let Some(hub) = weak.upgrade() else { return };
        let now = Instant::now();
        let cdp = hub.inner.lock().browser.as_ref().filter(|b| b.gen == gen).map(|b| Arc::clone(&b.cdp));
        acks.retain(|a| {
            if a.due > now {
                return true;
            }
            if let Some(c) = &cdp {
                let _ = c.send("Page.screencastFrameAck", json!({ "sessionId": a.frame }), Some(&a.session));
            }
            false
        });
    }
}

fn is_real_url(u: &str) -> bool {
    !u.is_empty() && u != "about:blank"
}

impl Hub {
    pub(crate) fn on_event(self: &Arc<Self>, gen: u64, ev: CdpEvent, acks: &mut Vec<PendingAck>) {
        let p = &ev.params;
        match ev.session_id.as_deref() {
            None => self.on_browser_event(gen, &ev.method, p),
            Some(cdp_session) => self.on_tab_event(gen, cdp_session, &ev.method, p, acks),
        }
    }

    fn browser_cdp(&self, gen: u64) -> Option<Arc<super::cdp::Cdp>> {
        self.inner.lock().browser.as_ref().filter(|b| b.gen == gen).map(|b| Arc::clone(&b.cdp))
    }

    fn on_browser_event(self: &Arc<Self>, gen: u64, method: &str, p: &Value) {
        match method {
            "Target.targetCreated" | "Target.targetInfoChanged" => {
                let info = &p["targetInfo"];
                let target = info["targetId"].as_str().unwrap_or("").to_string();
                let url = info["url"].as_str().unwrap_or("").to_string();
                let mut changed = false;
                let mut close_popup: Option<(String, String)> = None;
                {
                    let mut g = self.inner.lock();
                    if let Some(sid) = g.by_target.get(&target).cloned() {
                        if let Some(s) = g.sessions.get_mut(&sid) {
                            let title = info["title"].as_str().map(str::to_string).filter(|t| !t.is_empty());
                            if is_real_url(&url) && s.last_url.as_deref() != Some(url.as_str()) {
                                s.last_url = Some(url.clone());
                                changed = true;
                            }
                            if title.is_some() && s.title != title {
                                s.title = title;
                                changed = true;
                            }
                        }
                    } else if info["type"].as_str() == Some("page") {
                        let opener = info["openerId"].as_str().unwrap_or("");
                        let owner = g.by_target.get(opener).cloned().or_else(|| g.popups.get(&target).cloned());
                        if let Some(sid) = owner {
                            g.popups.insert(target.clone(), sid.clone());
                            if is_real_url(&url) {
                                close_popup = Some((sid, url.clone()));
                            }
                        }
                    }
                }
                if let Some((sid, url)) = close_popup {
                    self.inner.lock().popups.remove(&target);
                    if let Some(c) = self.browser_cdp(gen) {
                        let _ = c.send("Target.closeTarget", json!({ "targetId": target }), None);
                    }
                    let msg = format!("The page tried to open a new window ({}); it was closed. Use browser_navigate to open it in your tab.", policy::log_url(&url));
                    if let Some(s) = self.inner.lock().sessions.get_mut(&sid) {
                        s.notice(msg);
                    }
                    self.activity(&sid, "popup", &format!("closed a new window: {}", policy::log_url(&url)), Some(policy::log_url(&url)), ActivityOutcome::Info);
                }
                if changed {
                    self.emit_state();
                }
            }
            "Target.targetDestroyed" | "Target.detachedFromTarget" => {
                let target = p["targetId"].as_str().unwrap_or("").to_string();
                let session = p["sessionId"].as_str().unwrap_or("").to_string();
                let lost = {
                    let mut g = self.inner.lock();
                    g.popups.remove(&target);
                    let sid = g.by_target.get(&target).cloned().or_else(|| g.by_cdp.get(&session).cloned());
                    match sid {
                        Some(sid) => {
                            let matches = g.sessions.get(&sid).and_then(|s| s.tab.as_ref()).is_some_and(|t| t.target_id == target || t.cdp_session == session);
                            if matches {
                                if let Some(s) = g.sessions.get_mut(&sid) {
                                    s.tab = None;
                                    s.reopen = true;
                                }
                                g.by_target.retain(|_, v| *v != sid);
                                g.by_cdp.retain(|_, v| *v != sid);
                                Some(sid)
                            } else {
                                None
                            }
                        }
                        None => None,
                    }
                };
                if let Some(sid) = lost {
                    self.cv.notify_all();
                    self.activity(&sid, "tab", "the tab was closed; it reopens on the next call", None, ActivityOutcome::Info);
                    self.emit_state();
                }
            }
            "Browser.downloadWillBegin" => self.on_download_begin(gen, p),
            "Browser.downloadProgress" => self.on_download_progress(gen, p),
            _ => {}
        }
    }

    fn on_tab_event(self: &Arc<Self>, gen: u64, cdp_session: &str, method: &str, p: &Value, acks: &mut Vec<PendingAck>) {
        let mut g = self.inner.lock();
        let Some(sid) = g.by_cdp.get(cdp_session).cloned() else {
            // A frame for a tab we no longer track: ack so Chromium doesn't stall, then ignore.
            if method == "Page.screencastFrame" {
                drop(g);
                if let Some(c) = self.browser_cdp(gen) {
                    let _ = c.send("Page.stopScreencast", json!({}), Some(cdp_session));
                }
            }
            return;
        };
        let Some(s) = g.sessions.get_mut(&sid) else { return };
        let Some(tab) = s.tab.as_mut().filter(|t| t.gen == gen) else { return };
        let main = tab.target_id.clone();
        let mut notify = false;
        let mut emit = false;
        match method {
            "Page.frameStartedLoading" if p["frameId"].as_str() == Some(main.as_str()) => {
                tab.loading = true;
                tab.nav_started += 1;
                notify = true;
            }
            "Page.frameStoppedLoading" if p["frameId"].as_str() == Some(main.as_str()) => {
                tab.loading = false;
                tab.nav_done += 1;
                notify = true;
            }
            "Page.loadEventFired" => {
                tab.loading = false;
                tab.nav_done += 1;
                notify = true;
            }
            "Page.frameNavigated" => {
                let f = &p["frame"];
                if f.get("parentId").is_none() {
                    tab.world = None;
                    if let Some(u) = f["url"].as_str().filter(|u| is_real_url(u)) {
                        s.last_url = Some(u.to_string());
                        emit = true;
                    }
                }
            }
            "Page.navigatedWithinDocument" if p["frameId"].as_str() == Some(main.as_str()) => {
                if let Some(u) = p["url"].as_str().filter(|u| is_real_url(u)) {
                    s.last_url = Some(u.to_string());
                    emit = true;
                }
            }
            "Runtime.executionContextsCleared" => tab.world = None,
            "Runtime.executionContextDestroyed" => {
                if p["executionContextId"].as_i64().is_some() && p["executionContextId"].as_i64() == tab.world {
                    tab.world = None;
                }
            }
            "Runtime.consoleAPICalled" => {
                let level = match p["type"].as_str().unwrap_or("log") {
                    "warning" => "warning",
                    "error" | "assert" => "error",
                    "debug" => "debug",
                    "info" => "info",
                    _ => "log",
                };
                let text = p["args"].as_array().map(|a| a.iter().map(remote_text).collect::<Vec<_>>().join(" ")).unwrap_or_default();
                let at = location(&p["stackTrace"]["callFrames"][0]);
                tab.push_console(level, policy::truncate(&format!("{text}{at}"), 2000));
            }
            "Runtime.exceptionThrown" => {
                let d = &p["exceptionDetails"];
                let text = d["exception"]["description"].as_str().or(d["text"].as_str()).unwrap_or("exception");
                let at = d["url"].as_str().map(|u| format!(" ({}:{})", policy::log_url(u), d["lineNumber"].as_i64().unwrap_or(0) + 1)).unwrap_or_default();
                tab.push_console("error", policy::truncate(&format!("Uncaught {text}{at}"), 2000));
            }
            "Log.entryAdded" => {
                let e = &p["entry"];
                let level = match e["level"].as_str().unwrap_or("info") {
                    "error" => "error",
                    "warning" => "warning",
                    "verbose" => "debug",
                    _ => "info",
                };
                let src = e["source"].as_str().unwrap_or("browser");
                let url = e["url"].as_str().map(|u| format!(" ({})", policy::log_url(u))).unwrap_or_default();
                tab.push_console(level, policy::truncate(&format!("[{src}] {}{url}", e["text"].as_str().unwrap_or("")), 2000));
            }
            "Network.requestWillBeSent" => {
                let id = p["requestId"].as_str().unwrap_or("").to_string();
                if let Some(redirect) = p.get("redirectResponse") {
                    if let Some(e) = tab.network.iter_mut().rev().find(|e| e.id == id) {
                        e.status = redirect["status"].as_u64().map(|s| s as u16);
                        e.id.push_str(":redirected");
                    }
                }
                if tab.network.len() >= NETWORK_MAX {
                    tab.network.pop_front();
                }
                tab.network.push_back(NetEntry {
                    id,
                    method: p["request"]["method"].as_str().unwrap_or("GET").to_string(),
                    url: policy::log_url(p["request"]["url"].as_str().unwrap_or("")),
                    kind: p["type"].as_str().unwrap_or("Other").to_string(),
                    status: None,
                    failed: None,
                });
            }
            "Network.responseReceived" => {
                let id = p["requestId"].as_str().unwrap_or("");
                if let Some(e) = tab.network.iter_mut().rev().find(|e| e.id == id) {
                    e.status = p["response"]["status"].as_u64().map(|s| s as u16);
                }
            }
            "Network.loadingFailed" => {
                let id = p["requestId"].as_str().unwrap_or("");
                if let Some(e) = tab.network.iter_mut().rev().find(|e| e.id == id) {
                    let reason = p["blockedReason"].as_str().map(|b| format!("blocked: {b}")).or_else(|| {
                        p["errorText"].as_str().map(|t| if p["canceled"].as_bool() == Some(true) { format!("{t} (canceled)") } else { t.to_string() })
                    });
                    e.failed = reason.or(Some("failed".into()));
                }
            }
            "Page.javascriptDialogOpening" => {
                let kind = p["type"].as_str().unwrap_or("alert").to_string();
                let message = p["message"].as_str().unwrap_or("").to_string();
                if kind == "alert" || kind == "beforeunload" {
                    s.notice(format!("A JavaScript {kind} dialog appeared and was accepted: {}", policy::truncate(&message, 300)));
                    drop(g);
                    if let Some(c) = self.browser_cdp(gen) {
                        let _ = c.send("Page.handleJavaScriptDialog", json!({ "accept": true }), Some(cdp_session));
                    }
                    return;
                }
                let note = format!("A JavaScript {kind} dialog is open: \"{}\". Call browser_handle_dialog to accept or dismiss it.", policy::truncate(&message, 300));
                tab.dialog = Some(super::hub::Dialog { kind, message });
                s.notice(note);
                notify = true;
                emit = true;
            }
            "Page.javascriptDialogClosed" => {
                tab.dialog = None;
                notify = true;
                emit = true;
            }
            "Page.fileChooserOpened" => {
                s.notice("A file chooser opened. Use browser_file_upload with the ref of the file input (the user approves uploads).");
            }
            "Inspector.targetCrashed" => {
                let ctx = tab.context_id.clone();
                let target = tab.target_id.clone();
                s.notice("The tab crashed; it was reopened.");
                s.tab = None;
                s.reopen = true;
                g.by_cdp.remove(cdp_session);
                g.by_target.remove(&target);
                drop(g);
                if let Some(c) = self.browser_cdp(gen) {
                    let _ = c.send("Target.disposeBrowserContext", json!({ "browserContextId": ctx }), None);
                }
                self.cv.notify_all();
                self.activity(&sid, "tab", "the tab crashed", None, ActivityOutcome::Error);
                self.emit_state();
                return;
            }
            "Page.screencastFrame" => {
                let frame = p["sessionId"].clone();
                let sink = s.watch.as_ref().map(|w| Arc::clone(&w.sink));
                let now = Instant::now();
                let due = tab.next_ack.map_or(now, |t| t.max(now));
                tab.next_ack = Some(due + FRAME_INTERVAL);
                drop(g);
                let mut keep = false;
                if let Some(sink) = sink {
                    if let Ok(jpeg) = base64::engine::general_purpose::STANDARD.decode(p["data"].as_str().unwrap_or("")) {
                        keep = sink.send(encode_frame(&jpeg, &p["metadata"]));
                    }
                }
                if keep {
                    acks.push(PendingAck { due, session: cdp_session.to_string(), frame });
                } else {
                    // The viewer went away: stop the stream (ack this frame so nothing is left pending).
                    if let Some(c) = self.browser_cdp(gen) {
                        let _ = c.send("Page.screencastFrameAck", json!({ "sessionId": frame }), Some(cdp_session));
                        let _ = c.send("Page.stopScreencast", json!({}), Some(cdp_session));
                    }
                    let mut g = self.inner.lock();
                    if let Some(s) = g.sessions.get_mut(&sid) {
                        s.watch = None;
                        if let Some(t) = s.tab.as_mut() {
                            t.screencast = false;
                        }
                    }
                }
                return;
            }
            _ => {}
        }
        drop(g);
        if notify {
            self.cv.notify_all();
        }
        if emit {
            self.emit_state();
        }
    }

    // -----------------------------------------------------------------------
    // Downloads: they land in <data>\agent-browser\downloads\<session>\<guid>; the user decides.
    // -----------------------------------------------------------------------

    fn on_download_begin(self: &Arc<Self>, gen: u64, p: &Value) {
        let guid = p["guid"].as_str().unwrap_or("").to_string();
        if guid.is_empty() || guid.contains(['/', '\\', '.']) {
            return;
        }
        let frame = p["frameId"].as_str().unwrap_or("");
        let url = p["url"].as_str().unwrap_or("").to_string();
        let name = sanitize_file_name(p["suggestedFilename"].as_str().unwrap_or("download"));
        let now = super::now_ms();
        let (sid, prompt_id) = {
            let mut g = self.inner.lock();
            let sid = g.by_target.get(frame).cloned().or_else(|| {
                // A subframe: the session whose agent acted last.
                g.sessions.iter().filter(|(_, s)| s.tab.is_some()).max_by_key(|(_, s)| s.last_action_at).map(|(id, _)| id.clone())
            });
            let Some(sid) = sid else { return };
            let context = g.sessions.get(&sid).and_then(|s| s.tab.as_ref()).map(|t| t.context_id.clone());
            let id = g.next_prompt;
            g.next_prompt += 1;
            let origin = url::Url::parse(&url).ok().map(|u| policy::origin_label(&u));
            g.prompts.insert(
                id,
                Prompt {
                    view: AgentBrowserPrompt {
                        id,
                        session_id: sid.clone(),
                        kind: PromptKind::Download,
                        origin,
                        detail: format!("Keep the downloaded file \"{name}\" ({})? It is saved in Gridkeeper's data folder and the agent is told where.", policy::log_url(&url)),
                        created_ms: now,
                        expires_ms: now + super::hub::CONFIRM_TIMEOUT.as_millis() as u64,
                        remember_host: None,
                    },
                    answer: None,
                },
            );
            g.downloads.insert(guid.clone(), Download { sid: sid.clone(), url: url.clone(), file_name: name.clone(), context_id: context, decision: None, completed: false, finished: false });
            (sid, id)
        };
        self.activity(&sid, "download", &format!("download started: {name} (waiting for the user)"), Some(policy::log_url(&url)), ActivityOutcome::Info);
        self.emit_state();
        let hub = Arc::clone(self);
        let _ = crate::pty::spawn_guarded("agent-browser-download".into(), move || {
            let answer = hub.wait_answer(prompt_id, &sid);
            let allow = matches!(answer, Some(super::hub::Answer::Allow { .. }));
            hub.emit_state();
            let (finish, cancel) = {
                let mut g = hub.inner.lock();
                match g.downloads.get_mut(&guid) {
                    Some(d) => {
                        d.decision = Some(allow);
                        (allow && d.completed, if allow { None } else { Some(d.context_id.clone()) })
                    }
                    None => (false, None),
                }
            };
            if let Some(ctx) = cancel {
                if let Some(c) = hub.browser_cdp(gen) {
                    let mut params = json!({ "guid": guid });
                    if let Some(ctx) = ctx {
                        params["browserContextId"] = Value::String(ctx);
                    }
                    let _ = c.send("Browser.cancelDownload", params, None);
                }
                hub.discard_download(&guid, if answer.is_none() { "no answer within 2 minutes" } else { "declined by the user" });
            } else if finish {
                hub.finish_download(&guid);
            }
        });
    }

    fn on_download_progress(self: &Arc<Self>, _gen: u64, p: &Value) {
        let guid = p["guid"].as_str().unwrap_or("").to_string();
        let state = p["state"].as_str().unwrap_or("");
        let action = {
            let mut g = self.inner.lock();
            let Some(d) = g.downloads.get_mut(&guid) else { return };
            match state {
                "completed" => {
                    d.completed = true;
                    d.decision
                }
                "canceled" => {
                    d.finished = true;
                    Some(false)
                }
                _ => return,
            }
        };
        match (state, action) {
            ("completed", Some(true)) => self.finish_download(&guid),
            ("completed", Some(false)) => self.discard_download(&guid, "declined by the user"),
            ("canceled", _) => self.discard_download(&guid, "canceled"),
            _ => {}
        }
    }

    fn download_paths(&self, guid: &str, d: &Download) -> (PathBuf, PathBuf) {
        let dir = self.downloads_dir(&d.sid);
        (dir.join(guid), dir)
    }

    fn finish_download(&self, guid: &str) {
        let Some(d) = self.inner.lock().downloads.remove(guid) else { return };
        let (from, dir) = self.download_paths(guid, &d);
        let mut target = dir.join(&d.file_name);
        let mut n = 1;
        while target.exists() && n < 1000 {
            let (stem, ext) = match d.file_name.rsplit_once('.') {
                Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
                _ => (d.file_name.clone(), String::new()),
            };
            target = dir.join(format!("{stem} ({n}){ext}"));
            n += 1;
        }
        let (msg, outcome) = match std::fs::rename(&from, &target) {
            Ok(()) => (format!("Downloaded \"{}\" (allowed by the user): {}", d.file_name, target.display()), ActivityOutcome::Ok),
            Err(e) => (format!("The download of \"{}\" was allowed but could not be saved ({e}).", d.file_name), ActivityOutcome::Error),
        };
        if let Some(s) = self.inner.lock().sessions.get_mut(&d.sid) {
            s.notice(msg.clone());
        }
        self.activity(&d.sid, "download", &msg, Some(policy::log_url(&d.url)), outcome);
    }

    fn discard_download(&self, guid: &str, why: &str) {
        let Some(d) = self.inner.lock().downloads.remove(guid) else { return };
        let (from, _) = self.download_paths(guid, &d);
        let _ = std::fs::remove_file(&from);
        let msg = format!("The download of \"{}\" was not kept ({why}).", d.file_name);
        if let Some(s) = self.inner.lock().sessions.get_mut(&d.sid) {
            s.notice(msg.clone());
        }
        self.activity(&d.sid, "download", &msg, Some(policy::log_url(&d.url)), ActivityOutcome::Denied);
    }
}

/// Text of one console argument (`Runtime.RemoteObject`).
fn remote_text(o: &Value) -> String {
    if let Some(v) = o.get("value") {
        return match v {
            Value::String(s) => s.clone(),
            other => other.to_string(),
        };
    }
    if let Some(u) = o.get("unserializableValue").and_then(Value::as_str) {
        return u.to_string();
    }
    o.get("description").and_then(Value::as_str).unwrap_or_else(|| o.get("type").and_then(Value::as_str).unwrap_or("?")).to_string()
}

fn location(frame: &Value) -> String {
    match frame["url"].as_str().filter(|u| !u.is_empty()) {
        Some(u) => format!(" ({}:{})", policy::log_url(u), frame["lineNumber"].as_i64().unwrap_or(0) + 1),
        None => String::new(),
    }
}
