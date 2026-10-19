//! Gridkeeper — multi-agent terminal workspace (Tauri host).
//!
//! Module ownership:
//! - `pty`         PTY sessions (ConPTY / Unix pty), output ring buffer, flow control, process containers
//! - `platform`    per-OS bits: os name, GUI-launch PATH (login shell + tool folders), macOS LANG,
//!               Linux WebKitGTK workaround, Unix termination guards
//! - `app_menu`    the native macOS menu (App, Edit, View, Window, Help)
//! - `selftest`    `--gk-self-test` / `--gk-self-test-gui`: smoke tests of the built binary (CI)
//! - `procs`       Unix process table (sessions, trees, CPU/RAM) for containment and diagnostics
//! - `adapters`    agent adapters (PowerShell, Claude Code, Codex, generic)
//! - `profiles`    account records (`profiles.json`; historically Claude-only)
//! - `accounts`    per-agent accounts: home discovery, status commands, launch env
//! - `persistence` versioned, atomically written workspace state
//! - `git`         repo info, worktrees, read-only status / diff (Changes panel), branch summary
//! - `mission`     `<project>/.gridkeeper/mission.md`: capped read, atomic checked write, debounced watch;
//!               lead control outbox (list / archive) and the generated team.md
//! - `brain`       long-term project memory: `.gridkeeper/brain/` notes + inbox, generated INDEX.md, search
//! - `replay`      mission replay recordings (`.gridkeeper/replay/*.jsonl`) and export saves
//! - `sandbox`     GRIDKEEPER_SANDBOX isolated instances (own data folder + WebView2 profile)
//! - `diagnostics` host/webview/session resource attribution
//! - `ports`       LISTENING TCP ports per session process tree
//! - `browser`     browser panes: URL validation, embeddability probe, pop-out windows
//! - `browser_view` native browser panes: one child webview per pane (Windows)
//! - `skills`      Agent Skills: GitHub discovery (user-initiated), review, install into a project
//! - `phone`       opt-in phone alerts through ntfy (user-chosen server; curl; rate limited; generic text)
//! - `meter`       Claude Code cost & context meter: status line helper mode, `--settings` file, folder watch
//! - `logging` / `redact` structured logs with secret redaction
//! - `webview_guard` reload / rebuild the main window when a WebView2 process dies

pub mod accounts;
pub mod adapters;
pub mod app_menu;
pub mod brain;
pub mod browser;
pub mod browser_view;
pub mod commands;
pub mod diagnostics;
pub mod git;
pub mod gpu;
pub mod logging;
pub mod meter;
pub mod mission;
pub mod persistence;
pub mod phone;
pub mod platform;
pub mod ports;
pub mod procs;
pub mod profiles;
pub mod pty;
pub mod redact;
pub mod replay;
pub mod sandbox;
pub mod selftest;
pub mod skills;
pub mod state;
pub mod types;
pub mod webview_guard;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // macOS / Linux GUI launches: PATH from the login shell + tool folders, LANG, WebKitGTK
    // workaround (no-op on Windows). Single-threaded here.
    platform::init_process_env();
    // `--gk-self-test-gui`: runs as sandbox "self-test" unless one is set (before the sandbox is resolved).
    let gui_self_test = selftest::gui_requested();
    if gui_self_test {
        selftest::prepare_gui();
    }
    let mut context = tauri::generate_context!();
    // Sandbox (GRIDKEEPER_SANDBOX): resolved first, while the process is still single-threaded, because it
    // sets WEBVIEW2_USER_DATA_FOLDER before any window exists. An invalid name refuses to start.
    let config_base = dirs::config_dir().map(|d| d.join(&context.config().identifier));
    let sandbox = sandbox::init_from_env(config_base).unwrap_or_else(|e| fatal_startup_error(&e));
    if let Some(s) = sandbox {
        // Patching the config (not the live window) also covers webview_guard's rebuild-from-config.
        for w in context.config_mut().app.windows.iter_mut().filter(|w| w.label == webview_guard::MAIN) {
            w.title = sandbox::window_title(&w.title, &s.name);
        }
    }
    // Window self-test: hard deadline for the whole run (starts a thread; no env changes after this).
    selftest::arm_gui_deadline();
    let mut builder = tauri::Builder::default();
    // Benchmark runs (GRIDKEEPER_BENCH) and sandboxes may run beside a normal instance, so they skip the
    // single-instance lock.
    if std::env::var_os("GRIDKEEPER_BENCH").is_none() && sandbox.is_none() {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = webview_guard::main_window(app) {
                // macOS: the main window may be hidden (⌘W).
                #[cfg(target_os = "macos")]
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }));
    }
    // macOS: the native menu (app_menu.rs), and ⌘W / the close button hide the main window instead
    // of quitting with every agent (the Dock icon and Window › Main Window bring it back; ⌘Q quits).
    #[cfg(target_os = "macos")]
    {
        builder = builder
            .menu(|app| app_menu::build(app))
            .on_menu_event(|app, event| app_menu::handle_event(app, &event))
            .on_window_event(|window, event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    if window.label() == webview_guard::MAIN {
                        api.prevent_close();
                        // Hiding a full-screen window would leave an empty Space: leave full screen first.
                        if window.is_fullscreen().unwrap_or(false) {
                            let _ = window.set_fullscreen(false);
                        } else {
                            let _ = window.hide();
                        }
                    }
                }
            });
    }
    // Windows / Linux: closing the main window quits, even with a browser pop-out (it has no parent) still
    // open; a headless app would keep its agents running and ignore a relaunch (no main window to focus).
    #[cfg(not(target_os = "macos"))]
    {
        builder = builder.on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) && window.label() == webview_guard::MAIN && !webview_guard::rebuilding() {
                window.app_handle().exit(0);
            }
        });
    }
    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .setup(move |app| {
            let ctx = state::AppCtx::init(app.handle())?;
            app.manage(ctx);
            // What init_process_env changed (logging exists from AppCtx::init on).
            platform::log_env_report();
            if gui_self_test {
                selftest::start_gui_watchdog(app.handle().clone());
            }
            // Unix: stop sessions on SIGTERM/SIGINT/SIGHUP and on a main-thread panic (no-op on Windows).
            platform::install_exit_guards(app.handle());
            if let Some(w) = webview_guard::main_webview(app.handle()) {
                webview_guard::install(&w);
            }
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
            commands::session::session_output_tail,
            commands::session::session_clear_buffer,
            commands::session::session_remove,
            commands::services::state_load,
            commands::services::state_save,
            commands::services::profiles_list,
            commands::services::profile_create,
            commands::services::profile_update,
            commands::services::profile_delete,
            commands::services::profile_check,
            commands::services::accounts_list,
            commands::services::accounts_scan,
            commands::services::accounts_specs,
            commands::services::accounts_plan_home,
            commands::services::accounts_create,
            commands::services::accounts_restore_dismissed,
            commands::services::agents_detect,
            commands::services::path_info,
            commands::services::git_info,
            commands::services::git_worktree_add,
            commands::services::diagnostics_snapshot,
            commands::services::diagnostics_export,
            commands::services::log_frontend,
            commands::app::app_info,
            commands::tools::git_changes,
            commands::tools::git_diff,
            commands::tools::git_branch_summary,
            commands::tools::git_branch_files,
            commands::tools::git_branch_file_diff,
            commands::mission::mission_read,
            commands::mission::mission_write,
            commands::mission::mission_watch,
            commands::mission::mission_unwatch,
            commands::mission::mission_outbox_list,
            commands::mission::mission_outbox_archive,
            commands::mission::mission_team_write,
            commands::tools::ports_list,
            commands::tools::browser_probe,
            commands::tools::browser_open_window,
            commands::tools::browser_close_window,
            commands::tools::browser_devtools,
            browser_view::browser_view_supported,
            browser_view::browser_view_create,
            browser_view::browser_view_set_bounds,
            browser_view::browser_view_navigate,
            browser_view::browser_view_focus,
            browser_view::browser_view_blur,
            browser_view::browser_view_close,
            browser_view::browser_view_retain,
            browser_view::browser_view_snapshot,
            browser_view::browser_view_set_shortcuts,
            browser_view::browser_view_devtools,
            commands::skills::skills_search,
            commands::skills::skills_inspect,
            commands::skills::skills_file,
            commands::skills::skills_install,
            commands::skills::skills_installed,
            commands::skills::skills_remove,
            commands::skills::skills_check_update,
            commands::replay::replay_append,
            commands::replay::replay_list,
            commands::replay::replay_read,
            commands::replay::replay_delete,
            commands::replay::replay_save_dialog,
            commands::replay::replay_save_file,
            commands::meter::meter_snapshot,
            phone::phone_alerts_get,
            phone::phone_alerts_set,
            phone::phone_alerts_new_topic,
            phone::phone_alerts_set_token,
            phone::phone_alert_send,
            phone::phone_alerts_test,
            commands::brain::brain_list,
            commands::brain::brain_read,
            commands::brain::brain_write,
            commands::brain::brain_approve,
            commands::brain::brain_delete,
            commands::brain::brain_search,
            commands::brain::brain_share,
            commands::meter::spend_ledger_read,
            commands::meter::spend_ledger_write,
        ])
        .build(context)
        .unwrap_or_else(|e| fatal_startup_error(&e.to_string()))
        .run(|app, event| match event {
            // Destroying a crashed main window leaves no windows for a moment; that is not a quit.
            tauri::RunEvent::ExitRequested { code: None, api, .. } if webview_guard::rebuilding() => {
                api.prevent_exit();
            }
            tauri::RunEvent::Exit => {
                if let Some(ctx) = app.try_state::<state::AppCtx>() {
                    ctx.shutdown();
                }
            }
            // macOS: Dock icon clicked (or the app opened again) while the main window is hidden.
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { has_visible_windows: false, .. } => app_menu::show_main(app),
            _ => {}
        });
}

/// Startup failed before any window exists (e.g. WebView2 missing or its profile folder locked by
/// another process). Tell the user instead of exiting silently.
fn fatal_startup_error(message: &str) -> ! {
    tracing::error!(error = %redact::redact(message), "startup failed");
    // The window self-test (CI) must never wait on a dialog.
    if selftest::gui_mode() {
        eprintln!("Gridkeeper could not start: {message}");
        std::process::exit(1);
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};
        let wide = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
        let text = wide(&format!(
            "The app could not start.

{message}

If another copy is already running, close it and try again.              If the problem persists, (re)install the Microsoft Edge WebView2 Runtime."
        ));
        let title = wide("Startup error");
        // SAFETY: both buffers are NUL-terminated UTF-16 and outlive the call.
        unsafe { MessageBoxW(std::ptr::null_mut(), text.as_ptr(), title.as_ptr(), MB_OK | MB_ICONERROR) };
    }
    #[cfg(not(windows))]
    eprintln!("Gridkeeper could not start: {message}");
    std::process::exit(1);
}
