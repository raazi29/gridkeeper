//! Resource diagnostics: attribute CPU/RAM to the host process, its WebView2
//! processes and each session's process tree; export a redacted bundle.
//!
//! Sampling cost (measured, ~400 processes, release build): one Toolhelp
//! process snapshot (~6-7 ms; pid / parent pid / exe name) plus
//! `OpenProcess` + `GetProcessTimes` + `GetProcessMemoryInfo` for only the
//! processes we report on. sysinfo's per-process refresh would need a second
//! full Toolhelp walk (doubling the cost), so sysinfo is used only for
//! system-wide memory, CPU count and CPU brand.
//!
//! CPU% = process CPU-time delta / wall-clock delta between successive
//! snapshots (percent of ONE logical core, summed over processes). A process
//! seen for the first time reports 0 CPU.

use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::Instant;

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use regex::Regex;
use serde_json::{json, Value};
use sysinfo::{CpuRefreshKind, MemoryRefreshKind, System};

use crate::state::AppCtx;
use crate::types::*;

const LOG_TAIL_LINES: usize = 300;

/// Minimal Win32 process enumeration / query.
#[cfg(windows)]
mod win {
    use windows_sys::Win32::Foundation::{CloseHandle, FILETIME, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::ProcessStatus::{K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
    use windows_sys::Win32::System::Threading::{GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

    pub struct Entry {
        pub pid: u32,
        pub ppid: u32,
        pub is_webview: bool,
    }

    #[derive(Clone, Copy)]
    pub struct Times {
        /// FILETIME of process creation (100 ns units).
        pub creation: u64,
        /// Kernel + user CPU time (100 ns units).
        pub cpu: u64,
        /// Working set (RSS), bytes.
        pub working_set: u64,
    }

    fn eq_ascii_ci(wide: &[u16], ascii: &str) -> bool {
        let len = wide.iter().position(|&c| c == 0).unwrap_or(wide.len());
        len == ascii.len()
            && wide[..len].iter().zip(ascii.bytes()).all(|(&w, a)| w < 128 && (w as u8).eq_ignore_ascii_case(&a))
    }

    pub fn processes() -> Vec<Entry> {
        let mut out = Vec::with_capacity(512);
        // SAFETY: standard Toolhelp enumeration; `dwSize` is initialized as the
        // API requires and the snapshot handle is closed before returning.
        unsafe {
            let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snap == INVALID_HANDLE_VALUE || snap.is_null() {
                return out;
            }
            let mut entry: PROCESSENTRY32W = std::mem::zeroed();
            entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
            let mut ok = Process32FirstW(snap, &mut entry);
            while ok != 0 {
                out.push(Entry {
                    pid: entry.th32ProcessID,
                    ppid: entry.th32ParentProcessID,
                    is_webview: eq_ascii_ci(&entry.szExeFile, "msedgewebview2.exe"),
                });
                ok = Process32NextW(snap, &mut entry);
            }
            CloseHandle(snap);
        }
        out
    }

    fn ft(f: &FILETIME) -> u64 {
        ((f.dwHighDateTime as u64) << 32) | f.dwLowDateTime as u64
    }

    pub fn query(pid: u32) -> Option<Times> {
        // SAFETY: plain Win32 calls on a handle we own and close; out-params are
        // zero-initialized structs of the documented size.
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if h.is_null() {
                return None;
            }
            let mut c: FILETIME = std::mem::zeroed();
            let mut e: FILETIME = std::mem::zeroed();
            let mut k: FILETIME = std::mem::zeroed();
            let mut u: FILETIME = std::mem::zeroed();
            let times_ok = GetProcessTimes(h, &mut c, &mut e, &mut k, &mut u) != 0;
            let mut mem: PROCESS_MEMORY_COUNTERS = std::mem::zeroed();
            mem.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
            let mem_ok = K32GetProcessMemoryInfo(h, &mut mem, mem.cb) != 0;
            CloseHandle(h);
            if !times_ok {
                return None;
            }
            Some(Times {
                creation: ft(&c),
                cpu: ft(&k) + ft(&u),
                working_set: if mem_ok { mem.WorkingSetSize as u64 } else { 0 },
            })
        }
    }
}

#[cfg(not(windows))]
mod win {
    pub struct Entry {
        pub pid: u32,
        pub ppid: u32,
        pub is_webview: bool,
    }
    #[derive(Clone, Copy)]
    pub struct Times {
        pub creation: u64,
        pub cpu: u64,
        pub working_set: u64,
    }
    pub fn processes() -> Vec<Entry> {
        Vec::new()
    }
    pub fn query(_pid: u32) -> Option<Times> {
        None
    }
}

/// Previous CPU reading per pid: (creation time, cpu time, when).
type CpuHistory = HashMap<u32, (u64, u64, Instant)>;

pub struct DiagSampler {
    sys: Mutex<System>,
    history: Mutex<CpuHistory>,
}

impl Default for DiagSampler {
    fn default() -> Self {
        Self::new()
    }
}

/// Per-snapshot lazy cache of process queries.
#[derive(Default)]
struct Probe {
    cache: HashMap<u32, Option<win::Times>>,
}

impl Probe {
    fn get(&mut self, pid: u32) -> Option<win::Times> {
        *self.cache.entry(pid).or_insert_with(|| win::query(pid))
    }
}

/// `root` and its descendants, guarding against PID reuse and cycles.
fn tree(children: &HashMap<u32, Vec<u32>>, alive: &HashSet<u32>, probe: &mut Probe, root: u32) -> Vec<u32> {
    let mut out = Vec::new();
    if !alive.contains(&root) {
        return out;
    }
    let mut seen = HashSet::new();
    let mut queue = VecDeque::from([root]);
    while let Some(pid) = queue.pop_front() {
        if !seen.insert(pid) {
            continue;
        }
        out.push(pid);
        let Some(kids) = children.get(&pid) else { continue };
        let parent_created = probe.get(pid).map(|t| t.creation);
        for &child in kids {
            // A child cannot be created before its parent; otherwise the parent
            // PID was reused and this is not really a descendant.
            let child_created = probe.get(child).map(|t| t.creation);
            match (parent_created, child_created) {
                (Some(p), Some(c)) if c < p => {}
                _ => queue.push_back(child),
            }
        }
    }
    out
}

/// Turns raw readings into stats, tracking CPU deltas across snapshots.
struct Accumulator<'a> {
    now: Instant,
    alive: &'a HashSet<u32>,
    previous: &'a CpuHistory,
    next: CpuHistory,
    probe: Probe,
}

impl Accumulator<'_> {
    fn sum(&mut self, pids: &[u32]) -> ProcStats {
        let mut s = ProcStats::default();
        for &pid in pids {
            match self.probe.get(pid) {
                Some(t) => {
                    let cpu = match self.previous.get(&pid) {
                        Some(&(created, prev_cpu, at)) if created == t.creation => {
                            let wall = self.now.duration_since(at).as_secs_f64();
                            if wall > 0.0 { (t.cpu.saturating_sub(prev_cpu) as f64 / 1e7 / wall * 100.0) as f32 } else { 0.0 }
                        }
                        _ => 0.0,
                    };
                    self.next.insert(pid, (t.creation, t.cpu, self.now));
                    s.cpu_percent += cpu;
                    s.memory_bytes += t.working_set;
                    s.process_count += 1;
                }
                // Exists but not queryable (e.g. elevated): count it, no numbers.
                None if self.alive.contains(&pid) => s.process_count += 1,
                None => {}
            }
        }
        s
    }
}

impl DiagSampler {
    pub fn new() -> Self {
        let mut sys = System::new();
        sys.refresh_cpu_list(CpuRefreshKind::nothing());
        sys.refresh_memory_specifics(MemoryRefreshKind::nothing().with_ram());
        Self { sys: Mutex::new(sys), history: Mutex::new(HashMap::new()) }
    }

    pub fn snapshot(&self, roots: &[(SessionId, u32)]) -> Diagnostics {
        // One sampler at a time: CPU deltas need a consistent history.
        let mut history = self.history.lock();
        let now = Instant::now();
        let entries = win::processes();
        let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
        let mut alive: HashSet<u32> = HashSet::with_capacity(entries.len());
        let mut webview_named: HashSet<u32> = HashSet::new();
        for e in &entries {
            alive.insert(e.pid);
            if e.is_webview {
                webview_named.insert(e.pid);
            }
            if e.ppid != 0 && e.ppid != e.pid {
                children.entry(e.ppid).or_default().push(e.pid);
            }
        }

        let mut probe = Probe::default();
        let host = std::process::id();
        let webview: Vec<u32> = tree(&children, &alive, &mut probe, host)
            .into_iter()
            .filter(|pid| *pid != host && webview_named.contains(pid))
            .collect();
        let session_trees: Vec<(SessionId, Vec<u32>)> = roots
            .iter()
            .map(|(id, root)| (id.clone(), tree(&children, &alive, &mut probe, *root)))
            .collect();

        let mut acc = Accumulator { now, alive: &alive, previous: &history, next: HashMap::new(), probe };
        let host_stats = acc.sum(&[host]);
        let webview_stats = acc.sum(&webview);
        let mut total = ProcStats::default();
        let mut counted: HashSet<u32> = HashSet::new();
        let mut sessions = Vec::with_capacity(session_trees.len());
        for (id, pids) in &session_trees {
            let s = acc.sum(pids);
            // Aggregate without double counting overlapping trees.
            let unique: Vec<u32> = pids.iter().copied().filter(|p| counted.insert(*p)).collect();
            let u = acc.sum(&unique);
            total.cpu_percent += u.cpu_percent;
            total.memory_bytes += u.memory_bytes;
            total.process_count += u.process_count;
            sessions.push(SessionStats { id: id.clone(), stats: s });
        }
        // History keeps only processes reported this time (bounded size).
        *history = acc.next;
        drop(history);

        let mut sys = self.sys.lock();
        sys.refresh_memory_specifics(MemoryRefreshKind::nothing().with_ram());
        let logical_cores = match sys.cpus().len() {
            0 => std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1),
            n => n,
        } as u32;

        Diagnostics {
            host: host_stats,
            webview: webview_stats,
            sessions_total: total,
            sessions,
            logical_cores,
            system_memory_total: sys.total_memory(),
            system_memory_used: sys.used_memory(),
            running_sessions: roots.len() as u32,
        }
    }

    fn cpu_brand(&self) -> Option<String> {
        self.sys.lock().cpus().first().map(|c| c.brand().trim().to_string()).filter(|b| !b.is_empty())
    }
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

static EMAIL_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}").expect("email regex"));

/// Replaces the user's home directory with `~` (case-insensitive, `\` or `/`).
struct Scrubber {
    home: Option<Regex>,
}

impl Scrubber {
    fn new(home: Option<&Path>) -> Self {
        let home = home.map(|h| h.to_string_lossy().trim_end_matches(['\\', '/']).to_string()).filter(|h| h.len() > 3);
        let home = home.and_then(|h| {
            let parts: Vec<String> = h.split(['\\', '/']).map(regex::escape).collect();
            Regex::new(&format!(r"(?i){}", parts.join(r"[\\/]"))).ok()
        });
        Self { home }
    }

    fn text(&self, s: &str) -> String {
        let s = crate::redact::redact(s);
        let s = EMAIL_RE.replace_all(&s, "[email]");
        match &self.home {
            Some(re) => re.replace_all(&s, "~").into_owned(),
            None => s.into_owned(),
        }
    }

    fn value(&self, v: Value) -> Value {
        match v {
            Value::String(s) => Value::String(self.text(&s)),
            Value::Array(a) => Value::Array(a.into_iter().map(|x| self.value(x)).collect()),
            Value::Object(o) => Value::Object(o.into_iter().map(|(k, x)| (self.text(&k), self.value(x))).collect()),
            other => other,
        }
    }
}

/// Last `n` lines of a file, reading at most the final 2 MiB.
fn tail_lines(path: &Path, n: usize) -> Vec<String> {
    let Ok(mut f) = std::fs::File::open(path) else {
        return Vec::new();
    };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let start = len.saturating_sub(2 * 1024 * 1024);
    if f.seek(SeekFrom::Start(start)).is_err() {
        return Vec::new();
    }
    let mut buf = Vec::new();
    let _ = f.read_to_end(&mut buf);
    let text = String::from_utf8_lossy(&buf);
    let mut lines: Vec<&str> = text.lines().collect();
    if start > 0 && !lines.is_empty() {
        lines.remove(0); // probably a partial line
    }
    let skip = lines.len().saturating_sub(n);
    lines[skip..].iter().map(|l| l.to_string()).collect()
}

/// Everything the bundle is built from (separate from `AppCtx` for testing).
pub struct ExportInput<'a> {
    pub data_dir: &'a Path,
    pub logs_dir: &'a Path,
    pub home: Option<&'a Path>,
    pub profiles: Vec<ClaudeProfile>,
    pub state: PersistedState,
    pub snapshot: Diagnostics,
    pub agents: Vec<AgentAvailability>,
    pub cpu_brand: Option<String>,
}

pub fn build_bundle(input: &ExportInput<'_>, frontend: Value) -> Value {
    let scrub = Scrubber::new(input.home);
    let profiles: Vec<Value> = input
        .profiles
        .iter()
        .map(|p| {
            json!({
                "name": p.name,
                "isDefault": p.config_dir.is_none(),
                "dirExists": p.status.dir_exists,
                "likelyAuthenticated": p.status.likely_authenticated,
            })
        })
        .collect();
    let mut kinds: HashMap<String, u32> = HashMap::new();
    for s in &input.state.sessions {
        let k = serde_json::to_value(s.agent).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default();
        *kinds.entry(k).or_default() += 1;
    }
    let groups: usize = input.state.workspaces.iter().map(|w| w.groups.len()).sum();
    let log_tail = crate::logging::current_log_file(input.logs_dir)
        .map(|p| tail_lines(&p, LOG_TAIL_LINES))
        .unwrap_or_default();

    let bundle = json!({
        "generatedAt": chrono::Local::now().to_rfc3339(),
        "app": { "name": "Altera", "version": env!("CARGO_PKG_VERSION"), "debugBuild": cfg!(debug_assertions) },
        "os": {
            "name": System::name(),
            "longOsVersion": System::long_os_version(),
            "osVersion": System::os_version(),
            "kernel": System::kernel_long_version(),
            "arch": std::env::consts::ARCH,
        },
        "cpu": {
            "brand": input.cpu_brand,
            "logicalCores": input.snapshot.logical_cores,
            "physicalCores": System::physical_core_count(),
        },
        "memory": { "totalBytes": input.snapshot.system_memory_total, "usedBytes": input.snapshot.system_memory_used },
        "snapshot": input.snapshot,
        "agents": input.agents,
        "profiles": profiles,
        "settings": input.state.settings,
        "workspace": {
            "workspaceCount": input.state.workspaces.len(),
            "groupCount": groups,
            "sessionCount": input.state.sessions.len(),
            "sessionsByAgent": kinds,
        },
        "frontend": frontend,
        "logTail": log_tail,
    });
    scrub.value(bundle)
}

/// Write the bundle to `<data_dir>/diagnostics/altera-diagnostics-<ts>.json`.
pub fn write_bundle(input: &ExportInput<'_>, frontend: Value) -> AppResult<PathBuf> {
    let bundle = build_bundle(input, frontend);
    let pretty = serde_json::to_string_pretty(&bundle).map_err(|e| AppError::Other(e.to_string()))?;
    // Second pass over the serialized text catches key/value pairs split across
    // JSON structure; fall back to the per-string pass if it ever breaks JSON.
    let redacted = crate::redact::redact(&pretty);
    let text = if serde_json::from_str::<serde::de::IgnoredAny>(&redacted).is_ok() { redacted } else { pretty };

    let dir = input.data_dir.join("diagnostics");
    std::fs::create_dir_all(&dir)?;
    let ts = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let mut path = dir.join(format!("altera-diagnostics-{ts}.json"));
    let mut n = 1;
    while path.exists() {
        path = dir.join(format!("altera-diagnostics-{ts}-{n}.json"));
        n += 1;
    }
    crate::persistence::atomic_write(&path, text.as_bytes(), false)?;
    tracing::info!(file = %path.display(), "diagnostics exported");
    Ok(path)
}

pub fn export(ctx: &AppCtx, roots: &[(SessionId, u32)], frontend: Value) -> AppResult<String> {
    let state = ctx.store.get();
    let home = crate::adapters::discovery::home_dir();
    let input = ExportInput {
        data_dir: &ctx.paths.data_dir,
        logs_dir: &ctx.paths.logs_dir,
        home: home.as_deref(),
        profiles: ctx.profiles.list(),
        agents: crate::adapters::detect(&state.settings),
        snapshot: ctx.diag.snapshot(roots),
        cpu_brand: ctx.diag.cpu_brand(),
        state,
    };
    write_bundle(&input, frontend).map(|p| p.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    #[test]
    fn snapshot_attributes_host_and_session_tree() {
        let sampler = DiagSampler::new();
        // A child process tree: cmd.exe -> ping.exe
        let mut child = crate::adapters::process::hidden_command("cmd.exe")
            .args(["/d", "/c", "ping -n 6 127.0.0.1 >NUL"])
            .spawn()
            .unwrap();
        std::thread::sleep(Duration::from_millis(300));
        let roots = vec![("s1".to_string(), child.id())];
        let first = sampler.snapshot(&roots);
        assert_eq!(first.host.cpu_percent, 0.0, "no baseline on first sight");
        // Burn a little CPU so the next sample has something to measure.
        let t = Instant::now();
        let mut x = 0u64;
        while t.elapsed() < Duration::from_millis(250) {
            x = x.wrapping_mul(31).wrapping_add(7);
        }
        std::hint::black_box(x);
        let t = Instant::now();
        let d = sampler.snapshot(&roots);
        let took = t.elapsed();
        eprintln!("snapshot took {took:?}; host {:?}; session {:?}", d.host, d.sessions[0].stats);
        let _ = child.kill();
        let _ = child.wait();

        assert_eq!(first.host.process_count, 1);
        assert_eq!(d.host.process_count, 1);
        assert!(d.host.memory_bytes > 0);
        assert!(d.host.cpu_percent > 20.0, "busy loop must be visible: {:?}", d.host);
        assert_eq!(d.running_sessions, 1);
        assert!(d.sessions[0].stats.process_count >= 2, "{:?}", d.sessions[0]);
        assert_eq!(d.sessions_total.process_count, d.sessions[0].stats.process_count);
        assert!(d.logical_cores >= 1 && d.system_memory_total > d.system_memory_used);
        assert!(took < Duration::from_millis(500), "snapshot too slow: {took:?}");

        // Unknown root → empty stats, not a panic.
        let d = sampler.snapshot(&[("gone".into(), 0xFFFF_FFF0)]);
        assert_eq!(d.sessions[0].stats.process_count, 0);
    }

    #[test]
    fn bundle_is_scrubbed() {
        let data = tempfile::tempdir().unwrap();
        let logs = data.path().join("logs");
        std::fs::create_dir_all(&logs).unwrap();
        let mut log = String::new();
        for i in 0..400 {
            log.push_str(&format!("{{\"n\":{i},\"message\":\"line token=abc{i}\"}}\n"));
        }
        std::fs::write(logs.join("altera.2026-10-17.log"), log).unwrap();

        let home = PathBuf::from(r"C:\Users\Someone");
        let mut state = PersistedState::default();
        state.settings.agent_paths.claude = Some(r"c:\users\someone\.local\bin\claude.exe".into());
        let profiles = vec![ClaudeProfile {
            id: "p".into(),
            name: "work".into(),
            config_dir: Some(r"C:\Users\Someone\.claude-work".into()),
            color: "#7B61FF".into(),
            status: ProfileStatus { dir_exists: true, account: Some("me@example.com".into()), ..Default::default() },
        }];
        let input = ExportInput {
            data_dir: data.path(),
            logs_dir: &logs,
            home: Some(&home),
            profiles,
            state,
            snapshot: Diagnostics::default(),
            agents: vec![],
            cpu_brand: Some("Test CPU".into()),
        };
        let frontend = json!({ "apiKey": "zzz-secret", "note": "mail me@example.com", "path": "C:/Users/Someone/x" });
        let path = write_bundle(&input, frontend).unwrap();
        assert!(path.starts_with(data.path().join("diagnostics")));
        let text = std::fs::read_to_string(&path).unwrap();
        let v: Value = serde_json::from_str(&text).unwrap();
        assert!(!text.contains("zzz-secret"));
        assert!(!text.contains("me@example.com"));
        assert!(!text.to_lowercase().contains(r"users\\someone"), "{text}");
        assert!(!text.contains("Users/Someone"));
        assert!(!text.contains("abc399"));
        assert_eq!(v["settings"]["agentPaths"]["claude"], r"~\.local\bin\claude.exe");
        assert_eq!(v["frontend"]["path"], "~/x");
        assert_eq!(v["logTail"].as_array().unwrap().len(), LOG_TAIL_LINES);
        let p = &v["profiles"][0];
        assert_eq!(p["name"], "work");
        assert_eq!(p["isDefault"], false);
        assert!(p.get("configDir").is_none() && p.get("account").is_none());
    }

    #[test]
    fn tail_reads_last_lines() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("x.log");
        std::fs::write(&f, "a\nb\nc\n").unwrap();
        assert_eq!(tail_lines(&f, 2), vec!["b", "c"]);
        assert_eq!(tail_lines(&f, 10).len(), 3);
        assert!(tail_lines(&dir.path().join("missing"), 3).is_empty());
    }
}
