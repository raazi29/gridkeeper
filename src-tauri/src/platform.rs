//! Small per-OS pieces that don't belong to one feature module.
//!
//! - [`os`]: `"windows" | "macos" | "linux"` for `app_info`.
//! - [`init_process_env`] (macOS / Linux; nothing on Windows): fixes up the environment of a GUI
//!   launch. Called first thing in `run()` (and by `--gk-self-test`), while the process is still
//!   single-threaded, because it changes environment variables.
//!   * When the app was not started from a terminal (no `TERM`), the user's login shell is asked for
//!     its `PATH` once: `$SHELL -i -l -c 'printf …$PATH…'` in its own session, stdin closed, 5 s
//!     timeout, the way VS Code and terminal emulators resolve a GUI app's environment. launchd starts
//!     macOS apps with `/usr/bin:/bin:/usr/sbin:/sbin`, and Linux desktop launchers miss whatever only
//!     `~/.bashrc` adds (nvm, fnm, mise …). Agent CLIs are started directly, not through a shell, so
//!     they are only found when the host's own `PATH` has them. `GRIDKEEPER_SHELL_PATH=0` turns the
//!     lookup off, `=1` forces it.
//!   * Then well-known tool folders are appended when they exist and are still missing: Homebrew,
//!     `~/.local/bin` (Claude Code's native installer), npm-global, bun, volta, cargo, deno, asdf and
//!     mise shims, fnm's default alias, nvm's default Node version.
//!   * macOS: `LANG=en_US.UTF-8` when no locale is set (what Terminal.app does).
//!   * Linux: `WEBKIT_DISABLE_DMABUF_RENDERER=1` when the NVIDIA proprietary driver is loaded or the app
//!     runs as an AppImage (its bundled WebKitGTK meets the host's Mesa / drivers), unless the variable
//!     is already set either way. WebKitGTK's DMA-BUF renderer shows a blank window on those setups.
//!
//!   What happened is kept in [`env_report`] and logged by [`log_env_report`] once logging is up.
//! - [`install_exit_guards`]: Unix has no kill-on-close Job Object, so the host stops its sessions
//!   itself when it is told to terminate (SIGTERM / SIGINT / SIGHUP → normal exit path) and kills
//!   them when the main thread panics. A hard crash can still orphan agents there (see `pty::job`).
//!   Windows: nothing to do.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

/// The OS this build runs on, as reported to the frontend.
pub fn os() -> &'static str {
    if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

/// Time the login shell gets to print its `PATH` at startup.
pub const SHELL_PATH_TIMEOUT: Duration = Duration::from_secs(5);
/// `0` skips the login-shell `PATH` lookup, `1` forces it (even when started from a terminal).
pub const SHELL_PATH_ENV: &str = "GRIDKEEPER_SHELL_PATH";
/// Set for the login shell while it prints its `PATH`, so startup files can skip slow work.
pub const RESOLVING_ENV: &str = "GRIDKEEPER_RESOLVING_ENVIRONMENT";
/// WebKitGTK switch for its DMA-BUF renderer (blank window with the NVIDIA proprietary driver).
pub const WEBKIT_DMABUF_ENV: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";

const PATH_START: &str = "__GK_PATH_START__";
const PATH_END: &str = "__GK_PATH_END__";
/// Startup files that print more than this before the marker are not worth waiting for.
#[cfg(unix)]
const MAX_SHELL_OUTPUT: usize = 256 * 1024;

/// Outcome of the login-shell `PATH` lookup.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ShellPath {
    /// Not attempted (the reason): started from a terminal, turned off, no usable shell.
    Skipped(String),
    Captured { shell: PathBuf, entries: usize, millis: u64 },
    Failed { shell: PathBuf, error: String },
}

/// What [`init_process_env`] changed.
#[derive(Debug, Clone)]
pub struct EnvReport {
    pub shell_path: ShellPath,
    /// Well-known tool folders appended to `PATH`.
    pub appended: Vec<PathBuf>,
    /// Other variables set for this process, as `NAME=value`.
    pub set_vars: Vec<String>,
}

static REPORT: OnceLock<EnvReport> = OnceLock::new();

/// What [`init_process_env`] did (`None` on Windows, or before it ran).
pub fn env_report() -> Option<&'static EnvReport> {
    REPORT.get()
}

/// Log [`env_report`] (call once logging is initialised).
pub fn log_env_report() {
    let Some(r) = env_report() else { return };
    match &r.shell_path {
        ShellPath::Captured { shell, entries, millis } => {
            tracing::info!(shell = %shell.display(), entries, millis, "PATH taken from the login shell")
        }
        ShellPath::Failed { shell, error } => {
            tracing::warn!(shell = %shell.display(), error = %error, "could not read PATH from the login shell; using the default PATH")
        }
        ShellPath::Skipped(reason) => tracing::info!(reason = %reason, "login shell PATH lookup skipped"),
    }
    if !r.appended.is_empty() {
        let dirs: Vec<String> = r.appended.iter().map(|p| p.display().to_string()).collect();
        tracing::info!(dirs = %dirs.join(", "), "tool folders added to PATH");
    }
    if !r.set_vars.is_empty() {
        tracing::info!(vars = %r.set_vars.join(", "), "environment set for this process");
    }
}

/// `current` plus every candidate directory that exists and is not already listed (appended, so
/// the user's own order wins). `None` when nothing changes.
pub fn extend_path(current: &OsStr, candidates: &[PathBuf], exists: impl Fn(&Path) -> bool) -> Option<OsString> {
    let mut dirs: Vec<PathBuf> = std::env::split_paths(current).filter(|p| !p.as_os_str().is_empty()).collect();
    let before = dirs.len();
    for c in candidates {
        if !dirs.iter().any(|d| d == c) && exists(c) {
            dirs.push(c.clone());
        }
    }
    if dirs.len() == before {
        return None;
    }
    std::env::join_paths(dirs).ok()
}

/// `first` (the login shell's entries, in its order) followed by the entries of `current` it lacks.
/// Empty and relative entries are dropped: a GUI app's working directory means nothing.
pub fn merge_path(first: &[PathBuf], current: &OsStr) -> OsString {
    let mut dirs: Vec<PathBuf> = Vec::new();
    for p in first.iter().cloned().chain(std::env::split_paths(current)) {
        if p.has_root() && !dirs.contains(&p) {
            dirs.push(p);
        }
    }
    std::env::join_paths(dirs).unwrap_or_else(|_| current.to_os_string())
}

/// `None` when the login shell should be asked for its `PATH`, else why not. `term` is `$TERM`
/// (set when started from a terminal, whose `PATH` the app inherits), `setting` is
/// [`SHELL_PATH_ENV`].
pub fn shell_path_skip_reason(term: Option<&OsStr>, setting: Option<&OsStr>) -> Option<&'static str> {
    match setting.and_then(|s| s.to_str()).map(str::trim) {
        Some("0") | Some("false") | Some("off") => return Some("turned off (GRIDKEEPER_SHELL_PATH=0)"),
        Some("1") | Some("true") | Some("on") => return None,
        _ => {}
    }
    if term.is_some_and(|t| !t.is_empty()) {
        return Some("started from a terminal (its PATH is inherited)");
    }
    None
}

/// Arguments that make `shell` print its `PATH` between markers after reading the user's login and
/// interactive startup files. `None` for shells this doesn't know how to ask (csh, nu, xonsh …).
pub fn shell_path_args(shell: &Path) -> Option<Vec<String>> {
    let name = shell.file_name()?.to_str()?.trim_start_matches('-');
    let args: Vec<String> = match name {
        "bash" | "zsh" | "sh" | "dash" | "ash" | "ksh" | "mksh" => {
            vec!["-i".into(), "-l".into(), "-c".into(), format!("printf '%s' \"{PATH_START}$PATH{PATH_END}\"")]
        }
        "fish" => vec![
            "-i".into(),
            "-l".into(),
            "-c".into(),
            format!("printf '%s' '{PATH_START}'(string join : $PATH)'{PATH_END}'"),
        ],
        // -Login must come first (pwsh docs); it runs the POSIX login profiles, then $PROFILE.
        "pwsh" | "pwsh-preview" => vec![
            "-Login".into(),
            "-NoLogo".into(),
            "-NonInteractive".into(),
            "-Command".into(),
            format!("[Console]::Out.Write('{PATH_START}' + $env:PATH + '{PATH_END}')"),
        ],
        _ => return None,
    };
    Some(args)
}

/// The `PATH` a shell printed between the markers (startup files may print anything around it).
/// Unix `:`-separated; only absolute entries, de-duplicated. `None` when there is none.
pub fn parse_shell_path(stdout: &[u8]) -> Option<Vec<PathBuf>> {
    let text = String::from_utf8_lossy(stdout);
    let end = text.rfind(PATH_END)?;
    let start = text[..end].rfind(PATH_START)? + PATH_START.len();
    let mut dirs: Vec<PathBuf> = Vec::new();
    for entry in text[start..end].trim().split(':') {
        let p = PathBuf::from(entry);
        if entry.starts_with('/') && !dirs.contains(&p) {
            dirs.push(p);
        }
    }
    (!dirs.is_empty()).then_some(dirs)
}

/// Ask `shell` for its `PATH` (see the module docs). Returns the entries and how long it took.
/// Tries an interactive login shell first (that is where most users set PATH), then a plain login shell,
/// then a plain shell, within one time budget: some startup files make an interactive shell without a
/// terminal exit before it runs the command (seen on CI images).
#[cfg(unix)]
pub fn capture_shell_path(shell: &Path, timeout: Duration) -> Result<(Vec<PathBuf>, Duration), String> {
    let primary = shell_path_args(shell).ok_or_else(|| format!("{} is not a shell this can ask for PATH", shell.display()))?;
    let mut variants = vec![primary.clone()];
    for drop in [&["-i"][..], &["-i", "-l"][..]] {
        let v: Vec<String> = primary.iter().filter(|a| !drop.contains(&a.as_str())).cloned().collect();
        if v.len() < primary.len() && !variants.contains(&v) {
            variants.push(v);
        }
    }
    let started = std::time::Instant::now();
    let mut last = String::from("no answer");
    for args in variants {
        let left = timeout.saturating_sub(started.elapsed());
        if left.is_zero() {
            break;
        }
        match capture_with_args(shell, &args, left) {
            Ok((dirs, _)) => return Ok((dirs, started.elapsed())),
            Err(e) => last = e,
        }
    }
    Err(last)
}

#[cfg(unix)]
fn capture_with_args(shell: &Path, args: &[String], timeout: Duration) -> Result<(Vec<PathBuf>, Duration), String> {
    use std::io::Read;
    use std::os::fd::AsRawFd;
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};
    use std::time::Instant;

    let started = Instant::now();
    let deadline = started + timeout;
    let mut cmd = Command::new(shell);
    // The same opt-outs fix-path-env / shell-env pass: no oh-my-zsh update prompt, no tmux autostart.
    cmd.args(args)
        .env(RESOLVING_ENV, "1")
        .env("DISABLE_AUTO_UPDATE", "true")
        .env("ZSH_TMUX_AUTOSTART", "false")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    // Own session: no controlling terminal (an interactive shell must neither grab nor stop on the
    // parent's tty), and one process group to kill on timeout.
    // SAFETY: setsid(2) is async-signal-safe and touches no memory of the parent.
    unsafe {
        cmd.pre_exec(|| if libc::setsid() == -1 { Err(std::io::Error::last_os_error()) } else { Ok(()) });
    }
    let mut child = cmd.spawn().map_err(|e| format!("could not start {}: {e}", shell.display()))?;
    let pid = child.id() as libc::pid_t;
    let kill_group = |child: &mut std::process::Child| {
        // SAFETY: plain signal to the process group we created (pgid = pid after setsid).
        unsafe { libc::killpg(pid, libc::SIGKILL) };
        let _ = child.wait();
    };

    // Read on this thread with poll(2): init_process_env must stay single-threaded.
    let mut out = Vec::new();
    if let Some(mut stdout) = child.stdout.take() {
        let fd = stdout.as_raw_fd();
        let mut chunk = [0u8; 8192];
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                break;
            }
            let mut pfd = libc::pollfd { fd, events: libc::POLLIN, revents: 0 };
            let ms = left.as_millis().clamp(1, i32::MAX as u128) as libc::c_int;
            // SAFETY: one valid pollfd, count 1.
            let rc = unsafe { libc::poll(&mut pfd, 1, ms) };
            if rc < 0 {
                if std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted {
                    continue;
                }
                break;
            }
            if rc == 0 {
                break;
            }
            match stdout.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => {
                    out.extend_from_slice(&chunk[..n]);
                    // Done once the end marker arrived (the shell may keep the pipe open briefly).
                    if out.len() > MAX_SHELL_OUTPUT || parse_shell_path(&out).is_some() {
                        break;
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
    }
    let found = parse_shell_path(&out);
    // Give the shell a moment to exit on its own once it answered; then (or on timeout) kill it.
    let wait_until = if found.is_some() { deadline.min(Instant::now() + Duration::from_millis(500)) } else { deadline };
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < wait_until => std::thread::sleep(Duration::from_millis(10)),
            _ => {
                kill_group(&mut child);
                break;
            }
        }
    }
    let took = started.elapsed();
    match found {
        Some(dirs) => Ok((dirs, took)),
        None if took >= timeout => Err(format!("no answer within {} ms", timeout.as_millis())),
        None => Err("the shell exited without printing PATH".into()),
    }
}

/// Folders where agent CLIs and their runtimes usually live, beyond a GUI app's default `PATH`.
/// `os` is [`os()`]'s value (explicit so every platform's list is testable anywhere).
pub fn tool_dir_candidates(os: &str, home: Option<&Path>) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = Vec::new();
    match os {
        "macos" => v.extend(
            ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "/usr/local/sbin", "/opt/local/bin"].map(PathBuf::from),
        ),
        "linux" => v.push(PathBuf::from("/home/linuxbrew/.linuxbrew/bin")),
        _ => return v,
    }
    if let Some(h) = home {
        for rel in [
            ".local/bin", // Claude Code native installer, pipx, uv tools
            ".npm-global/bin",
            ".bun/bin",
            ".volta/bin",
            ".cargo/bin",
            ".deno/bin",
            ".asdf/shims",
            ".local/share/mise/shims",
            ".local/share/fnm/aliases/default/bin",
            ".fnm/aliases/default/bin",
        ] {
            v.push(h.join(rel));
        }
        if os == "macos" {
            v.push(h.join("Library/pnpm/bin")); // pnpm 9+
            v.push(h.join("Library/pnpm"));
            v.push(h.join("Library/Application Support/fnm/aliases/default/bin"));
        } else {
            v.push(h.join(".local/share/pnpm/bin"));
            v.push(h.join(".local/share/pnpm"));
            v.push(h.join(".linuxbrew/bin"));
        }
        if let Some(bin) = nvm_default_bin(h) {
            v.push(bin);
        }
    }
    v
}

/// `~/.nvm/versions/node/<version>/bin` for nvm's default alias (newest installed version when the
/// alias is missing or symbolic, like `lts/*` or `node`).
fn nvm_default_bin(home: &Path) -> Option<PathBuf> {
    let nvm = home.join(".nvm");
    let versions = nvm.join("versions").join("node");
    let installed: Vec<String> = std::fs::read_dir(&versions)
        .ok()?
        .filter_map(|e| e.ok()?.file_name().into_string().ok())
        .collect();
    let alias = std::fs::read_to_string(nvm.join("alias").join("default")).ok();
    let pick = pick_nvm_version(&installed, alias.as_deref())?;
    Some(versions.join(pick).join("bin"))
}

/// Numeric parts of `v22.11.0` / `22.11` / `v22`; `None` when it isn't a version.
fn version_parts(s: &str) -> Option<Vec<u64>> {
    let parts: Option<Vec<u64>> = s.trim().trim_start_matches('v').split('.').map(|p| p.parse().ok()).collect();
    parts.filter(|p| !p.is_empty() && p.len() <= 3)
}

/// The installed nvm version (`v22.11.0` folder name) that `alias` selects: the newest one matching a
/// numeric alias (`22`, `v22.11`, `22.11.0`), else the newest installed.
pub fn pick_nvm_version(installed: &[String], alias: Option<&str>) -> Option<String> {
    let mut versions: Vec<(Vec<u64>, &String)> =
        installed.iter().filter(|n| n.starts_with('v')).filter_map(|n| version_parts(n).map(|p| (p, n))).collect();
    versions.sort();
    if let Some(want) = alias.and_then(version_parts) {
        if let Some((_, name)) = versions.iter().rev().find(|(p, _)| p.starts_with(&want)) {
            return Some((*name).clone());
        }
    }
    versions.last().map(|(_, n)| (*n).clone())
}

/// Whether WebKitGTK's DMA-BUF renderer should be turned off for this process: the NVIDIA proprietary
/// driver is loaded, or this is an AppImage (WebKitGTK from the build machine on the user's graphics
/// stack), and the user did not set the variable either way. It costs the faster rendering path
/// (shared-memory compositing instead), which is why it is not unconditional.
pub fn want_dmabuf_workaround(nvidia_proprietary: bool, appimage: bool, already_set: bool) -> bool {
    (nvidia_proprietary || appimage) && !already_set
}

/// See the module docs. Must run before any other thread exists. Windows: does nothing.
pub fn init_process_env() {
    #[cfg(unix)]
    {
        let report = unix_env::apply();
        let _ = REPORT.set(report);
    }
}

#[cfg(unix)]
mod unix_env {
    use super::*;

    pub fn apply() -> EnvReport {
        let current = std::env::var_os("PATH").unwrap_or_default();
        let skip = shell_path_skip_reason(std::env::var_os("TERM").as_deref(), std::env::var_os(SHELL_PATH_ENV).as_deref());
        let (shell_path, mut path) = match skip {
            Some(reason) => (ShellPath::Skipped(reason.into()), current.clone()),
            None => match crate::adapters::login_shell() {
                None => (ShellPath::Skipped("no login shell found".into()), current.clone()),
                Some(exe) => match capture_shell_path(&exe.path, SHELL_PATH_TIMEOUT) {
                    Ok((dirs, took)) => {
                        let merged = merge_path(&dirs, &current);
                        let millis = took.as_millis() as u64;
                        (ShellPath::Captured { shell: exe.path, entries: dirs.len(), millis }, merged)
                    }
                    Err(error) => (ShellPath::Failed { shell: exe.path, error }, current.clone()),
                },
            },
        };

        let mut appended = Vec::new();
        let candidates = tool_dir_candidates(os(), dirs::home_dir().as_deref());
        if let Some(extended) = extend_path(&path, &candidates, |p| p.is_dir()) {
            let before: Vec<PathBuf> = std::env::split_paths(&path).collect();
            appended = std::env::split_paths(&extended).filter(|p| !before.contains(p)).collect();
            path = extended;
        }
        if path != current {
            // SAFETY: called at the very start of `run()` (or of the self-test), before Tauri, logging or
            // any other thread exists, so nothing reads the environment concurrently.
            unsafe { std::env::set_var("PATH", &path) };
        }

        let mut set_vars = Vec::new();
        #[cfg(target_os = "macos")]
        {
            let has_locale =
                ["LC_ALL", "LC_CTYPE", "LANG"].iter().any(|k| std::env::var_os(k).is_some_and(|v| !v.is_empty()));
            if !has_locale {
                // What Terminal.app and iTerm2 set by default; without it zsh / bash run in the C locale.
                // SAFETY: as above (single-threaded start).
                unsafe { std::env::set_var("LANG", "en_US.UTF-8") };
                set_vars.push("LANG=en_US.UTF-8".to_string());
            }
        }
        #[cfg(target_os = "linux")]
        {
            // /proc/driver/nvidia exists only with the proprietary driver (not nouveau).
            let nvidia = Path::new("/proc/driver/nvidia/version").exists();
            let appimage = std::env::var_os("APPIMAGE").is_some_and(|v| !v.is_empty());
            if want_dmabuf_workaround(nvidia, appimage, std::env::var_os(WEBKIT_DMABUF_ENV).is_some()) {
                // SAFETY: as above (single-threaded start, before GTK / WebKitGTK initialise).
                unsafe { std::env::set_var(WEBKIT_DMABUF_ENV, "1") };
                set_vars.push(format!("{WEBKIT_DMABUF_ENV}=1"));
            }
        }
        EnvReport { shell_path, appended, set_vars }
    }
}

/// See the module docs.
pub fn install_exit_guards(app: &tauri::AppHandle) {
    #[cfg(unix)]
    unix::install(app);
    #[cfg(not(unix))]
    let _ = app;
}

#[cfg(unix)]
mod unix {
    use std::sync::atomic::{AtomicI32, Ordering};
    use std::time::Duration;

    /// Write end of the self-pipe the signal handler pokes (-1 until installed).
    static SIGNAL_PIPE_W: AtomicI32 = AtomicI32::new(-1);

    extern "C" fn on_signal(sig: libc::c_int) {
        // Only async-signal-safe calls here: an atomic load and write(2).
        let fd = SIGNAL_PIPE_W.load(Ordering::Relaxed);
        if fd >= 0 {
            let b = sig as u8;
            // SAFETY: writing one byte from a stack variable to a pipe we own.
            unsafe { libc::write(fd, (&b as *const u8).cast(), 1) };
        }
    }

    pub fn install(app: &tauri::AppHandle) {
        // A main-thread panic ends the app; session threads catch their own panics (spawn_guarded),
        // so only the main thread's panics may take the sessions down with them.
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            if std::thread::current().name() == Some("main") {
                let n = crate::pty::kill_all_sessions();
                eprintln!("gridkeeper: main thread panicked; killed {n} session(s)");
            }
            previous(info);
        }));

        let mut fds = [-1 as libc::c_int; 2];
        // SAFETY: pipe(2) fills the two-element array; both ends get FD_CLOEXEC so session
        // processes never inherit them.
        let ok = unsafe {
            libc::pipe(fds.as_mut_ptr()) == 0
                && libc::fcntl(fds[0], libc::F_SETFD, libc::FD_CLOEXEC) == 0
                && libc::fcntl(fds[1], libc::F_SETFD, libc::FD_CLOEXEC) == 0
        };
        if !ok {
            tracing::warn!(error = %std::io::Error::last_os_error(), "could not install termination signal handlers");
            return;
        }
        SIGNAL_PIPE_W.store(fds[1], Ordering::Release);
        for sig in [libc::SIGTERM, libc::SIGINT, libc::SIGHUP] {
            // SAFETY: a zeroed sigaction with a plain handler, an empty mask and SA_RESTART is valid.
            unsafe {
                let mut sa: libc::sigaction = std::mem::zeroed();
                sa.sa_sigaction = on_signal as extern "C" fn(libc::c_int) as libc::sighandler_t;
                sa.sa_flags = libc::SA_RESTART;
                libc::sigemptyset(&mut sa.sa_mask);
                libc::sigaction(sig, &sa, std::ptr::null_mut());
            }
        }

        let app = app.clone();
        let read_fd = fds[0];
        let spawned = std::thread::Builder::new().name("signal-watch".into()).spawn(move || {
            let mut sig = 0u8;
            loop {
                // SAFETY: reading one byte into a stack variable from our own pipe.
                let n = unsafe { libc::read(read_fd, (&mut sig as *mut u8).cast(), 1) };
                if n == 1 {
                    break;
                }
                if n < 0 && std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted {
                    continue;
                }
                return;
            }
            tracing::warn!(signal = sig, "termination signal received; stopping sessions and exiting");
            // Normal path: ExitRequested → Exit → AppCtx::shutdown → shutdown_all (1.5 s).
            app.exit(0);
            // If the event loop never gets there, don't leave the agents behind.
            std::thread::sleep(Duration::from_secs(5));
            let n = crate::pty::kill_all_sessions();
            tracing::error!(sessions = n, "exit did not complete in time; killed the remaining sessions");
            std::process::exit(128 + i32::from(sig));
        });
        if let Err(e) = spawned {
            tracing::warn!(error = %e, "could not start the signal watcher");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn os_name_matches_target() {
        let os = os();
        assert!(["windows", "macos", "linux"].contains(&os));
        assert_eq!(os == "windows", cfg!(windows));
        assert_eq!(os == "macos", cfg!(target_os = "macos"));
    }

    #[test]
    fn extends_path_once_and_in_order() {
        let a = std::env::temp_dir().join("gk-a");
        let b = std::env::temp_dir().join("gk-b");
        let missing = std::env::temp_dir().join("gk-missing");
        let current = std::env::join_paths([a.clone()]).unwrap();
        let exists = |p: &Path| p != missing.as_path();
        let got = extend_path(&current, &[a.clone(), missing.clone(), b.clone()], exists).unwrap();
        let dirs: Vec<PathBuf> = std::env::split_paths(&got).collect();
        assert_eq!(dirs, vec![a.clone(), b.clone()]);
        // Nothing new → None (PATH left untouched).
        assert!(extend_path(&got, &[a, b], exists).is_none());
        // Empty PATH entries are dropped, not kept as "current directory".
        let empty = OsString::new();
        let only = extend_path(&empty, std::slice::from_ref(&missing), |_| true).unwrap();
        assert_eq!(std::env::split_paths(&only).collect::<Vec<_>>(), vec![missing]);
    }

    #[test]
    fn merge_puts_the_shell_path_first_and_keeps_the_rest() {
        let a = std::env::temp_dir().join("gk-shell-a");
        let b = std::env::temp_dir().join("gk-shell-b");
        let c = std::env::temp_dir().join("gk-current-c");
        let current = std::env::join_paths([c.clone(), a.clone(), PathBuf::from("relative")]).unwrap();
        let merged = merge_path(&[a.clone(), b.clone(), a.clone()], &current);
        assert_eq!(std::env::split_paths(&merged).collect::<Vec<_>>(), vec![a, b, c]);
    }

    #[test]
    fn skip_reason() {
        let os = |s: &str| OsString::from(s);
        assert_eq!(shell_path_skip_reason(None, None), None);
        assert!(shell_path_skip_reason(Some(&os("xterm-256color")), None).is_some());
        assert_eq!(shell_path_skip_reason(Some(&os("")), None), None);
        assert_eq!(shell_path_skip_reason(Some(&os("dumb")), Some(&os("1"))), None);
        assert!(shell_path_skip_reason(None, Some(&os("0"))).is_some());
        assert_eq!(shell_path_skip_reason(None, Some(&os("maybe"))), None);
    }

    #[test]
    fn shell_args_per_shell() {
        let args = |p: &str| shell_path_args(Path::new(p));
        for sh in ["/bin/zsh", "/bin/bash", "/usr/bin/dash", "/bin/sh", "-zsh"] {
            let a = args(sh).unwrap_or_else(|| panic!("{sh}"));
            assert_eq!(&a[..3], ["-i", "-l", "-c"], "{sh}");
            assert!(a[3].contains("$PATH") && a[3].contains(PATH_START) && a[3].contains(PATH_END));
        }
        let fish = args("/opt/homebrew/bin/fish").unwrap();
        assert!(fish[3].contains("string join : $PATH"));
        let pwsh = args("/usr/local/bin/pwsh").unwrap();
        assert_eq!(pwsh[0], "-Login", "pwsh needs -Login first");
        assert!(args("/bin/tcsh").is_none());
        assert!(args("/usr/bin/nu").is_none());
    }

    #[test]
    fn parses_the_marked_path_among_noise() {
        let out = format!(
            "Welcome!\n{PATH_START}stale{PATH_END}\nmore\n{PATH_START}/opt/homebrew/bin:/usr/bin::relative:/usr/bin:/Users/me/.nvm/versions/node/v22.1.0/bin{PATH_END}bye"
        );
        let dirs = parse_shell_path(out.as_bytes()).unwrap();
        let want: Vec<PathBuf> =
            ["/opt/homebrew/bin", "/usr/bin", "/Users/me/.nvm/versions/node/v22.1.0/bin"].map(PathBuf::from).to_vec();
        assert_eq!(dirs, want);
        assert!(parse_shell_path(b"no markers here").is_none());
        assert!(parse_shell_path(format!("{PATH_START}{PATH_END}").as_bytes()).is_none());
        assert!(parse_shell_path(format!("{PATH_START}/usr/bin").as_bytes()).is_none(), "unterminated");
    }

    #[test]
    fn tool_dirs_per_os() {
        let home = std::env::temp_dir().join("gk-no-such-home");
        let mac = tool_dir_candidates("macos", Some(&home));
        assert_eq!(mac[0], PathBuf::from("/opt/homebrew/bin"));
        for rel in [".local/bin", ".asdf/shims", ".local/share/mise/shims", "Library/pnpm"] {
            assert!(mac.contains(&home.join(rel)), "macOS lacks {rel}");
        }
        let linux = tool_dir_candidates("linux", Some(&home));
        assert!(linux.contains(&home.join(".local/bin")) && linux.contains(&home.join(".local/share/pnpm")));
        assert!(!linux.contains(&PathBuf::from("/opt/homebrew/bin")));
        assert!(tool_dir_candidates("windows", Some(&home)).is_empty());
    }

    #[test]
    fn nvm_version_pick() {
        let installed: Vec<String> = ["v18.20.4", "v22.11.0", "v22.2.0", "v20.18.0", "system", "v9.x"].map(String::from).to_vec();
        let pick = |a: Option<&str>| pick_nvm_version(&installed, a);
        assert_eq!(pick(Some("22\n")).as_deref(), Some("v22.11.0"));
        assert_eq!(pick(Some("v20")).as_deref(), Some("v20.18.0"));
        assert_eq!(pick(Some("22.2")).as_deref(), Some("v22.2.0"));
        assert_eq!(pick(Some("v18.20.4")).as_deref(), Some("v18.20.4"));
        assert_eq!(pick(Some("lts/*")).as_deref(), Some("v22.11.0"), "symbolic alias → newest");
        assert_eq!(pick(Some("16")).as_deref(), Some("v22.11.0"), "uninstalled alias → newest");
        assert_eq!(pick(None).as_deref(), Some("v22.11.0"));
        assert_eq!(pick_nvm_version(&[], Some("22")), None);
    }

    #[test]
    fn nvm_default_bin_from_disk() {
        let home = tempfile::tempdir().unwrap();
        assert!(nvm_default_bin(home.path()).is_none());
        let versions = home.path().join(".nvm/versions/node");
        for v in ["v20.1.0", "v22.3.0"] {
            std::fs::create_dir_all(versions.join(v).join("bin")).unwrap();
        }
        assert_eq!(nvm_default_bin(home.path()), Some(versions.join("v22.3.0").join("bin")));
        std::fs::create_dir_all(home.path().join(".nvm/alias")).unwrap();
        std::fs::write(home.path().join(".nvm/alias/default"), "20\n").unwrap();
        assert_eq!(nvm_default_bin(home.path()), Some(versions.join("v20.1.0").join("bin")));
    }

    #[test]
    fn dmabuf_workaround_decision() {
        assert!(want_dmabuf_workaround(true, false, false));
        assert!(want_dmabuf_workaround(false, true, false), "AppImage");
        assert!(!want_dmabuf_workaround(true, true, true), "the user's own setting wins");
        assert!(!want_dmabuf_workaround(false, false, false));
    }

    #[cfg(unix)]
    #[test]
    fn captures_path_from_a_real_shell() {
        let (dirs, took) = capture_shell_path(Path::new("/bin/sh"), Duration::from_secs(10)).expect("sh answers");
        assert!(!dirs.is_empty());
        assert!(dirs.iter().all(|d| d.is_absolute()));
        assert!(took < Duration::from_secs(10));
    }

    #[cfg(unix)]
    #[test]
    fn capture_times_out_and_kills_the_shell() {
        // A "shell" that never answers: a script named sh (so it gets sh's arguments) that sleeps.
        let dir = tempfile::tempdir().unwrap();
        let fake = dir.path().join("sh");
        std::fs::write(&fake, "#!/bin/sh\nsleep 30\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        let t = std::time::Instant::now();
        let err = capture_shell_path(&fake, Duration::from_millis(500)).unwrap_err();
        assert!(err.contains("no answer"), "{err}");
        assert!(t.elapsed() < Duration::from_secs(5), "{:?}", t.elapsed());
    }
}
