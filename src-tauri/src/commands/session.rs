//! Session commands (owner: PTY core).
//!
//! Synchronous Tauri commands run on the main (UI) thread, so anything that
//! can take more than microseconds is `async`: process launch runs on the
//! blocking pool, and the hot paths (write/ack/resize) stay off the UI thread.
//! None of the `SessionManager` calls block on the child process or frontend.

use tauri::State;
use tauri::ipc::{Channel, InvokeResponseBody};

use crate::state::AppCtx;
use crate::types::*;

#[tauri::command]
pub async fn session_start(ctx: State<'_, AppCtx>, spec: SessionSpec) -> AppResult<SessionInfo> {
    let settings = ctx.store.settings();
    let plan = crate::adapters::resolve_launch(&spec, &ctx.profiles, &settings)?;
    let buffer = (settings.buffer_kib.clamp(256, 65536) as usize) * 1024;
    let sessions = ctx.sessions.clone();
    tauri::async_runtime::spawn_blocking(move || sessions.start(spec, plan, buffer))
        .await
        .map_err(|e| AppError::Other(format!("session start task failed: {e}")))?
}

/// Attach the output stream. The ring buffer is replayed first (RESET frame + DATA), then live output.
/// Frames are raw binary: first byte `frame::DATA` / `frame::RESET`. The view must `session_ack`
/// the DATA payload bytes (excluding the type byte) it has processed.
#[tauri::command]
pub async fn session_attach(
    ctx: State<'_, AppCtx>,
    id: SessionId,
    channel: Channel<InvokeResponseBody>,
) -> AppResult<SessionInfo> {
    ctx.sessions.attach(&id, channel)
}

#[tauri::command]
pub async fn session_detach(ctx: State<'_, AppCtx>, id: SessionId) -> AppResult<()> {
    ctx.sessions.detach(&id)
}

#[tauri::command]
pub async fn session_write(ctx: State<'_, AppCtx>, id: SessionId, data: String) -> AppResult<()> {
    ctx.sessions.write(&id, data.into_bytes())
}

#[tauri::command]
pub async fn session_resize(ctx: State<'_, AppCtx>, id: SessionId, cols: u16, rows: u16) -> AppResult<()> {
    ctx.sessions.resize(&id, cols, rows)
}

/// Flow control: the frontend has finished processing `bytes` more DATA payload bytes.
#[tauri::command]
pub async fn session_ack(ctx: State<'_, AppCtx>, id: SessionId, bytes: u32) -> AppResult<()> {
    ctx.sessions.ack(&id, bytes as u64)
}

/// Stop a session. `force` terminates its whole process tree immediately; otherwise
/// Ctrl+C, then console close after 2 s, then termination after 3 s more. Returns at once.
#[tauri::command]
pub async fn session_stop(ctx: State<'_, AppCtx>, id: SessionId, force: bool) -> AppResult<()> {
    ctx.sessions.stop(&id, force)
}

#[tauri::command]
pub fn session_list(ctx: State<'_, AppCtx>) -> Vec<SessionInfo> {
    ctx.sessions.list()
}

/// Buffered output as plain text (escape sequences stripped).
#[tauri::command]
pub async fn session_output_text(ctx: State<'_, AppCtx>, id: SessionId) -> AppResult<String> {
    ctx.sessions.output_text(&id)
}

#[tauri::command]
pub async fn session_clear_buffer(ctx: State<'_, AppCtx>, id: SessionId) -> AppResult<()> {
    ctx.sessions.clear_buffer(&id)
}

/// Forget an exited session (fails if still running).
#[tauri::command]
pub async fn session_remove(ctx: State<'_, AppCtx>, id: SessionId) -> AppResult<()> {
    ctx.sessions.remove(&id)
}
