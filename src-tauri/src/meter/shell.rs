//! Which shell Claude Code runs status line commands through, and how to quote for it.
//!
//! Claude Code docs (statusline, "Windows configuration"): "On Windows, Claude Code runs status line
//! commands through Git Bash when Git Bash is installed, or through PowerShell when Git Bash is absent."
//! Git Bash consumes unquoted backslashes, so paths are written with forward slashes.
//! Elsewhere the command runs through a POSIX shell (`sh -c`).
//!
//! Used twice: by the host when it builds the injected `statusLine.command` (quoting depends on the
//! shell) and by the helper when it runs the user's own status line command (chaining).

use std::path::{Path, PathBuf};

/// Environment variable Claude Code itself honours to locate Git Bash on Windows.
pub const GIT_BASH_ENV: &str = "CLAUDE_CODE_GIT_BASH_PATH";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StatusShell {
    /// Windows with Git for Windows installed: `bash.exe -c`.
    GitBash(PathBuf),
    /// Windows without Git Bash: `pwsh` (or Windows PowerShell) `-Command`.
    PowerShell(PathBuf),
    /// Any other OS: `sh -c`.
    Sh,
}

/// Detect the status line shell. `env` looks up an environment variable (the session's own
/// environment first, then the process environment).
pub fn detect(env: &dyn Fn(&str) -> Option<String>) -> StatusShell {
    #[cfg(windows)]
    {
        match find_git_bash(env) {
            Some(bash) => StatusShell::GitBash(bash),
            None => StatusShell::PowerShell(find_powershell(env)),
        }
    }
    #[cfg(not(windows))]
    {
        let _ = env;
        StatusShell::Sh
    }
}

/// The process environment as an `env` lookup for [`detect`].
pub fn process_env(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|v| !v.trim().is_empty())
}

/// Git Bash the way Claude Code finds it: `CLAUDE_CODE_GIT_BASH_PATH`, else the `bash.exe` of the Git
/// installation that provides `git` on PATH, else the standard install folders. `bash` on PATH is
/// deliberately not used: `C:\Windows\System32\bash.exe` is WSL, not Git Bash.
pub fn find_git_bash(env: &dyn Fn(&str) -> Option<String>) -> Option<PathBuf> {
    if let Some(p) = env(GIT_BASH_ENV).map(PathBuf::from).filter(|p| p.is_file()) {
        return Some(p);
    }
    if let Some(git) = which::which("git").ok() {
        if let Some(bash) = git_root_bash(&git) {
            return Some(bash);
        }
    }
    let mut roots = Vec::new();
    for var in ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"] {
        if let Some(v) = env(var) {
            roots.push(PathBuf::from(v).join("Git"));
        }
    }
    if let Some(v) = env("LOCALAPPDATA") {
        roots.push(PathBuf::from(v).join("Programs").join("Git"));
    }
    roots.into_iter().map(|r| r.join("bin").join("bash.exe")).find(|p| p.is_file())
}

/// `<git root>\bin\bash.exe` for a `git.exe` found at `<root>\cmd`, `<root>\bin` or `<root>\mingw64\bin`.
pub fn git_root_bash(git: &Path) -> Option<PathBuf> {
    git.parent()?
        .ancestors()
        .take(3)
        .map(|a| a.join("bin").join("bash.exe"))
        .find(|p| p.is_file())
}

/// `pwsh` on PATH, else Windows PowerShell.
pub fn find_powershell(env: &dyn Fn(&str) -> Option<String>) -> PathBuf {
    if let Ok(p) = which::which("pwsh") {
        return p;
    }
    let root = env("SystemRoot").unwrap_or_else(|| r"C:\Windows".into());
    let p = PathBuf::from(root).join(r"System32\WindowsPowerShell\v1.0\powershell.exe");
    if p.is_file() { p } else { PathBuf::from("powershell.exe") }
}

/// A path as it should appear in a status line command: forward slashes on Windows (Git Bash eats
/// backslashes; PowerShell and Win32 accept `/`), no `\\?\` verbatim prefix.
pub fn command_path(p: &Path) -> String {
    let s = p.to_string_lossy();
    let s = s.strip_prefix(r"\\?\").unwrap_or(&s);
    if cfg!(windows) { s.replace('\\', "/") } else { s.to_string() }
}

/// Characters that need no quoting in bash, PowerShell and sh alike (a leading `~` expands in bash and a
/// leading `@` splats in PowerShell; `,` builds an array in PowerShell).
fn is_plain(s: &str) -> bool {
    !s.is_empty()
        && !s.starts_with(['~', '@'])
        && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '.' | '_' | '-' | ':' | '+'))
}

/// One shell word: bare when it is plain, else single-quoted (literal in bash, sh and PowerShell alike).
/// A word with a single quote or a control character is refused rather than escaped.
pub fn shell_word(s: &str) -> Result<String, String> {
    if is_plain(s) {
        return Ok(s.to_string());
    }
    if s.is_empty() || s.contains('\'') || s.chars().any(char::is_control) {
        return Err(format!("unsupported characters in {s:?}"));
    }
    Ok(format!("'{s}'"))
}

/// A full command line `program args...` for `shell`. A bare program path runs as a command in every
/// shell; a quoted one is a string in PowerShell, so there it gets the call operator (`& 'C:/a b/x.exe'`).
///
/// Checked by hand with a GUI-subsystem test exe (like the release build) spawned the way Claude Code
/// does it (shell `-c`/`-Command`, stdin and stdout redirected): Git Bash, pwsh 7 and Windows
/// PowerShell 5.1 all wait for it and pass the pipes, bare or quoted with `&`.
pub fn command_line(shell: &StatusShell, program: &str, args: &[String]) -> Result<String, String> {
    let prog = shell_word(program)?;
    let quoted = prog.starts_with('\'');
    let mut words = vec![prog];
    for a in args {
        words.push(shell_word(a)?);
    }
    let line = words.join(" ");
    Ok(match shell {
        StatusShell::PowerShell(_) if quoted => format!("& {line}"),
        _ => line,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn words_are_bare_or_single_quoted() {
        assert_eq!(shell_word("C:/Users/a/AppData/x.json").unwrap(), "C:/Users/a/AppData/x.json");
        assert_eq!(shell_word("--gk-statusline").unwrap(), "--gk-statusline");
        assert_eq!(shell_word("a,b").unwrap(), "'a,b'");
        assert_eq!(shell_word("~/x").unwrap(), "'~/x'");
        assert_eq!(shell_word("C:/Program Files/G/gridkeeper.exe").unwrap(), "'C:/Program Files/G/gridkeeper.exe'");
        assert_eq!(shell_word("C:/a$b/x").unwrap(), "'C:/a$b/x'");
        assert!(shell_word("C:/it's/x").is_err());
        assert!(shell_word("a\nb").is_err());
        assert!(shell_word("").is_err());
    }

    #[test]
    fn command_line_per_shell() {
        let args = vec!["x".to_string(), "C:/a b/m.json".to_string()];
        let bash = command_line(&StatusShell::GitBash("bash".into()), "C:/G/gk.exe", &args).unwrap();
        assert_eq!(bash, "C:/G/gk.exe x 'C:/a b/m.json'");
        let ps = command_line(&StatusShell::PowerShell("pwsh".into()), "C:/G/gk.exe", &args).unwrap();
        assert_eq!(ps, "C:/G/gk.exe x 'C:/a b/m.json'");
        let ps = command_line(&StatusShell::PowerShell("pwsh".into()), "C:/Program Files/G/gk.exe", &args).unwrap();
        assert_eq!(ps, "& 'C:/Program Files/G/gk.exe' x 'C:/a b/m.json'");
        let bash = command_line(&StatusShell::GitBash("bash".into()), "C:/Program Files/G/gk.exe", &args).unwrap();
        assert_eq!(bash, "'C:/Program Files/G/gk.exe' x 'C:/a b/m.json'");
        assert!(command_line(&StatusShell::Sh, "/it's/gk", &args).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn command_path_uses_forward_slashes() {
        assert_eq!(command_path(Path::new(r"\\?\C:\Users\a\x.json")), "C:/Users/a/x.json");
        assert_eq!(command_path(Path::new(r"D:\Gridkeeper\gridkeeper.exe")), "D:/Gridkeeper/gridkeeper.exe");
    }

    #[test]
    fn git_bash_from_env_and_git_location() {
        let t = tempfile::tempdir().unwrap();
        let root = t.path().join("Git");
        std::fs::create_dir_all(root.join("bin")).unwrap();
        std::fs::create_dir_all(root.join("cmd")).unwrap();
        std::fs::write(root.join("bin").join("bash.exe"), b"MZ").unwrap();
        // git.exe in <root>\cmd → <root>\bin\bash.exe
        assert_eq!(git_root_bash(&root.join("cmd").join("git.exe")), Some(root.join("bin").join("bash.exe")));
        assert_eq!(git_root_bash(&t.path().join("elsewhere").join("git.exe")), None);
        let bash = root.join("bin").join("bash.exe");
        let b = bash.to_string_lossy().into_owned();
        let env = move |k: &str| (k == GIT_BASH_ENV).then(|| b.clone());
        assert_eq!(find_git_bash(&env), Some(bash));
    }
}
