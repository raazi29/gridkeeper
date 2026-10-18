//! Integration tests against a real ConPTY (Windows only).
#![cfg(windows)]

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;

use super::*;

fn pwsh() -> PathBuf {
    let p = PathBuf::from(r"C:\Program Files\PowerShell\7\pwsh.exe");
    if p.is_file() { p } else { PathBuf::from("powershell.exe") }
}

fn spec(id: &str) -> SessionSpec {
    SessionSpec {
        id: id.into(),
        name: format!("test {id}"),
        agent: AgentKind::Generic,
        cwd: std::env::temp_dir().to_string_lossy().into_owned(),
        profile_id: None,
        command: None,
        args: vec![],
        env: vec![],
        resume: ResumeMode::None,
        agent_session_id: None,
        preset: None,
        cols: 120,
        rows: 30,
    }
}

fn plan(program: impl Into<PathBuf>, args: &[&str]) -> LaunchPlan {
    let program = program.into();
    LaunchPlan {
        display: format!("{} {}", program.display(), args.join(" ")),
        program,
        args: args.iter().map(|s| s.to_string()).collect(),
        env_set: vec![("GRIDKEEPER_TEST".into(), "1".into())],
        env_remove: vec!["CLAUDE_CONFIG_DIR".into()],
        cwd: std::env::temp_dir(),
    }
}

struct Fixture {
    core: Arc<SessionCore>,
    events: Arc<Mutex<Vec<SessionInfo>>>,
}

fn fixture() -> Fixture {
    let events = Arc::new(Mutex::new(Vec::new()));
    let ev = Arc::clone(&events);
    let core = Arc::new(SessionCore::new(move |info: &SessionInfo| ev.lock().push(info.clone())));
    Fixture { core, events }
}

impl Fixture {
    fn states(&self, id: &str) -> Vec<SessionState> {
        self.events.lock().iter().filter(|i| i.id == id).map(|i| i.state.clone()).collect()
    }

    fn wait_text(&self, id: &str, timeout: Duration, pred: impl Fn(&str) -> bool) -> String {
        let deadline = Instant::now() + timeout;
        loop {
            let text = self.core.output_text(id).unwrap();
            if pred(&text) || Instant::now() >= deadline {
                return text;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    /// Attach a sink that behaves like a terminal view: records DATA payloads,
    /// acks them immediately, and answers cursor-position requests (as
    /// xterm.js does — an attached view that never answers would hang ConPTY).
    fn attach_recorder(&self, id: &str) -> Arc<Mutex<Vec<u8>>> {
        let data = Arc::new(Mutex::new(Vec::new()));
        let d = Arc::clone(&data);
        let core = Arc::clone(&self.core);
        let sid = id.to_string();
        let mut cpr = text::CprScanner::new();
        self.core
            .attach_sink(
                id,
                Box::new(move |frame: Vec<u8>| {
                    if frame[0] == crate::types::frame::RESET {
                        d.lock().clear();
                    } else {
                        let payload = &frame[1..];
                        d.lock().extend_from_slice(payload);
                        for _ in 0..cpr.feed(payload) {
                            let _ = core.write(&sid, b"\x1b[1;1R".to_vec());
                        }
                        let _ = core.ack(&sid, payload.len() as u64);
                    }
                    Ok::<(), SinkClosed>(())
                }),
            )
            .unwrap();
        data
    }
}

#[test]
fn large_output_through_conpty() {
    let fx = fixture();
    let id = "it-lines";
    let p = plan(pwsh(), &["-NoLogo", "-NoProfile", "-Command", "1..20000 | % { \"line $_\" }"]);
    let info = fx.core.start(spec(id), p, 8 << 20).unwrap();
    assert!(info.pid.is_some());
    let streamed = fx.attach_recorder(id);

    assert!(fx.core.wait_exit(id, Duration::from_secs(90)).unwrap(), "process did not exit");
    assert!(fx.core.wait_output_eof(id, Duration::from_secs(10)).unwrap(), "reader did not reach EOF");
    let info = fx.core.info(id).unwrap();
    assert_eq!(info.state, SessionState::Exited { code: Some(0) });
    assert!(info.ended_at.is_some());
    assert!(info.bytes_out > 20000 * 6);

    let text = fx.core.output_text(id).unwrap();
    assert!(text.contains("line 20000"), "ring text tail: {:?}", &text[text.len().saturating_sub(300)..]);

    // The attached view received the same stream (allow the pump a moment).
    let deadline = Instant::now() + Duration::from_secs(5);
    while !text::strip_ansi(&streamed.lock()).contains("line 20000") && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(text::strip_ansi(&streamed.lock()).contains("line 20000"));

    let states = fx.states(id);
    assert_eq!(states.first(), Some(&SessionState::Starting));
    assert!(states.contains(&SessionState::Running));
    assert_eq!(states.last(), Some(&SessionState::Exited { code: Some(0) }));
    fx.core.detach(id).unwrap();
    fx.core.remove(id).unwrap();
    assert!(fx.core.list().is_empty());
}

#[test]
fn exit_code_is_reported() {
    let fx = fixture();
    let id = "it-exit7";
    fx.core.start(spec(id), plan("cmd.exe", &["/c", "exit 7"]), 256 * 1024).unwrap();
    assert!(fx.core.wait_exit(id, Duration::from_secs(30)).unwrap());
    assert_eq!(fx.core.info(id).unwrap().state, SessionState::Exited { code: Some(7) });
    assert!(fx.core.wait_output_eof(id, Duration::from_secs(10)).unwrap());
    // Writing to an exited session is refused.
    assert!(matches!(fx.core.write(id, b"x".to_vec()), Err(AppError::Invalid(_))));
    // Root pid list excludes exited sessions.
    assert!(fx.core.root_pids().iter().all(|(sid, _)| sid != id));
}

#[test]
fn force_stop_kills_whole_tree() {
    let fx = fixture();
    let id = "it-tree";
    let p = plan(
        pwsh(),
        &[
            "-NoProfile",
            "-Command",
            "Start-Process -NoNewWindow pwsh -ArgumentList '-NoProfile','-Command','Start-Sleep 60'; Start-Sleep 60",
        ],
    );
    let p = if pwsh().ends_with("pwsh.exe") {
        p
    } else {
        plan(
            pwsh(),
            &[
                "-NoProfile",
                "-Command",
                "Start-Process -NoNewWindow powershell -ArgumentList '-NoProfile','-Command','Start-Sleep 60'; Start-Sleep 60",
            ],
        )
    };
    fx.core.start(spec(id), p, 256 * 1024).unwrap();

    let deadline = Instant::now() + Duration::from_secs(30);
    let mut count = 0;
    while Instant::now() < deadline {
        count = fx.core.job_process_count(id).unwrap().expect("session has a job");
        if count >= 2 {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    assert!(count >= 2, "grandchild never appeared in the job (count {count})");
    assert_eq!(fx.core.root_pids().iter().filter(|(sid, _)| sid == id).count(), 1);

    let t = Instant::now();
    fx.core.stop(id, true).unwrap();
    assert!(t.elapsed() < Duration::from_millis(500), "stop must not block");
    assert!(fx.core.wait_exit(id, Duration::from_secs(10)).unwrap());

    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let n = fx.core.job_process_count(id).unwrap().unwrap();
        if n == 0 {
            break;
        }
        assert!(Instant::now() < deadline, "{n} processes still alive in the job");
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(matches!(fx.core.info(id).unwrap().state, SessionState::Exited { .. }));
    let states = fx.states(id);
    assert!(states.contains(&SessionState::Stopping));
}

#[test]
fn interactive_input_round_trip() {
    let fx = fixture();
    let id = "it-input";
    fx.core.start(spec(id), plan(pwsh(), &["-NoLogo", "-NoProfile"]), 1 << 20).unwrap();
    let text = fx.wait_text(id, Duration::from_secs(30), |t| t.contains("PS "));
    assert!(text.contains("PS "), "no prompt: {text:?}");

    fx.core.write(id, b"echo hello-altera\r".to_vec()).unwrap();
    // Once echoed as typed input, once as command output.
    let text = fx.wait_text(id, Duration::from_secs(20), |t| t.matches("hello-altera").count() >= 2);
    assert!(text.matches("hello-altera").count() >= 2, "output: {text:?}");

    fx.core.resize(id, 100, 20).unwrap();
    fx.core.resize(id, 100, 20).unwrap(); // unchanged: no-op
    fx.core.resize(id, 0, 0).unwrap(); // clamped, never zero

    // A single write beyond the queue cap is refused without blocking.
    let huge = vec![b'a'; MAX_INPUT_QUEUE + 1];
    assert!(matches!(fx.core.write(id, huge), Err(AppError::Invalid(m)) if m.contains("input queue full")));

    // Duplicate live id is rejected; removing a live session is refused.
    let dup = fx.core.start(spec(id), plan(pwsh(), &["-NoProfile"]), 1 << 20);
    assert!(matches!(dup, Err(AppError::Invalid(_))));
    assert!(matches!(fx.core.remove(id), Err(AppError::Invalid(_))));

    fx.core.write(id, b"exit\r".to_vec()).unwrap();
    assert!(fx.core.wait_exit(id, Duration::from_secs(20)).unwrap(), "pwsh did not exit");
    assert_eq!(fx.core.info(id).unwrap().state, SessionState::Exited { code: Some(0) });

    // Restart with the same id replaces the exited entry.
    fx.core.start(spec(id), plan("cmd.exe", &["/c", "exit 3"]), 256 * 1024).unwrap();
    assert!(fx.core.wait_exit(id, Duration::from_secs(20)).unwrap());
    assert_eq!(fx.core.info(id).unwrap().state, SessionState::Exited { code: Some(3) });
    assert_eq!(fx.core.list().len(), 1);
}

#[test]
fn graceful_stop_closes_interactive_shell() {
    let fx = fixture();
    let id = "it-graceful";
    fx.core.start(spec(id), plan(pwsh(), &["-NoLogo", "-NoProfile"]), 1 << 20).unwrap();
    fx.wait_text(id, Duration::from_secs(30), |t| t.contains("PS "));
    let t = Instant::now();
    fx.core.stop(id, false).unwrap();
    assert!(t.elapsed() < Duration::from_millis(500), "stop must not block");
    assert_eq!(fx.core.info(id).unwrap().state, SessionState::Stopping);
    // Ctrl+C does not end an idle shell; closing the console (after 2 s) does.
    assert!(fx.core.wait_exit(id, Duration::from_secs(10)).unwrap(), "graceful stop did not end the shell");
    assert!(fx.core.wait_output_eof(id, Duration::from_secs(10)).unwrap());
    assert!(matches!(fx.core.info(id).unwrap().state, SessionState::Exited { .. }));
}

#[test]
fn state_events_never_end_on_a_stale_running() {
    // A slow listener while delivering `Running` used to let the waiter's
    // `Exited` overtake it (snapshot taken before the callback, without
    // ordering), leaving the UI showing a live session for an exited process.
    let events = Arc::new(Mutex::new(Vec::<SessionInfo>::new()));
    let ev = Arc::clone(&events);
    let core = SessionCore::new(move |info: &SessionInfo| {
        // Delay only the launching thread's `Running` (session threads are
        // named `pty-*`; stalling the reader would stall ConPTY itself).
        let on_session_thread = std::thread::current().name().is_some_and(|n| n.starts_with("pty-"));
        if info.state == SessionState::Running && !on_session_thread {
            std::thread::sleep(Duration::from_millis(1500));
        }
        ev.lock().push(info.clone());
    });
    for i in 0..2 {
        let id = format!("it-order-{i}");
        core.start(spec(&id), plan("cmd.exe", &["/c", "echo order"]), 256 * 1024).unwrap();
        assert!(core.wait_exit(&id, Duration::from_secs(20)).unwrap());
        assert!(core.wait_output_eof(&id, Duration::from_secs(10)).unwrap());
        std::thread::sleep(Duration::from_millis(2000));
        let last = events.lock().iter().rev().find(|e| e.id == id).map(|e| e.state.clone());
        assert!(matches!(last, Some(SessionState::Exited { .. })), "{id}: last event {last:?}");
    }
}

#[test]
fn launch_failures_are_reported() {
    let fx = fixture();
    let err = fx.core.start(spec("it-missing"), plan("no-such-program-altera-xyz", &[]), 256 * 1024).unwrap_err();
    assert!(matches!(err, AppError::MissingExecutable(_)), "{err:?}");
    assert!(matches!(fx.core.info("it-missing").unwrap().state, SessionState::Failed { .. }));
    assert!(matches!(fx.states("it-missing").last(), Some(SessionState::Failed { .. })));

    let mut p = plan("cmd.exe", &["/c", "exit 0"]);
    p.cwd = PathBuf::from(r"C:\definitely\not\here\altera");
    let err = fx.core.start(spec("it-badcwd"), p, 256 * 1024).unwrap_err();
    match err {
        AppError::Invalid(m) => assert!(m.starts_with("Working directory does not exist"), "{m}"),
        other => panic!("unexpected {other:?}"),
    }
    // Failed sessions can be removed, and unknown ids are NotFound.
    fx.core.remove("it-badcwd").unwrap();
    assert!(matches!(fx.core.info("it-badcwd"), Err(AppError::NotFound(_))));
    assert!(matches!(fx.core.stop("nope", true), Err(AppError::NotFound(_))));
}

#[test]
fn replay_on_attach_after_exit() {
    let fx = fixture();
    let id = "it-replay";
    fx.core.start(spec(id), plan("cmd.exe", &["/c", "echo replay-marker-1 & echo replay-marker-2"]), 256 * 1024).unwrap();
    assert!(fx.core.wait_exit(id, Duration::from_secs(20)).unwrap());
    assert!(fx.core.wait_output_eof(id, Duration::from_secs(10)).unwrap());
    let data = fx.attach_recorder(id);
    let deadline = Instant::now() + Duration::from_secs(5);
    while !text::strip_ansi(&data.lock()).contains("replay-marker-2") && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    let t = text::strip_ansi(&data.lock());
    assert!(t.contains("replay-marker-1") && t.contains("replay-marker-2"), "{t:?}");
    // The replay must not contain the ConPTY cursor-position request (it was
    // already answered by Rust while no view was attached).
    assert_eq!(text::count_cpr(&data.lock()), 0);
    fx.core.clear_buffer(id).unwrap();
    assert_eq!(fx.core.output_text(id).unwrap(), "");
}

#[test]
fn shutdown_all_stops_everything() {
    let fx = fixture();
    for id in ["it-sd-1", "it-sd-2"] {
        fx.core.start(spec(id), plan(pwsh(), &["-NoLogo", "-NoProfile"]), 256 * 1024).unwrap();
    }
    fx.core.start(spec("it-sd-3"), plan("cmd.exe", &["/k"]), 256 * 1024).unwrap();
    std::thread::sleep(Duration::from_millis(1500));
    let t = Instant::now();
    fx.core.shutdown_all(Duration::from_millis(1500));
    assert!(t.elapsed() < Duration::from_millis(2500), "shutdown took {:?}", t.elapsed());
    for s in fx.core.list() {
        assert!(matches!(s.state, SessionState::Exited { .. }), "{} is {:?}", s.id, s.state);
    }
}

// ---- attention ------------------------------------------------------------------

fn attention_fixture() -> (Arc<SessionCore>, Arc<Mutex<Vec<SessionAttention>>>) {
    let events = Arc::new(Mutex::new(Vec::new()));
    let ev = Arc::clone(&events);
    let core = Arc::new(SessionCore::with_attention(|_: &SessionInfo| {}, move |a: &SessionAttention| ev.lock().push(a.clone())));
    (core, events)
}

/// The inbox ConPTY of older Windows builds (Windows 10, Server 2019 / 2022: typical CI VMs) swallows BEL and
/// rewrites OSC 7501 (docs/HANDOFF.md, known issues). The two signal tests below need build 22000+ (Windows 11).
fn conpty_passes_signals() -> bool {
    let build = sysinfo::System::kernel_version().and_then(|v| v.split('.').next_back().and_then(|b| b.parse::<u32>().ok()));
    match build {
        Some(b) if b < 22000 => {
            eprintln!("skipping: the ConPTY of Windows build {b} swallows these sequences (needs 22000+)");
            false
        }
        _ => true,
    }
}

/// BEL and notification escapes printed by a real program must survive ConPTY
/// and reach the scanner without any view attached.
#[test]
fn attention_signals_through_conpty() {
    if !conpty_passes_signals() {
        return;
    }
    let (core, events) = attention_fixture();
    let id = "it-attn";
    // Separate prints with sleeps: alerts are rate-limited to one per 2 s.
    let script = concat!(
        "$e=[char]27; $b=[char]7; ",
        "Write-Host -NoNewline \"bell:$b\"; Start-Sleep -Milliseconds 2300; ",
        "Write-Host -NoNewline \"$e]9;osc9-hello$e\\\"; Start-Sleep -Milliseconds 2300; ",
        "Write-Host -NoNewline \"$e]777;notify;T777;B777$b\"; Start-Sleep -Milliseconds 300; ",
        "Write-Host -NoNewline \"$e]7501;state=working$e\\\"; Start-Sleep -Milliseconds 300; ",
        "Write-Host -NoNewline \"$e]9;4;1;50$b\"; Start-Sleep -Milliseconds 300; ",
        "Write-Host done-marker; Start-Sleep -Milliseconds 500"
    );
    core.start(spec(id), plan(pwsh(), &["-NoLogo", "-NoProfile", "-Command", script]), 1 << 20).unwrap();
    assert!(core.wait_exit(id, Duration::from_secs(40)).unwrap());
    assert!(core.wait_output_eof(id, Duration::from_secs(10)).unwrap());
    let evs = events.lock().clone();
    eprintln!("attention events through ConPTY: {evs:#?}");
    assert!(evs.iter().any(|e| e.kind == AttentionKind::Bell), "BEL not seen: {evs:?}");
    // Progress (9;4) is never a notification.
    assert!(!evs.iter().any(|e| e.body.as_deref().is_some_and(|b| b.contains("50"))));
    let osc9 = evs.iter().any(|e| e.kind == AttentionKind::Notify && e.body.as_deref() == Some("osc9-hello"));
    let osc777 = evs.iter().any(|e| e.kind == AttentionKind::Notify && e.title.as_deref() == Some("T777"));
    let osc7501 = evs.iter().any(|e| e.kind == AttentionKind::Status && e.status.as_deref() == Some("working"));
    eprintln!("ConPTY passthrough: OSC 9 = {osc9}, OSC 777 = {osc777}, OSC 7501 = {osc7501}");
    assert!(osc9 && osc777 && osc7501, "ConPTY dropped an OSC sequence: osc9={osc9} osc777={osc777} osc7501={osc7501}");
}

/// The OSC 7501 probe is answered by Rust (as win32-input-mode key events) and
/// the exact reply reaches the program's console input.
#[test]
fn status_probe_is_answered() {
    if !conpty_passes_signals() {
        return;
    }
    // The reply is opt-in (see session.rs); enabling it process-wide is harmless for other tests.
    // SAFETY: tests do not read this variable concurrently with a write that could tear.
    unsafe { std::env::set_var("GRIDKEEPER_OSC7501_REPLY", "1") };
    let (core, _events) = attention_fixture();
    let id = "it-probe";
    let script = concat!(
        "$e=[char]27; Write-Host -NoNewline \"$e]7501;?$e\\\"; Start-Sleep -Milliseconds 1500; ",
        "$s=''; while([Console]::KeyAvailable){ $k=[Console]::ReadKey($true); $s+=$k.KeyChar }; ",
        "Write-Host ('GOT[' + ($s -replace [char]27,'<ESC>') + ']')"
    );
    core.start(spec(id), plan(pwsh(), &["-NoLogo", "-NoProfile", "-Command", script]), 1 << 20).unwrap();
    assert!(core.wait_exit(id, Duration::from_secs(30)).unwrap());
    assert!(core.wait_output_eof(id, Duration::from_secs(10)).unwrap());
    let reply = "<ESC>]7501;?:states=idle,working,done,blocked,error,clear:kinds=permission,question,auth<ESC>\\";
    let text = core.output_text(id).unwrap();
    assert!(text.contains(&format!("GOT[{reply}]")), "reply not delivered intact: {text:?}");

    // VT input mode (ENABLE_VIRTUAL_TERMINAL_INPUT only, like Node / Claude
    // Code), probe followed by DA1 as the OSC 7501 detection does.
    let id2 = "it-probe-vt";
    let script2 = concat!(
        "Add-Type -Name K -Namespace W -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern System.IntPtr GetStdHandle(int h); [DllImport(\"kernel32.dll\")] public static extern bool SetConsoleMode(System.IntPtr h, uint m); [DllImport(\"kernel32.dll\", CharSet=CharSet.Unicode)] public static extern bool ReadConsoleW(System.IntPtr h, char[] b, uint n, out uint r, System.IntPtr c);'; ",
        "$h=[W.K]::GetStdHandle(-10); [void][W.K]::SetConsoleMode($h, 0x200); ",
        "$e=[char]27; Write-Host -NoNewline \"$e]7501;?$e\\$e[c\"; Start-Sleep -Milliseconds 1500; ",
        "$buf=New-Object char[] 1024; $r=0; [void][W.K]::ReadConsoleW($h,$buf,1024,[ref]$r,[IntPtr]::Zero); ",
        "$s=-join $buf[0..([int]$r-1)]; Write-Host ('GOT[' + ($s -replace [char]27,'<ESC>') + ']')"
    );
    core.start(spec(id2), plan(pwsh(), &["-NoLogo", "-NoProfile", "-Command", script2]), 1 << 20).unwrap();
    assert!(core.wait_exit(id2, Duration::from_secs(30)).unwrap());
    assert!(core.wait_output_eof(id2, Duration::from_secs(10)).unwrap());
    let text2 = core.output_text(id2).unwrap();
    assert!(text2.contains(reply), "reply not delivered in VT input mode: {text2:?}");
    // Observation (Windows 11 build 26300 inbox ConPTY): conhost answers DA1
    // itself, synchronously, so its DA1 reply precedes ours. Logged only.
    let da1_first = text2.contains("c<ESC>]7501");
    eprintln!("VT-mode input as seen by the program: {text2:?} (ConPTY DA1 reply first: {da1_first})");
}
