//! Tool implementations (host side). Every tool acts on the calling session's own tab only; refs
//! come from the session's latest snapshot in Gridkeeper's isolated world.

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use super::hub::{CDP_TIMEOUT, Hub, TabRef};
use super::model::{ActivityOutcome, PromptKind};
use super::page::{self, KeySpec};
use super::policy;

/// Snapshot size returned by `browser_snapshot` / after actions.
const SNAPSHOT_FULL: usize = 40_000;
const SNAPSHOT_AFTER_ACTION: usize = 12_000;
const NAV_TIMEOUT: Duration = Duration::from_secs(20);
const ACTION_NAV_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_UPLOAD_FILES: usize = 20;
const MAX_WAIT_SECS: f64 = 30.0;
const MAX_SCREENSHOT_HEIGHT: f64 = 8000.0;

/// One tool's outcome: what the agent gets and what the activity log shows.
pub(crate) struct ToolOut {
    pub content: Vec<Value>,
    pub is_error: bool,
    pub summary: String,
    pub url: Option<String>,
    pub outcome: ActivityOutcome,
}

impl ToolOut {
    pub fn ok(text: impl Into<String>, summary: impl Into<String>) -> Self {
        Self { content: vec![json!({ "type": "text", "text": text.into() })], is_error: false, summary: summary.into(), url: None, outcome: ActivityOutcome::Ok }
    }
    pub fn error(msg: impl Into<String>) -> Self {
        let msg = msg.into();
        Self { content: vec![json!({ "type": "text", "text": msg.clone() })], is_error: true, summary: msg, url: None, outcome: ActivityOutcome::Error }
    }
    pub fn blocked(msg: impl Into<String>, summary: impl Into<String>) -> Self {
        Self { outcome: ActivityOutcome::Blocked, summary: summary.into(), ..Self::error(msg) }
    }
    pub fn denied(msg: impl Into<String>, summary: impl Into<String>) -> Self {
        Self { outcome: ActivityOutcome::Denied, summary: summary.into(), ..Self::error(msg) }
    }
    fn with_url(mut self, url: Option<String>) -> Self {
        self.url = url.map(|u| policy::log_url(&u));
        self
    }

    /// The MCP `tools/call` result, with pending notices first.
    pub fn into_result(self, notices: &[String]) -> Value {
        let mut content = Vec::with_capacity(self.content.len() + 1);
        if !notices.is_empty() {
            let text = format!("Notices from the browser:\n{}", notices.iter().map(|n| format!("- {n}")).collect::<Vec<_>>().join("\n"));
            content.push(json!({ "type": "text", "text": text }));
        }
        content.extend(self.content);
        json!({ "content": content, "isError": self.is_error })
    }
}

impl From<String> for ToolOut {
    fn from(msg: String) -> Self {
        ToolOut::error(msg)
    }
}

impl From<&str> for ToolOut {
    fn from(msg: &str) -> Self {
        ToolOut::error(msg)
    }
}

type Out = Result<ToolOut, ToolOut>;

fn arg_str<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key).and_then(Value::as_str)
}

fn need_str<'a>(args: &'a Value, key: &str) -> Result<&'a str, ToolOut> {
    arg_str(args, key).ok_or_else(|| ToolOut::error(format!("Missing argument \"{key}\".")))
}

fn need_ref(args: &Value) -> Result<String, ToolOut> {
    let r = need_str(args, "ref")?.trim();
    let r = r.strip_prefix("[ref=").and_then(|x| x.strip_suffix(']')).unwrap_or(r);
    let r = r.strip_prefix("ref=").unwrap_or(r);
    if r.is_empty() || r.len() > 32 || !r.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(ToolOut::error(format!("\"{r}\" is not a ref from browser_snapshot (expected something like e12).")));
    }
    Ok(r.to_string())
}

/// What the agent said it is acting on, else what the page says.
fn label(args: &Value, desc: Option<&str>) -> String {
    arg_str(args, "element").map(|e| policy::truncate(e.trim(), 80)).filter(|e| !e.is_empty()).or_else(|| desc.map(str::to_string)).unwrap_or_else(|| "element".into())
}

impl Hub {
    /// `browser_console_messages` / `browser_network_requests`: Gridkeeper's own rings, no page access.
    pub(crate) fn log_tool(&self, sid: &str, tool: &str, args: &Value) -> ToolOut {
        let g = self.inner.lock();
        let Some(tab) = g.sessions.get(sid).and_then(|s| s.tab.as_ref()) else {
            return ToolOut::ok("No tab is open yet (nothing logged). Use browser_navigate first.", format!("{tool}: no tab"));
        };
        if tool == "browser_console_messages" {
            let only_errors = args.get("onlyErrors").and_then(Value::as_bool).unwrap_or(false);
            let lines: Vec<String> = tab
                .console
                .iter()
                .filter(|e| !only_errors || e.level == "error" || e.level == "warning")
                .map(|e| format!("[{}] {}", e.level, e.text))
                .collect();
            let errors = tab.console.iter().filter(|e| e.level == "error").count();
            let text = if lines.is_empty() { "No console messages.".to_string() } else { lines.join("\n") };
            ToolOut::ok(text, format!("console: {} messages, {errors} errors", tab.console.len()))
        } else {
            let only_failed = args.get("onlyFailed").and_then(Value::as_bool).unwrap_or(false);
            let lines: Vec<String> = tab
                .network
                .iter()
                .filter(|e| !only_failed || e.failed.is_some() || e.status.is_some_and(|s| s >= 400))
                .map(|e| {
                    let status = match (&e.failed, e.status) {
                        (Some(f), _) => format!("FAILED {f}"),
                        (None, Some(s)) => s.to_string(),
                        (None, None) => "pending".into(),
                    };
                    format!("{} {} [{}] {}", e.method, e.url, e.kind, status)
                })
                .collect();
            let failed = tab.network.iter().filter(|e| e.failed.is_some() || e.status.is_some_and(|s| s >= 400)).count();
            let text = if lines.is_empty() { "No requests recorded.".to_string() } else { lines.join("\n") };
            ToolOut::ok(text, format!("network: {} requests, {failed} failed", tab.network.len()))
        }
    }

    pub(crate) fn run_tool(self: &Arc<Self>, sid: &str, tool: &str, args: &Value) -> Out {
        if tool == "browser_navigate" {
            // Refuse bad URLs before starting a browser for them.
            if let Err(e) = policy::navigable(arg_str(args, "url").unwrap_or("")) {
                return Err(ToolOut::blocked(e.clone(), format!("navigate refused: {e}")));
            }
        }
        let t = self.ensure_tab(sid)?;
        if tool != "browser_handle_dialog" {
            if let Some(d) = self.dialog_text(sid) {
                return Err(ToolOut::error(format!("A JavaScript dialog is open ({d}). Call browser_handle_dialog first.")));
            }
        }
        match tool {
            "browser_navigate" => self.tool_navigate(&t, args),
            "browser_navigate_back" => self.tool_back(&t),
            "browser_snapshot" => {
                let snap = self.snapshot_text(&t, SNAPSHOT_FULL)?;
                Ok(ToolOut::ok(snap.text, format!("snapshot ({} refs)", snap.refs)).with_url(Some(snap.url)))
            }
            "browser_click" => self.tool_click(&t, args),
            "browser_type" => self.tool_type(&t, args),
            "browser_press_key" => self.tool_press_key(&t, args),
            "browser_select_option" => self.tool_select(&t, args),
            "browser_hover" => self.tool_hover(&t, args),
            "browser_wait_for" => self.tool_wait_for(&t, args),
            "browser_take_screenshot" => self.tool_screenshot(&t, args),
            "browser_evaluate" => self.tool_evaluate(&t, args),
            "browser_file_upload" => self.tool_upload(&t, args),
            "browser_handle_dialog" => self.tool_dialog(&t, args),
            other => Err(ToolOut::error(format!("Unknown tool {other}."))),
        }
    }

    fn dialog_text(&self, sid: &str) -> Option<String> {
        let g = self.inner.lock();
        g.sessions.get(sid)?.tab.as_ref()?.dialog.as_ref().map(|d| format!("{}: \"{}\"", d.kind, policy::truncate(&d.message, 200)))
    }

    fn dialog_open(&self, sid: &str) -> bool {
        self.inner.lock().sessions.get(sid).and_then(|s| s.tab.as_ref()).is_some_and(|t| t.dialog.is_some())
    }

    /// A command on the tab; `Ok(None)` when a JavaScript dialog opened meanwhile (the reply would
    /// only come after the dialog is closed).
    fn tab_call(&self, t: &TabRef, method: &str, params: Value, timeout: Duration) -> Result<Option<Value>, String> {
        t.cdp.call_until(method, params, Some(&t.session), timeout, || self.dialog_open(&t.sid))
    }

    fn tab_call_value(&self, t: &TabRef, method: &str, params: Value) -> Result<Value, String> {
        self.tab_call(t, method, params, CDP_TIMEOUT)?.ok_or_else(|| "A JavaScript dialog opened; call browser_handle_dialog.".to_string())
    }

    fn world(&self, t: &TabRef) -> Result<i64, String> {
        if let Some(w) = self.inner.lock().sessions.get(&t.sid).and_then(|s| s.tab.as_ref()).filter(|tab| tab.generation == t.generation).and_then(|tab| tab.world) {
            return Ok(w);
        }
        let r = self.tab_call_value(t, "Page.createIsolatedWorld", json!({ "frameId": t.target, "worldName": page::WORLD_NAME }))?;
        let id = r.get("executionContextId").and_then(Value::as_i64).ok_or("the browser returned no isolated world")?;
        if let Some(tab) = self.inner.lock().sessions.get_mut(&t.sid).and_then(|s| s.tab.as_mut()).filter(|tab| tab.generation == t.generation) {
            tab.world = Some(id);
        }
        Ok(id)
    }

    fn clear_world(&self, t: &TabRef) {
        if let Some(tab) = self.inner.lock().sessions.get_mut(&t.sid).and_then(|s| s.tab.as_mut()) {
            tab.world = None;
        }
    }

    /// Run a `page.js` op in the isolated world (by value).
    fn page_op(&self, t: &TabRef, op: &str, args: Value) -> Result<Value, String> {
        let expr = page::op_expression(op, &args);
        for attempt in 0..2 {
            let ctx = self.world(t)?;
            let r = self.tab_call_value(t, "Runtime.evaluate", json!({ "expression": expr, "contextId": ctx, "returnByValue": true, "userGesture": true }));
            match r {
                Err(e) if attempt == 0 && e.to_ascii_lowercase().contains("context") => {
                    self.clear_world(t);
                    continue;
                }
                Err(e) => return Err(e),
                Ok(v) => {
                    if let Some(d) = v.get("exceptionDetails") {
                        return Err(page::exception_text(d));
                    }
                    return Ok(v.pointer("/result/value").cloned().unwrap_or(Value::Null));
                }
            }
        }
        Err("the page's script context was not available".into())
    }

    fn nav_counter(&self, t: &TabRef) -> u64 {
        self.inner.lock().sessions.get(&t.sid).and_then(|s| s.tab.as_ref()).map(|tab| tab.nav_started).unwrap_or(0)
    }

    /// Wait until a navigation that started after `since` finished loading (or `timeout`). When no
    /// start is seen within `START_GRACE` (about:blank, a same-document change) and nothing is loading,
    /// that counts as done.
    fn wait_loaded(&self, t: &TabRef, since: u64, require_start: bool, timeout: Duration) -> bool {
        const START_GRACE: Duration = Duration::from_millis(1500);
        let begin = Instant::now();
        let deadline = begin + timeout;
        let grace_end = begin + START_GRACE.min(timeout);
        let mut g = self.inner.lock();
        loop {
            let Some(tab) = g.sessions.get(&t.sid).and_then(|s| s.tab.as_ref()).filter(|tab| tab.generation == t.generation) else { return false };
            if tab.dialog.is_some() {
                return true;
            }
            let started = tab.nav_started > since;
            let now = Instant::now();
            if !tab.loading && (started || !require_start || now >= grace_end) {
                return true;
            }
            if now >= deadline {
                return false;
            }
            let until = if !started && !tab.loading && require_start { grace_end.min(deadline) } else { deadline };
            let _ = self.cv.wait_until(&mut g, until);
        }
    }

    /// After an input action: if it started a navigation, wait for the load.
    fn settle_after_action(&self, t: &TabRef, since: u64) {
        std::thread::sleep(Duration::from_millis(150));
        if self.nav_counter(t) > since {
            self.wait_loaded(t, since, true, ACTION_NAV_TIMEOUT);
        }
        std::thread::sleep(Duration::from_millis(100));
    }

    pub(crate) fn navigate_and_wait(&self, t: &TabRef, url: &str) -> Result<bool, String> {
        let since = self.nav_counter(t);
        let r = self.tab_call_value(t, "Page.navigate", json!({ "url": url }))?;
        if let Some(err) = r.get("errorText").and_then(Value::as_str).filter(|e| !e.is_empty()) {
            return Err(format!("Navigation failed: {err}"));
        }
        if r.get("loaderId").is_none() {
            return Ok(true); // same-document navigation
        }
        Ok(self.wait_loaded(t, since, true, NAV_TIMEOUT))
    }

    fn snapshot_text(&self, t: &TabRef, max: usize) -> Result<Snapshot, String> {
        let v = self.page_op(t, "snapshot", json!({ "maxChars": max }))?;
        let url = v.get("url").and_then(Value::as_str).unwrap_or("").to_string();
        let title = v.get("title").and_then(Value::as_str).unwrap_or("").to_string();
        let body = v.get("text").and_then(Value::as_str).unwrap_or("");
        let refs = v.get("refs").and_then(Value::as_u64).unwrap_or(0);
        let text = format!("Page URL: {url}\nPage title: {title}\nSnapshot:\n{}", if body.is_empty() { "- (empty page)" } else { body });
        Ok(Snapshot { text, url, refs })
    }

    /// Result text after an action: the outcome line + the page snapshot.
    fn after_action(&self, t: &TabRef, line: String, summary: String) -> Out {
        if let Some(d) = self.dialog_text(&t.sid) {
            return Ok(ToolOut::ok(format!("{line}\nA JavaScript dialog opened ({d}). Call browser_handle_dialog to continue."), summary));
        }
        match self.snapshot_text(t, SNAPSHOT_AFTER_ACTION) {
            Ok(s) => Ok(ToolOut::ok(format!("{line}\n\n{}", s.text), summary).with_url(Some(s.url))),
            Err(e) => Ok(ToolOut::ok(format!("{line}\n(No snapshot: {e})"), summary)),
        }
    }

    /// Whether actions on `page_url` (and, for a form, its target) need the user's confirmation.
    fn needs_confirm(&self, page_url: &str, form_action: Option<&str>) -> Option<(url::Url, String)> {
        let allow = self.allowlist();
        let ports = Arc::clone(&self.dev_ports);
        let check = |u: &url::Url| policy::origin_allowed(u, &allow, || ports());
        let page = url::Url::parse(page_url).ok()?;
        if !check(&page) {
            return Some((page.clone(), policy::origin_label(&page)));
        }
        if let Some(action) = form_action.and_then(|a| url::Url::parse(a).ok()) {
            if matches!(action.scheme(), "http" | "https") && !check(&action) {
                return Some((action.clone(), policy::origin_label(&action)));
            }
        }
        None
    }

    fn confirm_form(&self, t: &TabRef, page_url: &str, form: Option<&Value>, how: &str) -> Result<(), ToolOut> {
        let action = form.and_then(|f| f.get("action")).and_then(Value::as_str);
        let Some((u, origin)) = self.needs_confirm(page_url, action) else { return Ok(()) };
        let method = form.and_then(|f| f.get("method")).and_then(Value::as_str).unwrap_or("get").to_ascii_uppercase();
        let detail = format!(
            "Submit a form on {} by {how}.\nForm target: {method} {}",
            policy::origin_label(&url::Url::parse(page_url).unwrap_or(u.clone())),
            action.map(policy::log_url).unwrap_or_else(|| "(same page)".into())
        );
        self.activity(&t.sid, "confirm", &format!("asking the user: submit a form on {origin}"), Some(policy::log_url(page_url)), ActivityOutcome::Info);
        self.confirm(&t.sid, PromptKind::FormSubmit, Some(origin.clone()), detail, policy::allow_entry_for(&u))
            .map_err(|e| ToolOut::denied(format!("{e} (form submission on {origin})"), format!("form submission on {origin} not allowed")))
    }

    // -----------------------------------------------------------------------
    // Tools
    // -----------------------------------------------------------------------

    fn tool_navigate(&self, t: &TabRef, args: &Value) -> Out {
        let u = policy::navigable(need_str(args, "url")?).map_err(|e| ToolOut::blocked(e.clone(), format!("navigate refused: {e}")))?;
        let loaded = self.navigate_and_wait(t, u.as_str())?;
        let line = if loaded { format!("Navigated to {u}") } else { format!("Navigated to {u} (still loading after {} s)", NAV_TIMEOUT.as_secs()) };
        self.after_action(t, line, format!("navigate {}", policy::log_url(u.as_str())))
    }

    fn tool_back(&self, t: &TabRef) -> Out {
        let h = self.tab_call_value(t, "Page.getNavigationHistory", json!({}))?;
        let idx = h.get("currentIndex").and_then(Value::as_i64).unwrap_or(0);
        let entries = h.get("entries").and_then(Value::as_array).cloned().unwrap_or_default();
        if idx <= 0 {
            return Err(ToolOut::error("There is no previous page in this tab's history."));
        }
        let Some(entry) = entries.get((idx - 1) as usize) else { return Err(ToolOut::error("History entry not found.")) };
        let since = self.nav_counter(t);
        self.tab_call_value(t, "Page.navigateToHistoryEntry", json!({ "entryId": entry.get("id") }))?;
        self.wait_loaded(t, since, true, NAV_TIMEOUT);
        self.after_action(t, "Went back.".into(), "go back".into())
    }

    fn click_at(&self, t: &TabRef, x: f64, y: f64, button: &str, double: bool) -> Result<(), String> {
        let send = |kind: &str, count: u32| -> Result<(), String> {
            let mut p = json!({ "type": kind, "x": x, "y": y, "button": button, "clickCount": count });
            if kind == "mouseMoved" {
                p = json!({ "type": kind, "x": x, "y": y });
            }
            self.tab_call(t, "Input.dispatchMouseEvent", p, Duration::from_secs(10)).map(|_| ())
        };
        send("mouseMoved", 0)?;
        send("mousePressed", 1)?;
        send("mouseReleased", 1)?;
        if double && !self.dialog_open(&t.sid) {
            send("mousePressed", 2)?;
            send("mouseReleased", 2)?;
        }
        Ok(())
    }

    fn tool_click(&self, t: &TabRef, args: &Value) -> Out {
        let r = need_ref(args)?;
        let pt = self.page_op(t, "point", json!({ "ref": r }))?;
        let desc = pt.get("desc").and_then(Value::as_str);
        let what = label(args, desc);
        if let Some(cover) = pt.get("covered").and_then(Value::as_str) {
            return Err(ToolOut::error(format!(
                "{what} is covered by {cover} at its center, so a click would hit that instead. Close the overlay (or scroll) and take a new snapshot."
            )));
        }
        let page_url = pt.get("page").and_then(Value::as_str).unwrap_or("").to_string();
        if pt.get("submit").and_then(Value::as_bool) == Some(true) {
            self.confirm_form(t, &page_url, pt.get("form"), &format!("clicking {what}"))?;
        }
        let x = pt.get("x").and_then(Value::as_f64).unwrap_or(0.0);
        let y = pt.get("y").and_then(Value::as_f64).unwrap_or(0.0);
        let button = match arg_str(args, "button") {
            Some(b @ ("left" | "right" | "middle")) => b,
            _ => "left",
        };
        let double = args.get("doubleClick").and_then(Value::as_bool).unwrap_or(false);
        let since = self.nav_counter(t);
        self.click_at(t, x, y, button, double)?;
        self.settle_after_action(t, since);
        let verb = if double { "Double-clicked" } else { "Clicked" };
        self.after_action(t, format!("{verb} {what}."), format!("{} {what}", verb.to_ascii_lowercase()))
            .map(|o| o.with_url(Some(page_url)))
    }

    fn press(&self, t: &TabRef, k: &KeySpec) -> Result<(), String> {
        let mods = page::modifier_keys(k.modifiers);
        let mut held = 0u32;
        for (key, code, kc, bit) in &mods {
            held |= bit;
            self.tab_call(t, "Input.dispatchKeyEvent", json!({ "type": "rawKeyDown", "key": key, "code": code, "windowsVirtualKeyCode": kc, "modifiers": held }), Duration::from_secs(10))?;
        }
        let mut down = json!({ "type": if k.text.is_some() { "keyDown" } else { "rawKeyDown" }, "key": k.key, "code": k.code, "windowsVirtualKeyCode": k.key_code, "modifiers": k.modifiers });
        if let Some(text) = &k.text {
            down["text"] = json!(text);
            down["unmodifiedText"] = json!(text);
        }
        self.tab_call(t, "Input.dispatchKeyEvent", down, Duration::from_secs(10))?;
        if !self.dialog_open(&t.sid) {
            self.tab_call(t, "Input.dispatchKeyEvent", json!({ "type": "keyUp", "key": k.key, "code": k.code, "windowsVirtualKeyCode": k.key_code, "modifiers": k.modifiers }), Duration::from_secs(10))?;
        }
        for (key, code, kc, bit) in mods.iter().rev() {
            held &= !bit;
            let _ = t.cdp.send("Input.dispatchKeyEvent", json!({ "type": "keyUp", "key": key, "code": code, "windowsVirtualKeyCode": kc, "modifiers": held }), Some(&t.session));
        }
        Ok(())
    }

    fn tool_type(&self, t: &TabRef, args: &Value) -> Out {
        let r = need_ref(args)?;
        let text = need_str(args, "text")?.to_string();
        if text.len() > 100_000 {
            return Err(ToolOut::error("The text is too long (over 100 000 characters)."));
        }
        let submit = args.get("submit").and_then(Value::as_bool).unwrap_or(false);
        let info = self.page_op(t, "focus", json!({ "ref": r }))?;
        let what = label(args, info.get("desc").and_then(Value::as_str));
        let password = info.get("password").and_then(Value::as_bool) == Some(true);
        let page_url = info.get("page").and_then(Value::as_str).unwrap_or("").to_string();
        if text.is_empty() {
            if info.get("hadValue").and_then(Value::as_bool) == Some(true) {
                self.press(t, &page::key_spec("Backspace")?)?;
            }
        } else {
            self.tab_call(t, "Input.insertText", json!({ "text": text }), CDP_TIMEOUT)?;
        }
        let shown = if password {
            format!("{} characters (password field)", text.chars().count())
        } else {
            format!("\"{}\"", policy::truncate(&text, 40))
        };
        let mut summary = format!("type {shown} into {what}");
        let mut line = format!("Typed {} into {what}.", if password { format!("{} characters", text.chars().count()) } else { format!("\"{}\"", policy::truncate(&text, 200)) });
        if submit {
            let form = info.get("form").filter(|f| !f.is_null());
            if form.is_some() {
                if let Err(denied) = self.confirm_form(t, &page_url, form, &format!("pressing Enter in {what}")) {
                    return Err(ToolOut { summary: format!("{summary}; submit not allowed"), ..denied });
                }
            }
            let since = self.nav_counter(t);
            self.press(t, &page::key_spec("Enter")?)?;
            self.settle_after_action(t, since);
            summary.push_str(" + Enter");
            line.push_str(" Pressed Enter.");
        }
        self.after_action(t, line, summary).map(|o| o.with_url(Some(page_url)))
    }

    fn tool_press_key(&self, t: &TabRef, args: &Value) -> Out {
        let combo = need_str(args, "key")?;
        let k = page::key_spec(combo)?;
        let mut page_url = String::new();
        if k.key == "Enter" {
            let a = self.page_op(t, "active", json!({}))?;
            page_url = a.get("page").and_then(Value::as_str).unwrap_or("").to_string();
            let in_form = a.get("form").is_some_and(|f| !f.is_null());
            let multiline = a.get("multiline").and_then(Value::as_bool) == Some(true);
            if in_form && !multiline {
                let what = a.get("desc").and_then(Value::as_str).unwrap_or("the focused field").to_string();
                self.confirm_form(t, &page_url, a.get("form"), &format!("pressing Enter in {what}"))?;
            }
        }
        let since = self.nav_counter(t);
        self.press(t, &k)?;
        self.settle_after_action(t, since);
        self.after_action(t, format!("Pressed {combo}."), format!("press {combo}")).map(|o| o.with_url((!page_url.is_empty()).then_some(page_url)))
    }

    fn tool_select(&self, t: &TabRef, args: &Value) -> Out {
        let r = need_ref(args)?;
        let values: Vec<String> = args
            .get("values")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
            .unwrap_or_default();
        if values.is_empty() {
            return Err(ToolOut::error("Give at least one value in \"values\"."));
        }
        let res = self.page_op(t, "select", json!({ "ref": r, "values": values }))?;
        let what = label(args, res.get("desc").and_then(Value::as_str));
        let picked = res.get("selected").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(", ")).unwrap_or_default();
        std::thread::sleep(Duration::from_millis(100));
        self.after_action(t, format!("Selected {picked} in {what}."), format!("select {} in {what}", policy::truncate(&picked, 60)))
    }

    fn tool_hover(&self, t: &TabRef, args: &Value) -> Out {
        let r = need_ref(args)?;
        let pt = self.page_op(t, "point", json!({ "ref": r }))?;
        let what = label(args, pt.get("desc").and_then(Value::as_str));
        let x = pt.get("x").and_then(Value::as_f64).unwrap_or(0.0);
        let y = pt.get("y").and_then(Value::as_f64).unwrap_or(0.0);
        self.tab_call(t, "Input.dispatchMouseEvent", json!({ "type": "mouseMoved", "x": x, "y": y }), Duration::from_secs(10))?;
        std::thread::sleep(Duration::from_millis(200));
        self.after_action(t, format!("Hovering over {what}."), format!("hover {what}"))
    }

    fn tool_wait_for(&self, t: &TabRef, args: &Value) -> Out {
        let text = arg_str(args, "text").filter(|s| !s.is_empty());
        let gone = arg_str(args, "textGone").filter(|s| !s.is_empty());
        let secs = args.get("time").and_then(Value::as_f64).unwrap_or(if text.is_some() || gone.is_some() { MAX_WAIT_SECS } else { 1.0 });
        let limit = Duration::from_secs_f64(secs.clamp(0.0, MAX_WAIT_SECS));
        let deadline = Instant::now() + limit;
        if text.is_none() && gone.is_none() {
            std::thread::sleep(limit);
            return Ok(ToolOut::ok(format!("Waited {:.1} s.", limit.as_secs_f64()), format!("wait {:.1} s", limit.as_secs_f64())));
        }
        loop {
            let has = |s: &str| self.page_op(t, "hasText", json!({ "text": s })).map(|v| v.as_bool() == Some(true));
            let ok_text = match text {
                Some(s) => has(s)?,
                None => true,
            };
            let ok_gone = match gone {
                Some(s) => !has(s)?,
                None => true,
            };
            if ok_text && ok_gone {
                let what = text.map(|s| format!("\"{}\" appeared", policy::truncate(s, 60))).into_iter().chain(gone.map(|s| format!("\"{}\" disappeared", policy::truncate(s, 60)))).collect::<Vec<_>>().join(" and ");
                return self.after_action(t, format!("Done: {what}."), format!("wait: {what}"));
            }
            if Instant::now() >= deadline {
                return Err(ToolOut::error(format!("Timed out after {:.0} s waiting for the text condition.", limit.as_secs_f64())));
            }
            std::thread::sleep(Duration::from_millis(250));
        }
    }

    fn tool_screenshot(&self, t: &TabRef, args: &Value) -> Out {
        let full = args.get("fullPage").and_then(Value::as_bool).unwrap_or(false);
        let mut params = json!({ "format": "png" });
        if full {
            let m = self.tab_call_value(t, "Page.getLayoutMetrics", json!({}))?;
            let size = m.get("cssContentSize").or_else(|| m.get("contentSize")).cloned().unwrap_or(Value::Null);
            let w = size.get("width").and_then(Value::as_f64).unwrap_or(1280.0).min(4000.0);
            let h = size.get("height").and_then(Value::as_f64).unwrap_or(800.0).min(MAX_SCREENSHOT_HEIGHT);
            params = json!({ "format": "png", "captureBeyondViewport": true, "clip": { "x": 0, "y": 0, "width": w, "height": h, "scale": 1 } });
        }
        let mut shot = self.tab_call_value(t, "Page.captureScreenshot", params.clone())?;
        let mut mime = "image/png";
        if shot.get("data").and_then(Value::as_str).is_some_and(|d| d.len() > 3_000_000) {
            params["format"] = json!("jpeg");
            params["quality"] = json!(70);
            shot = self.tab_call_value(t, "Page.captureScreenshot", params)?;
            mime = "image/jpeg";
        }
        let data = shot.get("data").and_then(Value::as_str).ok_or("the browser returned no image")?.to_string();
        let url = self.inner.lock().sessions.get(&t.sid).and_then(|s| s.last_url.clone());
        Ok(ToolOut {
            content: vec![
                json!({ "type": "text", "text": format!("Screenshot of {}{}", url.as_deref().map(policy::log_url).unwrap_or_else(|| "the tab".into()), if full { " (full page)" } else { "" }) }),
                json!({ "type": "image", "data": data, "mimeType": mime }),
            ],
            is_error: false,
            summary: if full { "screenshot (full page)".into() } else { "screenshot".into() },
            url,
            outcome: ActivityOutcome::Ok,
        })
    }

    fn tool_evaluate(&self, t: &TabRef, args: &Value) -> Out {
        let src = arg_str(args, "function").or_else(|| arg_str(args, "expression")).ok_or_else(|| ToolOut::error("Missing argument \"function\"."))?;
        if src.len() > 50_000 {
            return Err(ToolOut::error("The script is too long."));
        }
        let page_url = self.page_op(t, "active", json!({}))?.get("page").and_then(Value::as_str).unwrap_or("").to_string();
        let preview = policy::truncate(&src.split_whitespace().collect::<Vec<_>>().join(" "), 80);
        if let Some((u, origin)) = self.needs_confirm(&page_url, None) {
            self.activity(&t.sid, "confirm", &format!("asking the user: run a script on {origin}"), Some(policy::log_url(&page_url)), ActivityOutcome::Info);
            let detail = format!("Run this script on {origin}:\n{}", policy::truncate(src, 600));
            self.confirm(&t.sid, PromptKind::Script, Some(origin.clone()), detail, policy::allow_entry_for(&u))
                .map_err(|e| ToolOut::denied(format!("{e} (script on {origin})"), format!("script on {origin} not allowed")))?;
        }
        let r = self
            .tab_call(t, "Runtime.evaluate", json!({ "expression": page::eval_expression(src), "returnByValue": true, "awaitPromise": true, "userGesture": true }), CDP_TIMEOUT)?
            .ok_or_else(|| ToolOut::error("A JavaScript dialog opened while the script ran; call browser_handle_dialog."))?;
        if let Some(d) = r.get("exceptionDetails") {
            return Err(ToolOut::error(format!("The script threw: {}", page::exception_text(d))));
        }
        let res = r.get("result").cloned().unwrap_or(Value::Null);
        let value = res.get("value").cloned().or_else(|| res.get("unserializableValue").cloned()).or_else(|| res.get("description").cloned()).unwrap_or(Value::Null);
        Ok(ToolOut::ok(format!("Result:\n{}", page::value_text(&value, 20_000)), format!("evaluate: {preview}")).with_url(Some(page_url)))
    }

    fn tool_upload(&self, t: &TabRef, args: &Value) -> Out {
        let r = need_ref(args)?;
        let paths: Vec<String> = args.get("paths").and_then(Value::as_array).map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect()).unwrap_or_default();
        if paths.is_empty() || paths.len() > MAX_UPLOAD_FILES {
            return Err(ToolOut::error(format!("Give 1 to {MAX_UPLOAD_FILES} absolute file paths in \"paths\".")));
        }
        let mut lines = Vec::new();
        for p in &paths {
            let path = std::path::Path::new(p);
            if !path.is_absolute() {
                return Err(ToolOut::error(format!("{p} is not an absolute path.")));
            }
            let meta = std::fs::metadata(path).map_err(|e| ToolOut::error(format!("{p}: {e}")))?;
            if !meta.is_file() {
                return Err(ToolOut::error(format!("{p} is not a file.")));
            }
            lines.push(format!("{p} ({} KB)", meta.len().div_ceil(1024)));
        }
        let pt = self.page_op(t, "describe", json!({ "ref": r }))?;
        let what = label(args, pt.as_str());
        let page_url = self.page_op(t, "active", json!({}))?.get("page").and_then(Value::as_str).unwrap_or("").to_string();
        let origin = url::Url::parse(&page_url).map(|u| policy::origin_label(&u)).unwrap_or_else(|_| "the page".into());
        self.activity(&t.sid, "confirm", &format!("asking the user: upload {} file(s) to {origin}", paths.len()), Some(policy::log_url(&page_url)), ActivityOutcome::Info);
        let detail = format!("Give {} file(s) to {origin} through {what}:\n{}", paths.len(), lines.join("\n"));
        self.confirm(&t.sid, PromptKind::Upload, Some(origin.clone()), detail, None)
            .map_err(|e| ToolOut::denied(format!("{e} (upload)"), format!("upload to {origin} not allowed")))?;
        let ctx = self.world(t)?;
        let obj = self.tab_call_value(t, "Runtime.evaluate", json!({ "expression": page::file_input_expression(&r), "contextId": ctx, "returnByValue": false }))?;
        if let Some(d) = obj.get("exceptionDetails") {
            return Err(ToolOut::error(page::exception_text(d)));
        }
        let object_id = obj.pointer("/result/objectId").and_then(Value::as_str).ok_or("the file input is not available")?.to_string();
        self.tab_call_value(t, "DOM.setFileInputFiles", json!({ "files": paths, "objectId": object_id }))?;
        let _ = self.tab_call(t, "Runtime.releaseObject", json!({ "objectId": object_id }), Duration::from_secs(5));
        let names: Vec<String> = paths.iter().map(|p| std::path::Path::new(p).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()).collect();
        self.after_action(t, format!("Set {} file(s) on {what}: {}", paths.len(), names.join(", ")), format!("upload {} to {origin}", policy::truncate(&names.join(", "), 80)))
    }

    fn tool_dialog(&self, t: &TabRef, args: &Value) -> Out {
        let accept = args.get("accept").and_then(Value::as_bool).ok_or_else(|| ToolOut::error("Missing argument \"accept\"."))?;
        let Some(d) = self.dialog_text(&t.sid) else { return Err(ToolOut::error("No JavaScript dialog is open.")) };
        let mut p = json!({ "accept": accept });
        if let Some(text) = arg_str(args, "promptText") {
            p["promptText"] = json!(text);
        }
        t.cdp.call("Page.handleJavaScriptDialog", p, Some(&t.session), CDP_TIMEOUT)?;
        if let Some(tab) = self.inner.lock().sessions.get_mut(&t.sid).and_then(|s| s.tab.as_mut()) {
            tab.dialog = None;
        }
        self.cv.notify_all();
        let since = self.nav_counter(t);
        self.settle_after_action(t, since);
        let verb = if accept { "Accepted" } else { "Dismissed" };
        self.after_action(t, format!("{verb} the dialog ({d})."), format!("{} dialog", verb.to_ascii_lowercase()))
    }
}

struct Snapshot {
    text: String,
    url: String,
    refs: u64,
}
