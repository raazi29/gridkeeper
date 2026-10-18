//! Unix process table (macOS and Linux), shared by session containment (`pty::job`), diagnostics and
//! port attribution. Windows uses Toolhelp / Job Objects instead and never calls into this module at
//! runtime (it still compiles there, so the pure helpers are unit-tested on every platform).
//!
//! One `sysinfo::System` is kept for the life of the process: sysinfo reuses its per-process state
//! between refreshes, which keeps repeated walks (the waiter's orphan check, the 2 s diagnostics poll)
//! cheap. Threads (Linux tasks) are never listed.

use std::sync::OnceLock;

use parking_lot::Mutex;
use sysinfo::{Pid, ProcessRefreshKind, ProcessStatus, ProcessesToUpdate, System};

/// One process, as seen by the last refresh.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcRow {
    pub pid: u32,
    /// 0 when unknown.
    pub ppid: u32,
    /// Session id (`getsid`); `None` when the process vanished or is not visible.
    pub sid: Option<u32>,
    pub zombie: bool,
    /// Short process name (Linux: `comm`, at most 15 bytes; macOS: the executable name).
    pub name: String,
    /// Start time, seconds since the epoch (PID-reuse guard).
    pub start_time: u64,
    /// User + system CPU time in milliseconds (only filled by [`Detail::Usage`] refreshes).
    pub cpu_ms: u64,
    /// Resident set size in bytes (only filled by [`Detail::Usage`] refreshes).
    pub rss: u64,
}

/// How much to read per process.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Detail {
    /// pid, parent, name, start time, status: enough for trees and containment.
    Basic,
    /// Also CPU time and memory (diagnostics).
    Usage,
}

fn system() -> &'static Mutex<System> {
    static SYS: OnceLock<Mutex<System>> = OnceLock::new();
    SYS.get_or_init(|| Mutex::new(System::new()))
}

/// Walk the process table once and return every process (threads excluded).
/// `with_sid` also queries each process's session id (one `getsid` call per process).
pub fn snapshot(detail: Detail, with_sid: bool) -> Vec<ProcRow> {
    walk(&mut system().lock(), detail, with_sid)
}

/// [`snapshot`] (basic detail, with session ids) unless another thread is walking the table right
/// now. For the host's last moments (panic hook, fatal signal), where waiting could deadlock.
pub fn try_snapshot() -> Option<Vec<ProcRow>> {
    system().try_lock().map(|mut sys| walk(&mut sys, Detail::Basic, true))
}

fn walk(sys: &mut System, detail: Detail, with_sid: bool) -> Vec<ProcRow> {
    let mut kind = ProcessRefreshKind::nothing().without_tasks();
    if detail == Detail::Usage {
        kind = kind.with_cpu().with_memory();
    }
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, kind);
    sys.processes()
        .values()
        .filter(|p| p.thread_kind().is_none())
        .map(|p| ProcRow {
            pid: p.pid().as_u32(),
            ppid: p.parent().map(Pid::as_u32).unwrap_or(0),
            sid: if with_sid { p.session_id().map(Pid::as_u32) } else { None },
            zombie: matches!(p.status(), ProcessStatus::Zombie | ProcessStatus::Dead),
            name: p.name().to_string_lossy().into_owned(),
            start_time: p.start_time(),
            cpu_ms: p.accumulated_cpu_time(),
            rss: p.memory(),
        })
        .collect()
}

/// Members of the session whose id is `sid` (the session leader's pid), plus every live descendant
/// of a member (children that started a session of their own while their parent was alive, like a
/// Job Object keeps them). Zombies are left out: they hold no resources and cannot be signalled
/// away. Pure, so it is unit-tested with fixtures on every platform.
pub fn session_members(rows: &[ProcRow], sid: u32) -> Vec<u32> {
    use std::collections::{HashMap, HashSet, VecDeque};
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for r in rows {
        if r.ppid != 0 && r.ppid != r.pid {
            children.entry(r.ppid).or_default().push(r.pid);
        }
    }
    let zombie: HashSet<u32> = rows.iter().filter(|r| r.zombie).map(|r| r.pid).collect();
    let mut seen: HashSet<u32> = HashSet::new();
    let mut queue: VecDeque<u32> = rows.iter().filter(|r| r.sid == Some(sid)).map(|r| r.pid).collect();
    let mut out = Vec::new();
    while let Some(pid) = queue.pop_front() {
        if !seen.insert(pid) {
            continue;
        }
        if !zombie.contains(&pid) {
            out.push(pid);
        }
        if let Some(kids) = children.get(&pid) {
            queue.extend(kids.iter().copied());
        }
    }
    out.sort_unstable();
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(pid: u32, ppid: u32, sid: u32, zombie: bool) -> ProcRow {
        ProcRow { pid, ppid, sid: Some(sid), zombie, name: format!("p{pid}"), start_time: 0, cpu_ms: 0, rss: 0 }
    }

    #[test]
    fn members_by_session_and_descendants() {
        let rows = vec![
            row(1, 0, 1, false),
            row(100, 1, 100, false),  // session leader (the shell)
            row(101, 100, 100, false), // job-control child in its own group, same session
            row(102, 1, 100, false),  // orphan, re-parented to init, still in the session
            row(103, 101, 103, false), // detached (setsid) child of a member
            row(104, 103, 103, false), // ...and its child
            row(105, 100, 100, true),  // zombie: not listed
            row(200, 1, 200, false),  // unrelated session
            row(201, 200, 200, false),
        ];
        assert_eq!(session_members(&rows, 100), vec![100, 101, 102, 103, 104]);
        assert_eq!(session_members(&rows, 200), vec![200, 201]);
        assert!(session_members(&rows, 999).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn snapshot_sees_this_process() {
        let me = std::process::id();
        let rows = snapshot(Detail::Usage, true);
        let mine = rows.iter().find(|r| r.pid == me).expect("own pid listed");
        assert!(mine.rss > 0, "{mine:?}");
        // SAFETY: getsid(0) only reads the calling process's session id.
        let sid = unsafe { libc::getsid(0) };
        assert_eq!(mine.sid, Some(sid as u32));
        assert!(!mine.zombie);
    }
}
