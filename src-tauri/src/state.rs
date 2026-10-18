//! Application context shared by all commands.

use std::path::PathBuf;
use std::sync::Arc;

use tauri::{AppHandle, Emitter, Manager};

use crate::diagnostics::DiagSampler;
use crate::mission::MissionWatchers;
use crate::persistence::StateStore;
use crate::profiles::ProfileStore;
use crate::pty::SessionManager;

pub struct AppPaths {
    /// %APPDATA%\app.gridkeeper.desktop (sandbox: `<that>\sandboxes\<name>`, see `sandbox`)
    pub data_dir: PathBuf,
    pub logs_dir: PathBuf,
}

pub struct AppCtx {
    pub paths: AppPaths,
    pub sessions: Arc<SessionManager>,
    pub profiles: ProfileStore,
    pub store: StateStore,
    pub diag: Arc<DiagSampler>,
    /// Ref-counted watches of `<projectDir>/.gridkeeper/mission.md` (`mission-changed` events).
    pub missions: MissionWatchers,
    /// Cost & context meter: `<data_dir>/meter` watch (`session-meter` events).
    pub meter: Arc<crate::meter::MeterHub>,
    _log_guard: Option<crate::logging::LogGuard>,
}

impl AppCtx {
    pub fn init(app: &AppHandle) -> anyhow::Result<Self> {
        let sandbox = crate::sandbox::current();
        let data_dir = match sandbox {
            Some(s) => s.data_dir.clone(),
            None => app.path().app_config_dir()?,
        };
        // Sandboxes start empty: never copy the live (or legacy) data into them.
        let migrated = if sandbox.is_some() { None } else { migrate_legacy_data_dir(&data_dir) };
        let logs_dir = data_dir.join("logs");
        std::fs::create_dir_all(&logs_dir)?;
        let log_guard = crate::logging::init(&logs_dir).ok();
        tracing::info!(version = env!("CARGO_PKG_VERSION"), "gridkeeper starting");
        if let Some(s) = sandbox {
            tracing::info!(name = %s.name, data_dir = %s.data_dir.display(), webview_folder_set = s.set_webview_folder, "sandbox mode");
        }
        if let Some(n) = migrated {
            tracing::info!(files = n, "copied settings from the previous app name (Altera)");
        }

        let store = StateStore::load(data_dir.join("workspaces.json"));
        let profiles = ProfileStore::load(data_dir.join("profiles.json"));
        let sessions = Arc::new(SessionManager::new(app.clone()));
        let emitter = app.clone();
        let missions = MissionWatchers::new(Arc::new(move |dir: &str| {
            let payload = crate::types::MissionChanged { project_dir: dir.to_string() };
            if let Err(e) = emitter.emit(crate::types::EVT_MISSION_CHANGED, payload) {
                tracing::warn!(error = %e, "could not emit mission-changed");
            }
        }));
        let meter_emitter = app.clone();
        let meter = Arc::new(crate::meter::MeterHub::new(
            &data_dir,
            std::env::current_exe().ok(),
            crate::meter::launch::default_managed_paths(),
            Arc::new(move |m: &crate::types::SessionMeter| {
                if let Err(e) = meter_emitter.emit(crate::types::EVT_SESSION_METER, m) {
                    tracing::warn!(error = %e, "could not emit session-meter");
                }
            }),
        ));
        if let Err(e) = meter.start_watch() {
            tracing::warn!(error = %e, "cost meter folder watch failed; meters update on the next start");
        }
        crate::meter::install(Arc::clone(&meter));
        Ok(Self {
            paths: AppPaths { data_dir, logs_dir },
            sessions,
            profiles,
            store,
            diag: Arc::new(DiagSampler::new()),
            missions,
            meter,
            _log_guard: log_guard,
        })
    }

    /// Graceful shutdown of every session's process tree. Called once on app exit.
    pub fn shutdown(&self) {
        tracing::info!("shutting down sessions");
        self.sessions.shutdown_all(std::time::Duration::from_millis(1500));
        self.missions.clear();
        self.meter.stop();
    }
}

/// The app was renamed from "Altera" (identifier `ai.altera.workspace`). On the first run under the new
/// identifier, copy the saved workspaces and profiles across. The old folder is left untouched (never
/// deleted or modified), so this is safe to repeat and easy to undo.
fn migrate_legacy_data_dir(data_dir: &std::path::Path) -> Option<usize> {
    let legacy = data_dir.parent()?.join("ai.altera.workspace");
    if data_dir.join("workspaces.json").exists() || data_dir.join("profiles.json").exists() || !legacy.is_dir() {
        return None;
    }
    std::fs::create_dir_all(data_dir).ok()?;
    let mut copied = 0;
    for name in ["workspaces.json", "workspaces.json.bak", "profiles.json"] {
        let from = legacy.join(name);
        if from.is_file() && std::fs::copy(&from, data_dir.join(name)).is_ok() {
            copied += 1;
        }
    }
    Some(copied)
}
