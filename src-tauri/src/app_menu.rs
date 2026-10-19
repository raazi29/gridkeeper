//! The native application menu on macOS: App, Edit, View, Window, Help.
//!
//! Without a menu, Tauri installs its own default on macOS; this one replaces it with a menu that
//! fits a terminal workspace. The menu is described by [`MENU`] (plain data, unit-tested on every OS)
//! and built by `build` (macOS only). Windows and Linux get no menu at all, as before.
//!
//! How it avoids double actions with the web UI's own key handling:
//! - Edit's Undo / Redo / Cut / Copy / Paste / Select All are *native* (predefined) items. AppKit sends
//!   `undo:` / `copy:` / `paste:` ... down the responder chain to the WKWebView, which runs the editing
//!   command in the focused element (an `<input>`, or xterm's helper textarea, which turns it into a
//!   DOM `copy` / `paste` event). These items never emit app events. Without them, ⌘C / ⌘V / ⌘A / ⌘Z
//!   do nothing in WKWebView text fields.
//! - WKWebView gives the page the first look at a ⌘ key: the menu sees the key equivalent only if the
//!   page did not `preventDefault()` the keydown. In a terminal, `terminalKeys.ts` / `registry.ts`
//!   handle ⌘C (with a selection) and ⌘V themselves and call `preventDefault()`, so Edit › Paste does
//!   not run on top; `registry.ts` also swallows a native paste event that arrives within 1 s of its
//!   own ⌘V. Clicking Edit › Paste with the mouse pastes once, through the same paste guard.
//! - Custom items ([`Item::Command`]) emit [`crate::types::EVT_NATIVE_MENU`] to the main webview, which
//!   runs the command from the palette's registry (`src/lib/nativeMenu.ts`). They carry no
//!   accelerator, except Settings… ⌘, (the macOS convention, also the default key binding), and the
//!   frontend drops a menu command that a key binding ran within the last 500 ms, so a shortcut
//!   never runs twice even if both paths see the key.
//! - Close Window (⌘W) on the main window hides it instead of quitting (`lib.rs`), so a reflexive ⌘W
//!   never stops every agent; the Dock icon or Window › Main Window shows it again. ⌘Q quits and stops
//!   all sessions, like closing the window on Windows.

/// Native (predefined) items: AppKit selectors, no app event.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Native {
    About,
    Services,
    Hide,
    HideOthers,
    ShowAll,
    Quit,
    Undo,
    Redo,
    Cut,
    Copy,
    Paste,
    SelectAll,
    Fullscreen,
    Minimize,
    Zoom,
    CloseWindow,
    BringAllToFront,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Item {
    Native(Native),
    /// Runs a frontend command (an id from `src/actions/commands.ts`). `accelerator` uses Tauri's
    /// syntax (`CmdOrCtrl+,`).
    Command { id: &'static str, label: &'static str, accelerator: Option<&'static str> },
    /// Opens a web page in the default browser.
    Link { id: &'static str, label: &'static str, url: &'static str },
    /// Shows and focuses the main window (it may be hidden after ⌘W).
    ShowMain,
    Separator,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    App,
    Edit,
    View,
    Window,
    Help,
}

pub struct Submenu {
    pub role: Role,
    /// Ignored for [`Role::App`] (macOS shows the app name).
    pub title: &'static str,
    pub items: &'static [Item],
}

/// Menu id prefix of [`Item::Command`] items: `cmd:<command id>`.
pub const COMMAND_PREFIX: &str = "cmd:";
/// Menu id prefix of [`Item::Link`] items: `link:<id>`.
pub const LINK_PREFIX: &str = "link:";
/// Menu id of [`Item::ShowMain`].
pub const SHOW_MAIN_ID: &str = "window:main";

pub const REPO_URL: &str = "https://github.com/raazi29/gridkeeper";

use Item::{Command, Link, Native as N, Separator, ShowMain};

pub const MENU: &[Submenu] = &[
    Submenu {
        role: Role::App,
        title: "Gridkeeper",
        items: &[
            N(Native::About),
            Separator,
            Command { id: "view.settings", label: "Settings…", accelerator: Some("CmdOrCtrl+,") },
            Command { id: "view.profiles", label: "Accounts…", accelerator: None },
            Separator,
            N(Native::Services),
            Separator,
            N(Native::Hide),
            N(Native::HideOthers),
            N(Native::ShowAll),
            Separator,
            N(Native::Quit),
        ],
    },
    Submenu {
        role: Role::Edit,
        title: "Edit",
        items: &[
            N(Native::Undo),
            N(Native::Redo),
            Separator,
            N(Native::Cut),
            N(Native::Copy),
            N(Native::Paste),
            N(Native::SelectAll),
            Separator,
            Command { id: "terminal.find", label: "Find in Terminal…", accelerator: None },
        ],
    },
    Submenu {
        role: Role::View,
        title: "View",
        items: &[
            Command { id: "view.palette", label: "Command Palette…", accelerator: None },
            Separator,
            Command { id: "view.toggleSidebar", label: "Toggle Sidebar", accelerator: None },
            Command { id: "view.toggleInspector", label: "Toggle Inspector", accelerator: None },
            Command { id: "view.mission", label: "Mission Control", accelerator: None },
            Command { id: "view.fleet", label: "Fleet", accelerator: None },
            Command { id: "view.changes", label: "Changes", accelerator: None },
            Command { id: "view.toggleDiagnostics", label: "Diagnostics", accelerator: None },
            Separator,
            Command { id: "terminal.zoomIn", label: "Zoom In", accelerator: None },
            Command { id: "terminal.zoomOut", label: "Zoom Out", accelerator: None },
            Command { id: "terminal.zoomReset", label: "Actual Size", accelerator: None },
            Separator,
            N(Native::Fullscreen),
        ],
    },
    Submenu {
        role: Role::Window,
        title: "Window",
        items: &[
            N(Native::Minimize),
            N(Native::Zoom),
            Separator,
            ShowMain,
            Separator,
            N(Native::CloseWindow),
            N(Native::BringAllToFront),
        ],
    },
    Submenu {
        role: Role::Help,
        title: "Help",
        items: &[
            Link { id: "readme", label: "Gridkeeper on GitHub", url: REPO_URL },
            Link { id: "releases", label: "Release Notes", url: "https://github.com/raazi29/gridkeeper/releases" },
            Link { id: "issues", label: "Report an Issue…", url: "https://github.com/raazi29/gridkeeper/issues/new/choose" },
        ],
    },
];

/// What a click on a menu id means (the native items never reach the app).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    RunCommand(&'static str),
    OpenUrl(&'static str),
    ShowMain,
}

/// Map a menu event id back to its item. `None` for ids that are not ours.
pub fn action_for(id: &str) -> Option<Action> {
    if id == SHOW_MAIN_ID {
        return Some(Action::ShowMain);
    }
    MENU.iter().flat_map(|s| s.items.iter()).find_map(|item| match *item {
        Command { id: cmd, .. } if id.strip_prefix(COMMAND_PREFIX) == Some(cmd) => Some(Action::RunCommand(cmd)),
        Link { id: link, url, .. } if id.strip_prefix(LINK_PREFIX) == Some(link) => Some(Action::OpenUrl(url)),
        _ => None,
    })
}

#[cfg(target_os = "macos")]
pub use mac::{build, handle_event, show_main};

#[cfg(target_os = "macos")]
mod mac {
    use tauri::menu::{AboutMetadata, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu as TauriSubmenu};
    use tauri::menu::{HELP_SUBMENU_ID, WINDOW_SUBMENU_ID};
    use tauri::{AppHandle, Emitter, Manager, Runtime};

    use super::*;

    fn about_metadata<R: Runtime>(app: &AppHandle<R>) -> AboutMetadata<'static> {
        let info = app.package_info();
        AboutMetadata {
            name: Some(info.name.clone()),
            version: Some(info.version.to_string()),
            comments: Some("Multi-agent terminal workspace".into()),
            license: Some("MIT".into()),
            website: Some(REPO_URL.into()),
            website_label: Some("github.com/raazi29/gridkeeper".into()),
            ..Default::default()
        }
    }

    fn append_native<R: Runtime>(app: &AppHandle<R>, menu: &TauriSubmenu<R>, n: Native) -> tauri::Result<()> {
        let item = match n {
            Native::About => PredefinedMenuItem::about(app, None, Some(about_metadata(app)))?,
            Native::Services => PredefinedMenuItem::services(app, None)?,
            Native::Hide => PredefinedMenuItem::hide(app, None)?,
            Native::HideOthers => PredefinedMenuItem::hide_others(app, None)?,
            Native::ShowAll => PredefinedMenuItem::show_all(app, None)?,
            Native::Quit => PredefinedMenuItem::quit(app, None)?,
            Native::Undo => PredefinedMenuItem::undo(app, None)?,
            Native::Redo => PredefinedMenuItem::redo(app, None)?,
            Native::Cut => PredefinedMenuItem::cut(app, None)?,
            Native::Copy => PredefinedMenuItem::copy(app, None)?,
            Native::Paste => PredefinedMenuItem::paste(app, None)?,
            Native::SelectAll => PredefinedMenuItem::select_all(app, None)?,
            Native::Fullscreen => PredefinedMenuItem::fullscreen(app, None)?,
            Native::Minimize => PredefinedMenuItem::minimize(app, None)?,
            Native::Zoom => PredefinedMenuItem::maximize(app, Some("Zoom"))?,
            Native::CloseWindow => PredefinedMenuItem::close_window(app, None)?,
            Native::BringAllToFront => PredefinedMenuItem::bring_all_to_front(app, None)?,
        };
        menu.append(&item)
    }

    /// The app menu from [`MENU`].
    pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
        let menu = Menu::new(app)?;
        for sub in MENU {
            let title = match sub.role {
                Role::App => app.package_info().name.clone(),
                _ => sub.title.to_string(),
            };
            let submenu = match sub.role {
                Role::Window => TauriSubmenu::with_id(app, WINDOW_SUBMENU_ID, &title, true)?,
                Role::Help => TauriSubmenu::with_id(app, HELP_SUBMENU_ID, &title, true)?,
                _ => TauriSubmenu::new(app, &title, true)?,
            };
            for item in sub.items {
                match *item {
                    Item::Native(n) => append_native(app, &submenu, n)?,
                    Item::Separator => submenu.append(&PredefinedMenuItem::separator(app)?)?,
                    Item::Command { id, label, accelerator } => {
                        let item = MenuItem::with_id(app, format!("{COMMAND_PREFIX}{id}"), label, true, accelerator)?;
                        submenu.append(&item)?;
                    }
                    Item::Link { id, label, .. } => {
                        let item = MenuItem::with_id(app, format!("{LINK_PREFIX}{id}"), label, true, None::<&str>)?;
                        submenu.append(&item)?;
                    }
                    Item::ShowMain => {
                        let item = MenuItem::with_id(app, SHOW_MAIN_ID, "Main Window", true, None::<&str>)?;
                        submenu.append(&item)?;
                    }
                }
            }
            menu.append(&submenu)?;
        }
        Ok(menu)
    }

    /// Show, unminimize and focus the main window (hidden by ⌘W or minimized).
    pub fn show_main<R: Runtime>(app: &AppHandle<R>) {
        if let Some(w) = app.get_webview_window(crate::webview_guard::MAIN) {
            let _ = w.show();
            let _ = w.unminimize();
            let _ = w.set_focus();
        }
    }

    pub fn handle_event<R: Runtime>(app: &AppHandle<R>, event: &MenuEvent) {
        match action_for(event.id().as_ref()) {
            Some(Action::RunCommand(command)) => {
                show_main(app);
                let payload = crate::types::NativeMenuCommand { command: command.to_string() };
                if let Err(e) = app.emit_to(crate::webview_guard::MAIN, crate::types::EVT_NATIVE_MENU, payload) {
                    tracing::warn!(error = %e, "could not send the menu command to the window");
                }
            }
            Some(Action::OpenUrl(url)) => {
                use tauri_plugin_opener::OpenerExt;
                if let Err(e) = app.opener().open_url(url, None::<&str>) {
                    tracing::warn!(error = %e, "could not open the help link");
                }
            }
            Some(Action::ShowMain) => show_main(app),
            None => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn all_items() -> impl Iterator<Item = &'static Item> {
        MENU.iter().flat_map(|s| s.items.iter())
    }

    #[test]
    fn has_the_standard_macos_menus_in_order() {
        let roles: Vec<Role> = MENU.iter().map(|s| s.role).collect();
        assert_eq!(roles, [Role::App, Role::Edit, Role::View, Role::Window, Role::Help]);
        let app = &MENU[0];
        for n in [Native::About, Native::Hide, Native::HideOthers, Native::ShowAll, Native::Quit] {
            assert!(app.items.contains(&Item::Native(n)), "App menu lacks {n:?}");
        }
        let window = &MENU[3];
        for n in [Native::Minimize, Native::Zoom, Native::CloseWindow] {
            assert!(window.items.contains(&Item::Native(n)), "Window menu lacks {n:?}");
        }
        assert!(window.items.contains(&Item::ShowMain));
    }

    /// Clipboard and undo must go through the native responder chain (WebKit fires the DOM events),
    /// never through an app event that would run beside the terminal's own ⌘C / ⌘V handling.
    #[test]
    fn edit_items_are_native() {
        let edit = MENU.iter().find(|s| s.role == Role::Edit).unwrap();
        for n in [Native::Undo, Native::Redo, Native::Cut, Native::Copy, Native::Paste, Native::SelectAll] {
            assert!(edit.items.contains(&Item::Native(n)), "Edit menu lacks native {n:?}");
        }
        for item in all_items() {
            if let Item::Command { id, label, .. } = item {
                let l = label.to_ascii_lowercase();
                for word in ["copy", "paste", "cut", "undo", "redo", "select all"] {
                    assert!(!l.contains(word), "custom item {id} looks like a clipboard / undo action: {label}");
                }
            }
        }
    }

    /// Accelerators on custom items run in addition to the page's key handling whenever the page lets
    /// the key through, so only an explicit allowlist may have one, and never a key the terminal or
    /// the standard Edit / App / Window items own.
    #[test]
    fn custom_accelerators_are_allowlisted_and_never_terminal_keys() {
        const ALLOWED: &[(&str, &str)] = &[("view.settings", "CmdOrCtrl+,")];
        const RESERVED: &[&str] = &["c", "v", "x", "a", "z", "q", "h", "m", "w", "tab", "space", "`"];
        for item in all_items() {
            let Item::Command { id, accelerator: Some(acc), .. } = item else { continue };
            assert!(ALLOWED.contains(&(*id, *acc)), "{id} has an accelerator ({acc}) that is not allowlisted");
            let lower = acc.to_ascii_lowercase();
            let parts: Vec<&str> = lower.split('+').collect();
            let key = *parts.last().unwrap();
            assert!(!parts.contains(&"ctrl") && !parts.contains(&"control"), "{id}: ⌃ combos belong to the terminal");
            assert!(!RESERVED.contains(&key), "{id}: {acc} collides with a system / Edit menu key");
        }
    }

    #[test]
    fn ids_are_unique_and_round_trip() {
        let mut seen = HashSet::new();
        for item in all_items() {
            let id = match *item {
                Item::Command { id, .. } => format!("{COMMAND_PREFIX}{id}"),
                Item::Link { id, .. } => format!("{LINK_PREFIX}{id}"),
                Item::ShowMain => SHOW_MAIN_ID.to_string(),
                _ => continue,
            };
            assert!(seen.insert(id.clone()), "duplicate menu id {id}");
            let expected = match *item {
                Item::Command { id, .. } => Action::RunCommand(id),
                Item::Link { url, .. } => Action::OpenUrl(url),
                _ => Action::ShowMain,
            };
            assert_eq!(action_for(&id), Some(expected));
        }
        assert_eq!(action_for("cmd:not.a.command"), None);
        assert_eq!(action_for("view.settings"), None);
        assert_eq!(action_for(""), None);
    }

    #[test]
    fn links_point_to_the_project() {
        for item in all_items() {
            if let Item::Link { url, .. } = item {
                assert!(url.starts_with(REPO_URL), "{url}");
            }
        }
    }

    /// The frontend runs whatever command id arrives; make sure each one exists there.
    #[test]
    fn command_ids_exist_in_the_frontend_registry() {
        let sources = [
            include_str!("../../src/actions/commands.ts"),
            include_str!("../../src/actions/terminalCommands.ts"),
            include_str!("../../src/actions/experienceCommands.ts"),
        ]
        .concat();
        for item in all_items() {
            if let Item::Command { id, .. } = item {
                assert!(sources.contains(&format!("id: \"{id}\"")), "command {id} is not registered in src/actions");
            }
        }
    }
}
