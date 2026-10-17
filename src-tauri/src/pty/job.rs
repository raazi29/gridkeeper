//! Per-session Windows Job Object.
//!
//! Every session's root process is assigned to its own job created with
//! `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` and *without* any breakaway flags, so
//! all descendants (agent CLIs, MCP servers, `Start-Process -NoNewWindow`
//! children, ...) stay in the job. Terminating the job — or simply closing the
//! last handle, including when Altera itself exits or crashes — kills exactly
//! that session's process tree and nothing else.
//!
//! Known limitation: portable-pty does not spawn with `CREATE_SUSPENDED`, so a
//! child that forks in the first microseconds (before assignment) could escape
//! the job. Shells and agent CLIs do not do this in practice.

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

#[cfg(not(windows))]
mod imp {
    use std::io;

    /// Non-Windows placeholder so the crate type-checks elsewhere; Altera only
    /// ships on Windows.
    pub struct Job;

    impl Job {
        pub fn new() -> io::Result<Self> {
            Err(io::Error::new(io::ErrorKind::Unsupported, "job objects require Windows"))
        }
        pub fn assign_pid(&self, _pid: u32) -> io::Result<()> {
            Ok(())
        }
        pub fn terminate(&self, _exit_code: u32) -> io::Result<()> {
            Ok(())
        }
        pub fn active_processes(&self) -> io::Result<u32> {
            Ok(0)
        }
    }
}

/// A kill-on-close job containing one session's process tree.
pub struct Job(imp::Job);

impl Job {
    /// Create an empty job with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`.
    pub fn new() -> io::Result<Self> {
        imp::Job::new().map(Job)
    }

    /// Assign a running process (and therefore its future descendants).
    pub fn assign_pid(&self, pid: u32) -> io::Result<()> {
        self.0.assign_pid(pid)
    }

    /// Terminate every process in the job.
    pub fn terminate(&self, exit_code: u32) -> io::Result<()> {
        self.0.terminate(exit_code)
    }

    /// Number of processes currently alive in the job.
    pub fn active_processes(&self) -> io::Result<u32> {
        self.0.active_processes()
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
