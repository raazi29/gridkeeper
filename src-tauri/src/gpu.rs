//! GPU telemetry from the Windows performance counters Task Manager uses:
//! `\GPU Engine(*)\Utilization Percentage`, `\GPU Process Memory(*)\{Dedicated,Shared} Usage` and
//! `\GPU Adapter Memory(*)\Dedicated Usage`, read through one long-lived PDH query.
//!
//! - The query is opened lazily on the first diagnostics snapshot (so only while Diagnostics or the
//!   status-bar resources are visible) and reused afterwards; wildcard counters pick up new instances
//!   on every collection.
//! - Utilization is a rate counter: it needs two collections, so the first snapshot after opening
//!   reports `warmingUp` with no engine figures. Each later value is the average over the interval
//!   since the previous snapshot (the 2 s poll).
//! - Engine figures follow Task Manager: per engine (adapter LUID + phys + engine index) the
//!   utilization of the relevant processes is summed; a process group's "GPU %" is its busiest engine.
//! - Nothing is estimated. If PDH fails, `available` is false and `error` says why.
//!
//! Adapter names are not resolvable without DXGI (no new dependencies), so adapters are identified by
//! LUID; the UI pairs the adapter that carries the WebView2 load with the verbatim WebGL renderer string.

use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

/// Utilization per engine class, percent (0-100; the busiest engine of that class).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnginePercent {
    #[serde(rename = "3d")]
    pub three_d: f32,
    pub copy: f32,
    pub video: f32,
    pub compute: f32,
    pub other: f32,
}

impl EnginePercent {
    fn slot(&mut self, class: EngineClass) -> &mut f32 {
        match class {
            EngineClass::ThreeD => &mut self.three_d,
            EngineClass::Copy => &mut self.copy,
            EngineClass::Video => &mut self.video,
            EngineClass::Compute => &mut self.compute,
            EngineClass::Other => &mut self.other,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuAdapter {
    /// Adapter LUID as Windows prints it in counter instances, e.g. `0x00000000_0x00015A7A`.
    pub luid: String,
    /// Dedicated (VRAM) bytes in use on this adapter by all processes.
    pub dedicated_used_bytes: u64,
    /// Whole-adapter utilization per engine class (all processes).
    pub engine_percent: EnginePercent,
    /// This adapter holds the app's WebView2 GPU allocations, i.e. it renders the UI and terminals.
    pub carries_ui: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuStats {
    pub available: bool,
    /// First collection after opening the query: rates are not known yet.
    pub warming_up: bool,
    /// WebView2 processes: busiest 3D engine, percent.
    pub webview_3d_percent: f32,
    /// WebView2 processes: busiest engine of any class (Task Manager's per-process "GPU" column).
    pub webview_total_percent: f32,
    pub webview_dedicated_bytes: u64,
    pub webview_shared_bytes: u64,
    /// Tauri host process: busiest engine, percent.
    pub host_percent: f32,
    /// All session process trees: busiest engine, percent.
    pub sessions_percent: f32,
    pub adapters: Vec<GpuAdapter>,
    /// Number of `GPU Engine` counter instances read (all processes, all adapters).
    pub engine_instances: u32,
    /// Time spent collecting and aggregating the counters, milliseconds.
    pub sample_ms: f32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl GpuStats {
    pub fn unavailable(error: impl Into<String>) -> Self {
        Self { available: false, error: Some(error.into()), ..Default::default() }
    }
}

// ---------------------------------------------------------------------------
// Instance names
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum EngineClass {
    ThreeD,
    Copy,
    Video,
    Compute,
    Other,
}

/// Bucket a driver-reported engine type (`3D`, `Copy`, `VideoDecode`, `Video Encode`, `Compute_0`,
/// `Cuda`, `Graphics_1`, `High Priority 3D`, `Security`, `Legacy Overlay`, ...).
pub fn classify_engine(engtype: &str) -> EngineClass {
    let t = engtype.to_ascii_lowercase();
    if t.contains("3d") || t.starts_with("graphics") {
        EngineClass::ThreeD
    } else if t.contains("copy") {
        EngineClass::Copy
    } else if t.contains("video") || t.contains("codec") || t.contains("encode") || t.contains("decode") {
        EngineClass::Video
    } else if t.contains("compute") || t.contains("cuda") {
        EngineClass::Compute
    } else {
        EngineClass::Other
    }
}

/// A parsed counter instance name. `GPU Engine` instances carry every field; `GPU Process Memory`
/// lacks `eng`/`engtype`; `GPU Adapter Memory` also lacks `pid`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Instance {
    pub pid: Option<u32>,
    pub luid: String,
    pub phys: u32,
    pub eng: Option<u32>,
    pub engtype: Option<String>,
}

/// Parse e.g. `pid_1234_luid_0x00000000_0x00015A7A_phys_0_eng_0_engtype_3D`.
/// The engine type is everything after `engtype_` (it may contain spaces or underscores).
/// Returns None when there is no LUID.
pub fn parse_instance(name: &str) -> Option<Instance> {
    let tokens: Vec<&str> = name.trim().split('_').collect();
    let mut pid = None;
    let mut luid = None;
    let mut phys = 0;
    let mut eng = None;
    let mut engtype = None;
    let mut i = 0;
    while i < tokens.len() {
        let next = tokens.get(i + 1).copied();
        match tokens[i].to_ascii_lowercase().as_str() {
            "pid" => {
                pid = next.and_then(|t| t.parse().ok());
                i += 2;
            }
            "luid" => {
                let (hi, lo) = (next?, tokens.get(i + 2).copied()?);
                let hex = |t: &str| t.len() > 2 && t[..2].eq_ignore_ascii_case("0x") && t[2..].chars().all(|c| c.is_ascii_hexdigit());
                if !hex(hi) || !hex(lo) {
                    return None;
                }
                luid = Some(format!("{hi}_{lo}"));
                i += 3;
            }
            "phys" => {
                phys = next.and_then(|t| t.parse().ok()).unwrap_or(0);
                i += 2;
            }
            "eng" => {
                eng = next.and_then(|t| t.parse().ok());
                i += 2;
            }
            "engtype" => {
                let rest = tokens[i + 1..].join("_");
                engtype = Some(rest.trim().to_string()).filter(|s| !s.is_empty());
                break;
            }
            _ => i += 1,
        }
    }
    Some(Instance { pid, luid: luid?, phys, eng, engtype })
}

// ---------------------------------------------------------------------------
// Aggregation (pure; unit-tested)
// ---------------------------------------------------------------------------

/// One collection's raw counter arrays: (instance name, value).
#[derive(Debug, Default, Clone)]
pub struct RawSample {
    pub engines: Vec<(String, f64)>,
    pub process_dedicated: Vec<(String, i64)>,
    pub process_shared: Vec<(String, i64)>,
    pub adapter_dedicated: Vec<(String, i64)>,
}

/// Which PIDs belong to which category (computed by the diagnostics snapshot).
pub struct Attribution<'a> {
    pub host: u32,
    pub webview: &'a HashSet<u32>,
    pub sessions: &'a HashSet<u32>,
}

fn pct(v: f64) -> f32 {
    if v.is_finite() { v.clamp(0.0, 100.0) as f32 } else { 0.0 }
}

pub fn aggregate(raw: &RawSample, who: &Attribution<'_>) -> GpuStats {
    type EngineKey = (String, u32, u32); // luid, phys, eng
    let mut class_of: HashMap<EngineKey, EngineClass> = HashMap::new();
    let mut all: HashMap<EngineKey, f64> = HashMap::new();
    let mut webview: HashMap<EngineKey, f64> = HashMap::new();
    let mut host: HashMap<EngineKey, f64> = HashMap::new();
    let mut sessions: HashMap<EngineKey, f64> = HashMap::new();
    let mut luids: Vec<String> = Vec::new();
    let note_luid =|l: &str, luids: &mut Vec<String>| {
        if !luids.iter().any(|x| x == l) {
            luids.push(l.to_string());
        }
    };

    for (name, value) in &raw.engines {
        let Some(inst) = parse_instance(name) else { continue };
        let Some(eng) = inst.eng else { continue };
        let v = if value.is_finite() { value.max(0.0) } else { 0.0 };
        note_luid(&inst.luid, &mut luids);
        let key = (inst.luid, inst.phys, eng);
        class_of.entry(key.clone()).or_insert_with(|| classify_engine(inst.engtype.as_deref().unwrap_or("")));
        *all.entry(key.clone()).or_default() += v;
        if let Some(pid) = inst.pid {
            if pid == who.host {
                *host.entry(key.clone()).or_default() += v;
            }
            if who.webview.contains(&pid) {
                *webview.entry(key.clone()).or_default() += v;
            }
            if who.sessions.contains(&pid) {
                *sessions.entry(key).or_default() += v;
            }
        }
    }

    let busiest = |m: &HashMap<EngineKey, f64>, only: Option<EngineClass>| -> f64 {
        m.iter()
            .filter(|(k, _)| only.is_none_or(|c| class_of.get(*k) == Some(&c)))
            .map(|(_, v)| *v)
            .fold(0.0, f64::max)
    };

    // Per-process GPU memory: WebView2 totals, and WebView2 dedicated bytes per LUID (carries-UI signal).
    let mut webview_dedicated = 0u64;
    let mut webview_shared = 0u64;
    let mut webview_dedicated_by_luid: HashMap<String, u64> = HashMap::new();
    for (name, value) in &raw.process_dedicated {
        let Some(inst) = parse_instance(name) else { continue };
        note_luid(&inst.luid, &mut luids);
        if inst.pid.is_some_and(|p| who.webview.contains(&p)) {
            let b = (*value).max(0) as u64;
            webview_dedicated += b;
            *webview_dedicated_by_luid.entry(inst.luid).or_default() += b;
        }
    }
    for (name, value) in &raw.process_shared {
        let Some(inst) = parse_instance(name) else { continue };
        if inst.pid.is_some_and(|p| who.webview.contains(&p)) {
            webview_shared += (*value).max(0) as u64;
        }
    }
    let mut adapter_dedicated: HashMap<String, u64> = HashMap::new();
    for (name, value) in &raw.adapter_dedicated {
        let Some(inst) = parse_instance(name) else { continue };
        note_luid(&inst.luid, &mut luids);
        *adapter_dedicated.entry(inst.luid).or_default() += (*value).max(0) as u64;
    }

    // The UI adapter: where WebView2 keeps its (persistent) GPU allocations; fall back to where its 3D
    // work ran. Never guessed: with no WebView2 signal at all, no adapter is marked.
    let argmax = |m: &HashMap<String, f64>| -> Option<String> {
        m.iter().filter(|(_, v)| **v > 0.0).max_by(|a, b| a.1.total_cmp(b.1)).map(|(k, _)| k.clone())
    };
    let ui_luid = argmax(&webview_dedicated_by_luid.iter().map(|(k, v)| (k.clone(), *v as f64)).collect()).or_else(|| {
        let mut by_luid: HashMap<String, f64> = HashMap::new();
        for (k, v) in &webview {
            if class_of.get(k) == Some(&EngineClass::ThreeD) {
                let e = by_luid.entry(k.0.clone()).or_default();
                *e = e.max(*v);
            }
        }
        argmax(&by_luid)
    });

    let mut adapters: Vec<GpuAdapter> = luids
        .into_iter()
        .map(|luid| {
            let mut ep = EnginePercent::default();
            for (k, v) in &all {
                if k.0 != luid {
                    continue;
                }
                let slot = ep.slot(class_of.get(k).copied().unwrap_or(EngineClass::Other));
                *slot = slot.max(pct(*v));
            }
            GpuAdapter {
                dedicated_used_bytes: adapter_dedicated.get(&luid).copied().unwrap_or(0),
                engine_percent: ep,
                carries_ui: ui_luid.as_deref() == Some(luid.as_str()),
                luid,
            }
        })
        .collect();
    adapters.sort_by(|a, b| b.carries_ui.cmp(&a.carries_ui).then(b.dedicated_used_bytes.cmp(&a.dedicated_used_bytes)).then(a.luid.cmp(&b.luid)));

    GpuStats {
        available: true,
        warming_up: false,
        webview_3d_percent: pct(busiest(&webview, Some(EngineClass::ThreeD))),
        webview_total_percent: pct(busiest(&webview, None)),
        webview_dedicated_bytes: webview_dedicated,
        webview_shared_bytes: webview_shared,
        host_percent: pct(busiest(&host, None)),
        sessions_percent: pct(busiest(&sessions, None)),
        adapters,
        engine_instances: raw.engines.len() as u32,
        sample_ms: 0.0,
        error: None,
    }
}

// ---------------------------------------------------------------------------
// PDH
// ---------------------------------------------------------------------------

pub const ENGINE_UTILIZATION: &str = r"\GPU Engine(*)\Utilization Percentage";
pub const PROCESS_DEDICATED: &str = r"\GPU Process Memory(*)\Dedicated Usage";
pub const PROCESS_SHARED: &str = r"\GPU Process Memory(*)\Shared Usage";
pub const ADAPTER_DEDICATED: &str = r"\GPU Adapter Memory(*)\Dedicated Usage";

#[cfg(windows)]
mod pdh {
    use windows_sys::Win32::System::Performance::{
        PDH_CSTATUS_NEW_DATA, PDH_CSTATUS_VALID_DATA, PDH_FMT, PDH_FMT_COUNTERVALUE, PDH_FMT_COUNTERVALUE_ITEM_W, PDH_FMT_DOUBLE,
        PDH_FMT_LARGE, PDH_HCOUNTER, PDH_HQUERY, PDH_MORE_DATA, PdhAddEnglishCounterW, PdhCloseQuery, PdhCollectQueryData,
        PdhGetFormattedCounterArrayW, PdhOpenQueryW,
    };

    /// `PDH_FMT_NOCAP100` (pdh.h); not exported by windows-sys. Summed instances may exceed 100.
    const PDH_FMT_NOCAP100: PDH_FMT = 0x0000_8000;

    pub struct Query {
        query: PDH_HQUERY,
        counters: [PDH_HCOUNTER; 4],
        /// u64 storage keeps the item array 8-byte aligned; item names point into it.
        buf: Vec<u64>,
        pub collections: u32,
    }

    // SAFETY: PDH query/counter handles are process-wide handles, not thread-affine; every use is
    // serialized by the owning Mutex in DiagSampler.
    unsafe impl Send for Query {}

    impl Drop for Query {
        fn drop(&mut self) {
            // SAFETY: the handle came from PdhOpenQueryW and is closed exactly once.
            unsafe { PdhCloseQuery(self.query) };
        }
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    pub fn status(st: u32) -> String {
        format!("0x{st:08X}")
    }

    impl Query {
        pub fn open(paths: [&str; 4]) -> Result<Self, String> {
            let mut query: PDH_HQUERY = std::ptr::null_mut();
            // SAFETY: out-param is a valid pointer; a null data source means live data.
            let st = unsafe { PdhOpenQueryW(std::ptr::null(), 0, &mut query) };
            if st != 0 {
                return Err(format!("PdhOpenQueryW failed ({})", status(st)));
            }
            let mut q = Query { query, counters: [std::ptr::null_mut(); 4], buf: Vec::new(), collections: 0 };
            for (i, path) in paths.iter().enumerate() {
                let w = wide(path);
                // SAFETY: valid query handle, NUL-terminated path, valid out-param.
                let st = unsafe { PdhAddEnglishCounterW(q.query, w.as_ptr(), 0, &mut q.counters[i]) };
                if st != 0 {
                    return Err(format!("GPU performance counter {path} unavailable ({})", status(st)));
                }
            }
            Ok(q)
        }

        pub fn collect(&mut self) -> Result<(), u32> {
            // SAFETY: valid query handle.
            let st = unsafe { PdhCollectQueryData(self.query) };
            if st != 0 {
                return Err(st);
            }
            self.collections += 1;
            Ok(())
        }

        fn read(&mut self, idx: usize, fmt: PDH_FMT, mut each: impl FnMut(String, &PDH_FMT_COUNTERVALUE)) -> Result<(), u32> {
            for _ in 0..4 {
                let mut size = (self.buf.len() * 8) as u32;
                let mut count = 0u32;
                let ptr = if self.buf.is_empty() { std::ptr::null_mut() } else { self.buf.as_mut_ptr() as *mut PDH_FMT_COUNTERVALUE_ITEM_W };
                // SAFETY: `size` is the byte size of `buf` (or 0 with a null buffer, as documented).
                let st = unsafe { PdhGetFormattedCounterArrayW(self.counters[idx], fmt, &mut size, &mut count, ptr) };
                if st == PDH_MORE_DATA {
                    self.buf.resize((size as usize).div_ceil(8) + 1, 0);
                    continue;
                }
                if st != 0 {
                    return Err(st);
                }
                if count == 0 || self.buf.is_empty() {
                    return Ok(());
                }
                // SAFETY: PDH wrote `count` items at the start of `buf`; their names are NUL-terminated
                // UTF-16 strings stored later in the same buffer, valid until the next call.
                let items = unsafe { std::slice::from_raw_parts(self.buf.as_ptr() as *const PDH_FMT_COUNTERVALUE_ITEM_W, count as usize) };
                for it in items {
                    let ok = it.FmtValue.CStatus == PDH_CSTATUS_VALID_DATA || it.FmtValue.CStatus == PDH_CSTATUS_NEW_DATA;
                    if !ok || it.szName.is_null() {
                        continue;
                    }
                    // SAFETY: see above.
                    let name = unsafe {
                        let mut len = 0;
                        while *it.szName.add(len) != 0 {
                            len += 1;
                        }
                        String::from_utf16_lossy(std::slice::from_raw_parts(it.szName, len))
                    };
                    each(name, &it.FmtValue);
                }
                return Ok(());
            }
            Err(PDH_MORE_DATA)
        }

        pub fn read_double(&mut self, idx: usize) -> Result<Vec<(String, f64)>, u32> {
            let mut out = Vec::new();
            // SAFETY (union read): PDH_FMT_DOUBLE fills `doubleValue`.
            self.read(idx, PDH_FMT_DOUBLE | PDH_FMT_NOCAP100, |n, v| out.push((n, unsafe { v.Anonymous.doubleValue })))?;
            Ok(out)
        }

        pub fn read_large(&mut self, idx: usize) -> Result<Vec<(String, i64)>, u32> {
            let mut out = Vec::new();
            // SAFETY (union read): PDH_FMT_LARGE fills `largeValue`.
            self.read(idx, PDH_FMT_LARGE, |n, v| out.push((n, unsafe { v.Anonymous.largeValue })))?;
            Ok(out)
        }
    }
}

/// Retry interval after the counters could not be opened (e.g. a VM without WDDM GPU counters).
const RETRY_AFTER: Duration = Duration::from_secs(60);

#[cfg(windows)]
enum State {
    Closed,
    Open(pdh::Query),
    Failed { error: String, retry_at: Instant },
}

/// Long-lived GPU counter reader. One per app (inside DiagSampler).
pub struct GpuSampler {
    #[cfg(windows)]
    state: State,
}

impl Default for GpuSampler {
    fn default() -> Self {
        Self::new()
    }
}

impl GpuSampler {
    pub fn new() -> Self {
        Self {
            #[cfg(windows)]
            state: State::Closed,
        }
    }

    /// Collect the counters now and attribute them. Opens the query on first use.
    #[cfg(windows)]
    pub fn sample(&mut self, who: &Attribution<'_>) -> GpuStats {
        let started = Instant::now();
        let mut stats = self.sample_inner(who);
        stats.sample_ms = started.elapsed().as_secs_f32() * 1000.0;
        stats
    }

    #[cfg(windows)]
    fn sample_inner(&mut self, who: &Attribution<'_>) -> GpuStats {
        use windows_sys::Win32::System::Performance::{
            PDH_CALC_NEGATIVE_DENOMINATOR, PDH_CALC_NEGATIVE_TIMEBASE, PDH_CALC_NEGATIVE_VALUE, PDH_CSTATUS_INVALID_DATA, PDH_INVALID_DATA,
            PDH_NO_DATA,
        };
        if let State::Failed { retry_at, .. } = &self.state {
            if Instant::now() >= *retry_at {
                self.state = State::Closed;
            }
        }
        if matches!(self.state, State::Closed) {
            self.state = match pdh::Query::open([ENGINE_UTILIZATION, PROCESS_DEDICATED, PROCESS_SHARED, ADAPTER_DEDICATED]) {
                Ok(q) => State::Open(q),
                Err(error) => {
                    tracing::warn!(%error, "GPU counters unavailable");
                    State::Failed { error, retry_at: Instant::now() + RETRY_AFTER }
                }
            };
        }
        let q = match &mut self.state {
            State::Open(q) => q,
            State::Failed { error, .. } => return GpuStats::unavailable(error.clone()),
            State::Closed => return GpuStats::unavailable("GPU counters not opened"),
        };
        if let Err(st) = q.collect() {
            // No instances at all is "no data", not a failure (e.g. a GPU-less session).
            if st != PDH_NO_DATA {
                let error = format!("PdhCollectQueryData failed ({})", pdh::status(st));
                self.state = State::Failed { error: error.clone(), retry_at: Instant::now() + RETRY_AFTER };
                return GpuStats::unavailable(error);
            }
        }
        let warming_up = q.collections < 2;
        let warmup_status = |st: u32| {
            matches!(st, PDH_INVALID_DATA | PDH_CSTATUS_INVALID_DATA | PDH_NO_DATA | PDH_CALC_NEGATIVE_DENOMINATOR | PDH_CALC_NEGATIVE_TIMEBASE | PDH_CALC_NEGATIVE_VALUE)
        };
        let mut raw = RawSample::default();
        match q.read_double(0) {
            Ok(v) => raw.engines = v,
            Err(st) if warming_up && warmup_status(st) => {}
            Err(st) if st == PDH_NO_DATA => {}
            Err(st) => return GpuStats::unavailable(format!("GPU engine counters unreadable ({})", pdh::status(st))),
        }
        let large = |q: &mut pdh::Query, idx: usize| match q.read_large(idx) {
            Ok(v) => v,
            Err(_) => Vec::new(), // memory counters are optional extras
        };
        raw.process_dedicated = large(q, 1);
        raw.process_shared = large(q, 2);
        raw.adapter_dedicated = large(q, 3);
        let mut stats = aggregate(&raw, who);
        if warming_up {
            // Rates need a second collection: report memory, but no engine figures yet.
            stats.warming_up = true;
            stats.webview_3d_percent = 0.0;
            stats.webview_total_percent = 0.0;
            stats.host_percent = 0.0;
            stats.sessions_percent = 0.0;
            for a in &mut stats.adapters {
                a.engine_percent = EnginePercent::default();
            }
        }
        stats
    }

    #[cfg(not(windows))]
    pub fn sample(&mut self, _who: &Attribution<'_>) -> GpuStats {
        GpuStats::unavailable("GPU counters are only available on Windows")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const L1: &str = "0x00000000_0x00015A7A";
    const L2: &str = "0x00000000_0x0001B3C4";

    #[test]
    fn parses_engine_instance() {
        let i = parse_instance("pid_1234_luid_0x00000000_0x00015A7A_phys_0_eng_0_engtype_3D").unwrap();
        assert_eq!(i, Instance { pid: Some(1234), luid: L1.into(), phys: 0, eng: Some(0), engtype: Some("3D".into()) });
    }

    #[test]
    fn engine_type_keeps_spaces_and_underscores() {
        let i = parse_instance("pid_8_luid_0x00000000_0x0000D1C2_phys_0_eng_5_engtype_Compute_1").unwrap();
        assert_eq!(i.engtype.as_deref(), Some("Compute_1"));
        assert_eq!(i.eng, Some(5));
        let i = parse_instance("pid_8_luid_0x00000000_0x0000D1C2_phys_1_eng_12_engtype_Legacy Overlay").unwrap();
        assert_eq!(i.engtype.as_deref(), Some("Legacy Overlay"));
        assert_eq!(i.phys, 1);
    }

    #[test]
    fn parses_memory_instances() {
        let p = parse_instance("pid_42_luid_0x00000000_0x00015A7A_phys_0").unwrap();
        assert_eq!((p.pid, p.eng, p.engtype), (Some(42), None, None));
        let a = parse_instance("luid_0x00000000_0x00015A7A_phys_0").unwrap();
        assert_eq!((a.pid, a.luid.as_str()), (None, L1));
    }

    #[test]
    fn rejects_garbage() {
        assert!(parse_instance("").is_none());
        assert!(parse_instance("_Total").is_none());
        assert!(parse_instance("pid_1_luid_zz_0x1_phys_0").is_none());
        assert!(parse_instance("pid_1_luid_0x00000000").is_none());
    }

    #[test]
    fn classifies_engine_types() {
        use EngineClass::*;
        for (t, c) in [
            ("3D", ThreeD),
            ("High Priority 3D", ThreeD),
            ("Graphics_1", ThreeD),
            ("Copy", Copy),
            ("VideoDecode", Video),
            ("Video Encode", Video),
            ("VideoProcessing", Video),
            ("Video Codec", Video),
            ("Compute_0", Compute),
            ("Cuda", Compute),
            ("Security", Other),
            ("Legacy Overlay", Other),
            ("", Other),
        ] {
            assert_eq!(classify_engine(t), c, "{t}");
        }
    }

    fn eng(pid: u32, luid: &str, e: u32, t: &str, v: f64) -> (String, f64) {
        (format!("pid_{pid}_luid_{luid}_phys_0_eng_{e}_engtype_{t}"), v)
    }

    #[test]
    fn aggregates_by_category_engine_and_adapter() {
        let webview: HashSet<u32> = [20, 21].into();
        let sessions: HashSet<u32> = [30].into();
        let who = Attribution { host: 10, webview: &webview, sessions: &sessions };
        let raw = RawSample {
            engines: vec![
                eng(20, L1, 0, "3D", 7.5),
                eng(21, L1, 0, "3D", 2.5), // same engine, second WebView2 process -> summed
                eng(20, L1, 2, "Copy", 1.0),
                eng(10, L1, 0, "3D", 0.5),
                eng(30, L1, 4, "Compute_0", 40.0),
                eng(99, L1, 0, "3D", 30.0),        // another app
                eng(99, L2, 0, "3D", 5.0),         // another adapter
                eng(99, L2, 7, "VideoDecode", 12.0),
                ("pid_99_luid_0x0_0x1_phys_0_eng_x".into(), 50.0), // unparsable engine index -> ignored
            ],
            process_dedicated: vec![
                (format!("pid_20_luid_{L1}_phys_0"), 100 << 20),
                (format!("pid_21_luid_{L1}_phys_0"), 20 << 20),
                (format!("pid_99_luid_{L2}_phys_0"), 500 << 20),
            ],
            process_shared: vec![(format!("pid_20_luid_{L1}_phys_0"), 8 << 20), (format!("pid_99_luid_{L2}_phys_0"), 1 << 20)],
            adapter_dedicated: vec![(format!("luid_{L1}_phys_0"), 900 << 20), (format!("luid_{L2}_phys_0"), 600 << 20)],
        };
        let s = aggregate(&raw, &who);
        assert!(s.available && !s.warming_up && s.error.is_none());
        assert_eq!(s.webview_3d_percent, 10.0);
        assert_eq!(s.webview_total_percent, 10.0);
        assert_eq!(s.host_percent, 0.5);
        assert_eq!(s.sessions_percent, 40.0);
        assert_eq!(s.webview_dedicated_bytes, 120 << 20);
        assert_eq!(s.webview_shared_bytes, 8 << 20);
        assert_eq!(s.engine_instances, 9);
        assert_eq!(s.adapters.len(), 2);
        let ui = &s.adapters[0];
        assert_eq!(ui.luid, L1);
        assert!(ui.carries_ui);
        assert_eq!(ui.dedicated_used_bytes, 900 << 20);
        assert_eq!(ui.engine_percent, EnginePercent { three_d: 40.5, copy: 1.0, video: 0.0, compute: 40.0, other: 0.0 });
        let other = &s.adapters[1];
        assert!(!other.carries_ui);
        assert_eq!(other.engine_percent.video, 12.0);
        assert_eq!(other.engine_percent.three_d, 5.0);
    }

    #[test]
    fn ui_adapter_falls_back_to_3d_load_and_is_never_guessed() {
        let webview: HashSet<u32> = [20].into();
        let none: HashSet<u32> = HashSet::new();
        let who = Attribution { host: 10, webview: &webview, sessions: &none };
        // No WebView2 memory reported: the adapter running its 3D work carries the UI.
        let raw = RawSample { engines: vec![eng(20, L2, 0, "3D", 3.0), eng(99, L1, 0, "3D", 50.0)], ..Default::default() };
        let s = aggregate(&raw, &who);
        assert_eq!(s.adapters.iter().find(|a| a.carries_ui).map(|a| a.luid.as_str()), Some(L2));
        // No WebView2 signal at all: nothing is marked.
        let raw = RawSample { engines: vec![eng(20, L2, 0, "3D", 0.0), eng(99, L1, 0, "3D", 50.0)], ..Default::default() };
        let s = aggregate(&raw, &who);
        assert!(s.adapters.iter().all(|a| !a.carries_ui));
    }

    #[test]
    fn clamps_and_ignores_bad_values() {
        let webview: HashSet<u32> = [20].into();
        let none: HashSet<u32> = HashSet::new();
        let who = Attribution { host: 10, webview: &webview, sessions: &none };
        let raw = RawSample {
            engines: vec![eng(20, L1, 0, "3D", 80.0), eng(20, L1, 0, "3D", 70.0), eng(20, L1, 1, "Copy", f64::NAN), eng(20, L1, 2, "Copy", -5.0)],
            ..Default::default()
        };
        let s = aggregate(&raw, &who);
        assert_eq!(s.webview_3d_percent, 100.0);
        assert_eq!(s.adapters[0].engine_percent.copy, 0.0);
    }

    /// Reads the real counters on this machine. Run with
    /// `cargo test gpu::tests::real_pdh_counters -- --ignored --nocapture`.
    #[test]
    #[ignore = "reads live machine counters"]
    #[cfg(windows)]
    fn real_pdh_counters() {
        let none: HashSet<u32> = HashSet::new();
        let who = Attribution { host: std::process::id(), webview: &none, sessions: &none };
        let mut g = GpuSampler::new();
        let first = g.sample(&who);
        eprintln!("first: available={} warming_up={} error={:?} cost={:.2} ms", first.available, first.warming_up, first.error, first.sample_ms);
        assert!(first.available, "{:?}", first.error);
        let mut costs = Vec::new();
        let mut last = first;
        for _ in 0..5 {
            std::thread::sleep(Duration::from_millis(1000));
            last = g.sample(&who);
            costs.push(last.sample_ms);
        }
        assert!(last.available && !last.warming_up, "{:?}", last.error);
        // Whole-machine 3D: sum over every process on every adapter's 3D engines (Task Manager "3D").
        let mut q = pdh::Query::open([ENGINE_UTILIZATION, PROCESS_DEDICATED, PROCESS_SHARED, ADAPTER_DEDICATED]).unwrap();
        q.collect().unwrap();
        std::thread::sleep(Duration::from_millis(1000));
        let t = Instant::now();
        q.collect().unwrap();
        let collect_ms = t.elapsed().as_secs_f64() * 1000.0;
        let t = Instant::now();
        let engines = q.read_double(0).unwrap();
        let mem = (q.read_large(1).unwrap().len(), q.read_large(2).unwrap().len(), q.read_large(3).unwrap().len());
        eprintln!(
            "phase cost: collect {collect_ms:.2} ms, read+format {:.2} ms; memory instances {mem:?}",
            t.elapsed().as_secs_f64() * 1000.0
        );
        let total_3d: f64 = engines
            .iter()
            .filter(|(n, _)| parse_instance(n).and_then(|i| i.engtype).is_some_and(|t| classify_engine(&t) == EngineClass::ThreeD))
            .map(|(_, v)| *v)
            .sum();
        eprintln!("GPU engine instances: {}; total 3D utilization (all processes, all adapters): {total_3d:.2} %", engines.len());
        for a in &last.adapters {
            eprintln!(
                "adapter {}: dedicated {} MiB, engines {:?}",
                a.luid,
                a.dedicated_used_bytes >> 20,
                a.engine_percent
            );
        }
        costs.sort_by(|a, b| a.total_cmp(b));
        eprintln!("sample cost ms (sorted): {costs:?}; median {:.2}", costs[costs.len() / 2]);
        assert!(engines.len() > 0);
    }
}
