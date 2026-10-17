//! App-level commands: build/runtime info and benchmark mode.

use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    /// Windows build number (e.g. 26300), used for xterm's `windowsPty` option.
    pub windows_build: Option<u32>,
    /// Raw value of GRIDKEEPER_BENCH when benchmark mode is requested, e.g. "sessions=6;mode=sustained".
    pub bench: Option<String>,
    /// Absolute path of the repo's scripts/bench directory, when it exists (dev builds / benchmarks).
    pub bench_scripts_dir: Option<String>,
}

#[tauri::command]
pub fn app_info() -> AppInfo {
    let bench = std::env::var("GRIDKEEPER_BENCH").ok().filter(|s| !s.trim().is_empty());
    let bench_scripts_dir = std::env::var("GRIDKEEPER_BENCH_SCRIPTS")
        .ok()
        .or_else(|| {
            let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("scripts").join("bench");
            p.is_dir().then(|| p.to_string_lossy().into_owned())
        })
        .and_then(|p| std::fs::canonicalize(p).ok())
        .map(|p| p.to_string_lossy().trim_start_matches(r"\\?\").to_string());
    AppInfo { version: env!("CARGO_PKG_VERSION").into(), windows_build: windows_build(), bench, bench_scripts_dir }
}

fn windows_build() -> Option<u32> {
    sysinfo::System::kernel_version().and_then(|v| v.split('.').next_back().and_then(|b| b.parse().ok()))
}
