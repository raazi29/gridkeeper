//! Small per-OS pieces that don't belong to one feature module.
//!
//! - [`os`]: `"windows" | "macos" | "linux"` for `app_info`.
//! - [`init_process_env`]: macOS GUI apps start with launchd's minimal `PATH` (`/usr/bin:/bin:...`)
//!   and no `LANG`, so Homebrew / npm / native-installer agents would not be found and shells would
//!   run in the C locale. Called first thing in `run()`, while the process is single-threaded.
//! - [`install_exit_guards`]: Unix has no kill-on-close Job Object, so the host stops its sessions
//!   itself when it is told to terminate (SIGTERM / SIGINT / SIGHUP → normal exit path) and kills
//!   them when the main thread panics. A hard crash can still orphan agents there (see `pty::job`).
//!   Windows: nothing to do.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

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

/// Where agent CLIs and their runtimes usually live on a Mac, beyond launchd's default `PATH`.
#[cfg(target_os = "macos")]
fn mac_path_candidates(home: Option<&Path>) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> =
        ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "/usr/local/sbin", "/opt/local/bin"]
            .iter()
            .map(PathBuf::from)
            .collect();
    if let Some(h) = home {
        for rel in [".local/bin", ".npm-global/bin", ".bun/bin", ".volta/bin", ".cargo/bin"] {
            v.push(h.join(rel));
        }
    }
    v
}

/// See the module docs. Must run before any other thread exists.
pub fn init_process_env() {
    #[cfg(target_os = "macos")]
    {
        let current = std::env::var_os("PATH").unwrap_or_default();
        let candidates = mac_path_candidates(dirs::home_dir().as_deref());
        if let Some(path) = extend_path(&current, &candidates, |p| p.is_dir()) {
            // SAFETY: called at the very start of `run()`, before Tauri, logging or any other thread
            // exists, so nothing reads the environment concurrently.
            unsafe { std::env::set_var("PATH", path) };
        }
        let has_locale = ["LC_ALL", "LC_CTYPE", "LANG"].iter().any(|k| std::env::var_os(k).is_some_and(|v| !v.is_empty()));
        if !has_locale {
            // What Terminal.app and iTerm2 set by default; without it zsh / bash run in the C locale.
            // SAFETY: as above (single-threaded start of `run()`).
            unsafe { std::env::set_var("LANG", "en_US.UTF-8") };
        }
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
}
