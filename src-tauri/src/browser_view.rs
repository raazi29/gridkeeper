//! Native browser panes: one child webview per browser pane, laid over the pane's host box.
//!
//! Windows only (Tauri's `unstable` multi-webview API, enabled for the Windows target in Cargo.toml).
//! The frontend (`src/browser/nativeViews.ts`) reports each pane's host box in CSS pixels plus the
//! page's `devicePixelRatio`, and hides a view whenever DOM content (menus, dialogs, the palette,
//! Mission Control, toasts) would have to draw above it: a native view always paints above the main
//! webview. Everything else (iframe engine, pop-outs, the probe) stays in `browser.rs`.
//! Why and how: docs/TECHNICAL_DECISIONS.md ADR-020, docs/research-notes/native-browser-panes.md.
//!
//! Security (same model as pop-out windows, ADR-019):
//! - views are labelled `bv-<pane id>`; capabilities target the `main` webview by label, so a view
//!   matches no capability and gets no plugin command;
//! - Tauri rejects custom (app) commands from remote origins; the only way around that is a URL Tauri
//!   treats as local (its protocol hosts, the dev server), and `view_navigation_allowed` refuses those
//!   for every top-level navigation, redirect and link click;
//! - new windows are always denied (the frontend opens the URL in this or a new pane);
//! - events go to the `main` webview only.
//!
//! macOS / Linux: the commands report "unsupported" and the frontend keeps the iframe engine. On
//! Linux, Tauri 2.12 packs child webviews into the window's GtkBox, so they cannot be positioned; on
//! macOS the API works but is unverified here and has no accelerator-key hook for app shortcuts.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Url};

use crate::browser::{MAX_URL_LEN, is_app_origin, validate_url};
use crate::types::{AppError, AppResult};

/// Webview label prefix; the rest is the pane id.
pub const LABEL_PREFIX: &str = "bv-";
const MAX_PANE_ID: usize = 64;
/// Bounds beyond this (CSS px) are a bug, not a layout.
const MAX_COORD: f64 = 100_000.0;
const MAX_SHORTCUTS: usize = 256;
const MAX_COMBO_LEN: usize = 48;
/// URLs reported to the frontend are cut here (data: / blob: sources can be huge).
#[cfg_attr(not(windows), allow(dead_code))]
const MAX_REPORTED_URL: usize = 8 * MAX_URL_LEN;

pub const EVT_STATE: &str = "browser-view-state";
pub const EVT_FOCUS: &str = "browser-view-focus";
pub const EVT_SHORTCUT: &str = "browser-view-shortcut";
pub const EVT_NEW_WINDOW: &str = "browser-view-new-window";
pub const EVT_DOWNLOAD: &str = "browser-view-download";

/// True where native browser panes exist (the frontend falls back to iframes elsewhere).
pub fn supported() -> bool {
    cfg!(windows)
}

/// `bv-<pane id>` for a pane id made of ASCII letters, digits, `-` and `_` (UUIDs), else None.
pub fn view_label(pane_id: &str) -> Option<String> {
    let ok = !pane_id.is_empty()
        && pane_id.len() <= MAX_PANE_ID
        && pane_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    ok.then(|| format!("{LABEL_PREFIX}{pane_id}"))
}

/// The pane id of a view label.
pub fn pane_of_label(label: &str) -> Option<&str> {
    label.strip_prefix(LABEL_PREFIX).filter(|id| view_label(id).is_some())
}

/// A pane's host box in CSS pixels of the main webview, plus the page's `devicePixelRatio`.
#[derive(Debug, Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ViewRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub scale: f64,
}

/// Physical pixels relative to the window's client area (where the main webview starts).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PhysRect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// CSS rect -> physical rect. Edges are rounded (not the size), so adjacent panes never leave a gap.
/// None for non-finite values, negative sizes, absurd coordinates or a scale outside 0.25..=8.
pub fn physical_rect(r: &ViewRect) -> Option<PhysRect> {
    if [r.x, r.y, r.width, r.height, r.scale].iter().any(|v| !v.is_finite()) {
        return None;
    }
    if !(0.25..=8.0).contains(&r.scale) || r.width < 0.0 || r.height < 0.0 {
        return None;
    }
    if r.x.abs() > MAX_COORD || r.y.abs() > MAX_COORD || r.width > MAX_COORD || r.height > MAX_COORD {
        return None;
    }
    let left = (r.x * r.scale).round();
    let top = (r.y * r.scale).round();
    let right = ((r.x + r.width) * r.scale).round();
    let bottom = ((r.y + r.height) * r.scale).round();
    Some(PhysRect { x: left as i32, y: top as i32, width: (right - left).max(0.0) as u32, height: (bottom - top).max(0.0) as u32 })
}

/// What the frontend wants a view to be.
/// - `shown`: placed at its rect and visible;
/// - `occluded`: hidden for a moment (an overlay, a drag); the page keeps running normally;
/// - `parked`: hidden while its pane is off screen; WebView2 is asked to use less memory.
#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Visibility {
    Shown,
    Occluded,
    Parked,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum NavAction {
    Url { url: String },
    Back,
    Forward,
    Reload,
    Stop,
}

/// An address a view is asked to open: what `browser::validate_url` accepts (http / https / file),
/// minus the app's own origins.
pub fn page_url(raw: &str, dev: Option<&Url>) -> AppResult<Url> {
    let v = validate_url(raw).ok_or_else(|| AppError::Invalid("Only http, https and file URLs are allowed".into()))?;
    let u = Url::parse(&v).map_err(|e| AppError::Invalid(e.to_string()))?;
    if is_app_origin(&u, dev) {
        return Err(AppError::Invalid("That address belongs to Gridkeeper itself".into()));
    }
    Ok(u)
}

/// Top-level navigations a view may make (typed addresses, redirects, link clicks, history steps).
/// `blob:` is allowed when its creator's origin is an ordinary web origin (generated downloads).
pub fn view_navigation_allowed(u: &Url, dev: Option<&Url>) -> bool {
    match u.scheme() {
        "http" | "https" | "file" => !is_app_origin(u, dev),
        "about" => u.as_str() == "about:blank",
        "blob" => Url::parse(u.path())
            .ok()
            .is_some_and(|inner| matches!(inner.scheme(), "http" | "https") && !is_app_origin(&inner, dev)),
        _ => false,
    }
}

/// `target=_blank` / `window.open` target the frontend may open (http / https, not the app itself).
pub fn new_window_url(u: &Url, dev: Option<&Url>) -> Option<String> {
    if !matches!(u.scheme(), "http" | "https") || is_app_origin(u, dev) {
        return None;
    }
    validate_url(u.as_str())
}

/// Modifier state of a key press.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Mods {
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
    pub meta: bool,
}

/// The key token of the frontend's combo format (`src/keybindings/combo.ts`) for a Windows virtual
/// key. Punctuation goes by scan code, like `KeyboardEvent.code` there (the physical key, so
/// "ctrl+shift+=" means the same key on every layout); letters and digits by virtual key.
pub fn key_name(vk: u32, scan: u32) -> Option<String> {
    let named = |s: &str| Some(s.to_string());
    match vk {
        0x41..=0x5A => Some(char::from(b'a' + (vk - 0x41) as u8).to_string()),
        0x30..=0x39 => Some(char::from(b'0' + (vk - 0x30) as u8).to_string()),
        0x60..=0x69 => Some(char::from(b'0' + (vk - 0x60) as u8).to_string()),
        0x70..=0x87 => Some(format!("f{}", vk - 0x6F)),
        0x08 => named("backspace"),
        0x09 => named("tab"),
        0x0D => named("enter"),
        0x1B => named("escape"),
        0x20 => named("space"),
        0x21 => named("pageup"),
        0x22 => named("pagedown"),
        0x23 => named("end"),
        0x24 => named("home"),
        0x25 => named("arrowleft"),
        0x26 => named("arrowup"),
        0x27 => named("arrowright"),
        0x28 => named("arrowdown"),
        0x2D => named("insert"),
        0x2E => named("delete"),
        0x6A => named("*"),
        0x6B => named("+"),
        0x6D => named("-"),
        0x6F => named("/"),
        // VK_OEM_* punctuation: physical position first, US meaning as the fallback.
        0xBA..=0xC0 | 0xDB..=0xDF => {
            let by_scan = match scan {
                0x29 => Some("`"),
                0x0C => Some("-"),
                0x0D => Some("="),
                0x1A => Some("["),
                0x1B => Some("]"),
                0x2B => Some("\\"),
                0x27 => Some(";"),
                0x28 => Some("'"),
                0x33 => Some(","),
                0x34 => Some("."),
                0x35 => Some("/"),
                _ => None,
            };
            let by_vk = match vk {
                0xBA => Some(";"),
                0xBB => Some("="),
                0xBC => Some(","),
                0xBD => Some("-"),
                0xBE => Some("."),
                0xBF => Some("/"),
                0xC0 => Some("`"),
                0xDB => Some("["),
                0xDC => Some("\\"),
                0xDD => Some("]"),
                0xDE => Some("'"),
                _ => None,
            };
            by_scan.or(by_vk).map(str::to_string)
        }
        _ => None,
    }
}

/// Canonical combo string ("ctrl+alt+shift+meta+<key>") of a key press, or None (modifier only, unknown key).
pub fn key_combo(vk: u32, scan: u32, m: Mods) -> Option<String> {
    let key = key_name(vk, scan)?;
    let mut s = String::with_capacity(24);
    for (on, token) in [(m.ctrl, "ctrl+"), (m.alt, "alt+"), (m.shift, "shift+"), (m.meta, "meta+")] {
        if on {
            s.push_str(token);
        }
    }
    s.push_str(&key);
    Some(s)
}

/// A combo string the frontend may register: short printable ASCII.
pub fn valid_combo(s: &str) -> bool {
    !s.is_empty() && s.len() <= MAX_COMBO_LEN && s.chars().all(|c| c.is_ascii_graphic())
}

/// Where a download is saved: WebView2's suggested path when it is already in `downloads`, else the
/// suggested file name in `downloads`, numbered when taken. None without a usable file name.
pub fn download_target(suggested: &Path, downloads: &Path, exists: impl Fn(&Path) -> bool) -> Option<PathBuf> {
    let name = suggested.file_name()?;
    if suggested.parent().is_some_and(|p| p == downloads) {
        return Some(suggested.to_path_buf());
    }
    let first = downloads.join(name);
    if !exists(&first) {
        return Some(first);
    }
    let p = Path::new(name);
    let stem = p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let ext = p.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    (1..1000).map(|i| downloads.join(format!("{stem} ({i}){ext}"))).find(|c| !exists(c))
}

/// Page title as shown in the UI: control characters dropped, at most 200 characters.
pub fn clean_title(t: &str) -> String {
    t.chars().filter(|c| !c.is_control()).take(200).collect::<String>().trim().to_string()
}

#[cfg_attr(not(windows), allow(dead_code))]
fn clip_url(mut u: String) -> String {
    if u.len() > MAX_REPORTED_URL {
        let mut cut = MAX_REPORTED_URL;
        while !u.is_char_boundary(cut) {
            cut -= 1;
        }
        u.truncate(cut);
    }
    u
}

// ---------------------------------------------------------------------------
// Event payloads (main webview only)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ViewState {
    pub pane_id: String,
    pub url: String,
    pub title: String,
    pub can_go_back: bool,
    pub can_go_forward: bool,
    pub loading: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewPane {
    pub pane_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewShortcut {
    pub pane_id: String,
    pub combo: String,
    pub repeat: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewNewWindow {
    pub pane_id: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewDownload {
    pub pane_id: String,
    pub url: String,
    pub path: Option<String>,
    /// "started" | "done" | "failed"
    pub state: &'static str,
}

// ---------------------------------------------------------------------------
// Commands (every platform registers them; only Windows implements them)
// ---------------------------------------------------------------------------

#[cfg(not(windows))]
fn unsupported<T>() -> AppResult<T> {
    Err(AppError::Invalid("Native browser panes are only available on Windows".into()))
}

#[tauri::command]
pub fn browser_view_supported() -> bool {
    supported()
}

/// Create the pane's view (or reuse it after a frontend reload: then only bounds and visibility are
/// applied and its state is re-sent). Returns true when an existing view was reused.
#[tauri::command]
pub async fn browser_view_create(app: AppHandle, pane_id: String, url: String, rect: ViewRect, visibility: Visibility) -> AppResult<bool> {
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(move || imp::create(&app, &pane_id, &url, &rect, visibility))
            .await
            .map_err(|e| AppError::Other(e.to_string()))?
    }
    #[cfg(not(windows))]
    {
        let _ = (app, pane_id, url, rect, visibility);
        unsupported()
    }
}

/// Place / show / hide a view. `rect` may be omitted when hiding.
#[tauri::command]
pub fn browser_view_set_bounds(app: AppHandle, pane_id: String, rect: Option<ViewRect>, visibility: Visibility) -> AppResult<()> {
    #[cfg(windows)]
    {
        imp::set_bounds(&app, &pane_id, rect.as_ref(), visibility)
    }
    #[cfg(not(windows))]
    {
        let _ = (app, pane_id, rect, visibility);
        unsupported()
    }
}

#[tauri::command]
pub fn browser_view_navigate(app: AppHandle, pane_id: String, action: NavAction) -> AppResult<()> {
    #[cfg(windows)]
    {
        imp::navigate(&app, &pane_id, action)
    }
    #[cfg(not(windows))]
    {
        let _ = (app, pane_id, action);
        unsupported()
    }
}

/// Give the page keyboard focus.
#[tauri::command]
pub fn browser_view_focus(app: AppHandle, pane_id: String) -> AppResult<()> {
    #[cfg(windows)]
    {
        imp::focus(&app, &pane_id)
    }
    #[cfg(not(windows))]
    {
        let _ = (app, pane_id);
        unsupported()
    }
}

/// Keyboard focus back to the app page when a view has it (a forwarded app shortcut is about to run).
#[tauri::command]
pub fn browser_view_blur(app: AppHandle) -> AppResult<()> {
    #[cfg(windows)]
    imp::blur(&app);
    #[cfg(not(windows))]
    let _ = app;
    Ok(())
}

/// Close a pane's view. Returns false when it did not exist.
#[tauri::command]
pub async fn browser_view_close(app: AppHandle, pane_id: String) -> AppResult<bool> {
    #[cfg(windows)]
    {
        imp::close(&app, &pane_id)
    }
    #[cfg(not(windows))]
    {
        let _ = (app, pane_id);
        Ok(false)
    }
}

/// Close every view whose pane is not listed (frontend boot, engine switch). Returns how many closed.
#[tauri::command]
pub async fn browser_view_retain(app: AppHandle, pane_ids: Vec<String>) -> AppResult<u32> {
    #[cfg(windows)]
    {
        Ok(imp::retain(&app, &pane_ids))
    }
    #[cfg(not(windows))]
    {
        let _ = (app, pane_ids);
        Ok(0)
    }
}

/// JPEG of what the view shows now (the placeholder while it is hidden for an overlay). Empty when
/// no picture could be taken within 400 ms (e.g. before the first paint).
#[tauri::command]
pub async fn browser_view_snapshot(app: AppHandle, pane_id: String) -> AppResult<tauri::ipc::Response> {
    #[cfg(windows)]
    {
        Ok(tauri::ipc::Response::new(imp::snapshot(&app, &pane_id).await?))
    }
    #[cfg(not(windows))]
    {
        let _ = (app, pane_id);
        unsupported()
    }
}

/// The app's key bindings (canonical combo strings). Pressed while a page has focus, they are kept
/// from the page and sent to the app as `browser-view-shortcut`.
#[tauri::command]
pub fn browser_view_set_shortcuts(combos: Vec<String>) -> AppResult<()> {
    if combos.len() > MAX_SHORTCUTS || !combos.iter().all(|c| valid_combo(c)) {
        return Err(AppError::Invalid("Invalid shortcut list".into()));
    }
    #[cfg(windows)]
    imp::set_shortcuts(combos);
    Ok(())
}

/// Developer tools of a view (debug builds only; release builds ship without the `devtools` feature).
#[tauri::command]
pub fn browser_view_devtools(app: AppHandle, pane_id: String) -> AppResult<()> {
    #[cfg(all(windows, debug_assertions))]
    {
        imp::devtools(&app, &pane_id)
    }
    #[cfg(not(all(windows, debug_assertions)))]
    {
        let _ = (app, pane_id);
        Err(AppError::Invalid("Developer tools are only available in debug builds on Windows".into()))
    }
}

/// The main window is being rebuilt (WebView2 browser process died): its views are gone with it.
pub fn forget_all() {
    #[cfg(windows)]
    imp::forget_all();
}

// ---------------------------------------------------------------------------
// Windows implementation (WebView2)
// ---------------------------------------------------------------------------

#[cfg(windows)]
mod imp {
    use std::collections::{HashMap, HashSet};
    use std::sync::mpsc;
    use std::time::Duration;

    use once_cell::sync::Lazy;
    use parking_lot::{Mutex, RwLock};
    use tauri::webview::{DownloadEvent, NewWindowResponse, WebviewBuilder};
    use tauri::{Emitter, Manager, PhysicalPosition, PhysicalSize, Rect, Webview, WebviewUrl};
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    use webview2_com::{
        AcceleratorKeyPressedEventHandler, CapturePreviewCompletedHandler, DocumentTitleChangedEventHandler,
        FocusChangedEventHandler, HistoryChangedEventHandler, NavigationCompletedEventHandler, NavigationStartingEventHandler,
        SourceChangedEventHandler, take_pwstr,
    };
    use windows::Win32::System::Com::{IStream, STREAM_SEEK_SET};
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetKeyState, VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT};
    use windows::Win32::UI::Shell::SHCreateMemStream;
    use windows_core::{BOOL, Interface, PWSTR};

    use super::*;
    use crate::webview_guard::MAIN;

    const SNAPSHOT_TIMEOUT: Duration = Duration::from_millis(400);
    const MAX_SNAPSHOT: usize = 16 * 1024 * 1024;

    #[derive(Default)]
    struct ViewInfo {
        focused: bool,
        loading: bool,
        shown: bool,
        parked: bool,
    }

    /// Per view label. Never hold this lock while calling into Tauri / WebView2: focus changes call
    /// back into the handlers below synchronously on the UI thread.
    static VIEWS: Lazy<Mutex<HashMap<String, ViewInfo>>> = Lazy::new(Default::default);
    static CREATING: Lazy<Mutex<HashSet<String>>> = Lazy::new(Default::default);
    static SHORTCUTS: Lazy<RwLock<HashSet<String>>> = Lazy::new(Default::default);

    fn label_of(pane_id: &str) -> AppResult<String> {
        view_label(pane_id).ok_or_else(|| AppError::Invalid("Invalid pane id".into()))
    }

    fn view(app: &AppHandle, pane_id: &str) -> AppResult<(String, Webview)> {
        let label = label_of(pane_id)?;
        let wv = app.get_webview(&label).ok_or_else(|| AppError::NotFound("browser view".into()))?;
        Ok((label, wv))
    }

    fn other(e: impl std::fmt::Display) -> AppError {
        AppError::Other(e.to_string())
    }

    fn focus_main(app: &AppHandle) {
        if let Some(m) = app.get_webview(MAIN) {
            let _ = m.set_focus();
        }
    }

    pub fn create(app: &AppHandle, pane_id: &str, url: &str, rect: &ViewRect, vis: Visibility) -> AppResult<bool> {
        let label = label_of(pane_id)?;
        let dev = crate::browser::dev_url(app);
        let target = page_url(url, dev.as_ref())?;
        let phys = physical_rect(rect).ok_or_else(|| AppError::Invalid("Invalid bounds".into()))?;
        if app.get_webview(&label).is_some() {
            VIEWS.lock().entry(label.clone()).or_default();
            set_bounds(app, pane_id, Some(rect), vis)?;
            resend_state(app, &label, pane_id);
            return Ok(true);
        }
        if !CREATING.lock().insert(label.clone()) {
            return Err(AppError::Conflict("The browser view is already being created".into()));
        }
        let res = build(app, &label, pane_id, target, phys, vis, dev);
        CREATING.lock().remove(&label);
        res.map(|_| false)
    }

    fn build(app: &AppHandle, label: &str, pane_id: &str, target: Url, phys: PhysRect, vis: Visibility, dev: Option<Url>) -> AppResult<()> {
        let window = app.get_window(MAIN).ok_or_else(|| AppError::NotFound("main window".into()))?;
        // Every WebView2 environment on one user data folder must use the same browser arguments
        // (else ERROR_INVALID_STATE, 0x8007139F), so take the main window's.
        let args = app.config().app.windows.iter().find(|w| w.label == MAIN).and_then(|w| w.additional_browser_args.clone());
        let nav_dev = dev.clone();
        let popup = (app.clone(), pane_id.to_string(), dev);
        let blank = Url::parse("about:blank").map_err(other)?;
        let mut builder = WebviewBuilder::new(label, WebviewUrl::External(blank))
            .on_navigation(move |u| view_navigation_allowed(u, nav_dev.as_ref()))
            .on_new_window(move |u, _features| {
                let (app, pane, dev) = &popup;
                if let Some(url) = new_window_url(&u, dev.as_ref()) {
                    let _ = app.emit_to(MAIN, EVT_NEW_WINDOW, ViewNewWindow { pane_id: pane.clone(), url });
                }
                NewWindowResponse::Deny
            })
            .on_download(download_handler(pane_id.to_string()))
            .zoom_hotkeys_enabled(true)
            .focused(false);
        if let Some(a) = args {
            builder = builder.additional_browser_args(&a);
        }
        let shown = vis == Visibility::Shown;
        // Created hidden views start at zero size, so the blank page never flashes.
        let size = if shown { PhysicalSize::new(phys.width, phys.height) } else { PhysicalSize::new(0, 0) };
        let wv = window
            .add_child(builder, PhysicalPosition::new(phys.x, phys.y), size)
            .map_err(|e| AppError::Other(format!("Could not create the browser view: {e}")))?;
        VIEWS.lock().insert(label.to_string(), ViewInfo { shown, ..Default::default() });
        if !shown {
            let _ = wv.hide();
        }
        install_hooks(app, &wv, pane_id);
        // Queued after the hooks (same event loop), so the first real navigation is observed.
        wv.navigate(target).map_err(other)?;
        tracing::info!("created a native browser view");
        Ok(())
    }

    fn download_handler(pane_id: String) -> impl Fn(Webview, DownloadEvent<'_>) -> bool + Send + Sync + 'static {
        move |wv, event| {
            let app = wv.app_handle().clone();
            match event {
                DownloadEvent::Requested { url, destination } => {
                    let Some(dir) = dirs::download_dir() else { return true };
                    match download_target(destination, &dir, |p| p.exists()) {
                        Some(p) => *destination = p,
                        None => return false,
                    }
                    let _ = app.emit_to(
                        MAIN,
                        EVT_DOWNLOAD,
                        ViewDownload { pane_id: pane_id.clone(), url: clip_url(url.to_string()), path: Some(destination.display().to_string()), state: "started" },
                    );
                    true
                }
                DownloadEvent::Finished { url, path, success } => {
                    let _ = app.emit_to(
                        MAIN,
                        EVT_DOWNLOAD,
                        ViewDownload {
                            pane_id: pane_id.clone(),
                            url: clip_url(url.to_string()),
                            path: path.map(|p| p.display().to_string()),
                            state: if success { "done" } else { "failed" },
                        },
                    );
                    true
                }
                _ => true,
            }
        }
    }

    fn install_hooks(app: &AppHandle, wv: &Webview, pane_id: &str) {
        let app = app.clone();
        let label = wv.label().to_string();
        let pane = pane_id.to_string();
        let res = wv.with_webview(move |pw| {
            // SAFETY: runs on the UI thread with the view's live controller.
            if let Err(e) = unsafe { hook(&pw.controller(), app, label, pane) } {
                tracing::warn!(error = %e, "could not attach the browser view handlers");
            }
        });
        if let Err(e) = res {
            tracing::warn!(error = %e, "could not reach the browser view to attach its handlers");
        }
    }

    /// Source, title and history flags of the page.
    unsafe fn read_state(core: &ICoreWebView2) -> windows_core::Result<(String, String, bool, bool)> {
        let mut src = PWSTR::null();
        let mut title = PWSTR::null();
        let mut back = BOOL::default();
        let mut fwd = BOOL::default();
        // SAFETY: plain getters on a live CoreWebView2 on the UI thread; the strings are taken (freed) once.
        unsafe {
            core.Source(&mut src)?;
            let url = take_pwstr(src);
            core.DocumentTitle(&mut title)?;
            let title = take_pwstr(title);
            core.CanGoBack(&mut back)?;
            core.CanGoForward(&mut fwd)?;
            Ok((url, title, back.as_bool(), fwd.as_bool()))
        }
    }

    fn emit_state(app: &AppHandle, label: &str, pane: &str, core: &ICoreWebView2) {
        let loading = VIEWS.lock().get(label).is_some_and(|v| v.loading);
        // SAFETY: called from WebView2 event handlers / with_webview, i.e. on the UI thread.
        if let Ok((url, title, can_go_back, can_go_forward)) = unsafe { read_state(core) } {
            let st = ViewState { pane_id: pane.to_string(), url: clip_url(url), title: clean_title(&title), can_go_back, can_go_forward, loading };
            let _ = app.emit_to(MAIN, EVT_STATE, st);
        }
    }

    fn resend_state(app: &AppHandle, label: &str, pane: &str) {
        let Some(wv) = app.get_webview(label) else { return };
        let (app, label, pane) = (app.clone(), label.to_string(), pane.to_string());
        let _ = wv.with_webview(move |pw| {
            // SAFETY: UI thread, live controller.
            if let Ok(core) = unsafe { pw.controller().CoreWebView2() } {
                emit_state(&app, &label, &pane, &core);
            }
        });
    }

    fn set_loading(label: &str, loading: bool) {
        if let Some(v) = VIEWS.lock().get_mut(label) {
            v.loading = loading;
        }
    }

    fn modifiers() -> Mods {
        // SAFETY: GetKeyState only reads the calling thread's key state (the UI thread, which is
        // processing this key message).
        let down = |vk: u16| unsafe { GetKeyState(i32::from(vk)) } < 0;
        Mods { ctrl: down(VK_CONTROL.0), alt: down(VK_MENU.0), shift: down(VK_SHIFT.0), meta: down(VK_LWIN.0) || down(VK_RWIN.0) }
    }

    /// WebView2 handlers of one view: page state -> `browser-view-state`, focus -> `browser-view-focus`,
    /// app shortcuts -> `browser-view-shortcut` (kept from the page).
    unsafe fn hook(controller: &ICoreWebView2Controller, app: AppHandle, label: String, pane: String) -> windows_core::Result<()> {
        // SAFETY (whole function): registering handlers on a live controller / CoreWebView2 from the UI thread.
        unsafe {
            let core = controller.CoreWebView2()?;
            let mut token = 0i64;

            let (a, l, p) = (app.clone(), label.clone(), pane.clone());
            core.add_NavigationStarting(
                &NavigationStartingEventHandler::create(Box::new(move |sender, _| {
                    set_loading(&l, true);
                    if let Some(core) = sender {
                        emit_state(&a, &l, &p, &core);
                    }
                    Ok(())
                })),
                &mut token,
            )?;
            let (a, l, p) = (app.clone(), label.clone(), pane.clone());
            core.add_NavigationCompleted(
                &NavigationCompletedEventHandler::create(Box::new(move |sender, _| {
                    set_loading(&l, false);
                    if let Some(core) = sender {
                        emit_state(&a, &l, &p, &core);
                    }
                    Ok(())
                })),
                &mut token,
            )?;
            let (a, l, p) = (app.clone(), label.clone(), pane.clone());
            core.add_SourceChanged(
                &SourceChangedEventHandler::create(Box::new(move |sender, _| {
                    if let Some(core) = sender {
                        emit_state(&a, &l, &p, &core);
                    }
                    Ok(())
                })),
                &mut token,
            )?;
            let (a, l, p) = (app.clone(), label.clone(), pane.clone());
            core.add_HistoryChanged(
                &HistoryChangedEventHandler::create(Box::new(move |sender, _| {
                    if let Some(core) = sender {
                        emit_state(&a, &l, &p, &core);
                    }
                    Ok(())
                })),
                &mut token,
            )?;
            let (a, l, p) = (app.clone(), label.clone(), pane.clone());
            core.add_DocumentTitleChanged(
                &DocumentTitleChangedEventHandler::create(Box::new(move |sender, _| {
                    if let Some(core) = sender {
                        emit_state(&a, &l, &p, &core);
                    }
                    Ok(())
                })),
                &mut token,
            )?;

            let (a, l, p) = (app.clone(), label.clone(), pane.clone());
            controller.add_GotFocus(
                &FocusChangedEventHandler::create(Box::new(move |_, _| {
                    if let Some(v) = VIEWS.lock().get_mut(&l) {
                        v.focused = true;
                    }
                    let _ = a.emit_to(MAIN, EVT_FOCUS, ViewPane { pane_id: p.clone() });
                    Ok(())
                })),
                &mut token,
            )?;
            let l = label.clone();
            controller.add_LostFocus(
                &FocusChangedEventHandler::create(Box::new(move |_, _| {
                    if let Some(v) = VIEWS.lock().get_mut(&l) {
                        v.focused = false;
                    }
                    Ok(())
                })),
                &mut token,
            )?;

            let (a, p) = (app, pane);
            controller.add_AcceleratorKeyPressed(
                &AcceleratorKeyPressedEventHandler::create(Box::new(move |_, args| {
                    let Some(args) = args else { return Ok(()) };
                    let mut kind = COREWEBVIEW2_KEY_EVENT_KIND::default();
                    args.KeyEventKind(&mut kind)?;
                    if kind != COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN && kind != COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN {
                        return Ok(());
                    }
                    let mut vk = 0u32;
                    args.VirtualKey(&mut vk)?;
                    let mut status = COREWEBVIEW2_PHYSICAL_KEY_STATUS::default();
                    args.PhysicalKeyStatus(&mut status)?;
                    let Some(combo) = key_combo(vk, status.ScanCode, modifiers()) else { return Ok(()) };
                    if !SHORTCUTS.read().contains(&combo) {
                        return Ok(());
                    }
                    // Handled early (the docs ask for it): neither the page nor WebView2's own
                    // accelerators see the key.
                    args.SetHandled(true)?;
                    let _ = a.emit_to(MAIN, EVT_SHORTCUT, ViewShortcut { pane_id: p.clone(), combo, repeat: status.WasKeyDown.as_bool() });
                    Ok(())
                })),
                &mut token,
            )?;
        }
        Ok(())
    }

    pub fn set_bounds(app: &AppHandle, pane_id: &str, rect: Option<&ViewRect>, vis: Visibility) -> AppResult<()> {
        let (label, wv) = view(app, pane_id)?;
        let phys = rect.map(|r| physical_rect(r).ok_or_else(|| AppError::Invalid("Invalid bounds".into()))).transpose()?;
        let (was_shown, was_parked, had_focus) =
            VIEWS.lock().get(&label).map(|v| (v.shown, v.parked, v.focused)).unwrap_or((false, false, false));
        if let Some(r) = phys {
            wv.set_bounds(Rect { position: PhysicalPosition::new(r.x, r.y).into(), size: PhysicalSize::new(r.width, r.height).into() })
                .map_err(other)?;
        }
        match vis {
            Visibility::Shown => {
                if phys.is_none() {
                    return Err(AppError::Invalid("A shown view needs bounds".into()));
                }
                if !was_shown {
                    wv.show().map_err(other)?;
                }
                if was_parked {
                    set_memory_low(&wv, false);
                }
            }
            Visibility::Occluded | Visibility::Parked => {
                if was_shown {
                    wv.hide().map_err(other)?;
                    // A hidden view keeps keyboard focus otherwise, and app shortcuts stop working.
                    if had_focus {
                        focus_main(app);
                    }
                }
                let park = vis == Visibility::Parked;
                if park != was_parked {
                    set_memory_low(&wv, park);
                }
            }
        }
        if let Some(v) = VIEWS.lock().get_mut(&label) {
            v.shown = vis == Visibility::Shown;
            v.parked = vis == Visibility::Parked;
        }
        Ok(())
    }

    /// `MemoryUsageTargetLevel` Low while a pane is off screen (WebView2 performance guidance).
    fn set_memory_low(wv: &Webview, low: bool) {
        let level = if low { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW } else { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL };
        let _ = wv.with_webview(move |pw| {
            // SAFETY: UI thread, live controller; ICoreWebView2_19 is optional (older runtimes skip this).
            unsafe {
                if let Ok(core) = pw.controller().CoreWebView2() {
                    if let Ok(c19) = core.cast::<ICoreWebView2_19>() {
                        let _ = c19.SetMemoryUsageTargetLevel(level);
                    }
                }
            }
        });
    }

    pub fn navigate(app: &AppHandle, pane_id: &str, action: NavAction) -> AppResult<()> {
        let (_, wv) = view(app, pane_id)?;
        match action {
            NavAction::Url { url } => {
                let u = page_url(&url, crate::browser::dev_url(app).as_ref())?;
                wv.navigate(u).map_err(other)
            }
            NavAction::Reload => wv.reload().map_err(other),
            step => wv
                .with_webview(move |pw| {
                    // SAFETY: UI thread, live controller.
                    unsafe {
                        if let Ok(core) = pw.controller().CoreWebView2() {
                            let _ = match step {
                                NavAction::Back => core.GoBack(),
                                NavAction::Forward => core.GoForward(),
                                _ => core.Stop(),
                            };
                        }
                    }
                })
                .map_err(other),
        }
    }

    pub fn focus(app: &AppHandle, pane_id: &str) -> AppResult<()> {
        let (_, wv) = view(app, pane_id)?;
        wv.set_focus().map_err(other)
    }

    pub fn blur(app: &AppHandle) {
        let any = VIEWS.lock().values().any(|v| v.focused);
        if any {
            focus_main(app);
        }
    }

    pub fn close(app: &AppHandle, pane_id: &str) -> AppResult<bool> {
        let label = label_of(pane_id)?;
        let had_focus = VIEWS.lock().remove(&label).is_some_and(|v| v.focused);
        let Some(wv) = app.get_webview(&label) else { return Ok(false) };
        let closed = wv.close().is_ok();
        if had_focus {
            focus_main(app);
        }
        Ok(closed)
    }

    pub fn retain(app: &AppHandle, keep: &[String]) -> u32 {
        let mut n = 0;
        for (label, _) in app.webviews() {
            let Some(pane) = pane_of_label(&label) else { continue };
            if !keep.iter().any(|k| k == pane) && close(app, pane).unwrap_or(false) {
                n += 1;
            }
        }
        VIEWS.lock().retain(|label, _| pane_of_label(label).is_some_and(|p| keep.iter().any(|k| k == p)));
        n
    }

    pub fn set_shortcuts(combos: Vec<String>) {
        *SHORTCUTS.write() = combos.into_iter().collect();
    }

    #[cfg(debug_assertions)]
    pub fn devtools(app: &AppHandle, pane_id: &str) -> AppResult<()> {
        let (_, wv) = view(app, pane_id)?;
        wv.open_devtools();
        Ok(())
    }

    pub fn forget_all() {
        VIEWS.lock().clear();
        CREATING.lock().clear();
    }

    pub async fn snapshot(app: &AppHandle, pane_id: &str) -> AppResult<Vec<u8>> {
        let (_, wv) = view(app, pane_id)?;
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        wv.with_webview(move |pw| {
            // SAFETY: UI thread, live controller.
            if let Err(e) = unsafe { capture(&pw.controller(), tx) } {
                tracing::debug!(error = %e, "browser view snapshot failed");
            }
        })
        .map_err(other)?;
        let bytes = tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(SNAPSHOT_TIMEOUT).unwrap_or_default())
            .await
            .unwrap_or_default();
        Ok(bytes)
    }

    unsafe fn capture(controller: &ICoreWebView2Controller, tx: mpsc::Sender<Vec<u8>>) -> windows_core::Result<()> {
        // SAFETY: UI thread; the stream lives until the completion handler has read it.
        unsafe {
            let core = controller.CoreWebView2()?;
            let stream = SHCreateMemStream(None).ok_or_else(|| windows_core::Error::from_hresult(windows_core::HRESULT(0x8007000Eu32 as i32)))?;
            let reader = stream.clone();
            let handler = CapturePreviewCompletedHandler::create(Box::new(move |res| {
                let bytes = if res.is_ok() { read_stream(&reader).unwrap_or_default() } else { Vec::new() };
                let _ = tx.send(bytes);
                Ok(())
            }));
            core.CapturePreview(COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_JPEG, &stream, &handler)
        }
    }

    unsafe fn read_stream(s: &IStream) -> windows_core::Result<Vec<u8>> {
        // SAFETY: reads into a local buffer of the size passed.
        unsafe {
            s.Seek(0, STREAM_SEEK_SET, None)?;
            let mut out = Vec::new();
            let mut buf = vec![0u8; 64 * 1024];
            loop {
                let mut read = 0u32;
                s.Read(buf.as_mut_ptr().cast(), buf.len() as u32, Some(&mut read)).ok()?;
                if read == 0 {
                    break;
                }
                out.extend_from_slice(&buf[..read as usize]);
                if out.len() > MAX_SNAPSHOT {
                    return Ok(Vec::new());
                }
            }
            Ok(out)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels() {
        let id = "3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b";
        assert_eq!(view_label(id).as_deref(), Some("bv-3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b"));
        assert_eq!(pane_of_label(&view_label(id).unwrap()), Some(id));
        for bad in ["", "../x", "a b", "main", "x/y", "é", &"a".repeat(65)] {
            assert!(view_label(bad).is_none(), "{bad:?}");
        }
        assert_eq!(pane_of_label("main"), None);
        assert_eq!(pane_of_label("browser-abc"), None);
        assert_eq!(pane_of_label("bv-"), None);
        assert_eq!(pane_of_label("bv-a/b"), None);
    }

    #[test]
    fn bounds() {
        let r = |x, y, w, h, s| ViewRect { x, y, width: w, height: h, scale: s };
        assert_eq!(physical_rect(&r(10.0, 20.0, 300.0, 200.0, 1.0)), Some(PhysRect { x: 10, y: 20, width: 300, height: 200 }));
        // 125 %: edges rounded, so two adjacent boxes share an edge exactly.
        let a = physical_rect(&r(0.0, 0.0, 100.3, 50.0, 1.25)).unwrap();
        let b = physical_rect(&r(100.3, 0.0, 100.0, 50.0, 1.25)).unwrap();
        assert_eq!(a.x + a.width as i32, b.x);
        assert_eq!(physical_rect(&r(10.0, 10.0, 0.0, 0.0, 2.0)), Some(PhysRect { x: 20, y: 20, width: 0, height: 0 }));
        for bad in [
            r(f64::NAN, 0.0, 1.0, 1.0, 1.0),
            r(0.0, 0.0, f64::INFINITY, 1.0, 1.0),
            r(0.0, 0.0, -1.0, 1.0, 1.0),
            r(0.0, 0.0, 1.0, 1.0, 0.0),
            r(0.0, 0.0, 1.0, 1.0, 9.0),
            r(1e9, 0.0, 1.0, 1.0, 1.0),
            r(0.0, 0.0, 1e9, 1.0, 1.0),
        ] {
            assert!(physical_rect(&bad).is_none(), "{bad:?}");
        }
    }

    #[test]
    fn urls_and_navigation() {
        let dev = Url::parse("http://localhost:1420").unwrap();
        let u = |s: &str| Url::parse(s).unwrap();
        assert_eq!(page_url("https://github.com", Some(&dev)).unwrap().as_str(), "https://github.com/");
        assert!(page_url("file:///C:/docs/a.html", None).is_ok());
        assert!(page_url("http://localhost:5173/", Some(&dev)).is_ok());
        for bad in ["http://tauri.localhost/", "http://localhost:1420/", "javascript:alert(1)", "data:text/html,x", "https://u:p@x.com/", "about:blank"] {
            assert!(page_url(bad, Some(&dev)).is_err(), "{bad:?}");
        }
        assert!(view_navigation_allowed(&u("https://accounts.google.com/x"), Some(&dev)));
        assert!(view_navigation_allowed(&u("about:blank"), None));
        assert!(view_navigation_allowed(&u("blob:https://example.com/0f1e"), None));
        assert!(!view_navigation_allowed(&u("blob:http://tauri.localhost/0f1e"), None));
        assert!(!view_navigation_allowed(&u("about:srcdoc"), None));
        assert!(!view_navigation_allowed(&u("http://ipc.localhost/x"), None));
        assert!(!view_navigation_allowed(&u("http://localhost:1420/"), Some(&dev)));
        assert!(!view_navigation_allowed(&u("data:text/html,x"), None));
        assert!(!view_navigation_allowed(&u("mailto:a@b.c"), None));
        assert_eq!(new_window_url(&u("https://example.com/a"), None).as_deref(), Some("https://example.com/a"));
        assert!(new_window_url(&u("file:///C:/a.html"), None).is_none());
        assert!(new_window_url(&u("http://tauri.localhost/"), None).is_none());
        assert!(new_window_url(&u("https://u:p@example.com/"), None).is_none());
    }

    #[test]
    fn nav_actions_deserialize() {
        let a: NavAction = serde_json::from_str(r#"{"kind":"url","url":"https://x.com"}"#).unwrap();
        assert_eq!(a, NavAction::Url { url: "https://x.com".into() });
        let b: NavAction = serde_json::from_str(r#"{"kind":"back"}"#).unwrap();
        assert_eq!(b, NavAction::Back);
        assert!(serde_json::from_str::<NavAction>(r#"{"kind":"eval"}"#).is_err());
        let v: Visibility = serde_json::from_str(r#""parked""#).unwrap();
        assert_eq!(v, Visibility::Parked);
        let r: ViewRect = serde_json::from_str(r#"{"x":1,"y":2,"width":3,"height":4,"scale":1.5}"#).unwrap();
        assert_eq!(r.scale, 1.5);
    }

    #[test]
    fn key_combos() {
        let m = |ctrl, alt, shift| Mods { ctrl, alt, shift, meta: false };
        assert_eq!(key_combo(0x50, 0x19, m(true, false, true)).as_deref(), Some("ctrl+shift+p"));
        assert_eq!(key_combo(0x31, 0x02, m(false, true, false)).as_deref(), Some("alt+1"));
        assert_eq!(key_combo(0x09, 0x0F, m(true, false, true)).as_deref(), Some("ctrl+shift+tab"));
        assert_eq!(key_combo(0x22, 0x51, m(true, false, true)).as_deref(), Some("ctrl+shift+pagedown"));
        assert_eq!(key_combo(0xBC, 0x33, m(true, false, false)).as_deref(), Some("ctrl+,"));
        assert_eq!(key_combo(0xBB, 0x0D, m(true, false, true)).as_deref(), Some("ctrl+shift+="));
        // German layout: the key right of 0 sends VK_OEM_4 ("ß") at scan 0x0C; the position wins.
        assert_eq!(key_combo(0xDB, 0x0C, m(true, false, true)).as_deref(), Some("ctrl+shift+-"));
        // Unknown scan code: the US meaning of the virtual key.
        assert_eq!(key_combo(0xC0, 0x00, m(true, false, true)).as_deref(), Some("ctrl+shift+`"));
        assert_eq!(key_combo(0x74, 0x3F, Mods::default()).as_deref(), Some("f5"));
        assert_eq!(key_combo(0x87, 0, Mods::default()).as_deref(), Some("f24"));
        assert_eq!(key_combo(0x10, 0x2A, m(false, false, true)), None, "modifier alone");
        assert_eq!(key_combo(0x5B, 0, Mods::default()), None, "Windows key alone");
        assert_eq!(key_combo(0x41, 0x1E, Mods { ctrl: true, alt: true, shift: true, meta: true }).as_deref(), Some("ctrl+alt+shift+meta+a"));
        assert!(valid_combo("ctrl+shift+p"));
        assert!(valid_combo("ctrl++"));
        assert!(!valid_combo(""));
        assert!(!valid_combo("ctrl+ p"));
        assert!(!valid_combo(&"a".repeat(49)));
    }

    #[test]
    fn download_targets() {
        let root = Path::new("home");
        let dl = root.join("Downloads");
        let dl = dl.as_path();
        let none = |_: &Path| false;
        let s = dl.join("report.pdf");
        assert_eq!(download_target(&s, dl, none), Some(s.clone()), "already in Downloads");
        let elsewhere = root.join("Temp").join("report.pdf");
        assert_eq!(download_target(&elsewhere, dl, none), Some(dl.join("report.pdf")));
        let taken = |p: &Path| p == dl.join("report.pdf") || p == dl.join("report (1).pdf");
        assert_eq!(download_target(&elsewhere, dl, taken), Some(dl.join("report (2).pdf")));
        assert_eq!(download_target(Path::new("/"), dl, none), None);
    }

    #[test]
    fn titles_and_urls() {
        assert_eq!(clean_title("  Docs\u{7}  "), "Docs");
        assert_eq!(clean_title(&"x".repeat(300)).len(), 200);
        let long = format!("https://example.com/{}", "é".repeat(MAX_REPORTED_URL));
        let clipped = clip_url(long);
        assert!(clipped.len() <= MAX_REPORTED_URL);
    }

    #[test]
    fn shortcut_list_is_validated() {
        assert!(browser_view_set_shortcuts(vec!["ctrl+shift+p".into(), "alt+1".into()]).is_ok());
        assert!(browser_view_set_shortcuts(vec!["bad combo".into()]).is_err());
        assert!(browser_view_set_shortcuts(vec!["a".into(); MAX_SHORTCUTS + 1]).is_err());
        assert!(browser_view_set_shortcuts(Vec::new()).is_ok());
    }
}
