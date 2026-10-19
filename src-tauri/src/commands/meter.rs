//! Cost & context meter commands (see `crate::meter`). Live updates arrive as `session-meter` events.

use tauri::State;

use crate::state::AppCtx;
use crate::types::*;

/// Every known pane meter (initial load; then follow `session-meter`).
#[tauri::command]
pub async fn meter_snapshot(ctx: State<'_, AppCtx>) -> AppResult<Vec<SessionMeter>> {
    Ok(ctx.meter.snapshot())
}

/// The spend guard ledger (`<data>\spend-ledger.json`), or `None` when there is none yet.
#[tauri::command]
pub async fn spend_ledger_read(ctx: State<'_, AppCtx>) -> AppResult<Option<String>> {
    crate::meter::ledger::read(&ctx.paths.data_dir)
}

/// Replace the spend guard ledger (a JSON object, at most 512 KiB; atomic write).
#[tauri::command]
pub async fn spend_ledger_write(ctx: State<'_, AppCtx>, text: String) -> AppResult<()> {
    crate::meter::ledger::write(&ctx.paths.data_dir, &text)
}
