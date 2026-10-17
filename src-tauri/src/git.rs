//! Git integration: repository info, worktree creation and the read-only Changes panel
//! (status + diff).
//!
//! Shells out to `git` (hidden window, bounded time). Only read-only commands
//! plus `worktree add` are ever run — nothing destructive; the Changes panel never stages,
//! commits, checks out or resets. A missing `git` or a non-repository path yields
//! `GitInfo::default()` / `RepoChanges::default()`, not an error.

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

// ---------------------------------------------------------------------------
// Changes panel (strictly read-only: status + diff, never stage/commit/checkout/reset)
// ---------------------------------------------------------------------------

const STATUS_TIMEOUT: Duration = Duration::from_secs(10);
const DIFF_TIMEOUT: Duration = Duration::from_secs(15);
/// Larger status lists are cut (a generated folder without .gitignore can hold 100k files).
pub const MAX_STATUS_FILES: usize = 5000;
/// Diffs are cut at 2 MiB (the git child is killed once its output passes the cap).
pub const MAX_DIFF_BYTES: usize = 2 * 1024 * 1024;
const MAX_STATUS_BYTES: usize = 8 * 1024 * 1024;

/// Read-only git run with a stdout cap. Pathspecs are literal (no `:(magic)`), locks optional.
fn run_git_capped(dir: &Path, args: &[&str], timeout: Duration, cap: usize) -> AppResult<process::CappedOutput> {
    let git = git_exe().ok_or_else(|| AppError::MissingExecutable("git".into()))?;
    let mut cmd = process::hidden_command(git);
    cmd.arg("-C").arg(dir).args(["-c", "core.quotepath=off", "-c", "color.ui=never"]).args(args);
    cmd.env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_PAGER", "cat")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_LITERAL_PATHSPECS", "1");
    process::run_capped(cmd, timeout, cap).map_err(|e| AppError::Other(format!("git did not complete: {e}")))
}

/// Parse `git status --porcelain=v2 --branch -z` output.
/// Returns the snapshot without `is_repo` / `root` (filled by the caller).
pub fn parse_status_v2(raw: &[u8]) -> RepoChanges {
    let text = String::from_utf8_lossy(raw);
    let mut out = RepoChanges::default();
    let mut records = text.split('\0');
    while let Some(rec) = records.next() {
        if rec.is_empty() {
            continue;
        }
        if let Some(h) = rec.strip_prefix("# ") {
            if let Some(b) = h.strip_prefix("branch.head ") {
                out.branch = (b != "(detached)").then(|| b.to_string());
            } else if let Some(u) = h.strip_prefix("branch.upstream ") {
                out.upstream = Some(u.to_string());
            } else if let Some(ab) = h.strip_prefix("branch.ab ") {
                for part in ab.split_whitespace() {
                    if let Some(a) = part.strip_prefix('+') {
                        out.ahead = a.parse().unwrap_or(0);
                    } else if let Some(b) = part.strip_prefix('-') {
                        out.behind = b.parse().unwrap_or(0);
                    }
                }
            }
            continue;
        }
        let xy = |s: &str| -> (String, String) {
            let mut c = s.chars();
            (c.next().unwrap_or('.').to_string(), c.next().unwrap_or('.').to_string())
        };
        let file = match rec.as_bytes()[0] {
            b'1' => {
                let f: Vec<&str> = rec.splitn(9, ' ').collect();
                if f.len() < 9 {
                    continue;
                }
                let (index, worktree) = xy(f[1]);
                ChangedFile { path: f[8].to_string(), orig_path: None, index, worktree, kind: "changed".into() }
            }
            b'2' => {
                let f: Vec<&str> = rec.splitn(10, ' ').collect();
                // The rename source is the NEXT NUL-separated record: always consume it.
                let orig = records.next().map(str::to_string);
                if f.len() < 10 {
                    continue;
                }
                let (index, worktree) = xy(f[1]);
                ChangedFile { path: f[9].to_string(), orig_path: orig, index, worktree, kind: "renamed".into() }
            }
            b'u' => {
                let f: Vec<&str> = rec.splitn(11, ' ').collect();
                if f.len() < 11 {
                    continue;
                }
                let (index, worktree) = xy(f[1]);
                ChangedFile { path: f[10].to_string(), orig_path: None, index, worktree, kind: "unmerged".into() }
            }
            b'?' => match rec.strip_prefix("? ") {
                Some(p) => ChangedFile {
                    path: p.to_string(),
                    orig_path: None,
                    index: ".".into(),
                    worktree: "?".into(),
                    kind: "untracked".into(),
                },
                None => continue,
            },
            _ => continue, // "!" ignored entries and anything unknown
        };
        if out.files.len() >= MAX_STATUS_FILES {
            out.truncated = true;
            continue;
        }
        out.files.push(file);
    }
    out
}

/// Repository root of `path`, or `None` when it is not inside a work tree.
fn repo_root(path: &str) -> AppResult<Option<PathBuf>> {
    if path.contains('\0') {
        return Err(AppError::Invalid("Path contains a NUL character".into()));
    }
    let dir = Path::new(path);
    if !dir.is_absolute() {
        return Err(AppError::Invalid("Path must be absolute".into()));
    }
    if !dir.is_dir() {
        return Ok(None);
    }
    if git_stdout(dir, &["rev-parse", "--is-inside-work-tree"]).as_deref() != Some("true") {
        return Ok(None);
    }
    Ok(git_stdout(dir, &["rev-parse", "--show-toplevel"]).filter(|r| !r.is_empty()).map(|r| PathBuf::from(win_path(&r))))
}

/// Branch, ahead/behind and changed files of the repository containing `path`. Read-only.
pub fn changes(path: &str) -> AppResult<RepoChanges> {
    let Some(root) = repo_root(path)? else {
        return Ok(RepoChanges::default());
    };
    let out = run_git_capped(
        &root,
        &["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"],
        STATUS_TIMEOUT,
        MAX_STATUS_BYTES,
    )?;
    if !out.truncated && !out.status.is_some_and(|s| s.success()) {
        let msg = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(AppError::Other(format!("git status failed: {}", crate::redact::redact(&msg))));
    }
    let mut c = parse_status_v2(&out.stdout);
    c.truncated |= out.truncated;
    c.is_repo = true;
    c.root = Some(root.to_string_lossy().into_owned());
    Ok(c)
}

/// A repository-relative path as printed by `git status`: no NUL / control characters, not
/// absolute, no drive letter or `..` component, no option-looking start.
pub fn validate_repo_relative(file: &str) -> AppResult<()> {
    let bad = file.is_empty()
        || file.len() > 4096
        || file.starts_with('-')
        || file.starts_with('/')
        || file.starts_with('\\')
        || file.contains(':')
        || file.chars().any(|c| c.is_control())
        || file.split(['/', '\\']).any(|seg| seg == "..");
    if bad {
        return Err(AppError::Invalid(format!("Invalid repository path: {file:?}")));
    }
    Ok(())
}

/// Cut a diff at `cap` bytes on a line boundary (UTF-8 safe). Returns (text, truncated).
pub fn cap_diff(bytes: &[u8], cap: usize) -> (String, bool) {
    if bytes.len() <= cap {
        return (String::from_utf8_lossy(bytes).into_owned(), false);
    }
    let head = &bytes[..cap];
    let end = head.iter().rposition(|&b| b == b'\n').map(|i| i + 1).unwrap_or(cap);
    (String::from_utf8_lossy(&head[..end]).into_owned(), true)
}

fn looks_binary(diff: &str) -> bool {
    diff.lines().any(|l| l.starts_with("Binary files ") && l.ends_with(" differ")) || diff.contains("GIT binary patch")
}

/// Unified diff of one file: work tree vs index (`staged = false`), index vs HEAD (`staged = true`),
/// or the whole file as added when it is untracked. Read-only; capped at [`MAX_DIFF_BYTES`].
pub fn diff(repo: &str, file: &str, staged: bool, untracked: bool) -> AppResult<FileDiff> {
    validate_repo_relative(file)?;
    let Some(root) = repo_root(repo)? else {
        return Err(AppError::Invalid(format!("Not a git repository: {repo}")));
    };
    let base = ["diff", "--no-color", "--no-ext-diff", "--no-textconv"];
    let mut args: Vec<&str> = base.to_vec();
    if untracked {
        // Exit code 1 = "files differ", the normal case here.
        args.extend(["--no-index", "--", "/dev/null", file]);
    } else {
        if staged {
            args.push("--cached");
        }
        args.extend(["--", file]);
    }
    // One byte over the cap tells "exactly at the cap" from "cut".
    let out = run_git_capped(&root, &args, DIFF_TIMEOUT, MAX_DIFF_BYTES + 1)?;
    let ok = out.truncated || out.status.is_some_and(|s| s.success() || s.code() == Some(1));
    if !ok {
        let msg = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(AppError::Other(format!("git diff failed: {}", crate::redact::redact(&msg))));
    }
    let (text, cut) = cap_diff(&out.stdout, MAX_DIFF_BYTES);
    let binary = looks_binary(&text);
    Ok(FileDiff { text, truncated: cut || out.truncated, binary })
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
    fn parses_status_v2() {
        let raw = concat!(
            "# branch.oid 1234\0",
            "# branch.head feat/x\0",
            "# branch.upstream origin/feat/x\0",
            "# branch.ab +3 -1\0",
            "1 .M N... 100644 100644 100644 aaaa bbbb src/main file.rs\0",
            "1 A. N... 000000 100644 100644 0000 cccc new.txt\0",
            "2 R. N... 100644 100644 100644 dddd eeee R100 docs/new name.md\0",
            "docs/old name.md\0",
            "u UU N... 100644 100644 100644 100644 h1 h2 h3 conflict.txt\0",
            "? untracked dir/a.txt\0",
            "! ignored.log\0",
        );
        let c = parse_status_v2(raw.as_bytes());
        assert_eq!(c.branch.as_deref(), Some("feat/x"));
        assert_eq!(c.upstream.as_deref(), Some("origin/feat/x"));
        assert_eq!((c.ahead, c.behind), (3, 1));
        assert_eq!(c.files.len(), 5, "{:?}", c.files);
        assert_eq!(c.files[0].path, "src/main file.rs");
        assert_eq!((c.files[0].index.as_str(), c.files[0].worktree.as_str()), (".", "M"));
        assert_eq!(c.files[1].index, "A");
        assert_eq!(c.files[2].kind, "renamed");
        assert_eq!(c.files[2].path, "docs/new name.md");
        assert_eq!(c.files[2].orig_path.as_deref(), Some("docs/old name.md"));
        assert_eq!(c.files[3].kind, "unmerged");
        assert_eq!(c.files[3].path, "conflict.txt");
        assert_eq!(c.files[4].kind, "untracked");
        assert_eq!(c.files[4].path, "untracked dir/a.txt");
        assert!(!c.truncated);

        let detached = parse_status_v2(b"# branch.oid 1\0# branch.head (detached)\0");
        assert_eq!(detached.branch, None);
        assert_eq!((detached.ahead, detached.behind), (0, 0));
    }

    #[test]
    fn status_list_is_capped() {
        let mut raw = String::new();
        for i in 0..(MAX_STATUS_FILES + 5) {
            raw.push_str(&format!("? f{i}.txt\0"));
        }
        let c = parse_status_v2(raw.as_bytes());
        assert_eq!(c.files.len(), MAX_STATUS_FILES);
        assert!(c.truncated);
    }

    #[test]
    fn diff_cap_cuts_on_line_boundary() {
        let (t, cut) = cap_diff(b"+a\n+b\n", 100);
        assert_eq!((t.as_str(), cut), ("+a\n+b\n", false));
        let (t, cut) = cap_diff(b"+aaaa\n+bbbb\n+cccc\n", 9);
        assert!(cut);
        assert_eq!(t, "+aaaa\n");
        // No newline inside the cap: hard cut, still valid UTF-8 (lossy).
        let (t, cut) = cap_diff("+ééééé".as_bytes(), 4);
        assert!(cut);
        assert!(t.len() <= 6);
        assert!(looks_binary("diff --git a/x b/x\nBinary files a/x and b/x differ\n"));
        assert!(!looks_binary("+Binary files are fun\n"));
    }

    #[test]
    fn repo_relative_paths_are_validated() {
        for ok in ["src/main.rs", "a b/c.txt", "docs\\x.md", ".github/workflows/ci.yml", "x..y"] {
            assert!(validate_repo_relative(ok).is_ok(), "{ok}");
        }
        for bad in ["", "-p", "../x", "a/../../x", "/etc/passwd", "\\\\srv\\share", "C:\\x", ":(top)x", "a\0b", "a\nb"] {
            assert!(validate_repo_relative(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn changes_and_diff_on_a_real_repo() {
        if git_exe().is_none() {
            eprintln!("git not installed; skipping");
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-q", "-b", "main"]);
        std::fs::write(repo.join("a.txt"), "one\n").unwrap();
        git(&repo, &["add", "a.txt"]);
        git(&repo, &["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "init"]);
        std::fs::write(repo.join("a.txt"), "one\ntwo\n").unwrap();
        std::fs::write(repo.join("new file.txt"), "fresh\n").unwrap();
        std::fs::write(repo.join("staged.txt"), "s\n").unwrap();
        git(&repo, &["add", "staged.txt"]);

        let repo_s = repo.to_string_lossy().into_owned();
        let c = changes(&repo_s).unwrap();
        assert!(c.is_repo);
        assert_eq!(c.branch.as_deref(), Some("main"));
        let paths: Vec<&str> = c.files.iter().map(|f| f.path.as_str()).collect();
        assert!(paths.contains(&"a.txt") && paths.contains(&"new file.txt") && paths.contains(&"staged.txt"), "{paths:?}");

        let d = diff(&repo_s, "a.txt", false, false).unwrap();
        assert!(d.text.contains("+two"), "{}", d.text);
        assert!(!d.truncated && !d.binary);
        let d = diff(&repo_s, "staged.txt", true, false).unwrap();
        assert!(d.text.contains("+s"));
        let d = diff(&repo_s, "new file.txt", false, true).unwrap();
        assert!(d.text.contains("+fresh"), "{}", d.text);
        assert!(diff(&repo_s, "../outside.txt", false, false).is_err());

        let plain = tempfile::tempdir().unwrap();
        assert!(!changes(&plain.path().to_string_lossy()).unwrap().is_repo);
        assert!(changes("relative\\dir").is_err());
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
