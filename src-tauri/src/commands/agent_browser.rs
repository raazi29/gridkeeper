//! Agent browser commands (see `crate::agent_browser`). Live updates arrive as `agent-browser-state`
//! and `agent-browser-activity` events; screencast frames on the channel given to `agent_browser_watch`.

use std::sync::Arc;

use tauri::ipc::{Channel, InvokeResponseBody};

use crate::agent_browser::app::ChannelSink;
use crate::agent_browser::model::{AgentBrowserState, InputEvent};
use crate::agent_browser::{Hub, hub};
use crate::types::{AppError, AppResult};

fn the_hub() -> AppResult<&'static Arc<Hub>> {
    hub().ok_or_else(|| AppError::Other("the agent browser is not available".into()))
}

fn err(e: String) -> AppError {
    AppError::Other(e)
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> AppResult<T> + Send + 'static) -> AppResult<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| AppError::Other(format!("agent browser task failed: {e}")))?
}

#[tauri::command]
pub async fn agent_browser_state() -> AppResult<AgentBrowserState> {
    Ok(the_hub()?.state())
}

/// "Give this agent a browser" (applies at the session's next launch).
#[tauri::command]
pub async fn agent_browser_set_session(id: String, enabled: bool) -> AppResult<()> {
    the_hub()?.set_session(&id, enabled).map_err(err)
}

/// Replace the allowlist; returns the normalized entries.
#[tauri::command]
pub async fn agent_browser_set_allowlist(entries: Vec<String>) -> AppResult<Vec<String>> {
    the_hub()?.set_allowlist(&entries).map_err(err)
}

#[tauri::command]
pub async fn agent_browser_set_idle_minutes(minutes: u32) -> AppResult<()> {
    the_hub()?.set_idle_minutes(minutes).map_err(err)
}

/// "Stop agent browsing" (true) / allow again (false).
#[tauri::command]
pub async fn agent_browser_set_stopped(id: String, stopped: bool) -> AppResult<()> {
    let h = the_hub()?;
    blocking(move || h.set_stopped(&id, stopped).map_err(err)).await
}

#[tauri::command]
pub async fn agent_browser_take_over(id: String, on: bool) -> AppResult<()> {
    the_hub()?.take_over(&id, on).map_err(err)
}

#[tauri::command]
pub async fn agent_browser_answer(prompt_id: u64, allow: bool, remember: bool) -> AppResult<()> {
    the_hub()?.answer(prompt_id, allow, remember).map_err(err)
}

/// Stream the tab as JPEG frames (`[u32 LE header length][header JSON][JPEG]`) while the view shows it.
#[tauri::command]
pub async fn agent_browser_watch(id: String, channel: Channel<InvokeResponseBody>, max_width: u32, max_height: u32, token: u32) -> AppResult<()> {
    let h = the_hub()?;
    blocking(move || {
        h.watch(&id, Arc::new(ChannelSink(channel)), max_width, max_height, token);
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn agent_browser_unwatch(id: String, token: u32) -> AppResult<()> {
    let h = the_hub()?;
    blocking(move || {
        h.unwatch(&id, token);
        Ok(())
    })
    .await
}

/// User input while the tab is taken over.
#[tauri::command]
pub async fn agent_browser_input(id: String, event: InputEvent) -> AppResult<()> {
    the_hub()?.input(&id, &event).map_err(err)
}

/// Close the shared browser now (tabs reopen on the next tool call).
#[tauri::command]
pub async fn agent_browser_stop_browser() -> AppResult<()> {
    let h = the_hub()?;
    blocking(move || {
        h.stop_browser("closed from the Agent browser view");
        Ok(())
    })
    .await
}
