use super::*;
use crate::meter::launch::{self, LaunchDecision, LaunchInput};
use crate::meter::shell::StatusShell;
use std::sync::mpsc::Receiver;

fn rec(sid: &str, cost: f64, t: u64) -> MeterRecord {
    MeterRecord {
        v: RECORD_VERSION,
        claude_session_id: Some(sid.into()),
        cost_usd: Some(cost),
        context_pct: Some(10.0),
        updated_ms: t,
        ..MeterRecord::default()
    }
}

#[test]
fn identifier_matches_tauri_conf() {
    let conf: serde_json::Value = serde_json::from_str(include_str!("../../tauri.conf.json")).unwrap();
    assert_eq!(conf["identifier"].as_str(), Some(APP_IDENTIFIER));
}

#[test]
fn file_names() {
    assert!(valid_session_id("0f8fad5b-d9cb-469f-a165-70867728950e"));
    for bad in ["", "a/b", "a.b", "..", "settings-x", &"x".repeat(65), "a b"] {
        assert!(!valid_session_id(bad), "{bad:?}");
    }
    assert_eq!(session_of_record_name("abc.json"), Some("abc"));
    assert_eq!(session_of_record_name("settings-abc.json"), None);
    assert_eq!(session_of_record_name(".abc.json.12.tmp"), None);
    assert_eq!(settings_name("abc"), "settings-abc.json");
}

#[test]
fn pane_total_sums_the_last_cost_per_claude_session_across_clear() {
    let mut p = PaneMeter::default();
    assert_eq!(p.pane_total(), None);
    assert!(p.apply(rec("a", 0.10, 1)));
    assert!(p.apply(rec("a", 0.40, 2)));
    assert!(!p.apply(rec("a", 0.40, 2)), "the same record twice is not a change");
    assert_eq!(p.pane_total(), Some(0.40));
    // /clear: a new Claude session id starts at $0.
    assert!(p.apply(rec("b", 0.0, 3)));
    assert!(p.apply(rec("b", 0.25, 4)));
    let v = p.view("pane");
    assert_eq!(v.cost_usd, Some(0.25), "cost of the current conversation");
    assert!((v.pane_cost_usd.unwrap() - 0.65).abs() < 1e-9, "{:?}", v.pane_cost_usd);
    assert_eq!(v.claude_session_id.as_deref(), Some("b"));
    // Back to "a" (resumed) with a fresh counter: its earlier spend is kept.
    assert!(p.apply(rec("a", 0.05, 5)));
    assert!((p.pane_total().unwrap() - 0.70).abs() < 1e-9, "{:?}", p.pane_total());
    // Records without cost (e.g. before the first API call) don't touch the total.
    let mut no_cost = rec("c", 0.0, 6);
    no_cost.cost_usd = None;
    assert!(p.apply(no_cost));
    assert!((p.pane_total().unwrap() - 0.70).abs() < 1e-9);
}

#[test]
fn pane_total_caps_remembered_conversations() {
    let mut p = PaneMeter::default();
    for i in 0..(MAX_BUCKETS + 10) {
        p.apply(rec(&format!("s{i}"), 1.0, i as u64));
    }
    assert_eq!(p.buckets.len(), MAX_BUCKETS);
    assert!((p.pane_total().unwrap() - (MAX_BUCKETS + 10) as f64).abs() < 1e-9);
}

fn collecting_hub(data: &Path) -> (Arc<MeterHub>, Receiver<SessionMeter>) {
    let (tx, rx) = mpsc::channel();
    let tx = parking_lot::Mutex::new(tx);
    let hub = Arc::new(MeterHub::new(
        data,
        Some(PathBuf::from("C:/Gridkeeper/gridkeeper.exe")),
        Vec::new(),
        Arc::new(move |m: &SessionMeter| {
            let _ = tx.lock().send(m.clone());
        }),
    ));
    (hub, rx)
}

#[test]
fn ingest_emits_and_forget_deletes_files() {
    let t = tempfile::tempdir().unwrap();
    let (hub, rx) = collecting_hub(t.path());
    let dir = hub.dir().to_path_buf();
    assert!(dir.is_dir());
    let id = "pane-1";
    let file = dir.join(record_name(id));
    write_atomic(&file, &serde_json::to_vec(&rec("c1", 0.42, 10)).unwrap()).unwrap();
    let v = hub.ingest(&file).expect("changed");
    assert_eq!(v.session_id, id);
    assert_eq!(rx.try_recv().unwrap().cost_usd, Some(0.42));
    assert!(hub.ingest(&file).is_none(), "unchanged file → no event");
    assert!(rx.try_recv().is_err());
    // Not meter records: ignored.
    std::fs::write(dir.join("settings-pane-1.json"), "{}").unwrap();
    assert!(hub.ingest(&dir.join("settings-pane-1.json")).is_none());
    std::fs::write(dir.join("junk.json"), "not json").unwrap();
    assert!(hub.ingest(&dir.join("junk.json")).is_none());
    // Oversize records are ignored.
    std::fs::write(dir.join("big.json"), vec![b' '; MAX_RECORD_BYTES as usize + 1]).unwrap();
    assert!(read_record(&dir.join("big.json")).is_none());

    hub.note_launch(id, MeterStatus::Metered, None, true);
    let v = rx.try_recv().unwrap();
    assert_eq!((v.status, v.chained, v.cost_usd), (MeterStatus::Metered, true, Some(0.42)));
    assert_eq!(hub.snapshot().iter().filter(|m| m.session_id == id).count(), 1);

    hub.forget(id);
    assert!(!file.exists() && !dir.join("settings-pane-1.json").exists());
    assert!(hub.get(id).is_none());
}

#[test]
fn startup_loads_records_and_cleans_stale_files() {
    let t = tempfile::tempdir().unwrap();
    let dir = meter_dir(t.path());
    std::fs::create_dir_all(&dir).unwrap();
    write_atomic(&dir.join("fresh.json"), &serde_json::to_vec(&rec("c", 1.5, 5)).unwrap()).unwrap();
    for name in ["old.json", "settings-old.json", ".old.json.1.tmp"] {
        let p = dir.join(name);
        std::fs::write(&p, "{}").unwrap();
        let f = std::fs::File::options().write(true).open(&p).unwrap();
        f.set_modified(SystemTime::now() - STALE_AFTER - Duration::from_secs(60)).unwrap();
    }
    std::fs::write(dir.join("keep.txt"), "not ours").unwrap();
    let (hub, rx) = collecting_hub(t.path());
    assert!(dir.join("fresh.json").exists());
    for name in ["old.json", "settings-old.json", ".old.json.1.tmp"] {
        assert!(!dir.join(name).exists(), "{name} should be cleaned");
    }
    assert!(dir.join("keep.txt").exists());
    let snap = hub.snapshot();
    assert_eq!(snap.len(), 1);
    assert_eq!((snap[0].session_id.as_str(), snap[0].pane_cost_usd, snap[0].status), ("fresh", Some(1.5), MeterStatus::Unknown));
    assert!(rx.try_recv().is_err(), "startup load emits nothing");
}

/// The helper writes a record; the folder watch (no polling) turns it into a `session-meter` event.
#[test]
fn watcher_turns_helper_writes_into_events() {
    let t = tempfile::tempdir().unwrap();
    let data = t.path().join(APP_IDENTIFIER);
    let (hub, rx) = collecting_hub(&data);
    hub.start_watch().unwrap();
    let file = hub.dir().join(record_name("pane-w"));
    let args = vec![helper::METER_FILE_FLAG.to_string(), file.to_string_lossy().into_owned()];
    let json = br#"{"session_id":"c-1","transcript_path":"x","cost":{"total_cost_usd":0.5},"context_window":{"used_percentage":81,"context_window_size":200000}}"#;
    let mut out = Vec::new();
    assert_eq!(helper::run(&args, &mut json.as_slice(), &mut out, Some(&data), 42), 0);
    let ev = rx.recv_timeout(Duration::from_secs(10)).expect("session-meter event");
    assert_eq!(ev.session_id, "pane-w");
    assert_eq!(ev.cost_usd, Some(0.5));
    assert_eq!(ev.pane_cost_usd, Some(0.5));
    assert_eq!(ev.context_pct, Some(81.0));
    assert_eq!(ev.updated_ms, Some(42));
    // After /clear: a new conversation, the pane total keeps the earlier spend.
    let json2 = br#"{"session_id":"c-2","cost":{"total_cost_usd":0.25}}"#;
    assert_eq!(helper::run(&args, &mut json2.as_slice(), &mut out, Some(&data), 43), 0);
    let ev = loop {
        let ev = rx.recv_timeout(Duration::from_secs(10)).expect("second event");
        if ev.updated_ms == Some(43) {
            break ev;
        }
    };
    assert_eq!(ev.claude_session_id.as_deref(), Some("c-2"));
    assert!((ev.pane_cost_usd.unwrap() - 0.75).abs() < 1e-9);
    hub.stop();
}

// ---------------------------------------------------------------------------
// Launch decisions
// ---------------------------------------------------------------------------

struct LaunchFx {
    _t: tempfile::TempDir,
    cwd: PathBuf,
    root: PathBuf,
    meter: PathBuf,
}

fn launch_fx() -> LaunchFx {
    let t = tempfile::tempdir().unwrap();
    let cwd = t.path().join("project");
    let root = t.path().join("claude-home");
    let meter = t.path().join("data").join(DIR_NAME);
    for d in [&cwd, &root, &meter] {
        std::fs::create_dir_all(d).unwrap();
    }
    LaunchFx { cwd, root, meter, _t: t }
}

fn input<'a>(fx: &'a LaunchFx, args: &'a [String], sh: &'a StatusShell, managed: &'a [PathBuf]) -> LaunchInput<'a> {
    LaunchInput {
        session_id: "s-1",
        user_args: args,
        cwd: &fx.cwd,
        config_root: Some(&fx.root),
        meter_dir: &fx.meter,
        exe: Path::new("C:/Gridkeeper/gridkeeper.exe"),
        shell: sh,
        managed,
        hooks: false,
    }
}

#[test]
fn decide_injects_only_a_status_line() {
    let fx = launch_fx();
    let sh = StatusShell::GitBash("bash.exe".into());
    let d = launch::decide(&input(&fx, &[], &sh, &[]));
    let LaunchDecision::Inject { settings_path, settings_json, chained, note, status, hooks } = d else { panic!("{d:?}") };
    assert_eq!(settings_path, fx.meter.join("settings-s-1.json"));
    assert!(!chained);
    assert_eq!(note, None);
    assert_eq!((status, hooks), (MeterStatus::Metered, false));
    let v: serde_json::Value = serde_json::from_str(&settings_json).unwrap();
    assert_eq!(v.as_object().unwrap().len(), 1, "only statusLine: {settings_json}");
    let sl = &v["statusLine"];
    assert_eq!(sl["type"], "command");
    assert_eq!(sl["padding"], 0);
    assert!(sl.get("refreshInterval").is_none(), "no timer");
    let cmd = sl["command"].as_str().unwrap();
    let meter_file = shell::command_path(&fx.meter.join("s-1.json"));
    assert!(cmd.starts_with("C:/Gridkeeper/gridkeeper.exe --gk-statusline --meter-file "), "{cmd}");
    assert!(cmd.contains(&meter_file) || cmd.contains(&format!("'{meter_file}'")), "{cmd}");
    assert!(!cmd.contains('\\'), "Git Bash eats backslashes: {cmd}");
    assert!(!cmd.contains("--chain-b64"));
}

#[test]
fn decide_skips_when_the_user_passes_settings() {
    let fx = launch_fx();
    let sh = StatusShell::Sh;
    for args in [vec!["--settings".to_string(), "x.json".into()], vec!["--model".into(), "opus".into(), "--settings={}".into()]] {
        match launch::decide(&input(&fx, &args, &sh, &[])) {
            LaunchDecision::Skip { status, note } => {
                assert_eq!(status, MeterStatus::CustomSettings);
                assert_eq!(note, launch::NOTE_CUSTOM_SETTINGS);
            }
            d => panic!("{d:?}"),
        }
    }
    // A prompt that merely mentions it is not the flag.
    assert!(matches!(launch::decide(&input(&fx, &["use --settingsx".into()], &sh, &[])), LaunchDecision::Inject { .. }));
}

#[test]
fn decide_chains_the_users_effective_status_line() {
    let fx = launch_fx();
    let sh = StatusShell::GitBash("bash.exe".into());
    std::fs::write(
        fx.root.join("settings.json"),
        r#"{"env":{"ANTHROPIC_API_KEY":"sk-ant-secret"},"statusLine":{"type":"command","command":"bash ~/.claude/user.sh"}}"#,
    )
    .unwrap();
    let chain_of = |d: LaunchDecision| match d {
        LaunchDecision::Inject { settings_json, chained, .. } => {
            assert!(!settings_json.contains("sk-ant"), "nothing else from the user's settings is copied");
            let v: serde_json::Value = serde_json::from_str(&settings_json).unwrap();
            let cmd = v["statusLine"]["command"].as_str().unwrap().to_string();
            let b64 = cmd.split_whitespace().skip_while(|w| *w != "--chain-b64").nth(1).map(str::to_string);
            assert_eq!(chained, b64.is_some());
            b64.map(|b| helper::decode_chain(&b).unwrap())
        }
        d => panic!("{d:?}"),
    };
    assert_eq!(chain_of(launch::decide(&input(&fx, &[], &sh, &[]))).as_deref(), Some("bash ~/.claude/user.sh"));
    // Project settings override the user's; local overrides project.
    std::fs::create_dir_all(fx.cwd.join(".claude")).unwrap();
    std::fs::write(fx.cwd.join(".claude").join("settings.json"), r#"{"statusLine":{"type":"command","command":"proj"}}"#).unwrap();
    assert_eq!(chain_of(launch::decide(&input(&fx, &[], &sh, &[]))).as_deref(), Some("proj"));
    std::fs::write(fx.cwd.join(".claude").join("settings.local.json"), r#"{"statusLine":{"type":"command","command":"local"}}"#).unwrap();
    assert_eq!(chain_of(launch::decide(&input(&fx, &[], &sh, &[]))).as_deref(), Some("local"));
    // disableAllHooks: status lines don't run at all, so the pane isn't metered (and says why).
    std::fs::write(fx.cwd.join(".claude").join("settings.local.json"), r#"{"statusLine":{"type":"command","command":"local"},"disableAllHooks":true}"#).unwrap();
    let d = launch::decide(&input(&fx, &[], &sh, &[]));
    assert!(matches!(&d, LaunchDecision::Skip { status: MeterStatus::Unavailable, note } if note.contains("disableAllHooks")), "{d:?}");
    // Our own helper is never chained; an over-long command is not chained (with a note).
    std::fs::write(fx.cwd.join(".claude").join("settings.local.json"), r#"{"statusLine":{"type":"command","command":"x.exe --gk-statusline --meter-file y"}}"#).unwrap();
    assert_eq!(chain_of(launch::decide(&input(&fx, &[], &sh, &[]))), None);
    let long = serde_json::json!({"statusLine": {"type": "command", "command": "x".repeat(helper::MAX_CHAIN_COMMAND + 1)}});
    std::fs::write(fx.cwd.join(".claude").join("settings.local.json"), long.to_string()).unwrap();
    let d = launch::decide(&input(&fx, &[], &sh, &[]));
    assert!(matches!(&d, LaunchDecision::Inject { note: Some(n), chained: false, .. } if n.contains("4 KiB")), "{d:?}");
    // Broken settings files are ignored.
    std::fs::write(fx.cwd.join(".claude").join("settings.local.json"), "{ not json").unwrap();
    assert_eq!(chain_of(launch::decide(&input(&fx, &[], &sh, &[]))).as_deref(), Some("proj"));
}

#[test]
fn decide_respects_managed_settings_and_odd_paths() {
    let fx = launch_fx();
    let sh = StatusShell::GitBash("bash.exe".into());
    let managed = fx.root.join("managed-settings.json");
    std::fs::write(&managed, r#"{"statusLine":{"type":"command","command":"corp"}}"#).unwrap();
    let list = vec![managed.clone()];
    assert!(matches!(launch::decide(&input(&fx, &[], &sh, &list)), LaunchDecision::Skip { status: MeterStatus::Managed, .. }));
    std::fs::write(&managed, r#"{"allowManagedHooksOnly":true}"#).unwrap();
    assert!(matches!(launch::decide(&input(&fx, &[], &sh, &list)), LaunchDecision::Skip { status: MeterStatus::Managed, .. }));
    std::fs::write(&managed, r#"{"permissions":{}}"#).unwrap();
    assert!(matches!(launch::decide(&input(&fx, &[], &sh, &list)), LaunchDecision::Inject { .. }));

    // A path with a space is quoted per shell; a quote in it can't be carried.
    let spaced = Path::new("C:/Program Files/Gridkeeper/gridkeeper.exe");
    let meter_file = Path::new("C:/Users/A B/AppData/Roaming/app.gridkeeper.desktop/meter/s.json");
    let bash = launch::statusline_command(spaced, meter_file, None, &sh).unwrap();
    assert_eq!(bash, format!("'C:/Program Files/Gridkeeper/gridkeeper.exe' --gk-statusline --meter-file '{}'", meter_file.display()));
    let ps = launch::statusline_command(spaced, meter_file, Some("echo hi"), &StatusShell::PowerShell("pwsh".into())).unwrap();
    assert!(ps.starts_with("& 'C:/Program Files/Gridkeeper/gridkeeper.exe' --gk-statusline"), "{ps}");
    assert!(ps.ends_with(&format!("--chain-b64 {}", helper::encode_chain("echo hi"))), "{ps}");
    assert!(launch::statusline_command(Path::new("C:/it's/gk.exe"), meter_file, None, &sh).is_err());
}

#[test]
fn decide_adds_hooks_to_the_same_file_and_never_copies_the_users() {
    let fx = launch_fx();
    let sh = StatusShell::GitBash("bash.exe".into());
    // The user's own hooks and status line: their hooks are not copied (Claude Code merges hooks across
    // settings sources), their status line is chained as before.
    std::fs::write(
        fx.root.join("settings.json"),
        r#"{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"notify-send done"}]}]},"statusLine":{"type":"command","command":"bash ~/.claude/user.sh"}}"#,
    )
    .unwrap();
    let mut inp = input(&fx, &[], &sh, &[]);
    inp.hooks = true;
    let d = launch::decide(&inp);
    let LaunchDecision::Inject { settings_json, chained, status, hooks, .. } = d else { panic!("{d:?}") };
    assert!(chained && hooks);
    assert_eq!(status, MeterStatus::Metered);
    assert!(!settings_json.contains("notify-send"), "the user's hooks are not copied: {settings_json}");
    let v: serde_json::Value = serde_json::from_str(&settings_json).unwrap();
    let mut keys: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
    keys.sort_unstable();
    assert_eq!(keys, vec!["hooks", "statusLine"], "one file, two keys");
    let state_file = shell::command_path(&fx.meter.join("s-1.hooks.json"));
    for ev in hooks::EVENTS {
        let cmd = v["hooks"][*ev][0]["hooks"][0]["command"].as_str().unwrap();
        assert!(cmd.starts_with(&format!("C:/Gridkeeper/gridkeeper.exe --gk-hook {ev} --state-file ")), "{cmd}");
        assert!(cmd.ends_with(&state_file) || cmd.ends_with(&format!("'{state_file}'")), "{cmd}");
        assert!(!cmd.contains('\\'), "Git Bash eats backslashes: {cmd}");
        assert_eq!(v["hooks"][*ev][0]["hooks"][0]["async"], true);
    }
    // Managed settings own the status line: hooks alone are injected (status says why the meter is off).
    let managed = fx.root.join("managed-settings.json");
    std::fs::write(&managed, r#"{"statusLine":{"type":"command","command":"corp"}}"#).unwrap();
    let list = vec![managed.clone()];
    let mut inp = input(&fx, &[], &sh, &list);
    inp.hooks = true;
    let d = launch::decide(&inp);
    let LaunchDecision::Inject { settings_json, status, hooks, note, chained, .. } = d else { panic!("{d:?}") };
    assert_eq!((status, hooks, chained), (MeterStatus::Managed, true, false));
    assert!(note.unwrap().contains("managed settings set the status line"));
    let v: serde_json::Value = serde_json::from_str(&settings_json).unwrap();
    assert!(v.get("statusLine").is_none() && v.get("hooks").is_some(), "{settings_json}");
    // allowManagedHooksOnly: nothing at all.
    std::fs::write(&managed, r#"{"allowManagedHooksOnly":true}"#).unwrap();
    assert!(matches!(launch::decide(&inp), LaunchDecision::Skip { status: MeterStatus::Managed, .. }));
    // disableAllHooks in the user's files: nothing either.
    std::fs::write(&managed, "{}").unwrap();
    std::fs::write(fx.root.join("settings.json"), r#"{"disableAllHooks":true}"#).unwrap();
    assert!(matches!(launch::decide(&inp), LaunchDecision::Skip { status: MeterStatus::Unavailable, .. }));
}

fn hook_hub(data: &Path) -> (Arc<MeterHub>, Receiver<crate::types::SessionAttention>) {
    let (hub, _meters) = collecting_hub(data);
    let (tx, rx) = mpsc::channel();
    let tx = parking_lot::Mutex::new(tx);
    hub.set_hook_sink(Arc::new(move |a: &crate::types::SessionAttention| {
        let _ = tx.lock().send(a.clone());
    }));
    (hub, rx)
}

/// The hook helper writes a state file; the folder watch (no polling) turns it into a `session-attention`
/// event with `kind = hook`. Keystrokes end a prompt's wait. Panes launched without hooks are ignored.
#[test]
fn watcher_turns_hook_writes_into_attention_events() {
    let t = tempfile::tempdir().unwrap();
    let data = t.path().join(APP_IDENTIFIER);
    let (hub, rx) = hook_hub(&data);
    let id = "pane-h";
    let file = hub.dir().join(hooks::hooks_name(id));
    // A stale file from an earlier run is deleted at launch.
    std::fs::write(&file, r#"{"v":1,"event":"PermissionRequest","t":5,"tool":"Old"}"#).unwrap();
    hub.start_watch().unwrap();
    hub.hooks_launch(id);
    assert!(!file.exists());
    assert!(hub.hooks_active(id));
    let args = |ev: &str| vec![ev.to_string(), hooks::STATE_FILE_FLAG.to_string(), file.to_string_lossy().into_owned()];
    let json = br#"{"hook_event_name":"PermissionRequest","session_id":"c-1","transcript_path":"C:/x.jsonl","tool_name":"Bash","tool_input":{"command":"rm -rf /"}}"#;
    assert_eq!(hooks::run(&args("PermissionRequest"), &mut json.as_slice(), Some(&data), hooks::now_us()), 0);
    let ev = rx.recv_timeout(Duration::from_secs(10)).expect("hook attention event");
    assert_eq!((ev.id.as_str(), ev.kind, ev.status.as_deref(), ev.tool.as_deref()), (id, crate::types::AttentionKind::Hook, Some("permission"), Some("Bash")));
    let raw = std::fs::read_to_string(&file).unwrap();
    assert!(!raw.contains("rm -rf") && !raw.contains("jsonl"), "{raw}");
    // Enter in the pane answers the prompt.
    hub.note_input(id, b"\x1b[B");
    assert!(rx.recv_timeout(Duration::from_millis(200)).is_err(), "an arrow key is not an answer");
    hub.note_input(id, b"\r");
    let ev = rx.recv_timeout(Duration::from_secs(1)).unwrap();
    assert_eq!((ev.status.as_deref(), ev.tool.as_deref()), (Some("tool"), Some("Bash")));
    // The turn ends.
    std::thread::sleep(Duration::from_millis(5));
    assert_eq!(hooks::run(&args("Stop"), &mut br#"{"hook_event_name":"Stop"}"#.as_slice(), Some(&data), hooks::now_us()), 0);
    let ev = loop {
        let ev = rx.recv_timeout(Duration::from_secs(10)).expect("stopped");
        if ev.status.as_deref() == Some("stopped") {
            break ev;
        }
    };
    assert_eq!(ev.kind, crate::types::AttentionKind::Hook);
    // A pane launched without hooks: its hook file is ignored, typing does nothing.
    let other = "pane-off";
    hub.hooks_off(other);
    let ofile = hub.dir().join(hooks::hooks_name(other));
    let oargs = vec!["Stop".to_string(), hooks::STATE_FILE_FLAG.to_string(), ofile.to_string_lossy().into_owned()];
    assert_eq!(hooks::run(&oargs, &mut b"{}".as_slice(), Some(&data), hooks::now_us()), 0);
    hub.note_input(other, b"\x1b");
    assert!(rx.recv_timeout(Duration::from_millis(500)).is_err(), "no events for a pane without hooks");
    // Hook files never show up as meters.
    assert!(hub.get(id).is_none() && hub.get(other).is_none());
    // Removing the pane deletes its hook file.
    hub.forget(id);
    assert!(!file.exists() && !hub.hooks_active(id));
    hub.stop();
}

// ---------------------------------------------------------------------------
// Through the Claude adapter's launch plan
// ---------------------------------------------------------------------------

/// One process-wide hub for adapter tests (the adapter finds it through `meter::hub()`).
fn test_hub() -> &'static Arc<MeterHub> {
    static DATA: OnceLock<PathBuf> = OnceLock::new();
    let data = DATA.get_or_init(|| {
        let t = Box::leak(Box::new(tempfile::tempdir().unwrap()));
        t.path().join(APP_IDENTIFIER)
    });
    if hub().is_none() {
        install(Arc::new(MeterHub::new(data, Some(PathBuf::from("C:/Gridkeeper/gridkeeper.exe")), Vec::new(), Arc::new(|_: &SessionMeter| {}))));
    }
    hub().unwrap()
}

struct AdapterFx {
    _dirs: Vec<tempfile::TempDir>,
    cwd: String,
    profiles: crate::profiles::ProfileStore,
    settings: crate::types::Settings,
    account: String,
}

fn adapter_fx() -> AdapterFx {
    let cwd = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    let bin = tempfile::tempdir().unwrap();
    std::fs::write(bin.path().join("claude.exe"), b"MZ").unwrap();
    let profiles = crate::profiles::ProfileStore::load_with_home(home.path().join("profiles.json"), Some(home.path().to_path_buf()));
    // A named account, so the user-settings lookup reads a temp folder (never the real ~/.claude).
    let acct_dir = home.path().join(".claude-meter-test");
    let account = profiles.create("meter".into(), Some(acct_dir.to_string_lossy().into()), None).unwrap().id;
    let mut settings = crate::types::Settings::default();
    settings.agent_paths.claude = Some(bin.path().join("claude.exe").to_string_lossy().into());
    settings.cost_meter = true;
    AdapterFx { cwd: cwd.path().to_string_lossy().into(), profiles, settings, account, _dirs: vec![cwd, home, bin] }
}

fn claude_spec(fx: &AdapterFx, id: &str, args: Vec<String>) -> crate::types::SessionSpec {
    crate::types::SessionSpec {
        id: id.into(),
        name: "c".into(),
        agent: crate::types::AgentKind::Claude,
        cwd: fx.cwd.clone(),
        profile_id: Some(fx.account.clone()),
        command: None,
        args,
        env: vec![],
        resume: crate::types::ResumeMode::None,
        agent_session_id: Some("0f8fad5b-d9cb-469f-a165-70867728950e".into()),
        preset: None,
        cols: 80,
        rows: 24,
    }
}

#[test]
fn claude_launch_plan_injects_settings_before_user_args() {
    let hub = test_hub();
    let fx = adapter_fx();
    let id = "adapter-inject";
    let spec = claude_spec(&fx, id, vec!["--model".into(), "opus".into()]);
    let plan = crate::adapters::resolve_launch(&spec, &fx.profiles, &fx.settings).unwrap();
    let file = hub.dir().join(settings_name(id));
    assert_eq!(
        plan.args,
        vec![
            "--session-id".to_string(),
            "0f8fad5b-d9cb-469f-a165-70867728950e".into(),
            "--settings".into(),
            file.to_string_lossy().into_owned(),
            "--model".into(),
            "opus".into(),
        ]
    );
    let json: serde_json::Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
    assert!(json["statusLine"]["command"].as_str().unwrap().contains("--gk-statusline --meter-file"));
    // Exact status is on by default with the meter: same file, `hooks` key, hook state reset for the pane.
    assert!(json["hooks"]["PermissionRequest"][0]["hooks"][0]["command"].as_str().unwrap().contains("--gk-hook PermissionRequest --state-file"));
    assert!(hub.hooks_active(id));
    let m = hub.get(id).unwrap();
    assert_eq!(m.status, MeterStatus::Metered);
    hub.forget(id);
    assert!(!file.exists());
    assert!(!hub.hooks_active(id));

    // Hooks switched off: the file has only the status line.
    let mut fx = fx;
    fx.settings.claude_hooks = false;
    let id = "adapter-nohooks";
    crate::adapters::resolve_launch(&claude_spec(&fx, id, vec![]), &fx.profiles, &fx.settings).unwrap();
    let json: serde_json::Value = serde_json::from_slice(&std::fs::read(hub.dir().join(settings_name(id))).unwrap()).unwrap();
    assert!(json.get("hooks").is_none() && json.get("statusLine").is_some());
    assert!(!hub.hooks_active(id));
    hub.forget(id);
}

#[test]
fn claude_launch_plan_skips_custom_settings_and_respects_the_toggle() {
    let hub = test_hub();
    let mut fx = adapter_fx();
    let id = "adapter-custom";
    let spec = claude_spec(&fx, id, vec!["--settings".into(), "mine.json".into()]);
    let plan = crate::adapters::resolve_launch(&spec, &fx.profiles, &fx.settings).unwrap();
    assert_eq!(plan.args.iter().filter(|a| *a == "--settings").count(), 1, "only the user's own: {:?}", plan.args);
    assert!(plan.args.ends_with(&["--settings".to_string(), "mine.json".into()]));
    assert!(!hub.dir().join(settings_name(id)).exists());
    let m = hub.get(id).unwrap();
    assert_eq!((m.status, m.note.as_deref()), (MeterStatus::CustomSettings, Some(launch::NOTE_CUSTOM_SETTINGS)));

    // Toggle off: nothing injected, nothing noted.
    fx.settings.cost_meter = false;
    let id = "adapter-off";
    let plan = crate::adapters::resolve_launch(&claude_spec(&fx, id, vec![]), &fx.profiles, &fx.settings).unwrap();
    assert!(!plan.args.iter().any(|a| a == "--settings"));
    assert!(hub.get(id).is_none());
    hub.forget("adapter-custom");
}
