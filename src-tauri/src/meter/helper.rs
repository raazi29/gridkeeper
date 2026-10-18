//! Status line helper mode: `gridkeeper.exe --gk-statusline --meter-file <file> [--chain-b64 <b64url>]`.
//!
//! Claude Code runs this command on every status line update (event driven: new assistant message,
//! `/compact`, mode changes...; debounced at 300 ms; no timer because no `refreshInterval` is set).
//! `main.rs` dispatches here before anything Tauri-related: no window, no logging setup, no state.
//!
//! What it does, in order:
//! 1. reads the status line JSON from stdin (capped at [`MAX_INPUT`]);
//! 2. keeps a whitelisted subset ([`extract`]): `session_id`, `cost.total_cost_usd`,
//!    `cost.total_duration_ms`, `cost.total_api_duration_ms`, `context_window.{context_window_size,
//!    used_percentage, total_input_tokens, total_output_tokens, current_usage.*}`, `rate_limits.*`
//!    (numbers and a short period name only) and `model.{display_name,id}`. Everything else, including
//!    `transcript_path`, `workspace` and `cwd`, is skipped by the parser and never stored;
//! 3. writes that subset atomically to the meter file, which must be inside
//!    `%APPDATA%\app.gridkeeper.desktop\` (sandboxes included) and named `<session>.json` in a `meter`
//!    folder ([`validate_meter_path`]), else nothing is written;
//! 4. prints the user's own status line when one was chained (`--chain-b64`): their command, run the way
//!    Claude Code runs status lines on this OS, fed the same stdin, 2 s timeout. Otherwise prints nothing.
//!
//! It never fails loudly: Claude Code shows whatever is printed, so every error path prints nothing
//! (or only the chained output) and exits 0.

use std::ffi::OsStr;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use base64::Engine;
use serde::Deserialize;
use serde_json::Value;

use super::shell::{self, StatusShell};
use super::{MeterRecord, RateWindow};

/// argv[1] that selects helper mode.
pub const FLAG: &str = "--gk-statusline";
pub const METER_FILE_FLAG: &str = "--meter-file";
pub const CHAIN_FLAG: &str = "--chain-b64";
/// Status line JSON larger than this is ignored (nothing written, nothing chained).
pub const MAX_INPUT: usize = 256 * 1024;
/// Chained status line output kept (the rest is dropped).
pub const MAX_CHAIN_OUTPUT: usize = 64 * 1024;
/// The user's status line command must finish within this.
pub const CHAIN_TIMEOUT: Duration = Duration::from_secs(2);
/// Longest user status line command that is chained (it travels base64-encoded on the command line).
pub const MAX_CHAIN_COMMAND: usize = 4096;
/// Environment variable that carries the chained command into its shell (never on a command line).
pub const CHAIN_ENV: &str = "GK_STATUSLINE_CHAIN";

const MAX_TEXT: usize = 128;
const MAX_KEYS: usize = 16;
const MAX_WINDOWS: usize = 8;

/// Whether this process was started as the status line helper.
pub fn is_invocation(arg1: Option<&OsStr>) -> bool {
    arg1.is_some_and(|a| a == FLAG)
}

/// `main()` entry: runs the helper when argv[1] is [`FLAG`] and returns its exit code.
pub fn main_from_env() -> Option<i32> {
    let mut args = std::env::args_os();
    let _exe = args.next();
    let first = args.next();
    if !is_invocation(first.as_deref()) {
        return None;
    }
    let rest: Vec<String> = args.map(|a| a.to_string_lossy().into_owned()).collect();
    let base = allowed_base();
    let stdin = io::stdin();
    let stdout = io::stdout();
    let code = run(&rest, &mut stdin.lock(), &mut stdout.lock(), base.as_deref(), super::now_ms());
    Some(code)
}

/// `%APPDATA%\app.gridkeeper.desktop` (the folder every meter file must live under).
pub fn allowed_base() -> Option<PathBuf> {
    dirs::config_dir().map(|d| d.join(super::APP_IDENTIFIER))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HelperArgs {
    pub meter_file: PathBuf,
    /// The user's own status line command (decoded).
    pub chain: Option<String>,
}

pub fn parse_args(args: &[String]) -> Result<HelperArgs, String> {
    let mut meter_file = None;
    let mut chain = None;
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            METER_FILE_FLAG => meter_file = Some(PathBuf::from(it.next().ok_or("--meter-file needs a value")?)),
            CHAIN_FLAG => chain = Some(decode_chain(it.next().ok_or("--chain-b64 needs a value")?)?),
            other => return Err(format!("unknown argument {other:?}")),
        }
    }
    Ok(HelperArgs { meter_file: meter_file.ok_or("--meter-file is required")?, chain })
}

/// URL-safe base64 without padding: no `/` (MSYS would rewrite an argument starting with it), no `+`/`=`.
pub fn encode_chain(cmd: &str) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(cmd.as_bytes())
}

pub fn decode_chain(b64: &str) -> Result<String, String> {
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(b64.trim())
        .map_err(|e| format!("bad --chain-b64: {e}"))?;
    let s = String::from_utf8(bytes).map_err(|_| "--chain-b64 is not UTF-8".to_string())?;
    if s.trim().is_empty() || s.len() > MAX_CHAIN_COMMAND || s.contains('\0') {
        return Err("unusable chained command".into());
    }
    Ok(s)
}

/// Read at most `cap` bytes. `None` = the input was larger (it is then ignored entirely).
pub fn read_capped(r: &mut dyn Read, cap: usize) -> io::Result<Option<Vec<u8>>> {
    let mut buf = Vec::with_capacity(4096);
    r.take(cap as u64 + 1).read_to_end(&mut buf)?;
    Ok((buf.len() <= cap).then_some(buf))
}

/// The only top-level keys the parser keeps; serde skips everything else (`transcript_path`,
/// `workspace`, `cwd`, `output_style`, ...) without storing it.
#[derive(Deserialize, Default)]
#[serde(default)]
struct StatusInput {
    session_id: Value,
    cost: Value,
    context_window: Value,
    rate_limits: Value,
    model: Value,
}

fn num(v: Option<&Value>) -> Option<f64> {
    v.and_then(Value::as_f64).filter(|n| n.is_finite() && *n >= 0.0)
}

fn uint(v: Option<&Value>) -> Option<u64> {
    num(v).filter(|n| *n <= 9.0e15).map(|n| n.round() as u64)
}

/// Short display text: control characters removed, at most `max` characters.
fn text(v: Option<&Value>, max: usize) -> Option<String> {
    let s: String = v?.as_str()?.chars().filter(|c| !c.is_control()).take(max).collect();
    let s = s.trim().to_string();
    (!s.is_empty()).then_some(s)
}

fn is_key(k: &str, max: usize) -> bool {
    !k.is_empty() && k.len() <= max && k.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

/// Claude conversation ids: `[A-Za-z0-9_-]{1,128}`.
pub fn valid_claude_session_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= 128 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Parse the status line JSON and keep the whitelisted fields. `None` = not a JSON object.
pub fn extract(input: &[u8], now_ms: u64) -> Option<MeterRecord> {
    let input = input.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(input);
    let first = input.iter().find(|b| !b.is_ascii_whitespace())?;
    if *first != b'{' {
        return None;
    }
    let s: StatusInput = serde_json::from_slice(input).ok()?;
    let cost = &s.cost;
    let ctx = &s.context_window;
    let mut rec = MeterRecord {
        v: super::RECORD_VERSION,
        claude_session_id: s.session_id.as_str().filter(|id| valid_claude_session_id(id)).map(str::to_string),
        cost_usd: num(cost.get("total_cost_usd")),
        duration_ms: uint(cost.get("total_duration_ms")),
        api_duration_ms: uint(cost.get("total_api_duration_ms")),
        context_size: uint(ctx.get("context_window_size")),
        context_pct: num(ctx.get("used_percentage")).map(|p| p.min(1000.0)),
        input_tokens: uint(ctx.get("total_input_tokens")),
        output_tokens: uint(ctx.get("total_output_tokens")),
        updated_ms: now_ms,
        ..MeterRecord::default()
    };
    if let Some(usage) = ctx.get("current_usage").and_then(Value::as_object) {
        for (k, v) in usage.iter().filter(|(k, _)| is_key(k, 48)).take(MAX_KEYS) {
            if let Some(n) = uint(Some(v)) {
                rec.current_usage.insert(k.clone(), n);
            }
        }
    }
    if let Some(limits) = s.rate_limits.as_object() {
        for (k, v) in limits.iter().filter(|(k, v)| is_key(k, 32) && v.is_object()).take(MAX_WINDOWS) {
            let w = RateWindow {
                used_pct: num(v.get("used_percentage")),
                resets_at: uint(v.get("resets_at")),
                used_usd: num(v.get("used_usd")),
                limit_usd: num(v.get("limit_usd")),
                period: text(v.get("period"), 32),
            };
            rec.rate_limits.insert(k.clone(), w);
        }
    }
    match &s.model {
        Value::Object(m) => {
            rec.model = text(m.get("display_name"), MAX_TEXT);
            rec.model_id = text(m.get("id"), MAX_TEXT);
        }
        v @ Value::String(_) => rec.model = text(Some(v), MAX_TEXT),
        _ => {}
    }
    Some(rec)
}

/// The meter file must be `<base>\...\meter\<session>.json`, where `<base>` is Gridkeeper's own data
/// folder (`%APPDATA%\app.gridkeeper.desktop`, sandboxes are below it). Returns the canonical path.
pub fn validate_meter_path(path: &Path, base: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err("meter file must be an absolute path".into());
    }
    let name = path.file_name().and_then(OsStr::to_str).ok_or("meter file has no name")?;
    if super::session_of_record_name(name).is_none() {
        return Err(format!("unexpected meter file name {name:?}"));
    }
    let parent = path.parent().ok_or("meter file has no folder")?;
    if !parent.file_name().is_some_and(|n| n.eq_ignore_ascii_case(super::DIR_NAME)) {
        return Err("meter file must be in a 'meter' folder".into());
    }
    let canon_parent = std::fs::canonicalize(parent).map_err(|e| format!("meter folder: {e}"))?;
    let canon_base = std::fs::canonicalize(base).map_err(|e| format!("data folder: {e}"))?;
    if !canon_parent.starts_with(&canon_base) {
        return Err("meter file is outside Gridkeeper's data folder".into());
    }
    let target = canon_parent.join(name);
    if let Ok(m) = std::fs::symlink_metadata(&target) {
        if !m.file_type().is_file() {
            return Err("meter file is not a regular file".into());
        }
    }
    Ok(target)
}

/// Atomic write of the record (see [`super::write_atomic`]).
pub fn write_record(path: &Path, rec: &MeterRecord) -> io::Result<()> {
    let bytes = serde_json::to_vec(rec).map_err(io::Error::other)?;
    super::write_atomic(path, &bytes)
}

/// The helper. `base` is the allowed data folder (`None` = unknown: nothing is written).
pub fn run(args: &[String], input: &mut dyn Read, out: &mut dyn Write, base: Option<&Path>, now_ms: u64) -> i32 {
    let Ok(parsed) = parse_args(args) else {
        return 2;
    };
    let bytes = read_capped(input, MAX_INPUT).ok().flatten();
    if let (Some(bytes), Some(base)) = (&bytes, base) {
        if let Some(rec) = extract(bytes, now_ms) {
            if let Ok(path) = validate_meter_path(&parsed.meter_file, base) {
                let _ = write_record(&path, &rec);
            }
        }
    }
    if let (Some(cmd), Some(bytes)) = (&parsed.chain, &bytes) {
        let sh = shell::detect(&shell::process_env);
        if let Some(output) = run_chain(&sh, cmd, bytes, CHAIN_TIMEOUT) {
            let _ = out.write_all(&output);
        }
    }
    let _ = out.flush();
    0
}

/// How the user's command is started for `shell`. The command itself travels in [`CHAIN_ENV`], so
/// no user text is ever re-quoted onto a command line.
pub fn chain_command(sh: &StatusShell, cmd: &str) -> Command {
    let mut c = match sh {
        StatusShell::GitBash(bash) => {
            let mut c = Command::new(bash);
            c.arg("-c").arg(format!("__gk_c=\"${CHAIN_ENV}\"; unset {CHAIN_ENV}; eval \"$__gk_c\""));
            c
        }
        StatusShell::PowerShell(ps) => {
            let mut c = Command::new(ps);
            c.args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"])
                .arg(format!("Invoke-Expression $env:{CHAIN_ENV}"));
            c
        }
        StatusShell::Sh => {
            let mut c = Command::new("sh");
            c.arg("-c").arg(format!("__gk_c=\"${CHAIN_ENV}\"; unset {CHAIN_ENV}; eval \"$__gk_c\""));
            c
        }
    };
    c.env(CHAIN_ENV, cmd);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // The release helper is a GUI-subsystem process without a console: a console child would
        // otherwise pop up a window.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    c
}

/// Run the user's status line command with `input` on stdin; its stdout (capped) on success,
/// `None` on spawn failure or timeout (the child is killed).
pub fn run_chain(sh: &StatusShell, cmd: &str, input: &[u8], timeout: Duration) -> Option<Vec<u8>> {
    let mut c = chain_command(sh, cmd);
    c.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    let mut child = c.spawn().ok()?;
    let deadline = Instant::now() + timeout;
    if let Some(mut stdin) = child.stdin.take() {
        let data = input.to_vec();
        // A command that never reads stdin must not block us: write from a thread, drop = EOF.
        std::thread::spawn(move || {
            let _ = stdin.write_all(&data);
        });
    }
    let (tx, rx) = mpsc::channel();
    if let Some(stdout) = child.stdout.take() {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = stdout.take(MAX_CHAIN_OUTPUT as u64).read_to_end(&mut buf);
            let _ = tx.send(buf);
        });
    }
    let out = rx.recv_timeout(timeout).ok();
    // Output closed (or timed out): give the process the rest of the budget to exit, then kill it.
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if out.is_some() && Instant::now() < deadline => std::thread::sleep(Duration::from_millis(5)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::meter::{record_name, DIR_NAME};

    const SAMPLE: &str = r#"{
        "hook_event_name": "Status",
        "session_id": "abc123-def",
        "transcript_path": "C:/Users/me/.claude/projects/x/abc123-def.jsonl",
        "cwd": "C:/work/secret-project",
        "model": { "id": "claude-opus-4-1", "display_name": "Opus 4.1" },
        "workspace": { "current_dir": "C:/work/secret-project", "project_dir": "C:/work" },
        "version": "2.1.300",
        "cost": { "total_cost_usd": 0.4213, "total_duration_ms": 45000, "total_api_duration_ms": 2300,
                  "total_lines_added": 156, "total_lines_removed": 23 },
        "context_window": { "total_input_tokens": 74000, "total_output_tokens": 2100,
                            "context_window_size": 200000, "used_percentage": 37, "remaining_percentage": 63,
                            "current_usage": { "input_tokens": 8500, "output_tokens": 1200,
                                               "cache_creation_input_tokens": 5000, "cache_read_input_tokens": 2000 } },
        "rate_limits": { "five_hour": { "used_percentage": 23.5, "resets_at": 1738425600 },
                         "seven_day": { "used_percentage": 41.2, "resets_at": 1738857600 } }
    }"#;

    #[test]
    fn extract_keeps_only_whitelisted_fields() {
        let rec = extract(SAMPLE.as_bytes(), 1234).unwrap();
        assert_eq!(rec.claude_session_id.as_deref(), Some("abc123-def"));
        assert_eq!(rec.cost_usd, Some(0.4213));
        assert_eq!(rec.duration_ms, Some(45000));
        assert_eq!(rec.api_duration_ms, Some(2300));
        assert_eq!(rec.context_size, Some(200000));
        assert_eq!(rec.context_pct, Some(37.0));
        assert_eq!(rec.input_tokens, Some(74000));
        assert_eq!(rec.output_tokens, Some(2100));
        assert_eq!(rec.current_usage.get("cache_read_input_tokens"), Some(&2000));
        assert_eq!(rec.rate_limits["five_hour"].used_pct, Some(23.5));
        assert_eq!(rec.rate_limits["seven_day"].resets_at, Some(1738857600));
        assert_eq!(rec.model.as_deref(), Some("Opus 4.1"));
        assert_eq!(rec.model_id.as_deref(), Some("claude-opus-4-1"));
        assert_eq!(rec.updated_ms, 1234);
        // Nothing else survives: no transcript path, no folders, no line counts.
        let json = serde_json::to_string(&rec).unwrap();
        for banned in ["transcript", "jsonl", "secret-project", "C:/work", "lines_added", "version", "2.1.300"] {
            assert!(!json.contains(banned), "{banned} leaked into {json}");
        }
    }

    #[test]
    fn extract_handles_missing_null_and_wrong_types() {
        let rec = extract(br#"{"session_id":"s1"}"#, 1).unwrap();
        assert_eq!(rec.claude_session_id.as_deref(), Some("s1"));
        assert_eq!(rec.cost_usd, None);
        assert!(rec.rate_limits.is_empty());

        let rec = extract(
            br#"{"session_id":"../../etc","cost":{"total_cost_usd":"lots"},"context_window":{"used_percentage":null,
                "current_usage":null,"context_window_size":-5},"rate_limits":{"Bad Key":{"used_percentage":1},
                "five_hour":7},"model":"Sonnet\u0007 4"}"#,
            1,
        )
        .unwrap();
        assert_eq!(rec.claude_session_id, None, "invalid ids are dropped");
        assert_eq!(rec.cost_usd, None);
        assert_eq!(rec.context_pct, None);
        assert_eq!(rec.context_size, None);
        assert!(rec.rate_limits.is_empty());
        assert_eq!(rec.model.as_deref(), Some("Sonnet 4"));

        assert!(extract(b"not json", 1).is_none());
        assert!(extract(b"[1,2]", 1).is_none());
        assert!(extract(b"", 1).is_none());
        // BOM + whitespace are fine.
        assert!(extract(b"\xEF\xBB\xBF  {}", 1).is_some());
    }

    #[test]
    fn oversize_input_is_ignored() {
        let big = vec![b' '; MAX_INPUT + 1];
        assert_eq!(read_capped(&mut big.as_slice(), MAX_INPUT).unwrap(), None);
        let ok = vec![b' '; MAX_INPUT];
        assert_eq!(read_capped(&mut ok.as_slice(), MAX_INPUT).unwrap().map(|v| v.len()), Some(MAX_INPUT));
    }

    fn base_with_meter() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let t = tempfile::tempdir().unwrap();
        let base = t.path().join("app.gridkeeper.desktop");
        let meter = base.join(DIR_NAME);
        std::fs::create_dir_all(&meter).unwrap();
        (t, base, meter)
    }

    #[test]
    fn meter_path_must_be_inside_the_data_folder() {
        let (t, base, meter) = base_with_meter();
        let id = "0f8fad5b-d9cb-469f-a165-70867728950e";
        assert!(validate_meter_path(&meter.join(record_name(id)), &base).is_ok());
        // Sandbox data folders live below the base.
        let sb = base.join("sandboxes").join("dev").join(DIR_NAME);
        std::fs::create_dir_all(&sb).unwrap();
        assert!(validate_meter_path(&sb.join(record_name(id)), &base).is_ok());
        // Outside the base, even through `..`.
        let outside = t.path().join("elsewhere").join(DIR_NAME);
        std::fs::create_dir_all(&outside).unwrap();
        assert!(validate_meter_path(&outside.join(record_name(id)), &base).is_err());
        let sneaky = meter.join("..").join("..").join("elsewhere").join(DIR_NAME).join(record_name(id));
        assert!(validate_meter_path(&sneaky, &base).is_err());
        // Wrong folder name, wrong file names, relative paths, missing folders.
        std::fs::create_dir_all(base.join("logs")).unwrap();
        assert!(validate_meter_path(&base.join("logs").join(record_name(id)), &base).is_err());
        for bad in ["settings-abc.json", "abc.txt", "a b.json", ".abc.json", "workspaces.json.bak"] {
            assert!(validate_meter_path(&meter.join(bad), &base).is_err(), "{bad}");
        }
        assert!(validate_meter_path(Path::new("meter/abc.json"), &base).is_err());
        assert!(validate_meter_path(&base.join("nope").join(DIR_NAME).join("abc.json"), &base).is_err());
        // A folder squatting on the file name is refused.
        std::fs::create_dir_all(meter.join("dir.json")).unwrap();
        assert!(validate_meter_path(&meter.join("dir.json"), &base).is_err());
    }

    #[test]
    fn run_writes_the_record_atomically_and_prints_nothing_without_chain() {
        let (_t, base, meter) = base_with_meter();
        let file = meter.join(record_name("s-1"));
        let args = vec![METER_FILE_FLAG.to_string(), file.to_string_lossy().into_owned()];
        let mut out = Vec::new();
        let code = run(&args, &mut SAMPLE.as_bytes(), &mut out, Some(&base), 77);
        assert_eq!(code, 0);
        assert!(out.is_empty(), "no chain → empty status line");
        let rec: MeterRecord = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
        assert_eq!(rec.cost_usd, Some(0.4213));
        assert_eq!(rec.updated_ms, 77);
        // No temp files left behind.
        let leftovers: Vec<_> = std::fs::read_dir(&meter).unwrap().flatten().filter(|e| e.file_name() != *record_name("s-1")).collect();
        assert!(leftovers.is_empty());

        // Outside the base: exit 0, nothing written.
        let other = tempfile::tempdir().unwrap();
        let stray = other.path().join(DIR_NAME);
        std::fs::create_dir_all(&stray).unwrap();
        let args = vec![METER_FILE_FLAG.to_string(), stray.join("s-1.json").to_string_lossy().into_owned()];
        assert_eq!(run(&args, &mut SAMPLE.as_bytes(), &mut out, Some(&base), 1), 0);
        assert!(!stray.join("s-1.json").exists());

        // Bad arguments.
        assert_eq!(run(&["--bogus".into()], &mut SAMPLE.as_bytes(), &mut out, Some(&base), 1), 2);
        assert_eq!(run(&[], &mut SAMPLE.as_bytes(), &mut out, Some(&base), 1), 2);
    }

    #[test]
    fn chain_b64_round_trip_and_limits() {
        for cmd in ["bash ~/.claude/statusline.sh", "jq -r '\"\\(.model.display_name)\"'", "echo ünï €", "powershell -NoProfile -File C:/x/s.ps1"] {
            let b = encode_chain(cmd);
            assert!(!b.contains(['/', '+', '=']), "{b}");
            assert_eq!(decode_chain(&b).unwrap(), cmd);
        }
        assert!(decode_chain("!!!").is_err());
        assert!(decode_chain(&encode_chain("   ")).is_err());
        assert!(decode_chain(&encode_chain(&"x".repeat(MAX_CHAIN_COMMAND + 1))).is_err());
        let args = vec![METER_FILE_FLAG.into(), "C:/m/meter/a.json".into(), CHAIN_FLAG.into(), encode_chain("echo hi")];
        assert_eq!(parse_args(&args).unwrap().chain.as_deref(), Some("echo hi"));
    }

    #[test]
    fn chain_command_per_shell_keeps_user_text_off_the_command_line() {
        let cmd = "echo \"$HOME\" 'x' & | ;";
        for sh in [StatusShell::GitBash("C:/Git/bin/bash.exe".into()), StatusShell::PowerShell("pwsh".into()), StatusShell::Sh] {
            let c = chain_command(&sh, cmd);
            let args: Vec<String> = c.get_args().map(|a| a.to_string_lossy().into_owned()).collect();
            assert!(!args.iter().any(|a| a.contains("$HOME")), "{args:?}");
            let env: Vec<_> = c.get_envs().filter(|(k, _)| *k == OsStr::new(CHAIN_ENV)).collect();
            assert_eq!(env.len(), 1);
            assert_eq!(env[0].1, Some(OsStr::new(cmd)));
            match sh {
                StatusShell::GitBash(_) | StatusShell::Sh => assert_eq!(args[0], "-c"),
                StatusShell::PowerShell(_) => assert!(args.contains(&"-NoProfile".to_string())),
            }
        }
    }

    const CHILD_BASE_ENV: &str = "GK_METER_TEST_CHILD_BASE";
    const CHILD_FILE_ENV: &str = "GK_METER_TEST_CHILD_FILE";

    /// Child half of `helper_runs_as_a_child_process_with_pipes`; a no-op in a normal test run.
    #[test]
    fn helper_child_entry() {
        let (Some(base), Some(file)) = (std::env::var_os(CHILD_BASE_ENV), std::env::var_os(CHILD_FILE_ENV)) else {
            return;
        };
        let args = vec![METER_FILE_FLAG.to_string(), file.to_string_lossy().into_owned()];
        let t0 = Instant::now();
        let code = run(&args, &mut io::stdin().lock(), &mut io::stdout().lock(), Some(Path::new(&base)), 99);
        eprintln!("helper core: {:?}", t0.elapsed());
        std::process::exit(code);
    }

    /// The no-chain path as a real child process with redirected stdin/stdout (this test binary stands
    /// in for gridkeeper.exe, whose debug build is locked by a running sandbox): the record lands, and
    /// the wall time (process start + test harness + helper) is printed.
    #[test]
    fn helper_runs_as_a_child_process_with_pipes() {
        let (_t, base, meter) = base_with_meter();
        let file = meter.join(record_name("child"));
        let exe = std::env::current_exe().unwrap();
        let mut times = Vec::new();
        for _ in 0..7 {
            let _ = std::fs::remove_file(&file);
            let t0 = Instant::now();
            let mut child = Command::new(&exe)
                .args(["meter::helper::tests::helper_child_entry", "--exact", "--quiet", "--test-threads=1"])
                .env(CHILD_BASE_ENV, &base)
                .env(CHILD_FILE_ENV, &file)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .unwrap();
            child.stdin.take().unwrap().write_all(SAMPLE.as_bytes()).unwrap();
            let out = child.wait_with_output().unwrap();
            times.push(t0.elapsed());
            assert!(out.status.success(), "{out:?}");
            let rec: MeterRecord = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
            assert_eq!((rec.cost_usd, rec.updated_ms), (Some(0.4213), 99));
        }
        times.sort();
        eprintln!("helper child process wall time: min {:?}, median {:?}, max {:?}", times[0], times[3], times[6]);
        assert!(times[3] < Duration::from_secs(5), "{times:?}");
    }

    /// The helper's own work (parse, whitelist, validate, atomic write) without process start.
    #[test]
    fn helper_core_is_fast() {
        let (_t, base, meter) = base_with_meter();
        let args = vec![METER_FILE_FLAG.to_string(), meter.join(record_name("fast")).to_string_lossy().into_owned()];
        let mut out = Vec::new();
        let t0 = Instant::now();
        for i in 0..20 {
            assert_eq!(run(&args, &mut SAMPLE.as_bytes(), &mut out, Some(&base), i), 0);
        }
        let per = t0.elapsed() / 20;
        eprintln!("helper core per run: {per:?}");
        assert!(per < Duration::from_millis(50), "{per:?}");
    }

    /// The chained command really receives the same stdin and its stdout is printed (real shell).
    #[test]
    fn chain_runs_with_stdin_and_timeout() {
        let sh = shell::detect(&shell::process_env);
        let (echo, slow) = match &sh {
            StatusShell::GitBash(_) | StatusShell::Sh => ("read -r line; printf 'got:%s' \"$line\"", "sleep 5"),
            StatusShell::PowerShell(_) => ("$l = [Console]::In.ReadLine(); Write-Output \"got:$l\"", "Start-Sleep 5"),
        };
        let out = run_chain(&sh, echo, b"{\"a\":1}\n", Duration::from_secs(20)).expect("chained output");
        let s = String::from_utf8_lossy(&out);
        assert!(s.trim_end().ends_with("got:{\"a\":1}"), "{s:?} via {sh:?}");
        let t0 = Instant::now();
        assert_eq!(run_chain(&sh, slow, b"", Duration::from_millis(500)), None);
        assert!(t0.elapsed() < Duration::from_secs(4), "timeout must kill the child");
    }
}
