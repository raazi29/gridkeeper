//! MCP helper mode: `gridkeeper --gk-mcp-browser --session <id> --endpoint <name>` (token in
//! `GK_AGENT_BROWSER_TOKEN`), started by the agent CLI as a stdio MCP server.
//!
//! `main.rs` dispatches here before anything Tauri-related (no window, no logging, no state). The
//! helper never talks to the browser: it lists the tools and forwards each `tools/call` to the
//! Gridkeeper host over the per-user pipe / socket (`ipc`), on its own thread and connection, so a
//! call that waits for the user never blocks `ping` or other calls.
//!
//! Protocol: newline-delimited JSON-RPC on stdin / stdout, nothing else on stdout. Dual-era:
//! - legacy revisions (2025-11-25 and earlier): `initialize` (the requested version is echoed when
//!   supported), `notifications/initialized`, `ping`, `tools/list`, `tools/call`;
//! - modern revisions (2026-07-28): `server/discover`, the protocol version in every request's
//!   `_meta` (`-32022` when unsupported), `resultType: "complete"` on results.
//!
//! Exits when stdin closes.

use std::collections::HashSet;
use std::ffi::OsStr;
use std::io::{self, BufRead, Write};
use std::sync::Arc;

use parking_lot::Mutex;
use serde_json::{Value, json};

use super::ipc::{self, Request, RequestKind};
use super::tools;

pub const SESSION_FLAG: &str = "--session";
pub const ENDPOINT_FLAG: &str = "--endpoint";
/// Supported MCP revisions, newest first.
pub const SUPPORTED_VERSIONS: &[&str] = &["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
/// Newest revision that uses the `initialize` handshake.
pub const LATEST_LEGACY: &str = "2025-11-25";
const META_VERSION: &str = "io.modelcontextprotocol/protocolVersion";

pub fn is_invocation(arg1: Option<&OsStr>) -> bool {
    arg1.is_some_and(|a| a == super::HELPER_FLAG)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HelperArgs {
    pub session: String,
    pub endpoint: String,
}

pub fn parse_args(args: &[String]) -> Result<HelperArgs, String> {
    let (mut session, mut endpoint) = (None, None);
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            SESSION_FLAG => session = Some(it.next().ok_or("--session needs a value")?.clone()),
            ENDPOINT_FLAG => endpoint = Some(it.next().ok_or("--endpoint needs a value")?.clone()),
            other => return Err(format!("unknown argument {other:?}")),
        }
    }
    let session = session.ok_or("--session is required")?;
    if !super::valid_session_id(&session) {
        return Err("invalid --session".into());
    }
    let endpoint = endpoint.filter(|e| !e.is_empty() && e.len() < 512).ok_or("--endpoint is required")?;
    Ok(HelperArgs { session, endpoint })
}

/// Where tool calls go (the host in production, a fake in tests).
pub trait Backend: Send + Sync {
    /// Forward one call; `Err` = the host could not be reached / refused.
    fn call(&self, tool: &str, args: &Value) -> Result<Value, String>;
}

/// Talks to the Gridkeeper host.
pub struct HostBackend {
    pub endpoint: String,
    pub session: String,
    pub token: String,
}

impl HostBackend {
    fn request(&self, kind: RequestKind, tool: Option<&str>, args: Value) -> Request {
        Request { v: ipc::PROTOCOL_VERSION, session: self.session.clone(), token: self.token.clone(), kind, tool: tool.map(str::to_string), args }
    }

    /// Keep a presence connection open for the helper's lifetime (best effort, one attempt).
    pub fn hold_presence(self: &Arc<Self>) {
        let me = Arc::clone(self);
        let _ = std::thread::Builder::new().name("gk-presence".into()).spawn(move || {
            let Ok(conn) = ipc::connect_retry(&me.endpoint) else { return };
            match conn.exchange(&me.request(RequestKind::Presence, None, Value::Null)) {
                Ok(r) if r.ok => {
                    // Block until the host goes away (or the process exits).
                    let mut sink = [0u8; 64];
                    let mut c = &conn;
                    while matches!(io::Read::read(&mut c, &mut sink), Ok(n) if n > 0) {}
                }
                _ => {}
            }
        });
    }
}

impl Backend for HostBackend {
    fn call(&self, tool: &str, args: &Value) -> Result<Value, String> {
        let conn = ipc::connect_retry(&self.endpoint)
            .map_err(|e| format!("Gridkeeper's agent browser is not reachable ({e}). Is Gridkeeper still running?"))?;
        let resp = conn
            .exchange(&self.request(RequestKind::Call, Some(tool), args.clone()))
            .map_err(|e| format!("Lost the connection to Gridkeeper ({e})."))?;
        if resp.ok {
            resp.result.ok_or_else(|| "Gridkeeper returned no result.".to_string())
        } else {
            Err(resp.error.unwrap_or_else(|| "Gridkeeper refused the call.".into()))
        }
    }
}

/// `main()` entry: runs the helper when argv[1] is the helper flag; returns its exit code.
pub fn main_from_env() -> Option<i32> {
    let mut args = std::env::args_os();
    let _exe = args.next();
    let first = args.next();
    if !is_invocation(first.as_deref()) {
        return None;
    }
    let rest: Vec<String> = args.map(|a| a.to_string_lossy().into_owned()).collect();
    let parsed = match parse_args(&rest) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("gridkeeper --gk-mcp-browser: {e}");
            return Some(2);
        }
    };
    let token = std::env::var(super::TOKEN_ENV).unwrap_or_default();
    let backend = Arc::new(HostBackend { endpoint: parsed.endpoint, session: parsed.session, token });
    backend.hold_presence();
    let stdin = io::stdin();
    let out: Arc<Mutex<Box<dyn Write + Send>>> = Arc::new(Mutex::new(Box::new(io::stdout())));
    serve(&mut stdin.lock(), &out, backend);
    Some(0)
}

/// The JSON-RPC loop. Returns at EOF.
pub fn serve(input: &mut dyn BufRead, out: &Arc<Mutex<Box<dyn Write + Send>>>, backend: Arc<dyn Backend>) {
    let server = Server { out: Arc::clone(out), backend, cancelled: Arc::new(Mutex::new(HashSet::new())) };
    loop {
        let line = match ipc::read_line_capped(input, ipc::MAX_LINE) {
            Ok(Some(l)) => l,
            Ok(None) => return,
            Err(e) if e.kind() == io::ErrorKind::InvalidData => {
                server.write(&error(Value::Null, -32700, "message too large or not UTF-8", None));
                continue;
            }
            Err(_) => return,
        };
        if line.trim().is_empty() {
            continue;
        }
        server.handle_line(&line);
    }
}

struct Server {
    out: Arc<Mutex<Box<dyn Write + Send>>>,
    backend: Arc<dyn Backend>,
    cancelled: Arc<Mutex<HashSet<String>>>,
}

fn error(id: Value, code: i64, message: &str, data: Option<Value>) -> Value {
    let mut e = json!({ "code": code, "message": message });
    if let Some(d) = data {
        e["data"] = d;
    }
    json!({ "jsonrpc": "2.0", "id": id, "error": e })
}

fn result(id: Value, mut res: Value, modern: bool) -> Value {
    if modern && res.is_object() {
        res["resultType"] = Value::String("complete".into());
    }
    json!({ "jsonrpc": "2.0", "id": id, "result": res })
}

fn server_info() -> Value {
    json!({ "name": "gridkeeper-browser", "title": "Gridkeeper agent browser", "version": env!("CARGO_PKG_VERSION") })
}

impl Server {
    fn write(&self, msg: &Value) {
        let mut line = msg.to_string();
        line.push('\n');
        let mut out = self.out.lock();
        let _ = out.write_all(line.as_bytes()).and_then(|()| out.flush());
    }

    fn handle_line(&self, line: &str) {
        let msg: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => return self.write(&error(Value::Null, -32700, "parse error", None)),
        };
        if msg.is_array() {
            return self.write(&error(Value::Null, -32600, "batches are not supported", None));
        }
        let Some(method) = msg.get("method").and_then(Value::as_str) else {
            return; // a response to something we never sent: ignore
        };
        let id = msg.get("id").cloned();
        let params = msg.get("params").cloned().unwrap_or(Value::Null);
        let Some(id) = id.filter(|i| !i.is_null()) else {
            // Notifications.
            if method == "notifications/cancelled" {
                if let Some(rid) = params.get("requestId") {
                    self.cancelled.lock().insert(rid.to_string());
                }
            }
            return;
        };
        // Modern requests carry the protocol version in _meta.
        let meta_version = params.get("_meta").and_then(|m| m.get(META_VERSION)).and_then(Value::as_str).map(str::to_string);
        if let Some(v) = &meta_version {
            if !SUPPORTED_VERSIONS.contains(&v.as_str()) {
                return self.write(&error(
                    id,
                    -32022,
                    "Unsupported protocol version",
                    Some(json!({ "supported": SUPPORTED_VERSIONS, "requested": v })),
                ));
            }
        }
        let modern = meta_version.is_some();
        match method {
            "initialize" => {
                let requested = params.get("protocolVersion").and_then(Value::as_str).unwrap_or(LATEST_LEGACY);
                let version = if SUPPORTED_VERSIONS.contains(&requested) && requested != SUPPORTED_VERSIONS[0] { requested } else { LATEST_LEGACY };
                self.write(&result(
                    id,
                    json!({
                        "protocolVersion": version,
                        "capabilities": { "tools": { "listChanged": false } },
                        "serverInfo": server_info(),
                        "instructions": tools::INSTRUCTIONS,
                    }),
                    false,
                ));
            }
            "server/discover" => self.write(&json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": {
                    "resultType": "complete",
                    "supportedVersions": SUPPORTED_VERSIONS,
                    "capabilities": { "tools": {} },
                    "instructions": tools::INSTRUCTIONS,
                    "_meta": { "io.modelcontextprotocol/serverInfo": server_info() },
                }
            })),
            "ping" => self.write(&result(id, json!({}), modern)),
            "tools/list" => self.write(&result(id, json!({ "tools": tools::tool_list() }), modern)),
            "tools/call" => self.call(id, params, modern),
            _ => self.write(&error(id, -32601, &format!("method not found: {method}"), None)),
        }
    }

    fn call(&self, id: Value, params: Value, modern: bool) {
        let Some(name) = params.get("name").and_then(Value::as_str).map(str::to_string) else {
            return self.write(&error(id, -32602, "tools/call needs a tool name", None));
        };
        if !tools::tool_names().contains(&name) {
            return self.write(&error(id, -32602, &format!("unknown tool: {name}"), None));
        }
        let args = match params.get("arguments") {
            None | Some(Value::Null) => json!({}),
            Some(a @ Value::Object(_)) => a.clone(),
            Some(_) => return self.write(&error(id, -32602, "arguments must be an object", None)),
        };
        let out = Arc::clone(&self.out);
        let backend = Arc::clone(&self.backend);
        let cancelled = Arc::clone(&self.cancelled);
        let spawned = std::thread::Builder::new().name("gk-tool-call".into()).spawn(move || {
            let res = match backend.call(&name, &args) {
                Ok(r) => r,
                Err(e) => tools::text_result(e, true),
            };
            if cancelled.lock().remove(&id.to_string()) {
                return;
            }
            let server = Server { out, backend, cancelled };
            server.write(&result(id, res, modern));
        });
        if spawned.is_err() {
            self.write(&error(Value::Null, -32603, "could not start a worker thread", None));
        }
    }
}
