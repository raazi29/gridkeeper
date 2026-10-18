//! Integration tests against a real Unix pty (macOS / Linux), the counterpart of the ConPTY tests
//! in `tests.rs`. Only POSIX `sh` and `sleep` are used.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;

use super::*;

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

/// `sh` with a recognizable prompt and no rc files (`ENV` unset).
fn plan(args: &[&str]) -> LaunchPlan {
    LaunchPlan {
        display: format!("sh {}", args.join(" ")),
        program: PathBuf::from("sh"),
        args: args.iter().map(|s| s.to_string()).collect(),
        env_set: vec![("GRIDKEEPER_TEST".into(), "1".into()), ("PS1".into(), "gk-prompt$ ".into())],
        env_remove: vec!["ENV".into(), "BASH_ENV".into(), "CLAUDE_CONFIG_DIR".into()],
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

    /// A sink that records DATA payloads and acks them, like a terminal view.
    fn attach_recorder(&self, id: &str) -> Arc<Mutex<Vec<u8>>> {
        let data = Arc::new(Mutex::new(Vec::new()));
        let d = Arc::clone(&data);
        let core = Arc::clone(&self.core);
        let sid = id.to_string();
        self.core
            .attach_sink(
                id,
                Box::new(move |frame: Vec<u8>| {
                    if frame[0] == crate::types::frame::RESET {
                        d.lock().clear();
                    } else {
                        let payload = &frame[1..];
                        d.lock().extend_from_slice(payload);
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
fn exit_code_is_reported() {
    let fx = fixture();
    let id = "ut-exit7";
    fx.core.start(spec(id), plan(&["-c", "exit 7"]), 256 * 1024).unwrap();
    assert!(fx.core.wait_exit(id, Duration::from_secs(30)).unwrap());
    assert_eq!(fx.core.info(id).unwrap().state, SessionState::Exited { code: Some(7) });
    assert!(fx.core.wait_output_eof(id, Duration::from_secs(10)).unwrap(), "reader did not reach EOF");
    assert!(matches!(fx.core.write(id, b"x".to_vec()), Err(AppError::Invalid(_))));
    assert!(fx.core.root_pids().iter().all(|(sid, _)| sid != id));
}

#[test]
fn large_output_through_pty() {
    let fx = fixture();
    let id = "ut-lines";
    let script = "i=1; while [ $i -le 20000 ]; do echo \"line $i\"; i=$((i+1)); done; sleep 0.3";
    let info = fx.core.start(spec(id), plan(&["-c", script]), 8 << 20).unwrap();
    assert!(info.pid.is_some());
    let streamed = fx.attach_recorder(id);
    assert!(fx.core.wait_exit(id, Duration::from_secs(90)).unwrap(), "process did not exit");
    assert!(fx.core.wait_output_eof(id, Duration::from_secs(10)).unwrap(), "reader did not reach EOF");
    let info = fx.core.info(id).unwrap();
    assert_eq!(info.state, SessionState::Exited { code: Some(0) });
    assert!(info.bytes_out > 20000 * 6);
    let text = fx.core.output_text(id).unwrap();
    assert!(text.contains("line 20000"), "ring text tail: {:?}", &text[text.len().saturating_sub(300)..]);
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
fn interactive_input_round_trip() {
    let fx = fixture();
    let id = "ut-input";
    fx.core.start(spec(id), plan(&[]), 1 << 20).unwrap();
    let text = fx.wait_text(id, Duration::from_secs(30), |t| t.contains("gk-prompt$"));
    assert!(text.contains("gk-prompt$"), "no prompt: {text:?}");

    fx.core.write(id, b"echo hello-altera\r".to_vec()).unwrap();
    // Once echoed by the tty as typed input, once as command output.
    let text = fx.wait_text(id, Duration::from_secs(20), |t| t.matches("hello-altera").count() >= 2);
    assert!(text.matches("hello-altera").count() >= 2, "output: {text:?}");

    fx.core.resize(id, 100, 20).unwrap();
    fx.core.resize(id, 100, 20).unwrap();
    fx.core.resize(id, 0, 0).unwrap();

    let huge = vec![b'a'; MAX_INPUT_QUEUE + 1];
    assert!(matches!(fx.core.write(id, huge), Err(AppError::Invalid(m)) if m.contains("input queue full")));
    assert!(matches!(fx.core.start(spec(id), plan(&[]), 1 << 20), Err(AppError::Invalid(_))));
    assert!(matches!(fx.core.remove(id), Err(AppError::Invalid(_))));

    fx.core.write(id, b"exit\r".to_vec()).unwrap();
    assert!(fx.core.wait_exit(id, Duration::from_secs(20)).unwrap(), "sh did not exit");
    assert_eq!(fx.core.info(id).unwrap().state, SessionState::Exited { code: Some(0) });

    // Restart with the same id replaces the exited entry.
    fx.core.start(spec(id), plan(&["-c", "exit 3"]), 256 * 1024).unwrap();
    assert!(fx.core.wait_exit(id, Duration::from_secs(20)).unwrap());
    assert_eq!(fx.core.info(id).unwrap().state, SessionState::Exited { code: Some(3) });
    assert_eq!(fx.core.list().len(), 1);
}

#[test]
fn force_stop_kills_whole_tree() {
    let fx = fixture();
    let id = "ut-tree";
    fx.core.start(spec(id), plan(&["-c", "sleep 60 & sleep 60"]), 256 * 1024).unwrap();
    let deadline = Instant::now() + Duration::from_secs(30);
    let mut count = 0;
    while Instant::now() < deadline {
        count = fx.core.job_process_count(id).unwrap().expect("session has a container");
        if count >= 2 {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    assert!(count >= 2, "background child never appeared in the session (count {count})");

    let t = Instant::now();
    fx.core.stop(id, true).unwrap();
    assert!(t.elapsed() < Duration::from_secs(2), "stop must not wait for the exit: {:?}", t.elapsed());
    assert!(fx.core.wait_exit(id, Duration::from_secs(10)).unwrap());
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let n = fx.core.job_process_count(id).unwrap().unwrap();
        if n == 0 {
            break;
        }
        assert!(Instant::now() < deadline, "{n} processes still alive in the session");
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(matches!(fx.core.info(id).unwrap().state, SessionState::Exited { .. }));
    assert!(fx.states(id).contains(&SessionState::Stopping));
}

#[test]
fn orphans_are_reaped_after_the_root_exits() {
    let fx = fixture();
    let id = "ut-orphan";
    // The root exits at once; its background child ignores the SIGHUP the kernel sends the tty's
    // foreground group when the session leader exits, so it would outlive the session.
    fx.core.start(spec(id), plan(&["-c", "(trap '' HUP; exec sleep 60) & sleep 0.3; exit 0"]), 256 * 1024).unwrap();
    assert!(fx.core.wait_exit(id, Duration::from_secs(10)).unwrap());
    // ORPHAN_GRACE (2 s), then the container is terminated by the waiter.
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let n = fx.core.job_process_count(id).unwrap().unwrap();
        if n == 0 {
            break;
        }
        assert!(Instant::now() < deadline, "orphan still alive ({n})");
        std::thread::sleep(Duration::from_millis(100));
    }
    assert!(fx.core.wait_output_eof(id, Duration::from_secs(10)).unwrap());
}

#[test]
fn graceful_stop_closes_interactive_shell() {
    let fx = fixture();
    let id = "ut-graceful";
    fx.core.start(spec(id), plan(&[]), 1 << 20).unwrap();
    fx.wait_text(id, Duration::from_secs(30), |t| t.contains("gk-prompt$"));
    let t = Instant::now();
    fx.core.stop(id, false).unwrap();
    assert!(t.elapsed() < Duration::from_millis(500), "stop must not block");
    assert_eq!(fx.core.info(id).unwrap().state, SessionState::Stopping);
    // Ctrl+C does not end an idle shell; SIGHUP (after 2 s) does.
    assert!(fx.core.wait_exit(id, Duration::from_secs(10)).unwrap(), "graceful stop did not end the shell");
    assert!(fx.core.wait_output_eof(id, Duration::from_secs(10)).unwrap());
    assert!(matches!(fx.core.info(id).unwrap().state, SessionState::Exited { .. }));
}

#[test]
fn launch_failures_are_reported() {
    let fx = fixture();
    let mut p = plan(&[]);
    p.program = PathBuf::from("no-such-program-altera-xyz");
    let err = fx.core.start(spec("ut-missing"), p, 256 * 1024).unwrap_err();
    assert!(matches!(err, AppError::MissingExecutable(_)), "{err:?}");
    assert!(matches!(fx.core.info("ut-missing").unwrap().state, SessionState::Failed { .. }));

    let mut p = plan(&["-c", "exit 0"]);
    p.cwd = PathBuf::from("/definitely/not/here/altera");
    match fx.core.start(spec("ut-badcwd"), p, 256 * 1024).unwrap_err() {
        AppError::Invalid(m) => assert!(m.starts_with("Working directory does not exist"), "{m}"),
        other => panic!("unexpected {other:?}"),
    }
    fx.core.remove("ut-badcwd").unwrap();
    assert!(matches!(fx.core.info("ut-badcwd"), Err(AppError::NotFound(_))));
}

#[test]
fn replay_on_attach_after_exit() {
    let fx = fixture();
    let id = "ut-replay";
    fx.core.start(spec(id), plan(&["-c", "echo replay-marker-1; echo replay-marker-2; sleep 0.3"]), 256 * 1024).unwrap();
    assert!(fx.core.wait_exit(id, Duration::from_secs(20)).unwrap());
    assert!(fx.core.wait_output_eof(id, Duration::from_secs(10)).unwrap());
    let data = fx.attach_recorder(id);
    let deadline = Instant::now() + Duration::from_secs(5);
    while !text::strip_ansi(&data.lock()).contains("replay-marker-2") && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    let t = text::strip_ansi(&data.lock());
    assert!(t.contains("replay-marker-1") && t.contains("replay-marker-2"), "{t:?}");
    fx.core.clear_buffer(id).unwrap();
    assert_eq!(fx.core.output_text(id).unwrap(), "");
}

#[test]
fn shutdown_all_stops_everything() {
    let fx = fixture();
    for id in ["ut-sd-1", "ut-sd-2"] {
        fx.core.start(spec(id), plan(&[]), 256 * 1024).unwrap();
    }
    // Ignores Ctrl+C and SIGHUP (inherited by sleep): only the final SIGKILL ends it.
    fx.core.start(spec("ut-sd-3"), plan(&["-c", "trap '' HUP INT TERM; sleep 60"]), 256 * 1024).unwrap();
    std::thread::sleep(Duration::from_millis(1000));
    let t = Instant::now();
    fx.core.shutdown_all(Duration::from_millis(1500));
    assert!(t.elapsed() < Duration::from_millis(3500), "shutdown took {:?}", t.elapsed());
    for s in fx.core.list() {
        assert!(matches!(s.state, SessionState::Exited { .. }), "{} is {:?}", s.id, s.state);
    }
    let deadline = Instant::now() + Duration::from_secs(5);
    while fx.core.job_process_count("ut-sd-3").unwrap().unwrap() > 0 {
        assert!(Instant::now() < deadline, "the stubborn session survived shutdown");
        std::thread::sleep(Duration::from_millis(50));
    }
}
