//! Altera — multi-agent terminal workspace (Tauri host).
//!
//! Module ownership:
//! - `pty`         ConPTY sessions, output ring buffer, flow control, Job Objects
//! - `adapters`    agent adapters (PowerShell, Claude Code, Codex, generic)
//! - `profiles`    Claude account profiles (CLAUDE_CONFIG_DIR)
//! - `persistence` versioned, atomically written workspace state
//! - `git`         repo info and worktrees
//! - `diagnostics` host/webview/session resource attribution
//! - `logging` / `redact` structured logs with secret redaction

pub mod adapters;
pub mod commands;
pub mod diagnostics;
pub mod git;
pub mod logging;
pub mod persistence;
pub mod profiles;
pub mod pty;
pub mod redact;
pub mod state;
pub mod types;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();
    // Benchmark runs (ALTERA_BENCH) may run beside a normal instance, so they skip the single-instance lock.
    if std::env::var_os("ALTERA_BENCH").is_none() {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }));
    }
    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let ctx = state::AppCtx::init(app.handle())?;
            app.manage(ctx);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::session::session_start,
            commands::session::session_attach,
            commands::session::session_detach,
            commands::session::session_write,
            commands::session::session_write_binary,
            commands::session::session_resize,
            commands::session::session_ack,
            commands::session::session_stop,
            commands::session::session_list,
            commands::session::session_output_text,
            commands::session::session_clear_buffer,
            commands::session::session_remove,
            commands::services::state_load,
            commands::services::state_save,
            commands::services::profiles_list,
            commands::services::profile_create,
            commands::services::profile_update,
            commands::services::profile_delete,
            commands::services::profile_check,
            commands::services::agents_detect,
            commands::services::path_info,
            commands::services::git_info,
            commands::services::git_worktree_add,
            commands::services::diagnostics_snapshot,
            commands::services::diagnostics_export,
            commands::services::log_frontend,
            commands::app::app_info,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(ctx) = app.try_state::<state::AppCtx>() {
                    ctx.shutdown();
                }
            }
        });
}
