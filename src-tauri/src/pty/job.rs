//! Per-session process containment: [`ProcessContainer`].
//!
//! **Windows: a Job Object.** Every session's root process is assigned to its
//! own job created with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` and *without* any
//! breakaway flags, so all descendants (agent CLIs, MCP servers,
//! `Start-Process -NoNewWindow` children, ...) stay in the job. Terminating the
//! job — or simply closing the last handle, including when Gridkeeper itself
//! exits or crashes — kills exactly that session's process tree and nothing else.
//!
//! Known limitation: portable-pty does not spawn with `CREATE_SUSPENDED`, so a
//! child that forks in the first microseconds (before assignment) could escape
//! the job. Shells and agent CLIs do not do this in practice.
//!
//! **macOS / Linux: the POSIX session.** portable-pty's Unix spawn calls
//! `setsid()` in the child before `exec` (verified in portable-pty 0.9
//! `unix.rs`), so the root process leads a new session and process group whose
//! ids equal its pid. Everything it starts inherits that session id unless it
//! calls `setsid()` itself; job-control shells put each pipeline in its own
//! process group, but inside the same session. The container therefore signals
//! the root's process group (`killpg`) *and* every process whose session id is
//! the root's pid, plus the live descendants of those (children that detached
//! into a session of their own while their parent was alive). Members are found
//! with one process-table walk (`crate::procs`). Hard kill = `SIGKILL`; the
//! graceful stop's middle step = `SIGHUP` (+ `SIGCONT` so stopped jobs see it).
//!
//! Unix limitation: there is no kernel object that kills the tree when the host
//! dies. A clean exit runs `shutdown_all`, and `crate::platform` kills every
//! registered session on a main-thread panic and on SIGTERM / SIGINT / SIGHUP
//! to the host, but a hard crash (SIGKILL, segfault, power loss) can orphan the
//! session processes, unlike Windows. (Linux `PR_SET_PDEATHSIG` is not used: it
//! is not inherited across `fork`, so it would only cover the root shell and not
//! the agents it starts, and it fires when the *thread* that spawned the child
//! exits, which for a blocking-pool spawn can be long before the app quits.)

use std::io;

#[cfg(windows)]
mod imp {
    use std::io;
    use std::mem::{size_of, zeroed};
    use std::ptr::null;

    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JobObjectBasicAccountingInformation, JobObjectExtendedLimitInformation, QueryInformationJobObject,
        SetInformationJobObject, TerminateJobObject,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SET_QUOTA, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
    };

    /// Owned kernel handle, closed on drop.
    pub struct OwnedHandle(HANDLE);

    // SAFETY: a kernel HANDLE is an opaque process-wide identifier; the job and
    // process APIs used here are thread-safe.
    unsafe impl Send for OwnedHandle {}
    unsafe impl Sync for OwnedHandle {}

    impl OwnedHandle {
        fn new(h: HANDLE) -> io::Result<Self> {
            if h.is_null() || h as isize == -1 { Err(io::Error::last_os_error()) } else { Ok(Self(h)) }
        }
        pub fn raw(&self) -> HANDLE {
            self.0
        }
    }

    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            // SAFETY: we own the handle and close it exactly once.
            unsafe { CloseHandle(self.0) };
        }
    }

    pub struct Job {
        handle: OwnedHandle,
    }

    impl Job {
        pub fn new() -> io::Result<Self> {
            // SAFETY: plain Win32 calls with valid arguments; the info struct is
            // a POD type for which all-zeroes is a valid value.
            unsafe {
                let handle = OwnedHandle::new(CreateJobObjectW(null(), null()))?;
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let ok = SetInformationJobObject(
                    handle.raw(),
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const _,
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                if ok == 0 {
                    return Err(io::Error::last_os_error());
                }
                Ok(Self { handle })
            }
        }

        pub fn assign_pid(&self, pid: u32) -> io::Result<()> {
            // SAFETY: OpenProcess returns an owned handle or null; ownership is
            // transferred to OwnedHandle which closes it.
            unsafe {
                let access =
                    PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION;
                let proc = OwnedHandle::new(OpenProcess(access, 0, pid))?;
                if AssignProcessToJobObject(self.handle.raw(), proc.raw()) == 0 {
                    return Err(io::Error::last_os_error());
                }
            }
            Ok(())
        }

        pub fn terminate(&self, exit_code: u32) -> io::Result<()> {
            // SAFETY: valid job handle owned by self.
            if unsafe { TerminateJobObject(self.handle.raw(), exit_code) } == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        }

        pub fn active_processes(&self) -> io::Result<u32> {
            // SAFETY: the output buffer is a correctly sized POD struct.
            unsafe {
                let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = zeroed();
                let ok = QueryInformationJobObject(
                    self.handle.raw(),
                    JobObjectBasicAccountingInformation,
                    &mut info as *mut _ as *mut _,
                    size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                    std::ptr::null_mut(),
                );
                if ok == 0 {
                    return Err(io::Error::last_os_error());
                }
                Ok(info.ActiveProcesses)
            }
        }
    }
}

#[cfg(unix)]
mod imp {
    use std::io;
    use std::sync::atomic::{AtomicI32, Ordering};
    use std::time::Duration;

    use parking_lot::Mutex;

    use crate::procs::{self, Detail};

    /// Session ids of every container that holds a live root, for [`kill_all`] (host panic or
    /// termination signal). A `Vec` because it must be const-initialized; it holds one entry per
    /// running session.
    static LIVE: Mutex<Vec<i32>> = Mutex::new(Vec::new());

    /// The session (= process group) led by the root process.
    pub struct Job {
        /// Root pid = session id = process group id; 0 until assigned.
        sid: AtomicI32,
    }

    /// Members of session `sid`, from a fresh process-table walk.
    fn members(sid: i32) -> Vec<u32> {
        procs::session_members(&procs::snapshot(Detail::Basic, true), sid as u32)
    }

    /// `kill(2)` for one member, never for pid 0/1 (process group / init) or this process.
    fn kill_one(pid: u32, sig: libc::c_int) {
        let Ok(p) = i32::try_from(pid) else { return };
        if p > 1 && pid != std::process::id() {
            // SAFETY: plain syscall; an exited pid yields ESRCH, which is ignored.
            unsafe { libc::kill(p, sig) };
        }
    }

    /// `killpg(2)` for the root's own process group (`sid > 1`: never "my group" or init).
    fn kill_group(sid: i32, sig: libc::c_int) {
        if sid > 1 && sid as u32 != std::process::id() {
            // SAFETY: plain syscall; ESRCH (group already empty) is ignored.
            unsafe { libc::killpg(sid, sig) };
        }
    }

    /// Send each signal to the root's process group and to every member of the session.
    fn signal_session(sid: i32, sigs: &[libc::c_int], members: &[u32]) {
        for &sig in sigs {
            kill_group(sid, sig);
            for &pid in members {
                kill_one(pid, sig);
            }
        }
    }

    impl Job {
        pub fn new() -> io::Result<Self> {
            Ok(Self { sid: AtomicI32::new(0) })
        }

        fn sid(&self) -> i32 {
            self.sid.load(Ordering::Acquire)
        }

        /// Record the root. portable-pty made it a session leader (`setsid` before `exec`), so its
        /// pid is the session id and the process group id of everything it starts.
        pub fn assign_pid(&self, pid: u32) -> io::Result<()> {
            let pid = i32::try_from(pid).map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "pid out of range"))?;
            if pid <= 1 {
                return Err(io::Error::new(io::ErrorKind::InvalidInput, format!("refusing to contain pid {pid}")));
            }
            // SAFETY: plain syscall.
            let sid = unsafe { libc::getsid(pid) };
            // -1 = already gone (or a zombie macOS will not report); anything else must be the pid itself.
            // Otherwise signalling "the session" would reach nothing: refuse, so the caller falls back to
            // killing the root process directly.
            if sid >= 0 && sid != pid {
                return Err(io::Error::other(format!("process {pid} is not a session leader (session {sid})")));
            }
            self.sid.store(pid, Ordering::Release);
            LIVE.lock().push(pid);
            Ok(())
        }

        /// SIGKILL the whole session. Repeats (briefly) while members remain, so a process forked
        /// while the first signal was in flight is caught too. Never blocks for long.
        pub fn terminate(&self, _exit_code: u32) -> io::Result<()> {
            let sid = self.sid();
            if sid <= 1 {
                return Ok(());
            }
            for pass in 0..3 {
                let m = members(sid);
                if pass > 0 && m.is_empty() {
                    break;
                }
                signal_session(sid, &[libc::SIGKILL], &m);
                std::thread::sleep(Duration::from_millis(20));
            }
            Ok(())
        }

        /// Graceful middle step: SIGHUP (what a terminal sends when it closes), then SIGCONT so
        /// stopped jobs wake up and see it.
        pub fn hang_up(&self) -> io::Result<()> {
            let sid = self.sid();
            if sid > 1 {
                signal_session(sid, &[libc::SIGHUP, libc::SIGCONT], &members(sid));
            }
            Ok(())
        }

        pub fn active_processes(&self) -> io::Result<u32> {
            let sid = self.sid();
            if sid <= 1 {
                return Ok(0);
            }
            Ok(members(sid).len() as u32)
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            let sid = self.sid();
            if sid > 1 {
                LIVE.lock().retain(|s| *s != sid);
            }
        }
    }

    /// SIGKILL every registered session. For the host's last moments (main-thread panic, fatal
    /// signal): uses `try_lock` everywhere, because the panicking thread may hold a lock, and falls
    /// back to `killpg` alone when the process table is busy. Returns the number of sessions.
    pub fn kill_all() -> usize {
        let Some(live) = LIVE.try_lock().map(|l| l.clone()) else { return 0 };
        kill_sessions(&live);
        live.len()
    }

    /// SIGKILL the given sessions (members from one table walk when the table is free).
    pub fn kill_sessions(sids: &[i32]) {
        let rows = procs::try_snapshot();
        for &sid in sids.iter().filter(|s| **s > 1) {
            let m = rows.as_deref().map(|r| procs::session_members(r, sid as u32)).unwrap_or_default();
            signal_session(sid, &[libc::SIGKILL], &m);
        }
    }

    #[cfg(test)]
    pub fn is_registered(sid: u32) -> bool {
        LIVE.lock().contains(&(sid as i32))
    }
}

/// Containment of one session's process tree: a kill-on-close Job Object on
/// Windows, the POSIX session led by the root process on macOS / Linux (see the
/// module docs for what each guarantees).
pub struct ProcessContainer(imp::Job);

/// Historical name (the Windows-only implementation was called `Job`).
pub type Job = ProcessContainer;

impl ProcessContainer {
    /// Create an empty container (Windows: a job with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`).
    pub fn new() -> io::Result<Self> {
        imp::Job::new().map(ProcessContainer)
    }

    /// Assign a running process (and therefore its future descendants).
    pub fn assign_pid(&self, pid: u32) -> io::Result<()> {
        self.0.assign_pid(pid)
    }

    /// Terminate every process in the container.
    pub fn terminate(&self, exit_code: u32) -> io::Result<()> {
        self.0.terminate(exit_code)
    }

    /// Number of processes currently alive in the container.
    pub fn active_processes(&self) -> io::Result<u32> {
        self.0.active_processes()
    }

    /// Unix: SIGHUP (+ SIGCONT) to every process of the session, the graceful
    /// stop's middle step. Windows: nothing (closing the pseudoconsole sends
    /// `CTRL_CLOSE_EVENT` there).
    pub fn hang_up(&self) -> io::Result<()> {
        #[cfg(unix)]
        {
            self.0.hang_up()
        }
        #[cfg(not(unix))]
        {
            Ok(())
        }
    }
}

/// Unix: SIGKILL every live session's processes right now (host panic / fatal signal; see
/// `crate::platform`). Windows: nothing to do, the kernel closes the job handles. Returns the number
/// of sessions signalled.
pub fn kill_all_sessions() -> usize {
    #[cfg(unix)]
    {
        imp::kill_all()
    }
    #[cfg(not(unix))]
    {
        0
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    #[test]
    fn job_kills_assigned_tree() {
        let job = Job::new().expect("create job");
        assert_eq!(job.active_processes().unwrap(), 0);
        let mut child = std::process::Command::new("cmd.exe")
            .args(["/c", "ping -n 30 127.0.0.1 >NUL"])
            .spawn()
            .expect("spawn cmd");
        job.assign_pid(child.id()).expect("assign");
        let deadline = Instant::now() + Duration::from_secs(5);
        while job.active_processes().unwrap() < 2 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(job.active_processes().unwrap() >= 1);
        job.terminate(9).expect("terminate");
        let status = child.wait().unwrap();
        assert_eq!(status.code(), Some(9));
        let deadline = Instant::now() + Duration::from_secs(5);
        while job.active_processes().unwrap() > 0 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(job.active_processes().unwrap(), 0);
    }
}

#[cfg(all(test, unix))]
mod unix_tests {
    use super::*;
    use std::os::unix::process::CommandExt;
    use std::time::{Duration, Instant};

    /// Like portable-pty's spawn: the child leads a new session.
    fn spawn_session_leader(script: &str) -> std::process::Child {
        let mut cmd = std::process::Command::new("sh");
        cmd.args(["-c", script]);
        // SAFETY: setsid is async-signal-safe and the closure touches nothing else.
        unsafe {
            cmd.pre_exec(|| if libc::setsid() == -1 { Err(io::Error::last_os_error()) } else { Ok(()) });
        }
        cmd.spawn().expect("spawn sh")
    }

    fn wait_until(timeout: Duration, mut f: impl FnMut() -> bool) -> bool {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if f() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        f()
    }

    fn members(sid: u32) -> Vec<u32> {
        crate::procs::session_members(&crate::procs::snapshot(crate::procs::Detail::Basic, true), sid)
    }

    #[test]
    fn container_kills_whole_session() {
        let mut child = spawn_session_leader("sleep 30 & sleep 30");
        let c = ProcessContainer::new().unwrap();
        assert_eq!(c.active_processes().unwrap(), 0, "nothing assigned yet");
        c.assign_pid(child.id()).unwrap();
        // The shell (or the exec'd foreground sleep) plus the background sleep.
        assert!(wait_until(Duration::from_secs(5), || c.active_processes().unwrap() >= 2), "background child never appeared");
        let before = members(child.id());
        assert!(before.len() >= 2, "{before:?}");

        let t = Instant::now();
        c.terminate(1).unwrap();
        assert!(t.elapsed() < Duration::from_millis(1000), "terminate must not block: {:?}", t.elapsed());
        let status = child.wait().unwrap();
        assert!(!status.success());
        // The background sleep was re-parented (init / a subreaper) and killed with the session.
        assert!(wait_until(Duration::from_secs(5), || c.active_processes().unwrap() == 0), "processes survived");
        let alive: Vec<u32> = crate::procs::snapshot(crate::procs::Detail::Basic, false)
            .into_iter()
            .filter(|r| before.contains(&r.pid) && !r.zombie)
            .map(|r| r.pid)
            .collect();
        assert!(alive.is_empty(), "still alive: {alive:?}");
    }

    #[test]
    fn hang_up_ends_a_shell_and_its_jobs() {
        let mut child = spawn_session_leader("sleep 30 & sleep 30; wait");
        let c = ProcessContainer::new().unwrap();
        c.assign_pid(child.id()).unwrap();
        assert!(wait_until(Duration::from_secs(5), || c.active_processes().unwrap() >= 2));
        c.hang_up().unwrap();
        let _ = child.wait();
        assert!(wait_until(Duration::from_secs(5), || c.active_processes().unwrap() == 0), "SIGHUP left processes behind");
    }

    /// `kill_all_sessions` itself is not called here: tests run in parallel and it would kill the
    /// other tests' sessions. Registration + the kill path it uses are checked instead.
    #[test]
    fn registered_sessions_can_be_killed_without_a_container_call() {
        let mut child = spawn_session_leader("sleep 30 & sleep 30");
        let sid = child.id();
        let c = ProcessContainer::new().unwrap();
        c.assign_pid(sid).unwrap();
        assert!(super::imp::is_registered(sid));
        assert!(wait_until(Duration::from_secs(5), || c.active_processes().unwrap() >= 2));
        super::imp::kill_sessions(&[sid as i32]);
        let _ = child.wait();
        assert!(wait_until(Duration::from_secs(5), || c.active_processes().unwrap() == 0));
        drop(c);
        assert!(!super::imp::is_registered(sid), "dropped containers leave the registry");
    }

    #[test]
    fn refuses_init_and_unassigned_is_inert() {
        let c = ProcessContainer::new().unwrap();
        assert!(c.assign_pid(1).is_err());
        assert!(c.assign_pid(0).is_err());
        c.terminate(1).unwrap();
        c.hang_up().unwrap();
        assert_eq!(c.active_processes().unwrap(), 0);
    }
}
