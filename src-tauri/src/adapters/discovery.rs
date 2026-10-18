//! Executable discovery shared by all adapters (and by `profiles::check_status`).
//!
//! macOS / Linux: PATH lookup through `which` and plain files; none of the shim handling below
//! applies (`classify` accepts any existing file, `via_cmd` is never set).
//!
//! Windows specifics handled here:
//! - npm installs put three shims in `%APPDATA%\npm`: `<name>` (sh script),
//!   `<name>.cmd` and `<name>.ps1`. A ConPTY child must be a real PE file, so
//!   we prefer a native `.exe`: either a sibling `<name>.exe`, or the `.exe`
//!   the `.cmd` shim forwards to (parsed from the shim text, which is a
//!   plain generated launcher — never a config or credential file).
//! - When only a `.cmd`/`.bat` exists, it is launched through
//!   `%SystemRoot%\System32\cmd.exe /d /c <shim> args...` (`/d` skips AutoRun).
//!   Known limitation: cmd.exe re-parses the command line, so arguments with
//!   cmd metacharacters are rejected (see `validate_cmd_args`), and a shim path
//!   containing spaces combined with quoted arguments is mangled by cmd's
//!   quote-stripping rule. Native executables have neither problem.

use std::path::{Path, PathBuf};

#[cfg(windows)]
use once_cell::sync::Lazy;
#[cfg(windows)]
use regex::Regex;

use crate::types::{AppError, AppResult};

/// A resolved program.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Executable {
    pub path: PathBuf,
    /// The program is a batch file and must be run via `cmd.exe /d /c`.
    pub via_cmd: bool,
}

impl Executable {
    pub fn native(path: PathBuf) -> Self {
        Self { path, via_cmd: false }
    }

    /// Program to spawn plus the arguments that must precede the adapter's own.
    pub fn program_and_prefix(&self) -> (PathBuf, Vec<String>) {
        if self.via_cmd {
            (
                cmd_exe(),
                vec!["/d".into(), "/c".into(), self.path.to_string_lossy().into_owned()],
            )
        } else {
            (self.path.clone(), Vec::new())
        }
    }
}

/// `%SystemRoot%\System32\cmd.exe` (not `%COMSPEC%`, which is user-controlled).
pub fn cmd_exe() -> PathBuf {
    let root = std::env::var_os("SystemRoot").unwrap_or_else(|| r"C:\Windows".into());
    PathBuf::from(root).join("System32").join("cmd.exe")
}

/// `%USERPROFILE%`, falling back to the known-folder lookup.
pub fn home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .filter(|p| p.is_dir())
        .or_else(dirs::home_dir)
}

/// `%LOCALAPPDATA%`.
pub fn local_app_data() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(PathBuf::from).or_else(dirs::data_local_dir)
}

#[cfg(windows)]
fn ext_lower(path: &Path) -> String {
    path.extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).unwrap_or_default()
}

#[cfg(windows)]
static SHIM_TARGET_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#"(?i)"%~?dp0%?\\?([^"%]+?\.exe)""#).expect("shim regex"));

/// The native `.exe` an npm-generated `.cmd` shim forwards to, if it exists.
#[cfg(windows)]
fn shim_target(cmd_path: &Path) -> Option<PathBuf> {
    let meta = std::fs::metadata(cmd_path).ok()?;
    if meta.len() > 64 * 1024 {
        return None;
    }
    let text = std::fs::read_to_string(cmd_path).ok()?;
    let rel = SHIM_TARGET_RE.captures(&text)?.get(1)?.as_str().trim_start_matches('\\');
    let target = cmd_path.parent()?.join(rel);
    target.is_file().then_some(target)
}

/// Turn an existing path into something launchable, preferring native executables
/// over shims. Returns `None` if nothing usable exists at/next to `path`.
#[cfg(windows)]
pub fn classify(path: &Path) -> Option<Executable> {
    let ext = ext_lower(path);
    match ext.as_str() {
        "exe" | "com" => path.is_file().then(|| Executable::native(path.to_path_buf())),
        "cmd" | "bat" => {
            if !path.is_file() {
                return None;
            }
            if let Some(target) = shim_target(path) {
                return Some(Executable::native(target));
            }
            let sibling = path.with_extension("exe");
            if sibling.is_file() {
                return Some(Executable::native(sibling));
            }
            Some(Executable { path: path.to_path_buf(), via_cmd: true })
        }
        "ps1" | "" | "sh" => {
            // npm's PowerShell / sh shims: look for a native or batch sibling.
            let base = if ext.is_empty() { path.to_path_buf() } else { path.with_extension("") };
            let exe = PathBuf::from(format!("{}.exe", base.display()));
            if exe.is_file() {
                return Some(Executable::native(exe));
            }
            let cmd = PathBuf::from(format!("{}.cmd", base.display()));
            classify(&cmd)
        }
        _ => path.is_file().then(|| Executable::native(path.to_path_buf())),
    }
}

/// macOS / Linux: any existing file is launchable as is (npm's `bin` entries are symlinks to
/// scripts with a shebang; there are no `.cmd` shims to unwrap). `which` already checked the
/// executable bit for PATH hits; an explicit path without it fails at spawn with a clear error.
#[cfg(not(windows))]
pub fn classify(path: &Path) -> Option<Executable> {
    path.is_file().then(|| Executable::native(path.to_path_buf()))
}

/// Look `name` up on PATH (PATHEXT-aware) and classify the hit.
pub fn which_exe(name: &str) -> Option<Executable> {
    let mut first_shim: Option<Executable> = None;
    for hit in which::which_all(name).ok()? {
        if let Some(exe) = classify(&hit) {
            if !exe.via_cmd {
                return Some(exe);
            }
            first_shim.get_or_insert(exe);
        }
    }
    first_shim
}

/// Resolve a user-supplied program (settings override or `SessionSpec.command`):
/// absolute/relative paths must exist; bare names are looked up on PATH.
pub fn resolve_user_program(program: &str) -> AppResult<Executable> {
    let program = program.trim().trim_matches('"');
    if program.is_empty() {
        return Err(AppError::Invalid("Executable path is empty".into()));
    }
    if program.contains('\0') {
        return Err(AppError::Invalid("Executable path contains a NUL character".into()));
    }
    let p = Path::new(program);
    let looks_like_path = p.is_absolute() || program.contains('\\') || program.contains('/');
    if looks_like_path {
        return classify(p).ok_or_else(|| AppError::MissingExecutable(program.to_string()));
    }
    which_exe(program).ok_or_else(|| AppError::MissingExecutable(program.to_string()))
}

/// Characters cmd.exe interprets even inside an argument list.
const CMD_META: &[char] = &['&', '|', '<', '>', '^', '%', '"', '!', '\r', '\n'];

/// Reject arguments that cmd.exe would re-interpret when a batch shim is used.
pub fn validate_cmd_args(args: &[String]) -> AppResult<()> {
    if let Some(bad) = args.iter().find(|a| a.contains(CMD_META)) {
        return Err(AppError::Invalid(format!(
            "Argument {bad:?} contains characters that cmd.exe would interpret; \
             configure a native .exe path for this agent to pass it safely"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn classify_prefers_shim_target_and_siblings() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        // npm-style shim pointing at a native exe.
        let target_dir = d.join("node_modules").join("@x").join("tool").join("bin");
        std::fs::create_dir_all(&target_dir).unwrap();
        std::fs::write(target_dir.join("tool.exe"), b"MZ").unwrap();
        std::fs::write(
            d.join("tool.cmd"),
            "@ECHO off\r\n\"%dp0%\\node_modules\\@x\\tool\\bin\\tool.exe\"   %*\r\n",
        )
        .unwrap();
        std::fs::write(d.join("tool"), "#!/bin/sh\n").unwrap();
        std::fs::write(d.join("tool.ps1"), "#ps\n").unwrap();

        let want = Executable::native(target_dir.join("tool.exe"));
        assert_eq!(classify(&d.join("tool.cmd")), Some(want.clone()));
        assert_eq!(classify(&d.join("tool")), Some(want.clone()));
        assert_eq!(classify(&d.join("tool.ps1")), Some(want));

        // A shim whose target is missing is run through cmd.exe.
        std::fs::write(d.join("other.cmd"), "@echo off\r\nnode other.js %*\r\n").unwrap();
        let e = classify(&d.join("other.cmd")).unwrap();
        assert!(e.via_cmd);
        let (prog, prefix) = e.program_and_prefix();
        assert!(prog.to_string_lossy().to_ascii_lowercase().ends_with("cmd.exe"));
        assert_eq!(&prefix[..2], &["/d".to_string(), "/c".to_string()]);

        assert_eq!(classify(&d.join("missing.exe")), None);
    }

    #[test]
    fn user_program_resolution() {
        assert!(matches!(resolve_user_program(""), Err(AppError::Invalid(_))));
        assert!(matches!(
            resolve_user_program(r"C:\nope\nothing-here.exe"),
            Err(AppError::MissingExecutable(_))
        ));
        #[cfg(windows)]
        {
            let cmd = resolve_user_program("cmd").expect("cmd.exe on PATH");
            assert!(!cmd.via_cmd);
        }
        #[cfg(not(windows))]
        {
            let sh = resolve_user_program("sh").expect("sh on PATH");
            assert!(!sh.via_cmd && sh.path.is_absolute());
            assert!(matches!(resolve_user_program("/nope/nothing-here"), Err(AppError::MissingExecutable(_))));
        }
    }

    #[cfg(not(windows))]
    #[test]
    fn classify_takes_plain_files() {
        let dir = tempfile::tempdir().unwrap();
        let tool = dir.path().join("claude");
        std::fs::write(&tool, "#!/bin/sh\n").unwrap();
        assert_eq!(classify(&tool), Some(Executable::native(tool.clone())));
        assert_eq!(classify(&dir.path().join("missing")), None);
        assert_eq!(classify(dir.path()), None, "a directory is not a program");
        assert!(!classify(&tool).unwrap().program_and_prefix().1.iter().any(|a| a == "/c"));
    }

    #[test]
    fn cmd_meta_rejected() {
        assert!(validate_cmd_args(&["--continue".into(), "hello world".into()]).is_ok());
        assert!(validate_cmd_args(&["a & calc".into()]).is_err());
        assert!(validate_cmd_args(&["%PATH%".into()]).is_err());
    }
}
