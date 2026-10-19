//! Smoke tests of the built binary, for CI and for "does it run on my machine?" reports.
//!
//! `gridkeeper --gk-self-test` (dispatched by `main.rs` before anything Tauri-related: no window, no
//! logging setup, no single-instance check) runs, in the order the app needs them:
//! 1. the environment fix-up `run()` does first (`platform::init_process_env`), and on macOS / Linux
//!    an explicit login-shell `PATH` lookup (the step GUI launches depend on);
//! 2. the data folder (`<config dir>/app.gridkeeper.desktop`, or the sandbox folder when
//!    `GRIDKEEPER_SANDBOX` is set): created if missing, a probe file written, read back, removed;
//! 3. the default terminal (the `powershell` adapter: pwsh on Windows, the login shell elsewhere),
//!    planned by the same `resolve_launch` as a real pane, started in a PTY (ConPTY / Unix pty), and
//!    sent a command whose output is a marker the typed text itself does not contain;
//! 4. process containment: a session with a background child and an orphaned grandchild is
//!    force-stopped, and every process in it must be gone (Job Object / POSIX session).
//!
//! It prints one line per check, lists the agent CLIs it finds on `PATH` (information only), and
//! exits 0 when every check passed, 1 otherwise. Release builds on Windows are GUI-subsystem
//! executables: redirect stdout to see the report (`gridkeeper.exe --gk-self-test | Out-String`).
//!
//! `gridkeeper --gk-self-test-gui` starts the real app (as sandbox `self-test` unless
//! `GRIDKEEPER_SANDBOX` is set, so it never touches a normal instance or takes its single-instance
//! lock), waits until the frontend's boot calls `state_load` (window, webview, frontend bundle and
//! the JS → Rust → JS IPC round trip all work, since boot awaits `app_info` first), keeps running two
//! more seconds, then exits 0. No call within `GK_SELF_TEST_TIMEOUT` seconds (default 90) → exit 1.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::pty::SessionCore;
use crate::types::*;

/// argv[1] that selects the headless self-test.
pub const FLAG: &str = "--gk-self-test";
/// argv[1] that selects the window self-test.
pub const GUI_FLAG: &str = "--gk-self-test-gui";
/// Sandbox name the window self-test runs under when none is set.
pub const GUI_SANDBOX: &str = "self-test";
/// Seconds the window self-test waits for the frontend (`GK_SELF_TEST_TIMEOUT` overrides).
pub const GUI_TIMEOUT_ENV: &str = "GK_SELF_TEST_TIMEOUT";
const GUI_TIMEOUT_DEFAULT: Duration = Duration::from_secs(90);

/// What the default shell must print. The command that prints it never contains it literally.
pub const MARKER: &str = "GK_SELFTEST_OK";

/// `main()` entry: runs the headless self-test when argv[1] is [`FLAG`] and returns its exit code.
pub fn main_from_env() -> Option<i32> {
    let first = std::env::args_os().nth(1)?;
    if first != FLAG {
        return None;
    }
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    Some(run(&mut out))
}

struct Report<'a> {
    out: &'a mut dyn Write,
    passed: usize,
    failed: usize,
}

impl Report<'_> {
    fn line(&mut self, tag: &str, name: &str, detail: &str) {
        let _ = writeln!(self.out, "[{tag}] {name}: {detail}");
        let _ = self.out.flush();
    }
    fn ok(&mut self, name: &str, detail: impl AsRef<str>) {
        self.passed += 1;
        self.line("ok", name, detail.as_ref());
    }
    fn fail(&mut self, name: &str, detail: impl AsRef<str>) {
        self.failed += 1;
        self.line("FAIL", name, detail.as_ref());
    }
    fn info(&mut self, name: &str, detail: impl AsRef<str>) {
        self.line("info", name, detail.as_ref());
    }
}

/// Run every check, writing the report to `out`. Returns the process exit code.
pub fn run(out: &mut dyn Write) -> i32 {
    let started = Instant::now();
    let _ = writeln!(
        out,
        "Gridkeeper self-test {} ({} {})",
        env!("CARGO_PKG_VERSION"),
        crate::platform::os(),
        std::env::consts::ARCH
    );
    // What run() does first, while still single-threaded.
    crate::platform::init_process_env();
    let mut r = Report { out, passed: 0, failed: 0 };
    let scratch = std::env::temp_dir().join(format!("gk-self-test-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&scratch);

    check_env(&mut r);
    check_data_dir(&mut r);
    let core = Arc::new(SessionCore::new(|_| {}));
    let shell = check_default_shell(&mut r, &core, &scratch);
    check_containment(&mut r, &core, shell.as_deref());
    list_agents(&mut r);

    core.shutdown_all(Duration::from_millis(1500));
    let _ = std::fs::remove_dir_all(&scratch);
    let verdict = if r.failed == 0 { "PASS" } else { "FAIL" };
    let _ = writeln!(
        r.out,
        "{verdict}: {} passed, {} failed ({:.1} s)",
        r.passed,
        r.failed,
        started.elapsed().as_secs_f64()
    );
    let _ = r.out.flush();
    i32::from(r.failed != 0)
}

fn check_env(r: &mut Report<'_>) {
    let path = std::env::var_os("PATH").unwrap_or_default();
    let entries = std::env::split_paths(&path).filter(|p| !p.as_os_str().is_empty()).count();
    if entries == 0 {
        r.fail("PATH", "empty");
    } else {
        r.ok("PATH", format!("{entries} entries"));
    }
    if let Some(rep) = crate::platform::env_report() {
        let startup = match &rep.shell_path {
            crate::platform::ShellPath::Captured { shell, entries, millis } => {
                format!("taken from {} ({entries} entries, {millis} ms)", shell.display())
            }
            crate::platform::ShellPath::Failed { shell, error } => format!("{} failed: {error}", shell.display()),
            crate::platform::ShellPath::Skipped(why) => format!("skipped: {why}"),
        };
        r.info("startup PATH", startup);
        if !rep.appended.is_empty() {
            let dirs: Vec<String> = rep.appended.iter().map(|p| p.display().to_string()).collect();
            r.info("tool folders added", dirs.join(", "));
        }
        if !rep.set_vars.is_empty() {
            r.info("environment set", rep.set_vars.join(", "));
        }
    }
    #[cfg(unix)]
    {
        // Explicitly, whatever the startup decided: this is what a Dock / desktop launch relies on.
        match crate::adapters::login_shell() {
            None => r.fail("login shell PATH", "no login shell found ($SHELL, passwd, /bin/sh)"),
            Some(exe) if crate::platform::shell_path_args(&exe.path).is_none() => {
                r.info("login shell PATH", format!("{} is not supported; the built-in folder list is used", exe.path.display()))
            }
            Some(exe) => match crate::platform::capture_shell_path(&exe.path, Duration::from_secs(15)) {
                Ok((dirs, took)) => r.ok(
                    "login shell PATH",
                    format!("{} answered in {} ms ({} entries)", exe.path.display(), took.as_millis(), dirs.len()),
                ),
                Err(e) => r.fail("login shell PATH", format!("{}: {e}", exe.path.display())),
            },
        }
    }
}

/// The folder `AppCtx::init` uses: Tauri's app config dir (`dirs::config_dir()/<identifier>`), or the
/// sandbox's folder under it.
fn data_dir() -> Result<PathBuf, String> {
    let base = dirs::config_dir()
        .map(|d| d.join(crate::meter::APP_IDENTIFIER))
        .ok_or_else(|| "the OS reports no config directory".to_string())?;
    match crate::sandbox::parse_env(std::env::var_os(crate::sandbox::ENV))? {
        Some(name) => Ok(crate::sandbox::data_dir(&base, &name)),
        None => Ok(base),
    }
}

fn check_data_dir(r: &mut Report<'_>) {
    let dir = match data_dir() {
        Ok(d) => d,
        Err(e) => return r.fail("data folder", e),
    };
    let probe = dir.join(format!(".gk-self-test-{}", std::process::id()));
    let result = std::fs::create_dir_all(&dir)
        .and_then(|_| std::fs::write(&probe, MARKER))
        .and_then(|_| std::fs::read_to_string(&probe));
    let _ = std::fs::remove_file(&probe);
    match result {
        Ok(text) if text == MARKER => r.ok("data folder", format!("{} (writable)", dir.display())),
        Ok(_) => r.fail("data folder", format!("{}: probe file read back wrong", dir.display())),
        Err(e) => r.fail("data folder", format!("{}: {e}", dir.display())),
    }
}

/// A command for `shell` that prints [`MARKER`] without containing it.
pub fn marker_command(shell: &Path) -> String {
    let stem = shell.file_stem().map(|s| s.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
    match stem.trim_start_matches('-') {
        "pwsh" | "powershell" => "Write-Output ('GK_SELF' + 'TEST_OK')".into(),
        "fish" => "echo GK_SELF''TEST_OK".into(),
        "cmd" => "echo GK_SELF^TEST_OK".into(),
        _ => "echo GK_SELF\"\"TEST_OK".into(),
    }
}

fn wait_for(core: &SessionCore, id: &str, timeout: Duration, pred: impl Fn(&str) -> bool) -> Option<String> {
    let deadline = Instant::now() + timeout;
    loop {
        let text = core.output_text(id).unwrap_or_default();
        if pred(&text) {
            return Some(text);
        }
        if Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn tail(text: &str, max: usize) -> String {
    let t: String = text.chars().rev().take(max).collect::<Vec<_>>().into_iter().rev().collect();
    t.replace(['\r', '\n'], " ⏎ ").trim().to_string()
}

/// The default terminal in a PTY, exactly as a new pane would start it. Returns its program.
fn check_default_shell(r: &mut Report<'_>, core: &SessionCore, scratch: &Path) -> Option<PathBuf> {
    let id = "self-test-shell";
    let cwd = dirs::home_dir().filter(|h| h.is_dir()).unwrap_or_else(std::env::temp_dir);
    let spec = SessionSpec {
        id: id.into(),
        name: "self-test".into(),
        agent: AgentKind::Powershell,
        cwd: cwd.to_string_lossy().into_owned(),
        profile_id: None,
        command: None,
        args: vec![],
        env: vec![],
        resume: ResumeMode::None,
        agent_session_id: None,
        preset: None,
        cols: 120,
        rows: 30,
    };
    let profiles = crate::profiles::ProfileStore::load_with_home(scratch.join("profiles.json"), None);
    let plan = match crate::adapters::resolve_launch(&spec, &profiles, &Settings::default()) {
        Ok(p) => p,
        Err(e) => {
            r.fail("default terminal", format!("not found: {e}"));
            return None;
        }
    };
    r.ok("default terminal", plan.display.clone());
    let program = plan.program.clone();
    let command = marker_command(&program);
    let t = Instant::now();
    if let Err(e) = core.start(spec, plan, 1 << 20) {
        r.fail("pty", format!("could not start the shell: {e}"));
        return Some(program);
    }
    // Let startup files run and a prompt appear before typing (typeahead works too, but some line
    // editors drop it while they initialise).
    let _ = wait_for(core, id, Duration::from_secs(20), |t| !t.trim().is_empty());
    let mut found = None;
    for _ in 0..2 {
        if core.write(id, format!("{command}\r").into_bytes()).is_err() {
            break;
        }
        found = wait_for(core, id, Duration::from_secs(20), |t| t.contains(MARKER));
        if found.is_some() {
            break;
        }
    }
    match found {
        Some(_) => r.ok("pty", format!("the shell ran a typed command and printed the marker ({} ms)", t.elapsed().as_millis())),
        None => {
            let text = core.output_text(id).unwrap_or_default();
            r.fail("pty", format!("no marker from the shell; last output: {:?}", tail(&text, 300)));
        }
    }
    let _ = core.write(id, b"exit\r".to_vec());
    if !core.wait_exit(id, Duration::from_secs(10)).unwrap_or(false) {
        let _ = core.stop(id, true);
        let _ = core.wait_exit(id, Duration::from_secs(10));
    }
    Some(program)
}

#[cfg(unix)]
fn pid_alive(pid: u32) -> bool {
    // SAFETY: signal 0 only checks existence / permission.
    unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
}

/// A session whose root starts a background child and an orphaned grandchild; a forced stop must
/// leave nothing behind.
fn check_containment(r: &mut Report<'_>, core: &SessionCore, shell: Option<&Path>) {
    let id = "self-test-tree";
    #[cfg(unix)]
    let (plan, expect) = {
        let _ = shell;
        let script = "sleep 300 & echo GKPID:$!; (sleep 300 & echo GKPID:$!); echo GKREADY; sleep 300";
        let plan = LaunchPlan {
            display: format!("/bin/sh -c '{script}'"),
            program: PathBuf::from("/bin/sh"),
            args: vec!["-c".into(), script.into()],
            env_set: vec![],
            env_remove: vec![],
            cwd: std::env::temp_dir(),
        };
        (plan, 3u32) // sh, its background child, the orphaned grandchild
    };
    #[cfg(windows)]
    let (plan, expect) = {
        let exe = shell.map(Path::to_path_buf).unwrap_or_else(|| PathBuf::from("powershell.exe"));
        let child = exe.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "powershell.exe".into());
        let script = format!(
            "Start-Process -NoNewWindow '{child}' -ArgumentList '-NoProfile','-Command','Start-Sleep 300'; Write-Output GKREADY; Start-Sleep 300"
        );
        let plan = LaunchPlan {
            display: format!("{} -NoProfile -Command \"{script}\"", exe.display()),
            program: exe,
            args: vec!["-NoProfile".into(), "-Command".into(), script],
            env_set: vec![],
            env_remove: vec![],
            cwd: std::env::temp_dir(),
        };
        (plan, 2u32) // the shell and the process it started
    };
    let spec = SessionSpec {
        id: id.into(),
        name: "self-test containment".into(),
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
    };
    if let Err(e) = core.start(spec, plan, 256 * 1024) {
        return r.fail("containment", format!("could not start the test tree: {e}"));
    }
    if wait_for(core, id, Duration::from_secs(30), |t| t.contains("GKREADY")).is_none() {
        let text = core.output_text(id).unwrap_or_default();
        let _ = core.stop(id, true);
        return r.fail("containment", format!("the test tree did not start; output: {:?}", tail(&text, 300)));
    }
    let count = |core: &SessionCore| core.job_process_count(id).ok().flatten();
    let deadline = Instant::now() + Duration::from_secs(20);
    let mut before = count(core).unwrap_or(0);
    while before < expect && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(100));
        before = count(core).unwrap_or(0);
    }
    if before < expect {
        let _ = core.stop(id, true);
        return r.fail("containment", format!("only {before} of {expect} processes are in the session"));
    }
    #[cfg(unix)]
    let pids: Vec<u32> = core
        .output_text(id)
        .unwrap_or_default()
        .lines()
        .filter_map(|l| l.trim().strip_prefix("GKPID:")?.trim().parse().ok())
        .collect();

    let t = Instant::now();
    if let Err(e) = core.stop(id, true) {
        return r.fail("containment", format!("stop failed: {e}"));
    }
    let _ = core.wait_exit(id, Duration::from_secs(10));
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut left = count(core).unwrap_or(0);
    #[cfg(unix)]
    let mut alive: Vec<u32> = pids.iter().copied().filter(|p| pid_alive(*p)).collect();
    #[cfg(not(unix))]
    let alive: Vec<u32> = Vec::new();
    while (left > 0 || !alive.is_empty()) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
        left = count(core).unwrap_or(0);
        #[cfg(unix)]
        {
            alive.retain(|p| pid_alive(*p));
        }
    }
    if left == 0 && alive.is_empty() {
        r.ok("containment", format!("{before} processes in the session, all gone {} ms after a forced stop", t.elapsed().as_millis()));
    } else {
        r.fail("containment", format!("{left} process(es) still in the session, live pids {alive:?}"));
    }
}

/// Agent CLIs on PATH (information only; nothing is run).
fn list_agents(r: &mut Report<'_>) {
    let found: Vec<String> = ["claude", "codex", "gemini", "opencode", "node", "git"]
        .iter()
        .map(|name| match crate::adapters::discovery::which_exe(name) {
            Some(exe) => format!("{name}={}", exe.path.display()),
            None => format!("{name}=-"),
        })
        .collect();
    r.info("on PATH", found.join("  "));
}

// ---- window self-test ------------------------------------------------------------------------

static GUI_MODE: AtomicBool = AtomicBool::new(false);
static FRONTEND_BOOTED: AtomicBool = AtomicBool::new(false);
static FRONTEND_ERRORS: AtomicU32 = AtomicU32::new(0);

/// Whether argv[1] asks for the window self-test.
pub fn gui_requested() -> bool {
    std::env::args_os().nth(1).is_some_and(|a| a == GUI_FLAG)
}

/// Window self-test, first thing in `run()` (single-threaded, before the sandbox is resolved).
pub fn prepare_gui() {
    GUI_MODE.store(true, Ordering::Release);
    if std::env::var_os(crate::sandbox::ENV).is_none() {
        // SAFETY: called at the start of `run()`, before any other thread exists.
        unsafe { std::env::set_var(crate::sandbox::ENV, GUI_SANDBOX) };
    }
}

/// Whether this process runs the window self-test.
pub fn gui_mode() -> bool {
    GUI_MODE.load(Ordering::Acquire)
}

/// Window self-test: a hard deadline for the whole run, because the watchdog in `setup` only starts
/// once the window exists. Call after the last environment change in `run()` (it starts a thread).
pub fn arm_gui_deadline() {
    if !gui_mode() {
        return;
    }
    let limit = gui_timeout() + Duration::from_secs(30);
    let spawned = std::thread::Builder::new().name("self-test-deadline".into()).spawn(move || {
        std::thread::sleep(limit);
        println!("[FAIL] window: not done after {} s (stuck before or while creating the window)", limit.as_secs());
        println!("FAIL");
        let _ = std::io::stdout().flush();
        std::process::exit(1);
    });
    if let Err(e) = spawned {
        eprintln!("self-test: could not start the deadline timer: {e}");
        std::process::exit(1);
    }
}

/// Called by `state_load`: the frontend booted far enough to call it (after awaiting `app_info`).
pub fn note_frontend_booted() {
    if GUI_MODE.load(Ordering::Acquire) {
        FRONTEND_BOOTED.store(true, Ordering::Release);
    }
}

/// Called by `log_frontend` for error-level messages (uncaught errors, unhandled rejections).
pub fn note_frontend_error() {
    if GUI_MODE.load(Ordering::Acquire) {
        FRONTEND_ERRORS.fetch_add(1, Ordering::Relaxed);
    }
}

fn gui_timeout() -> Duration {
    std::env::var(GUI_TIMEOUT_ENV)
        .ok()
        .and_then(|s| s.trim().parse::<u64>().ok())
        .filter(|s| *s > 0)
        .map(Duration::from_secs)
        .unwrap_or(GUI_TIMEOUT_DEFAULT)
}

/// From `setup`: wait for the frontend, report, exit.
pub fn start_gui_watchdog(app: tauri::AppHandle) {
    if !GUI_MODE.load(Ordering::Acquire) {
        return;
    }
    let started = Instant::now();
    let timeout = gui_timeout();
    let spawned = std::thread::Builder::new().name("self-test-gui".into()).spawn(move || {
        println!("Gridkeeper window self-test {} ({} {})", env!("CARGO_PKG_VERSION"), crate::platform::os(), std::env::consts::ARCH);
        while !FRONTEND_BOOTED.load(Ordering::Acquire) && started.elapsed() < timeout {
            std::thread::sleep(Duration::from_millis(50));
        }
        let code = if FRONTEND_BOOTED.load(Ordering::Acquire) {
            println!("[ok] window: webview up; the frontend called state_load after {} ms", started.elapsed().as_millis());
            // Keep rendering a moment so a crash right after boot still fails the run.
            std::thread::sleep(Duration::from_secs(2));
            let errors = FRONTEND_ERRORS.load(Ordering::Relaxed);
            println!("[info] frontend errors logged: {errors} (details in the sandbox log folder)");
            println!("PASS");
            0
        } else {
            println!("[FAIL] window: no IPC call from the frontend within {} s", timeout.as_secs());
            println!("FAIL");
            1
        };
        let _ = std::io::stdout().flush();
        app.exit(code);
        // If the event loop does not end by itself, don't hang CI.
        std::thread::sleep(Duration::from_secs(10));
        std::process::exit(code);
    });
    if let Err(e) = spawned {
        eprintln!("self-test: could not start the watchdog: {e}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marker_commands_never_contain_the_marker() {
        for shell in ["/bin/zsh", "/bin/bash", "/bin/sh", "/usr/bin/fish", "pwsh.exe", "C:\\Windows\\powershell.exe", "cmd.exe", "-zsh"] {
            let c = marker_command(Path::new(shell));
            assert!(!c.contains(MARKER), "{shell}: {c}");
            assert!(c.contains("GK_SELF") && c.contains("TEST_OK"), "{shell}: {c}");
        }
        assert!(marker_command(Path::new("/opt/homebrew/bin/pwsh")).starts_with("Write-Output"));
    }

    #[test]
    fn data_dir_follows_the_sandbox_rules() {
        // Without GRIDKEEPER_SANDBOX in the test environment this is the normal folder.
        if std::env::var_os(crate::sandbox::ENV).is_none() {
            let d = data_dir().unwrap();
            assert!(d.ends_with(crate::meter::APP_IDENTIFIER), "{}", d.display());
        }
    }

    #[test]
    fn gui_hooks_are_inert_outside_gui_mode() {
        // GUI_MODE is never set by unit tests.
        note_frontend_booted();
        note_frontend_error();
        assert!(!FRONTEND_BOOTED.load(Ordering::Acquire));
        assert_eq!(FRONTEND_ERRORS.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn tail_keeps_the_end_on_one_line() {
        assert_eq!(tail("a\r\nb\nccc", 4), "⏎ ccc");
        assert_eq!(tail("", 10), "");
    }

    /// The whole headless self-test against this machine (PTY, shell, containment). The data folder
    /// check creates and removes a probe file in the real config folder.
    #[test]
    #[ignore = "starts the default shell; run with --ignored (CI runs the built binary instead)"]
    fn full_self_test() {
        let mut out = Vec::new();
        let code = run(&mut out);
        let text = String::from_utf8_lossy(&out);
        println!("{text}");
        assert_eq!(code, 0, "{text}");
    }
}
