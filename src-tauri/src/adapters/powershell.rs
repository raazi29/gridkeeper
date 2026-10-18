//! The platform's default terminal (`AgentKind::Powershell`, kept as the stored identifier).
//!
//! - Windows: PowerShell — pwsh 7 preferred, Windows PowerShell 5.1 as fallback.
//! - macOS / Linux: the user's login shell — `$SHELL`, else the passwd entry, else zsh (macOS) /
//!   bash (Linux), else `/bin/sh`. macOS starts it as a login shell (`-l`, like Terminal.app), so
//!   `/etc/zprofile` / `~/.zprofile` set up PATH (Homebrew, path_helper); Linux starts an
//!   interactive non-login shell, like GNOME Terminal / Konsole. pwsh on Unix is the catalog preset
//!   `pwsh` (listed only when it is on PATH), or this adapter when `$SHELL` / the settings override
//!   points at it.

#[cfg(windows)]
use std::path::PathBuf;

use super::discovery::Executable;
#[cfg(windows)]
use super::discovery;
use super::{AgentAdapter, Capabilities, LaunchContext, PlanBuilder};
use crate::types::*;

pub struct PowerShellAdapter;

#[cfg(windows)]
fn is_windows_powershell(exe: &Executable) -> bool {
    exe.path
        .file_name()
        .map(|n| n.to_string_lossy().eq_ignore_ascii_case("powershell.exe"))
        .unwrap_or(false)
}

/// File name without extension, lower-cased (`/usr/local/bin/pwsh` → `pwsh`).
#[cfg_attr(windows, allow(dead_code))]
fn stem(exe: &Executable) -> String {
    exe.path.file_stem().map(|n| n.to_string_lossy().to_ascii_lowercase()).unwrap_or_default()
}

#[cfg(windows)]
fn discover_powershell() -> Option<Executable> {
    if let Some(exe) = discovery::which_exe("pwsh").filter(|e| !e.via_cmd) {
        return Some(exe);
    }
    let mut candidates = Vec::new();
    for var in ["ProgramFiles", "ProgramW6432"] {
        if let Some(pf) = std::env::var_os(var) {
            candidates.push(PathBuf::from(pf).join(r"PowerShell\7\pwsh.exe"));
        }
    }
    candidates.push(PathBuf::from(r"C:\Program Files\PowerShell\7\pwsh.exe"));
    if let Some(found) = candidates.into_iter().find(|p| p.is_file()) {
        return Some(Executable::native(found));
    }
    if let Some(exe) = discovery::which_exe("powershell").filter(|e| !e.via_cmd) {
        return Some(exe);
    }
    let root = std::env::var_os("SystemRoot").unwrap_or_else(|| r"C:\Windows".into());
    let legacy = PathBuf::from(root).join(r"System32\WindowsPowerShell\v1.0\powershell.exe");
    legacy.is_file().then(|| Executable::native(legacy))
}

/// The login shell from the passwd database (`getpwuid_r`), when `$SHELL` is not set.
#[cfg(unix)]
fn passwd_shell() -> Option<std::path::PathBuf> {
    use std::ffi::CStr;
    use std::os::unix::ffi::OsStrExt;
    let mut pwd: libc::passwd = unsafe { std::mem::zeroed() };
    let mut buf = vec![0 as libc::c_char; 16 * 1024];
    let mut result: *mut libc::passwd = std::ptr::null_mut();
    // SAFETY: getpwuid_r writes into `pwd` / `buf` (sizes given) and sets `result` to `&pwd` on
    // success; the strings it points to live in `buf`, which outlives their use below.
    let rc = unsafe { libc::getpwuid_r(libc::getuid(), &mut pwd, buf.as_mut_ptr(), buf.len(), &mut result) };
    if rc != 0 || result.is_null() || pwd.pw_shell.is_null() {
        return None;
    }
    // SAFETY: pw_shell is a NUL-terminated string inside `buf`.
    let shell = unsafe { CStr::from_ptr(pwd.pw_shell) };
    let path = std::path::PathBuf::from(std::ffi::OsStr::from_bytes(shell.to_bytes()));
    Some(path)
}

/// `$SHELL` → passwd entry → zsh (macOS) / bash (Linux) → `/bin/sh`. Only absolute, existing files.
#[cfg(unix)]
pub fn login_shell() -> Option<Executable> {
    use std::path::PathBuf;
    let usable = |p: &PathBuf| p.is_absolute() && p.is_file();
    let from_env = std::env::var_os("SHELL").filter(|v| !v.is_empty()).map(PathBuf::from);
    let fallbacks: &[&str] = if cfg!(target_os = "macos") {
        &["/bin/zsh", "/bin/bash", "/bin/sh"]
    } else {
        &["/bin/bash", "/usr/bin/bash", "/bin/zsh", "/usr/bin/zsh", "/bin/sh"]
    };
    from_env
        .filter(usable)
        .or_else(|| passwd_shell().filter(usable))
        .or_else(|| fallbacks.iter().map(PathBuf::from).find(usable))
        .map(Executable::native)
}

impl AgentAdapter for PowerShellAdapter {
    fn kind(&self) -> AgentKind {
        AgentKind::Powershell
    }
    fn display_name(&self) -> &'static str {
        if cfg!(windows) { "PowerShell" } else { "Shell" }
    }
    fn capabilities(&self) -> Capabilities {
        Capabilities { supports_resume: false, supports_profiles: false }
    }
    fn settings_override<'s>(&self, settings: &'s Settings) -> Option<&'s str> {
        settings.agent_paths.powershell.as_deref()
    }

    fn discover(&self) -> Option<Executable> {
        #[cfg(windows)]
        {
            discover_powershell()
        }
        #[cfg(unix)]
        {
            login_shell()
        }
    }

    fn version_args(&self, exe: &Executable) -> Option<Vec<String>> {
        #[cfg(windows)]
        {
            if is_windows_powershell(exe) {
                // Windows PowerShell 5.1 has no --version switch.
                Some(
                    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"]
                        .map(String::from)
                        .to_vec(),
                )
            } else {
                Some(vec!["--version".into()])
            }
        }
        #[cfg(unix)]
        {
            // bash / zsh / fish / pwsh / tcsh answer --version; POSIX sh (dash) and ksh don't.
            match stem(exe).as_str() {
                "sh" | "dash" | "ash" | "ksh" | "mksh" => None,
                _ => Some(vec!["--version".into()]),
            }
        }
    }

    fn configure(&self, _ctx: &LaunchContext<'_>, exe: &Executable, plan: &mut PlanBuilder) -> AppResult<()> {
        #[cfg(windows)]
        {
            let _ = exe;
            plan.arg("-NoLogo");
        }
        #[cfg(unix)]
        {
            if stem(exe) == "pwsh" {
                plan.arg("-NoLogo");
            } else if cfg!(target_os = "macos") {
                plan.arg("-l");
            }
        }
        Ok(())
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn finds_a_login_shell() {
        let sh = login_shell().expect("some shell exists");
        assert!(sh.path.is_absolute() && sh.path.is_file(), "{sh:?}");
        assert!(!sh.via_cmd);
        assert!(passwd_shell().is_none_or(|p| p.is_absolute()));
    }

    #[test]
    fn shell_flags() {
        let probe = |p: &str| PowerShellAdapter.version_args(&Executable::native(p.into()));
        assert!(probe("/bin/sh").is_none());
        assert!(probe("/usr/bin/dash").is_none());
        assert_eq!(probe("/bin/zsh"), Some(vec!["--version".to_string()]));
        assert_eq!(probe("/opt/homebrew/bin/pwsh"), Some(vec!["--version".to_string()]));
        assert_eq!(PowerShellAdapter.display_name(), "Shell");
    }
}
