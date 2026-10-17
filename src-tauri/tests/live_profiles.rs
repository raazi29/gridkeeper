//! Live checks against the real machine. Ignored by default; run with
//! `cargo test --test live_profiles -- --ignored --nocapture`.
//!
//! Prints ONLY non-personal fields (never the account e-mail).

use gridkeeper_lib::adapters;
use gridkeeper_lib::profiles::{self, ProfileStore};
use gridkeeper_lib::types::*;

fn home() -> std::path::PathBuf {
    adapters::discovery::home_dir().expect("home dir")
}

#[test]
#[ignore]
fn live_check_status_for_real_profiles() {
    let settings = Settings::default();
    let candidates = [
        ("Default", None),
        ("account1", Some(home().join(".claude-account1"))),
        ("account2", Some(home().join(".claude-account2"))),
    ];
    for (name, dir) in candidates {
        let profile = ClaudeProfile {
            id: name.into(),
            name: name.into(),
            config_dir: dir.map(|d| d.to_string_lossy().into_owned()),
            color: "#7B61FF".into(),
            status: Default::default(),
        };
        let started = std::time::Instant::now();
        match profiles::check_status(&profile, &settings) {
            Ok(s) => println!(
                "{name}: verified={} logged_in={:?} auth_method={:?} dir_exists={} likely_authenticated={} has_account={} ({:?})",
                s.verified,
                s.logged_in,
                s.auth_method,
                s.dir_exists,
                s.likely_authenticated,
                s.account.is_some(),
                started.elapsed()
            ),
            Err(e) => println!("{name}: error {e}"),
        }
    }
}

#[test]
#[ignore]
fn live_seed_detect_and_launch_plans() {
    let tmp = tempfile::tempdir().unwrap();
    let store = ProfileStore::load_with_home(tmp.path().join("profiles.json"), Some(home()));
    for p in store.list() {
        println!(
            "seeded profile: name={} is_default={} dir_exists={} likely_authenticated={} color={}",
            p.name,
            p.config_dir.is_none(),
            p.status.dir_exists,
            p.status.likely_authenticated,
            p.color
        );
    }
    let settings = Settings::default();
    for a in adapters::detect(&settings) {
        println!("detect: {:?} path={:?} version={:?} error={:?}", a.kind, a.path, a.version, a.error);
    }
    let cwd = std::env::temp_dir().to_string_lossy().into_owned();
    for (agent, profile) in [
        (AgentKind::Claude, None),
        (AgentKind::Claude, store.list().get(1).map(|p| p.id.clone())),
        (AgentKind::Codex, None),
        (AgentKind::Powershell, None),
    ] {
        let spec = SessionSpec {
            id: "live".into(),
            name: "live".into(),
            agent,
            cwd: cwd.clone(),
            profile_id: profile,
            command: None,
            args: vec![],
            env: vec![],
            resume: ResumeMode::Continue,
            agent_session_id: None,
            preset: None,
            cols: 80,
            rows: 24,
        };
        match adapters::resolve_launch(&spec, &store, &settings) {
            Ok(plan) => println!(
                "plan {agent:?}: {} | set={:?} | remove={:?}",
                plan.display,
                plan.env_set.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>(),
                plan.env_remove
            ),
            Err(e) => println!("plan {agent:?}: error {e}"),
        }
    }
}
