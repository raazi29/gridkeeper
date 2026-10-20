//! Chrome DevTools Protocol over `--remote-debugging-pipe`: NUL-terminated JSON messages, one pipe in
//! each direction (Chromium `devtools_pipe_handler.cc`). Flat sessions (`sessionId` on the message).
//!
//! One reader thread per browser parses frames: responses complete the waiting [`Cdp::call`],
//! events go to the `on_event` callback (which must not block: the hub forwards them to its event
//! thread). Plain OS threads and blocking calls with timeouts, like the rest of the host (ADR-008).

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, mpsc};
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde_json::{Value, json};

/// Messages larger than this are dropped (Chromium's own receive buffer is 100 MiB).
pub const MAX_MESSAGE: usize = 96 * 1024 * 1024;
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, PartialEq)]
pub struct CdpEvent {
    pub method: String,
    pub params: Value,
    pub session_id: Option<String>,
}

pub type EventFn = Box<dyn Fn(CdpEvent) + Send + Sync>;
pub type CloseFn = Box<dyn FnOnce() + Send>;

type Reply = Result<Value, String>;

pub struct Cdp {
    writer: Mutex<Box<dyn Write + Send>>,
    next_id: AtomicU64,
    pending: Mutex<HashMap<u64, mpsc::Sender<Reply>>>,
    closed: AtomicBool,
}

/// Split complete NUL-terminated frames out of `buf` (+ `data`). An oversized partial frame is
/// discarded up to its terminator (`skipping`).
pub fn split_frames(buf: &mut Vec<u8>, skipping: &mut bool, data: &[u8], out: &mut Vec<Vec<u8>>) {
    let mut rest = data;
    while let Some(i) = rest.iter().position(|&b| b == 0) {
        if *skipping {
            *skipping = false;
            buf.clear();
        } else {
            buf.extend_from_slice(&rest[..i]);
            out.push(std::mem::take(buf));
        }
        rest = &rest[i + 1..];
    }
    if *skipping {
        return;
    }
    buf.extend_from_slice(rest);
    if buf.len() > MAX_MESSAGE {
        buf.clear();
        *skipping = true;
    }
}

impl Cdp {
    /// Start the reader thread. `on_close` runs once when the browser side closes the pipe.
    pub fn start(reader: Box<dyn Read + Send>, writer: Box<dyn Write + Send>, on_event: EventFn, on_close: CloseFn) -> std::io::Result<Arc<Self>> {
        let cdp = Arc::new(Self {
            writer: Mutex::new(writer),
            next_id: AtomicU64::new(1),
            pending: Mutex::new(HashMap::new()),
            closed: AtomicBool::new(false),
        });
        let weak = Arc::downgrade(&cdp);
        crate::pty::spawn_guarded("agent-browser-cdp".into(), move || {
            read_loop(reader, &weak, &on_event);
            if let Some(c) = weak.upgrade() {
                c.mark_closed();
            }
            on_close();
        })?;
        Ok(cdp)
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Acquire)
    }

    fn mark_closed(&self) {
        self.closed.store(true, Ordering::Release);
        let waiters: Vec<_> = self.pending.lock().drain().collect();
        for (_, tx) in waiters {
            let _ = tx.send(Err("the browser connection closed".into()));
        }
    }

    fn write_message(&self, msg: &Value) -> Result<(), String> {
        if self.is_closed() {
            return Err("the browser is not running".into());
        }
        let mut bytes = serde_json::to_vec(msg).map_err(|e| e.to_string())?;
        bytes.push(0);
        let res = {
            let mut w = self.writer.lock();
            w.write_all(&bytes).and_then(|()| w.flush())
        };
        res.map_err(|e| {
            self.mark_closed();
            format!("could not write to the browser: {e}")
        })
    }

    fn message(id: u64, method: &str, params: Value, session: Option<&str>) -> Value {
        let mut m = json!({ "id": id, "method": method, "params": params });
        if let Some(s) = session {
            m["sessionId"] = Value::String(s.to_string());
        }
        m
    }

    /// Send a command and wait for its result.
    pub fn call(&self, method: &str, params: Value, session: Option<&str>, timeout: Duration) -> Result<Value, String> {
        self.call_until(method, params, session, timeout, || false).map(|r| r.unwrap_or(Value::Null))
    }

    /// Like [`call`](Self::call), but gives up early (`Ok(None)`) as soon as `abort()` returns true
    /// (checked every 50 ms): for input that may open a JavaScript dialog, which blocks the reply
    /// until the dialog is closed.
    pub fn call_until(
        &self,
        method: &str,
        params: Value,
        session: Option<&str>,
        timeout: Duration,
        abort: impl Fn() -> bool,
    ) -> Result<Option<Value>, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::channel();
        self.pending.lock().insert(id, tx);
        if let Err(e) = self.write_message(&Self::message(id, method, params, session)) {
            self.pending.lock().remove(&id);
            return Err(e);
        }
        let deadline = Instant::now() + timeout;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                self.pending.lock().remove(&id);
                return Err(format!("{method} timed out after {} s", timeout.as_secs()));
            }
            match rx.recv_timeout(left.min(Duration::from_millis(50))) {
                Ok(Ok(v)) => return Ok(Some(v)),
                Ok(Err(e)) => return Err(e),
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if abort() {
                        self.pending.lock().remove(&id);
                        return Ok(None);
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => return Err("the browser connection closed".into()),
            }
        }
    }

    /// Fire and forget (screencast acks, input during take-over, closing popups).
    pub fn send(&self, method: &str, params: Value, session: Option<&str>) -> Result<(), String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        self.write_message(&Self::message(id, method, params, session))
    }

    fn deliver(&self, msg: Value, on_event: &EventFn) {
        if let Some(id) = msg.get("id").and_then(Value::as_u64) {
            let Some(tx) = self.pending.lock().remove(&id) else { return };
            let reply = match msg.get("error") {
                Some(err) => Err(err.get("message").and_then(Value::as_str).unwrap_or("CDP error").to_string()),
                None => Ok(msg.get("result").cloned().unwrap_or(Value::Null)),
            };
            let _ = tx.send(reply);
        } else if let Some(method) = msg.get("method").and_then(Value::as_str) {
            let ev = CdpEvent {
                method: method.to_string(),
                params: msg.get("params").cloned().unwrap_or(Value::Null),
                session_id: msg.get("sessionId").and_then(Value::as_str).map(str::to_string),
            };
            on_event(ev);
        }
    }
}

fn read_loop(mut reader: Box<dyn Read + Send>, weak: &std::sync::Weak<Cdp>, on_event: &EventFn) {
    let mut chunk = vec![0u8; 64 * 1024];
    let mut buf = Vec::new();
    let mut skipping = false;
    let mut frames = Vec::new();
    loop {
        let n = match reader.read(&mut chunk) {
            Ok(0) => return,
            Ok(n) => n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => return,
        };
        split_frames(&mut buf, &mut skipping, &chunk[..n], &mut frames);
        if frames.is_empty() {
            continue;
        }
        let Some(cdp) = weak.upgrade() else { return };
        for f in frames.drain(..) {
            match serde_json::from_slice::<Value>(&f) {
                Ok(msg) => cdp.deliver(msg, on_event),
                Err(e) => tracing::debug!(error = %e, "unparseable CDP message"),
            }
        }
    }
}
