//! Cost & context meter commands (see `crate::meter`). Live updates arrive as `session-meter` events.

use tauri::State;

use crate::state::AppCtx;
use crate::types::*;

/// Every known pane meter (initial load; then follow `session-meter`).
#[tauri::command]
pub async fn meter_snapshot(ctx: State<'_, AppCtx>) -> AppResult<Vec<SessionMeter>> {
    Ok(ctx.meter.snapshot())
}
