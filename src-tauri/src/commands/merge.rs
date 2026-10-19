//! Merge assistant (see `crate::merge`, ADR-020). Everything runs on the blocking pool.

use crate::types::*;

fn join_err(e: impl std::fmt::Display) -> AppError {
    AppError::Other(e.to_string())
}

/// What merging the worktree's branch into `base` (default: the main checkout's branch) would do:
/// commits, diffstat, fast-forward, conflicts, refusal reasons. Writes nothing.
#[tauri::command]
pub async fn merge_preview(path: String, base: Option<String>) -> Result<MergePreview, AppError> {
    tauri::async_runtime::spawn_blocking(move || crate::merge::preview(&path, base.as_deref())).await.map_err(join_err)?
}

/// The exact commands a merge request runs (shown before the user confirms). Pure.
#[tauri::command]
pub fn merge_plan(request: MergeRequest) -> Result<MergePlan, AppError> {
    crate::merge::plan(&request)
}

/// Run a confirmed merge in the main checkout. Guards are re-checked; a failed step is rolled back.
#[tauri::command]
pub async fn merge_execute(request: MergeRequest) -> Result<MergeOutcome, AppError> {
    tauri::async_runtime::spawn_blocking(move || crate::merge::execute(&request, &crate::testrun::manager()))
        .await
        .map_err(join_err)?
}

/// What "remove worktree + branch" would run for the worktree at `path`.
#[tauri::command]
pub async fn merge_cleanup_plan(path: String, base: Option<String>) -> Result<WorktreeCleanupPlan, AppError> {
    tauri::async_runtime::spawn_blocking(move || crate::merge::cleanup_plan(&path, base.as_deref())).await.map_err(join_err)?
}

/// Run a confirmed clean-up: unlink junctions / symlinks, `git worktree remove`, `git branch -d`.
#[tauri::command]
pub async fn merge_cleanup(path: String, branch: String, base: Option<String>) -> Result<WorktreeCleanupOutcome, AppError> {
    tauri::async_runtime::spawn_blocking(move || crate::merge::cleanup(&path, &branch, base.as_deref()))
        .await
        .map_err(join_err)?
}
