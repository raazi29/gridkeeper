//! Sandbox instances: `GRIDKEEPER_SANDBOX=<name>` runs a build next to the live app without touching it.
//!
//! A sandbox skips the single-instance lock, keeps its data in `<app config dir>\sandboxes\<name>`
//! (workspaces, profiles, logs; the legacy Altera migration never runs), uses its own WebView2
//! profile on Windows (`WEBVIEW2_USER_DATA_FOLDER=<data dir>\webview`, unless already set; macOS /
//! Linux share the WebKit profile with a normal instance) and says so in the
//! window title. An invalid name refuses to start, so a typo never falls back to the live data.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

pub const ENV: &str = "GRIDKEEPER_SANDBOX";
pub const WEBVIEW2_ENV: &str = "WEBVIEW2_USER_DATA_FOLDER";
pub const MAX_NAME_LEN: usize = 32;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Sandbox {
    pub name: String,
    pub data_dir: PathBuf,
    /// Whether this process set `WEBVIEW2_USER_DATA_FOLDER` itself (then children don't inherit it).
    pub set_webview_folder: bool,
}

static CURRENT: OnceLock<Sandbox> = OnceLock::new();

/// The active sandbox, if this process is one.
pub fn current() -> Option<&'static Sandbox> {
    CURRENT.get()
}

pub fn name() -> Option<&'static str> {
    current().map(|s| s.name.as_str())
}

/// `[a-z0-9-]{1,32}`.
pub fn validate_name(raw: &str) -> Result<&str, String> {
    let ok = !raw.is_empty()
        && raw.len() <= MAX_NAME_LEN
        && raw.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
    if ok {
        Ok(raw)
    } else {
        Err(format!(
            "{ENV}={raw:?} is not a valid sandbox name. Use 1 to {MAX_NAME_LEN} lowercase letters, digits \
             or '-' (for example {ENV}=test). The app did not start, so your normal data was not touched."
        ))
    }
}

/// `<base>\sandboxes\<name>`, where `base` is the normal app config dir.
pub fn data_dir(base: &Path, name: &str) -> PathBuf {
    base.join("sandboxes").join(name)
}

pub fn webview_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("webview")
}

/// Parse the raw environment value. `None` = not a sandbox.
pub fn parse_env(raw: Option<OsString>) -> Result<Option<String>, String> {
    match raw {
        None => Ok(None),
        Some(v) => match v.to_str() {
            Some(s) => validate_name(s).map(|n| Some(n.to_string())),
            None => Err(format!("{ENV} is not valid Unicode. The app did not start.")),
        },
    }
}

/// Called first thing in `run()`, before the Tauri builder exists (still single-threaded).
/// `config_base` is the normal app config dir (`%APPDATA%\<identifier>`).
pub fn init_from_env(config_base: Option<PathBuf>) -> Result<Option<&'static Sandbox>, String> {
    let Some(name) = parse_env(std::env::var_os(ENV))? else {
        return Ok(None);
    };
    let base = config_base.ok_or_else(|| format!("{ENV} is set but the app data folder is unknown."))?;
    let data_dir = data_dir(&base, &name);
    // WebView2 only. On macOS / Linux the sandbox isolates the app data but shares the WebKit
    // profile (localStorage, cache) with a normal instance.
    let set_webview_folder = cfg!(windows) && std::env::var_os(WEBVIEW2_ENV).is_none_or(|v| v.is_empty());
    if set_webview_folder {
        let webview = webview_dir(&data_dir);
        std::fs::create_dir_all(&webview).map_err(|e| format!("Could not create {}: {e}", webview.display()))?;
        // SAFETY: called at the very start of `run()`, before Tauri, logging or any other thread
        // exists, so nothing reads the environment concurrently.
        unsafe { std::env::set_var(WEBVIEW2_ENV, &webview) };
    }
    let sandbox = Sandbox { name, data_dir, set_webview_folder };
    Ok(Some(CURRENT.get_or_init(|| sandbox)))
}

/// `Gridkeeper [sandbox: <name>]`.
pub fn window_title(base: &str, name: &str) -> String {
    format!("{base} [sandbox: {name}]")
}

/// Variables a sandbox must not pass on to its sessions' processes (a dev build started from a
/// sandbox terminal would otherwise share the sandbox's data and WebView2 profile).
pub fn child_env_remove() -> Vec<&'static str> {
    match current() {
        None => Vec::new(),
        Some(s) if s.set_webview_folder => vec![ENV, WEBVIEW2_ENV],
        Some(_) => vec![ENV],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_names() {
        for ok in ["a", "test", "ui-2", "0", "a-b-c", &"x".repeat(32)] {
            assert_eq!(validate_name(ok), Ok(ok), "{ok}");
        }
        for bad in ["", "Test", "my sandbox", "a_b", "a.b", "../x", "a/b", "a\\b", "ü", " a", "a\n", &"x".repeat(33)] {
            let e = validate_name(bad).unwrap_err();
            assert!(e.contains(ENV), "{e}");
        }
    }

    #[test]
    fn parses_env() {
        assert_eq!(parse_env(None), Ok(None));
        assert_eq!(parse_env(Some("ui".into())), Ok(Some("ui".to_string())));
        assert!(parse_env(Some("".into())).is_err(), "set-but-empty is refused, not ignored");
        assert!(parse_env(Some("UI".into())).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn derives_dirs_and_title_unix() {
        let base = Path::new("/home/u/.config/app.gridkeeper.desktop");
        let d = data_dir(base, "ui");
        assert_eq!(d, PathBuf::from("/home/u/.config/app.gridkeeper.desktop/sandboxes/ui"));
        assert_eq!(webview_dir(&d), PathBuf::from("/home/u/.config/app.gridkeeper.desktop/sandboxes/ui/webview"));
        assert!(d.starts_with(base) && d != base);
        assert_eq!(window_title("Gridkeeper", "ui"), "Gridkeeper [sandbox: ui]");
    }

    #[cfg(windows)]
    #[test]
    fn derives_dirs_and_title() {
        let base = Path::new(r"C:\Users\u\AppData\Roaming\app.gridkeeper.desktop");
        let d = data_dir(base, "ui");
        assert_eq!(d, PathBuf::from(r"C:\Users\u\AppData\Roaming\app.gridkeeper.desktop\sandboxes\ui"));
        assert_eq!(
            webview_dir(&d),
            PathBuf::from(r"C:\Users\u\AppData\Roaming\app.gridkeeper.desktop\sandboxes\ui\webview")
        );
        assert!(d.starts_with(base) && d != base);
        assert_eq!(window_title("Gridkeeper", "ui"), "Gridkeeper [sandbox: ui]");
    }

    #[test]
    fn not_a_sandbox_by_default() {
        // Tests never set GRIDKEEPER_SANDBOX / call init_from_env.
        assert!(current().is_none());
        assert!(child_env_remove().is_empty());
    }
}
