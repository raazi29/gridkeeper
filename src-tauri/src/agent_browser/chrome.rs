//! Find and start the shared browser (Microsoft Edge, Google Chrome or Chromium) with the DevTools
//! protocol on two pipes instead of a port.
//!
//! - **Windows**: two anonymous pipes; the child's ends are made inheritable and passed both as
//!   `--remote-debugging-io-pipes=<read>,<write>` (inherited handles keep their values; current
//!   Chromium) and as CRT file descriptors 3 and 4 through `STARTUPINFO.lpReserved2` (what Node /
//!   Playwright do; older Chromium). `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` limits inheritance to those
//!   two handles. The process starts suspended, joins its own kill-on-close Job Object, then resumes:
//!   if Gridkeeper dies, the kernel kills the browser tree.
//! - **macOS / Linux**: `pipe(2)` + `dup2` onto fds 3 and 4 in the child, which also calls `setsid`
//!   so the browser leads its own POSIX session (the session container from `crate::pty`, also
//!   killed by the host's exit guards).
//!
//! The profile lives in `<data>\agent-browser\profile` (never the user's own browser profile; Chrome
//! 136+ refuses remote debugging of the default profile anyway).

use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::pty::ProcessContainer;

/// Viewport of every agent tab (CSS pixels).
pub const WINDOW_SIZE: (u32, u32) = (1280, 800);

/// Locate a browser. `override_path` (config `browserPath`) wins when it exists.
pub fn find_browser(override_path: Option<&str>) -> Option<PathBuf> {
    if let Some(p) = override_path.map(str::trim).filter(|p| !p.is_empty()) {
        let p = PathBuf::from(p);
        return p.is_file().then_some(p);
    }
    candidates().into_iter().find(|p| p.is_file())
}

#[cfg(windows)]
fn candidates() -> Vec<PathBuf> {
    let mut bases: Vec<PathBuf> = Vec::new();
    for var in ["ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA"] {
        if let Some(v) = std::env::var_os(var).filter(|v| !v.is_empty()) {
            bases.push(PathBuf::from(v));
        }
    }
    let mut v = Vec::new();
    for suffix in [r"Microsoft\Edge\Application\msedge.exe", r"Google\Chrome\Application\chrome.exe", r"Chromium\Application\chrome.exe"] {
        for b in &bases {
            v.push(b.join(suffix));
        }
    }
    for name in ["msedge", "chrome"] {
        if let Ok(p) = which::which(name) {
            v.push(p);
        }
    }
    v
}

#[cfg(target_os = "macos")]
fn candidates() -> Vec<PathBuf> {
    let apps = [
        "Google Chrome.app/Contents/MacOS/Google Chrome",
        "Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "Chromium.app/Contents/MacOS/Chromium",
    ];
    let mut v: Vec<PathBuf> = apps.iter().map(|a| Path::new("/Applications").join(a)).collect();
    if let Some(home) = dirs::home_dir() {
        v.extend(apps.iter().map(|a| home.join("Applications").join(a)));
    }
    v
}

#[cfg(all(unix, not(target_os = "macos")))]
fn candidates() -> Vec<PathBuf> {
    let mut v = Vec::new();
    for name in ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser", "microsoft-edge-stable", "microsoft-edge"] {
        if let Ok(p) = which::which(name) {
            v.push(p);
        }
    }
    v.push(PathBuf::from("/opt/google/chrome/chrome"));
    v.push(PathBuf::from("/opt/microsoft/msedge/msedge"));
    v
}

/// Short product name for the UI.
pub fn label(exe: &Path) -> &'static str {
    let s = exe.to_string_lossy().to_ascii_lowercase();
    if s.contains("edge") {
        "Microsoft Edge"
    } else if s.contains("chromium") {
        "Chromium"
    } else if s.contains("chrome") {
        "Google Chrome"
    } else {
        "Chromium-based browser"
    }
}

/// Command-line switches (without the pipe handles, which `launch` adds on Windows).
pub fn launch_args(profile: &Path, headless: bool) -> Vec<String> {
    let mut a: Vec<String> = [
        "--remote-debugging-pipe",
        "--no-first-run",
        "--no-default-browser-check",
        "--no-startup-window",
        "--disable-sync",
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-default-apps",
        "--disable-extensions",
        "--disable-component-extensions-with-background-pages",
        "--disable-breakpad",
        "--disable-crash-reporter",
        "--disable-field-trial-config",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--disable-hang-monitor",
        "--disable-prompt-on-repost",
        "--disable-search-engine-choice-screen",
        "--disable-infobars",
        "--disable-edgeupdater",
        "--edge-skip-compat-layer-relaunch",
        "--no-service-autorun",
        "--metrics-recording-only",
        "--password-store=basic",
        "--use-mock-keychain",
        "--mute-audio",
        "--disable-features=Translate,MediaRouter,OptimizationHints,LensOverlay,AutofillServerCommunication,msForceBrowserSignIn,msEdgeUpdateLaunchServicesPreferredVersion",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    a.push(format!("--user-data-dir={}", profile.to_string_lossy()));
    a.push(format!("--window-size={},{}", WINDOW_SIZE.0, WINDOW_SIZE.1));
    if headless {
        a.push("--headless=new".into());
    }
    a
}

/// A started browser: the process and the two DevTools pipe ends the host keeps.
pub struct Launched {
    pub process: BrowserProcess,
    pub reader: Box<dyn io::Read + Send>,
    pub writer: Box<dyn io::Write + Send>,
}

/// The browser process and its container. Dropping it kills the browser tree.
pub struct BrowserProcess {
    pub pid: u32,
    container: Option<ProcessContainer>,
    #[cfg(windows)]
    handle: win::Handle,
    #[cfg(unix)]
    child: parking_lot::Mutex<std::process::Child>,
}

impl BrowserProcess {
    pub fn is_alive(&self) -> bool {
        #[cfg(windows)]
        {
            !self.handle.wait(Duration::ZERO)
        }
        #[cfg(unix)]
        {
            matches!(self.child.lock().try_wait(), Ok(None))
        }
    }

    /// Wait for the process to exit; true when it did within `timeout`.
    pub fn wait_exit(&self, timeout: Duration) -> bool {
        #[cfg(windows)]
        {
            self.handle.wait(timeout)
        }
        #[cfg(unix)]
        {
            let deadline = std::time::Instant::now() + timeout;
            loop {
                if !self.is_alive() {
                    return true;
                }
                if std::time::Instant::now() >= deadline {
                    return false;
                }
                std::thread::sleep(Duration::from_millis(25));
            }
        }
    }

    /// Kill the whole browser tree (renderers, GPU and utility processes included).
    pub fn kill(&self) {
        if let Some(c) = &self.container {
            if let Err(e) = c.terminate(1) {
                tracing::debug!(error = %e, "agent browser container terminate failed");
            }
        }
        #[cfg(windows)]
        self.handle.terminate();
        #[cfg(unix)]
        {
            let mut ch = self.child.lock();
            let _ = ch.kill();
            let _ = ch.wait();
        }
    }
}

impl Drop for BrowserProcess {
    fn drop(&mut self) {
        if self.is_alive() {
            self.kill();
        }
    }
}

fn contain(pid: u32) -> Option<ProcessContainer> {
    match ProcessContainer::new().and_then(|c| c.assign_pid(pid).map(|()| c)) {
        Ok(c) => Some(c),
        Err(e) => {
            tracing::warn!(error = %e, "could not contain the agent browser");
            None
        }
    }
}

/// Start `exe` with `args` and the DevTools pipes.
pub fn launch(exe: &Path, args: &[String]) -> io::Result<Launched> {
    imp_launch(exe, args)
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

#[cfg(windows)]
mod win {
    use std::time::Duration;

    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0};
    use windows_sys::Win32::System::Threading::{TerminateProcess, WaitForSingleObject};

    /// Owned process handle.
    pub struct Handle(pub HANDLE);
    // SAFETY: an opaque kernel handle; the APIs used are thread-safe.
    unsafe impl Send for Handle {}
    unsafe impl Sync for Handle {}

    impl Handle {
        /// True when the process has exited (within `timeout`).
        pub fn wait(&self, timeout: Duration) -> bool {
            let ms = u32::try_from(timeout.as_millis()).unwrap_or(u32::MAX - 1);
            // SAFETY: valid process handle owned by self.
            unsafe { WaitForSingleObject(self.0, ms) == WAIT_OBJECT_0 }
        }
        pub fn terminate(&self) {
            // SAFETY: valid process handle owned by self.
            unsafe { TerminateProcess(self.0, 1) };
        }
    }

    impl Drop for Handle {
        fn drop(&mut self) {
            // SAFETY: owned, closed once.
            unsafe { CloseHandle(self.0) };
        }
    }
}

/// `"..."` quoting for one argument (MSVCRT / CommandLineToArgvW rules).
#[cfg(any(windows, test))]
pub fn quote_windows_arg(arg: &str, out: &mut String) {
    let needs = arg.is_empty() || arg.chars().any(|c| matches!(c, ' ' | '\t' | '\n' | '\x0b' | '"'));
    if !needs {
        out.push_str(arg);
        return;
    }
    out.push('"');
    let mut backslashes = 0usize;
    for c in arg.chars() {
        match c {
            '\\' => backslashes += 1,
            '"' => {
                out.extend(std::iter::repeat_n('\\', backslashes * 2 + 1));
                out.push('"');
                backslashes = 0;
            }
            _ => {
                out.extend(std::iter::repeat_n('\\', backslashes));
                out.push(c);
                backslashes = 0;
            }
        }
    }
    out.extend(std::iter::repeat_n('\\', backslashes * 2));
    out.push('"');
}

/// The CRT's inherited-handle block (`STARTUPINFO.lpReserved2`): `int count; u8 flags[count];
/// intptr handles[count]` (unaligned). `None` = closed descriptor.
#[cfg(any(windows, test))]
pub fn crt_handle_block(handles: &[Option<isize>]) -> Vec<u8> {
    const FOPEN: u8 = 0x01;
    const FPIPE: u8 = 0x08;
    let n = handles.len();
    let mut v = Vec::with_capacity(4 + n * (1 + std::mem::size_of::<isize>()));
    v.extend_from_slice(&(n as i32).to_le_bytes());
    for h in handles {
        v.push(if h.is_some() { FOPEN | FPIPE } else { 0 });
    }
    for h in handles {
        v.extend_from_slice(&h.unwrap_or(-1).to_le_bytes());
    }
    v
}

#[cfg(windows)]
fn imp_launch(exe: &Path, args: &[String]) -> io::Result<Launched> {
    use std::mem::{size_of, zeroed};
    use std::os::windows::io::FromRawHandle;
    use std::ptr::{null, null_mut};

    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, HANDLE_FLAG_INHERIT, SetHandleInformation};
    use windows_sys::Win32::System::Pipes::CreatePipe;
    use windows_sys::Win32::System::Threading::{
        CREATE_NO_WINDOW, CREATE_SUSPENDED, CreateProcessW, DeleteProcThreadAttributeList, EXTENDED_STARTUPINFO_PRESENT,
        InitializeProcThreadAttributeList, LPPROC_THREAD_ATTRIBUTE_LIST, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
        PROCESS_INFORMATION, ResumeThread, STARTUPINFOEXW, TerminateProcess, UpdateProcThreadAttribute,
    };

    struct Owned(HANDLE);
    impl Drop for Owned {
        fn drop(&mut self) {
            if !self.0.is_null() {
                // SAFETY: owned handle, closed once.
                unsafe { CloseHandle(self.0) };
            }
        }
    }
    impl Owned {
        fn take(&mut self) -> HANDLE {
            std::mem::replace(&mut self.0, null_mut())
        }
    }

    fn pipe() -> io::Result<(Owned, Owned)> {
        let (mut r, mut w): (HANDLE, HANDLE) = (null_mut(), null_mut());
        // SAFETY: out pointers to locals; non-inheritable by default (null security attributes).
        if unsafe { CreatePipe(&mut r, &mut w, null(), 0) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok((Owned(r), Owned(w)))
    }

    // Host → browser (browser reads), browser → host (browser writes).
    let (child_read, mut host_write) = pipe()?;
    let (mut host_read, child_write) = pipe()?;
    for h in [child_read.0, child_write.0] {
        // SAFETY: valid handles owned above.
        if unsafe { SetHandleInformation(h, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) } == 0 {
            return Err(io::Error::last_os_error());
        }
    }

    let mut cmdline = String::new();
    quote_windows_arg(&exe.to_string_lossy(), &mut cmdline);
    for a in args {
        cmdline.push(' ');
        quote_windows_arg(a, &mut cmdline);
    }
    cmdline.push(' ');
    cmdline.push_str(&format!("--remote-debugging-io-pipes={},{}", child_read.0 as usize, child_write.0 as usize));
    let mut cmd_w: Vec<u16> = cmdline.encode_utf16().chain(std::iter::once(0)).collect();
    let exe_w: Vec<u16> = exe.as_os_str().to_string_lossy().encode_utf16().chain(std::iter::once(0)).collect();

    let crt = crt_handle_block(&[None, None, None, Some(child_read.0 as isize), Some(child_write.0 as isize)]);
    let inherit = [child_read.0, child_write.0];

    // SAFETY: the attribute list buffer is sized by the first call and lives until
    // DeleteProcThreadAttributeList; `inherit`, `crt`, `cmd_w` and `exe_w` outlive CreateProcessW.
    unsafe {
        let mut size = 0usize;
        InitializeProcThreadAttributeList(null_mut(), 1, 0, &mut size);
        let mut attr_buf = vec![0u64; size.div_ceil(8).max(1)];
        let attrs = attr_buf.as_mut_ptr() as LPPROC_THREAD_ATTRIBUTE_LIST;
        if InitializeProcThreadAttributeList(attrs, 1, 0, &mut size) == 0 {
            return Err(io::Error::last_os_error());
        }
        let ok = UpdateProcThreadAttribute(
            attrs,
            0,
            PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
            inherit.as_ptr().cast(),
            size_of::<[HANDLE; 2]>(),
            null_mut(),
            null(),
        );
        if ok == 0 {
            let e = io::Error::last_os_error();
            DeleteProcThreadAttributeList(attrs);
            return Err(e);
        }
        let mut si: STARTUPINFOEXW = zeroed();
        si.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
        si.StartupInfo.cbReserved2 = crt.len() as u16;
        si.StartupInfo.lpReserved2 = crt.as_ptr() as *mut u8;
        si.lpAttributeList = attrs;
        let mut pi: PROCESS_INFORMATION = zeroed();
        let created = CreateProcessW(
            exe_w.as_ptr(),
            cmd_w.as_mut_ptr(),
            null(),
            null(),
            1,
            EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | CREATE_NO_WINDOW,
            null(),
            null(),
            &si.StartupInfo,
            &mut pi,
        );
        let err = io::Error::last_os_error();
        DeleteProcThreadAttributeList(attrs);
        drop(child_read);
        drop(child_write);
        if created == 0 {
            return Err(err);
        }
        let process = win::Handle(pi.hProcess);
        let container = contain(pi.dwProcessId);
        if container.is_none() {
            // Never run a browser Gridkeeper could orphan.
            TerminateProcess(pi.hProcess, 1);
            CloseHandle(pi.hThread);
            return Err(io::Error::other("could not put the browser into a Job Object"));
        }
        ResumeThread(pi.hThread);
        CloseHandle(pi.hThread);
        let reader = std::fs::File::from_raw_handle(host_read.take() as _);
        let writer = std::fs::File::from_raw_handle(host_write.take() as _);
        Ok(Launched {
            process: BrowserProcess { pid: pi.dwProcessId, container, handle: process },
            reader: Box::new(reader),
            writer: Box::new(writer),
        })
    }
}

// ---------------------------------------------------------------------------
// macOS / Linux
// ---------------------------------------------------------------------------

#[cfg(unix)]
fn imp_launch(exe: &Path, args: &[String]) -> io::Result<Launched> {
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};

    fn pipe() -> io::Result<(OwnedFd, OwnedFd)> {
        let mut fds = [0 as libc::c_int; 2];
        #[cfg(any(target_os = "linux", target_os = "android"))]
        // SAFETY: out array of two ints.
        let rc = unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC) };
        #[cfg(not(any(target_os = "linux", target_os = "android")))]
        // SAFETY: out array of two ints; then plain fcntl on the new descriptors.
        let rc = unsafe {
            let rc = libc::pipe(fds.as_mut_ptr());
            if rc == 0 {
                libc::fcntl(fds[0], libc::F_SETFD, libc::FD_CLOEXEC);
                libc::fcntl(fds[1], libc::F_SETFD, libc::FD_CLOEXEC);
            }
            rc
        };
        if rc != 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: freshly created descriptors we own.
        Ok(unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) })
    }

    let (child_read, host_write) = pipe()?;
    let (host_read, child_write) = pipe()?;
    let (cr, cw) = (child_read.as_raw_fd(), child_write.as_raw_fd());
    let mut cmd = Command::new(exe);
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    // SAFETY: only async-signal-safe calls between fork and exec.
    unsafe {
        cmd.pre_exec(move || {
            if libc::setsid() == -1 {
                return Err(io::Error::last_os_error());
            }
            // Move the pipe ends out of the way first (they could be 3 or 4 themselves).
            let r = libc::fcntl(cr, libc::F_DUPFD, 10);
            let w = libc::fcntl(cw, libc::F_DUPFD, 10);
            if r < 0 || w < 0 || libc::dup2(r, 3) < 0 || libc::dup2(w, 4) < 0 {
                return Err(io::Error::last_os_error());
            }
            libc::close(r);
            libc::close(w);
            Ok(())
        });
    }
    let child = cmd.spawn()?;
    drop(child_read);
    drop(child_write);
    let pid = child.id();
    let container = contain(pid);
    Ok(Launched {
        process: BrowserProcess { pid, container, child: parking_lot::Mutex::new(child) },
        reader: Box::new(std::fs::File::from(host_read)),
        writer: Box::new(std::fs::File::from(host_write)),
    })
}
