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
        env_set: vec![("ALTERA_TEST".into(), "1".into())],
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
