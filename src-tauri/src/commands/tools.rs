//! Built-in tools: read-only git Changes panel, dev-server port detection, browser panes.
//! Everything that shells out or snapshots processes runs on the blocking pool.

use tauri::{AppHandle, State};

use crate::state::AppCtx;
use crate::types::*;

fn join_err(e: impl std::fmt::Display) -> AppError {
    AppError::Other(e.to_string())
}

/// Branch, ahead/behind and changed files of the repository containing `path` (read-only).
#[tauri::command]
pub async fn git_changes(path: String) -> Result<RepoChanges, AppError> {
    tauri::async_runtime::spawn_blocking(move || crate::git::changes(&path)).await.map_err(join_err)?
}

/// Unified diff of one repository-relative file (read-only; capped at 2 MiB).
#[tauri::command]
pub async fn git_diff(repo: String, file: String, staged: bool, untracked: bool) -> Result<FileDiff, AppError> {
    tauri::async_runtime::spawn_blocking(move || crate::git::diff(&repo, &file, staged, untracked))
        .await
        .map_err(join_err)?
}

/// LISTENING TCP ports per running session (process-tree attribution).
#[tauri::command]
pub async fn ports_list(ctx: State<'_, AppCtx>) -> Result<Vec<crate::ports::SessionPorts>, AppError> {
    let roots = ctx.sessions.root_pids();
    tauri::async_runtime::spawn_blocking(move || crate::ports::session_ports(&roots)).await.map_err(join_err)
}

/// Can `url` be shown in an iframe? Also reports reachability and the static page title.
#[tauri::command]
pub async fn browser_probe(url: String) -> Result<crate::browser::FrameProbe, AppError> {
    tauri::async_runtime::spawn_blocking(move || crate::browser::probe(&url)).await.map_err(join_err)?
}

/// Pop-out browser window (async: creating a window from a sync command deadlocks on Windows).
#[tauri::command]
pub async fn browser_open_window(app: AppHandle, url: String, label: Option<String>) -> Result<String, AppError> {
    crate::browser::open_window(&app, &url, label.as_deref())
}

#[tauri::command]
pub async fn browser_close_window(app: AppHandle, label: String) -> Result<bool, AppError> {
    crate::browser::close_window(&app, &label)
}

#[tauri::command]
pub async fn browser_devtools(app: AppHandle, label: String) -> Result<(), AppError> {
    crate::browser::devtools(&app, &label)
}
