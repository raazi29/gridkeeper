//! Mission replay commands (see `crate::replay`). File IO and the native save dialog run on the
//! blocking pool, never on the main thread.

use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

use crate::types::*;

/// Header carrying the save token of `replay_save_file` (the body is the raw file bytes).
pub const TOKEN_HEADER: &str = "x-replay-token";

fn join_err(e: impl std::fmt::Display) -> AppError {
    AppError::Other(e.to_string())
}

/// Append event lines (each one JSON object) to `<projectDir>/.gridkeeper/replay/<fileName>`.
/// Nothing is written when the 5 MB cap would be crossed; the result then has `full: true`.
#[tauri::command]
pub async fn replay_append(project_dir: String, file_name: String, lines: Vec<String>) -> Result<ReplayAppend, AppError> {
    tauri::async_runtime::spawn_blocking(move || crate::replay::append(&project_dir, &file_name, &lines))
        .await
        .map_err(join_err)?
}

/// Recordings of a project, newest first (missing folder = empty list).
#[tauri::command]
pub async fn replay_list(project_dir: String) -> Result<Vec<ReplayInfo>, AppError> {
    tauri::async_runtime::spawn_blocking(move || crate::replay::list(&project_dir)).await.map_err(join_err)?
}

/// One recording as text (at most 5 MB).
#[tauri::command]
pub async fn replay_read(project_dir: String, name: String) -> Result<String, AppError> {
    tauri::async_runtime::spawn_blocking(move || crate::replay::read(&project_dir, &name)).await.map_err(join_err)?
}

#[tauri::command]
pub async fn replay_delete(project_dir: String, name: String) -> Result<(), AppError> {
    tauri::async_runtime::spawn_blocking(move || crate::replay::delete(&project_dir, &name)).await.map_err(join_err)?
}

/// Native save dialog for an export (`kind` = "mp4" | "webm" | "gif"). Returns null when cancelled,
/// else the chosen path and a one-time token for `replay_save_file`.
#[tauri::command]
pub async fn replay_save_dialog(
    app: AppHandle,
    default_name: String,
    kind: String,
) -> Result<Option<ReplaySaveTarget>, AppError> {
    let kind = crate::replay::validate_kind(&kind)?;
    let name = crate::replay::default_file_name(&default_name, kind);
    let label = match kind {
        "gif" => "GIF animation",
        "webm" => "WebM video",
        _ => "MP4 video",
    };
    tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = app
            .dialog()
            .file()
            .set_title("Export mission replay")
            .set_file_name(name)
            .add_filter(label, &[kind])
            .set_can_create_directories(true);
        if let Some(w) = app.get_webview_window(crate::webview_guard::MAIN) {
            dialog = dialog.set_parent(&w);
        }
        let Some(picked) = dialog.blocking_save_file() else {
            return Ok(None);
        };
        let Some(path) = picked.as_path().map(std::path::Path::to_path_buf) else {
            return Err(AppError::Invalid("The dialog returned no file path".into()));
        };
        crate::replay::register_save_target(&path, kind).map(Some)
    })
    .await
    .map_err(join_err)?
}

/// Write an export. Raw body = the file bytes (no JSON), header `x-replay-token` = the token from
/// `replay_save_dialog`. Writes only to that dialog-chosen path; returns it.
#[tauri::command]
pub async fn replay_save_file(request: Request<'_>) -> Result<String, AppError> {
    let token = request
        .headers()
        .get(TOKEN_HEADER)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned)
        .ok_or_else(|| AppError::Invalid(format!("missing {TOKEN_HEADER} header")))?;
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err(AppError::Invalid("replay_save_file expects the file bytes as a raw body".into()));
    };
    if bytes.len() > crate::replay::MAX_EXPORT_BYTES {
        return Err(AppError::Invalid(format!("The export is larger than {} MB", crate::replay::MAX_EXPORT_BYTES >> 20)));
    }
    let bytes = bytes.clone();
    tauri::async_runtime::spawn_blocking(move || crate::replay::save_export(&token, &bytes)).await.map_err(join_err)?
}
