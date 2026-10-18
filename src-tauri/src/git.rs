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

/// Convert git's forward-slash paths to Windows form (unchanged on macOS / Linux).
fn win_path(p: &str) -> String {
    if cfg!(windows) { p.replace('/', "\\") } else { p.to_string() }
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
    run_file_diff(&root, &args)
}

/// Run a one-file `git diff` and cap its text at [`MAX_DIFF_BYTES`]. Exit code 1 ("files differ",
/// `--no-index`) counts as success.
fn run_file_diff(root: &Path, args: &[&str]) -> AppResult<FileDiff> {
    // One byte over the cap tells "exactly at the cap" from "cut".
    let out = run_git_capped(root, args, DIFF_TIMEOUT, MAX_DIFF_BYTES + 1)?;
    let ok = out.truncated || out.status.is_some_and(|s| s.success() || s.code() == Some(1));
    if !ok {
        let msg = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(AppError::Other(format!("git diff failed: {}", crate::redact::redact(&msg))));
    }
    let (text, cut) = cap_diff(&out.stdout, MAX_DIFF_BYTES);
    let binary = looks_binary(&text);
    Ok(FileDiff { text, truncated: cut || out.truncated, binary })
}

// ---------------------------------------------------------------------------
// Branch summary (read-only: rev-list / diff --shortstat / status / log)
// ---------------------------------------------------------------------------

/// A ref name safe to pass as a revision argument: git's `check-ref-format` rules (no `..`, `@{`,
/// `~^:?*[\`, whitespace or control characters, no `.`-leading component, no `.lock` suffix) plus
/// no leading `-`, so it can never be read as an option.
pub fn is_valid_ref_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 200
        && name != "@"
        && !name.starts_with('-')
        && !name.starts_with('/')
        && !name.ends_with('/')
        && !name.ends_with('.')
        && !name.ends_with(".lock")
        && !name.contains("..")
        && !name.contains("@{")
        && !name.contains("//")
        && !name.chars().any(|c| c.is_control() || c.is_whitespace() || matches!(c, '~' | '^' | ':' | '?' | '*' | '[' | '\\'))
        && !name.split('/').any(|seg| seg.starts_with('.'))
}

/// `git rev-list --left-right --count A...B` → `(left, right)` = (only in A, only in B).
pub fn parse_left_right(s: &str) -> Option<(u32, u32)> {
    let mut it = s.split_whitespace();
    let left = it.next()?.parse().ok()?;
    let right = it.next()?.parse().ok()?;
    Some((left, right))
}

/// `git diff --shortstat` → `(files, insertions, deletions)`. Any part may be missing (" 1 file changed,
/// 2 deletions(-)"); empty output is all zeros. Parts are told apart by the `(+)` / `(-)` markers, so
/// translated git output parses too.
pub fn parse_shortstat(s: &str) -> (u32, u32, u32) {
    let (mut files, mut ins, mut del) = (0, 0, 0);
    for part in s.trim().split(',') {
        let Some(n) = part.split_whitespace().next().and_then(|w| w.parse::<u32>().ok()) else {
            continue;
        };
        if part.contains("(+)") {
            ins = n;
        } else if part.contains("(-)") {
            del = n;
        } else {
            files = n;
        }
    }
    (files, ins, del)
}

fn git_stdout_timeout(dir: &Path, args: &[&str], timeout: Duration) -> Option<String> {
    let out = run_git(dir, args, timeout)?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// A requested base: blank = none (use the default); anything else must be a valid ref name.
fn requested_base(base: Option<&str>) -> AppResult<Option<&str>> {
    let requested = base.map(str::trim).filter(|b| !b.is_empty());
    if let Some(b) = requested
        && !is_valid_ref_name(b)
    {
        return Err(AppError::Invalid(format!("Invalid base branch: {b:?}")));
    }
    Ok(requested)
}

fn names_commit(dir: &Path, rev: &str) -> bool {
    git_stdout(dir, &["rev-parse", "--verify", "--quiet", &format!("{rev}^{{commit}}")]).is_some_and(|s| !s.is_empty())
}

fn current_branch(dir: &Path) -> Option<String> {
    git_stdout(dir, &["symbolic-ref", "--quiet", "--short", "HEAD"]).filter(|b| !b.is_empty())
}

/// The base to measure against: the requested one, else the main worktree's branch. Only a base that
/// names a commit is returned.
fn resolve_base(dir: &Path, requested: Option<&str>) -> Option<String> {
    let base = match requested {
        Some(b) => Some(b.to_string()),
        None => git_stdout(dir, &["worktree", "list", "--porcelain"])
            .and_then(|s| parse_worktrees(&s).into_iter().next())
            .and_then(|w| w.branch),
    };
    base.filter(|b| names_commit(dir, b))
}

/// The worktree at `path` measured against `base` (default: the main worktree's branch).
/// A non-repository (or missing) folder is `is_repo: false`, not an error. Strictly read-only.
pub fn branch_summary(path: &str, base: Option<&str>) -> AppResult<BranchSummary> {
    let requested = requested_base(base)?;
    let Some(root) = repo_root(path)? else {
        return Ok(BranchSummary::default());
    };
    let dir = root.as_path();
    let mut out = BranchSummary { is_repo: true, ..Default::default() };
    out.branch = current_branch(dir);
    let has_head = names_commit(dir, "HEAD");
    out.base = resolve_base(dir, requested);

    if let Some(b) = out.base.as_deref()
        && has_head
        && out.branch.as_deref() != Some(b)
    {
        let range = format!("{b}...HEAD");
        if let Some((behind, ahead)) =
            git_stdout_timeout(dir, &["rev-list", "--left-right", "--count", &range], DIFF_TIMEOUT)
                .as_deref()
                .and_then(parse_left_right)
        {
            out.behind = behind;
            out.ahead = ahead;
        }
        if let Some(stat) = git_stdout_timeout(
            dir,
            &["diff", "--shortstat", "--no-color", "--no-ext-diff", "--no-textconv", &range],
            DIFF_TIMEOUT,
        ) {
            (out.files_changed, out.insertions, out.deletions) = parse_shortstat(&stat);
        }
    }

    if let Ok(st) = run_git_capped(dir, &["status", "--porcelain"], STATUS_TIMEOUT, MAX_STATUS_BYTES)
        && (st.truncated || st.status.is_some_and(|s| s.success()))
    {
        let n = st.stdout.split(|&b| b == b'\n').filter(|l| !l.iter().all(u8::is_ascii_whitespace)).count();
        out.uncommitted = u32::try_from(n).unwrap_or(u32::MAX);
    }

    if has_head && let Some(log) = git_stdout(dir, &["log", "-1", "--format=%s%x00%ct"]) {
        let (subject, time) = log.split_once('\0').unwrap_or((log.as_str(), ""));
        out.last_commit_subject = Some(subject.trim().to_string()).filter(|s| !s.is_empty());
        out.last_commit_ms = time.trim().parse::<u64>().ok().map(|secs| secs.saturating_mul(1000));
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Branch files (read-only: diff --numstat / --name-status / one-file diff over base...HEAD)
// ---------------------------------------------------------------------------

/// Longer committed-file lists are cut.
pub const MAX_BRANCH_FILES: usize = 2000;
const MAX_BRANCH_LIST_BYTES: usize = 4 * 1024 * 1024;

/// One record of `git diff --numstat -z`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NumstatEntry {
    pub path: String,
    pub orig_path: Option<String>,
    pub insertions: u32,
    pub deletions: u32,
    pub binary: bool,
}

/// Parse `git diff --numstat -z`: `ins\tdel\tpath\0`, or for a rename / copy `ins\tdel\t\0src\0dst\0`.
/// Binary files print `-\t-`. Incomplete trailing records are dropped.
pub fn parse_numstat_z(raw: &[u8]) -> Vec<NumstatEntry> {
    let text = String::from_utf8_lossy(raw);
    let mut out = Vec::new();
    let mut recs = text.split('\0');
    while let Some(rec) = recs.next() {
        if rec.is_empty() {
            continue;
        }
        let mut f = rec.splitn(3, '\t');
        let (Some(ins), Some(del), Some(path)) = (f.next(), f.next(), f.next()) else {
            continue;
        };
        let (orig_path, path) = if path.is_empty() {
            // The rename source and destination are the NEXT two records: always consume them.
            let (Some(src), Some(dst)) = (recs.next(), recs.next()) else {
                break;
            };
            if dst.is_empty() {
                continue;
            }
            (Some(src.to_string()).filter(|s| !s.is_empty()), dst.to_string())
        } else {
            (None, path.to_string())
        };
        let binary = ins == "-" && del == "-";
        out.push(NumstatEntry {
            path,
            orig_path,
            insertions: ins.parse().unwrap_or(0),
            deletions: del.parse().unwrap_or(0),
            binary,
        });
    }
    out
}

/// Parse `git diff --name-status -z`: `X\0path\0`, or `R<score>\0src\0dst\0` / `C<score>\0src\0dst\0`.
/// Returns `(status letter, orig_path, path)`.
pub fn parse_name_status_z(raw: &[u8]) -> Vec<(String, Option<String>, String)> {
    let text = String::from_utf8_lossy(raw);
    let mut out = Vec::new();
    let mut recs = text.split('\0');
    while let Some(rec) = recs.next() {
        let Some(letter) = rec.chars().next().filter(char::is_ascii_alphabetic) else {
            continue;
        };
        let entry = if matches!(letter, 'R' | 'C') {
            let (Some(src), Some(dst)) = (recs.next(), recs.next()) else {
                break;
            };
            (letter.to_string(), Some(src.to_string()), dst.to_string())
        } else {
            let Some(path) = recs.next() else {
                break;
            };
            (letter.to_string(), None, path.to_string())
        };
        if !entry.2.is_empty() {
            out.push(entry);
        }
    }
    out
}

/// Join numstat (line counts, the list's order) with name-status (letters) by destination path and
/// cap at `cap` files. A file missing from name-status is "R" when renamed, else "M".
pub fn merge_branch_files(
    numstat: Vec<NumstatEntry>,
    status: Vec<(String, Option<String>, String)>,
    cap: usize,
) -> (Vec<BranchFile>, bool) {
    let letters: std::collections::HashMap<String, String> = status.into_iter().map(|(s, _, p)| (p, s)).collect();
    let truncated = numstat.len() > cap;
    let files = numstat
        .into_iter()
        .take(cap)
        .map(|n| {
            let status = letters
                .get(&n.path)
                .cloned()
                .unwrap_or_else(|| if n.orig_path.is_some() { "R".into() } else { "M".into() });
            BranchFile {
                path: n.path,
                orig_path: n.orig_path,
                status,
                insertions: n.insertions,
                deletions: n.deletions,
                binary: n.binary,
            }
        })
        .collect();
    (files, truncated)
}

/// stdout of a capped list command; a cut output keeps only its complete NUL-terminated records.
fn complete_records(out: process::CappedOutput, what: &str) -> AppResult<Vec<u8>> {
    if !out.truncated && !out.status.is_some_and(|s| s.success()) {
        let msg = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(AppError::Other(format!("git {what} failed: {}", crate::redact::redact(&msg))));
    }
    let mut bytes = out.stdout;
    if out.truncated {
        let end = bytes.iter().rposition(|&b| b == 0).map(|i| i + 1).unwrap_or(0);
        bytes.truncate(end);
    }
    Ok(bytes)
}

/// The files the commits on HEAD changed since it left `base` (default: the main worktree's branch),
/// with line counts. Empty when HEAD is the base or no base resolves; a non-repository is
/// `is_repo: false`, not an error. Strictly read-only.
pub fn branch_files(path: &str, base: Option<&str>) -> AppResult<BranchFiles> {
    let requested = requested_base(base)?;
    let Some(root) = repo_root(path)? else {
        return Ok(BranchFiles::default());
    };
    let dir = root.as_path();
    let mut out = BranchFiles { is_repo: true, ..Default::default() };
    out.branch = current_branch(dir);
    out.base = resolve_base(dir, requested);
    let Some(b) = out.base.clone() else {
        return Ok(out);
    };
    if out.branch.as_deref() == Some(b.as_str()) || !names_commit(dir, "HEAD") {
        return Ok(out);
    }
    out.ahead = git_stdout_timeout(dir, &["rev-list", "--count", &format!("{b}..HEAD")], DIFF_TIMEOUT)
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);

    let range = format!("{b}...HEAD");
    let list = |mode: &str| -> AppResult<Vec<u8>> {
        let args = ["diff", mode, "-z", "-M", "--no-color", "--no-ext-diff", "--no-textconv", range.as_str()];
        let o = run_git_capped(dir, &args, DIFF_TIMEOUT, MAX_BRANCH_LIST_BYTES)?;
        complete_records(o, &format!("diff {mode}"))
    };
    let numstat = parse_numstat_z(&list("--numstat")?);
    // Letters are cosmetic: a failed name-status still yields the list (M / R).
    let status = list("--name-status").map(|b| parse_name_status_z(&b)).unwrap_or_default();
    (out.files, out.truncated) = merge_branch_files(numstat, status, MAX_BRANCH_FILES);
    Ok(out)
}

/// Unified diff of one file over `base...HEAD` (what the branch's commits did to it). `orig_file`, a
/// rename source, is added to the pathspec so git pairs the rename. Read-only; capped at
/// [`MAX_DIFF_BYTES`].
pub fn branch_file_diff(path: &str, base: &str, file: &str, orig_file: Option<&str>) -> AppResult<FileDiff> {
    validate_repo_relative(file)?;
    let orig = orig_file.map(str::trim).filter(|o| !o.is_empty() && *o != file);
    if let Some(o) = orig {
        validate_repo_relative(o)?;
    }
    let base = base.trim();
    if !is_valid_ref_name(base) {
        return Err(AppError::Invalid(format!("Invalid base branch: {base:?}")));
    }
    let Some(root) = repo_root(path)? else {
        return Err(AppError::Invalid(format!("Not a git repository: {path}")));
    };
    if !names_commit(&root, base) {
        return Err(AppError::Invalid(format!("Unknown base branch: {base:?}")));
    }
    let range = format!("{base}...HEAD");
    let mut args = vec!["diff", "--no-color", "--no-ext-diff", "--no-textconv", "-M", range.as_str(), "--", file];
    if let Some(o) = orig {
        args.push(o);
    }
    run_file_diff(&root, &args)
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
        assert_eq!(w[0].path, if cfg!(windows) { r"D:\repo" } else { "D:/repo" });
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
    fn parses_shortstat() {
        assert_eq!(parse_shortstat(" 3 files changed, 10 insertions(+), 2 deletions(-)\n"), (3, 10, 2));
        assert_eq!(parse_shortstat(" 1 file changed, 1 insertion(+)"), (1, 1, 0));
        assert_eq!(parse_shortstat(" 1 file changed, 4 deletions(-)"), (1, 0, 4));
        assert_eq!(parse_shortstat(" 2 files changed"), (2, 0, 0));
        assert_eq!(parse_shortstat(""), (0, 0, 0));
        assert_eq!(parse_shortstat("garbage"), (0, 0, 0));
        // Translated output still parses by the (+)/(-) markers.
        assert_eq!(parse_shortstat(" 2 Dateien geändert, 5 Zeilen hinzugefügt(+), 1 Zeile entfernt(-)"), (2, 5, 1));
    }

    #[test]
    fn parses_left_right() {
        assert_eq!(parse_left_right("2\t5\n"), Some((2, 5)));
        assert_eq!(parse_left_right("0 0"), Some((0, 0)));
        assert_eq!(parse_left_right("7"), None);
        assert_eq!(parse_left_right(""), None);
        assert_eq!(parse_left_right("a\tb"), None);
    }

    #[test]
    fn parses_numstat_z() {
        let raw = concat!(
            "10\t2\tsrc/main file.rs\0",
            "5\t1\t\0docs/old name.md\0docs/new name.md\0",
            "-\t-\tassets/logo.png\0",
            "0\t7\tgone.txt\0",
        );
        let n = parse_numstat_z(raw.as_bytes());
        assert_eq!(n.len(), 4, "{n:?}");
        assert_eq!(
            n[0],
            NumstatEntry { path: "src/main file.rs".into(), orig_path: None, insertions: 10, deletions: 2, binary: false }
        );
        assert_eq!(n[1].path, "docs/new name.md");
        assert_eq!(n[1].orig_path.as_deref(), Some("docs/old name.md"));
        assert_eq!((n[1].insertions, n[1].deletions), (5, 1));
        assert!(n[2].binary && n[2].insertions == 0 && n[2].deletions == 0);
        assert_eq!(n[2].path, "assets/logo.png");
        assert_eq!((n[3].insertions, n[3].deletions, n[3].binary), (0, 7, false));

        // A tab inside a file name stays part of the path.
        let t = parse_numstat_z(b"1\t0\ta\tb.txt\0");
        assert_eq!(t[0].path, "a\tb.txt");
        // A rename cut before its destination is dropped, not misread.
        assert!(parse_numstat_z(b"1\t1\t\0old.txt\0").is_empty());
        assert!(parse_numstat_z(b"").is_empty());
        assert!(parse_numstat_z(b"garbage\0").is_empty());
    }

    #[test]
    fn parses_name_status_z() {
        let raw = b"M\0src/a.rs\0R087\0old.md\0new.md\0A\0b.bin\0D\0gone.txt\0C100\0x.txt\0y.txt\0";
        let s = parse_name_status_z(raw);
        assert_eq!(
            s,
            vec![
                ("M".into(), None, "src/a.rs".into()),
                ("R".into(), Some("old.md".into()), "new.md".into()),
                ("A".into(), None, "b.bin".into()),
                ("D".into(), None, "gone.txt".into()),
                ("C".into(), Some("x.txt".into()), "y.txt".into()),
            ]
        );
        // Cut mid-record: complete records kept.
        assert_eq!(parse_name_status_z(b"M\0a\0R100\0old\0").len(), 1);
    }

    #[test]
    fn merges_and_caps_branch_files() {
        let numstat = parse_numstat_z(b"1\t0\tnew.txt\0" as &[u8]);
        let numstat = [numstat, parse_numstat_z(b"2\t2\t\0a.md\0b.md\0-\t-\tlogo.png\0x\t0\tq\0")].concat();
        let status = parse_name_status_z(b"A\0new.txt\0R090\0a.md\0b.md\0");
        let (files, cut) = merge_branch_files(numstat.clone(), status.clone(), 100);
        assert!(!cut);
        assert_eq!(files.len(), 4);
        assert_eq!(files[0].status, "A");
        assert_eq!((files[1].status.as_str(), files[1].orig_path.as_deref()), ("R", Some("a.md")));
        // Not in name-status: M (R for renames); numbers that fail to parse are 0.
        assert_eq!(files[2].status, "M");
        assert!(files[2].binary);
        assert_eq!((files[3].path.as_str(), files[3].insertions), ("q", 0));
        let (files, cut) = merge_branch_files(numstat, status, 2);
        assert!(cut);
        assert_eq!(files.len(), 2);
    }

    #[test]
    fn branch_files_on_a_real_repo_and_worktree() {
        if git_exe().is_none() {
            eprintln!("git not installed; skipping");
            return;
        }
        let commit = |dir: &Path, msg: &str| {
            git(dir, &["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", msg]);
        };
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-q", "-b", "main"]);
        let long: String = (0..30).map(|i| format!("line {i} of the document\n")).collect();
        std::fs::write(repo.join("a.txt"), "one\ntwo\n").unwrap();
        std::fs::write(repo.join("old name.md"), &long).unwrap();
        std::fs::write(repo.join("gone.txt"), "g\n").unwrap();
        git(&repo, &["add", "."]);
        commit(&repo, "init");

        let wt = tmp.path().join("wt");
        git(&repo, &["worktree", "add", "-q", "-b", "feature", &wt.to_string_lossy()]);
        std::fs::write(wt.join("a.txt"), "one\nTWO\nthree\n").unwrap();
        git(&wt, &["mv", "old name.md", "new name.md"]);
        std::fs::write(wt.join("new name.md"), format!("{long}one more\n")).unwrap();
        git(&wt, &["rm", "-q", "gone.txt"]);
        std::fs::write(wt.join("logo.bin"), [0u8, 159, 146, 150, 0, 1, 2, 3]).unwrap();
        git(&wt, &["add", "-A"]);
        commit(&wt, "feature work");
        git(&wt, &["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "--allow-empty", "-m", "empty"]);
        // main moves on: not part of the branch's work (three-dot).
        std::fs::write(repo.join("c.txt"), "c\n").unwrap();
        git(&repo, &["add", "c.txt"]);
        commit(&repo, "main moves");
        // Uncommitted in the worktree: not listed here either.
        std::fs::write(wt.join("dirty.txt"), "d\n").unwrap();

        let wt_s = wt.to_string_lossy().into_owned();
        let b = branch_files(&wt_s, None).unwrap();
        assert!(b.is_repo && !b.truncated);
        assert_eq!(b.branch.as_deref(), Some("feature"));
        assert_eq!(b.base.as_deref(), Some("main"));
        assert_eq!(b.ahead, 2);
        let by = |p: &str| b.files.iter().find(|f| f.path == p).unwrap_or_else(|| panic!("{p} missing: {:?}", b.files));
        assert_eq!(b.files.len(), 4, "{:?}", b.files);
        let a = by("a.txt");
        assert_eq!((a.status.as_str(), a.insertions, a.deletions, a.binary), ("M", 2, 1, false));
        let r = by("new name.md");
        assert_eq!((r.status.as_str(), r.orig_path.as_deref(), r.insertions, r.deletions), ("R", Some("old name.md"), 1, 0));
        assert_eq!(by("gone.txt").status, "D");
        let bin = by("logo.bin");
        assert_eq!((bin.status.as_str(), bin.binary), ("A", true));
        assert!(!b.files.iter().any(|f| f.path == "c.txt" || f.path == "dirty.txt"));
        assert_eq!(branch_files(&wt_s, Some("main")).unwrap(), b);

        // One-file diffs over main...HEAD.
        let d = branch_file_diff(&wt_s, "main", "a.txt", None).unwrap();
        assert!(d.text.contains("+TWO") && d.text.contains("-two"), "{}", d.text);
        assert!(!d.truncated && !d.binary);
        let d = branch_file_diff(&wt_s, "main", "new name.md", Some("old name.md")).unwrap();
        assert!(d.text.contains("rename from old name.md") && d.text.contains("+one more"), "{}", d.text);
        let d = branch_file_diff(&wt_s, "main", "logo.bin", None).unwrap();
        assert!(d.binary, "{}", d.text);
        let d = branch_file_diff(&wt_s, "main", "c.txt", None).unwrap();
        assert!(d.text.is_empty(), "main's own change is not the branch's: {}", d.text);
        assert!(matches!(branch_file_diff(&wt_s, "main", "../x", None), Err(AppError::Invalid(_))));
        assert!(matches!(branch_file_diff(&wt_s, "main", "a.txt", Some("-p")), Err(AppError::Invalid(_))));
        assert!(matches!(branch_file_diff(&wt_s, "--output=x", "a.txt", None), Err(AppError::Invalid(_))));
        assert!(matches!(branch_file_diff(&wt_s, "no-such-branch", "a.txt", None), Err(AppError::Invalid(_))));

        // The main worktree is the base: nothing committed "on top".
        let m = branch_files(&repo.to_string_lossy(), None).unwrap();
        assert_eq!((m.branch.as_deref(), m.base.as_deref(), m.ahead), (Some("main"), Some("main"), 0));
        assert!(m.files.is_empty());
        // Unresolvable base: no list; invalid base: error; not a repository: default.
        let none = branch_files(&wt_s, Some("no-such-branch")).unwrap();
        assert!(none.is_repo && none.base.is_none() && none.files.is_empty());
        assert!(matches!(branch_files(&wt_s, Some("a..b")), Err(AppError::Invalid(_))));
        let plain = tmp.path().join("plain");
        std::fs::create_dir_all(&plain).unwrap();
        assert_eq!(branch_files(&plain.to_string_lossy(), None).unwrap(), BranchFiles::default());
    }

    #[test]
    fn validates_ref_names() {
        for ok in ["main", "origin/main", "feature/x-1", "v1.0", "HEAD", "release_2026"] {
            assert!(is_valid_ref_name(ok), "{ok}");
        }
        for bad in [
            "", "-x", "--output=x", "a..b", "main...HEAD", "a b", "a\tb", "a~1", "a^", "a:b", "a?", "a*", "a[",
            "a\\b", "@", "x@{1}", ".hidden", "a/.b", "a/", "/a", "a//b", "a.", "a.lock", "a\0b",
        ] {
            assert!(!is_valid_ref_name(bad), "{bad:?}");
        }
    }

    #[test]
    fn branch_summary_on_a_real_repo_and_worktree() {
        if git_exe().is_none() {
            eprintln!("git not installed; skipping");
            return;
        }
        let commit = |dir: &Path, msg: &str| {
            git(dir, &["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", msg]);
        };
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-q", "-b", "main"]);
        std::fs::write(repo.join("a.txt"), "one\ntwo\n").unwrap();
        git(&repo, &["add", "a.txt"]);
        commit(&repo, "init");

        let wt = tmp.path().join("wt");
        git(&repo, &["worktree", "add", "-q", "-b", "feature", &wt.to_string_lossy()]);
        // feature: 2 commits touching 2 files (+4 -1).
        std::fs::write(wt.join("a.txt"), "one\nTWO\n").unwrap();
        git(&wt, &["add", "a.txt"]);
        commit(&wt, "edit a");
        std::fs::write(wt.join("b.txt"), "x\ny\nz\n").unwrap();
        git(&wt, &["add", "b.txt"]);
        commit(&wt, "add b");
        // main moves on by one commit.
        std::fs::write(repo.join("c.txt"), "c\n").unwrap();
        git(&repo, &["add", "c.txt"]);
        commit(&repo, "main moves");
        // Uncommitted in the worktree: one modified, one untracked.
        std::fs::write(wt.join("a.txt"), "dirty\n").unwrap();
        std::fs::write(wt.join("new.txt"), "n\n").unwrap();

        let wt_s = wt.to_string_lossy().into_owned();
        let s = branch_summary(&wt_s, None).unwrap();
        assert!(s.is_repo);
        assert_eq!(s.branch.as_deref(), Some("feature"));
        assert_eq!(s.base.as_deref(), Some("main"));
        assert_eq!((s.ahead, s.behind), (2, 1), "{s:?}");
        assert_eq!((s.files_changed, s.insertions, s.deletions), (2, 4, 1), "{s:?}");
        assert_eq!(s.uncommitted, 2);
        assert_eq!(s.last_commit_subject.as_deref(), Some("add b"));
        assert!(s.last_commit_ms.is_some_and(|ms| ms > 1_600_000_000_000));

        // Explicit base, same answer; blank base = default.
        assert_eq!(branch_summary(&wt_s, Some("main")).unwrap(), s);
        assert_eq!(branch_summary(&wt_s, Some("  ")).unwrap(), s);

        // The main worktree against itself: base reported, counts zero.
        let main = branch_summary(&repo.to_string_lossy(), None).unwrap();
        assert_eq!(main.branch.as_deref(), Some("main"));
        assert_eq!(main.base.as_deref(), Some("main"));
        assert_eq!((main.ahead, main.behind, main.files_changed), (0, 0, 0));
        assert_eq!(main.last_commit_subject.as_deref(), Some("main moves"));

        // Unresolvable base: None, zeros (not an error). Invalid base: error.
        let none = branch_summary(&wt_s, Some("no-such-branch")).unwrap();
        assert_eq!(none.base, None);
        assert_eq!((none.ahead, none.behind, none.files_changed), (0, 0, 0));
        assert_eq!(none.uncommitted, 2);
        assert!(matches!(branch_summary(&wt_s, Some("--output=x")), Err(AppError::Invalid(_))));
        assert!(matches!(branch_summary(&wt_s, Some("main..feature")), Err(AppError::Invalid(_))));

        // Not a repository / missing folder: is_repo false, not an error.
        let plain = tmp.path().join("plain");
        std::fs::create_dir_all(&plain).unwrap();
        assert_eq!(branch_summary(&plain.to_string_lossy(), None).unwrap(), BranchSummary::default());
        let missing = tmp.path().join("definitely").join("missing");
        assert!(!branch_summary(&missing.to_string_lossy(), None).unwrap().is_repo);

        // A fresh repository without commits.
        let empty = tmp.path().join("empty");
        std::fs::create_dir_all(&empty).unwrap();
        git(&empty, &["init", "-q", "-b", "main"]);
        let e = branch_summary(&empty.to_string_lossy(), None).unwrap();
        assert!(e.is_repo);
        assert_eq!(e.last_commit_subject, None);
        assert_eq!((e.ahead, e.behind), (0, 0));
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
        let null_device = if cfg!(windows) { "NUL" } else { "/dev/null" };
        cmd.arg("-C").arg(dir).args(args).env("GIT_CONFIG_NOSYSTEM", "1").env("GIT_CONFIG_GLOBAL", null_device);
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
