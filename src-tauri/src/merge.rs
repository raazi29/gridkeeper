//! Merge assistant: merging a worktree's branch into its base in the main checkout. This is the
//! first git *write* operation in Gridkeeper (ADR-020); everything else in `git` is read-only.
//!
//! Guardrails:
//! - **Preview first, nothing written** (`preview`): commits, diffstat, fast-forward check and a
//!   conflict check with `git merge-tree --write-tree` (git >= 2.38; it only adds unreferenced
//!   objects to the object store). Older git: a temporary detached worktree in the temp folder,
//!   `merge --no-commit --no-ff`, `merge --abort`, then the worktree is removed.
//! - **Refusals, never repairs**: the main checkout must have the base checked out, no tracked
//!   changes, no merge / rebase / cherry-pick / revert / bisect in progress and no `index.lock`. The
//!   assistant never checks out, stashes, resets a branch, forces, rewrites history or deletes a
//!   branch on its own.
//! - **Pinned commits**: the request carries the previewed base and branch SHAs; if either branch
//!   moved, the merge is refused. The merge names the branch's SHA, so exactly the previewed (and
//!   tested) commit is merged.
//! - **Exact commands** (`plan`): the same argv lists are shown to the user and executed.
//! - **Never mid-merge**: a failed step is followed by `merge --abort` (or `reset --merge` after a
//!   squash, which never moves HEAD) and a check that HEAD is the old base and the checkout is clean.
//! - **Clean-up is separate** (`cleanup_plan` / `cleanup`): `git worktree remove` (never `--force`)
//!   and `git branch -d` (never `-D`), after unlinking junctions / symlinks inside the worktree:
//!   Git for Windows' `worktree remove` follows a directory junction and deletes the target's
//!   contents (verified with 2.51: a `node_modules` junction to the main checkout would empty it).
//! - Every git write runs in a `ProcessContainer` with a time limit, so a hung hook cannot outlive it.

use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use once_cell::sync::Lazy;
use parking_lot::Mutex;

use crate::adapters::process;
use crate::git;
use crate::types::*;

/// Time limit of one git write (hooks such as pre-commit may run linters).
const WRITE_TIMEOUT: Duration = Duration::from_secs(300);
const CHECK_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_PREVIEW_FILES: usize = 500;
const MAX_COMMITS: usize = 200;
const STEP_OUTPUT_CAP: usize = 8 * 1024;
pub const MAX_MESSAGE_LEN: usize = 500;
/// A worktree with more entries than this is not scanned for links (the clean-up is refused).
const MAX_SCAN_ENTRIES: usize = 400_000;

/// One merge or clean-up at a time.
static WRITE_LOCK: Mutex<()> = Mutex::new(());

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/// `git version 2.51.0.windows.1` → (2, 51, 0).
pub fn parse_git_version(s: &str) -> Option<(u32, u32, u32)> {
    let v = s.trim().strip_prefix("git version ")?;
    let mut it = v.split(|c: char| !c.is_ascii_digit()).filter(|p| !p.is_empty()).map(|p| p.parse::<u32>().ok());
    let major = it.next()??;
    let minor = it.next()??;
    let patch = it.next().flatten().unwrap_or(0);
    Some((major, minor, patch))
}

/// `git merge-tree --write-tree` exists from git 2.38.
pub fn supports_write_tree(v: (u32, u32, u32)) -> bool {
    v >= (2, 38, 0)
}

fn git_version() -> Option<String> {
    static V: Lazy<Option<String>> = Lazy::new(|| {
        let exe = git::git_exe()?;
        let out = process::run_with_timeout(
            {
                let mut c = process::hidden_command(exe);
                c.arg("--version");
                c
            },
            git::QUICK_TIMEOUT,
        )
        .ok()?;
        out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
    });
    V.clone()
}

pub fn is_sha(s: &str) -> bool {
    (s.len() == 40 || s.len() == 64) && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// The commit message of a merge commit / squash: one line, at most 500 characters. Ignored (empty)
/// for a fast-forward.
pub fn validate_message(strategy: MergeStrategy, message: &str) -> AppResult<String> {
    if strategy == MergeStrategy::FastForward {
        return Ok(String::new());
    }
    let m = message.trim();
    if m.is_empty() {
        return Err(AppError::Invalid("The commit message is empty".into()));
    }
    if m.chars().count() > MAX_MESSAGE_LEN {
        return Err(AppError::Invalid(format!("The commit message is longer than {MAX_MESSAGE_LEN} characters")));
    }
    if m.chars().any(char::is_control) {
        return Err(AppError::Invalid("The commit message must be a single line".into()));
    }
    Ok(m.to_string())
}

/// The git arguments (after `git -C <main checkout>`) a merge runs, in order.
pub fn merge_steps(strategy: MergeStrategy, message: &str, branch_sha: &str) -> Vec<Vec<String>> {
    let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<String>>();
    match strategy {
        MergeStrategy::FastForward => vec![s(&["merge", "--ff-only", branch_sha])],
        MergeStrategy::MergeCommit => vec![s(&["merge", "--no-ff", "--no-edit", "-m", message, branch_sha])],
        MergeStrategy::Squash => vec![s(&["merge", "--squash", branch_sha]), s(&["commit", "-m", message])],
    }
}

/// What runs when a step fails (a failed `--ff-only` changes nothing).
pub fn rollback_steps(strategy: MergeStrategy) -> Vec<Vec<String>> {
    match strategy {
        MergeStrategy::FastForward => vec![],
        MergeStrategy::MergeCommit => vec![vec!["merge".into(), "--abort".into()]],
        MergeStrategy::Squash => vec![vec!["reset".into(), "--merge".into()]],
    }
}

/// One argument as a reader would type it: bare when it is plain, else in double quotes.
pub fn quote_arg(a: &str) -> String {
    let plain = !a.is_empty() && a.chars().all(|c| c.is_ascii_alphanumeric() || "-_./\\:@=+,".contains(c));
    if plain { a.to_string() } else { format!("\"{}\"", a.replace('"', "\\\"")) }
}

/// `git -C "<dir>" <args…>` for display.
pub fn display_command(dir: &str, args: &[String]) -> String {
    let mut s = format!("git -C {}", quote_arg(dir));
    for a in args {
        s.push(' ');
        s.push_str(&quote_arg(a));
    }
    s
}

/// The commands of a merge request, exactly as `execute` runs them.
pub fn plan(req: &MergeRequest) -> AppResult<MergePlan> {
    if !is_sha(&req.branch_sha) {
        return Err(AppError::Invalid("Invalid branch commit".into()));
    }
    let message = validate_message(req.strategy, &req.message)?;
    let main = req.main_path.trim();
    if main.is_empty() {
        return Err(AppError::Invalid("No main checkout".into()));
    }
    Ok(MergePlan {
        main_path: main.to_string(),
        commands: merge_steps(req.strategy, &message, &req.branch_sha).iter().map(|a| display_command(main, a)).collect(),
        on_failure: rollback_steps(req.strategy).iter().map(|a| display_command(main, a)).collect(),
    })
}

/// Parse `git merge-tree --write-tree -z [--name-only] <a> <b>` output (exit code 0 or 1): the tree
/// OID, then the conflicted files (`<mode> <oid> <stage>\t<path>` per stage, or bare paths with
/// `--name-only`), then — after an empty record — informational records
/// `<n>\0<path>…\0<type>\0<message>\0`. Conflicted paths get their `CONFLICT (<kind>)` kind.
/// Returns `None` when the first record is not an object id.
pub fn parse_merge_tree_z(raw: &[u8]) -> Option<(String, Vec<MergeConflict>)> {
    let text = String::from_utf8_lossy(raw);
    let mut recs = text.split('\0');
    let tree = recs.next()?.trim().to_string();
    if !is_sha(&tree) {
        return None;
    }
    let mut conflicts: Vec<MergeConflict> = Vec::new();
    for rec in recs.by_ref() {
        if rec.is_empty() {
            break;
        }
        let path = match rec.split_once('\t') {
            Some((meta, p)) if meta.split(' ').count() == 3 && meta.split(' ').all(|f| !f.is_empty()) => p,
            _ => rec,
        };
        if !conflicts.iter().any(|c| c.path == path) {
            conflicts.push(MergeConflict { path: path.to_string(), kind: "conflict".into() });
        }
    }
    // Informational messages: kinds for the conflicted paths.
    while let Some(n) = recs.next() {
        let Ok(n) = n.trim().parse::<usize>() else { break };
        let paths: Vec<&str> = recs.by_ref().take(n).collect();
        let (Some(kind), Some(_msg)) = (recs.next(), recs.next()) else { break };
        let Some(k) = kind.strip_prefix("CONFLICT (").and_then(|k| k.strip_suffix(')')) else { continue };
        let k = if k == "contents" { "content" } else { k };
        for p in paths {
            if let Some(c) = conflicts.iter_mut().find(|c| c.path == p && c.kind == "conflict") {
                c.kind = k.to_string();
            }
        }
    }
    Some((tree, conflicts))
}

/// `git log --format=%H%x00%s%x00%an%x00%ct` (one commit per line).
pub fn parse_commits(text: &str) -> Vec<MergeCommitInfo> {
    text.lines()
        .filter_map(|l| {
            let mut f = l.splitn(4, '\0');
            let sha = f.next()?.trim().to_string();
            if !is_sha(&sha) {
                return None;
            }
            let subject = f.next().unwrap_or("").to_string();
            let author = f.next().unwrap_or("").to_string();
            let time_ms = f.next().and_then(|t| t.trim().parse::<u64>().ok()).map(|s| s.saturating_mul(1000)).unwrap_or(0);
            Some(MergeCommitInfo { sha, subject, author, time_ms })
        })
        .collect()
}

// ---------------------------------------------------------------------------
// git plumbing
// ---------------------------------------------------------------------------

fn rev(dir: &Path, refname: &str) -> Option<String> {
    git::git_stdout(dir, &["rev-parse", "--verify", "--quiet", &format!("{refname}^{{commit}}")])
        .filter(|s| is_sha(s))
}

fn branch_ref(name: &str) -> String {
    format!("refs/heads/{name}")
}

/// `merge-base --is-ancestor a b`: Some(true / false), None when git failed.
fn is_ancestor(dir: &Path, a: &str, b: &str) -> Option<bool> {
    let out = git::run_git(dir, &["merge-base", "--is-ancestor", a, b], git::DIFF_TIMEOUT)?;
    match out.status.code() {
        Some(0) => Some(true),
        Some(1) => Some(false),
        _ => None,
    }
}

fn count_lines(raw: &[u8]) -> u32 {
    raw.split(|&b| b == b'\n').filter(|l| !l.iter().all(u8::is_ascii_whitespace)).count() as u32
}

fn status_count(dir: &Path, tracked_only: bool) -> Option<u32> {
    let args: &[&str] = if tracked_only { &["status", "--porcelain", "--untracked-files=no"] } else { &["status", "--porcelain"] };
    let out = git::run_git_capped(dir, args, git::STATUS_TIMEOUT, git::MAX_STATUS_BYTES).ok()?;
    if out.truncated {
        return Some(u32::MAX);
    }
    out.status.is_some_and(|s| s.success()).then(|| count_lines(&out.stdout))
}

fn worktrees(dir: &Path) -> Vec<WorktreeInfo> {
    git::git_stdout(dir, &["worktree", "list", "--porcelain"]).map(|s| git::parse_worktrees(&s)).unwrap_or_default()
}

/// The main checkout's git directory (absolute).
fn git_dir(main: &Path) -> Option<PathBuf> {
    let d = git::git_stdout(main, &["rev-parse", "--git-dir"])?;
    let p = PathBuf::from(git::win_path(&d));
    Some(if p.is_absolute() { p } else { main.join(p) })
}

/// Why the main checkout cannot take a merge into `base` right now (empty = it can).
fn main_checkout_blockers(main: &Path, main_branch: Option<&str>, base: &str) -> Vec<String> {
    let shown = main.display();
    let mut out = Vec::new();
    if main_branch != Some(base) {
        let what = match main_branch {
            Some(b) => format!("“{b}”"),
            None => "a detached HEAD".into(),
        };
        out.push(format!(
            "The main checkout ({shown}) has {what} checked out, not “{base}”. Check out “{base}” there yourself; the merge assistant never switches branches."
        ));
    }
    if let Some(gd) = git_dir(main) {
        let busy = [
            ("MERGE_HEAD", "A merge"),
            ("CHERRY_PICK_HEAD", "A cherry-pick"),
            ("REVERT_HEAD", "A revert"),
            ("REBASE_HEAD", "A rebase"),
            ("rebase-merge", "A rebase"),
            ("rebase-apply", "A rebase or am"),
            ("BISECT_LOG", "A bisect"),
        ];
        if let Some((_, what)) = busy.iter().find(|(f, _)| gd.join(f).exists()) {
            out.push(format!("{what} is in progress in the main checkout ({shown}). Finish or abort it yourself first."));
        }
        if gd.join("index.lock").exists() {
            out.push(format!(
                "Another git process is using the main checkout ({shown}): index.lock exists. Wait for it (or remove a stale lock yourself)."
            ));
        }
    } else {
        out.push(format!("Could not read the main checkout's git folder ({shown})."));
    }
    match status_count(main, true) {
        Some(0) => {}
        Some(n) => out.push(format!(
            "The main checkout ({shown}) has {} to tracked files. Commit or stash them yourself first; a merge starts from a clean checkout.",
            if n == u32::MAX { "many uncommitted changes".to_string() } else if n == 1 { "1 uncommitted change".into() } else { format!("{n} uncommitted changes") }
        )),
        None => out.push(format!("Could not read the status of the main checkout ({shown}).")),
    }
    out
}

enum CheckError {
    Unrelated,
    Failed(String),
}

fn stderr_text(b: &[u8]) -> String {
    crate::redact::redact(String::from_utf8_lossy(b).trim())
}

fn merge_tree_check(dir: &Path, base_sha: &str, branch_sha: &str) -> Result<(bool, Vec<MergeConflict>), CheckError> {
    let out = git::run_git_capped(dir, &["merge-tree", "--write-tree", "-z", "--name-only", base_sha, branch_sha], CHECK_TIMEOUT, 8 << 20)
        .map_err(|e| CheckError::Failed(e.to_string()))?;
    let code = out.status.and_then(|s| s.code());
    match code {
        Some(0) | Some(1) if !out.truncated => {
            let (_, conflicts) = parse_merge_tree_z(&out.stdout).ok_or_else(|| CheckError::Failed("unexpected merge-tree output".into()))?;
            Ok((code == Some(0), conflicts))
        }
        _ => {
            let err = stderr_text(&out.stderr);
            if err.contains("unrelated histories") { Err(CheckError::Unrelated) } else { Err(CheckError::Failed(err)) }
        }
    }
}

/// A temporary detached worktree (git < 2.38 conflict check), removed on drop.
struct TempWorktree {
    main: PathBuf,
    path: PathBuf,
}

impl Drop for TempWorktree {
    fn drop(&mut self) {
        if self.path.exists() {
            if let Ok(links) = find_links(&self.path) {
                let _ = unlink_all(&links);
            }
            let p = self.path.to_string_lossy().into_owned();
            let _ = git::run_git(&self.main, &["worktree", "remove", "--force", "--", &p], CHECK_TIMEOUT);
            if self.path.exists() {
                // std's remove_dir_all does not follow links.
                let _ = std::fs::remove_dir_all(&self.path);
            }
        }
        let _ = git::run_git(&self.main, &["worktree", "prune"], git::QUICK_TIMEOUT);
    }
}

/// Conflict check for git < 2.38: a detached worktree of the base in the temp folder, a trial merge,
/// `merge --abort`, then the worktree is removed. Also exercised by the tests on newer git.
fn temp_worktree_check(main: &Path, base_sha: &str, branch_sha: &str) -> Result<(bool, Vec<MergeConflict>), CheckError> {
    let path = std::env::temp_dir().join(format!("gridkeeper-merge-check-{}", uuid::Uuid::new_v4().simple()));
    let p = path.to_string_lossy().into_owned();
    let out = git::run_git(main, &["worktree", "add", "--detach", "--", &p, base_sha], CHECK_TIMEOUT)
        .ok_or_else(|| CheckError::Failed("git worktree add did not complete".into()))?;
    let _guard = TempWorktree { main: main.to_path_buf(), path: path.clone() };
    if !out.status.success() {
        return Err(CheckError::Failed(stderr_text(&out.stderr)));
    }
    let merged = git::run_git(
        &path,
        &["-c", "user.name=Gridkeeper", "-c", "user.email=gridkeeper@localhost", "merge", "--no-commit", "--no-ff", branch_sha],
        CHECK_TIMEOUT,
    )
    .ok_or_else(|| CheckError::Failed("git merge did not complete".into()))?;
    let result = if merged.status.success() {
        Ok((true, Vec::new()))
    } else {
        let names = git::run_git(&path, &["diff", "--name-only", "--diff-filter=U", "-z"], git::DIFF_TIMEOUT)
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).split('\0').filter(|s| !s.is_empty()).map(str::to_string).collect::<Vec<_>>())
            .unwrap_or_default();
        if !names.is_empty() {
            Ok((false, names.into_iter().map(|path| MergeConflict { path, kind: "conflict".into() }).collect()))
        } else {
            let err = stderr_text(&merged.stderr);
            if err.contains("unrelated histories") { Err(CheckError::Unrelated) } else { Err(CheckError::Failed(err)) }
        }
    };
    let _ = git::run_git(&path, &["merge", "--abort"], git::DIFF_TIMEOUT);
    result
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

/// What merging the branch of the worktree at `path` into `base` (default: the main checkout's
/// branch) would do. Writes nothing (merge-tree only adds unreferenced objects). Refusal reasons are
/// in `blockers`, not errors; an invalid base or a non-repository is an error.
pub fn preview(path: &str, base: Option<&str>) -> AppResult<MergePreview> {
    let requested = git::requested_base(base)?;
    let root = git::repo_root(path)?.ok_or_else(|| AppError::Invalid(format!("Not a git repository: {path}")))?;
    let dir = root.as_path();
    let mut p = MergePreview { path: root.to_string_lossy().into_owned(), git_version: git_version(), ..Default::default() };
    p.branch = git::current_branch(dir);
    let main = worktrees(dir).into_iter().next();
    p.main_path = main.as_ref().map(|m| m.path.clone());
    p.main_branch = main.as_ref().and_then(|m| m.branch.clone());
    p.base = requested.map(str::to_string).or_else(|| p.main_branch.clone());
    p.base_sha = p.base.as_deref().and_then(|b| rev(dir, &branch_ref(b)));
    p.branch_sha = p.branch.as_deref().and_then(|b| rev(dir, &branch_ref(b)));
    p.worktree_uncommitted = status_count(dir, false).unwrap_or(0);

    let Some(branch) = p.branch.clone() else {
        p.blockers.push(format!("HEAD in {} is not on a branch (detached, or no commits yet): the merge assistant merges a branch.", p.path));
        return Ok(p);
    };
    let Some(base) = p.base.clone() else {
        p.blockers.push("No base branch: the main checkout has no branch checked out.".into());
        return Ok(p);
    };
    let (Some(base_sha), Some(branch_sha)) = (p.base_sha.clone(), p.branch_sha.clone()) else {
        p.blockers.push(format!("“{base}” or “{branch}” is not a local branch with commits."));
        return Ok(p);
    };
    if branch == base {
        p.blockers.push(format!("This worktree is on “{base}” itself: there is nothing to merge."));
        return Ok(p);
    }
    let Some(main) = main else {
        p.blockers.push("Could not find the main checkout (git worktree list).".into());
        return Ok(p);
    };
    let main_dir = PathBuf::from(&main.path);
    if git::same_path(&main_dir, dir) {
        p.blockers.push(format!(
            "This session works in the main checkout itself (on “{branch}”). Merging needs the branch in its own worktree and “{base}” in the main checkout."
        ));
        return Ok(p);
    }
    p.blockers.extend(main_checkout_blockers(&main_dir, main.branch.as_deref(), &base));

    let range = format!("{base_sha}...{branch_sha}");
    if let Some((behind, ahead)) =
        git::git_stdout_timeout(dir, &["rev-list", "--left-right", "--count", &range], git::DIFF_TIMEOUT).as_deref().and_then(git::parse_left_right)
    {
        p.behind = behind;
        p.ahead = ahead;
    }
    if p.ahead == 0 {
        p.blockers.push(format!("Nothing to merge: “{branch}” has no commits that “{base}” does not have."));
        return Ok(p);
    }
    if let Some(stat) = git::git_stdout_timeout(dir, &["diff", "--shortstat", "--no-color", "--no-ext-diff", "--no-textconv", &range], git::DIFF_TIMEOUT) {
        (p.files_changed, p.insertions, p.deletions) = git::parse_shortstat(&stat);
    }
    let list = |mode: &str| -> Option<Vec<u8>> {
        let args = ["diff", mode, "-z", "-M", "--no-color", "--no-ext-diff", "--no-textconv", range.as_str()];
        let o = git::run_git_capped(dir, &args, git::DIFF_TIMEOUT, 4 << 20).ok()?;
        git::complete_records(o, mode).ok()
    };
    if let Some(numstat) = list("--numstat") {
        let status = list("--name-status").map(|b| git::parse_name_status_z(&b)).unwrap_or_default();
        (p.files, p.files_truncated) = git::merge_branch_files(git::parse_numstat_z(&numstat), status, MAX_PREVIEW_FILES);
    }
    let n = (MAX_COMMITS + 1).to_string();
    let log_range = format!("{base_sha}..{branch_sha}");
    if let Some(log) = git::git_stdout_timeout(dir, &["log", "--no-color", "--format=%H%x00%s%x00%an%x00%ct", "-n", &n, &log_range], git::DIFF_TIMEOUT) {
        let mut commits = parse_commits(&log);
        p.commits_truncated = commits.len() > MAX_COMMITS;
        commits.truncate(MAX_COMMITS);
        p.last_subject = commits.first().map(|c| c.subject.clone()).filter(|s| !s.is_empty());
        p.commits = commits;
    }

    p.can_fast_forward = is_ancestor(dir, &base_sha, &branch_sha) == Some(true);
    let check = if p.can_fast_forward {
        p.check_method = "fast-forward".into();
        Ok((true, Vec::new()))
    } else if git_version().as_deref().and_then(parse_git_version).is_some_and(supports_write_tree) {
        p.check_method = "merge-tree".into();
        merge_tree_check(dir, &base_sha, &branch_sha)
    } else {
        p.check_method = "temporary worktree".into();
        temp_worktree_check(&main_dir, &base_sha, &branch_sha)
    };
    match check {
        Ok((clean, conflicts)) => {
            p.clean = Some(clean);
            if !clean {
                let n = conflicts.len();
                p.blockers.push(format!(
                    "{} would conflict. Resolve {} on “{branch}” first (merge or rebase “{base}” in its worktree), then preview again.",
                    if n == 1 { "1 file".to_string() } else { format!("{n} files") },
                    if n == 1 { "it" } else { "them" }
                ));
            }
            p.conflicts = conflicts;
        }
        Err(CheckError::Unrelated) => p.blockers.push(format!("“{branch}” and “{base}” have no common history.")),
        Err(CheckError::Failed(e)) => {
            p.warnings.push(format!("The conflict check failed ({e}). If the merge conflicts, git stops and the checkout is put back."));
        }
    }
    if p.worktree_uncommitted > 0 {
        let n = p.worktree_uncommitted;
        p.warnings.push(format!(
            "{} in the worktree {} not part of the merge: only commits are merged.",
            if n == 1 { "1 uncommitted or untracked file".to_string() } else { format!("{n} uncommitted or untracked files") },
            if n == 1 { "is" } else { "are" }
        ));
    }
    Ok(p)
}

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------

fn cap_tail(s: &str, cap: usize) -> String {
    if s.len() <= cap {
        return s.to_string();
    }
    let mut start = s.len() - cap;
    while !s.is_char_boundary(start) {
        start += 1;
    }
    format!("…{}", &s[start..])
}

/// Run one git write in `dir` (contained, time-limited, never prompting).
fn run_write(dir: &Path, args: &[String]) -> (bool, GitStepLog) {
    let command = display_command(&dir.to_string_lossy(), args);
    let Some(exe) = git::git_exe() else {
        return (false, GitStepLog { command, ok: false, output: "git not found".into() });
    };
    let mut cmd = process::hidden_command(exe);
    cmd.arg("-C").arg(dir).args(args);
    cmd.env("GIT_TERMINAL_PROMPT", "0").env("GIT_PAGER", "cat").env("GIT_MERGE_AUTOEDIT", "no");
    match crate::testrun::run_contained(cmd, WRITE_TIMEOUT, 256 * 1024) {
        Ok(o) => {
            let ok = o.code == Some(0);
            let mut output = crate::redact::redact(String::from_utf8_lossy(&o.output).trim());
            if o.timed_out {
                output = format!("{output}\n(stopped after {} s)", WRITE_TIMEOUT.as_secs()).trim().to_string();
            }
            (ok, GitStepLog { command, ok, output: cap_tail(&output, STEP_OUTPUT_CAP) })
        }
        Err(e) => (false, GitStepLog { command, ok: false, output: format!("could not run git: {e}") }),
    }
}

fn unmerged_files(dir: &Path) -> Vec<String> {
    git::run_git(dir, &["diff", "--name-only", "--diff-filter=U", "-z"], git::DIFF_TIMEOUT)
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).split('\0').filter(|s| !s.is_empty()).map(str::to_string).collect())
        .unwrap_or_default()
}

/// Put the main checkout back after a failed step: `merge --abort` when a merge is in progress,
/// `reset --merge` when a squash left changes (neither moves HEAD). Then check HEAD and status.
fn rollback(main: &Path, base_sha: &str, steps: &mut Vec<GitStepLog>) -> Result<(), String> {
    let merging = git_dir(main).is_some_and(|gd| gd.join("MERGE_HEAD").exists());
    if merging {
        steps.push(run_write(main, &["merge".into(), "--abort".into()]).1);
    } else if status_count(main, true) != Some(0) {
        steps.push(run_write(main, &["reset".into(), "--merge".into()]).1);
    }
    let head = rev(main, "HEAD");
    let still_merging = git_dir(main).is_some_and(|gd| gd.join("MERGE_HEAD").exists());
    let clean = status_count(main, true) == Some(0);
    if head.as_deref() == Some(base_sha) && !still_merging && clean {
        Ok(())
    } else {
        Err(format!(
            "the main checkout ({}) needs attention: HEAD {}, merge in progress: {}, clean: {}",
            main.display(),
            head.as_deref().map(|h| &h[..h.len().min(10)]).unwrap_or("unknown"),
            still_merging,
            clean
        ))
    }
}

fn conflict(msg: impl Into<String>) -> AppError {
    AppError::Conflict(msg.into())
}

/// Run a confirmed merge. Every guard is checked again first (refusals are errors and nothing is
/// written); a failed step is rolled back and reported in the outcome.
pub fn execute(req: &MergeRequest, tests: &crate::testrun::Manager) -> AppResult<MergeOutcome> {
    let _lock = WRITE_LOCK.try_lock().ok_or_else(|| conflict("Another merge or clean-up is running"))?;
    let base = req.base.trim();
    let branch = req.branch.trim();
    if !git::is_valid_ref_name(base) || !git::is_valid_ref_name(branch) {
        return Err(AppError::Invalid("Invalid branch name".into()));
    }
    if !is_sha(&req.base_sha) || !is_sha(&req.branch_sha) {
        return Err(AppError::Invalid("Invalid commit id".into()));
    }
    let plan = plan(req)?;
    let message = validate_message(req.strategy, &req.message)?;
    let root = git::repo_root(&req.path)?.ok_or_else(|| AppError::Invalid(format!("Not a git repository: {}", req.path)))?;
    if git::current_branch(&root).as_deref() != Some(branch) {
        return Err(conflict(format!("The worktree is no longer on “{branch}”. Preview again.")));
    }
    let main = worktrees(&root).into_iter().next().ok_or_else(|| conflict("Could not find the main checkout"))?;
    let main_dir = PathBuf::from(&main.path);
    if !git::same_path(&main_dir, Path::new(&plan.main_path)) || git::same_path(&main_dir, &root) {
        return Err(conflict("The main checkout changed since the preview. Preview again."));
    }
    let blockers = main_checkout_blockers(&main_dir, main.branch.as_deref(), base);
    if !blockers.is_empty() {
        return Err(conflict(blockers.join(" ")));
    }
    if rev(&main_dir, &branch_ref(base)).as_deref() != Some(req.base_sha.as_str()) {
        return Err(conflict(format!("“{base}” moved since the preview. Preview again.")));
    }
    if rev(&main_dir, &branch_ref(branch)).as_deref() != Some(req.branch_sha.as_str()) {
        return Err(conflict(format!("“{branch}” has new commits since the preview. Preview again (and run the tests again).")));
    }
    if req.strategy == MergeStrategy::FastForward && is_ancestor(&main_dir, &req.base_sha, &req.branch_sha) != Some(true) {
        return Err(conflict(format!("“{base}” cannot be fast-forwarded to “{branch}”. Choose a merge commit or a squash.")));
    }
    if req.require_tests && tests.passing_evidence(&root, &req.branch_sha).is_none() {
        return Err(conflict(format!(
            "Tests are required: there is no passing run on {} in a clean worktree. Run the tests (or untick the requirement).",
            &req.branch_sha[..10]
        )));
    }

    tracing::info!(strategy = ?req.strategy, "merge: running");
    let mut out = MergeOutcome { strategy: req.strategy, ..Default::default() };
    let mut failed: Option<String> = None;
    for args in merge_steps(req.strategy, &message, &req.branch_sha) {
        let (ok, log) = run_write(&main_dir, &args);
        let detail = log.output.clone();
        out.steps.push(log);
        if !ok {
            failed = Some(if detail.is_empty() { "git failed".into() } else { detail });
            break;
        }
    }
    if let Some(err) = failed {
        out.conflicts = unmerged_files(&main_dir).into_iter().map(|path| MergeConflict { path, kind: "conflict".into() }).collect();
        let back = rollback(&main_dir, &req.base_sha, &mut out.steps);
        out.rolled_back = back.is_ok();
        out.error = Some(match back {
            Ok(()) => cap_tail(&err, 2000),
            Err(e) => format!("{}\nROLLBACK INCOMPLETE: {e}", cap_tail(&err, 2000)),
        });
        tracing::warn!(rolled_back = out.rolled_back, conflicts = out.conflicts.len(), "merge: failed");
        return Ok(out);
    }

    let head = rev(&main_dir, "HEAD");
    let parent = rev(&main_dir, "HEAD^1");
    let as_expected = match req.strategy {
        MergeStrategy::FastForward => head.as_deref() == Some(req.branch_sha.as_str()),
        MergeStrategy::MergeCommit => {
            parent.as_deref() == Some(req.base_sha.as_str())
                && head.as_deref().is_some_and(|h| is_ancestor(&main_dir, &req.branch_sha, h) == Some(true))
        }
        MergeStrategy::Squash => parent.as_deref() == Some(req.base_sha.as_str()),
    };
    out.new_sha = head;
    out.ok = as_expected;
    if !as_expected {
        out.error = Some("git reported success but the result is not what was planned; check the main checkout's history.".into());
    }
    tracing::info!(ok = out.ok, "merge: done");
    Ok(out)
}

// ---------------------------------------------------------------------------
// Worktree clean-up (a separate, confirmed step after a merge)
// ---------------------------------------------------------------------------

/// Junctions and symlinks inside `root` (not descending into them; the root's `.git` is skipped).
pub fn find_links(root: &Path) -> Result<Vec<PathBuf>, String> {
    let mut links = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    let mut seen = 0usize;
    while let Some(dir) = stack.pop() {
        let rd = std::fs::read_dir(&dir).map_err(|e| format!("could not read {}: {e}", dir.display()))?;
        for entry in rd {
            let entry = entry.map_err(|e| e.to_string())?;
            seen += 1;
            if seen > MAX_SCAN_ENTRIES {
                return Err(format!("more than {MAX_SCAN_ENTRIES} files to check for links"));
            }
            let path = entry.path();
            if dir == root && entry.file_name() == ".git" {
                continue;
            }
            // DirEntry::file_type does not follow links; on Windows junctions count as symlinks.
            let ft = entry.file_type().map_err(|e| e.to_string())?;
            if ft.is_symlink() {
                links.push(path);
            } else if ft.is_dir() {
                stack.push(path);
            }
        }
    }
    links.sort();
    Ok(links)
}

/// Remove a link itself, never its target (`RemoveDirectoryW` on a directory junction / symlink).
fn unlink(p: &Path) -> io::Result<()> {
    let ft = std::fs::symlink_metadata(p)?.file_type();
    if !ft.is_symlink() {
        return Err(io::Error::other("not a link"));
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::FileTypeExt;
        if ft.is_symlink_dir() {
            return std::fs::remove_dir(p);
        }
    }
    std::fs::remove_file(p)
}

fn unlink_all(links: &[PathBuf]) -> Result<u32, String> {
    let mut n = 0;
    for l in links {
        unlink(l).map_err(|e| format!("could not unlink {}: {e}", l.display()))?;
        n += 1;
    }
    Ok(n)
}

/// What "remove worktree + branch" would do for the worktree at `path`.
pub fn cleanup_plan(path: &str, base: Option<&str>) -> AppResult<WorktreeCleanupPlan> {
    let requested = git::requested_base(base)?;
    let root = git::repo_root(path)?.ok_or_else(|| AppError::Invalid(format!("Not a git repository: {path}")))?;
    let mut p = WorktreeCleanupPlan { path: root.to_string_lossy().into_owned(), ..Default::default() };
    let branch = git::current_branch(&root);
    p.branch = branch.clone().unwrap_or_default();
    let main = worktrees(&root).into_iter().next();
    let Some(main) = main else {
        p.blockers.push("Could not find the main checkout.".into());
        return Ok(p);
    };
    p.main_path = main.path.clone();
    let main_dir = PathBuf::from(&main.path);
    if git::same_path(&main_dir, &root) {
        p.blockers.push("This is the main checkout; only a linked worktree can be removed.".into());
        return Ok(p);
    }
    let Some(branch) = branch else {
        p.blockers.push("The worktree is not on a branch.".into());
        return Ok(p);
    };
    let base = requested.map(str::to_string).or(main.branch.clone());
    p.branch_merged = base.as_deref().is_some_and(|b| {
        b != branch && is_ancestor(&main_dir, &branch_ref(&branch), &branch_ref(b)) == Some(true)
    });
    match status_count(&root, false) {
        Some(0) => {}
        Some(n) => p.blockers.push(format!(
            "The worktree has {} uncommitted or untracked file(s). `git worktree remove` refuses (Gridkeeper never forces it): commit or delete them first.",
            if n == u32::MAX { "many".to_string() } else { n.to_string() }
        )),
        None => p.blockers.push("Could not read the worktree's status.".into()),
    }
    match find_links(&root) {
        Ok(links) => p.links = links.iter().map(|l| l.to_string_lossy().into_owned()).collect(),
        Err(e) => p.blockers.push(format!("Could not check the worktree for junctions / symlinks ({e}).")),
    }
    let root_s = p.path.clone();
    p.commands.push(display_command(&main.path, &["worktree".into(), "remove".into(), "--".into(), root_s]));
    if p.branch_merged {
        p.commands.push(display_command(&main.path, &["branch".into(), "-d".into(), branch.clone()]));
    }
    Ok(p)
}

/// Run a confirmed clean-up: unlink the worktree's links, `git worktree remove` (no force), then
/// `git branch -d` when the branch is merged. Stops at the first failure.
pub fn cleanup(path: &str, branch: &str, base: Option<&str>) -> AppResult<WorktreeCleanupOutcome> {
    let _lock = WRITE_LOCK.try_lock().ok_or_else(|| conflict("Another merge or clean-up is running"))?;
    let plan = cleanup_plan(path, base)?;
    if !plan.blockers.is_empty() {
        return Err(conflict(plan.blockers.join(" ")));
    }
    if plan.branch != branch.trim() {
        return Err(conflict(format!("The worktree is on “{}”, not “{}”. Check again.", plan.branch, branch.trim())));
    }
    let main_dir = PathBuf::from(&plan.main_path);
    let root = PathBuf::from(&plan.path);
    let mut out = WorktreeCleanupOutcome::default();
    let links: Vec<PathBuf> = plan.links.iter().map(PathBuf::from).collect();
    match unlink_all(&links) {
        Ok(n) => out.links_removed = n,
        Err(e) => {
            out.error = Some(format!("{e}; nothing was removed"));
            return Ok(out);
        }
    }
    match find_links(&root) {
        Ok(rest) if rest.is_empty() => {}
        Ok(rest) => {
            out.error = Some(format!("{} link(s) appeared in the worktree; nothing was removed", rest.len()));
            return Ok(out);
        }
        Err(e) => {
            out.error = Some(format!("could not re-check the worktree ({e}); nothing was removed"));
            return Ok(out);
        }
    }
    let (ok, log) = run_write(&main_dir, &["worktree".into(), "remove".into(), "--".into(), plan.path.clone()]);
    let detail = log.output.clone();
    out.steps.push(log);
    if !ok {
        out.error = Some(if detail.is_empty() { "git worktree remove failed".into() } else { detail });
        return Ok(out);
    }
    out.worktree_removed = true;
    if plan.branch_merged {
        let (ok, log) = run_write(&main_dir, &["branch".into(), "-d".into(), plan.branch.clone()]);
        let detail = log.output.clone();
        out.steps.push(log);
        out.branch_deleted = ok;
        if !ok {
            out.error = Some(detail);
        }
    }
    tracing::info!(worktree_removed = out.worktree_removed, branch_deleted = out.branch_deleted, "worktree clean-up");
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_git_versions() {
        assert_eq!(parse_git_version("git version 2.51.0.windows.1"), Some((2, 51, 0)));
        assert_eq!(parse_git_version("git version 2.37.1 (Apple Git-137.1)"), Some((2, 37, 1)));
        assert_eq!(parse_git_version("git version 2.38"), Some((2, 38, 0)));
        assert_eq!(parse_git_version("nope"), None);
        assert!(supports_write_tree((2, 38, 0)) && supports_write_tree((3, 0, 0)));
        assert!(!supports_write_tree((2, 37, 9)));
    }

    // Recorded from git 2.51 (`merge-tree --write-tree -z [--name-only] main feat`): a content conflict
    // in a.txt and a modify/delete conflict in d.txt.
    const TREE: &str = "72fb3c2a26f2b4dd8d71e64a2c5d5b12952afff8";

    fn fixture(name_only: bool) -> Vec<u8> {
        let files = if name_only {
            "a.txt\0d.txt\0".to_string()
        } else {
            [
                "100644 de980441c3ab03a8c07dda1ad27b8a11f39deb1e 1\ta.txt",
                "100644 097825b89d0fd9cadcaf0c0b9995937a16c4f125 2\ta.txt",
                "100644 a641d0eb27ffa7ccb76487250e606ff49858457f 3\ta.txt",
                "100644 587be6b4c3f93f93c489c0111bba5596147a26cb 1\td.txt",
                "100644 975fbec8256d3e8a3797e7a3611380f27c49f4ac 2\td.txt",
            ]
            .iter()
            .map(|r| format!("{r}\0"))
            .collect()
        };
        let msgs = concat!(
            "1\0a.txt\0Auto-merging\0Auto-merging a.txt\n\0",
            "1\0a.txt\0CONFLICT (contents)\0CONFLICT (content): Merge conflict in a.txt\n\0",
            "1\0d.txt\0CONFLICT (modify/delete)\0CONFLICT (modify/delete): d.txt deleted in feat and modified in main.  Version main of d.txt left in tree.\n\0",
        );
        format!("{TREE}\0{files}\0{msgs}").into_bytes()
    }

    #[test]
    fn parses_merge_tree_output() {
        let want = vec![
            MergeConflict { path: "a.txt".into(), kind: "content".into() },
            MergeConflict { path: "d.txt".into(), kind: "modify/delete".into() },
        ];
        for name_only in [true, false] {
            let (tree, c) = parse_merge_tree_z(&fixture(name_only)).unwrap();
            assert_eq!(tree, TREE);
            assert_eq!(c, want, "name_only {name_only}");
        }
        // --no-messages: paths only, kinds unknown.
        let (_, c) = parse_merge_tree_z(format!("{TREE}\0a.txt\0sp ace.txt\0").as_bytes()).unwrap();
        assert_eq!(c.iter().map(|x| (x.path.as_str(), x.kind.as_str())).collect::<Vec<_>>(), [("a.txt", "conflict"), ("sp ace.txt", "conflict")]);
        // Clean merge: the tree only.
        assert_eq!(parse_merge_tree_z(b"cd7bf6f55679c167510bbf4728da554caced7c51\0"), Some(("cd7bf6f55679c167510bbf4728da554caced7c51".into(), vec![])));
        assert_eq!(parse_merge_tree_z(b"fatal: refusing to merge unrelated histories\n"), None);
        assert_eq!(parse_merge_tree_z(b""), None);
    }

    #[test]
    fn plans_show_exactly_what_runs() {
        let sha = "1".repeat(40);
        let mut req = MergeRequest {
            path: r"D:\wt".into(),
            main_path: r"D:\Main Repo".into(),
            base: "main".into(),
            branch: "feat".into(),
            base_sha: "2".repeat(40),
            branch_sha: sha.clone(),
            strategy: MergeStrategy::MergeCommit,
            message: "Merge feat: add \"x\"".into(),
            require_tests: true,
        };
        let p = plan(&req).unwrap();
        assert_eq!(p.commands, [format!(r#"git -C "D:\Main Repo" merge --no-ff --no-edit -m "Merge feat: add \"x\"" {sha}"#)]);
        assert_eq!(p.on_failure, [r#"git -C "D:\Main Repo" merge --abort"#]);
        req.strategy = MergeStrategy::Squash;
        let p = plan(&req).unwrap();
        assert_eq!(p.commands.len(), 2);
        assert!(p.commands[0].ends_with(&format!("merge --squash {sha}")));
        assert!(p.commands[1].ends_with(r#"commit -m "Merge feat: add \"x\"""#));
        assert_eq!(p.on_failure, [r#"git -C "D:\Main Repo" reset --merge"#]);
        req.strategy = MergeStrategy::FastForward;
        req.message = String::new();
        let p = plan(&req).unwrap();
        assert_eq!(p.commands, [format!(r#"git -C "D:\Main Repo" merge --ff-only {sha}"#)]);
        assert!(p.on_failure.is_empty());
        // Invalid input never produces a plan.
        req.strategy = MergeStrategy::MergeCommit;
        assert!(plan(&req).is_err(), "empty message");
        req.message = "two\nlines".into();
        assert!(plan(&req).is_err());
        req.message = "ok".into();
        req.branch_sha = "main".into();
        assert!(plan(&req).is_err());
    }

    #[test]
    fn quotes_display_arguments() {
        assert_eq!(quote_arg("merge"), "merge");
        assert_eq!(quote_arg(r"D:\a\b"), r"D:\a\b");
        assert_eq!(quote_arg("a b"), "\"a b\"");
        assert_eq!(quote_arg(""), "\"\"");
        assert_eq!(quote_arg("x;y"), "\"x;y\"");
        assert!(is_sha(&"a".repeat(40)) && is_sha(&"0".repeat(64)));
        assert!(!is_sha("main") && !is_sha(&"A".repeat(40)) && !is_sha(&"a".repeat(39)));
    }

    #[test]
    fn parses_commit_lines() {
        let a = "a".repeat(40);
        let text = format!("{a}\0Add tests\0Ada\x001760000000\nnot a commit\n");
        assert_eq!(parse_commits(&text), [MergeCommitInfo { sha: a, subject: "Add tests".into(), author: "Ada".into(), time_ms: 1_760_000_000_000 }]);
    }

    // ---- real repositories ----------------------------------------------------------------------

    /// The real-repository tests share the process-wide write lock (a concurrent merge is refused by
    /// design), so they run one at a time.
    static SERIAL: Mutex<()> = Mutex::new(());

    struct Repo {
        _tmp: tempfile::TempDir,
        main: PathBuf,
        base: PathBuf,
        _serial: parking_lot::MutexGuard<'static, ()>,
    }

    fn git(dir: &Path, args: &[&str]) -> String {
        let mut cmd = process::hidden_command(git::git_exe().unwrap());
        let null = if cfg!(windows) { "NUL" } else { "/dev/null" };
        cmd.arg("-C").arg(dir).args(args).env("GIT_CONFIG_NOSYSTEM", "1").env("GIT_CONFIG_GLOBAL", null);
        let out = process::run_with_timeout(cmd, Duration::from_secs(60)).unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    fn commit(dir: &Path, msg: &str) {
        git(dir, &["add", "-A"]);
        git(dir, &["commit", "-q", "-m", msg]);
    }

    /// main with a.txt; worktree `wt` on branch `feat` (created from main).
    fn repo() -> Option<Repo> {
        git::git_exe()?;
        let serial = SERIAL.lock();
        let tmp = tempfile::tempdir().unwrap();
        let base = tmp.path().to_path_buf();
        let main = base.join("main");
        std::fs::create_dir_all(&main).unwrap();
        git(&main, &["init", "-q", "-b", "main"]);
        // Local config: the merge itself runs with the machine's global config, the repo's wins.
        for (k, v) in [("user.name", "t"), ("user.email", "t@example.invalid"), ("commit.gpgsign", "false"), ("core.autocrlf", "false")] {
            git(&main, &["config", k, v]);
        }
        std::fs::write(main.join("a.txt"), "one\ntwo\nthree\n").unwrap();
        std::fs::write(main.join(".gitignore"), "ignored/\n").unwrap();
        commit(&main, "init");
        let wt = base.join("wt");
        git(&main, &["worktree", "add", "-q", "-b", "feat", &wt.to_string_lossy()]);
        Some(Repo { _tmp: tmp, main, base, _serial: serial })
    }

    impl Repo {
        fn wt(&self) -> PathBuf {
            self.base.join("wt")
        }
        fn s(p: &Path) -> String {
            p.to_string_lossy().into_owned()
        }
        fn request(&self, pv: &MergePreview, strategy: MergeStrategy, message: &str) -> MergeRequest {
            MergeRequest {
                path: pv.path.clone(),
                main_path: pv.main_path.clone().unwrap(),
                base: pv.base.clone().unwrap(),
                branch: pv.branch.clone().unwrap(),
                base_sha: pv.base_sha.clone().unwrap(),
                branch_sha: pv.branch_sha.clone().unwrap(),
                strategy,
                message: message.into(),
                require_tests: false,
            }
        }
    }

    #[test]
    fn fast_forward_preview_and_merge() {
        let Some(r) = repo() else { return };
        let wt = r.wt();
        std::fs::write(wt.join("b.txt"), "b\n").unwrap();
        commit(&wt, "add b");
        let pv = preview(&Repo::s(&wt), None).unwrap();
        assert!(pv.blockers.is_empty(), "{:?}", pv.blockers);
        assert_eq!((pv.branch.as_deref(), pv.base.as_deref()), (Some("feat"), Some("main")));
        assert!(pv.can_fast_forward && pv.clean == Some(true));
        assert_eq!(pv.check_method, "fast-forward");
        assert_eq!((pv.ahead, pv.behind, pv.files_changed, pv.insertions), (1, 0, 1, 1));
        assert_eq!(pv.commits.len(), 1);
        assert_eq!(pv.last_subject.as_deref(), Some("add b"));
        assert!(git::same_path(Path::new(pv.main_path.as_deref().unwrap()), &r.main));

        let m = crate::testrun::Manager::new();
        // Tests required but never run: refused, nothing written.
        let mut req = r.request(&pv, MergeStrategy::FastForward, "");
        req.require_tests = true;
        assert!(matches!(execute(&req, &m), Err(AppError::Conflict(_))));
        req.require_tests = false;
        let out = execute(&req, &m).unwrap();
        assert!(out.ok && !out.rolled_back, "{out:?}");
        assert_eq!(out.new_sha, pv.branch_sha);
        assert_eq!(git(&r.main, &["rev-parse", "main"]), pv.branch_sha.clone().unwrap());
        assert!(r.main.join("b.txt").is_file());
        // The same request again: main moved, refused.
        assert!(matches!(execute(&req, &m), Err(AppError::Conflict(_))));
    }

    #[test]
    fn merge_commit_and_squash_when_main_moved() {
        let Some(r) = repo() else { return };
        let wt = r.wt();
        std::fs::write(wt.join("b.txt"), "b\n").unwrap();
        commit(&wt, "add b");
        std::fs::write(r.main.join("c.txt"), "c\n").unwrap();
        commit(&r.main, "main moves");
        let pv = preview(&Repo::s(&wt), None).unwrap();
        assert!(pv.blockers.is_empty(), "{:?}", pv.blockers);
        assert!(!pv.can_fast_forward);
        assert_eq!((pv.ahead, pv.behind), (1, 1));
        assert_eq!(pv.clean, Some(true));
        assert_eq!(pv.check_method, "merge-tree");
        let m = crate::testrun::Manager::new();
        // Fast-forward is refused when not possible.
        assert!(execute(&r.request(&pv, MergeStrategy::FastForward, ""), &m).is_err());
        let out = execute(&r.request(&pv, MergeStrategy::MergeCommit, "Merge feat: add b"), &m).unwrap();
        assert!(out.ok, "{out:?}");
        assert_eq!(git(&r.main, &["log", "-1", "--format=%s"]), "Merge feat: add b");
        assert_eq!(git(&r.main, &["rev-parse", "HEAD^2"]), pv.branch_sha.clone().unwrap());

        // Squash a second change.
        std::fs::write(wt.join("d.txt"), "d\n").unwrap();
        commit(&wt, "add d");
        let pv = preview(&Repo::s(&wt), None).unwrap();
        assert!(pv.blockers.is_empty(), "{:?}", pv.blockers);
        let before = git(&r.main, &["rev-parse", "HEAD"]);
        let out = execute(&r.request(&pv, MergeStrategy::Squash, "Squash feat"), &m).unwrap();
        assert!(out.ok, "{out:?}");
        assert_eq!(git(&r.main, &["rev-parse", "HEAD^1"]), before);
        assert_eq!(git(&r.main, &["log", "-1", "--format=%s"]), "Squash feat");
        assert!(r.main.join("d.txt").is_file());
        assert_eq!(git(&r.main, &["status", "--porcelain"]), "");
    }

    #[test]
    fn conflicts_are_previewed_and_a_failed_merge_is_rolled_back() {
        let Some(r) = repo() else { return };
        let wt = r.wt();
        std::fs::write(wt.join("a.txt"), "one\nTWO-feat\nthree\n").unwrap();
        commit(&wt, "feat edits a");
        std::fs::write(r.main.join("a.txt"), "one\nTWO-main\nthree\n").unwrap();
        commit(&r.main, "main edits a");
        let pv = preview(&Repo::s(&wt), None).unwrap();
        assert_eq!(pv.clean, Some(false));
        assert_eq!(pv.conflicts, [MergeConflict { path: "a.txt".into(), kind: "content".into() }]);
        assert!(pv.blockers.iter().any(|b| b.contains("would conflict")), "{:?}", pv.blockers);

        // The fallback check agrees.
        let (clean, conflicts) = match temp_worktree_check(&r.main, pv.base_sha.as_deref().unwrap(), pv.branch_sha.as_deref().unwrap()) {
            Ok(x) => x,
            Err(_) => panic!("temporary worktree check failed"),
        };
        assert!(!clean);
        assert_eq!(conflicts.iter().map(|c| c.path.as_str()).collect::<Vec<_>>(), ["a.txt"]);
        let listed = git(&r.main, &["worktree", "list", "--porcelain"]);
        assert_eq!(git::parse_worktrees(&listed).len(), 2, "the temporary worktree is gone: {listed}");

        // Executing anyway (the preview's blockers are advisory to the UI): git stops, we roll back.
        let m = crate::testrun::Manager::new();
        let head = git(&r.main, &["rev-parse", "HEAD"]);
        let out = execute(&r.request(&pv, MergeStrategy::MergeCommit, "Merge feat"), &m).unwrap();
        assert!(!out.ok && out.rolled_back, "{out:?}");
        assert_eq!(out.conflicts.iter().map(|c| c.path.as_str()).collect::<Vec<_>>(), ["a.txt"]);
        assert!(out.steps.iter().any(|s| s.command.ends_with("merge --abort")));
        assert_eq!(git(&r.main, &["rev-parse", "HEAD"]), head);
        assert_eq!(git(&r.main, &["status", "--porcelain"]), "");
        assert!(!r.main.join(".git").join("MERGE_HEAD").exists());

        let out = execute(&r.request(&pv, MergeStrategy::Squash, "Squash feat"), &m).unwrap();
        assert!(!out.ok && out.rolled_back, "{out:?}");
        assert!(out.steps.iter().any(|s| s.command.ends_with("reset --merge")));
        assert_eq!(git(&r.main, &["rev-parse", "HEAD"]), head);
        assert_eq!(git(&r.main, &["status", "--porcelain"]), "");
    }

    #[test]
    fn guards_refuse_a_dirty_or_switched_main_checkout() {
        let Some(r) = repo() else { return };
        let wt = r.wt();
        std::fs::write(wt.join("b.txt"), "b\n").unwrap();
        commit(&wt, "add b");
        let m = crate::testrun::Manager::new();

        // Tracked change in the main checkout.
        std::fs::write(r.main.join("a.txt"), "dirty\n").unwrap();
        let pv = preview(&Repo::s(&wt), None).unwrap();
        assert!(pv.blockers.iter().any(|b| b.contains("uncommitted change")), "{:?}", pv.blockers);
        let req = r.request(&pv, MergeStrategy::FastForward, "");
        assert!(matches!(execute(&req, &m), Err(AppError::Conflict(_))));
        assert_eq!(std::fs::read_to_string(r.main.join("a.txt")).unwrap(), "dirty\n", "nothing touched");
        git(&r.main, &["checkout", "--", "a.txt"]);

        // Untracked files alone do not block (git refuses by itself if one would be overwritten).
        std::fs::write(r.main.join("scratch.txt"), "s\n").unwrap();
        assert!(preview(&Repo::s(&wt), None).unwrap().blockers.is_empty());
        std::fs::remove_file(r.main.join("scratch.txt")).unwrap();

        // Another branch checked out in the main checkout.
        git(&r.main, &["checkout", "-q", "-b", "other"]);
        let pv = preview(&Repo::s(&wt), Some("main")).unwrap();
        assert!(pv.blockers.iter().any(|b| b.contains("checked out, not “main”")), "{:?}", pv.blockers);
        assert!(matches!(execute(&r.request(&pv, MergeStrategy::FastForward, ""), &m), Err(AppError::Conflict(_))));
        git(&r.main, &["checkout", "-q", "main"]);

        // The branch moved after the preview.
        let pv = preview(&Repo::s(&wt), None).unwrap();
        assert!(pv.blockers.is_empty(), "{:?}", pv.blockers);
        std::fs::write(wt.join("e.txt"), "e\n").unwrap();
        commit(&wt, "add e");
        assert!(matches!(execute(&r.request(&pv, MergeStrategy::FastForward, ""), &m), Err(AppError::Conflict(_))));

        // A merge in progress in the main checkout.
        std::fs::write(r.main.join(".git").join("MERGE_HEAD"), format!("{}\n", pv.branch_sha.clone().unwrap())).unwrap();
        let pv = preview(&Repo::s(&wt), None).unwrap();
        assert!(pv.blockers.iter().any(|b| b.contains("merge is in progress")), "{:?}", pv.blockers);
        std::fs::remove_file(r.main.join(".git").join("MERGE_HEAD")).unwrap();

        // The main checkout itself, a worktree on the base, nothing to merge.
        let pv = preview(&Repo::s(&r.main), None).unwrap();
        assert!(!pv.blockers.is_empty());
        assert!(preview("relative", None).is_err());
        assert!(preview(&Repo::s(&wt), Some("a..b")).is_err());
    }

    #[test]
    fn cleanup_unlinks_links_then_removes_worktree_and_merged_branch() {
        let Some(r) = repo() else { return };
        let wt = r.wt();
        std::fs::write(wt.join("b.txt"), "b\n").unwrap();
        commit(&wt, "add b");
        // A link inside the worktree to a folder that must survive (like a node_modules junction).
        let target = r.base.join("shared");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("precious.txt"), "keep\n").unwrap();
        std::fs::create_dir_all(wt.join("ignored")).unwrap();
        let link = wt.join("ignored").join("node_modules");
        #[cfg(windows)]
        let made = {
            let mut c = process::hidden_command("cmd.exe");
            c.args(["/d", "/c", "mklink", "/J"]).arg(&link).arg(&target);
            process::run_with_timeout(c, Duration::from_secs(10)).is_ok_and(|o| o.status.success())
        };
        #[cfg(unix)]
        let made = std::os::unix::fs::symlink(&target, &link).is_ok();
        assert!(made, "could not create the link");

        // Not merged yet: the branch would be kept.
        let p = cleanup_plan(&Repo::s(&wt), None).unwrap();
        assert!(p.blockers.is_empty(), "{:?}", p.blockers);
        assert!(!p.branch_merged);
        assert_eq!(p.links.len(), 1);
        assert_eq!(p.commands.len(), 1);

        let pv = preview(&Repo::s(&wt), None).unwrap();
        let out = execute(&r.request(&pv, MergeStrategy::FastForward, ""), &crate::testrun::Manager::new()).unwrap();
        assert!(out.ok);
        let p = cleanup_plan(&Repo::s(&wt), None).unwrap();
        assert!(p.branch_merged);
        assert_eq!(p.commands.len(), 2);
        assert!(p.commands[1].ends_with("branch -d feat"));
        assert!(matches!(cleanup(&Repo::s(&wt), "other", None), Err(AppError::Conflict(_))));

        let done = cleanup(&Repo::s(&wt), "feat", None).unwrap();
        assert_eq!(done.error, None, "{done:?}");
        assert_eq!(done.links_removed, 1);
        assert!(done.worktree_removed && done.branch_deleted, "{done:?}");
        assert!(!wt.exists());
        assert!(target.join("precious.txt").is_file(), "the link target was not touched");
        assert!(git(&r.main, &["branch", "--list", "feat"]).is_empty());
        // The main checkout is never removed.
        let p = cleanup_plan(&Repo::s(&r.main), None).unwrap();
        assert!(!p.blockers.is_empty());
    }

    #[test]
    fn cleanup_refuses_a_dirty_worktree() {
        let Some(r) = repo() else { return };
        let wt = r.wt();
        std::fs::write(wt.join("untracked.txt"), "u\n").unwrap();
        let p = cleanup_plan(&Repo::s(&wt), None).unwrap();
        assert!(p.blockers.iter().any(|b| b.contains("uncommitted or untracked")), "{:?}", p.blockers);
        assert!(matches!(cleanup(&Repo::s(&wt), "feat", None), Err(AppError::Conflict(_))));
        assert!(wt.join("untracked.txt").is_file());
    }
}
