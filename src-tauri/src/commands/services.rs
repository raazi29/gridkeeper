//! Workspace, profile, agent, git and diagnostics commands (owner: services).

use serde::Serialize;
use tauri::State;

use crate::state::AppCtx;
use crate::types::*;

#[tauri::command]
pub fn state_load(ctx: State<'_, AppCtx>) -> PersistedState {
    // `--gk-self-test-gui` waits for this call (no-op otherwise).
    crate::selftest::note_frontend_booted();
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

/// Runs the account's own status command (`claude auth status --json`, `codex login status`;
/// existing dirs only). Accepts an account of any agent. Never reads credential files.
#[tauri::command]
pub async fn profile_check(ctx: State<'_, AppCtx>, id: String) -> Result<ProfileStatus, AppError> {
    let account = ctx.profiles.get_account(&id).ok_or_else(|| AppError::NotFound(id.clone()))?;
    let settings = ctx.store.settings();
    tauri::async_runtime::spawn_blocking(move || crate::accounts::check_status(&account, &settings))
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
}

// ---- accounts (all agents) -------------------------------------------------------------------
// The `profile*` commands above keep their Claude meaning (other features depend on it);
// `profile_check`, `profile_update` and `profile_delete` also accept any account id.

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountsSnapshot {
    pub accounts: Vec<Account>,
    /// Homes the user removed (hidden from the scan until restored).
    pub dismissed: usize,
}

fn spec_or_err(agent: AgentKind, preset: Option<&str>) -> AppResult<&'static crate::accounts::AccountSpec> {
    crate::accounts::spec_for(agent, preset)
        .ok_or_else(|| AppError::Invalid("This agent has no account isolation".into()))
}

/// Saved accounts of every agent with filename-only status (instant).
#[tauri::command]
pub fn accounts_list(ctx: State<'_, AppCtx>) -> AccountsSnapshot {
    AccountsSnapshot { accounts: ctx.profiles.list_all(), dismissed: ctx.profiles.dismissed_count() }
}

/// Find new account homes (default + sibling homes per agent, existence checks only), add them
/// as auto-detected (dismissed ones excepted), then verify every account with the agent's own
/// status command in parallel (15 s timeout each). Accounts with a live session are not
/// re-checked. Never reads credential files.
#[tauri::command]
pub async fn accounts_scan(ctx: State<'_, AppCtx>) -> Result<AccountsSnapshot, AppError> {
    let settings = ctx.store.settings();
    let s2 = settings.clone();
    let installed = tauri::async_runtime::spawn_blocking(move || crate::accounts::installed_keys(&s2))
        .await
        .map_err(|e| AppError::Other(e.to_string()))?;
    ctx.profiles.merge_detected(&installed)?;
    let busy: std::collections::HashSet<String> = ctx
        .sessions
        .list()
        .into_iter()
        .filter(|s| matches!(s.state, SessionState::Starting | SessionState::Running | SessionState::Stopping))
        .filter_map(|s| s.profile_id)
        .collect();
    let list = ctx.profiles.list_all();
    let accounts = tauri::async_runtime::spawn_blocking(move || crate::accounts::check_all(list, &settings, &busy, &installed))
        .await
        .map_err(|e| AppError::Other(e.to_string()))?;
    Ok(AccountsSnapshot { accounts, dismissed: ctx.profiles.dismissed_count() })
}

/// Agents with account support (and installed tools without it) for the Accounts dialog.
#[tauri::command]
pub async fn accounts_specs(ctx: State<'_, AppCtx>) -> Result<Vec<crate::accounts::AccountAgentInfo>, AppError> {
    let settings = ctx.store.settings();
    let env = ctx.profiles.scan_env().clone();
    tauri::async_runtime::spawn_blocking(move || crate::accounts::agent_infos(&settings, &env))
        .await
        .map_err(|e| AppError::Other(e.to_string()))
}

/// Where "Add account" would create the new home (path preview; listing only).
#[tauri::command]
pub fn accounts_plan_home(
    ctx: State<'_, AppCtx>,
    agent: AgentKind,
    preset: Option<String>,
    name: String,
) -> AppResult<crate::accounts::PlannedHome> {
    ctx.profiles.plan_home(spec_or_err(agent, preset.as_deref())?, &name)
}

/// "Add account": creates an EMPTY home folder (or uses an existing one when `use_existing`)
/// and the entry. The UI then opens a pane running the agent's own sign-in.
#[tauri::command]
pub fn accounts_create(
    ctx: State<'_, AppCtx>,
    agent: AgentKind,
    preset: Option<String>,
    name: String,
    use_existing: bool,
    home_dir: Option<String>,
    color: Option<String>,
) -> AppResult<Account> {
    ctx.profiles.create_new_home(spec_or_err(agent, preset.as_deref())?, name, use_existing, home_dir, color)
}

/// Forget removed homes so the next scan lists them again.
#[tauri::command]
pub fn accounts_restore_dismissed(ctx: State<'_, AppCtx>) -> AppResult<()> {
    ctx.profiles.restore_dismissed()
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

/// Async + blocking pool: a stat/canonicalize of an offline UNC path or a
/// disconnected mapped drive can block for many seconds, which on the main
/// thread (sync commands) would freeze the whole window.
#[tauri::command]
pub async fn path_info(path: String) -> Result<PathInfo, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = std::path::Path::new(&path);
        PathInfo {
            exists: p.exists(),
            is_dir: p.is_dir(),
            normalized: std::fs::canonicalize(p)
                .ok()
                .map(|c| c.to_string_lossy().trim_start_matches(r"\\?\").to_string()),
        }
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))
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

/// Polled every 2 s while the status bar shows diagnostics: the process
/// snapshot runs on the blocking pool, never on the main thread.
#[tauri::command]
pub async fn diagnostics_snapshot(ctx: State<'_, AppCtx>) -> Result<Diagnostics, AppError> {
    let roots = ctx.sessions.root_pids();
    let diag = std::sync::Arc::clone(&ctx.diag);
    tauri::async_runtime::spawn_blocking(move || diag.snapshot(&roots))
        .await
        .map_err(|e| AppError::Other(e.to_string()))
}

/// Writes a redacted diagnostics bundle and returns its path. Async so the
/// agent `--version` probes (up to 10 s) never block the main thread.
#[tauri::command]
pub async fn diagnostics_export(ctx: State<'_, AppCtx>, frontend: serde_json::Value) -> Result<String, AppError> {
    let settings = ctx.store.settings();
    let agents = tauri::async_runtime::spawn_blocking(move || crate::adapters::detect(&settings))
        .await
        .map_err(|e| AppError::Other(e.to_string()))?;
    let roots = ctx.sessions.root_pids();
    crate::diagnostics::export_with_agents(&ctx, &roots, frontend, agents)
}

#[tauri::command]
pub fn log_frontend(level: String, message: String) {
    let message = crate::redact::redact(&message);
    match level.as_str() {
        "error" => {
            crate::selftest::note_frontend_error();
            tracing::error!(target: "frontend", "{message}")
        }
        "warn" => tracing::warn!(target: "frontend", "{message}"),
        _ => tracing::info!(target: "frontend", "{message}"),
    }
}
