//! Helper ⇄ host transport: one JSON request line, one JSON response line per connection.
//!
//! - **Windows**: a named pipe `\\.\pipe\gridkeeper-ab-<pid>-<random>` created with
//!   `FILE_FLAG_FIRST_PIPE_INSTANCE` (nobody can squat the name first), `PIPE_REJECT_REMOTE_CLIENTS`
//!   and a DACL that grants access to the current user (and SYSTEM) only. The host learns the client's
//!   process id from `GetNamedPipeClientProcessId`.
//! - **macOS / Linux**: a Unix socket in a 0700 folder (`$XDG_RUNTIME_DIR/gridkeeper`, else the data
//!   folder, else `/tmp/gridkeeper-<uid>`), mode 0600; peers with another uid are refused; the peer pid
//!   comes from `SO_PEERCRED` (Linux) / `LOCAL_PEERPID` (macOS).
//!
//! Not a local HTTP server and no TCP port: only processes of this user can connect, and the host
//! additionally checks the per-launch token and that the client runs inside the claimed session.
//! A connection is either a tool `call` (request → response → close) or a `presence` connection the
//! helper keeps open for its lifetime (the host learns when the agent's helper goes away).

use std::io::{self, BufRead, Read, Write};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PROTOCOL_VERSION: u32 = 1;
/// Largest request / response line (a full-page screenshot is a few MB of base64).
pub const MAX_LINE: usize = 48 * 1024 * 1024;
/// How long a client waits for a free pipe instance / the socket.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RequestKind {
    Presence,
    Call,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Request {
    pub v: u32,
    pub session: String,
    pub token: String,
    pub kind: RequestKind,
    #[serde(default)]
    pub tool: Option<String>,
    #[serde(default)]
    pub args: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Response {
    pub ok: bool,
    /// MCP `tools/call` result (`content`, `isError`).
    #[serde(default)]
    pub result: Option<Value>,
    #[serde(default)]
    pub error: Option<String>,
}

impl Response {
    pub fn ok(result: Option<Value>) -> Self {
        Self { ok: true, result, error: None }
    }
    pub fn err(msg: impl Into<String>) -> Self {
        Self { ok: false, result: None, error: Some(msg.into()) }
    }
}

/// One line (without the newline), at most `cap` bytes. `Ok(None)` at EOF before any byte.
pub fn read_line_capped<R: BufRead + ?Sized>(r: &mut R, cap: usize) -> io::Result<Option<String>> {
    let mut buf = Vec::new();
    loop {
        let (done, used) = {
            let avail = match r.fill_buf() {
                Ok(b) => b,
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(e) => return Err(e),
            };
            if avail.is_empty() {
                if buf.is_empty() {
                    return Ok(None);
                }
                (true, 0)
            } else if let Some(i) = avail.iter().position(|&b| b == b'\n') {
                buf.extend_from_slice(&avail[..i]);
                (true, i + 1)
            } else {
                buf.extend_from_slice(avail);
                (false, avail.len())
            }
        };
        r.consume(used);
        if buf.len() > cap {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "line too long"));
        }
        if done {
            if buf.last() == Some(&b'\r') {
                buf.pop();
            }
            return String::from_utf8(buf).map(Some).map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "not UTF-8"));
        }
    }
}

pub fn write_json_line<T: Serialize>(w: &mut impl Write, value: &T) -> io::Result<()> {
    let mut bytes = serde_json::to_vec(value).map_err(io::Error::other)?;
    bytes.push(b'\n');
    w.write_all(&bytes)?;
    w.flush()
}

/// Constant-time comparison (token check).
pub fn ct_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// A fresh random token (two v4 UUIDs = 244 random bits from the OS generator).
pub fn new_token() -> String {
    format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple())
}

/// One accepted or opened connection.
pub struct Conn {
    #[cfg(windows)]
    inner: std::fs::File,
    #[cfg(unix)]
    inner: std::os::unix::net::UnixStream,
    /// The other side's process id, when the OS reports it (server side only).
    pub peer_pid: Option<u32>,
}

impl Read for &Conn {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        (&self.inner).read(buf)
    }
}

impl Write for &Conn {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        (&self.inner).write(buf)
    }
    fn flush(&mut self) -> io::Result<()> {
        (&self.inner).flush()
    }
}

impl Conn {
    /// Send one request and read the response (client side).
    pub fn exchange(&self, req: &Request) -> io::Result<Response> {
        let mut w = self;
        write_json_line(&mut w, req)?;
        let mut reader = io::BufReader::new(self);
        let line = read_line_capped(&mut reader, MAX_LINE)?
            .ok_or_else(|| io::Error::new(io::ErrorKind::UnexpectedEof, "Gridkeeper closed the connection"))?;
        serde_json::from_str(&line).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
    }
}

/// Handles one accepted connection (called on its own thread).
pub type Handler = Arc<dyn Fn(Conn) + Send + Sync>;

/// The listening side. Dropping it stops accepting.
pub struct Server {
    endpoint: String,
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Server {
    pub fn endpoint(&self) -> &str {
        &self.endpoint
    }

    /// Stop accepting (existing connections finish on their own).
    pub fn stop(&mut self) {
        if self.stop.swap(true, Ordering::AcqRel) {
            return;
        }
        // Unblock the accept call with a throwaway connection. If that fails (the socket file was deleted
        // with its folder), the accept thread can't be woken: leave it blocked rather than hang here.
        let woke = connect(&self.endpoint, Duration::from_millis(300)).is_ok();
        if let Some(t) = self.thread.take() {
            if woke {
                let _ = t.join();
            }
        }
        #[cfg(unix)]
        let _ = std::fs::remove_file(&self.endpoint);
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.stop();
    }
}

fn spawn_handler(handler: &Handler, conn: Conn) {
    let h = Arc::clone(handler);
    if let Err(e) = crate::pty::spawn_guarded("agent-browser-conn".into(), move || h(conn)) {
        tracing::warn!(error = %e, "could not start an agent browser connection thread");
    }
}

// ---------------------------------------------------------------------------
// Windows: named pipe
// ---------------------------------------------------------------------------

#[cfg(windows)]
mod imp {
    use std::io;
    use std::os::windows::io::FromRawHandle;
    use std::ptr::null_mut;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::{Duration, Instant};

    use windows_sys::Win32::Foundation::{
        CloseHandle, ERROR_PIPE_BUSY, ERROR_PIPE_CONNECTED, GetLastError, HANDLE, INVALID_HANDLE_VALUE, LocalFree,
    };
    use windows_sys::Win32::Security::Authorization::{
        ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
    };
    use windows_sys::Win32::Security::{
        GetTokenInformation, PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER, TokenUser,
    };
    use windows_sys::Win32::Storage::FileSystem::{FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_ACCESS_DUPLEX};
    use windows_sys::Win32::System::Pipes::{
        ConnectNamedPipe, CreateNamedPipeW, GetNamedPipeClientProcessId, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS,
        PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    use super::{Conn, Handler, Server};

    const BUF: u32 = 64 * 1024;

    pub fn pipe_path(name: &str) -> String {
        format!(r"\\.\pipe\{name}")
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// `S-1-5-21-...` of the user running this process.
    fn current_user_sid() -> io::Result<String> {
        // SAFETY: token handle and buffers are owned here and released on every path; the TOKEN_USER
        // buffer is u64-aligned and as large as GetTokenInformation asked for.
        unsafe {
            let mut token: HANDLE = null_mut();
            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
                return Err(io::Error::last_os_error());
            }
            let mut len = 0u32;
            GetTokenInformation(token, TokenUser, null_mut(), 0, &mut len);
            let mut buf = vec![0u64; (len as usize).div_ceil(8).max(1)];
            let ok = GetTokenInformation(token, TokenUser, buf.as_mut_ptr().cast(), (buf.len() * 8) as u32, &mut len);
            CloseHandle(token);
            if ok == 0 {
                return Err(io::Error::last_os_error());
            }
            let tu = &*(buf.as_ptr() as *const TOKEN_USER);
            let mut s: *mut u16 = null_mut();
            if ConvertSidToStringSidW(tu.User.Sid, &mut s) == 0 {
                return Err(io::Error::last_os_error());
            }
            let mut n = 0;
            while *s.add(n) != 0 {
                n += 1;
            }
            let out = String::from_utf16_lossy(std::slice::from_raw_parts(s, n));
            LocalFree(s.cast());
            Ok(out)
        }
    }

    /// Security attributes that grant the pipe to this user and SYSTEM only (protected DACL).
    struct PipeSecurity {
        sd: PSECURITY_DESCRIPTOR,
    }

    unsafe impl Send for PipeSecurity {}

    impl PipeSecurity {
        fn new() -> io::Result<Self> {
            let sddl = format!("D:P(A;;GA;;;{})(A;;GA;;;SY)", current_user_sid()?);
            let w = wide(&sddl);
            let mut sd: PSECURITY_DESCRIPTOR = null_mut();
            // SAFETY: valid NUL-terminated SDDL; the descriptor is freed in Drop with LocalFree.
            if unsafe { ConvertStringSecurityDescriptorToSecurityDescriptorW(w.as_ptr(), SDDL_REVISION_1, &mut sd, null_mut()) }
                == 0
            {
                return Err(io::Error::last_os_error());
            }
            Ok(Self { sd })
        }

        fn attributes(&self) -> SECURITY_ATTRIBUTES {
            SECURITY_ATTRIBUTES {
                nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: self.sd,
                bInheritHandle: 0,
            }
        }
    }

    impl Drop for PipeSecurity {
        fn drop(&mut self) {
            // SAFETY: allocated by ConvertStringSecurityDescriptorToSecurityDescriptorW.
            unsafe { LocalFree(self.sd) };
        }
    }

    struct Instance(HANDLE);
    unsafe impl Send for Instance {}

    fn create_instance(name: &[u16], first: bool, sec: &PipeSecurity) -> io::Result<Instance> {
        let sa = sec.attributes();
        let open = PIPE_ACCESS_DUPLEX | if first { FILE_FLAG_FIRST_PIPE_INSTANCE } else { 0 };
        let mode = PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS;
        // SAFETY: NUL-terminated name, valid security attributes that outlive the call.
        let h = unsafe { CreateNamedPipeW(name.as_ptr(), open, mode, PIPE_UNLIMITED_INSTANCES, BUF, BUF, 0, &sa) };
        if h == INVALID_HANDLE_VALUE || h.is_null() {
            return Err(io::Error::last_os_error());
        }
        Ok(Instance(h))
    }

    pub fn serve(name: &str, handler: Handler) -> io::Result<Server> {
        let sec = PipeSecurity::new()?;
        let wname = wide(&pipe_path(name));
        // The first instance is created here so a squatted / invalid name fails the caller.
        let first = create_instance(&wname, true, &sec)?;
        let stop = Arc::new(AtomicBool::new(false));
        let stop2 = Arc::clone(&stop);
        let thread = crate::pty::spawn_guarded("agent-browser-pipe".into(), move || {
            let mut pending = Some(first);
            while !stop2.load(Ordering::Acquire) {
                let inst = match pending.take() {
                    Some(i) => i,
                    None => match create_instance(&wname, false, &sec) {
                        Ok(i) => i,
                        Err(e) => {
                            tracing::warn!(error = %e, "agent browser pipe: could not create an instance");
                            std::thread::sleep(Duration::from_millis(500));
                            continue;
                        }
                    },
                };
                // SAFETY: valid pipe handle; synchronous (no OVERLAPPED).
                let connected = unsafe { ConnectNamedPipe(inst.0, null_mut()) } != 0
                    || unsafe { GetLastError() } == ERROR_PIPE_CONNECTED;
                if !connected || stop2.load(Ordering::Acquire) {
                    // SAFETY: we own the handle.
                    unsafe { CloseHandle(inst.0) };
                    continue;
                }
                let mut pid = 0u32;
                // SAFETY: connected pipe handle, out pointer to a u32.
                let peer_pid = (unsafe { GetNamedPipeClientProcessId(inst.0, &mut pid) } != 0 && pid != 0).then_some(pid);
                // SAFETY: ownership of the handle moves into the File.
                let file = unsafe { std::fs::File::from_raw_handle(inst.0 as _) };
                super::spawn_handler(&handler, Conn { inner: file, peer_pid });
            }
            if let Some(i) = pending {
                // SAFETY: we own the handle.
                unsafe { CloseHandle(i.0) };
            }
        })?;
        Ok(Server { endpoint: name.to_string(), stop, thread: Some(thread) })
    }

    pub fn connect(name: &str, timeout: Duration) -> io::Result<Conn> {
        let path = pipe_path(name);
        let deadline = Instant::now() + timeout;
        loop {
            match std::fs::OpenOptions::new().read(true).write(true).open(&path) {
                Ok(f) => return Ok(Conn { inner: f, peer_pid: None }),
                Err(e) if e.raw_os_error() == Some(ERROR_PIPE_BUSY as i32) && Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(20));
                }
                Err(e) => return Err(e),
            }
        }
    }

    pub fn new_endpoint(_data_dir: &std::path::Path) -> io::Result<String> {
        let tag = uuid::Uuid::new_v4().simple().to_string();
        Ok(format!("gridkeeper-ab-{}-{}", std::process::id(), &tag[..16]))
    }
}

// ---------------------------------------------------------------------------
// macOS / Linux: Unix socket
// ---------------------------------------------------------------------------

#[cfg(unix)]
mod imp {
    use std::io;
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    use std::os::unix::io::AsRawFd;
    use std::os::unix::net::{UnixListener, UnixStream};
    use std::path::{Path, PathBuf};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
    use std::time::Duration;

    use super::{Conn, Handler, Server};

    /// Longest socket path used (sun_path is 104 bytes on macOS, 108 on Linux).
    const MAX_SOCK_PATH: usize = 100;

    fn euid() -> u32 {
        // SAFETY: plain syscall.
        unsafe { libc::geteuid() }
    }

    /// A 0700 folder owned by us.
    fn private_dir(dir: &Path) -> io::Result<()> {
        std::fs::create_dir_all(dir)?;
        let meta = std::fs::symlink_metadata(dir)?;
        if !meta.is_dir() || meta.uid() != euid() {
            return Err(io::Error::other(format!("{} is not a folder owned by this user", dir.display())));
        }
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
    }

    pub fn new_endpoint(data_dir: &Path) -> io::Result<String> {
        // Unique per hub, not just per process: hubs in one process (parallel tests) would otherwise share a path,
        // and the second bind unlinks the first listener's socket so its stop() never unblocks its accept.
        static SEQ: AtomicU32 = AtomicU32::new(0);
        let file = format!("ab-{}-{}.sock", std::process::id(), SEQ.fetch_add(1, Ordering::Relaxed));
        let mut candidates: Vec<PathBuf> = Vec::new();
        if let Some(rt) = std::env::var_os("XDG_RUNTIME_DIR").filter(|v| !v.is_empty()) {
            candidates.push(PathBuf::from(rt).join("gridkeeper"));
        }
        candidates.push(super::super::dir(data_dir).join("run"));
        candidates.push(std::env::temp_dir().join(format!("gridkeeper-{}", euid())));
        let mut last = io::Error::other("no folder for the agent browser socket");
        for dir in candidates {
            let path = dir.join(&file);
            if path.as_os_str().len() > MAX_SOCK_PATH {
                continue;
            }
            match private_dir(&dir) {
                Ok(()) => return Ok(path.to_string_lossy().into_owned()),
                Err(e) => last = e,
            }
        }
        Err(last)
    }

    /// (pid, uid) of the peer.
    #[cfg(any(target_os = "linux", target_os = "android"))]
    fn peer(s: &UnixStream) -> (Option<u32>, Option<u32>) {
        let mut cred: libc::ucred = unsafe { std::mem::zeroed() };
        let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
        // SAFETY: valid socket, out buffer of the right size.
        let rc = unsafe {
            libc::getsockopt(s.as_raw_fd(), libc::SOL_SOCKET, libc::SO_PEERCRED, (&mut cred as *mut libc::ucred).cast(), &mut len)
        };
        if rc == 0 { (u32::try_from(cred.pid).ok().filter(|p| *p > 0), Some(cred.uid)) } else { (None, None) }
    }

    #[cfg(target_os = "macos")]
    fn peer(s: &UnixStream) -> (Option<u32>, Option<u32>) {
        let fd = s.as_raw_fd();
        let mut uid: libc::uid_t = 0;
        let mut gid: libc::gid_t = 0;
        // SAFETY: valid socket and out pointers.
        let uid = (unsafe { libc::getpeereid(fd, &mut uid, &mut gid) } == 0).then_some(uid);
        let mut pid: libc::pid_t = 0;
        let mut len = std::mem::size_of::<libc::pid_t>() as libc::socklen_t;
        // SOL_LOCAL = 0, LOCAL_PEERPID = 2 (<sys/un.h>).
        // SAFETY: valid socket, out buffer of the right size.
        let rc = unsafe { libc::getsockopt(fd, 0, 2, (&mut pid as *mut libc::pid_t).cast(), &mut len) };
        let pid = (rc == 0).then(|| u32::try_from(pid).ok()).flatten().filter(|p| *p > 0);
        (pid, uid)
    }

    #[cfg(not(any(target_os = "linux", target_os = "android", target_os = "macos")))]
    fn peer(_s: &UnixStream) -> (Option<u32>, Option<u32>) {
        (None, None)
    }

    pub fn serve(path: &str, handler: Handler) -> io::Result<Server> {
        let p = Path::new(path);
        // A stale socket of an earlier run of this pid (never another file type).
        if let Ok(meta) = std::fs::symlink_metadata(p) {
            use std::os::unix::fs::FileTypeExt;
            if meta.file_type().is_socket() && meta.uid() == euid() {
                let _ = std::fs::remove_file(p);
            }
        }
        let listener = UnixListener::bind(p)?;
        std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o600))?;
        let stop = Arc::new(AtomicBool::new(false));
        let stop2 = Arc::clone(&stop);
        let me = euid();
        let thread = crate::pty::spawn_guarded("agent-browser-sock".into(), move || {
            for stream in listener.incoming() {
                if stop2.load(Ordering::Acquire) {
                    break;
                }
                let Ok(stream) = stream else { continue };
                let (pid, uid) = peer(&stream);
                if uid.is_some_and(|u| u != me) {
                    continue; // another user's process: drop it
                }
                super::spawn_handler(&handler, Conn { inner: stream, peer_pid: pid });
            }
        })?;
        Ok(Server { endpoint: path.to_string(), stop, thread: Some(thread) })
    }

    pub fn connect(path: &str, _timeout: Duration) -> io::Result<Conn> {
        UnixStream::connect(path).map(|s| Conn { inner: s, peer_pid: None })
    }
}

/// A fresh endpoint name for this host process.
pub fn new_endpoint(data_dir: &std::path::Path) -> io::Result<String> {
    imp::new_endpoint(data_dir)
}

/// Start listening on `endpoint`; `handler` runs on its own thread per connection.
pub fn serve(endpoint: &str, handler: Handler) -> io::Result<Server> {
    imp::serve(endpoint, handler)
}

/// Open a connection to the host.
pub fn connect(endpoint: &str, timeout: Duration) -> io::Result<Conn> {
    imp::connect(endpoint, timeout)
}

/// Retry `connect` for a short while (the host may be creating the next pipe instance).
pub fn connect_retry(endpoint: &str) -> io::Result<Conn> {
    let deadline = Instant::now() + CONNECT_TIMEOUT;
    loop {
        match connect(endpoint, CONNECT_TIMEOUT) {
            Ok(c) => return Ok(c),
            Err(e) if Instant::now() >= deadline => return Err(e),
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Err(e),
            Err(_) => std::thread::sleep(Duration::from_millis(50)),
        }
    }
}
