//! Workspace, profile, agent, git and diagnostics commands (owner: services).

use serde::Serialize;
use tauri::State;

use crate::state::AppCtx;
use crate::types::*;

#[tauri::command]
pub fn state_load(ctx: State<'_, AppCtx>) -> PersistedState {
    ctx.store.get()
}

#[tauri::command]
pub fn state_save(ctx: State<'_, AppCtx>, state: PersistedState) -> AppResult<()> {
    ctx.store.save(state)
}

#[tauri::command]
pub fn profiles_list(ctx: State<'_, AppCtx>) -> Vec<ClaudeProfile> {
    ctx.profiles.list()
}

#[tauri::command]
pub fn profile_create(
    ctx: State<'_, AppCtx>,
    name: String,
    config_dir: Option<String>,
    color: Option<String>,
) -> AppResult<ClaudeProfile> {
    ctx.profiles.create(name, config_dir, color)
}

#[tauri::command]
pub fn profile_update(ctx: State<'_, AppCtx>, profile: ClaudeProfile) -> AppResult<ClaudeProfile> {
    ctx.profiles.update(profile)
}

/// Removes the profile entry only. Never deletes the config directory.
#[tauri::command]
pub fn profile_delete(ctx: State<'_, AppCtx>, id: String) -> AppResult<()> {
    ctx.profiles.delete(&id)
}

/// Runs `claude auth status --json` for the profile (existing dirs only). Never reads credential files.
#[tauri::command]
pub async fn profile_check(ctx: State<'_, AppCtx>, id: String) -> Result<ProfileStatus, AppError> {
    let profile = ctx.profiles.get(&id).ok_or_else(|| AppError::NotFound(id.clone()))?;
    let settings = ctx.store.settings();
    tauri::async_runtime::spawn_blocking(move || crate::profiles::check_status(&profile, &settings))
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
pub async fn agents_detect(ctx: State<'_, AppCtx>) -> Result<Vec<AgentAvailability>, AppError> {
    let settings = ctx.store.settings();
    tauri::async_runtime::spawn_blocking(move || crate::adapters::detect(&settings))
        .await
        .map_err(|e| AppError::Other(e.to_string()))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathInfo {
    pub exists: bool,
    pub is_dir: bool,
    pub normalized: Option<String>,
}

#[tauri::command]
pub fn path_info(path: String) -> PathInfo {
    let p = std::path::Path::new(&path);
    PathInfo {
        exists: p.exists(),
        is_dir: p.is_dir(),
        normalized: std::fs::canonicalize(p)
            .ok()
            .map(|c| c.to_string_lossy().trim_start_matches(r"\\?\").to_string()),
    }
}

#[tauri::command]
pub async fn git_info(path: String) -> Result<GitInfo, AppError> {
    tauri::async_runtime::spawn_blocking(move || crate::git::info(&path))
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
}

/// Creates a worktree. The UI must confirm with the user before calling.
#[tauri::command]
pub async fn git_worktree_add(
    repo: String,
    path: String,
    branch: String,
    new_branch: bool,
) -> Result<WorktreeInfo, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::git::worktree_add(&repo, &path, &branch, new_branch)
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
pub fn diagnostics_snapshot(ctx: State<'_, AppCtx>) -> Diagnostics {
    let roots = ctx.sessions.root_pids();
    ctx.diag.snapshot(&roots)
}

/// Writes a redacted diagnostics bundle and returns its path.
#[tauri::command]
pub fn diagnostics_export(ctx: State<'_, AppCtx>, frontend: serde_json::Value) -> AppResult<String> {
    let roots = ctx.sessions.root_pids();
    crate::diagnostics::export(&ctx, &roots, frontend)
}

#[tauri::command]
pub fn log_frontend(level: String, message: String) {
    let message = crate::redact::redact(&message);
    match level.as_str() {
        "error" => tracing::error!(target: "frontend", "{message}"),
        "warn" => tracing::warn!(target: "frontend", "{message}"),
        _ => tracing::info!(target: "frontend", "{message}"),
    }
}
