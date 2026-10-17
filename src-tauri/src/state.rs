//! Application context shared by all commands.

use std::path::PathBuf;
use std::sync::Arc;

use tauri::{AppHandle, Manager};

use crate::diagnostics::DiagSampler;
use crate::persistence::StateStore;
use crate::profiles::ProfileStore;
use crate::pty::SessionManager;

pub struct AppPaths {
    /// %APPDATA%\ai.altera.workspace
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
        let logs_dir = data_dir.join("logs");
        std::fs::create_dir_all(&logs_dir)?;
        let log_guard = crate::logging::init(&logs_dir).ok();
        tracing::info!(version = env!("CARGO_PKG_VERSION"), "altera starting");

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
