use super::*;
use crate::meter::{DIR_NAME, record_name};

fn base_with_meter() -> (tempfile::TempDir, PathBuf, PathBuf) {
    let t = tempfile::tempdir().unwrap();
    let base = t.path().join("app.gridkeeper.desktop");
    let meter = base.join(DIR_NAME);
    std::fs::create_dir_all(&meter).unwrap();
    (t, base, meter)
}

fn ex(event: &str, json: &str) -> Option<HookRecord> {
    extract(event, &mut json.as_bytes(), 7)
}

// ---------------------------------------------------------------------------
// Payload whitelisting
// ---------------------------------------------------------------------------

/// Payloads shaped like the hooks reference examples, with every sensitive field filled in.
const COMMON: &str = r#""session_id":"0f8fad5b-d9cb-469f-a165-70867728950e","prompt_id":"p-1",
    "transcript_path":"C:/Users/me/.claude/projects/secret-proj/abc.jsonl","cwd":"C:/work/secret-proj",
    "scratchpad_dir":"C:/Users/me/AppData/Local/Temp/scratch","permission_mode":"default","effort":{"level":"high"}"#;

fn payload(event: &str, extra: &str) -> String {
    format!(r#"{{{COMMON},"hook_event_name":"{event}"{extra}}}"#)
}

const BANNED: &[&str] = &[
    "transcript",
    "jsonl",
    "secret",
    "C:/work",
    "C:/Users",
    "scratch",
    "rm -rf",
    "node_modules",
    "SECRET_TOKEN",
    "factorial",
    "Permission needed",
    "needs your permission",
    "Cannot find module",
    "Irreversible",
    "refactoring",
    "Rate limit reached",
    "429",
    "file content",
    "effort",
    "high",
    "addRules",
];

fn assert_clean(rec: &HookRecord) {
    let json = serde_json::to_string(rec).unwrap();
    for b in BANNED {
        assert!(!json.contains(b), "{b:?} leaked into {json}");
    }
}

#[test]
fn extract_keeps_only_safe_fields_for_every_event() {
    let cases: Vec<(&str, String)> = vec![
        ("PreToolUse", payload("PreToolUse", r#","tool_name":"Bash","tool_input":{"command":"rm -rf node_modules","description":"x SECRET_TOKEN"},"tool_use_id":"toolu_1""#)),
        (
            "PermissionRequest",
            payload(
                "PermissionRequest",
                r#","tool_name":"Bash","tool_input":{"command":"rm -rf node_modules"},"permission_suggestions":[{"type":"addRules","rules":[{"toolName":"Bash","ruleContent":"rm -rf node_modules"}]}]"#,
            ),
        ),
        (
            "PostToolUse",
            payload("PostToolUse", r#","tool_name":"Write","tool_input":{"file_path":"C:/work/secret-proj/a.txt","content":"file content"},"tool_response":{"filePath":"C:/work/secret-proj/a.txt"},"duration_ms":12"#),
        ),
        (
            "PostToolUseFailure",
            payload("PostToolUseFailure", r#","tool_name":"Bash","tool_input":{"command":"npm test"},"error":"Exit code 1\nError: Cannot find module 'express'","is_interrupt":false"#),
        ),
        ("PermissionDenied", payload("PermissionDenied", r#","tool_name":"Bash","tool_input":{"command":"rm -rf /tmp"},"reason":"[Irreversible Local Destruction]""#)),
        ("UserPromptSubmit", payload("UserPromptSubmit", r#","prompt":"Write a function to calculate the factorial of SECRET_TOKEN""#)),
        (
            "Notification",
            payload("Notification", r#","message":"Claude needs your permission to use Bash","title":"Permission needed","notification_type":"permission_prompt""#),
        ),
        (
            "Stop",
            payload("Stop", r#","stop_hook_active":true,"last_assistant_message":"I've completed the refactoring.","background_tasks":[{"command":"tail -f C:/work/secret.log"}]"#),
        ),
        (
            "SubagentStop",
            payload("SubagentStop", r#","agent_id":"def456","agent_type":"Explore","agent_transcript_path":"C:/Users/me/.claude/x.jsonl","last_assistant_message":"refactoring done""#),
        ),
        ("StopFailure", payload("StopFailure", r#","error":"rate_limit","error_details":"429 Too Many Requests","last_assistant_message":"API Error: Rate limit reached""#)),
        ("SessionStart", payload("SessionStart", r#","source":"startup","model":"claude-opus","session_title":"secret plan""#)),
        ("SessionEnd", payload("SessionEnd", r#","reason":"clear""#)),
    ];
    for (event, json) in &cases {
        let rec = ex(event, json).unwrap_or_else(|| panic!("{event}"));
        assert_eq!(rec.event, *event);
        assert_eq!(rec.t, 7);
        assert_eq!(rec.v, RECORD_VERSION);
        assert_eq!(rec.claude_session_id.as_deref(), Some("0f8fad5b-d9cb-469f-a165-70867728950e"));
        assert_clean(&rec);
    }
    let get = |e: &str| ex(e, &cases.iter().find(|(n, _)| *n == e).unwrap().1).unwrap();
    assert_eq!(get("PreToolUse").tool.as_deref(), Some("Bash"));
    assert_eq!(get("PermissionRequest").tool.as_deref(), Some("Bash"));
    assert_eq!(get("PostToolUse").tool.as_deref(), Some("Write"));
    let f = get("PostToolUseFailure");
    assert_eq!((f.tool.as_deref(), f.detail.as_deref(), f.interrupt), (Some("Bash"), None, false), "error text never kept");
    assert_eq!(get("PermissionDenied").detail, None, "the denial reason is free text");
    assert_eq!(get("Notification").notification.as_deref(), Some("permission_prompt"));
    assert_eq!(get("StopFailure").detail.as_deref(), Some("rate_limit"));
    assert_eq!(get("SessionStart").detail.as_deref(), Some("startup"));
    assert_eq!(get("SessionEnd").detail.as_deref(), Some("clear"));
    assert!(get("SubagentStop").subagent);
    assert!(!get("Stop").subagent);
    // Tool names never leak through non-tool events.
    assert_eq!(ex("Stop", &payload("Stop", r#","tool_name":"Bash""#)).unwrap().tool, None);
}

#[test]
fn extract_rejects_and_sanitizes() {
    // Unknown event (command line), or a payload naming a different event.
    assert!(ex("Bogus", "{}").is_none());
    assert!(ex("Stop", r#"{"hook_event_name":"PreToolUse"}"#).is_none());
    // A payload that isn't JSON (or is cut off) still records the event.
    let r = ex("Stop", "not json").unwrap();
    assert_eq!((r.event.as_str(), r.claude_session_id.as_deref()), ("Stop", None));
    assert!(ex("Stop", "").is_some());
    // Odd values are dropped, not stored.
    let r = ex(
        "PreToolUse",
        r#"{"hook_event_name":"PreToolUse","session_id":"../../etc","tool_name":"Bash; rm -rf /","agent_id":7}"#,
    )
    .unwrap();
    assert_eq!((r.claude_session_id, r.tool, r.subagent), (None, None, false));
    let r = ex("Notification", r#"{"notification_type":"permission prompt!"}"#).unwrap();
    assert_eq!(r.notification, None);
    let r = ex("StopFailure", r#"{"error":"API Error: something long and free-form"}"#).unwrap();
    assert_eq!(r.detail, None);
    assert_eq!(ex("PreToolUse", r#"{"tool_name":"mcp__github__create_issue"}"#).unwrap().tool.as_deref(), Some("mcp__github__create_issue"));
    assert!(ex("PostToolUseFailure", r#"{"tool_name":"Bash","is_interrupt":true}"#).unwrap().interrupt);
}

#[test]
fn large_tool_payloads_are_streamed_past() {
    let big = "x".repeat(8 * 1024 * 1024);
    let json = format!(r#"{{"hook_event_name":"PostToolUse","tool_name":"Read","tool_response":{{"content":"{big}"}},"session_id":"s1"}}"#);
    let rec = extract("PostToolUse", &mut json.as_bytes(), 1).unwrap();
    assert_eq!((rec.tool.as_deref(), rec.claude_session_id.as_deref()), (Some("Read"), Some("s1")));
    assert!(serde_json::to_vec(&rec).unwrap().len() < 300);
}

// ---------------------------------------------------------------------------
// Helper: paths, writes, exit code
// ---------------------------------------------------------------------------

#[test]
fn state_path_must_be_a_hooks_file_inside_the_data_folder() {
    let (t, base, meter) = base_with_meter();
    assert!(validate_state_path(&meter.join(hooks_name("pane-1")), &base).is_ok());
    let sb = base.join("sandboxes").join("dev").join(DIR_NAME);
    std::fs::create_dir_all(&sb).unwrap();
    assert!(validate_state_path(&sb.join(hooks_name("pane-1")), &base).is_ok());
    let outside = t.path().join("elsewhere").join(DIR_NAME);
    std::fs::create_dir_all(&outside).unwrap();
    assert!(validate_state_path(&outside.join(hooks_name("pane-1")), &base).is_err());
    let sneaky = meter.join("..").join("..").join("elsewhere").join(DIR_NAME).join(hooks_name("pane-1"));
    assert!(validate_state_path(&sneaky, &base).is_err());
    for bad in [record_name("pane-1"), "settings-x.hooks.json".into(), "a b.hooks.json".into(), ".hooks.json".into(), "x.hooks.json.tmp".into()] {
        assert!(validate_state_path(&meter.join(&bad), &base).is_err(), "{bad}");
    }
    assert!(validate_state_path(Path::new("meter/pane-1.hooks.json"), &base).is_err());
    // A meter record path is not accepted as a hook file, and the other way round.
    assert!(crate::meter::helper::validate_meter_path(&meter.join(hooks_name("pane-1")), &base).is_err());
    assert_eq!(session_of_hooks_name("pane-1.hooks.json"), Some("pane-1"));
    assert_eq!(crate::meter::session_of_record_name("pane-1.hooks.json"), None);
}

#[test]
fn run_writes_atomically_never_fails_and_keeps_the_newest() {
    let (_t, base, meter) = base_with_meter();
    let file = meter.join(hooks_name("p"));
    let args = |ev: &str| vec![ev.to_string(), STATE_FILE_FLAG.to_string(), file.to_string_lossy().into_owned()];
    let pr = payload("PermissionRequest", r#","tool_name":"Bash","tool_input":{"command":"rm -rf node_modules"}"#);
    assert_eq!(run(&args("PermissionRequest"), &mut pr.as_bytes(), Some(&base), 200), 0);
    let rec = read_record(&file).unwrap();
    assert_eq!((rec.event.as_str(), rec.tool.as_deref(), rec.t), ("PermissionRequest", Some("Bash"), 200));
    assert_clean(&rec);
    // An older helper that finishes later doesn't overwrite it.
    let pre = payload("PreToolUse", r#","tool_name":"Bash""#);
    assert_eq!(run(&args("PreToolUse"), &mut pre.as_bytes(), Some(&base), 150), 0);
    assert_eq!(read_record(&file).unwrap().event, "PermissionRequest");
    assert_eq!(run(&args("PostToolUse"), &mut payload("PostToolUse", "").as_bytes(), Some(&base), 300), 0);
    assert_eq!(read_record(&file).unwrap().event, "PostToolUse");
    let leftovers: Vec<_> = std::fs::read_dir(&meter).unwrap().flatten().filter(|e| e.path() != file).collect();
    assert!(leftovers.is_empty(), "no temp files: {leftovers:?}");

    // Bad arguments, unknown events, files outside the data folder: exit 0 (exit 2 would block Claude), nothing written.
    for bad in [vec![], vec!["--bogus".to_string()], vec!["Bogus".into(), STATE_FILE_FLAG.into(), file.to_string_lossy().into_owned()], vec!["Stop".into()]] {
        assert_eq!(run(&bad, &mut b"{}".as_slice(), Some(&base), 999), 0, "{bad:?}");
    }
    let other = tempfile::tempdir().unwrap();
    let stray = other.path().join(DIR_NAME);
    std::fs::create_dir_all(&stray).unwrap();
    let a = vec!["Stop".to_string(), STATE_FILE_FLAG.into(), stray.join(hooks_name("p")).to_string_lossy().into_owned()];
    assert_eq!(run(&a, &mut b"{}".as_slice(), Some(&base), 999), 0);
    assert!(!stray.join(hooks_name("p")).exists());
    assert_eq!(run(&args("Stop"), &mut b"{}".as_slice(), None, 999), 0, "unknown data folder: nothing written");
    assert_eq!(read_record(&file).unwrap().t, 300);
}

#[test]
fn parse_args_shapes() {
    let a = parse_args(&["Notification".into(), STATE_FILE_FLAG.into(), "C:/x/meter/p.hooks.json".into()]).unwrap();
    assert_eq!(a.event, "Notification");
    assert_eq!(a.state_file, PathBuf::from("C:/x/meter/p.hooks.json"));
    assert!(parse_args(&[STATE_FILE_FLAG.into(), "x".into()]).is_err());
    assert!(parse_args(&["Stop".into(), STATE_FILE_FLAG.into()]).is_err());
    assert!(is_invocation(Some(OsStr::new(FLAG))));
    assert!(!is_invocation(Some(OsStr::new(crate::meter::helper::FLAG))));
}

#[test]
fn hooks_json_has_one_async_command_per_event() {
    let sh = StatusShell::GitBash("bash.exe".into());
    let exe = Path::new("C:/Program Files/Gridkeeper/gridkeeper.exe");
    let file = Path::new("C:/Users/A B/AppData/Roaming/app.gridkeeper.desktop/meter/p-1.hooks.json");
    let v = hooks_json(exe, file, &sh).unwrap();
    let obj = v.as_object().unwrap();
    assert_eq!(obj.len(), EVENTS.len());
    for ev in EVENTS {
        let groups = obj[*ev].as_array().unwrap();
        assert_eq!(groups.len(), 1);
        let g = &groups[0];
        assert_eq!(g.get("matcher").and_then(Value::as_str), MATCHER_EVENTS.contains(ev).then_some("*"), "{ev}");
        let h = &g["hooks"].as_array().unwrap()[0];
        assert_eq!(h["type"], "command");
        assert_eq!(h["async"], true);
        assert_eq!(h["timeout"], HOOK_TIMEOUT_S);
        assert!(h.get("args").is_none(), "shell form, like the status line (exec form needs a newer Claude Code)");
        let cmd = h["command"].as_str().unwrap();
        assert_eq!(
            cmd,
            format!("'C:/Program Files/Gridkeeper/gridkeeper.exe' --gk-hook {ev} --state-file 'C:/Users/A B/AppData/Roaming/app.gridkeeper.desktop/meter/p-1.hooks.json'")
        );
    }
    let ps = hooks_json(exe, file, &StatusShell::PowerShell("pwsh".into())).unwrap();
    assert!(ps["Stop"][0]["hooks"][0]["command"].as_str().unwrap().starts_with("& 'C:/Program Files/Gridkeeper/gridkeeper.exe' --gk-hook Stop"));
    assert!(hooks_json(Path::new("C:/it's/gk.exe"), file, &sh).is_err());
}

// ---------------------------------------------------------------------------
// Host state machine
// ---------------------------------------------------------------------------

fn r(event: &str, t: u64) -> HookRecord {
    HookRecord { v: RECORD_VERSION, event: event.into(), t, ..HookRecord::default() }
}

fn tool(event: &str, name: &str, t: u64) -> HookRecord {
    HookRecord { tool: Some(name.into()), ..r(event, t) }
}

fn note(kind: &str, t: u64) -> HookRecord {
    HookRecord { notification: Some(kind.into()), ..r("Notification", t) }
}

fn st(u: Option<HookUpdate>) -> Option<(&'static str, Option<String>, Option<String>)> {
    u.map(|u| (u.state.as_str(), u.tool, u.reason))
}

fn s(state: &'static str, tool: Option<&str>) -> Option<(&'static str, Option<String>, Option<String>)> {
    Some((state, tool.map(Into::into), None))
}

const MS: u64 = 1000;
const SEC: u64 = 1_000_000;

#[test]
fn permission_prompt_flow() {
    let mut p = PaneHooks::default();
    assert_eq!(st(p.apply(&HookRecord { detail: Some("startup".into()), ..r("SessionStart", 1 * SEC) })), Some(("ready", None, Some("startup".into()))));
    assert_eq!(st(p.apply(&r("UserPromptSubmit", 2 * SEC))), s("working", None));
    assert_eq!(st(p.apply(&tool("PreToolUse", "Bash", 3 * SEC))), s("tool", Some("Bash")));
    assert_eq!(st(p.apply(&tool("PermissionRequest", "Bash", 3 * SEC + 5 * MS))), s("permission", Some("Bash")));
    assert!(p.is_waiting());
    // The same call's PreToolUse reported late (its helper started a bit later) changes nothing.
    assert_eq!(p.apply(&tool("PreToolUse", "Bash", 3 * SEC + 9 * MS)), None);
    // ~6 s later Claude's own permission notification: still the same prompt, nothing new to show.
    assert_eq!(p.apply(&note("permission_prompt", 9 * SEC)), None);
    assert_eq!(p.apply(&note("idle_prompt", 70 * SEC)), None, "idle_prompt never hides a prompt");
    // Arrow keys / focus reports don't answer it; Enter does.
    assert_eq!(p.on_input(b"\x1b[B"), None);
    assert_eq!(p.on_input(b"\x1b[I"), None);
    assert!(p.is_waiting());
    assert_eq!(st(p.on_input(b"\r")), s("tool", Some("Bash")));
    assert!(!p.is_waiting());
    assert_eq!(st(p.apply(&tool("PostToolUse", "Bash", 80 * SEC))), s("working", None));
    let stop = p.apply(&r("Stop", 92 * SEC)).unwrap();
    assert_eq!((stop.state, stop.active_ms), (HookState::Stopped, Some(90_000)));
    assert_eq!(p.apply(&r("Stop", 93 * SEC)), None, "a repeated stop is not shown twice");
    assert_eq!(st(p.apply(&note("idle_prompt", 152 * SEC))), s("idle-prompt", None));
}

#[test]
fn stale_records_are_ignored_and_parallel_calls_keep_the_prompt() {
    let mut p = PaneHooks::default();
    p.apply(&r("UserPromptSubmit", 10 * SEC));
    assert_eq!(st(p.apply(&tool("PermissionRequest", "Bash", 20 * SEC))), s("permission", Some("Bash")));
    // An older record (a helper that started earlier but finished later).
    assert_eq!(p.apply(&tool("PreToolUse", "Bash", 19 * SEC)), None);
    assert_eq!(p.apply(&r("UserPromptSubmit", 20 * SEC)), None, "same timestamp = not newer");
    // Other calls of the same batch run and finish while the prompt waits.
    assert_eq!(p.apply(&tool("PreToolUse", "Read", 20 * SEC + 300 * MS)), None);
    assert_eq!(p.apply(&tool("PostToolUse", "Read", 20 * SEC + 400 * MS)), None);
    assert!(p.is_waiting());
    // A later, different call means the prompt was answered (the user approved without a keystroke
    // Gridkeeper saw, e.g. a hook of their own allowed it).
    assert_eq!(st(p.apply(&tool("PreToolUse", "Edit", 30 * SEC))), s("tool", Some("Edit")));
    assert!(!p.is_waiting());
    // A permission notification without a PermissionRequest names the recent tool.
    assert_eq!(st(p.apply(&note("permission_prompt", 36 * SEC))), s("permission", Some("Edit")));
    // The waiting call finishing ends the wait too.
    assert_eq!(st(p.apply(&tool("PostToolUse", "Edit", 50 * SEC))), s("working", None));
}

#[test]
fn questions_interrupts_failures_and_sessions() {
    let mut p = PaneHooks::default();
    p.apply(&r("UserPromptSubmit", 1 * SEC));
    // AskUserQuestion / ExitPlanMode wait for the user like a permission prompt.
    assert_eq!(st(p.apply(&tool("PreToolUse", "AskUserQuestion", 2 * SEC))), s("input", Some("AskUserQuestion")));
    assert!(p.is_waiting());
    assert_eq!(st(p.apply(&tool("PostToolUse", "AskUserQuestion", 9 * SEC))), s("working", None));
    // MCP input dialogs.
    assert_eq!(st(p.apply(&note("elicitation_dialog", 10 * SEC))), s("input", None));
    assert_eq!(st(p.apply(&note("elicitation_complete", 11 * SEC))), s("working", None));
    // Esc while Claude works interrupts the turn (no Stop hook comes).
    assert_eq!(st(p.apply(&tool("PreToolUse", "Bash", 12 * SEC))), s("tool", Some("Bash")));
    assert_eq!(st(p.on_input(b"\x1b")), Some(("stopped", None, Some("interrupt".into()))));
    assert_eq!(p.on_input(b"\x1b"), None, "nothing more to interrupt");
    // Esc on a prompt declines it and stops the turn.
    p.apply(&r("UserPromptSubmit", 20 * SEC));
    p.apply(&tool("PermissionRequest", "Bash", 21 * SEC));
    assert_eq!(st(p.on_input(b"\x1b")), Some(("stopped", None, Some("interrupt".into()))));
    // Ctrl+C while working, an aborted tool, an API error.
    p.apply(&r("UserPromptSubmit", 30 * SEC));
    assert_eq!(st(p.on_input(b"\x03")), Some(("stopped", None, Some("interrupt".into()))));
    p.apply(&r("UserPromptSubmit", 40 * SEC));
    let abort = HookRecord { interrupt: true, ..tool("PostToolUseFailure", "Bash", 41 * SEC) };
    assert_eq!(st(p.apply(&abort)), Some(("stopped", None, Some("interrupt".into()))));
    p.apply(&r("UserPromptSubmit", 50 * SEC));
    assert_eq!(st(p.apply(&HookRecord { detail: Some("rate_limit".into()), ..r("StopFailure", 51 * SEC) })), Some(("stopped", None, Some("rate_limit".into()))));
    // /clear: SessionEnd then SessionStart.
    assert_eq!(st(p.apply(&HookRecord { detail: Some("clear".into()), ..r("SessionEnd", 60 * SEC) })), Some(("ended", None, Some("clear".into()))));
    assert_eq!(st(p.apply(&HookRecord { detail: Some("clear".into()), ..r("SessionStart", 60 * SEC + 1) })), Some(("ready", None, Some("clear".into()))));
    // Typing while nothing runs or waits is not a state change.
    assert_eq!(p.on_input(b"hello\r"), None);
    // Unknown notification types and events are ignored.
    assert_eq!(p.apply(&note("auth_success", 70 * SEC)), None);
    assert_eq!(p.apply(&r("Bogus", 71 * SEC)), None);
}

#[test]
fn answer_and_interrupt_keys() {
    for k in [&b"\r"[..], b"1", b"2", b"y", b"N", b"\x1b", b"\x03", b"abc\r"] {
        assert!(is_answer_key(k), "{k:?}");
    }
    for k in [&b"\x1b[A"[..], b"\x1b[B", b"\x1b[I", b"\x1b[O", b"a", b"\t", b"12", b""] {
        assert!(!is_answer_key(k), "{k:?}");
    }
    assert!(is_interrupt_key(b"\x1b") && is_interrupt_key(b"\x03"));
    assert!(!is_interrupt_key(b"\x1b[A") && !is_interrupt_key(b"\r"));
}

#[test]
fn updates_become_hook_attention_events() {
    let u = HookUpdate { state: HookState::Permission, tool: Some("Bash".into()), reason: None, active_ms: None };
    let a = u.to_attention("pane-1");
    assert_eq!(a.kind, AttentionKind::Hook);
    assert_eq!((a.id.as_str(), a.status.as_deref(), a.tool.as_deref()), ("pane-1", Some("permission"), Some("Bash")));
    let json = serde_json::to_value(&a).unwrap();
    assert_eq!(json, json!({ "id": "pane-1", "kind": "hook", "status": "permission", "tool": "Bash" }));
}
