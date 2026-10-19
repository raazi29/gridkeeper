//! Brain commands: the team's long-term project memory in `<projectDir>/.gridkeeper/brain/`
//! (`notes/`, `inbox/`, generated `INDEX.md`); see `crate::brain`. Changes made by agents arrive as
//! `mission-changed` events with `file: "brain"` (the mission watch observes the brain folder).
//! File IO runs on the blocking pool, never on the main thread.

use crate::types::*;

fn join_err(e: impl std::fmt::Display) -> AppError {
    AppError::Other(e.to_string())
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> AppResult<T> + Send + 'static) -> AppResult<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(join_err)?
}

/// Every note (`notes/`) and suggestion (`inbox/`); missing brain folder = `exists: false`. Brings a stale
/// INDEX.md up to date.
#[tauri::command]
pub async fn brain_list(project_dir: String) -> Result<BrainIndex, AppError> {
    blocking(move || crate::brain::list(&project_dir)).await
}

/// One note (`inbox` = from `inbox/`). Missing = `exists: false`; larger than 16 KiB = error.
#[tauri::command]
pub async fn brain_read(project_dir: String, slug: String, inbox: bool) -> Result<BrainNoteFile, AppError> {
    blocking(move || crate::brain::read(&project_dir, &slug, inbox)).await
}

/// Atomic, redacted write (at most 16 KiB). With `check_expected`, fails with code `"conflict"` unless the
/// file is still the version last seen (`expected_modified_ms`; `None` = must not exist yet).
#[tauri::command]
pub async fn brain_write(
    project_dir: String,
    slug: String,
    text: String,
    inbox: bool,
    expected_modified_ms: Option<u64>,
    check_expected: bool,
) -> Result<BrainNoteFile, AppError> {
    blocking(move || crate::brain::write(&project_dir, &slug, &text, inbox, expected_modified_ms, check_expected)).await
}

/// Move a suggestion from `inbox/` to `notes/` as confirmed. Returns its slug in `notes/` (a clash gets
/// `-<n>`); code `"not_found"` when the suggestion is gone.
#[tauri::command]
pub async fn brain_approve(project_dir: String, slug: String) -> Result<String, AppError> {
    blocking(move || crate::brain::approve(&project_dir, &slug)).await
}

/// Delete a note or suggestion; returns the text it had (for Undo). Code `"not_found"` when it is gone.
#[tauri::command]
pub async fn brain_delete(project_dir: String, slug: String, inbox: bool) -> Result<String, AppError> {
    blocking(move || crate::brain::delete(&project_dir, &slug, inbox)).await
}

/// Ranked local full-text search over notes and suggestions (title, tags, kind, source, body; prefixes
/// match). At most 50 hits; an empty query returns none.
#[tauri::command]
pub async fn brain_search(project_dir: String, query: String) -> Result<Vec<BrainHit>, AppError> {
    blocking(move || crate::brain::search(&project_dir, &query)).await
}

/// Share the brain through git (`share`: `notes/*.md` and `INDEX.md` become committable) or keep it local.
#[tauri::command]
pub async fn brain_share(project_dir: String, share: bool) -> Result<BrainShare, AppError> {
    blocking(move || crate::brain::set_shared(&project_dir, share)).await
}
