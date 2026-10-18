//! Mission file commands: `<projectDir>/.gridkeeper/mission.md`, plus the lead control outbox
//! (`.gridkeeper/outbox/`) and the generated team file (`.gridkeeper/team.md`); see `crate::mission`.
//! File IO and watcher start/stop run on the blocking pool, never on the main thread.

use tauri::{AppHandle, Manager};

use crate::state::AppCtx;
use crate::types::*;

fn join_err(e: impl std::fmt::Display) -> AppError {
    AppError::Other(e.to_string())
}

/// Read the mission file (missing = `exists: false`; larger than 256 KiB = error).
#[tauri::command]
pub async fn mission_read(project_dir: String) -> Result<MissionFile, AppError> {
    tauri::async_runtime::spawn_blocking(move || crate::mission::read(&project_dir)).await.map_err(join_err)?
}

/// Atomic write. With `check_expected`, fails with code `"conflict"` unless the file is still the
/// version last seen (`expected_modified_ms`; `None` = must not exist yet).
#[tauri::command]
pub async fn mission_write(
    project_dir: String,
    text: String,
    expected_modified_ms: Option<u64>,
    check_expected: bool,
) -> Result<MissionFile, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::mission::write(&project_dir, &text, expected_modified_ms, check_expected)
    })
    .await
    .map_err(join_err)?
}

/// Ref-counted watch; emits `mission-changed` `{ projectDir }` (debounced). Pair with `mission_unwatch`.
#[tauri::command]
pub async fn mission_watch(app: AppHandle, project_dir: String) -> Result<(), AppError> {
    tauri::async_runtime::spawn_blocking(move || app.state::<AppCtx>().missions.watch(&project_dir))
        .await
        .map_err(join_err)?
}

#[tauri::command]
pub async fn mission_unwatch(app: AppHandle, project_dir: String) -> Result<(), AppError> {
    tauri::async_runtime::spawn_blocking(move || app.state::<AppCtx>().missions.unwatch(&project_dir))
        .await
        .map_err(join_err)?
}

/// Instruction files directly in `.gridkeeper/outbox/` (`.md` / `.txt`), oldest first, at most 50,
/// each read up to 16 KiB (`truncated` beyond). Missing folder = empty list.
#[tauri::command]
pub async fn mission_outbox_list(project_dir: String) -> Result<Vec<OutboxItem>, AppError> {
    tauri::async_runtime::spawn_blocking(move || crate::mission::outbox_list(&project_dir)).await.map_err(join_err)?
}

/// Move a handled instruction file to `outbox/sent/` or `outbox/dismissed/` (`disposition`). Returns the
/// archived path; code `"not_found"` when the file is gone.
#[tauri::command]
pub async fn mission_outbox_archive(project_dir: String, name: String, disposition: String) -> Result<String, AppError> {
    tauri::async_runtime::spawn_blocking(move || crate::mission::outbox_archive(&project_dir, &name, &disposition))
        .await
        .map_err(join_err)?
}

/// Atomically write the generated `.gridkeeper/team.md` (redacted, at most 256 KiB; never emits an event).
#[tauri::command]
pub async fn mission_team_write(project_dir: String, text: String) -> Result<(), AppError> {
    tauri::async_runtime::spawn_blocking(move || crate::mission::team_write(&project_dir, &text)).await.map_err(join_err)?
}
