//! Test runs (see `crate::testrun`): detection on the blocking pool, the runner on its own threads.

use std::sync::Arc;

use tauri::{AppHandle, Emitter, State};

use crate::state::AppCtx;
use crate::types::*;

fn join_err(e: impl std::fmt::Display) -> AppError {
    AppError::Other(e.to_string())
}

/// The runner emits `test-run` events through the app handle (installed once).
fn manager(app: &AppHandle) -> Arc<crate::testrun::Manager> {
    let m = crate::testrun::manager();
    m.ensure_emitter(|| {
        let app = app.clone();
        Arc::new(move |info: &TestRunInfo| {
            if let Err(e) = app.emit(EVT_TEST_RUN, info) {
                tracing::warn!(error = %e, "could not emit test-run");
            }
        })
    });
    m
}

/// Test commands found in a folder's own files (package.json, Cargo.toml, pytest, go.mod, Makefile).
#[tauri::command]
pub async fn test_detect(path: String) -> Result<TestDetection, AppError> {
    tauri::async_runtime::spawn_blocking(move || crate::testrun::detect(&path)).await.map_err(join_err)?
}

/// Queue a run (starts at once when fewer than `testRuns.maxConcurrent` are running). A folder with an
/// active run gets that run back.
#[tauri::command]
pub async fn test_run_start(app: AppHandle, ctx: State<'_, AppCtx>, spec: TestRunSpec) -> Result<TestRunInfo, AppError> {
    let settings = ctx.store.settings().test_runs;
    let m = manager(&app);
    tauri::async_runtime::spawn_blocking(move || m.start(spec, &settings)).await.map_err(join_err)?
}

/// Cancel a queued or running run (ends its whole process tree). False when it already finished.
#[tauri::command]
pub async fn test_run_cancel(app: AppHandle, id: String) -> Result<bool, AppError> {
    Ok(manager(&app).cancel(&id))
}

/// Known runs (active ones and the newest finished ones), oldest first.
#[tauri::command]
pub async fn test_run_list(app: AppHandle) -> Result<Vec<TestRunInfo>, AppError> {
    Ok(manager(&app).list())
}

/// A run's captured output, ANSI stripped (the newest `max_bytes`, default all of the 2 MiB kept).
#[tauri::command]
pub async fn test_run_log(app: AppHandle, id: String, max_bytes: Option<u32>) -> Result<TestRunLog, AppError> {
    let m = manager(&app);
    tauri::async_runtime::spawn_blocking(move || m.log(&id, max_bytes.map(|b| b as usize))).await.map_err(join_err)?
}
