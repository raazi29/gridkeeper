//! Low-memory guard (ADR-024): warn before the machine runs out of commit, and keep Gridkeeper alive
//! long enough to say so.
//!
//! When Windows reaches its commit limit (RAM + page files), allocations fail everywhere at once:
//! WebView2 processes exit with STATUS_COMMITMENT_LIMIT, and a Rust allocation failure aborts the host,
//! which takes every agent with it (one Job Object per session, ADR-009). Gridkeeper's own use is small;
//! the agents and other programs fill the machine. This module watches the free commit and tells the
//! frontend when it crosses a threshold, so the user can close something first.
//!
//! - **Reading.** One thread wakes every [`TICK`] (5 s) and makes one cheap call: `GlobalMemoryStatusEx`
//!   on Windows (`ullTotalPageFile` = commit limit, `ullAvailPageFile` = free commit), available
//!   memory + free swap through sysinfo on Linux (`/proc/meminfo`). macOS is not covered: its swap
//!   grows on demand, so "available memory" there is not a limit and would warn falsely; the guard
//!   reports `supported: false`. A fixed 5 s timer on one thread is the exception to "no polling while
//!   idle": the condition it watches is caused by other programs, so there is no event to wait on.
//! - **Levels.** [`next_level`] (pure, unit-tested): `low` below max(2 GiB, 5 % of the limit),
//!   `critical` below max(1 GiB, 2.5 %), with 512 MiB of hysteresis on the way back up.
//! - **Events.** `memory-status` only when the level changes; `memory_status` reads on demand. The
//!   per-process list (one Toolhelp walk + one `GetProcessMemoryInfo` per process, ~10-20 ms) is only
//!   built while the level is not `ok`.
//! - **Emergency reserve** (Windows). 64 MiB committed at startup, released on entering `critical` so
//!   the host's own allocations (building this status, the WebView's IPC) still find commit; taken back
//!   once the level is `ok` again. Linux overcommits, so untouched memory reserves nothing there.

use std::collections::{HashMap, HashSet, VecDeque};
use std::time::Duration;

use parking_lot::Mutex;
use tauri::{AppHandle, Emitter, Manager};

use crate::types::{AppError, AppResult, MemoryConsumer, MemoryLevel, MemoryStatus, EVT_MEMORY_STATUS};

/// Interval between readings.
pub const TICK: Duration = Duration::from_secs(5);
const MIB: u64 = 1 << 20;
const GIB: u64 = 1 << 30;
/// Hysteresis: a level is left upwards only this far above its threshold.
pub const RECOVER_MARGIN: u64 = 512 * MIB;
/// Emergency reserve (Windows): committed, never touched (commit is charged at commit time, so it
/// costs no RAM).
pub const RESERVE_BYTES: usize = 64 << 20;
/// Programs listed in the status.
const TOP_N: usize = 5;

// ---------------------------------------------------------------------------
// Levels (pure)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Thresholds {
    /// `low` below this much free.
    pub low: u64,
    /// `critical` below this much free.
    pub critical: u64,
}

/// Thresholds for a commit limit (or RAM + swap) of `limit` bytes. The floors matter on small and
/// mid-size machines (16 GB RAM + a 24 GB page file → 2 GiB / 1 GiB); the percentages on large ones.
/// Capped at a quarter / an eighth of the limit so a tiny VM is not permanently "low".
pub fn thresholds(limit: u64) -> Thresholds {
    Thresholds { low: (2 * GIB).max(limit / 20).min(limit / 4), critical: GIB.max(limit / 40).min(limit / 8) }
}

/// The level after a reading of `free` bytes, given the previous level. Going down is immediate; going
/// up needs [`RECOVER_MARGIN`] above the threshold being left, so a reading hovering at a threshold
/// does not flap the banner and the launch hold.
pub fn next_level(prev: MemoryLevel, free: u64, limit: u64) -> MemoryLevel {
    let t = thresholds(limit);
    if free < t.critical {
        return MemoryLevel::Critical;
    }
    let raw = if free < t.low { MemoryLevel::Low } else { MemoryLevel::Ok };
    match prev {
        MemoryLevel::Ok => raw,
        MemoryLevel::Low => {
            if free >= t.low.saturating_add(RECOVER_MARGIN) {
                MemoryLevel::Ok
            } else {
                MemoryLevel::Low
            }
        }
        MemoryLevel::Critical => {
            if free >= t.low.saturating_add(RECOVER_MARGIN) {
                MemoryLevel::Ok
            } else if free >= t.critical.saturating_add(RECOVER_MARGIN) {
                MemoryLevel::Low
            } else {
                MemoryLevel::Critical
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Consumers (pure summary over one process walk)
// ---------------------------------------------------------------------------

/// One process from the walk.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcMem {
    pub pid: u32,
    pub ppid: u32,
    pub name: String,
    /// Private bytes (Windows) / RSS (Linux); 0 when the process could not be queried.
    pub bytes: u64,
    /// Creation time in any monotonic unit; 0 = unknown. Guards the tree walk against PID reuse.
    pub created: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Summary {
    pub top: Vec<MemoryConsumer>,
    pub agents_bytes: u64,
    pub app_bytes: u64,
}

/// `root` and its live descendants. A child created before its parent means the parent pid was
/// reused, so that child is not followed (same guard as `diagnostics`).
fn descendants(procs: &HashMap<u32, &ProcMem>, children: &HashMap<u32, Vec<u32>>, root: u32, out: &mut HashSet<u32>) {
    if !procs.contains_key(&root) {
        return;
    }
    let mut queue = VecDeque::from([root]);
    while let Some(pid) = queue.pop_front() {
        if !out.insert(pid) {
            continue;
        }
        let parent_created = procs.get(&pid).map(|p| p.created).unwrap_or(0);
        for &child in children.get(&pid).map(Vec::as_slice).unwrap_or(&[]) {
            let child_created = procs.get(&child).map(|p| p.created).unwrap_or(0);
            if parent_created != 0 && child_created != 0 && child_created < parent_created {
                continue;
            }
            queue.push_back(child);
        }
    }
}

/// Top `n` programs (grouped by executable name, case-insensitively) plus Gridkeeper's share:
/// `agents` = the session roots' trees, `app` = the host's tree without them.
pub fn summarize(procs: &[ProcMem], host: u32, roots: &[u32], n: usize) -> Summary {
    let by_pid: HashMap<u32, &ProcMem> = procs.iter().map(|p| (p.pid, p)).collect();
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for p in procs {
        if p.ppid != 0 && p.ppid != p.pid {
            children.entry(p.ppid).or_default().push(p.pid);
        }
    }
    let mut agents = HashSet::new();
    for &r in roots {
        descendants(&by_pid, &children, r, &mut agents);
    }
    let mut app = HashSet::new();
    descendants(&by_pid, &children, host, &mut app);
    let bytes_of = |set: &HashSet<u32>| set.iter().filter_map(|pid| by_pid.get(pid)).map(|p| p.bytes).sum::<u64>();
    let agents_bytes = bytes_of(&agents);
    let app_bytes = bytes_of(&app.difference(&agents).copied().collect::<HashSet<u32>>());

    // name (lower case) -> consumer, plus the largest member's bytes for its pid.
    let mut groups: HashMap<String, (MemoryConsumer, u64)> = HashMap::new();
    for p in procs.iter().filter(|p| p.bytes > 0) {
        let g = groups.entry(p.name.to_lowercase()).or_insert_with(|| (MemoryConsumer { name: p.name.clone(), ..Default::default() }, 0));
        g.0.count += 1;
        g.0.bytes += p.bytes;
        if p.bytes > g.1 {
            g.1 = p.bytes;
            g.0.pid = p.pid;
        }
    }
    let mut top: Vec<MemoryConsumer> = groups.into_values().map(|(c, _)| c).collect();
    top.sort_by(|a, b| b.bytes.cmp(&a.bytes).then_with(|| a.name.cmp(&b.name)));
    top.truncate(n);
    Summary { top, agents_bytes, app_bytes }
}

// ---------------------------------------------------------------------------
// Platform
// ---------------------------------------------------------------------------

/// One reading: the limit and how much of it is free, in bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Reading {
    pub limit: u64,
    pub free: u64,
}

#[cfg(windows)]
mod plat {
    use super::{ProcMem, Reading};
    use windows_sys::Win32::Foundation::{CloseHandle, FILETIME, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::Memory::{MEM_COMMIT, MEM_RELEASE, MEM_RESERVE, PAGE_READWRITE, VirtualAlloc, VirtualFree};
    use windows_sys::Win32::System::ProcessStatus::{K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX};
    use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    use windows_sys::Win32::System::Threading::{GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

    pub const SUPPORTED: bool = true;

    pub fn read() -> Option<Reading> {
        // SAFETY: `dwLength` is set as the API requires; the struct is a plain out-parameter.
        unsafe {
            let mut m: MEMORYSTATUSEX = std::mem::zeroed();
            m.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
            if GlobalMemoryStatusEx(&mut m) == 0 || m.ullTotalPageFile == 0 {
                return None;
            }
            Some(Reading { limit: m.ullTotalPageFile, free: m.ullAvailPageFile })
        }
    }

    fn name(wide: &[u16]) -> String {
        let len = wide.iter().position(|&c| c == 0).unwrap_or(wide.len());
        String::from_utf16_lossy(&wide[..len])
    }

    /// Private bytes (commit charge) and creation time; None when the process cannot be opened
    /// (protected / elevated processes).
    fn query(pid: u32) -> Option<(u64, u64)> {
        // SAFETY: plain Win32 calls on a handle we own and close; out-params are zero-initialized
        // structs of the documented size (`PROCESS_MEMORY_COUNTERS_EX` starts with the base struct).
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if h.is_null() {
                return None;
            }
            let mut mem: PROCESS_MEMORY_COUNTERS_EX = std::mem::zeroed();
            mem.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32;
            let mem_ok = K32GetProcessMemoryInfo(h, &mut mem as *mut _ as *mut PROCESS_MEMORY_COUNTERS, mem.cb) != 0;
            let (mut c, mut e, mut k, mut u): (FILETIME, FILETIME, FILETIME, FILETIME) = std::mem::zeroed();
            let created = if GetProcessTimes(h, &mut c, &mut e, &mut k, &mut u) != 0 {
                ((c.dwHighDateTime as u64) << 32) | c.dwLowDateTime as u64
            } else {
                0
            };
            CloseHandle(h);
            mem_ok.then_some((mem.PrivateUsage as u64, created))
        }
    }

    pub fn processes() -> Vec<ProcMem> {
        let mut out = Vec::with_capacity(512);
        // SAFETY: standard Toolhelp enumeration; `dwSize` is initialized as the API requires and the
        // snapshot handle is closed before returning.
        unsafe {
            let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snap == INVALID_HANDLE_VALUE || snap.is_null() {
                return out;
            }
            let mut entry: PROCESSENTRY32W = std::mem::zeroed();
            entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
            let mut ok = Process32FirstW(snap, &mut entry);
            while ok != 0 {
                out.push(ProcMem { pid: entry.th32ProcessID, ppid: entry.th32ParentProcessID, name: name(&entry.szExeFile), bytes: 0, created: 0 });
                ok = Process32NextW(snap, &mut entry);
            }
            CloseHandle(snap);
        }
        for p in &mut out {
            if p.pid == 0 {
                continue; // System Idle Process
            }
            if let Some((bytes, created)) = query(p.pid) {
                p.bytes = bytes;
                p.created = created;
            }
        }
        out
    }

    /// The emergency reserve: committed address space, never touched. Stored as an address so the
    /// monitor state stays `Send`.
    #[derive(Default)]
    pub struct Reserve(Option<usize>);

    impl Reserve {
        pub fn held(&self) -> bool {
            self.0.is_some()
        }

        pub fn acquire(&mut self) -> bool {
            if self.0.is_none() {
                // SAFETY: a fresh private allocation; the address is only ever passed back to VirtualFree.
                let p = unsafe { VirtualAlloc(std::ptr::null(), super::RESERVE_BYTES, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE) };
                if !p.is_null() {
                    self.0 = Some(p as usize);
                }
            }
            self.0.is_some()
        }

        pub fn release(&mut self) {
            if let Some(p) = self.0.take() {
                // SAFETY: `p` is the base address VirtualAlloc returned and is released exactly once.
                unsafe { VirtualFree(p as *mut core::ffi::c_void, 0, MEM_RELEASE) };
            }
        }
    }
}

#[cfg(target_os = "linux")]
mod plat {
    use super::{ProcMem, Reading};
    use crate::procs::{self, Detail};
    use sysinfo::{MemoryRefreshKind, System};

    pub const SUPPORTED: bool = true;

    /// Available RAM + free swap against RAM + swap: what the kernel can still hand out before the
    /// OOM killer runs.
    pub fn read() -> Option<Reading> {
        let mut sys = System::new();
        sys.refresh_memory_specifics(MemoryRefreshKind::nothing().with_ram().with_swap());
        let limit = sys.total_memory().saturating_add(sys.total_swap());
        (limit > 0).then(|| Reading { limit, free: sys.available_memory().saturating_add(sys.free_swap()) })
    }

    pub fn processes() -> Vec<ProcMem> {
        procs::snapshot(Detail::Usage, false)
            .into_iter()
            .filter(|r| !r.zombie)
            .map(|r| ProcMem { pid: r.pid, ppid: r.ppid, name: r.name, bytes: r.rss, created: r.start_time })
            .collect()
    }

    /// Linux overcommits: untouched memory reserves nothing, so there is no reserve.
    #[derive(Default)]
    pub struct Reserve;

    impl Reserve {
        pub fn held(&self) -> bool {
            false
        }
        pub fn acquire(&mut self) -> bool {
            false
        }
        pub fn release(&mut self) {}
    }
}

#[cfg(not(any(windows, target_os = "linux")))]
mod plat {
    use super::{ProcMem, Reading};

    /// macOS: swap grows on demand, there is no fixed limit to warn about (see the module docs).
    pub const SUPPORTED: bool = false;

    pub fn read() -> Option<Reading> {
        None
    }

    pub fn processes() -> Vec<ProcMem> {
        Vec::new()
    }

    #[derive(Default)]
    pub struct Reserve;

    impl Reserve {
        pub fn held(&self) -> bool {
            false
        }
        pub fn acquire(&mut self) -> bool {
            false
        }
        pub fn release(&mut self) {}
    }
}

// ---------------------------------------------------------------------------
// Monitor
// ---------------------------------------------------------------------------

#[derive(Default)]
struct Monitor {
    /// None until the first reading.
    level: Option<MemoryLevel>,
    reserve: plat::Reserve,
}

static MONITOR: Mutex<Option<Monitor>> = Mutex::new(None);

/// One reading through the level machine. Returns the reading, the new level and whether it changed.
/// The reserve is released before anything else happens on entering `critical`.
fn step() -> Option<(Reading, MemoryLevel, bool)> {
    let reading = plat::read()?;
    let mut guard = MONITOR.lock();
    let m = guard.get_or_insert_with(Monitor::default);
    let first = m.level.is_none();
    let prev = m.level.unwrap_or_default();
    let level = next_level(prev, reading.free, reading.limit);
    m.level = Some(level);
    match level {
        MemoryLevel::Critical => m.reserve.release(),
        // Taken at startup unless already critical, then only once memory has fully recovered (the
        // hysteresis keeps this from alternating with the release).
        MemoryLevel::Low if first => {
            m.reserve.acquire();
        }
        MemoryLevel::Ok => {
            m.reserve.acquire();
        }
        MemoryLevel::Low => {}
    }
    Some((reading, level, first || level != prev))
}

fn reserve_held() -> bool {
    MONITOR.lock().as_ref().is_some_and(|m| m.reserve.held())
}

/// The full status for `level`; the process walk only runs when the level is not `ok`.
fn build_status(app: &AppHandle, reading: Reading, level: MemoryLevel) -> MemoryStatus {
    let t = thresholds(reading.limit);
    let mut status = MemoryStatus {
        supported: true,
        level,
        limit_bytes: reading.limit,
        free_bytes: reading.free,
        low_bytes: t.low,
        critical_bytes: t.critical,
        reserve_held: reserve_held(),
        ..Default::default()
    };
    if level != MemoryLevel::Ok {
        let roots: Vec<u32> = app
            .try_state::<crate::state::AppCtx>()
            .map(|ctx| ctx.sessions.root_pids().into_iter().map(|(_, pid)| pid).collect())
            .unwrap_or_default();
        let s = summarize(&plat::processes(), std::process::id(), &roots, TOP_N);
        status.top = s.top;
        status.agents_bytes = Some(s.agents_bytes);
        status.app_bytes = Some(s.app_bytes);
    }
    status
}

fn tick(app: &AppHandle) {
    let Some((reading, level, changed)) = step() else { return };
    if !changed {
        return;
    }
    let status = build_status(app, reading, level);
    let top: Vec<String> = status.top.iter().map(|c| format!("{} x{} {} MiB", c.name, c.count, c.bytes / MIB)).collect();
    tracing::info!(
        ?level,
        free_mib = reading.free / MIB,
        limit_mib = reading.limit / MIB,
        agents_mib = status.agents_bytes.map(|b| b / MIB),
        reserve_held = status.reserve_held,
        top = %top.join(", "),
        "memory level"
    );
    if let Err(e) = app.emit(EVT_MEMORY_STATUS, &status) {
        tracing::warn!(error = %e, "could not emit memory-status");
    }
}

/// Start the monitor thread (once, from `setup`). No-op where the guard is unsupported.
pub fn start(app: AppHandle) {
    if !plat::SUPPORTED {
        return;
    }
    let spawned = std::thread::Builder::new().name("memguard".into()).spawn(move || {
        loop {
            // A panic in one reading must not end the guard (or, with unwind, anything else).
            if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| tick(&app))).is_err() {
                tracing::warn!("memory guard reading panicked");
            }
            std::thread::sleep(TICK);
        }
    });
    if let Err(e) = spawned {
        tracing::warn!(error = %e, "memory guard thread did not start");
    }
}

/// Current status: a fresh reading with the monitor's level (hysteresis included).
#[tauri::command]
pub async fn memory_status(app: AppHandle) -> AppResult<MemoryStatus> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(reading) = plat::read() else { return MemoryStatus::default() };
        let level = MONITOR.lock().as_ref().and_then(|m| m.level);
        let level = match level {
            Some(l) => l,
            // Asked before the thread's first reading: take that reading here.
            None => step().map(|(_, l, _)| l).unwrap_or_default(),
        };
        build_status(&app, reading, level)
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use MemoryLevel::{Critical, Low, Ok};

    const LIMIT: u64 = 40 * GIB; // the 16 GB RAM + 24 GB page file machine

    #[test]
    fn thresholds_floors_percentages_and_caps() {
        assert_eq!(thresholds(LIMIT), Thresholds { low: 2 * GIB, critical: GIB });
        // Large machine: the percentages win.
        assert_eq!(thresholds(200 * GIB), Thresholds { low: 10 * GIB, critical: 5 * GIB });
        // Tiny VM: capped at a quarter / an eighth of the limit.
        assert_eq!(thresholds(4 * GIB), Thresholds { low: GIB, critical: GIB / 2 });
    }

    #[test]
    fn levels_go_down_immediately() {
        assert_eq!(next_level(Ok, 3 * GIB, LIMIT), Ok);
        assert_eq!(next_level(Ok, 2 * GIB - 1, LIMIT), Low);
        assert_eq!(next_level(Ok, GIB - 1, LIMIT), Critical);
        assert_eq!(next_level(Low, GIB - 1, LIMIT), Critical);
        assert_eq!(next_level(Ok, 0, LIMIT), Critical);
    }

    #[test]
    fn levels_come_back_with_hysteresis() {
        // Low stays low just above the threshold, recovers past threshold + margin.
        assert_eq!(next_level(Low, 2 * GIB, LIMIT), Low);
        assert_eq!(next_level(Low, 2 * GIB + RECOVER_MARGIN - 1, LIMIT), Low);
        assert_eq!(next_level(Low, 2 * GIB + RECOVER_MARGIN, LIMIT), Ok);
        // Critical: back to low past critical + margin, to ok past low + margin.
        assert_eq!(next_level(Critical, GIB, LIMIT), Critical);
        assert_eq!(next_level(Critical, GIB + RECOVER_MARGIN - 1, LIMIT), Critical);
        assert_eq!(next_level(Critical, GIB + RECOVER_MARGIN, LIMIT), Low);
        assert_eq!(next_level(Critical, 2 * GIB + RECOVER_MARGIN, LIMIT), Ok);
    }

    #[test]
    fn hovering_at_a_threshold_does_not_flap() {
        let mut level = Ok;
        let mut changes = 0;
        for i in 0..100u64 {
            // ±64 MiB around the low threshold.
            let free = if i % 2 == 0 { 2 * GIB - 64 * MIB } else { 2 * GIB + 64 * MIB };
            let next = next_level(level, free, LIMIT);
            if next != level {
                changes += 1;
            }
            level = next;
        }
        assert_eq!(level, Low);
        assert_eq!(changes, 1);
    }

    fn p(pid: u32, ppid: u32, name: &str, mib: u64, created: u64) -> ProcMem {
        ProcMem { pid, ppid, name: name.into(), bytes: mib * MIB, created }
    }

    #[test]
    fn summary_groups_by_name_and_attributes_trees() {
        let procs = vec![
            p(4, 0, "System", 0, 1),
            p(100, 4, "gridkeeper.exe", 80, 10),
            p(101, 100, "msedgewebview2.exe", 300, 11),
            p(102, 100, "conhost.exe", 10, 12),
            p(200, 100, "pwsh.exe", 60, 20), // session 1 root
            p(201, 200, "claude.exe", 700, 21),
            p(300, 100, "pwsh.exe", 60, 30), // session 2 root
            p(301, 300, "CLAUDE.EXE", 600, 31),
            p(302, 300, "node.exe", 100, 32),
            p(400, 4, "chrome.exe", 500, 40),
            p(401, 400, "chrome.exe", 400, 41),
            // Pid reuse: claims session 1's root as parent but was created before it.
            p(500, 200, "old.exe", 900, 5),
        ];
        let s = summarize(&procs, 100, &[200, 300], 3);
        let names: Vec<(&str, u32, u32, u64)> = s.top.iter().map(|c| (c.name.as_str(), c.pid, c.count, c.bytes / MIB)).collect();
        // Equal totals sort by name.
        assert_eq!(names, vec![("claude.exe", 201, 2, 1300), ("chrome.exe", 400, 2, 900), ("old.exe", 500, 1, 900)]);
        assert_eq!(s.agents_bytes / MIB, 60 + 700 + 60 + 600 + 100);
        assert_eq!(s.app_bytes / MIB, 80 + 300 + 10);
    }

    #[test]
    fn summary_handles_missing_roots_and_cycles() {
        let procs = vec![p(10, 11, "a", 1, 0), p(11, 10, "b", 2, 0)];
        let s = summarize(&procs, 999, &[10, 12345], 5);
        assert_eq!(s.agents_bytes / MIB, 3);
        assert_eq!(s.app_bytes, 0);
        assert_eq!(s.top.len(), 2);
    }

    #[cfg(windows)]
    #[test]
    fn windows_reading_and_reserve() {
        let r = plat::read().expect("GlobalMemoryStatusEx");
        assert!(r.limit > 0 && r.free <= r.limit, "{r:?}");
        let mut reserve = plat::Reserve::default();
        if reserve.acquire() {
            assert!(reserve.held());
            reserve.release();
        }
        assert!(!reserve.held());
        let me = std::process::id();
        let procs = plat::processes();
        let mine = procs.iter().find(|p| p.pid == me).expect("own pid listed");
        assert!(mine.bytes > 0 && mine.created > 0, "{mine:?}");
    }
}
