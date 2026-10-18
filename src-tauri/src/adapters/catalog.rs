//! Catalog of additional agent CLIs, launched through the generic adapter with a `preset` id.
//!
//! Each entry says how to find, launch and resume one tool. Flags are taken from each tool's
//! documentation (see docs/research-notes/agents-notifications-market.md); entries whose resume
//! flags are unverified leave them as `None` rather than guessing. Adding a tool = one entry here.

use super::discovery::{self, Executable};
use crate::types::*;

pub struct CatalogEntry {
    pub id: &'static str,
    pub name: &'static str,
    /// Executable names looked up on PATH, in order.
    pub exe: &'static [&'static str],
    /// Arguments for a normal interactive launch.
    pub launch: &'static [&'static str],
    /// Arguments that continue the most recent conversation (replace `launch`).
    pub continue_args: Option<&'static [&'static str]>,
    /// Arguments that open the tool's own conversation picker.
    pub pick_args: Option<&'static [&'static str]>,
    /// Flag that resumes a specific conversation id: `[flag, id]` (appended after `launch`).
    pub session_flag: Option<&'static str>,
    /// Environment variable that relocates the tool's config/state (for future per-pane profiles).
    pub home_env: Option<&'static str>,
}

pub static CATALOG: &[CatalogEntry] = &[
    CatalogEntry {
        id: "hermes",
        name: "Hermes Agent",
        exe: &["hermes"],
        launch: &[],
        continue_args: Some(&["--continue"]),
        pick_args: None,
        session_flag: Some("--resume"),
        home_env: Some("HERMES_HOME"),
    },
    CatalogEntry {
        id: "opencode",
        name: "OpenCode",
        exe: &["opencode"],
        launch: &[],
        continue_args: Some(&["-c"]),
        pick_args: None,
        session_flag: Some("-s"),
        home_env: None,
    },
    CatalogEntry {
        id: "gemini",
        name: "Gemini CLI",
        exe: &["gemini"],
        launch: &[],
        continue_args: None,
        pick_args: None,
        session_flag: None,
        home_env: Some("GEMINI_CLI_HOME"),
    },
    CatalogEntry {
        id: "copilot",
        name: "GitHub Copilot CLI",
        exe: &["copilot"],
        launch: &[],
        continue_args: Some(&["--continue"]),
        pick_args: Some(&["--resume"]),
        session_flag: None,
        home_env: None,
    },
    CatalogEntry {
        id: "aider",
        name: "Aider",
        exe: &["aider"],
        launch: &[],
        continue_args: Some(&["--restore-chat-history"]),
        pick_args: None,
        session_flag: None,
        home_env: None,
    },
    CatalogEntry {
        id: "droid",
        name: "Factory Droid",
        exe: &["droid"],
        launch: &[],
        continue_args: Some(&["-r"]),
        pick_args: None,
        session_flag: Some("-r"),
        home_env: None,
    },
    CatalogEntry {
        id: "kimi",
        name: "Kimi CLI",
        exe: &["kimi"],
        launch: &[],
        continue_args: Some(&["-C"]),
        pick_args: None,
        session_flag: None,
        home_env: None,
    },
    CatalogEntry {
        id: "qwen",
        name: "Qwen Code",
        exe: &["qwen"],
        launch: &[],
        continue_args: None,
        pick_args: None,
        session_flag: None,
        home_env: None,
    },
    CatalogEntry {
        id: "cursor",
        name: "Cursor Agent",
        exe: &["cursor-agent"],
        launch: &[],
        continue_args: None,
        pick_args: None,
        session_flag: None,
        home_env: None,
    },
    CatalogEntry {
        id: "goose",
        name: "Goose",
        exe: &["goose"],
        launch: &["session"],
        continue_args: Some(&["session", "-r"]),
        pick_args: None,
        session_flag: None,
        home_env: None,
    },
    CatalogEntry {
        id: "crush",
        name: "Crush",
        exe: &["crush"],
        launch: &[],
        continue_args: None,
        pick_args: None,
        session_flag: None,
        home_env: None,
    },
    CatalogEntry {
        id: "amp",
        name: "Amp",
        exe: &["amp"],
        launch: &[],
        continue_args: None,
        pick_args: None,
        session_flag: None,
        home_env: None,
    },
    CatalogEntry {
        id: "openclaw",
        name: "OpenClaw",
        exe: &["openclaw"],
        // Terminal UI; the assistant itself runs behind a background Gateway.
        launch: &["tui"],
        continue_args: None,
        pick_args: None,
        session_flag: None,
        home_env: None,
    },
    // macOS / Linux: PowerShell 7 when installed (Windows has it as the built-in default terminal,
    // `AgentKind::Powershell`, so it is not listed twice there). Listed only when pwsh is on PATH.
    #[cfg(not(windows))]
    CatalogEntry {
        id: "pwsh",
        name: "PowerShell",
        exe: &["pwsh"],
        launch: &["-NoLogo"],
        continue_args: None,
        pick_args: None,
        session_flag: None,
        home_env: None,
    },
];

pub fn entry(id: &str) -> Option<&'static CatalogEntry> {
    CATALOG.iter().find(|e| e.id == id)
}

pub fn discover(e: &CatalogEntry) -> Option<Executable> {
    e.exe.iter().find_map(|name| discovery::which_exe(name))
}

/// Arguments for this launch (before user arguments).
pub fn launch_args(e: &CatalogEntry, resume: &ResumeMode) -> AppResult<Vec<String>> {
    let own = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    Ok(match resume {
        ResumeMode::None => own(e.launch),
        ResumeMode::Continue => own(e.continue_args.unwrap_or(e.launch)),
        ResumeMode::Pick => own(e.pick_args.or(e.continue_args).unwrap_or(e.launch)),
        ResumeMode::Session { id } => match e.session_flag {
            Some(flag) => {
                super::validate_session_id(id)?;
                let mut v = own(e.launch);
                v.push(flag.to_string());
                v.push(id.clone());
                v
            }
            None => own(e.continue_args.unwrap_or(e.launch)),
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_unique_and_resume_mapping() {
        let mut ids: Vec<_> = CATALOG.iter().map(|e| e.id).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), CATALOG.len());
        let hermes = entry("hermes").unwrap();
        assert_eq!(launch_args(hermes, &ResumeMode::Continue).unwrap(), vec!["--continue"]);
        assert_eq!(
            launch_args(hermes, &ResumeMode::Session { id: "0123abcd-ef".into() }).unwrap(),
            vec!["--resume", "0123abcd-ef"]
        );
        let oc = entry("openclaw").unwrap();
        assert_eq!(launch_args(oc, &ResumeMode::Continue).unwrap(), vec!["tui"]);
        assert!(launch_args(hermes, &ResumeMode::Session { id: "../x".into() }).is_err());
    }
}
