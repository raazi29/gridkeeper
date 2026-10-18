//! WebView2 crash recovery for the main window.
//!
//! When Windows runs low on virtual memory it can kill the WebView2 browser or renderer process.
//! Without a handler the main window stays black until the app is restarted, although every PTY
//! session is still alive in this process. Sessions and their replay rings live on the Rust side
//! and the frontend re-attaches to running sessions when it boots, so recovery is a fresh page:
//! - renderer exited, or still unresponsive on a repeat report: reload the page;
//! - browser process exited: the controller is dead, so the window is destroyed and rebuilt from
//!   the config (`lib.rs` keeps the app alive while no window exists);
//! - GPU / utility processes exited: WebView2 restarts those itself; lost WebGL contexts are
//!   handled by the terminal registry. Logged only.
//!
//! Windows only. On macOS / Linux `install` does nothing: WKWebView / WebKitGTK web-process crashes
//! are not handled yet (the page would have to be reloaded by hand).

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use tauri::{AppHandle, Manager, WebviewWindow};

pub const MAIN: &str = "main";

/// Set while the main window is being rebuilt, so destroying the dead one doesn't exit the app.
static REBUILDING: AtomicBool = AtomicBool::new(false);
/// Recent recoveries, to back off instead of thrashing while memory is still exhausted.
#[cfg_attr(not(windows), allow(dead_code))]
static RECOVERIES: Mutex<Vec<Instant>> = Mutex::new(Vec::new());

pub fn rebuilding() -> bool {
    REBUILDING.load(Ordering::Acquire)
}

/// Delay before the next recovery: none for the first two in a minute, then growing to 30 s.
#[cfg_attr(not(windows), allow(dead_code))]
fn backoff() -> Duration {
    let mut r = RECOVERIES.lock();
    let now = Instant::now();
    r.retain(|t| now.duration_since(*t) < Duration::from_secs(60));
    r.push(now);
    match r.len() {
        0..=2 => Duration::ZERO,
        n => Duration::from_secs((5 * (n as u64 - 2)).min(30)),
    }
}

#[cfg(windows)]
pub fn install(window: &WebviewWindow) {
    let app = window.app_handle().clone();
    let res = window.with_webview(move |pw| {
        if let Err(e) = hook(&pw.controller(), app) {
            tracing::warn!(error = %e, "could not install the WebView2 crash handler");
        }
    });
    if let Err(e) = res {
        tracing::warn!(error = %e, "could not reach the main webview to install the crash handler");
    }
}

#[cfg(not(windows))]
pub fn install(_window: &WebviewWindow) {}

#[cfg(windows)]
fn hook(
    controller: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller,
    app: AppHandle,
) -> windows_core::Result<()> {
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    use webview2_com::ProcessFailedEventHandler;
    use windows_core::Interface;

    let mut last_hang: Option<Instant> = None;
    let handler = ProcessFailedEventHandler::create(Box::new(move |webview, args| {
        let Some(args) = args else { return Ok(()) };
        let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
        let mut reason = COREWEBVIEW2_PROCESS_FAILED_REASON::default();
        let mut exit_code = 0i32;
        // SAFETY: plain out-parameter getters on a live event-args object, on the UI thread.
        unsafe {
            args.ProcessFailedKind(&mut kind)?;
            if let Ok(a2) = args.cast::<ICoreWebView2ProcessFailedEventArgs2>() {
                let _ = a2.Reason(&mut reason);
                let _ = a2.ExitCode(&mut exit_code);
            }
        }
        tracing::error!(
            kind = kind.0,
            reason = reason.0,
            exit_code = format_args!("{:#010x}", exit_code as u32),
            "WebView2 process failed"
        );

        let reload = match kind {
            COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED => true,
            // Reported repeatedly while the renderer stays hung; a single report can be a long frame.
            COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE => {
                let now = Instant::now();
                let repeat = last_hang.is_some_and(|t| now.duration_since(t) < Duration::from_secs(30));
                last_hang = Some(now);
                repeat
            }
            COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED => {
                rebuild(app.clone());
                return Ok(());
            }
            _ => false,
        };
        if reload {
            last_hang = None;
            let delay = backoff();
            match webview {
                Some(wv) if delay.is_zero() => {
                    tracing::warn!("reloading the main page after a renderer failure");
                    // SAFETY: the WebView stays valid after a renderer failure; called on the UI thread.
                    unsafe { wv.Reload()? };
                }
                _ => {
                    let app = app.clone();
                    tauri::async_runtime::spawn(async move {
                        pause(delay).await;
                        tracing::warn!(delay_s = delay.as_secs(), "reloading the main page after a renderer failure");
                        if let Some(w) = app.get_webview_window(MAIN) {
                            let _ = w.reload();
                        }
                    });
                }
            }
        }
        Ok(())
    }));
    let mut token = 0i64;
    // SAFETY: registering an event handler on the live CoreWebView2 from the UI thread.
    unsafe { controller.CoreWebView2()?.add_ProcessFailed(&handler, &mut token) }
}

/// Destroy the dead main window and build a new one from the config. Runs off the UI thread:
/// window creation from inside a WebView2 callback would re-enter the event loop.
#[cfg_attr(not(windows), allow(dead_code))]
fn rebuild(app: AppHandle) {
    if REBUILDING.swap(true, Ordering::AcqRel) {
        return;
    }
    let delay = backoff();
    tauri::async_runtime::spawn(async move {
        pause(delay).await;
        tracing::warn!(delay_s = delay.as_secs(), "WebView2 browser process exited; rebuilding the main window");
        let mut geometry = None;
        if let Some(old) = app.get_webview_window(MAIN) {
            geometry = Some((old.outer_position().ok(), old.inner_size().ok(), old.is_maximized().unwrap_or(false)));
            let _ = old.destroy();
        }
        // The label is free once the old window is gone from the manager.
        for _ in 0..50 {
            if app.get_webview_window(MAIN).is_none() {
                break;
            }
            pause(Duration::from_millis(100)).await;
        }
        let built = app
            .config()
            .app
            .windows
            .iter()
            .find(|c| c.label == MAIN)
            .ok_or(tauri::Error::WindowNotFound)
            .and_then(|cfg| tauri::WebviewWindowBuilder::from_config(&app, cfg)?.build());
        match built {
            Ok(w) => {
                if let Some((pos, size, maximized)) = geometry {
                    if maximized {
                        let _ = w.maximize();
                    } else {
                        if let Some(p) = pos {
                            let _ = w.set_position(p);
                        }
                        if let Some(s) = size {
                            let _ = w.set_size(s);
                        }
                    }
                }
                install(&w);
                tracing::info!("main window rebuilt; the page re-attaches to running sessions");
            }
            Err(e) => tracing::error!(error = %e, "could not rebuild the main window"),
        }
        REBUILDING.store(false, Ordering::Release);
    });
}

#[cfg_attr(not(windows), allow(dead_code))]
async fn pause(d: Duration) {
    if !d.is_zero() {
        tauri::async_runtime::spawn_blocking(move || std::thread::sleep(d)).await.ok();
    }
}
