//! Git integration: repository info and worktree creation.
//!
//! Shells out to `git` (hidden window, bounded time). Only read-only commands
//! plus `worktree add` are ever run — nothing destructive. A missing `git` or a
//! non-repository path yields `GitInfo::default()`, not an error.

use std::path::{Path, PathBuf};
use std::process::Output;
use std::time::Duration;

use crate::adapters::{discovery, process};
use crate::types::*;

const QUICK_TIMEOUT: Duration = Duration::from_secs(5);
const WORKTREE_TIMEOUT: Duration = Duration::from_secs(60);

fn git_exe() -> Option<PathBuf> {
    static GIT: once_cell::sync::Lazy<Option<PathBuf>> =
        once_cell::sync::Lazy::new(|| discovery::which_exe("git").filter(|e| !e.via_cmd).map(|e| e.path));
    GIT.clone()
}

fn run_git(dir: &Path, args: &[&str], timeout: Duration) -> Option<Output> {
    let git = git_exe()?;
    let mut cmd = process::hidden_command(git);
    cmd.arg("-C").arg(dir).args(args);
    // Never prompt (credential helpers, pagers, editors).
    cmd.env("GIT_TERMINAL_PROMPT", "0").env("GIT_PAGER", "cat").env("GIT_OPTIONAL_LOCKS", "0");
    process::run_with_timeout(cmd, timeout).ok()
}

fn git_stdout(dir: &Path, args: &[&str]) -> Option<String> {
    let out = run_git(dir, args, QUICK_TIMEOUT)?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Convert git's forward-slash paths to Windows form.
fn win_path(p: &str) -> String {
    p.replace('/', "\\")
}

/// Parse `git worktree list --porcelain`.
pub fn parse_worktrees(porcelain: &str) -> Vec<WorktreeInfo> {
    let mut out = Vec::new();
    for block in porcelain.replace("\r\n", "\n").split("\n\n") {
        let mut path = None;
        let mut head = None;
        let mut branch = None;
        for line in block.lines() {
            if let Some(p) = line.strip_prefix("worktree ") {
                path = Some(win_path(p.trim()));
            } else if let Some(h) = line.strip_prefix("HEAD ") {
                head = Some(h.trim().to_string());
            } else if let Some(b) = line.strip_prefix("branch ") {
                let b = b.trim();
                branch = Some(b.strip_prefix("refs/heads/").unwrap_or(b).to_string());
            }
        }
        if let Some(path) = path {
            let is_main = out.is_empty();
            out.push(WorktreeInfo { path, branch, head, is_main });
        }
    }
    out
}

pub fn info(path: &str) -> AppResult<GitInfo> {
    if path.contains('\0') {
        return Err(AppError::Invalid("Path contains a NUL character".into()));
    }
    let dir = Path::new(path);
    if !dir.is_dir() {
        return Ok(GitInfo::default());
    }
    let inside = git_stdout(dir, &["rev-parse", "--is-inside-work-tree"]);
    if inside.as_deref() != Some("true") {
        return Ok(GitInfo::default());
    }
    let root = git_stdout(dir, &["rev-parse", "--show-toplevel"]).map(|r| win_path(&r));
    let branch = git_stdout(dir, &["symbolic-ref", "--quiet", "--short", "HEAD"])
        .filter(|b| !b.is_empty())
        .or_else(|| git_stdout(dir, &["rev-parse", "--abbrev-ref", "HEAD"]).filter(|b| !b.is_empty()));
    let dirty = run_git(dir, &["status", "--porcelain", "-uno"], QUICK_TIMEOUT)
        .filter(|o| o.status.success())
        .map(|o| !o.stdout.iter().all(u8::is_ascii_whitespace))
        .unwrap_or(false);
    let worktrees = git_stdout(dir, &["worktree", "list", "--porcelain"])
        .map(|s| parse_worktrees(&s))
        .unwrap_or_default();
    Ok(GitInfo { is_repo: true, root, branch, dirty, worktrees })
}

fn check_branch_name(repo: &Path, branch: &str) -> AppResult<()> {
    let sane = !branch.is_empty()
        && branch.len() <= 200
        && !branch.starts_with('-')
        && !branch.chars().any(|c| c.is_control() || c.is_whitespace());
    if !sane {
        return Err(AppError::Invalid(format!("Invalid branch name: {branch:?}")));
    }
    match run_git(repo, &["check-ref-format", "--branch", branch], QUICK_TIMEOUT) {
        Some(o) if o.status.success() => Ok(()),
        Some(_) => Err(AppError::Invalid(format!("Invalid branch name: {branch:?}"))),
        None => Err(AppError::MissingExecutable("git".into())),
    }
}

/// `git -C <repo> worktree add [-b <branch>] <path> [<branch>]`.
pub fn worktree_add(repo: &str, path: &str, branch: &str, new_branch: bool) -> AppResult<WorktreeInfo> {
    if [repo, path, branch].iter().any(|s| s.contains('\0')) {
        return Err(AppError::Invalid("Arguments must not contain NUL characters".into()));
    }
    git_exe().ok_or_else(|| AppError::MissingExecutable("git".into()))?;
    let repo_dir = Path::new(repo);
    let gi = info(repo)?;
    if !gi.is_repo {
        return Err(AppError::Invalid(format!("Not a git repository: {repo}")));
    }
    let target = PathBuf::from(path.trim());
    if path.trim().is_empty() || !target.is_absolute() {
        return Err(AppError::Invalid(format!("Worktree path must be absolute: {path}")));
    }
    if target.exists() {
        return Err(AppError::Invalid(format!("Path already exists: {path}")));
    }
    let branch = branch.trim();
    check_branch_name(repo_dir, branch)?;

    let target_s = target.to_string_lossy().into_owned();
    let mut args: Vec<&str> = vec!["worktree", "add"];
    if new_branch {
        args.extend(["-b", branch, "--", &target_s]);
    } else {
        args.extend(["--", &target_s, branch]);
    }
    let out = run_git(repo_dir, &args, WORKTREE_TIMEOUT)
        .ok_or_else(|| AppError::Other("git worktree add did not complete".into()))?;
    if !out.status.success() {
        let msg = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(AppError::Other(format!("git worktree add failed: {}", crate::redact::redact(&msg))));
    }
    tracing::info!(new_branch, "created git worktree");

    // Report the new worktree as git sees it.
    let created = info(repo)?
        .worktrees
        .into_iter()
        .find(|w| same_path(Path::new(&w.path), &target));
    Ok(created.unwrap_or(WorktreeInfo {
        path: target_s,
        branch: Some(branch.to_string()),
        head: None,
        is_main: false,
    }))
}

fn same_path(a: &Path, b: &Path) -> bool {
    let norm = |p: &Path| {
        std::fs::canonicalize(p)
            .unwrap_or_else(|_| p.to_path_buf())
            .to_string_lossy()
            .trim_start_matches(r"\\?\")
            .trim_end_matches('\\')
            .to_lowercase()
    };
    norm(a) == norm(b)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_porcelain() {
        let s = "worktree D:/repo\nHEAD 1111\nbranch refs/heads/main\n\nworktree D:/repo/.wt/feat\nHEAD 2222\nbranch refs/heads/feat/x\n\nworktree D:/tmp/det\nHEAD 3333\ndetached\n\n";
        let w = parse_worktrees(s);
        assert_eq!(w.len(), 3);
        assert!(w[0].is_main && !w[1].is_main);
        assert_eq!(w[0].path, r"D:\repo");
        assert_eq!(w[1].branch.as_deref(), Some("feat/x"));
        assert_eq!(w[2].branch, None);
        assert_eq!(w[2].head.as_deref(), Some("3333"));
    }

    #[test]
    fn non_repo_is_default() {
        let dir = tempfile::tempdir().unwrap();
        let gi = info(&dir.path().to_string_lossy()).unwrap();
        assert!(!gi.is_repo && gi.worktrees.is_empty());
        let gi = info(r"C:\definitely\missing\dir").unwrap();
        assert!(!gi.is_repo);
    }

    fn git(dir: &Path, args: &[&str]) {
        let mut cmd = process::hidden_command(git_exe().unwrap());
        cmd.arg("-C").arg(dir).args(args).env("GIT_CONFIG_NOSYSTEM", "1").env("GIT_CONFIG_GLOBAL", "NUL");
        let out = process::run_with_timeout(cmd, Duration::from_secs(30)).unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    }

    #[test]
    fn repo_info_and_worktree_add() {
        if git_exe().is_none() {
            eprintln!("git not installed; skipping");
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-q", "-b", "main"]);
        git(&repo, &["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "--allow-empty", "-m", "init"]);
        std::fs::write(repo.join("a.txt"), "x").unwrap();
        git(&repo, &["add", "a.txt"]);

        let repo_s = repo.to_string_lossy().into_owned();
        let gi = info(&repo_s).unwrap();
        assert!(gi.is_repo);
        assert_eq!(gi.branch.as_deref(), Some("main"));
        assert!(gi.dirty, "staged change counts as dirty");
        assert_eq!(gi.worktrees.len(), 1);
        assert!(gi.worktrees[0].is_main);

        // Validation.
        let wt = tmp.path().join("wt-feature");
        let wt_s = wt.to_string_lossy().into_owned();
        assert!(matches!(worktree_add(&repo_s, &wt_s, "bad..name", true), Err(AppError::Invalid(_))));
        assert!(matches!(worktree_add(&repo_s, &wt_s, "-x", true), Err(AppError::Invalid(_))));
        assert!(matches!(worktree_add(&repo_s, &repo_s, "feature", true), Err(AppError::Invalid(_))));
        assert!(matches!(worktree_add(&repo_s, "relative\\wt", "feature", true), Err(AppError::Invalid(_))));
        let not_repo = tmp.path().join("plain");
        std::fs::create_dir_all(&not_repo).unwrap();
        assert!(matches!(
            worktree_add(&not_repo.to_string_lossy(), &wt_s, "feature", true),
            Err(AppError::Invalid(_))
        ));

        // Create.
        let w = worktree_add(&repo_s, &wt_s, "feature/one", true).unwrap();
        assert!(wt.is_dir());
        assert_eq!(w.branch.as_deref(), Some("feature/one"));
        assert!(!w.is_main);
        let gi = info(&repo_s).unwrap();
        assert_eq!(gi.worktrees.len(), 2);
        let gi_wt = info(&wt_s).unwrap();
        assert_eq!(gi_wt.branch.as_deref(), Some("feature/one"));

        // Existing branch into a second worktree path fails cleanly (branch checked out).
        let wt2 = tmp.path().join("wt-two");
        assert!(worktree_add(&repo_s, &wt2.to_string_lossy(), "feature/one", false).is_err());
    }
}
