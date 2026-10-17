//! Application context shared by all commands.

use std::path::PathBuf;
use std::sync::Arc;

use tauri::{AppHandle, Manager};

use crate::diagnostics::DiagSampler;
use crate::persistence::StateStore;
use crate::profiles::ProfileStore;
use crate::pty::SessionManager;

pub struct AppPaths {
    /// %APPDATA%\app.gridkeeper.desktop
    pub data_dir: PathBuf,
    pub logs_dir: PathBuf,
}

pub struct AppCtx {
    pub paths: AppPaths,
    pub sessions: Arc<SessionManager>,
    pub profiles: ProfileStore,
    pub store: StateStore,
    pub diag: Arc<DiagSampler>,
    _log_guard: Option<crate::logging::LogGuard>,
}

impl AppCtx {
    pub fn init(app: &AppHandle) -> anyhow::Result<Self> {
        let data_dir = app.path().app_config_dir()?;
        let migrated = migrate_legacy_data_dir(&data_dir);
        let logs_dir = data_dir.join("logs");
        std::fs::create_dir_all(&logs_dir)?;
        let log_guard = crate::logging::init(&logs_dir).ok();
        tracing::info!(version = env!("CARGO_PKG_VERSION"), "gridkeeper starting");
        if let Some(n) = migrated {
            tracing::info!(files = n, "copied settings from the previous app name (Altera)");
        }

        let store = StateStore::load(data_dir.join("workspaces.json"));
        let profiles = ProfileStore::load(data_dir.join("profiles.json"));
        let sessions = Arc::new(SessionManager::new(app.clone()));
        Ok(Self {
            paths: AppPaths { data_dir, logs_dir },
            sessions,
            profiles,
            store,
            diag: Arc::new(DiagSampler::new()),
            _log_guard: log_guard,
        })
    }

    /// Graceful shutdown of every session's process tree. Called once on app exit.
    pub fn shutdown(&self) {
        tracing::info!("shutting down sessions");
        self.sessions.shutdown_all(std::time::Duration::from_millis(1500));
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
