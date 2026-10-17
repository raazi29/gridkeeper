use super::*;
use std::path::Path;

struct Fixture {
    _dirs: Vec<tempfile::TempDir>,
    cwd: String,
    home: PathBuf,
    profiles: ProfileStore,
    settings: Settings,
    fake_bin: PathBuf,
}

fn fixture() -> Fixture {
    let cwd = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    let data = tempfile::tempdir().unwrap();
    let bin = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(home.path().join(".claude")).unwrap();
    for exe in ["claude.exe", "codex.exe", "tool.exe"] {
        std::fs::write(bin.path().join(exe), b"MZ").unwrap();
    }
    std::fs::write(bin.path().join("tool.cmd"), "@echo off\r\nnode tool.js %*\r\n").unwrap();
    let profiles = ProfileStore::load_with_home(data.path().join("profiles.json"), Some(home.path().to_path_buf()));
    let mut settings = Settings::default();
    settings.agent_paths.claude = Some(bin.path().join("claude.exe").to_string_lossy().into());
    settings.agent_paths.codex = Some(bin.path().join("codex.exe").to_string_lossy().into());
    Fixture {
        cwd: cwd.path().to_string_lossy().into(),
        home: home.path().to_path_buf(),
        fake_bin: bin.path().to_path_buf(),
        profiles,
        settings,
        _dirs: vec![cwd, home, data, bin],
    }
}

fn spec(agent: AgentKind, cwd: &str) -> SessionSpec {
    SessionSpec {
        id: "s1".into(),
        name: "test".into(),
        agent,
        cwd: cwd.into(),
        profile_id: None,
        command: None,
        args: vec![],
        env: vec![],
        resume: ResumeMode::None,
        agent_session_id: None,
        preset: None,
        cols: 80,
        rows: 24,
    }
}

fn env<'a>(plan: &'a LaunchPlan, key: &str) -> Option<&'a str> {
    plan.env_set.iter().find(|(k, _)| k.eq_ignore_ascii_case(key)).map(|(_, v)| v.as_str())
}

fn removed(plan: &LaunchPlan, key: &str) -> bool {
    plan.env_remove.iter().any(|k| k.eq_ignore_ascii_case(key))
}

const UUID: &str = "0f8fad5b-d9cb-469f-a165-70867728950e";

#[test]
fn common_env_and_cwd() {
    let f = fixture();
    let plan = resolve_launch(&spec(AgentKind::Claude, &f.cwd), &f.profiles, &f.settings).unwrap();
    assert_eq!(plan.cwd, PathBuf::from(&f.cwd));
    assert_eq!(env(&plan, "TERM"), Some("xterm-256color"));
    assert_eq!(env(&plan, "COLORTERM"), Some("truecolor"));
    assert_eq!(env(&plan, "TERM_PROGRAM"), Some("Altera"));
    assert_eq!(env(&plan, "TERM_PROGRAM_VERSION"), Some(env!("CARGO_PKG_VERSION")));
    assert!(removed(&plan, "WT_SESSION") && removed(&plan, "WT_PROFILE_ID"));
    assert!(plan.display.contains("claude.exe"));
}

#[test]
fn missing_cwd_is_invalid() {
    let f = fixture();
    let missing = Path::new(&f.cwd).join("nope").to_string_lossy().into_owned();
    let err = resolve_launch(&spec(AgentKind::Powershell, &missing), &f.profiles, &f.settings).unwrap_err();
    match err {
        AppError::Invalid(m) => assert!(m.starts_with("Working directory does not exist"), "{m}"),
        e => panic!("unexpected {e:?}"),
    }
    assert!(resolve_launch(&spec(AgentKind::Powershell, ""), &f.profiles, &f.settings).is_err());
}

#[test]
fn rejects_bad_env_and_args() {
    let f = fixture();
    let mut s = spec(AgentKind::Codex, &f.cwd);
    s.env = vec![EnvVar { key: "A=B".into(), value: "x".into() }];
    assert!(matches!(resolve_launch(&s, &f.profiles, &f.settings), Err(AppError::Invalid(_))));
    s.env = vec![EnvVar { key: "OK".into(), value: "a\0b".into() }];
    assert!(matches!(resolve_launch(&s, &f.profiles, &f.settings), Err(AppError::Invalid(_))));
    s.env.clear();
    s.args = vec!["x\0y".into()];
    assert!(matches!(resolve_launch(&s, &f.profiles, &f.settings), Err(AppError::Invalid(_))));
}

#[test]
fn claude_default_profile_removes_config_dir_and_identity() {
    let f = fixture();
    let plan = resolve_launch(&spec(AgentKind::Claude, &f.cwd), &f.profiles, &f.settings).unwrap();
    assert!(removed(&plan, "CLAUDE_CONFIG_DIR"));
    assert!(env(&plan, "CLAUDE_CONFIG_DIR").is_none());
    for k in CLAUDE_IDENTITY_ENV {
        assert!(removed(&plan, k), "{k} must be removed");
    }
    assert_eq!(env(&plan, "CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT"), Some("1"));
    assert_eq!(plan.program, PathBuf::from(f.settings.agent_paths.claude.as_ref().unwrap()));
    assert!(plan.args.is_empty());

    // Explicit default id behaves the same.
    let mut s = spec(AgentKind::Claude, &f.cwd);
    s.profile_id = Some(crate::profiles::DEFAULT_PROFILE_ID.into());
    let plan = resolve_launch(&s, &f.profiles, &f.settings).unwrap();
    assert!(removed(&plan, "CLAUDE_CONFIG_DIR"));
}

#[test]
fn claude_named_profile_sets_config_dir() {
    let f = fixture();
    let dir = f.home.join(".claude-account9");
    let p = f.profiles.create("acct".into(), Some(dir.to_string_lossy().into()), None).unwrap();
    let mut s = spec(AgentKind::Claude, &f.cwd);
    s.profile_id = Some(p.id.clone());
    let plan = resolve_launch(&s, &f.profiles, &f.settings).unwrap();
    assert_eq!(env(&plan, "CLAUDE_CONFIG_DIR"), Some(dir.to_string_lossy().as_ref()));
    assert!(!removed(&plan, "CLAUDE_CONFIG_DIR"));
    assert!(removed(&plan, "ANTHROPIC_API_KEY"));

    // Profile dir deleted after creation → Invalid.
    std::fs::remove_dir(&dir).unwrap();
    match resolve_launch(&s, &f.profiles, &f.settings).unwrap_err() {
        AppError::Invalid(m) => assert!(m.starts_with("Profile directory missing"), "{m}"),
        e => panic!("unexpected {e:?}"),
    }

    // Unknown profile id → NotFound.
    s.profile_id = Some("no-such-profile".into());
    assert!(matches!(resolve_launch(&s, &f.profiles, &f.settings), Err(AppError::NotFound(_))));
}

#[test]
fn user_env_overrides_adapter_env() {
    let f = fixture();
    let mut s = spec(AgentKind::Claude, &f.cwd);
    s.env = vec![
        EnvVar { key: "CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT".into(), value: "0".into() },
        EnvVar { key: "anthropic_api_key".into(), value: "intentional".into() },
    ];
    let plan = resolve_launch(&s, &f.profiles, &f.settings).unwrap();
    assert_eq!(env(&plan, "CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT"), Some("0"));
    assert_eq!(env(&plan, "ANTHROPIC_API_KEY"), Some("intentional"));
    assert!(!removed(&plan, "ANTHROPIC_API_KEY"));
    assert_eq!(plan.env_set.iter().filter(|(k, _)| k.eq_ignore_ascii_case("CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT")).count(), 1);
}

#[test]
fn claude_resume_modes() {
    let f = fixture();
    let dir = f.home.join(".claude-r");
    let p = f.profiles.create("r".into(), Some(dir.to_string_lossy().into()), None).unwrap();
    let mut s = spec(AgentKind::Claude, &f.cwd);
    s.profile_id = Some(p.id.clone());
    s.args = vec!["--verbose".into()];

    // New conversation pinned to an id.
    s.agent_session_id = Some(UUID.into());
    let plan = resolve_launch(&s, &f.profiles, &f.settings).unwrap();
    assert_eq!(plan.args, vec!["--session-id", UUID, "--verbose"]);

    // Continue.
    s.resume = ResumeMode::Continue;
    let plan = resolve_launch(&s, &f.profiles, &f.settings).unwrap();
    assert_eq!(plan.args, vec!["--continue", "--verbose"]);

    // Resume without a transcript falls back to --session-id.
    s.resume = ResumeMode::Session { id: UUID.into() };
    let plan = resolve_launch(&s, &f.profiles, &f.settings).unwrap();
    assert_eq!(plan.args, vec!["--session-id", UUID, "--verbose"]);

    // With a transcript in projects/<any>/<id>.jsonl → --resume.
    let proj = dir.join("projects").join("C--work");
    std::fs::create_dir_all(&proj).unwrap();
    std::fs::write(proj.join(format!("{UUID}.jsonl")), b"").unwrap();
    let plan = resolve_launch(&s, &f.profiles, &f.settings).unwrap();
    assert_eq!(plan.args, vec!["--resume", UUID, "--verbose"]);

    // Bad ids are rejected.
    s.resume = ResumeMode::Session { id: "../../etc".into() };
    assert!(matches!(resolve_launch(&s, &f.profiles, &f.settings), Err(AppError::Invalid(_))));
    s.resume = ResumeMode::None;
    s.agent_session_id = Some("not a uuid; rm".into());
    assert!(matches!(resolve_launch(&s, &f.profiles, &f.settings), Err(AppError::Invalid(_))));
}

#[test]
fn codex_resume_modes() {
    let f = fixture();
    let mut s = spec(AgentKind::Codex, &f.cwd);
    let plan = resolve_launch(&s, &f.profiles, &f.settings).unwrap();
    assert!(plan.args.is_empty());
    assert!(!plan.args.iter().any(|a| a == "--no-alt-screen"));
    assert!(!removed(&plan, "CLAUDE_CONFIG_DIR"));
    s.resume = ResumeMode::Continue;
    assert_eq!(resolve_launch(&s, &f.profiles, &f.settings).unwrap().args, vec!["resume", "--last"]);
    s.resume = ResumeMode::Session { id: UUID.into() };
    assert_eq!(resolve_launch(&s, &f.profiles, &f.settings).unwrap().args, vec!["resume", UUID]);
}

#[test]
fn powershell_args() {
    let f = fixture();
    let mut s = spec(AgentKind::Powershell, &f.cwd);
    s.args = vec!["-NoProfile".into()];
    let plan = resolve_launch(&s, &f.profiles, &f.settings).unwrap();
    assert_eq!(plan.args, vec!["-NoLogo", "-NoProfile"]);
    let name = plan.program.file_name().unwrap().to_string_lossy().to_ascii_lowercase();
    assert!(name == "pwsh.exe" || name == "powershell.exe", "{name}");
}

#[test]
fn generic_requires_command_and_handles_batch() {
    let f = fixture();
    let mut s = spec(AgentKind::Generic, &f.cwd);
    assert!(matches!(resolve_launch(&s, &f.profiles, &f.settings), Err(AppError::Invalid(_))));

    s.command = Some(f.fake_bin.join("tool.exe").to_string_lossy().into());
    s.args = vec!["a b".into()];
    let plan = resolve_launch(&s, &f.profiles, &f.settings).unwrap();
    assert_eq!(plan.program, f.fake_bin.join("tool.exe"));
    assert_eq!(plan.args, vec!["a b"]);
    assert!(plan.display.ends_with("\"a b\""), "{}", plan.display);

    // A sibling .exe wins over the .cmd.
    s.command = Some(f.fake_bin.join("tool.cmd").to_string_lossy().into());
    assert_eq!(resolve_launch(&s, &f.profiles, &f.settings).unwrap().program, f.fake_bin.join("tool.exe"));

    // A lone .cmd goes through cmd.exe /d /c, and cmd metacharacters are refused.
    std::fs::remove_file(f.fake_bin.join("tool.exe")).unwrap();
    let plan = resolve_launch(&s, &f.profiles, &f.settings).unwrap();
    assert!(plan.program.to_string_lossy().to_ascii_lowercase().ends_with("cmd.exe"));
    assert_eq!(&plan.args[..2], &["/d", "/c"]);
    assert!(plan.args[2].ends_with("tool.cmd"));
    s.args = vec!["x & calc".into()];
    assert!(matches!(resolve_launch(&s, &f.profiles, &f.settings), Err(AppError::Invalid(_))));

    // Bare names resolve via PATH.
    s.command = Some("cmd".into());
    s.args = vec![];
    let plan = resolve_launch(&s, &f.profiles, &f.settings).unwrap();
    assert!(plan.program.to_string_lossy().to_ascii_lowercase().ends_with("cmd.exe"));

    s.command = Some("definitely-missing-altera-tool".into());
    assert!(matches!(resolve_launch(&s, &f.profiles, &f.settings), Err(AppError::MissingExecutable(_))));
}

#[test]
fn display_is_redacted() {
    let d = display_command(Path::new(r"C:\bin\x.exe"), &["--api-key".into(), "sk-ant-api03-abcdefghijklmnop".into()]);
    assert!(!d.contains("abcdefghijklmnop"), "{d}");
}

#[test]
fn registry_covers_every_kind() {
    for k in [AgentKind::Powershell, AgentKind::Claude, AgentKind::Codex, AgentKind::Generic] {
        assert_eq!(adapter_for(k).kind(), k);
    }
    assert!(adapter_for(AgentKind::Claude).capabilities().supports_profiles);
    assert!(adapter_for(AgentKind::Codex).capabilities().supports_resume);
}

#[test]
fn detect_reports_every_kind() {
    let mut settings = Settings::default();
    settings.agent_paths.claude = Some(r"C:\definitely\missing\claude.exe".into());
    let found = detect(&settings);
    // Built-in kinds first (one each), then any catalog tools found on this PC.
    let builtin: Vec<_> = found.iter().filter(|a| a.preset.is_none()).collect();
    assert_eq!(builtin.len(), ADAPTERS.len());
    assert!(found.iter().filter(|a| a.preset.is_some()).all(|a| a.kind == AgentKind::Generic && a.label.is_some()));
    let claude = found.iter().find(|a| a.kind == AgentKind::Claude).unwrap();
    assert!(claude.path.is_none() && claude.error.is_some());
    let ps = found.iter().find(|a| a.kind == AgentKind::Powershell).unwrap();
    assert!(ps.path.is_some(), "{ps:?}");
    assert!(ps.version.is_some(), "{ps:?}");
    let generic = found.iter().find(|a| a.kind == AgentKind::Generic && a.preset.is_none()).unwrap();
    assert!(generic.error.is_none());
}

#[test]
fn strips_parent_agent_session_vars() {
    let names = ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CONFIG_DIR", "PATH", "CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT"]
        .iter()
        .map(|s| s.to_string());
    let got = super::inherited_agent_session_vars(names);
    assert!(got.contains(&"CLAUDECODE".to_string()));
    assert!(got.contains(&"CLAUDE_CODE_MESSAGING_TOKEN".to_string()));
    assert!(got.contains(&"CLAUDE_CODE_SESSION_ID".to_string()));
    assert!(!got.contains(&"CLAUDE_CONFIG_DIR".to_string()));
    assert!(!got.contains(&"PATH".to_string()));
    assert!(!got.contains(&"CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT".to_string()));
}
