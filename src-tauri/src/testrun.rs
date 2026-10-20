//! Test runs: a workspace's test command run in a session's worktree (or the project folder) as a
//! background helper process, so sign-off rests on evidence instead of an agent's word.
//!
//! - **Detection** (`detect`): `package.json` `test` script (npm / pnpm / yarn / bun by lockfile or
//!   `packageManager`), `Cargo.toml`, `pytest.ini` / `pyproject.toml` / `setup.cfg` / `tox.ini`,
//!   `go.mod`, a Makefile `test:` target. Reads a few small files, never runs anything.
//! - **Runner** (`Manager`): each run is `cmd.exe /d /s /c <command>` (Windows) or `sh -c <command>`
//!   (macOS / Linux) at below-normal priority inside its own `ProcessContainer` (Job Object / POSIX
//!   session), so cancel, timeout, normal completion and app exit end the whole tree: no orphans.
//!   stdout + stderr go to a 2 MiB ring (the newest output wins). At most
//!   `TestRunSettings::max_concurrent` runs at once (the rest queue) and one active run per folder.
//!   Runs get `CI=true` (unless set) so watch modes stay off; agent session variables are removed.
//! - **Evidence**: git root, HEAD and the uncommitted-file count are recorded at start (and checked
//!   again at the end), so the merge gate (`passing_evidence`) only accepts a green run on exactly
//!   the commit being merged, in a clean worktree.
//! - **Summaries** (`parse_counts`, `failing_names`): pure, best-effort parsers for vitest, jest,
//!   cargo, pytest, go test and mocha.

use std::collections::VecDeque;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use parking_lot::{Condvar, Mutex};
use regex::Regex;

use crate::pty::ProcessContainer;
use crate::types::*;

/// Output kept per run (the newest bytes; older output is dropped and counted).
pub const LOG_CAP: usize = 2 * 1024 * 1024;
pub const MAX_COMMAND_LEN: usize = 2000;
pub const MIN_TIMEOUT_SEC: u32 = 10;
pub const MAX_TIMEOUT_SEC: u32 = 4 * 3600;
/// Finished runs kept in memory (with their logs); older ones are forgotten.
const KEEP_FINISHED: usize = 12;
const LAST_LINES: usize = 20;
const MAX_FAILURES: usize = 10;
/// How often the waiter looks at the child between wake-ups (cancel wakes it at once).
const POLL: Duration = Duration::from_millis(200);
/// After the tree is gone, wait at most this long for the pipe readers.
const READER_GRACE: Duration = Duration::from_secs(2);
#[cfg(windows)]
const BELOW_NORMAL_PRIORITY_CLASS: u32 = 0x0000_4000;

fn now_ms() -> u64 {
    crate::meter::now_ms()
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

fn read_small(path: &Path, cap: u64) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > cap {
        return None;
    }
    std::fs::read_to_string(path).ok()
}

fn short(s: &str, max: usize) -> String {
    let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if s.chars().count() <= max { s } else { format!("{}…", s.chars().take(max - 1).collect::<String>()) }
}

/// The package manager that runs a `package.json` script: lockfile first, then `packageManager`.
/// Returns (command, what decided it).
pub fn package_runner(dir: &Path, package_manager: Option<&str>) -> (&'static str, &'static str) {
    const LOCKS: &[(&str, &str)] = &[
        ("pnpm-lock.yaml", "pnpm test"),
        ("yarn.lock", "yarn test"),
        ("bun.lockb", "bun run test"),
        ("bun.lock", "bun run test"),
        ("package-lock.json", "npm test"),
        ("npm-shrinkwrap.json", "npm test"),
    ];
    for (lock, cmd) in LOCKS {
        if dir.join(lock).is_file() {
            return (cmd, lock);
        }
    }
    match package_manager.map(str::trim) {
        Some(p) if p.starts_with("pnpm@") || p == "pnpm" => ("pnpm test", "packageManager"),
        Some(p) if p.starts_with("yarn@") || p == "yarn" => ("yarn test", "packageManager"),
        Some(p) if p.starts_with("bun@") || p == "bun" => ("bun run test", "packageManager"),
        _ => ("npm test", "no lockfile"),
    }
}

static MAKE_TEST: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?m)^test\s*::?(?:[^=]|$)").unwrap());

/// Every way to run the tests of `dir` found in its own files, best first (no subfolders).
pub fn detect_in(dir: &Path) -> Vec<TestCandidate> {
    let mut out = Vec::new();
    if let Some(text) = read_small(&dir.join("package.json"), 1024 * 1024)
        && let Ok(v) = serde_json::from_str::<serde_json::Value>(&text)
        && let Some(script) = v.pointer("/scripts/test").and_then(|s| s.as_str())
        && !script.trim().is_empty()
        // `npm init`'s placeholder always fails.
        && !script.contains("no test specified")
    {
        let (cmd, why) = package_runner(dir, v.get("packageManager").and_then(|p| p.as_str()));
        out.push(TestCandidate { command: cmd.into(), source: format!("package.json \"test\": {} · {why}", short(script, 60)) });
    }
    if dir.join("Cargo.toml").is_file() {
        out.push(TestCandidate { command: "cargo test".into(), source: "Cargo.toml".into() });
    }
    let pytest = if dir.join("pytest.ini").is_file() {
        Some("pytest.ini".to_string())
    } else if read_small(&dir.join("pyproject.toml"), 1024 * 1024).is_some_and(|t| t.contains("[tool.pytest")) {
        Some("pyproject.toml [tool.pytest.ini_options]".into())
    } else if read_small(&dir.join("setup.cfg"), 1024 * 1024).is_some_and(|t| t.contains("[tool:pytest]")) {
        Some("setup.cfg [tool:pytest]".into())
    } else if read_small(&dir.join("tox.ini"), 1024 * 1024).is_some_and(|t| t.contains("[pytest]")) {
        Some("tox.ini [pytest]".into())
    } else if dir.join("pyproject.toml").is_file() {
        Some("pyproject.toml".into())
    } else {
        None
    };
    if let Some(source) = pytest {
        out.push(TestCandidate { command: "pytest".into(), source });
    }
    if dir.join("go.mod").is_file() {
        out.push(TestCandidate { command: "go test ./...".into(), source: "go.mod".into() });
    }
    for name in ["Makefile", "makefile", "GNUmakefile"] {
        if read_small(&dir.join(name), 1024 * 1024).is_some_and(|t| MAKE_TEST.is_match(&t)) {
            out.push(TestCandidate { command: "make test".into(), source: format!("{name} test target") });
            break;
        }
    }
    out
}

fn checked_dir(path: &str) -> AppResult<PathBuf> {
    if path.contains('\0') {
        return Err(AppError::Invalid("Path contains a NUL character".into()));
    }
    let dir = PathBuf::from(path.trim());
    if path.trim().is_empty() || !dir.is_absolute() {
        return Err(AppError::Invalid(format!("Folder must be an absolute path: {path:?}")));
    }
    Ok(dir)
}

/// Detected test commands for a folder. A missing folder yields no candidates, not an error.
pub fn detect(path: &str) -> AppResult<TestDetection> {
    let dir = checked_dir(path)?;
    let candidates = if dir.is_dir() { detect_in(&dir) } else { Vec::new() };
    let first = candidates.first().cloned();
    Ok(TestDetection {
        dir: dir.to_string_lossy().into_owned(),
        command: first.as_ref().map(|c| c.command.clone()),
        source: first.map(|c| c.source),
        candidates,
    })
}

// ---------------------------------------------------------------------------
// Validation (also used by `persistence::sanitize`)
// ---------------------------------------------------------------------------

/// A test command: one line (no control characters), at most 2000 characters. Returns it trimmed.
pub fn validate_command(cmd: &str) -> AppResult<String> {
    let c = cmd.trim();
    if c.is_empty() {
        return Err(AppError::Invalid("The test command is empty".into()));
    }
    if c.chars().count() > MAX_COMMAND_LEN {
        return Err(AppError::Invalid(format!("The test command is longer than {MAX_COMMAND_LEN} characters")));
    }
    if c.chars().any(char::is_control) {
        return Err(AppError::Invalid("The test command must be a single line".into()));
    }
    Ok(c.to_string())
}

/// Persisted command: trimmed; an empty or invalid one becomes `None` (= auto-detect).
pub fn sanitize_command(cmd: &mut Option<String>) {
    *cmd = cmd.as_deref().and_then(|c| validate_command(c).ok());
}

pub fn sanitize_settings(s: &mut TestRunSettings) {
    s.max_concurrent = s.max_concurrent.clamp(1, 8);
    s.timeout_min = s.timeout_min.clamp(1, 240);
}

// ---------------------------------------------------------------------------
// Output ring
// ---------------------------------------------------------------------------

/// Byte ring that keeps the newest `cap` bytes and counts everything pushed.
pub struct LogRing {
    buf: VecDeque<u8>,
    cap: usize,
    total: u64,
}

impl LogRing {
    pub fn new(cap: usize) -> Self {
        Self { buf: VecDeque::new(), cap: cap.max(1), total: 0 }
    }

    pub fn push(&mut self, data: &[u8]) {
        self.total += data.len() as u64;
        if data.len() >= self.cap {
            self.buf.clear();
            self.buf.extend(&data[data.len() - self.cap..]);
            return;
        }
        let over = (self.buf.len() + data.len()).saturating_sub(self.cap);
        self.buf.drain(..over);
        self.buf.extend(data);
    }

    pub fn total(&self) -> u64 {
        self.total
    }

    pub fn len(&self) -> usize {
        self.buf.len()
    }

    pub fn is_empty(&self) -> bool {
        self.buf.is_empty()
    }

    /// The newest `max` bytes (all when `max` is larger) and how many older bytes are not included.
    pub fn tail(&self, max: usize) -> (Vec<u8>, u64) {
        let skip = self.buf.len().saturating_sub(max);
        let bytes: Vec<u8> = self.buf.iter().skip(skip).copied().collect();
        let dropped = self.total - bytes.len() as u64;
        (bytes, dropped)
    }
}

/// Plain text of captured output: escape sequences stripped; when older output was dropped, the first
/// (partial) line is cut.
pub fn log_text(bytes: &[u8], dropped: u64) -> String {
    let text = crate::pty::text::strip_ansi(bytes);
    if dropped > 0 {
        match text.find('\n') {
            Some(i) => text[i + 1..].to_string(),
            None => String::new(),
        }
    } else {
        text
    }
}

// ---------------------------------------------------------------------------
// Summary parsers (pure, best effort)
// ---------------------------------------------------------------------------

static VITEST: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?m)^[ \t]*Tests[ \t]+(.+?)[ \t]*\((\d+)\)[ \t]*$").unwrap());
static JEST: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?m)^[ \t]*Tests:[ \t]+(.+?)[ \t]*$").unwrap());
static CARGO: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?m)^test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored;").unwrap());
static PYTEST: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?m)^=*[ \t]*((?:\d+ [a-z]+)(?:, \d+ [a-z]+)*) in [\d.]+s\b.*$").unwrap()
});
static PYTEST_NONE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?m)^=*[ \t]*no tests ran in [\d.]+s\b").unwrap());
static GO_OK: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?m)^ok[ \t]+\S+[ \t]+(?:[\d.]+s|\(cached\))").unwrap());
static GO_FAIL_PKG: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?m)^FAIL\t\S+").unwrap());
static GO_TEST: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?m)^--- (PASS|FAIL|SKIP): ").unwrap());
static MOCHA: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?m)^[ \t]*(\d+) (passing|failing|pending)\b").unwrap());
static PIECE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^(\d+) ([a-z]+)").unwrap());

/// Add "N word" pieces (`passed`, `failed`, ...) to `c`; returns whether any piece was recognized.
fn add_pieces<'a>(c: &mut TestCounts, pieces: impl Iterator<Item = &'a str>) -> bool {
    let mut any = false;
    for p in pieces {
        let Some(m) = PIECE.captures(p.trim()) else { continue };
        let n: u32 = m[1].parse().unwrap_or(0);
        match &m[2] {
            "passed" | "xpassed" => c.passed += n,
            "failed" | "error" | "errors" => c.failed += n,
            "skipped" | "todo" | "xfailed" | "pending" => c.skipped += n,
            // "total", "warnings", "deselected", "rerun": not counted.
            "total" | "warning" | "warnings" | "deselected" | "rerun" => {}
            _ => continue,
        }
        any = true;
    }
    any
}

fn counts(runner: &str, unit: &str) -> TestCounts {
    TestCounts { runner: runner.into(), unit: unit.into(), ..Default::default() }
}

fn vitest_counts(text: &str) -> Option<TestCounts> {
    let m = VITEST.captures_iter(text).last()?;
    let mut c = counts("vitest", "tests");
    add_pieces(&mut c, m[1].split('|')).then_some(c)
}

fn jest_counts(text: &str) -> Option<TestCounts> {
    let m = JEST.captures_iter(text).last()?;
    let mut c = counts("jest", "tests");
    add_pieces(&mut c, m[1].split(',')).then_some(c)
}

fn cargo_counts(text: &str) -> Option<TestCounts> {
    let mut c = counts("cargo", "tests");
    let mut any = false;
    // One line per test binary (unit, integration, doc tests): summed.
    for m in CARGO.captures_iter(text) {
        any = true;
        c.passed += m[1].parse::<u32>().unwrap_or(0);
        c.failed += m[2].parse::<u32>().unwrap_or(0);
        c.skipped += m[3].parse::<u32>().unwrap_or(0);
    }
    any.then_some(c)
}

fn pytest_counts(text: &str) -> Option<TestCounts> {
    let last = PYTEST
        .captures_iter(text)
        .filter_map(|m| {
            let mut c = counts("pytest", "tests");
            let known = m[1].split(',').any(|p| {
                let w = p.trim().split_once(' ').map(|x| x.1).unwrap_or("");
                matches!(w, "passed" | "failed" | "error" | "errors" | "skipped" | "xfailed" | "xpassed")
            });
            (known && add_pieces(&mut c, m[1].split(','))).then_some((m.get(0).map(|x| x.start()).unwrap_or(0), c))
        })
        .last();
    let none = PYTEST_NONE.find_iter(text).last().map(|m| (m.start(), counts("pytest", "tests")));
    match (last, none) {
        (Some(a), Some(b)) => Some(if a.0 >= b.0 { a.1 } else { b.1 }),
        (a, b) => a.or(b).map(|x| x.1),
    }
}

fn go_counts(text: &str) -> Option<TestCounts> {
    let ok = GO_OK.find_iter(text).count() as u32;
    let fail_pkgs = GO_FAIL_PKG.find_iter(text).count() as u32;
    let mut tests = counts("go", "tests");
    let mut verbose = false;
    for m in GO_TEST.captures_iter(text) {
        match &m[1] {
            "PASS" => {
                verbose = true;
                tests.passed += 1;
            }
            "FAIL" => tests.failed += 1,
            _ => tests.skipped += 1,
        }
    }
    if verbose {
        return Some(tests);
    }
    if ok == 0 && fail_pkgs == 0 {
        return None;
    }
    Some(TestCounts { runner: "go".into(), unit: "packages".into(), passed: ok, failed: fail_pkgs, skipped: 0 })
}

fn mocha_counts(text: &str) -> Option<TestCounts> {
    let mut c = counts("mocha", "tests");
    let mut any = false;
    for m in MOCHA.captures_iter(text) {
        let n: u32 = m[1].parse().unwrap_or(0);
        match &m[2] {
            "passing" => c.passed = n,
            "failing" => c.failed = n,
            _ => c.skipped = n,
        }
        any = true;
    }
    any.then_some(c)
}

/// Pass / fail / skip counts from a test run's output (escape sequences already stripped). Several
/// runners in one run (e.g. `vitest run && cargo test`) are summed.
pub fn parse_counts(text: &str) -> Option<TestCounts> {
    let found: Vec<TestCounts> = [vitest_counts(text), jest_counts(text), cargo_counts(text), pytest_counts(text), go_counts(text), mocha_counts(text)]
        .into_iter()
        .flatten()
        .collect();
    let mut it = found.into_iter();
    let first = it.next()?;
    Some(it.fold(first, |mut acc, c| {
        acc.runner = format!("{}+{}", acc.runner, c.runner);
        if acc.unit != c.unit {
            acc.unit = "tests".into();
        }
        acc.passed += c.passed;
        acc.failed += c.failed;
        acc.skipped += c.skipped;
        acc
    }))
}

static FAIL_NAMES: Lazy<Vec<Regex>> = Lazy::new(|| {
    [
        // vitest " FAIL  src/a.test.ts > suite > name", jest "FAIL src/a.test.js" (space-separated;
        // go's package lines use a tab).
        r"(?m)^[ \t]*FAIL {1,2}(\S.*?)[ \t]*$",
        // jest "  ● suite › name"
        r"(?m)^[ \t]*● (.+?)[ \t]*$",
        // cargo "test a::b ... FAILED"
        r"(?m)^test (\S+) \.\.\. FAILED[ \t]*$",
        // pytest short summary "FAILED tests/x.py::test_y - assert ..."
        r"(?m)^(?:FAILED|ERROR) (\S+)",
        // go "--- FAIL: TestX (0.00s)"
        r"(?m)^[ \t]*--- FAIL: (\S+)",
    ]
    .iter()
    .map(|r| Regex::new(r).unwrap())
    .collect()
});

/// Names of failing tests found in the output (best effort, in order of appearance, at most 10).
pub fn failing_names(text: &str) -> Vec<String> {
    let mut hits: Vec<(usize, String)> = Vec::new();
    for re in FAIL_NAMES.iter() {
        for m in re.captures_iter(text) {
            let name = m[1].trim();
            if name.is_empty() || name == "Console" || name.starts_with("Console ") {
                continue;
            }
            hits.push((m.get(0).map(|x| x.start()).unwrap_or(0), short(name, 200)));
        }
    }
    hits.sort_by_key(|h| h.0);
    let mut out: Vec<String> = Vec::new();
    for (_, n) in hits {
        if !out.contains(&n) {
            out.push(n);
            if out.len() >= MAX_FAILURES {
                break;
            }
        }
    }
    out
}

/// The last `n` non-empty lines (trailing whitespace trimmed, each at most 300 characters).
pub fn last_lines(text: &str, n: usize) -> Vec<String> {
    let mut v: Vec<String> = text
        .lines()
        .rev()
        .map(str::trim_end)
        .filter(|l| !l.trim().is_empty())
        .take(n)
        .map(|l| if l.chars().count() > 300 { format!("{}…", l.chars().take(299).collect::<String>()) } else { l.to_string() })
        .collect();
    v.reverse();
    v
}

/// Final status from how the run ended. `not_found` = the shell's "command not found" exit code
/// (9009 for cmd.exe, 127 for sh).
pub fn status_for_exit(code: Option<i32>) -> TestRunStatus {
    match code {
        Some(0) => TestRunStatus::Passed,
        Some(c) if is_not_found_code(c) => TestRunStatus::Error,
        _ => TestRunStatus::Failed,
    }
}

fn is_not_found_code(code: i32) -> bool {
    if cfg!(windows) { code == 9009 } else { code == 127 }
}

/// The shell could not find the command: its "not found" exit code, or cmd.exe's / sh's message in the
/// last lines (cmd.exe does not always exit with 9009). Only meaningful when no test summary was found.
pub fn looks_not_found(code: Option<i32>, lines: &[String]) -> bool {
    if code.is_some_and(is_not_found_code) {
        return true;
    }
    code.is_some_and(|c| c != 0)
        && lines.iter().rev().take(5).any(|l| {
            l.contains("is not recognized as an internal or external command") || l.ends_with(": command not found") || l.ends_with(": not found")
        })
}

/// The line that says what was not found (else the last line).
fn not_found_line(lines: &[String]) -> Option<&String> {
    lines.iter().rev().take(5).find(|l| l.contains("not recognized") || l.contains("not found")).or(lines.last())
}

// ---------------------------------------------------------------------------
// Contained helper processes (also used by `merge` for git writes)
// ---------------------------------------------------------------------------

/// `line` run by the platform shell: `cmd.exe /d /s /c "<line>"` (Windows; `/s` makes cmd strip
/// exactly the outer quotes and run the rest verbatim) or `sh -c <line>`. No console window,
/// below-normal priority.
pub fn shell_command(line: &str) -> Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let comspec = std::env::var_os("ComSpec")
            .filter(|v| Path::new(v).is_absolute())
            .unwrap_or_else(|| "cmd.exe".into());
        let mut cmd = Command::new(comspec);
        cmd.raw_arg(format!("/d /s /c \"{line}\""));
        cmd.creation_flags(crate::adapters::process::CREATE_NO_WINDOW | BELOW_NORMAL_PRIORITY_CLASS);
        cmd
    }
    #[cfg(not(windows))]
    {
        let mut cmd = Command::new("sh");
        cmd.arg("-c").arg(line);
        cmd
    }
}

/// A spawned child and the container that holds its tree (`None` if containment failed; then only
/// the root can be stopped).
pub(crate) struct Contained {
    pub child: Child,
    pub container: Option<Arc<ProcessContainer>>,
}

impl Contained {
    /// End the whole tree (the container, then the root as a fallback).
    pub fn kill_tree(&mut self) {
        if let Some(c) = &self.container {
            let _ = c.terminate(1);
        }
        let _ = self.child.kill();
    }
}

/// Spawn `cmd` (stdin closed, stdout / stderr piped) and put it in a fresh `ProcessContainer`.
/// Unix: the child leads a new session (`setsid`, like a PTY session) at `nice` 10.
pub(crate) fn spawn_contained(mut cmd: Command) -> io::Result<Contained> {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // SAFETY: setsid and nice are async-signal-safe; the closure touches nothing else.
        unsafe {
            cmd.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(io::Error::last_os_error());
                }
                let _ = libc::nice(10);
                Ok(())
            });
        }
    }
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let child = cmd.spawn()?;
    let container = match ProcessContainer::new().and_then(|c| c.assign_pid(child.id()).map(|_| c)) {
        Ok(c) => Some(Arc::new(c)),
        Err(e) => {
            tracing::warn!(error = %e, "helper process not contained; only its root can be stopped");
            None
        }
    };
    Ok(Contained { child, container })
}

/// Read `pipe` to the end, handing each chunk to `sink`; the receiver gets `()` when the pipe closes.
fn pump<R: Read + Send + 'static>(pipe: Option<R>, sink: impl Fn(&[u8]) + Send + 'static) -> mpsc::Receiver<()> {
    let (tx, rx) = mpsc::channel();
    let Some(mut pipe) = pipe else {
        let _ = tx.send(());
        return rx;
    };
    // If no thread can be started the sender is dropped with the closure: the receiver reports
    // "disconnected" at once (nothing is read; a child blocked on a full pipe ends at its time limit).
    let _ = crate::pty::spawn_guarded("helper-out".into(), move || {
        let mut buf = [0u8; 16 * 1024];
        loop {
            match pipe.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => sink(&buf[..n]),
            }
        }
        let _ = tx.send(());
    });
    rx
}

/// Output of [`run_contained`]: stdout + stderr (interleaved by arrival), capped.
pub(crate) struct ContainedOutput {
    pub code: Option<i32>,
    pub output: Vec<u8>,
    pub timed_out: bool,
}

/// Run `cmd` to completion inside a container with a time limit; the whole tree is ended on timeout
/// and leftovers are ended after the root exits. Output beyond `cap` bytes is dropped (oldest first).
pub(crate) fn run_contained(cmd: Command, timeout: Duration, cap: usize) -> io::Result<ContainedOutput> {
    let mut c = spawn_contained(cmd)?;
    let ring = Arc::new(Mutex::new(LogRing::new(cap)));
    let (r1, r2) = (Arc::clone(&ring), Arc::clone(&ring));
    let out_rx = pump(c.child.stdout.take(), move |b| r1.lock().push(b));
    let err_rx = pump(c.child.stderr.take(), move |b| r2.lock().push(b));
    let deadline = Instant::now() + timeout;
    let (code, timed_out) = loop {
        if let Some(st) = c.child.try_wait()? {
            break (st.code(), false);
        }
        if Instant::now() >= deadline {
            c.kill_tree();
            let _ = c.child.wait();
            break (None, true);
        }
        std::thread::sleep(Duration::from_millis(15));
    };
    if let Some(j) = &c.container {
        let _ = j.terminate(1);
    }
    let until = Instant::now() + READER_GRACE;
    for rx in [out_rx, err_rx] {
        let _ = rx.recv_timeout(until.saturating_duration_since(Instant::now()));
    }
    let (output, _) = ring.lock().tail(cap);
    Ok(ContainedOutput { code, output, timed_out })
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/// Folder key: case-insensitive, either slash, no trailing separator (same as the frontend's pathKey).
pub fn path_key(p: &str) -> String {
    p.trim().replace('/', "\\").trim_end_matches('\\').to_lowercase()
}

type Emit = Arc<dyn Fn(&TestRunInfo) + Send + Sync>;

struct Run {
    key: String,
    info: Mutex<TestRunInfo>,
    log: Mutex<LogRing>,
    cancel: AtomicBool,
    wake: Condvar,
    wake_lock: Mutex<()>,
    container: Mutex<Option<Arc<ProcessContainer>>>,
}

impl Run {
    fn snapshot(&self) -> TestRunInfo {
        let mut i = self.info.lock().clone();
        i.output_bytes = self.log.lock().total();
        i
    }
}

#[derive(Default)]
struct Inner {
    /// Creation order; active runs plus the newest finished ones.
    runs: Vec<Arc<Run>>,
    queue: VecDeque<Arc<Run>>,
    active: usize,
    max_concurrent: usize,
    seq: u64,
}

/// Queue, runner threads and results of test runs (one per app: [`manager`]).
pub struct Manager {
    inner: Mutex<Inner>,
    emit: Mutex<Option<Emit>>,
}

impl Default for Manager {
    fn default() -> Self {
        Self::new()
    }
}

static MANAGER: Lazy<Arc<Manager>> = Lazy::new(|| Arc::new(Manager::new()));

/// The app's test-run manager.
pub fn manager() -> Arc<Manager> {
    Arc::clone(&MANAGER)
}

/// App exit: end every running test tree now (Windows would also do it when the job handles close;
/// on macOS / Linux nothing else would).
pub fn shutdown() {
    MANAGER.shutdown();
}

struct GitFacts {
    root: Option<String>,
    head: Option<String>,
    uncommitted: Option<u32>,
}

fn git_facts(cwd: &Path) -> GitFacts {
    let none = GitFacts { root: None, head: None, uncommitted: None };
    let Ok(Some(root)) = crate::git::repo_root(&cwd.to_string_lossy()) else { return none };
    let head = crate::git::git_stdout(&root, &["rev-parse", "--verify", "--quiet", "HEAD"]).filter(|s| !s.is_empty());
    let uncommitted = crate::git::run_git_capped(
        &root,
        &["status", "--porcelain"],
        crate::git::STATUS_TIMEOUT,
        crate::git::MAX_STATUS_BYTES,
    )
    .ok()
    .filter(|o| o.status.is_some_and(|s| s.success()))
    .map(|o| o.stdout.split(|&b| b == b'\n').filter(|l| !l.iter().all(u8::is_ascii_whitespace)).count() as u32);
    GitFacts { root: Some(root.to_string_lossy().into_owned()), head, uncommitted }
}

/// Releases the runner slot when the run thread ends, however it ends (a panic marks the run failed).
struct SlotGuard {
    mgr: Arc<Manager>,
    run: Arc<Run>,
}

impl Drop for SlotGuard {
    fn drop(&mut self) {
        let unfinished = self.run.info.lock().status.is_active();
        if unfinished {
            {
                let mut i = self.run.info.lock();
                i.status = TestRunStatus::Error;
                i.error = Some("internal error in the test runner".into());
                i.ended_ms = Some(now_ms());
            }
            self.mgr.emit(&self.run.snapshot());
        }
        if let Some(c) = self.run.container.lock().take() {
            let _ = c.terminate(1);
        }
        self.mgr.release();
    }
}

impl Manager {
    pub fn new() -> Self {
        Self { inner: Mutex::new(Inner { max_concurrent: 2, ..Default::default() }), emit: Mutex::new(None) }
    }

    /// Install the event sink once (the first command that needs it passes the app handle).
    pub fn ensure_emitter(&self, make: impl FnOnce() -> Emit) {
        let mut e = self.emit.lock();
        if e.is_none() {
            *e = Some(make());
        }
    }

    fn emit(&self, info: &TestRunInfo) {
        let f = self.emit.lock().clone();
        if let Some(f) = f {
            f(info);
        }
    }

    fn find(&self, id: &str) -> Option<Arc<Run>> {
        self.inner.lock().runs.iter().find(|r| r.info.lock().id == id).cloned()
    }

    /// Queue a run (or start it when a slot is free). A folder that already has a queued or running
    /// run gets that run back instead of a second one.
    pub fn start(self: &Arc<Self>, spec: TestRunSpec, settings: &TestRunSettings) -> AppResult<TestRunInfo> {
        let dir = checked_dir(&spec.cwd)?;
        if !dir.is_dir() {
            return Err(AppError::Invalid(format!("Folder not found: {}", dir.display())));
        }
        let command = validate_command(&spec.command)?;
        let mut s = settings.clone();
        sanitize_settings(&mut s);
        let timeout = spec.timeout_sec.unwrap_or(s.timeout_min * 60).clamp(MIN_TIMEOUT_SEC, MAX_TIMEOUT_SEC);
        let cwd = dir.to_string_lossy().into_owned();
        let key = path_key(&cwd);
        let label = short(spec.label.trim(), 80);

        let (run, start_now) = {
            let mut inner = self.inner.lock();
            inner.max_concurrent = s.max_concurrent as usize;
            if let Some(r) = inner.runs.iter().find(|r| r.key == key && r.info.lock().status.is_active()) {
                return Ok(r.snapshot());
            }
            inner.seq += 1;
            let info = TestRunInfo {
                id: format!("t{}-{}", now_ms(), inner.seq),
                cwd,
                command,
                label: if label.is_empty() { key.clone() } else { label },
                session_id: spec.session_id.filter(|s| !s.trim().is_empty()),
                status: TestRunStatus::Queued,
                queued_ms: now_ms(),
                timeout_sec: timeout,
                ..Default::default()
            };
            let run = Arc::new(Run {
                key,
                info: Mutex::new(info),
                log: Mutex::new(LogRing::new(LOG_CAP)),
                cancel: AtomicBool::new(false),
                wake: Condvar::new(),
                wake_lock: Mutex::new(()),
                container: Mutex::new(None),
            });
            inner.runs.push(Arc::clone(&run));
            trim_finished(&mut inner.runs);
            let start_now = inner.active < inner.max_concurrent;
            if start_now {
                inner.active += 1;
                mark_launched(&run);
            } else {
                inner.queue.push_back(Arc::clone(&run));
            }
            (run, start_now)
        };
        let info = run.snapshot();
        self.emit(&info);
        if start_now {
            self.launch(run);
        }
        Ok(info)
    }

    fn launch(self: &Arc<Self>, run: Arc<Run>) {
        let mgr = Arc::clone(self);
        let r = Arc::clone(&run);
        let spawned = crate::pty::spawn_guarded("test-run".into(), move || {
            let _slot = SlotGuard { mgr: Arc::clone(&mgr), run: Arc::clone(&r) };
            mgr.execute(&r);
        });
        if let Err(e) = spawned {
            {
                let mut i = run.info.lock();
                i.status = TestRunStatus::Error;
                i.error = Some(format!("could not start a runner thread: {e}"));
                i.ended_ms = Some(now_ms());
            }
            self.emit(&run.snapshot());
            self.release();
        }
    }

    /// A slot was freed: start queued runs while there is room.
    fn release(self: &Arc<Self>) {
        let starts = {
            let mut inner = self.inner.lock();
            inner.active = inner.active.saturating_sub(1);
            let mut starts = Vec::new();
            while inner.active < inner.max_concurrent {
                let Some(r) = inner.queue.pop_front() else { break };
                if r.info.lock().status != TestRunStatus::Queued {
                    continue;
                }
                inner.active += 1;
                mark_launched(&r);
                starts.push(r);
            }
            starts
        };
        for r in starts {
            self.launch(r);
        }
    }

    fn finish(&self, run: &Run, status: TestRunStatus, code: Option<i32>, error: Option<String>, started: Instant) {
        let (bytes, dropped) = run.log.lock().tail(LOG_CAP);
        let text = log_text(&bytes, dropped);
        let mut status = status;
        let mut error = error;
        let lines = last_lines(&text, LAST_LINES);
        let counts = if code.is_some() { parse_counts(&text) } else { None };
        if code.is_some() && error.is_none() {
            // The shell's "not found" (exit code or message) without a test summary: the command never ran.
            if counts.is_none() && looks_not_found(code, &lines) {
                status = TestRunStatus::Error;
                error = Some(match not_found_line(&lines) {
                    Some(l) => format!("command not found: {l}"),
                    None => "command not found".into(),
                });
            } else if status == TestRunStatus::Error {
                // A "not found" exit code with a recognizable summary is a real test result.
                status = TestRunStatus::Failed;
            }
        }
        let failures = if status == TestRunStatus::Passed { Vec::new() } else { failing_names(&text) };
        let cwd = PathBuf::from(&run.info.lock().cwd);
        let end = git_facts(&cwd);
        {
            let mut i = run.info.lock();
            i.status = status;
            i.exit_code = code;
            i.error = error.map(|e| crate::redact::redact(&e));
            i.ended_ms = Some(now_ms());
            i.duration_ms = Some(started.elapsed().as_millis() as u64);
            i.counts = counts;
            i.failures = failures;
            i.last_lines = lines.iter().map(|l| crate::redact::redact(l)).collect();
            // Evidence only holds when the folder did not change under the run.
            if end.head != i.head_sha {
                i.head_sha = None;
            }
            i.uncommitted = match (i.uncommitted, end.uncommitted) {
                (Some(a), Some(b)) => Some(a.max(b)),
                _ => None,
            };
        }
        tracing::info!(status = ?status, code = ?code, "test run finished");
        self.emit(&run.snapshot());
    }

    fn execute(&self, run: &Arc<Run>) {
        let started = Instant::now();
        let (cwd, command, timeout) = {
            let i = run.info.lock();
            (PathBuf::from(&i.cwd), i.command.clone(), Duration::from_secs(i.timeout_sec as u64))
        };
        let facts = git_facts(&cwd);
        {
            let mut i = run.info.lock();
            i.repo_root = facts.root;
            i.head_sha = facts.head;
            i.uncommitted = facts.uncommitted;
        }
        self.emit(&run.snapshot());
        if run.cancel.load(Ordering::SeqCst) {
            self.finish(run, TestRunStatus::Cancelled, None, None, started);
            return;
        }

        let mut cmd = shell_command(&command);
        cmd.current_dir(&cwd);
        let names = std::env::vars_os().filter_map(|(k, _)| k.into_string().ok());
        for k in crate::adapters::inherited_agent_session_vars(names) {
            cmd.env_remove(k);
        }
        if std::env::var_os("CI").is_none() {
            cmd.env("CI", "true");
        }
        let mut c = match spawn_contained(cmd) {
            Ok(c) => c,
            Err(e) => {
                self.finish(run, TestRunStatus::Error, None, Some(format!("could not start the shell: {e}")), started);
                return;
            }
        };
        *run.container.lock() = c.container.clone();
        let (r1, r2) = (Arc::clone(run), Arc::clone(run));
        let out_rx = pump(c.child.stdout.take(), move |b| r1.log.lock().push(b));
        let err_rx = pump(c.child.stderr.take(), move |b| r2.log.lock().push(b));

        let deadline = started + timeout;
        let (status, code, error) = loop {
            match c.child.try_wait() {
                Ok(Some(st)) => break (status_for_exit(st.code()), st.code(), st.code().is_none().then(|| "ended by a signal".to_string())),
                Ok(None) => {}
                Err(e) => {
                    c.kill_tree();
                    break (TestRunStatus::Error, None, Some(format!("lost the process: {e}")));
                }
            }
            if run.cancel.load(Ordering::SeqCst) {
                c.kill_tree();
                let _ = c.child.wait();
                break (TestRunStatus::Cancelled, None, None);
            }
            let now = Instant::now();
            if now >= deadline {
                c.kill_tree();
                let _ = c.child.wait();
                let mins = timeout.as_secs() / 60;
                let limit = if mins > 0 { format!("{mins} min") } else { format!("{} s", timeout.as_secs()) };
                break (TestRunStatus::TimedOut, None, Some(format!("stopped after the {limit} time limit")));
            }
            let mut g = run.wake_lock.lock();
            if !run.cancel.load(Ordering::SeqCst) {
                run.wake.wait_for(&mut g, POLL.min(deadline - now));
            }
        };
        // The root is gone: end anything it left behind (servers, watchers), then collect the output.
        if let Some(j) = run.container.lock().take() {
            let _ = j.terminate(1);
        }
        let until = Instant::now() + READER_GRACE;
        for rx in [out_rx, err_rx] {
            let _ = rx.recv_timeout(until.saturating_duration_since(Instant::now()));
        }
        drop(c);
        self.finish(run, status, code, error, started);
    }

    /// Cancel a queued or running run. Returns false when it is unknown or already finished.
    pub fn cancel(&self, id: &str) -> bool {
        let Some(run) = self.find(id) else { return false };
        // Still waiting for a slot: taken out of the queue under the manager lock, so it never starts.
        let dequeued = {
            let mut inner = self.inner.lock();
            let before = inner.queue.len();
            inner.queue.retain(|r| !Arc::ptr_eq(r, &run));
            if inner.queue.len() != before {
                let mut i = run.info.lock();
                i.status = TestRunStatus::Cancelled;
                i.ended_ms = Some(now_ms());
                true
            } else {
                false
            }
        };
        if dequeued {
            self.emit(&run.snapshot());
            return true;
        }
        // Launched (it got a slot): its runner thread ends the tree.
        if run.info.lock().status.is_active() {
            run.cancel.store(true, Ordering::SeqCst);
            let _g = run.wake_lock.lock();
            run.wake.notify_all();
            return true;
        }
        false
    }

    /// Every known run, oldest first.
    pub fn list(&self) -> Vec<TestRunInfo> {
        let runs = self.inner.lock().runs.clone();
        runs.iter().map(|r| r.snapshot()).collect()
    }

    pub fn info(&self, id: &str) -> Option<TestRunInfo> {
        self.find(id).map(|r| r.snapshot())
    }

    /// The captured output (the newest `max_bytes`, default everything kept).
    pub fn log(&self, id: &str, max_bytes: Option<usize>) -> AppResult<TestRunLog> {
        let run = self.find(id).ok_or_else(|| AppError::NotFound(format!("test run {id} (older runs are not kept)")))?;
        let (bytes, dropped) = run.log.lock().tail(max_bytes.unwrap_or(LOG_CAP).clamp(1024, LOG_CAP));
        let status = run.info.lock().status;
        Ok(TestRunLog { id: id.to_string(), status, text: crate::redact::redact(&log_text(&bytes, dropped)), dropped_bytes: dropped })
    }

    /// The newest passing run in the worktree at `root` that ran on commit `sha` with no uncommitted
    /// or untracked files (and nothing changed while it ran). The merge gate's evidence.
    pub fn passing_evidence(&self, root: &Path, sha: &str) -> Option<TestRunInfo> {
        self.list().into_iter().rev().find(|i| {
            i.status == TestRunStatus::Passed
                && i.head_sha.as_deref() == Some(sha)
                && i.uncommitted == Some(0)
                && i.repo_root.as_deref().is_some_and(|r| crate::git::same_path(Path::new(r), root))
        })
    }

    /// End every running tree and drop the queue (app exit).
    pub fn shutdown(&self) {
        let runs = {
            let mut inner = self.inner.lock();
            inner.queue.clear();
            inner.runs.clone()
        };
        for r in runs {
            r.cancel.store(true, Ordering::SeqCst);
            if let Some(c) = r.container.lock().as_ref() {
                let _ = c.terminate(1);
            }
            r.wake.notify_all();
        }
    }

    /// Tests: wait until nothing is queued or running.
    #[cfg(test)]
    fn wait_idle(&self, timeout: Duration) -> bool {
        let until = Instant::now() + timeout;
        while Instant::now() < until {
            if !self.list().iter().any(|i| i.status.is_active()) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        false
    }
}

/// A run got a slot (called under the manager lock, so `cancel` sees it either in the queue or running).
fn mark_launched(run: &Run) {
    let mut i = run.info.lock();
    i.status = TestRunStatus::Running;
    i.started_ms = Some(now_ms());
}

/// Keep every active run and the newest `KEEP_FINISHED` finished ones.
fn trim_finished(runs: &mut Vec<Arc<Run>>) {
    let mut finished_seen = 0;
    let mut keep = vec![true; runs.len()];
    for (i, r) in runs.iter().enumerate().rev() {
        if !r.info.lock().status.is_active() {
            finished_seen += 1;
            if finished_seen > KEEP_FINISHED {
                keep[i] = false;
            }
        }
    }
    let mut it = keep.into_iter();
    runs.retain(|_| it.next().unwrap_or(true));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::process;

    // ---- detection ------------------------------------------------------------------------------

    fn write(dir: &Path, name: &str, text: &str) {
        std::fs::write(dir.join(name), text).unwrap();
    }

    #[test]
    fn detects_package_json_by_lockfile() {
        let t = tempfile::tempdir().unwrap();
        let d = t.path();
        write(d, "package.json", r#"{"scripts":{"test":"vitest run"}}"#);
        let c = detect_in(d);
        assert_eq!(c[0].command, "npm test");
        assert!(c[0].source.contains("vitest run") && c[0].source.contains("no lockfile"), "{}", c[0].source);
        write(d, "pnpm-lock.yaml", "");
        assert_eq!(detect_in(d)[0].command, "pnpm test");
        std::fs::remove_file(d.join("pnpm-lock.yaml")).unwrap();
        write(d, "yarn.lock", "");
        assert_eq!(detect_in(d)[0].command, "yarn test");
        std::fs::remove_file(d.join("yarn.lock")).unwrap();
        write(d, "bun.lock", "");
        assert_eq!(detect_in(d)[0].command, "bun run test");
        std::fs::remove_file(d.join("bun.lock")).unwrap();
        write(d, "package.json", r#"{"packageManager":"pnpm@9.1.0","scripts":{"test":"jest"}}"#);
        assert_eq!(detect_in(d)[0].command, "pnpm test");
        // npm init's placeholder and a missing script are not test commands.
        write(d, "package.json", r#"{"scripts":{"test":"echo \"Error: no test specified\" && exit 1"}}"#);
        assert!(detect_in(d).is_empty());
        write(d, "package.json", r#"{"scripts":{"build":"tsc"}}"#);
        assert!(detect_in(d).is_empty());
        write(d, "package.json", "not json");
        assert!(detect_in(d).is_empty());
    }

    #[test]
    fn detects_other_ecosystems_in_order() {
        let t = tempfile::tempdir().unwrap();
        let d = t.path();
        write(d, "Makefile", "build:\n\tcc x.c\n\ntest: build\n\t./run\n");
        write(d, "go.mod", "module x\n");
        write(d, "pyproject.toml", "[tool.pytest.ini_options]\naddopts='-q'\n");
        write(d, "Cargo.toml", "[package]\nname='x'\n");
        write(d, "package.json", r#"{"scripts":{"test":"vitest run"}}"#);
        let cmds: Vec<String> = detect_in(d).into_iter().map(|c| c.command).collect();
        assert_eq!(cmds, ["npm test", "cargo test", "pytest", "go test ./...", "make test"]);
        let det = detect(&d.to_string_lossy()).unwrap();
        assert_eq!(det.command.as_deref(), Some("npm test"));
        assert_eq!(det.candidates.len(), 5);
        assert!(detect_in(d).iter().any(|c| c.source == "pyproject.toml [tool.pytest.ini_options]"));
    }

    #[test]
    fn makefile_needs_a_test_target() {
        let t = tempfile::tempdir().unwrap();
        let d = t.path();
        write(d, "Makefile", ".PHONY: test\ntest := 1\ntests: x\n");
        assert!(detect_in(d).is_empty());
        write(d, "Makefile", "all:\n\techo\ntest:\n\techo t\n");
        assert_eq!(detect_in(d)[0].command, "make test");
        write(d, "pytest.ini", "[pytest]\n");
        assert_eq!(detect_in(d)[0], TestCandidate { command: "pytest".into(), source: "pytest.ini".into() });
    }

    #[test]
    fn detect_validates_and_tolerates_missing_folders() {
        assert!(detect("relative/dir").is_err());
        assert!(detect("a\0b").is_err());
        let t = tempfile::tempdir().unwrap();
        let missing = t.path().join("gone");
        let d = detect(&missing.to_string_lossy()).unwrap();
        assert!(d.command.is_none() && d.candidates.is_empty());
    }

    #[test]
    fn commands_and_settings_are_validated() {
        assert_eq!(validate_command("  npm test ").unwrap(), "npm test");
        assert!(validate_command("   ").is_err());
        assert!(validate_command("npm test\nrm -rf x").is_err());
        assert!(validate_command(&"x".repeat(MAX_COMMAND_LEN + 1)).is_err());
        let mut c = Some("  cargo test  ".to_string());
        sanitize_command(&mut c);
        assert_eq!(c.as_deref(), Some("cargo test"));
        let mut c = Some(" ".to_string());
        sanitize_command(&mut c);
        assert_eq!(c, None);
        let mut s = TestRunSettings { max_concurrent: 0, timeout_min: 9999 };
        sanitize_settings(&mut s);
        assert_eq!(s, TestRunSettings { max_concurrent: 1, timeout_min: 240 });
    }

    // ---- ring -----------------------------------------------------------------------------------

    #[test]
    fn ring_keeps_the_newest_bytes() {
        let mut r = LogRing::new(8);
        r.push(b"abc");
        r.push(b"defgh");
        assert_eq!(r.tail(100), (b"abcdefgh".to_vec(), 0));
        r.push(b"ij");
        assert_eq!(r.tail(100), (b"cdefghij".to_vec(), 2));
        r.push(b"0123456789AB");
        assert_eq!(r.tail(100), (b"456789AB".to_vec(), 14));
        assert_eq!(r.tail(3), (b"9AB".to_vec(), 19));
        assert_eq!((r.total(), r.len()), (22, 8));
        assert_eq!(log_text(b"partial\nline two\n", 5), "line two\n");
        assert_eq!(log_text(b"\x1b[32mok\x1b[0m\r\n", 0), "ok\n");
    }

    // ---- parsers --------------------------------------------------------------------------------

    const VITEST_PASS: &str = " ✓ src/a.test.ts (3 tests) 5ms\n\n Test Files  41 passed (41)\n      Tests  412 passed (412)\n   Start at  12:00:00\n   Duration  38.2s (transform 1.2s)\n";
    const VITEST_FAIL: &str = " ❯ src/b.test.ts (2 tests | 1 failed) 7ms\n   × b > fails 3ms\n\n⎯⎯⎯ Failed Tests 1 ⎯⎯⎯\n\n FAIL  src/b.test.ts > b > fails\nAssertionError: expected 1 to be 2\n\n Test Files  1 failed | 1 passed (2)\n      Tests  3 failed | 407 passed | 2 skipped (412)\n";
    const JEST_FAIL: &str = "FAIL src/x.test.js\n  ● math › adds\n\n    expect(received).toBe(expected)\n\n  ● Console\n\nTest Suites: 1 failed, 40 passed, 41 total\nTests:       3 failed, 2 skipped, 409 passed, 414 total\nSnapshots:   0 total\nTime:        12.345 s\n";
    const CARGO_FAIL: &str = "running 3 tests\ntest a::ok ... ok\ntest b::bad ... FAILED\n\nfailures:\n    b::bad\n\ntest result: FAILED. 250 passed; 2 failed; 3 ignored; 0 measured; 0 filtered out; finished in 12.34s\n\n   Doc-tests x\n\ntest result: ok. 4 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.50s\n";
    const PYTEST_FAIL: &str = "tests/test_x.py .F.s\n=========================== short test summary info ============================\nFAILED tests/test_x.py::test_y - assert 1 == 2\nERROR tests/test_z.py::test_e - fixture missing\n========== 1 failed, 409 passed, 2 skipped, 1 error, 3 warnings in 12.34s ==========\n";
    const GO_PLAIN: &str = "--- FAIL: TestAdd (0.00s)\n    add_test.go:9: got 3, want 4\nFAIL\nFAIL\texample.com/m/pkg\t0.123s\nok  \texample.com/m/other\t0.050s\nok  \texample.com/m/cached\t(cached)\n?   \texample.com/m/cmd\t[no test files]\nFAIL\n";
    const GO_VERBOSE: &str = "=== RUN   TestA\n--- PASS: TestA (0.00s)\n=== RUN   TestB\n--- FAIL: TestB (0.00s)\n=== RUN   TestC\n--- SKIP: TestC (0.00s)\nFAIL\nFAIL\texample.com/m\t0.1s\n";
    const MOCHA_OUT: &str = "  412 passing (2s)\n  2 pending\n  3 failing\n\n  1) suite\n       fails:\n";

    fn c(runner: &str, unit: &str, passed: u32, failed: u32, skipped: u32) -> Option<TestCounts> {
        Some(TestCounts { runner: runner.into(), unit: unit.into(), passed, failed, skipped })
    }

    #[test]
    fn parses_runner_summaries() {
        assert_eq!(parse_counts(VITEST_PASS), c("vitest", "tests", 412, 0, 0));
        assert_eq!(parse_counts(VITEST_FAIL), c("vitest", "tests", 407, 3, 2));
        assert_eq!(parse_counts(JEST_FAIL), c("jest", "tests", 409, 3, 2));
        assert_eq!(parse_counts(CARGO_FAIL), c("cargo", "tests", 254, 2, 4));
        assert_eq!(parse_counts(PYTEST_FAIL), c("pytest", "tests", 409, 2, 2));
        assert_eq!(parse_counts("==== 412 passed in 3.21s ====\n"), c("pytest", "tests", 412, 0, 0));
        assert_eq!(parse_counts("3 passed, 1 xfailed in 0.02s\n"), c("pytest", "tests", 3, 0, 1));
        assert_eq!(parse_counts("=== no tests ran in 0.01s ===\n"), c("pytest", "tests", 0, 0, 0));
        assert_eq!(parse_counts(GO_PLAIN), c("go", "packages", 2, 1, 0));
        assert_eq!(parse_counts(GO_VERBOSE), c("go", "tests", 1, 1, 1));
        assert_eq!(parse_counts(MOCHA_OUT), c("mocha", "tests", 412, 3, 2));
        assert_eq!(parse_counts("hello\nworld\n"), None);
        assert_eq!(parse_counts(""), None);
        // Several runners in one run are summed.
        let both = format!("{VITEST_PASS}\n{CARGO_FAIL}");
        assert_eq!(parse_counts(&both), c("vitest+cargo", "tests", 666, 2, 4));
        // The last vitest summary wins (watch-like reruns print several).
        let twice = format!("      Tests  1 failed | 2 passed (3)\n{VITEST_PASS}");
        assert_eq!(parse_counts(&twice), c("vitest", "tests", 412, 0, 0));
    }

    #[test]
    fn finds_failing_test_names() {
        assert_eq!(failing_names(VITEST_FAIL), ["src/b.test.ts > b > fails"]);
        assert_eq!(failing_names(JEST_FAIL), ["src/x.test.js", "math › adds"]);
        assert_eq!(failing_names(CARGO_FAIL), ["b::bad"]);
        assert_eq!(failing_names(PYTEST_FAIL), ["tests/test_x.py::test_y", "tests/test_z.py::test_e"]);
        assert_eq!(failing_names(GO_PLAIN), ["TestAdd"]);
        assert!(failing_names(VITEST_PASS).is_empty());
        let many: String = (0..30).map(|i| format!("test t{i} ... FAILED\n")).collect();
        assert_eq!(failing_names(&many).len(), MAX_FAILURES);
    }

    #[test]
    fn last_lines_skip_blanks() {
        assert_eq!(last_lines("a\n\n  \nb  \nc\n", 2), ["b", "c"]);
        assert_eq!(last_lines("", 5), Vec::<String>::new());
        assert_eq!(last_lines(&"x".repeat(400), 1)[0].chars().count(), 300);
    }

    #[test]
    fn exit_codes_map_to_statuses() {
        assert_eq!(status_for_exit(Some(0)), TestRunStatus::Passed);
        assert_eq!(status_for_exit(Some(1)), TestRunStatus::Failed);
        assert_eq!(status_for_exit(None), TestRunStatus::Failed);
        let nf = if cfg!(windows) { 9009 } else { 127 };
        assert_eq!(status_for_exit(Some(nf)), TestRunStatus::Error);
        let lines = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<String>>();
        // cmd.exe does not always exit with 9009: its message counts too.
        let cmd = lines(&["'npx' is not recognized as an internal or external command,", "operable program or batch file."]);
        assert!(looks_not_found(Some(1), &cmd));
        assert_eq!(not_found_line(&cmd).map(String::as_str), Some(cmd[0].as_str()));
        assert!(looks_not_found(Some(127), &lines(&["sh: 1: pytest: not found"])));
        assert!(looks_not_found(Some(1), &lines(&["bash: pytest: command not found"])));
        assert!(looks_not_found(Some(nf), &[]));
        assert!(!looks_not_found(Some(1), &lines(&["FAIL src/a.test.ts", "Tests  1 failed (1)"])));
        assert!(!looks_not_found(Some(0), &cmd), "a passing run is never 'not found'");
    }

    #[test]
    fn path_keys_match_the_frontend() {
        assert_eq!(path_key(r"D:\Repo\wt\ "), r"d:\repo\wt");
        assert_eq!(path_key("D:/Repo/wt/"), r"d:\repo\wt");
    }

    // ---- runner lifecycle (real shells) ---------------------------------------------------------

    fn settings(max: u32) -> TestRunSettings {
        TestRunSettings { max_concurrent: max, timeout_min: 1 }
    }

    fn spec(dir: &Path, command: &str) -> TestRunSpec {
        TestRunSpec { cwd: dir.to_string_lossy().into_owned(), command: command.into(), label: "t".into(), session_id: None, timeout_sec: None }
    }

    fn wait_status(m: &Manager, id: &str, timeout: Duration) -> TestRunInfo {
        let until = Instant::now() + timeout;
        loop {
            let i = m.info(id).expect("run is known");
            if !i.status.is_active() || Instant::now() >= until {
                return i;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// A command that prints a line and exits with `code`.
    fn exit_with(code: i32) -> String {
        if cfg!(windows) { format!("echo hello from the run & exit /b {code}") } else { format!("echo hello from the run; exit {code}") }
    }

    /// A command that runs for ~30 s and starts a grandchild.
    fn long_running() -> &'static str {
        if cfg!(windows) { "ping -n 30 127.0.0.1 >NUL" } else { "sleep 30 & sleep 30" }
    }

    #[test]
    fn runs_pass_and_fail_with_output() {
        let m = Arc::new(Manager::new());
        let events = Arc::new(Mutex::new(Vec::<TestRunStatus>::new()));
        let ev = Arc::clone(&events);
        m.ensure_emitter(|| Arc::new(move |i: &TestRunInfo| ev.lock().push(i.status)));
        let t = tempfile::tempdir().unwrap();

        let ok = m.start(spec(t.path(), &exit_with(0)), &settings(2)).unwrap();
        let ok = wait_status(&m, &ok.id, Duration::from_secs(30));
        assert_eq!(ok.status, TestRunStatus::Passed, "{ok:?}");
        assert_eq!(ok.exit_code, Some(0));
        assert!(ok.duration_ms.is_some() && ok.ended_ms.is_some());
        assert_eq!(ok.last_lines.last().map(String::as_str), Some("hello from the run"));
        assert!(m.log(&ok.id, None).unwrap().text.contains("hello from the run"));

        let bad = m.start(spec(t.path(), &exit_with(3)), &settings(2)).unwrap();
        let bad = wait_status(&m, &bad.id, Duration::from_secs(30));
        assert_eq!((bad.status, bad.exit_code), (TestRunStatus::Failed, Some(3)));
        let ev = events.lock().clone();
        // A run that gets a slot at once is reported as running (queued only while waiting for a slot).
        assert!(ev.contains(&TestRunStatus::Running) && ev.contains(&TestRunStatus::Passed) && ev.contains(&TestRunStatus::Failed), "{ev:?}");

        let missing = m.start(spec(t.path(), "definitely-not-a-command-gridkeeper-xyz"), &settings(2)).unwrap();
        let missing = wait_status(&m, &missing.id, Duration::from_secs(30));
        assert_eq!(missing.status, TestRunStatus::Error, "{missing:?}");
        assert!(missing.error.is_some());

        assert!(m.start(spec(t.path(), "two\nlines"), &settings(2)).is_err());
        assert!(m.start(spec(&t.path().join("gone"), "x"), &settings(2)).is_err());
        assert!(matches!(m.log("nope", None), Err(AppError::NotFound(_))));
    }

    #[test]
    fn cancel_and_timeout_end_the_tree() {
        let m = Arc::new(Manager::new());
        let t = tempfile::tempdir().unwrap();
        let t2 = tempfile::tempdir().unwrap();
        let run = m.start(spec(t.path(), long_running()), &settings(2)).unwrap();
        // Same folder while active: the same run comes back.
        assert_eq!(m.start(spec(t.path(), "other"), &settings(2)).unwrap().id, run.id);
        std::thread::sleep(Duration::from_millis(400));
        let begun = Instant::now();
        assert!(m.cancel(&run.id));
        let done = wait_status(&m, &run.id, Duration::from_secs(10));
        assert_eq!(done.status, TestRunStatus::Cancelled);
        assert!(begun.elapsed() < Duration::from_secs(8), "cancel took {:?}", begun.elapsed());
        assert!(!m.cancel(&run.id), "finished runs cannot be cancelled");

        let mut sp = spec(t2.path(), long_running());
        sp.timeout_sec = Some(1); // clamped to MIN_TIMEOUT_SEC
        let run = m.start(sp, &settings(2)).unwrap();
        assert_eq!(run.timeout_sec, MIN_TIMEOUT_SEC);
        let done = wait_status(&m, &run.id, Duration::from_secs(40));
        assert_eq!(done.status, TestRunStatus::TimedOut, "{done:?}");
        assert!(done.error.as_deref().is_some_and(|e| e.contains("time limit")));
        assert!(m.wait_idle(Duration::from_secs(5)));
    }

    #[test]
    fn concurrency_is_capped_and_the_queue_drains() {
        let m = Arc::new(Manager::new());
        let dirs: Vec<_> = (0..3).map(|_| tempfile::tempdir().unwrap()).collect();
        let a = m.start(spec(dirs[0].path(), long_running()), &settings(1)).unwrap();
        let b = m.start(spec(dirs[1].path(), &exit_with(0)), &settings(1)).unwrap();
        let c = m.start(spec(dirs[2].path(), &exit_with(0)), &settings(1)).unwrap();
        assert_eq!(b.status, TestRunStatus::Queued);
        std::thread::sleep(Duration::from_millis(300));
        assert_eq!(m.info(&b.id).unwrap().status, TestRunStatus::Queued, "only one slot");
        // Cancelling a queued run never starts it.
        assert!(m.cancel(&c.id));
        assert_eq!(m.info(&c.id).unwrap().status, TestRunStatus::Cancelled);
        assert!(m.cancel(&a.id));
        let b = wait_status(&m, &b.id, Duration::from_secs(30));
        assert_eq!(b.status, TestRunStatus::Passed, "the queued run started once the slot was free: {b:?}");
        assert!(m.info(&c.id).unwrap().started_ms.is_none());
        assert!(m.wait_idle(Duration::from_secs(5)));
    }

    #[test]
    fn evidence_needs_a_clean_tree_at_the_same_commit() {
        if crate::git::git_exe().is_none() {
            return;
        }
        let t = tempfile::tempdir().unwrap();
        let repo = t.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let git = |args: &[&str]| {
            let mut cmd = process::hidden_command(crate::git::git_exe().unwrap());
            let null = if cfg!(windows) { "NUL" } else { "/dev/null" };
            cmd.arg("-C").arg(&repo).args(args).env("GIT_CONFIG_NOSYSTEM", "1").env("GIT_CONFIG_GLOBAL", null);
            let o = process::run_with_timeout(cmd, Duration::from_secs(30)).unwrap();
            assert!(o.status.success(), "{args:?}: {}", String::from_utf8_lossy(&o.stderr));
            String::from_utf8_lossy(&o.stdout).trim().to_string()
        };
        git(&["init", "-q", "-b", "main"]);
        std::fs::write(repo.join("a.txt"), "a\n").unwrap();
        git(&["add", "a.txt"]);
        git(&["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "init"]);
        let sha = git(&["rev-parse", "HEAD"]);

        let m = Arc::new(Manager::new());
        let run = m.start(spec(&repo, &exit_with(0)), &settings(2)).unwrap();
        let run = wait_status(&m, &run.id, Duration::from_secs(30));
        assert_eq!(run.status, TestRunStatus::Passed);
        assert_eq!(run.head_sha.as_deref(), Some(sha.as_str()));
        assert_eq!(run.uncommitted, Some(0));
        assert!(m.passing_evidence(&repo, &sha).is_some());
        assert!(m.passing_evidence(&repo, "0000000000000000000000000000000000000000").is_none());

        // An untracked file: the run is not evidence for the commit.
        std::fs::write(repo.join("new.txt"), "n\n").unwrap();
        let dirty = m.start(spec(&repo, &exit_with(0)), &settings(2)).unwrap();
        let dirty = wait_status(&m, &dirty.id, Duration::from_secs(30));
        assert_eq!(dirty.uncommitted, Some(1));
        assert_eq!(m.passing_evidence(&repo, &sha).map(|i| i.id), Some(run.id), "only the clean run counts");
    }
}
