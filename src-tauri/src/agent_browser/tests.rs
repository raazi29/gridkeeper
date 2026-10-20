//! Agent browser tests: policy, config, launch injection, transport, CDP framing, MCP protocol,
//! page helpers, tab routing / take-over / confirmations / lifecycle on a hub without a browser, and
//! one `#[ignore]` live test that starts the real browser headless through the tool path.

use std::io::{BufReader, Cursor};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde_json::{Value, json};

use super::cdp::{self, Cdp, CdpEvent};
use super::config::Config;
use super::hub::{Hub, HubOptions, JanitorRow, UiEvent, plan_janitor};
use super::ipc::{self, Request, RequestKind};
use super::launch::{self, Injection};
use super::mcp::{self, Backend};
use super::model::{ActivityOutcome, PromptKind};
use super::{chrome, page, policy, tools};

// ---------------------------------------------------------------------------
// policy
// ---------------------------------------------------------------------------

#[test]
fn navigable_allows_http_https_about_blank_only() {
    assert_eq!(policy::navigable("http://localhost:5173/").unwrap().as_str(), "http://localhost:5173/");
    assert_eq!(policy::navigable("localhost:3000/x").unwrap().as_str(), "http://localhost:3000/x");
    assert_eq!(policy::navigable("https://example.com").unwrap().as_str(), "https://example.com/");
    assert_eq!(policy::navigable("about:blank").unwrap().as_str(), "about:blank");
    for bad in ["file:///C:/Windows/win.ini", "javascript:alert(1)", "chrome://settings", "edge://flags", "data:text/html,hi", "about:config", "", "http://user:pw@example.com/", "ftp://x"] {
        assert!(policy::navigable(bad).is_err(), "{bad} must be refused");
    }
    assert!(policy::navigable(&format!("http://a.com/{}", "x".repeat(9000))).is_err());
}

#[test]
fn allowlist_entries_normalize() {
    assert_eq!(policy::normalize_entry("Example.COM").as_deref(), Some("example.com"));
    assert_eq!(policy::normalize_entry("https://staging.example.com:8443/path?q=1").as_deref(), Some("staging.example.com:8443"));
    assert_eq!(policy::normalize_entry("*.example.com").as_deref(), Some("*.example.com"));
    assert_eq!(policy::normalize_entry("[::1]:8080").as_deref(), Some("[::1]:8080"));
    assert_eq!(policy::normalize_entry("192.168.1.5:5173").as_deref(), Some("192.168.1.5:5173"));
    for bad in ["", "*.192.168.1.5", "a b.com", "*.*.com", "user@host.com", "*"] {
        assert!(policy::normalize_entry(bad).is_none(), "{bad:?} must be invalid");
    }
    let list = policy::normalize_allowlist(&["a.com".into(), "A.com".into(), "bad entry".into(), "b.com:81".into()]);
    assert_eq!(list, vec!["a.com".to_string(), "b.com:81".to_string()]);
}

#[test]
fn origin_allowed_loopback_allowlist_and_dev_ports() {
    let u = |s: &str| url::Url::parse(s).unwrap();
    let none: Vec<String> = Vec::new();
    let no_ports = || -> Vec<u16> { panic!("dev ports must not be looked up for this host") };
    assert!(policy::origin_allowed(&u("http://localhost:5173/"), &none, no_ports));
    assert!(policy::origin_allowed(&u("http://app.localhost/"), &none, no_ports));
    assert!(policy::origin_allowed(&u("http://127.0.0.1:8080/"), &none, no_ports));
    assert!(policy::origin_allowed(&u("http://127.3.4.5/"), &none, no_ports));
    assert!(policy::origin_allowed(&u("http://[::1]:3000/"), &none, no_ports));
    assert!(policy::origin_allowed(&u("about:blank"), &none, no_ports));
    assert!(!policy::origin_allowed(&u("https://example.com/"), &none, no_ports));

    let allow = vec!["*.example.com".to_string(), "api.test:8443".to_string()];
    assert!(policy::origin_allowed(&u("https://example.com/"), &allow, no_ports));
    assert!(policy::origin_allowed(&u("https://a.b.example.com/"), &allow, no_ports));
    assert!(!policy::origin_allowed(&u("https://badexample.com/"), &allow, no_ports));
    assert!(policy::origin_allowed(&u("https://api.test:8443/"), &allow, no_ports));
    assert!(!policy::origin_allowed(&u("https://api.test/"), &allow, no_ports));

    // A private address on a dev-server port of a session.
    assert!(policy::origin_allowed(&u("http://192.168.1.5:5173/"), &none, || vec![5173]));
    assert!(!policy::origin_allowed(&u("http://192.168.1.5:9999/"), &none, || vec![5173]));
    assert!(!policy::origin_allowed(&u("http://8.8.8.8:5173/"), &none, || vec![5173]));
}

#[test]
fn log_url_drops_query_and_fragment() {
    assert_eq!(policy::log_url("https://example.com/cb?code=SECRET#frag"), "https://example.com/cb");
    assert_eq!(policy::allow_entry_for(&url::Url::parse("https://x.example.com:8443/a").unwrap()).as_deref(), Some("x.example.com:8443"));
    assert_eq!(policy::allow_entry_for(&url::Url::parse("https://x.example.com/a").unwrap()).as_deref(), Some("x.example.com"));
}

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

#[test]
fn config_roundtrip_sanitize_and_prune() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("config.json");
    assert_eq!(Config::load(&path), Config::default());
    std::fs::write(&path, "{ not json").unwrap();
    assert_eq!(Config::load(&path), Config::default());

    let mut c = Config::default();
    assert!(c.set_session("s1", true));
    assert!(!c.set_session("s1", true));
    assert!(!c.set_session("bad id!", true));
    assert!(c.set_session("s2", true));
    assert!(c.allow("Example.com"));
    assert!(!c.allow("example.com"));
    c.idle_minutes = 0;
    c.save(&path).unwrap();
    let back = Config::load(&path);
    assert_eq!(back.sessions, vec!["s1".to_string(), "s2".to_string()]);
    assert_eq!(back.allowlist, vec!["example.com".to_string()]);
    assert_eq!(back.idle_minutes, 1, "clamped");

    let mut c = back;
    assert_eq!(c.prune(&["s2".to_string()]), 1);
    assert!(!c.enabled("s1"));
    assert!(c.enabled("s2"));
    assert!(c.set_session("s2", false));
    assert!(!c.enabled("s2"));
}

// ---------------------------------------------------------------------------
// launch injection
// ---------------------------------------------------------------------------

fn inj<'a>(exe: &'a std::path::Path, token: &'a str) -> Injection<'a> {
    Injection { exe, session_id: "sess-1", endpoint: "gridkeeper-ab-1-abcd", token }
}

#[test]
fn claude_injection_is_one_equals_form_flag_and_a_server_entry() {
    let exe = std::path::PathBuf::from(r"C:\Program Files\Gridkeeper\gridkeeper.exe");
    let j: Value = serde_json::from_str(&launch::claude_mcp_json(&inj(&exe, "tok"))).unwrap();
    let s = &j["mcpServers"][super::SERVER_NAME];
    assert_eq!(s["type"], "stdio");
    assert_eq!(s["command"], exe.to_string_lossy().as_ref());
    assert_eq!(s["args"], json!(["--gk-mcp-browser", "--session", "sess-1", "--endpoint", "gridkeeper-ab-1-abcd"]));
    assert_eq!(s["env"][super::TOKEN_ENV], "tok");
    assert_eq!(j["mcpServers"].as_object().unwrap().len(), 1, "only our server; the user's servers come from their own config");
    let args = launch::claude_args(std::path::Path::new(r"C:\data\agent-browser\mcp-sess-1.json"));
    assert_eq!(args, vec![r"--mcp-config=C:\data\agent-browser\mcp-sess-1.json".to_string()]);
    assert!(!args.iter().any(|a| a == "--strict-mcp-config"));
}

#[test]
fn codex_injection_uses_toml_literal_overrides() {
    let exe = std::path::PathBuf::from(r"C:\Users\Jo Doe\Gridkeeper\gridkeeper.exe");
    let args = launch::codex_args(&inj(&exe, "t0k"), true).unwrap();
    assert_eq!(args.len(), 10);
    assert!(args.iter().step_by(2).all(|a| a == "-c"));
    assert_eq!(args[1], r"mcp_servers.gk-browser.command='C:\Users\Jo Doe\Gridkeeper\gridkeeper.exe'");
    assert_eq!(args[3], "mcp_servers.gk-browser.args=['--gk-mcp-browser','--session','sess-1','--endpoint','gridkeeper-ab-1-abcd']");
    assert_eq!(args[5], "mcp_servers.gk-browser.env.GK_AGENT_BROWSER_TOKEN='t0k'");
    assert_eq!(args[7], "mcp_servers.gk-browser.startup_timeout_sec=20");
    assert_eq!(args[9], "mcp_servers.gk-browser.tool_timeout_sec=600");
    assert!(crate::adapters::discovery::validate_cmd_args(&args).is_ok(), "passes the codex.cmd shim");

    // A quote in the path: a basic string natively, refused through the shim.
    let odd = std::path::PathBuf::from(r"C:\it's\gk.exe");
    assert!(launch::codex_args(&inj(&odd, "t"), true).is_err());
    let native = launch::codex_args(&inj(&odd, "t"), false).unwrap();
    assert_eq!(native[1], r#"mcp_servers.gk-browser.command="C:\\it's\\gk.exe""#);
}

#[test]
fn toml_string_escapes() {
    assert_eq!(launch::toml_string("a b", true).as_deref(), Some("'a b'"));
    assert_eq!(launch::toml_string("it's", true), None);
    assert_eq!(launch::toml_string("it's \"x\"\n", false).as_deref(), Some("\"it's \\\"x\\\"\\u000A\""));
}

// ---------------------------------------------------------------------------
// transport
// ---------------------------------------------------------------------------

#[test]
fn read_line_capped_and_ct_eq() {
    let mut r = BufReader::new(Cursor::new(b"one\r\ntwo\nthree".to_vec()));
    assert_eq!(ipc::read_line_capped(&mut r, 100).unwrap().as_deref(), Some("one"));
    assert_eq!(ipc::read_line_capped(&mut r, 100).unwrap().as_deref(), Some("two"));
    assert_eq!(ipc::read_line_capped(&mut r, 100).unwrap().as_deref(), Some("three"));
    assert_eq!(ipc::read_line_capped(&mut r, 100).unwrap(), None);
    let mut big = BufReader::new(Cursor::new(vec![b'x'; 300]));
    assert!(ipc::read_line_capped(&mut big, 100).is_err());
    assert!(ipc::ct_eq("abc", "abc"));
    assert!(!ipc::ct_eq("abc", "abd"));
    assert!(!ipc::ct_eq("abc", "abcd"));
    let t = ipc::new_token();
    assert_eq!(t.len(), 64);
    assert_ne!(t, ipc::new_token());
}

#[test]
fn endpoint_roundtrip_reports_peer_pid() {
    let dir = tempfile::tempdir().unwrap();
    let endpoint = ipc::new_endpoint(dir.path()).unwrap();
    let seen: Arc<Mutex<Vec<Option<u32>>>> = Arc::new(Mutex::new(Vec::new()));
    let seen2 = Arc::clone(&seen);
    let handler: ipc::Handler = Arc::new(move |conn: ipc::Conn| {
        seen2.lock().push(conn.peer_pid);
        let mut r = BufReader::new(&conn);
        let line = ipc::read_line_capped(&mut r, 1024).unwrap().unwrap();
        let req: Request = serde_json::from_str(&line).unwrap();
        let mut w = &conn;
        ipc::write_json_line(&mut w, &ipc::Response::ok(Some(json!({ "echo": req.tool })))).unwrap();
    });
    let mut server = ipc::serve(&endpoint, handler).unwrap();
    for i in 0..3 {
        let conn = ipc::connect_retry(&endpoint).unwrap();
        let resp = conn
            .exchange(&Request { v: 1, session: "s".into(), token: "t".into(), kind: RequestKind::Call, tool: Some(format!("tool{i}")), args: Value::Null })
            .unwrap();
        assert_eq!(resp.result.unwrap()["echo"], format!("tool{i}"));
    }
    server.stop();
    let pids = seen.lock().clone();
    assert!(pids.len() >= 3);
    #[cfg(any(windows, target_os = "linux", target_os = "macos"))]
    assert!(pids.iter().take(3).all(|p| *p == Some(std::process::id())), "{pids:?}");
}

#[cfg(windows)]
#[test]
fn pipe_name_cannot_be_created_twice() {
    let dir = tempfile::tempdir().unwrap();
    let endpoint = ipc::new_endpoint(dir.path()).unwrap();
    let h: ipc::Handler = Arc::new(|_c| {});
    let _first = ipc::serve(&endpoint, Arc::clone(&h)).unwrap();
    assert!(ipc::serve(&endpoint, h).is_err(), "FILE_FLAG_FIRST_PIPE_INSTANCE refuses a second server");
}

// ---------------------------------------------------------------------------
// CDP
// ---------------------------------------------------------------------------

#[test]
fn split_frames_handles_partial_and_oversized() {
    let mut buf = Vec::new();
    let mut skipping = false;
    let mut out = Vec::new();
    cdp::split_frames(&mut buf, &mut skipping, b"{\"a\":1}\0{\"b\"", &mut out);
    assert_eq!(out, vec![b"{\"a\":1}".to_vec()]);
    out.clear();
    cdp::split_frames(&mut buf, &mut skipping, b":2}\0\0", &mut out);
    assert_eq!(out, vec![b"{\"b\":2}".to_vec(), Vec::new()]);
    out.clear();
    let huge = vec![b'x'; cdp::MAX_MESSAGE + 10];
    cdp::split_frames(&mut buf, &mut skipping, &huge, &mut out);
    assert!(skipping && buf.is_empty() && out.is_empty());
    cdp::split_frames(&mut buf, &mut skipping, b"tail\0{\"c\":3}\0", &mut out);
    assert_eq!(out, vec![b"{\"c\":3}".to_vec()]);
}

/// A fake browser on two in-process pipes: answers every command with `{"echo": method}`, and sends
/// one event per command.
fn fake_browser() -> (Arc<Cdp>, Arc<Mutex<Vec<CdpEvent>>>, std::sync::mpsc::Receiver<()>) {
    use std::io::{Read, Write};
    let (to_browser_r, to_browser_w) = std::io::pipe().unwrap();
    let (from_browser_r, mut from_browser_w) = std::io::pipe().unwrap();
    std::thread::spawn(move || {
        let mut r = to_browser_r;
        let mut buf = Vec::new();
        let mut skipping = false;
        let mut chunk = [0u8; 4096];
        let mut frames = Vec::new();
        loop {
            let n = match r.read(&mut chunk) {
                Ok(0) | Err(_) => return,
                Ok(n) => n,
            };
            cdp::split_frames(&mut buf, &mut skipping, &chunk[..n], &mut frames);
            for f in frames.drain(..) {
                let msg: Value = serde_json::from_slice(&f).unwrap();
                let method = msg["method"].as_str().unwrap().to_string();
                if method == "Test.hang" {
                    continue;
                }
                if method == "Test.close" {
                    return;
                }
                let mut ev = json!({ "method": "Test.event", "params": { "for": method } });
                if let Some(s) = msg.get("sessionId") {
                    ev["sessionId"] = s.clone();
                }
                let reply = if method == "Test.fail" {
                    json!({ "id": msg["id"], "error": { "code": -32000, "message": "nope" } })
                } else {
                    json!({ "id": msg["id"], "result": { "echo": method } })
                };
                for m in [ev, reply] {
                    let mut b = serde_json::to_vec(&m).unwrap();
                    b.push(0);
                    if from_browser_w.write_all(&b).is_err() {
                        return;
                    }
                }
            }
        }
    });
    let events: Arc<Mutex<Vec<CdpEvent>>> = Arc::new(Mutex::new(Vec::new()));
    let ev2 = Arc::clone(&events);
    let (closed_tx, closed_rx) = std::sync::mpsc::channel();
    let cdp = Cdp::start(
        Box::new(from_browser_r),
        Box::new(to_browser_w),
        Box::new(move |e| ev2.lock().push(e)),
        Box::new(move || {
            let _ = closed_tx.send(());
        }),
    )
    .unwrap();
    (cdp, events, closed_rx)
}

#[test]
fn cdp_calls_events_errors_timeouts_and_close() {
    let (cdp, events, closed) = fake_browser();
    let r = cdp.call("Page.enable", json!({}), Some("S1"), Duration::from_secs(5)).unwrap();
    assert_eq!(r["echo"], "Page.enable");
    assert_eq!(cdp.call("Test.fail", json!({}), None, Duration::from_secs(5)).unwrap_err(), "nope");
    let t = Instant::now();
    assert!(cdp.call("Test.hang", json!({}), None, Duration::from_millis(200)).unwrap_err().contains("timed out"));
    assert!(t.elapsed() < Duration::from_secs(3));
    // abort() ends the wait early (a dialog opened).
    assert_eq!(cdp.call_until("Test.hang", json!({}), None, Duration::from_secs(10), || true).unwrap(), None);
    let deadline = Instant::now() + Duration::from_secs(3);
    while events.lock().len() < 2 && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    let evs = events.lock().clone();
    assert_eq!(evs[0].method, "Test.event");
    assert_eq!(evs[0].session_id.as_deref(), Some("S1"));
    assert_eq!(evs[0].params["for"], "Page.enable");
    let _ = cdp.send("Test.close", json!({}), None);
    closed.recv_timeout(Duration::from_secs(5)).expect("on_close runs when the browser side closes");
    assert!(cdp.is_closed());
    assert!(cdp.call("Page.enable", json!({}), None, Duration::from_secs(1)).is_err());
}

// ---------------------------------------------------------------------------
// MCP helper protocol
// ---------------------------------------------------------------------------

struct FakeBackend(Mutex<Vec<(String, Value)>>);

impl Backend for FakeBackend {
    fn call(&self, tool: &str, args: &Value) -> Result<Value, String> {
        self.0.lock().push((tool.to_string(), args.clone()));
        if tool == "browser_snapshot" { Err("host down".into()) } else { Ok(tools::text_result(format!("did {tool}"), false)) }
    }
}

struct SharedBuf(Arc<Mutex<Vec<u8>>>);
impl std::io::Write for SharedBuf {
    fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
        self.0.lock().extend_from_slice(b);
        Ok(b.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn run_mcp(lines: &[Value], expect: usize) -> (Vec<Value>, Arc<FakeBackend>) {
    let input: String = lines.iter().map(|l| format!("{l}\n")).collect();
    let buf = Arc::new(Mutex::new(Vec::new()));
    let out: Arc<Mutex<Box<dyn std::io::Write + Send>>> = Arc::new(Mutex::new(Box::new(SharedBuf(Arc::clone(&buf)))));
    let backend = Arc::new(FakeBackend(Mutex::new(Vec::new())));
    mcp::serve(&mut BufReader::new(Cursor::new(input.into_bytes())), &out, backend.clone());
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let text = String::from_utf8(buf.lock().clone()).unwrap();
        let msgs: Vec<Value> = text.lines().map(|l| serde_json::from_str(l).unwrap()).collect();
        if msgs.len() >= expect || Instant::now() > deadline {
            return (msgs, backend);
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn by_id(msgs: &[Value], id: i64) -> Value {
    msgs.iter().find(|m| m["id"] == json!(id)).cloned().unwrap_or_else(|| panic!("no response {id}: {msgs:?}"))
}

#[test]
fn mcp_legacy_handshake_list_and_call() {
    let (msgs, backend) = run_mcp(
        &[
            json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}),
            json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
            json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}),
            json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"browser_navigate","arguments":{"url":"http://localhost:5173"}}}),
            json!({"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"no_such_tool","arguments":{}}}),
            json!({"jsonrpc":"2.0","id":5,"method":"ping"}),
            json!({"jsonrpc":"2.0","id":6,"method":"resources/list"}),
            json!({"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"browser_snapshot"}}),
        ],
        7,
    );
    let init = by_id(&msgs, 1);
    assert_eq!(init["result"]["protocolVersion"], "2025-06-18", "a supported requested version is echoed");
    assert!(init["result"]["capabilities"]["tools"].is_object());
    assert!(init["result"]["instructions"].as_str().unwrap().contains("untrusted"));
    let names: Vec<String> = by_id(&msgs, 2)["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap().to_string()).collect();
    for n in ["browser_navigate", "browser_snapshot", "browser_click", "browser_type", "browser_console_messages", "browser_network_requests", "browser_take_screenshot", "browser_file_upload"] {
        assert!(names.contains(&n.to_string()), "{n}");
    }
    assert_eq!(by_id(&msgs, 3)["result"]["content"][0]["text"], "did browser_navigate");
    assert!(by_id(&msgs, 3)["result"].get("resultType").is_none(), "legacy results have no resultType");
    assert_eq!(by_id(&msgs, 4)["error"]["code"], -32602);
    assert_eq!(by_id(&msgs, 5)["result"], json!({}));
    assert_eq!(by_id(&msgs, 6)["error"]["code"], -32601);
    let failed = by_id(&msgs, 7);
    assert_eq!(failed["result"]["isError"], true, "a host failure is a tool error, not a protocol error");
    assert_eq!(backend.0.lock()[0], ("browser_navigate".to_string(), json!({"url":"http://localhost:5173"})));
}

#[test]
fn mcp_initialize_with_unknown_version_answers_latest_legacy() {
    let (msgs, _) = run_mcp(&[json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"1999-01-01"}})], 1);
    assert_eq!(by_id(&msgs, 1)["result"]["protocolVersion"], mcp::LATEST_LEGACY);
}

#[test]
fn mcp_modern_discover_meta_and_result_type() {
    let meta = json!({ "io.modelcontextprotocol/protocolVersion": "2026-07-28" });
    let (msgs, _) = run_mcp(
        &[
            json!({"jsonrpc":"2.0","id":1,"method":"server/discover","params":{"_meta": meta}}),
            json!({"jsonrpc":"2.0","id":2,"method":"tools/list","params":{"_meta": meta}}),
            json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"_meta": meta, "name":"browser_take_screenshot","arguments":{}}}),
            json!({"jsonrpc":"2.0","id":4,"method":"tools/list","params":{"_meta": {"io.modelcontextprotocol/protocolVersion":"2099-01-01"}}}),
        ],
        4,
    );
    let d = by_id(&msgs, 1)["result"].clone();
    assert_eq!(d["resultType"], "complete");
    assert!(d["supportedVersions"].as_array().unwrap().contains(&json!("2026-07-28")));
    assert_eq!(d["_meta"]["io.modelcontextprotocol/serverInfo"]["name"], "gridkeeper-browser");
    assert_eq!(by_id(&msgs, 2)["result"]["resultType"], "complete");
    assert_eq!(by_id(&msgs, 3)["result"]["resultType"], "complete");
    let e = by_id(&msgs, 4)["error"].clone();
    assert_eq!(e["code"], -32022);
    assert_eq!(e["data"]["requested"], "2099-01-01");
}

#[test]
fn mcp_bad_input_and_args() {
    let input = "not json\n[1,2]\n{\"jsonrpc\":\"2.0\",\"id\":9,\"method\":\"tools/call\",\"params\":{\"name\":\"browser_click\",\"arguments\":[1]}}\n";
    let buf = Arc::new(Mutex::new(Vec::new()));
    let out: Arc<Mutex<Box<dyn std::io::Write + Send>>> = Arc::new(Mutex::new(Box::new(SharedBuf(Arc::clone(&buf)))));
    mcp::serve(&mut BufReader::new(Cursor::new(input.as_bytes().to_vec())), &out, Arc::new(FakeBackend(Mutex::new(Vec::new()))));
    let text = String::from_utf8(buf.lock().clone()).unwrap();
    let msgs: Vec<Value> = text.lines().map(|l| serde_json::from_str(l).unwrap()).collect();
    assert_eq!(msgs[0]["error"]["code"], -32700);
    assert_eq!(msgs[1]["error"]["code"], -32600);
    assert_eq!(msgs[2]["error"]["code"], -32602);
    assert!(text.lines().all(|l| !l.is_empty()), "only JSON-RPC lines on stdout");
}

#[test]
fn helper_args_parse() {
    let a = mcp::parse_args(&["--session".into(), "abc".into(), "--endpoint".into(), "gridkeeper-ab-1-x".into()]).unwrap();
    assert_eq!((a.session.as_str(), a.endpoint.as_str()), ("abc", "gridkeeper-ab-1-x"));
    assert!(mcp::parse_args(&["--session".into(), "a b".into(), "--endpoint".into(), "x".into()]).is_err());
    assert!(mcp::parse_args(&["--session".into(), "abc".into()]).is_err());
    assert!(mcp::parse_args(&["--bogus".into()]).is_err());
    assert!(mcp::is_invocation(Some(std::ffi::OsStr::new("--gk-mcp-browser"))));
    assert!(!mcp::is_invocation(Some(std::ffi::OsStr::new("--gk-statusline"))));
}

#[test]
fn tool_annotations_mark_read_only_tools() {
    for t in tools::tool_list() {
        let name = t["name"].as_str().unwrap();
        assert_eq!(t["annotations"]["readOnlyHint"].as_bool().unwrap(), tools::is_read_only(name), "{name}");
        assert_eq!(t["inputSchema"]["type"], "object");
        assert!(name.len() <= 40);
    }
}

// ---------------------------------------------------------------------------
// page helpers / chrome
// ---------------------------------------------------------------------------

#[test]
fn key_specs() {
    let k = page::key_spec("Enter").unwrap();
    assert_eq!((k.key.as_str(), k.key_code, k.text.as_deref()), ("Enter", 13, Some("\r")));
    let k = page::key_spec("Control+a").unwrap();
    assert_eq!((k.key.as_str(), k.code.as_str(), k.modifiers, k.text), ("a", "KeyA", page::MOD_CTRL, None));
    let k = page::key_spec("Shift+Tab").unwrap();
    assert_eq!((k.key.as_str(), k.modifiers), ("Tab", page::MOD_SHIFT));
    let k = page::key_spec("Shift+a").unwrap();
    assert_eq!(k.text.as_deref(), Some("A"));
    assert_eq!(page::key_spec("+").unwrap().key, "+");
    assert_eq!(page::key_spec("Control++").unwrap().key, "+");
    assert!(page::key_spec("Hyper+x").is_err());
    assert!(page::key_spec("NotAKey").is_err());
    assert_eq!(page::modifier_keys(page::MOD_CTRL | page::MOD_SHIFT).len(), 2);
}

#[test]
fn eval_and_exception_helpers() {
    assert_eq!(page::eval_expression("() => document.title"), "(() => document.title)()");
    assert_eq!(page::eval_expression("async () => 1"), "(async () => 1)()");
    assert_eq!(page::eval_expression("x => x"), "(x => x)()");
    assert_eq!(page::eval_expression("document.title"), "document.title");
    assert_eq!(page::exception_text(&json!({"exception": {"description": "Error: Unknown ref e9: take a new snapshot\n    at x"}})), "Unknown ref e9: take a new snapshot");
    assert!(page::op_expression("point", &json!({"ref": "e1"})).ends_with("globalThis.__gk.run(\"point\", {\"ref\":\"e1\"})"));
    assert!(page::PAGE_JS.contains("globalThis.__gk"));
    assert_eq!(page::value_text(&json!("abc"), 10), "abc");
    assert!(page::value_text(&json!("x".repeat(50)), 10).contains("40 more characters"));
}

#[test]
fn windows_quoting_and_crt_block() {
    let q = |s: &str| {
        let mut o = String::new();
        chrome::quote_windows_arg(s, &mut o);
        o
    };
    assert_eq!(q("plain"), "plain");
    assert_eq!(q("a b"), "\"a b\"");
    assert_eq!(q(""), "\"\"");
    assert_eq!(q(r#"say "hi""#), r#""say \"hi\"""#);
    assert_eq!(q(r"C:\dir with space\"), r#""C:\dir with space\\""#);
    let block = chrome::crt_handle_block(&[None, None, None, Some(0x1234), Some(0x5678)]);
    let w = std::mem::size_of::<isize>();
    assert_eq!(block.len(), 4 + 5 + 5 * w);
    assert_eq!(&block[..4], &5i32.to_le_bytes());
    assert_eq!(&block[4..9], &[0, 0, 0, 0x09, 0x09]);
    assert_eq!(&block[9..9 + w], &(-1isize).to_le_bytes());
    assert_eq!(&block[9 + 3 * w..9 + 4 * w], &0x1234isize.to_le_bytes());
}

#[test]
fn launch_args_use_the_pipe_and_an_own_profile() {
    let a = chrome::launch_args(std::path::Path::new("/data/agent-browser/profile"), true);
    assert!(a.contains(&"--remote-debugging-pipe".to_string()));
    assert!(!a.iter().any(|x| x.starts_with("--remote-debugging-port")));
    assert!(a.contains(&"--user-data-dir=/data/agent-browser/profile".to_string()));
    assert!(a.contains(&"--headless=new".to_string()));
    assert!(!chrome::launch_args(std::path::Path::new("/p"), false).contains(&"--headless=new".to_string()));
    assert_eq!(chrome::label(std::path::Path::new(r"C:\x\Microsoft\Edge\Application\msedge.exe")), "Microsoft Edge");
}

#[test]
fn frame_encoding_and_file_names() {
    let f = super::events::encode_frame(b"JPEG", &json!({ "deviceWidth": 1280.0, "deviceHeight": 800.0, "offsetTop": 0.0, "pageScaleFactor": 1.0 }));
    let n = u32::from_le_bytes([f[0], f[1], f[2], f[3]]) as usize;
    let header: Value = serde_json::from_slice(&f[4..4 + n]).unwrap();
    assert_eq!(header["w"], 1280.0);
    assert_eq!(&f[4 + n..], b"JPEG");
    assert_eq!(super::events::sanitize_file_name("../../evil?.exe"), "_.._evil_.exe");
    assert_eq!(super::events::sanitize_file_name("..."), "download");
    assert_eq!(super::events::sanitize_file_name("report 2026.pdf"), "report 2026.pdf");
}

// ---------------------------------------------------------------------------
// hub without a browser: injection state, auth, routing, take-over, confirmations, lifecycle
// ---------------------------------------------------------------------------

// Fields drop in declaration order: the hub (and its socket, which on Unix can live in the data folder)
// must go before the temporary folder is deleted.
struct Fx {
    hub: Arc<Hub>,
    events: Arc<Mutex<Vec<UiEvent>>>,
    _dir: tempfile::TempDir,
}

fn hub_fx(serve: bool, roots: Vec<(String, u32)>) -> Fx {
    let dir = tempfile::tempdir().unwrap();
    let events: Arc<Mutex<Vec<UiEvent>>> = Arc::new(Mutex::new(Vec::new()));
    let ev2 = Arc::clone(&events);
    let hub = Hub::new(HubOptions {
        data_dir: dir.path().to_path_buf(),
        exe: Some(dir.path().join("gridkeeper.exe")),
        emit: Arc::new(move |e| ev2.lock().push(e)),
        roots: Arc::new(move || roots.clone()),
        dev_ports: Arc::new(Vec::new),
        existing_sessions: None,
        serve,
    });
    Fx { _dir: dir, hub, events }
}

#[test]
fn prepare_launch_only_for_opted_in_sessions() {
    let fx = hub_fx(true, vec![]);
    assert!(fx.hub.prepare_launch("s1", launch::Cli::Claude, false).is_empty(), "not opted in");
    fx.hub.set_session("s1", true).unwrap();
    let args = fx.hub.prepare_launch("s1", launch::Cli::Claude, false);
    if launch::claude_managed_mcp_paths().iter().any(|p| p.is_file()) {
        assert!(args.is_empty());
        return;
    }
    assert_eq!(args.len(), 1);
    let file = args[0].strip_prefix("--mcp-config=").unwrap();
    let j: Value = serde_json::from_str(&std::fs::read_to_string(file).unwrap()).unwrap();
    let token = j["mcpServers"]["gk-browser"]["env"][super::TOKEN_ENV].as_str().unwrap().to_string();
    assert_eq!(token.len(), 64);
    let st = fx.hub.state();
    let row = st.sessions.iter().find(|s| s.session_id == "s1").unwrap();
    assert!(row.enabled && row.launched && !row.connected);
    // A relaunch rotates the token.
    let args2 = fx.hub.prepare_launch("s1", launch::Cli::Codex, false);
    assert!(args2.iter().any(|a| a.starts_with("mcp_servers.gk-browser.env.GK_AGENT_BROWSER_TOKEN=")));
    assert!(!args2.iter().any(|a| a.contains(&token)));
    // Opting out: the next launch gets nothing.
    fx.hub.set_session("s1", false).unwrap();
    assert!(fx.hub.prepare_launch("s1", launch::Cli::Claude, false).is_empty());
    assert!(!fx.hub.state().sessions.iter().any(|s| s.session_id == "s1" && s.launched));
}

fn token_of(hub: &Hub, sid: &str) -> String {
    let args = hub.prepare_launch(sid, launch::Cli::Codex, false);
    let a = args.iter().find(|a| a.contains(super::TOKEN_ENV)).unwrap();
    a.rsplit_once('=').unwrap().1.trim_matches('\'').to_string()
}

#[test]
fn authentication_needs_token_and_session_tree() {
    let me = std::process::id();
    let fx = hub_fx(true, vec![("s1".into(), me), ("s2".into(), u32::MAX - 7)]);
    fx.hub.set_session("s1", true).unwrap();
    fx.hub.set_session("s2", true).unwrap();
    let t1 = token_of(&fx.hub, "s1");
    let t2 = token_of(&fx.hub, "s2");
    let req = |sid: &str, tok: &str| Request { v: ipc::PROTOCOL_VERSION, session: sid.into(), token: tok.into(), kind: RequestKind::Call, tool: None, args: Value::Null };
    assert!(fx.hub.authenticate(&req("s1", &t1), Some(me)).is_ok());
    assert!(fx.hub.authenticate(&req("s1", &t2), Some(me)).is_err(), "another session's token");
    assert!(fx.hub.authenticate(&req("s1", "x"), Some(me)).is_err());
    assert!(fx.hub.authenticate(&req("nope", &t1), Some(me)).is_err());
    assert!(fx.hub.authenticate(&req("s2", &t2), Some(me)).is_err(), "right token, but this process is not in s2's tree");
    let mut old = req("s1", &t1);
    old.v = 99;
    assert!(fx.hub.authenticate(&old, Some(me)).is_err());
    // Over the real endpoint: a call for s1 from this process is accepted (log-only tool: no browser).
    let backend = mcp::HostBackend { endpoint: fx.hub.endpoint().to_string(), session: "s1".into(), token: t1.clone() };
    let r = backend.call("browser_console_messages", &json!({})).unwrap();
    assert!(r["content"][0]["text"].as_str().unwrap().contains("No tab"));
    let bad = mcp::HostBackend { endpoint: fx.hub.endpoint().to_string(), session: "s2".into(), token: t2 };
    assert!(bad.call("browser_console_messages", &json!({})).unwrap_err().contains("does not belong"));
}

fn add_fake_tab(hub: &Hub, sid: &str, cdp_session: &str, target: &str) {
    let mut g = hub.inner.lock();
    g.by_cdp.insert(cdp_session.into(), sid.into());
    g.by_target.insert(target.into(), sid.into());
    let s = g.sessions.entry(sid.into()).or_default();
    let tab = super::hub::tests_support::tab(1, target, cdp_session);
    s.tab = Some(tab);
}

#[test]
fn events_route_to_the_owning_tab_only() {
    let fx = hub_fx(false, vec![]);
    add_fake_tab(&fx.hub, "a", "SA", "TA");
    add_fake_tab(&fx.hub, "b", "SB", "TB");
    let mut acks = Vec::new();
    let ev = |sess: &str, method: &str, params: Value| CdpEvent { method: method.into(), params, session_id: Some(sess.into()) };
    fx.hub.on_event(1, ev("SA", "Runtime.consoleAPICalled", json!({"type":"error","args":[{"type":"string","value":"boom in A"}]})), &mut acks);
    fx.hub.on_event(1, ev("SB", "Network.requestWillBeSent", json!({"requestId":"1","request":{"method":"GET","url":"http://localhost:3000/api?token=SECRET"},"type":"Fetch"})), &mut acks);
    fx.hub.on_event(1, ev("SB", "Network.loadingFailed", json!({"requestId":"1","errorText":"net::ERR_CONNECTION_REFUSED"})), &mut acks);
    fx.hub.on_event(1, ev("SA", "Page.frameNavigated", json!({"frame":{"id":"TA","url":"http://localhost:5173/home"}})), &mut acks);
    fx.hub.on_event(2, ev("SA", "Runtime.consoleAPICalled", json!({"type":"log","args":[{"type":"string","value":"old generation"}]})), &mut acks);
    fx.hub.on_event(1, ev("SX", "Runtime.consoleAPICalled", json!({"type":"log","args":[{"type":"string","value":"unknown session"}]})), &mut acks);

    let a = fx.hub.log_tool("a", "browser_console_messages", &json!({}));
    let a_text = a.content[0]["text"].as_str().unwrap().to_string();
    assert!(a_text.contains("boom in A"));
    assert!(!a_text.contains("old generation") && !a_text.contains("unknown session"));
    let b = fx.hub.log_tool("b", "browser_console_messages", &json!({}));
    assert!(!b.content[0]["text"].as_str().unwrap().contains("boom"), "A's console never shows in B");
    let net = fx.hub.log_tool("b", "browser_network_requests", &json!({ "onlyFailed": true }));
    let net_text = net.content[0]["text"].as_str().unwrap();
    assert!(net_text.contains("http://localhost:3000/api") && net_text.contains("ERR_CONNECTION_REFUSED"));
    assert!(!net_text.contains("SECRET"), "queries are not kept");
    assert!(fx.hub.log_tool("a", "browser_network_requests", &json!({})).content[0]["text"].as_str().unwrap().contains("No requests"));
    let st = fx.hub.state();
    assert_eq!(st.sessions.iter().find(|s| s.session_id == "a").unwrap().url.as_deref(), Some("http://localhost:5173/home"));
}

#[test]
fn popups_of_an_agent_tab_are_closed_and_reported() {
    let fx = hub_fx(false, vec![]);
    add_fake_tab(&fx.hub, "a", "SA", "TA");
    let mut acks = Vec::new();
    let created = CdpEvent { method: "Target.targetCreated".into(), params: json!({"targetInfo":{"targetId":"P1","type":"page","url":"","openerId":"TA"}}), session_id: None };
    fx.hub.on_event(1, created, &mut acks);
    assert_eq!(fx.hub.inner.lock().popups.get("P1").map(String::as_str), Some("a"));
    let changed = CdpEvent { method: "Target.targetInfoChanged".into(), params: json!({"targetInfo":{"targetId":"P1","type":"page","url":"https://example.com/login?x=1","openerId":"TA"}}), session_id: None };
    fx.hub.on_event(1, changed, &mut acks);
    let g = fx.hub.inner.lock();
    assert!(g.popups.is_empty());
    let notices = &g.sessions["a"].notices;
    assert!(notices.iter().any(|n| n.contains("https://example.com/login") && !n.contains("x=1")), "{notices:?}");
}

#[test]
fn takeover_queues_calls_and_stop_refuses_them() {
    let fx = hub_fx(false, vec![]);
    add_fake_tab(&fx.hub, "a", "SA", "TA");
    fx.hub.take_over("a", true).unwrap();
    let hub = Arc::clone(&fx.hub);
    let waiter = std::thread::spawn(move || {
        let t = Instant::now();
        let r = hub.acquire("a");
        hub.release("a");
        (r, t.elapsed())
    });
    std::thread::sleep(Duration::from_millis(300));
    assert!(!waiter.is_finished(), "the call waits while the user has the tab");
    fx.hub.take_over("a", false).unwrap();
    let (r, waited) = waiter.join().unwrap();
    assert!(r.is_ok());
    assert!(waited >= Duration::from_millis(250));

    // One call at a time per session; other sessions are not blocked.
    fx.hub.acquire("a").unwrap();
    fx.hub.acquire("b").unwrap();
    fx.hub.release("b");
    fx.hub.release("a");

    fx.hub.set_stopped("a", true).unwrap();
    assert!(fx.hub.acquire("a").unwrap_err().contains("turned off"));
    assert!(fx.hub.inner.lock().sessions["a"].tab.is_none(), "stopping closes the tab");
    fx.hub.set_stopped("a", false).unwrap();
    assert!(fx.hub.acquire("a").is_ok());
    fx.hub.release("a");
    let acts: Vec<String> = fx.events.lock().iter().filter_map(|e| if let UiEvent::Activity(a) = e { Some(a.summary.clone()) } else { None }).collect();
    assert!(acts.iter().any(|s| s.contains("took over")));
    assert!(acts.iter().any(|s| s.contains("stopped browsing")));
}

#[test]
fn confirmations_wait_for_the_user_and_remember_hosts() {
    let fx = hub_fx(false, vec![]);
    let hub = Arc::clone(&fx.hub);
    let asker = std::thread::spawn(move || {
        hub.confirm("a", PromptKind::FormSubmit, Some("https://shop.example".into()), "Submit a form".into(), Some("shop.example".into()))
    });
    let deadline = Instant::now() + Duration::from_secs(3);
    let id = loop {
        if let Some(p) = fx.hub.state().prompts.first() {
            break p.id;
        }
        assert!(Instant::now() < deadline, "prompt never appeared");
        std::thread::sleep(Duration::from_millis(10));
    };
    let p = fx.hub.state().prompts[0].clone();
    assert_eq!((p.kind, p.session_id.as_str(), p.remember_host.as_deref()), (PromptKind::FormSubmit, "a", Some("shop.example")));
    fx.hub.answer(id, true, true).unwrap();
    assert!(asker.join().unwrap().is_ok());
    assert!(fx.hub.state().prompts.is_empty());
    assert_eq!(fx.hub.state().allowlist, vec!["shop.example".to_string()]);
    assert!(fx.hub.answer(id, true, false).is_err(), "answered prompts are gone");

    let hub = Arc::clone(&fx.hub);
    let asker = std::thread::spawn(move || hub.confirm("a", PromptKind::Upload, None, "Give 1 file".into(), None));
    let deadline = Instant::now() + Duration::from_secs(3);
    let id = loop {
        if let Some(p) = fx.hub.state().prompts.first() {
            break p.id;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(10));
    };
    fx.hub.answer(id, false, false).unwrap();
    assert!(asker.join().unwrap().unwrap_err().contains("declined"));
}

#[test]
fn janitor_plan_closes_orphan_tabs_and_stops_when_idle() {
    let now = Instant::now();
    let ago = |s: u64| now - Duration::from_secs(s);
    let row = |id: &str, has_tab: bool, presence: u32, disc: Option<Instant>| JanitorRow { id: id.into(), has_tab, presence, busy: false, watched: false, last_disconnect: disc };
    let idle = Duration::from_secs(600);
    // Helper gone for 2 minutes: close; gone 10 s: keep; connected: keep.
    let rows = vec![row("gone", true, 0, Some(ago(120))), row("recent", true, 0, Some(ago(10))), row("live", true, 1, None)];
    let (close, stop) = plan_janitor(&rows, now, ago(5), None, false, idle);
    assert_eq!(close, vec!["gone".to_string()]);
    assert_eq!(stop, None);
    // No tool call for 11 minutes: stop, unless someone watches or a question is open.
    let rows = vec![row("live", true, 1, None)];
    assert_eq!(plan_janitor(&rows, now, ago(660), None, false, idle).1, Some("idle"));
    assert_eq!(plan_janitor(&rows, now, ago(660), None, true, idle).1, None);
    let watched = vec![JanitorRow { watched: true, ..row("live", true, 1, None) }];
    assert_eq!(plan_janitor(&watched, now, ago(660), None, false, idle).1, None);
    // No tabs for over a minute: stop.
    let rows = vec![row("x", false, 1, None)];
    assert_eq!(plan_janitor(&rows, now, ago(5), Some(ago(90)), false, idle).1, Some("no agent tabs"));
    assert_eq!(plan_janitor(&rows, now, ago(5), Some(ago(20)), false, idle).1, None);
}

#[test]
fn stale_launch_files_are_removed_at_startup() {
    let dir = tempfile::tempdir().unwrap();
    let ab = super::dir(dir.path());
    std::fs::create_dir_all(&ab).unwrap();
    std::fs::write(ab.join("mcp-old.json"), "{}").unwrap();
    std::fs::write(ab.join("config.json"), r#"{"sessions":["keep","gone"]}"#).unwrap();
    let hub = Hub::new(HubOptions {
        data_dir: dir.path().to_path_buf(),
        exe: None,
        emit: Arc::new(|_| {}),
        roots: Arc::new(Vec::new),
        dev_ports: Arc::new(Vec::new),
        existing_sessions: Some(vec!["keep".into()]),
        serve: false,
    });
    assert!(!ab.join("mcp-old.json").exists());
    assert_eq!(hub.config.lock().sessions, vec!["keep".to_string()]);
    // No executable: an opted-in launch gets no tools and says why.
    hub.set_session("keep", true).unwrap();
    assert!(hub.prepare_launch("keep", launch::Cli::Claude, false).is_empty());
    assert!(hub.state().sessions[0].launch_note.as_deref().unwrap_or("").contains("no browser tools"));
}

#[test]
fn activity_outcomes_serialize_camel_case() {
    assert_eq!(serde_json::to_value(ActivityOutcome::Denied).unwrap(), json!("denied"));
    assert_eq!(serde_json::to_value(PromptKind::FormSubmit).unwrap(), json!("formSubmit"));
}

// ---------------------------------------------------------------------------
// Live: the real browser, headless, through the helper's transport and the tool path.
// Run with: cargo test --lib agent_browser::tests::live_ -- --ignored --nocapture
// ---------------------------------------------------------------------------

#[test]
#[ignore = "starts Edge / Chrome headless (needs a browser and ~300 MB of free memory)"]
fn live_browser_opens_about_blank_via_tools() {
    if chrome::find_browser(None).is_none() {
        eprintln!("no browser installed; skipping");
        return;
    }
    let me = std::process::id();
    let fx = hub_fx(true, vec![("live".into(), me)]);
    fx.hub.set_session("live", true).unwrap();
    let token = token_of(&fx.hub, "live");
    let backend = mcp::HostBackend { endpoint: fx.hub.endpoint().to_string(), session: "live".into(), token };
    let t = Instant::now();
    let r = backend.call("browser_navigate", &json!({ "url": "about:blank" })).unwrap();
    eprintln!("navigate: {r}");
    assert_eq!(r["isError"], false, "{r}");
    assert!(r["content"].to_string().contains("about:blank"));
    eprintln!("browser start + tab + navigate: {:?}", t.elapsed());
    let st = fx.hub.state();
    assert!(st.running, "{:?}", st.error);
    eprintln!("browser: {:?} pid {:?}", st.browser, st.pid);

    let r = backend.call("browser_evaluate", &json!({ "function": "() => { document.body.innerHTML = '<h1>Hi</h1><button>Go</button><input placeholder=Name>'; return 1 + 1; }" })).unwrap();
    assert!(r["content"].to_string().contains('2'), "{r}");
    let snap = backend.call("browser_snapshot", &json!({})).unwrap();
    let text = snap["content"][0]["text"].as_str().unwrap().to_string();
    eprintln!("{text}");
    assert!(text.contains("heading \"Hi\"") && text.contains("button \"Go\" [ref=e1]") && text.contains("textbox \"Name\" [ref=e2]"));
    let typed = backend.call("browser_type", &json!({ "ref": "e2", "text": "Ada" })).unwrap();
    assert!(typed["content"].to_string().contains("value=\\\"Ada\\\""), "{typed}");
    let clicked = backend.call("browser_click", &json!({ "ref": "e1" })).unwrap();
    assert_eq!(clicked["isError"], false, "{clicked}");
    let shot = backend.call("browser_take_screenshot", &json!({})).unwrap();
    assert_eq!(shot["content"][1]["type"], "image");
    let blocked = backend.call("browser_navigate", &json!({ "url": "file:///C:/Windows/win.ini" })).unwrap();
    assert_eq!(blocked["isError"], true);
    let console = backend.call("browser_console_messages", &json!({})).unwrap();
    eprintln!("console: {console}");

    // Through the MCP helper's JSON-RPC layer too.
    let input = format!("{}\n", json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"browser_snapshot","arguments":{}}}));
    let buf = Arc::new(Mutex::new(Vec::new()));
    let out: Arc<Mutex<Box<dyn std::io::Write + Send>>> = Arc::new(Mutex::new(Box::new(SharedBuf(Arc::clone(&buf)))));
    mcp::serve(&mut BufReader::new(Cursor::new(input.into_bytes())), &out, Arc::new(backend));
    let deadline = Instant::now() + Duration::from_secs(20);
    while buf.lock().is_empty() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    let line = String::from_utf8(buf.lock().clone()).unwrap();
    assert!(line.contains("heading"), "{line}");

    let pid = fx.hub.state().pid.unwrap();
    fx.hub.stop_browser("test done");
    assert!(!fx.hub.state().running);
    eprintln!("stopped browser pid {pid}");
    fx.hub.shutdown();
}
