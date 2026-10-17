//! Resource diagnostics: attribute CPU/RAM to the host process, its WebView2
//! processes and each session's process tree; export a redacted bundle.
//!
//! Sampling cost: one Toolhelp snapshot of all processes with no per-process
//! queries (parents/names only), then CPU+memory refresh for just the
//! processes we report on. CPU% is computed by sysinfo between successive
//! refreshes at least 200 ms apart; a newly seen process reports ~0 CPU for
//! its first two samples (sysinfo establishes the baseline on the second).

use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use regex::Regex;
use serde_json::{json, Value};
use sysinfo::{CpuRefreshKind, MemoryRefreshKind, Pid, ProcessRefreshKind, ProcessesToUpdate, System};

use crate::state::AppCtx;
use crate::types::*;

const WEBVIEW_EXE: &str = "msedgewebview2.exe";
const LOG_TAIL_LINES: usize = 300;

pub struct DiagSampler {
    sys: Mutex<System>,
}

impl Default for DiagSampler {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Default)]
struct Acc(ProcStats);

impl Acc {
    fn add(&mut self, p: &sysinfo::Process) {
        self.0.cpu_percent += p.cpu_usage();
        self.0.memory_bytes += p.memory();
        self.0.process_count += 1;
    }
}

/// Descendants of `root` (inclusive), guarding against PID reuse and cycles.
fn tree(sys: &System, children: &HashMap<Pid, Vec<Pid>>, root: Pid) -> Vec<Pid> {
    let mut out = Vec::new();
    if sys.process(root).is_none() {
        return out;
    }
    let mut seen = HashSet::new();
    let mut queue = VecDeque::from([root]);
    while let Some(pid) = queue.pop_front() {
        if !seen.insert(pid) {
            continue;
        }
        out.push(pid);
        let parent_start = sys.process(pid).map(|p| p.start_time()).unwrap_or(0);
        for child in children.get(&pid).into_iter().flatten() {
            // A child cannot start before its parent; otherwise the parent PID was reused.
            let child_start = sys.process(*child).map(|p| p.start_time()).unwrap_or(0);
            if child_start == 0 || parent_start == 0 || child_start >= parent_start {
                queue.push_back(*child);
            }
        }
    }
    out
}

impl DiagSampler {
    pub fn new() -> Self {
        let mut sys = System::new();
        // CPU% per process is scaled by the CPU count, so the list must exist.
        sys.refresh_cpu_list(CpuRefreshKind::nothing());
        sys.refresh_memory_specifics(MemoryRefreshKind::nothing().with_ram());
        Self { sys: Mutex::new(sys) }
    }

    pub fn snapshot(&self, roots: &[(SessionId, u32)]) -> Diagnostics {
        let mut sys = self.sys.lock();
        // Pass 1: process list, parents and names only.
        sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());

        let mut children: HashMap<Pid, Vec<Pid>> = HashMap::new();
        for (pid, p) in sys.processes() {
            if let Some(parent) = p.parent() {
                children.entry(parent).or_default().push(*pid);
            }
        }

        let host = Pid::from_u32(std::process::id());
        let webview: Vec<Pid> = tree(&sys, &children, host)
            .into_iter()
            .filter(|pid| {
                *pid != host
                    && sys
                        .process(*pid)
                        .is_some_and(|p| p.name().to_string_lossy().eq_ignore_ascii_case(WEBVIEW_EXE))
            })
            .collect();
        let session_trees: Vec<(SessionId, Vec<Pid>)> = roots
            .iter()
            .map(|(id, root)| (id.clone(), tree(&sys, &children, Pid::from_u32(*root))))
            .collect();

        // Pass 2: CPU + memory for the processes we report on.
        let mut wanted: Vec<Pid> = vec![host];
        wanted.extend(&webview);
        for (_, pids) in &session_trees {
            wanted.extend(pids);
        }
        wanted.sort_unstable();
        wanted.dedup();
        sys.refresh_processes_specifics(
            ProcessesToUpdate::Some(&wanted),
            true,
            ProcessRefreshKind::nothing().with_cpu().with_memory(),
        );
        sys.refresh_memory_specifics(MemoryRefreshKind::nothing().with_ram());

        let stats = |pids: &[Pid]| {
            let mut acc = Acc::default();
            for pid in pids {
                if let Some(p) = sys.process(*pid) {
                    acc.add(p);
                }
            }
            acc.0
        };

        let host_stats = stats(&[host]);
        let webview_stats = stats(&webview);
        let mut total = ProcStats::default();
        let mut counted: HashSet<Pid> = HashSet::new();
        let mut sessions = Vec::with_capacity(session_trees.len());
        for (id, pids) in &session_trees {
            let s = stats(pids);
            // Aggregate without double counting overlapping trees.
            let unique: Vec<Pid> = pids.iter().copied().filter(|p| counted.insert(*p)).collect();
            let u = stats(&unique);
            total.cpu_percent += u.cpu_percent;
            total.memory_bytes += u.memory_bytes;
            total.process_count += u.process_count;
            sessions.push(SessionStats { id: id.clone(), stats: s });
        }

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
        // sysinfo needs two refreshes >= 200 ms apart to establish a CPU baseline
        // for a newly seen process; the third snapshot measures a real interval.
        std::thread::sleep(Duration::from_millis(250));
        sampler.snapshot(&roots);
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
