//! Agent Skills commands (see `crate::skills`): GitHub discovery (user-initiated only) and install
//! into a project's `.claude/skills` / `.agents/skills`. Network and file work run on the blocking
//! pool, never on the main thread.

use crate::skills::{self, CurlFetcher, InstallRequest};
use crate::types::*;

fn join_err(e: impl std::fmt::Display) -> AppError {
    AppError::Other(e.to_string())
}

/// One page of skill repositories. `sort`: `trending` | `top` | `best` | `stars`; `query` is free
/// text (required for `best` / `stars`). Rate limits come back as `rateLimited: true`.
#[tauri::command]
pub async fn skills_search(query: String, sort: String, page: u32) -> Result<SkillRepoPage, AppError> {
    tauri::async_runtime::spawn_blocking(move || skills::search(&CurlFetcher, &query, &sort, page))
        .await
        .map_err(join_err)?
}

/// A repository's skills at `git_ref` (default branch when null), pinned to a commit SHA.
#[tauri::command]
pub async fn skills_inspect(repo: String, git_ref: Option<String>) -> Result<RepoSkills, AppError> {
    tauri::async_runtime::spawn_blocking(move || skills::inspect(&CurlFetcher, &repo, git_ref.as_deref()))
        .await
        .map_err(join_err)?
}

/// One file of a repository at a pinned commit (text up to 256 KiB), for review before install.
#[tauri::command]
pub async fn skills_file(repo: String, commit_sha: String, path: String) -> Result<SkillFileText, AppError> {
    tauri::async_runtime::spawn_blocking(move || skills::read_file(&CurlFetcher, &repo, &commit_sha, &path))
        .await
        .map_err(join_err)?
}

/// Install one skill folder (pinned commit) into `targets` (`.claude/skills`, `.agents/skills`) of the
/// project. Existing folders fail with code `conflict` unless `replace` (the user confirmed).
#[tauri::command]
pub async fn skills_install(
    project_dir: String,
    repo: String,
    commit_sha: String,
    skill_path: String,
    targets: Vec<String>,
    replace: bool,
) -> Result<InstallResult, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        skills::install(
            &CurlFetcher,
            &InstallRequest {
                project_dir: &project_dir,
                repo: &repo,
                commit_sha: &commit_sha,
                skill_path: &skill_path,
                targets: &targets,
                replace,
            },
        )
    })
    .await
    .map_err(join_err)?
}

/// Skills in the project's `.claude/skills` and `.agents/skills` (read-only, no network).
#[tauri::command]
pub async fn skills_installed(project_dir: String) -> Result<Vec<InstalledSkill>, AppError> {
    tauri::async_runtime::spawn_blocking(move || skills::installed(&project_dir)).await.map_err(join_err)?
}

/// Delete one installed skill folder (`.claude/skills/<name>` or `.agents/skills/<name>` only).
#[tauri::command]
pub async fn skills_remove(project_dir: String, target_dir_rel: String) -> Result<(), AppError> {
    tauri::async_runtime::spawn_blocking(move || skills::remove(&project_dir, &target_dir_rel))
        .await
        .map_err(join_err)?
}

/// Compare an installed skill's pinned commit with the repository's default branch now.
#[tauri::command]
pub async fn skills_check_update(
    repo: String,
    skill_path: String,
    commit_sha: String,
    tree_sha: Option<String>,
) -> Result<SkillUpdateCheck, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        skills::check_update(&CurlFetcher, &repo, &skill_path, &commit_sha, tree_sha.as_deref())
    })
    .await
    .map_err(join_err)?
}
