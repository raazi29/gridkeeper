//! Claude Code.
//!
//! Profiles: each Claude account lives in its own config directory selected
//! with `CLAUDE_CONFIG_DIR`. The default profile means "Claude's default
//! location" (`%USERPROFILE%\.claude`), so for it we explicitly REMOVE
//! `CLAUDE_CONFIG_DIR` — the app itself may have inherited one, and leaking it
//! would silently run the default profile under another account.
//!
//! Identity isolation: Claude Code prefers `ANTHROPIC_AUTH_TOKEN`,
//! `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_PROFILE` over
//! the per-config-dir subscription login. If any of them is inherited from the
//! app's environment, every profile would authenticate as that one identity,
//! so they are always removed. A user who really wants one can add it back
//! explicitly through the session's `env` (applied last).

use std::path::{Path, PathBuf};

use super::discovery::{self, Executable};
use super::{validate_session_id, AgentAdapter, Capabilities, LaunchContext, PlanBuilder};
use crate::types::*;

pub struct ClaudeAdapter;

/// Environment variables that override the per-profile login.
pub const CLAUDE_IDENTITY_ENV: &[&str] =
    &["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_PROFILE"];

/// Whether `<config_root>/projects/*/<id>.jsonl` exists. Directory listing and
/// file-existence checks only; transcripts are never opened.
pub fn transcript_exists(config_root: &Path, id: &str) -> bool {
    let Ok(entries) = std::fs::read_dir(config_root.join("projects")) else {
        return false;
    };
    let file = format!("{id}.jsonl");
    entries
        .flatten()
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .any(|e| e.path().join(&file).is_file())
}

impl AgentAdapter for ClaudeAdapter {
    fn kind(&self) -> AgentKind {
        AgentKind::Claude
    }
    fn display_name(&self) -> &'static str {
        "Claude Code"
    }
    fn capabilities(&self) -> Capabilities {
        Capabilities { supports_resume: true, supports_profiles: true }
    }
    fn settings_override<'s>(&self, settings: &'s Settings) -> Option<&'s str> {
        settings.agent_paths.claude.as_deref()
    }

    /// Native installer location first, then PATH (preferring a native exe
    /// over the npm `.cmd` shim).
    fn discover(&self) -> Option<Executable> {
        if let Some(home) = discovery::home_dir() {
            let native = home.join(r".local\bin\claude.exe");
            if native.is_file() {
                return Some(Executable::native(native));
            }
        }
        discovery::which_exe("claude")
    }

    fn configure(&self, ctx: &LaunchContext<'_>, _exe: &Executable, plan: &mut PlanBuilder) -> AppResult<()> {
        let spec = ctx.spec;

        // --- profile -------------------------------------------------------
        let profile = match spec.profile_id.as_deref().filter(|s| !s.is_empty()) {
            Some(id) => {
                let account = ctx
                    .profiles
                    .get_account(id)
                    .ok_or_else(|| AppError::NotFound(format!("Claude profile {id}")))?;
                if account.agent != AgentKind::Claude {
                    return Err(AppError::Invalid(format!("Account {:?} is not a Claude Code account", account.name)));
                }
                Some(account.profile)
            }
            None => ctx.profiles.default_profile(),
        };
        let config_dir = profile.as_ref().and_then(|p| p.config_dir.clone()).filter(|d| !d.trim().is_empty());
        let config_root: Option<PathBuf> = match &config_dir {
            None => {
                plan.remove_env("CLAUDE_CONFIG_DIR");
                discovery::home_dir().map(|h| h.join(".claude"))
            }
            Some(dir) => {
                let p = PathBuf::from(dir);
                if !p.is_dir() {
                    return Err(AppError::Invalid(format!("Profile directory missing: {dir}")));
                }
                plan.set_env("CLAUDE_CONFIG_DIR", dir.clone());
                Some(p)
            }
        };
        for key in CLAUDE_IDENTITY_ENV {
            plan.remove_env(*key);
        }
        // ConPTY hosts mis-coalesce positioned writes of the fullscreen renderer.
        plan.set_env("CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT", "1");

        // --- resume --------------------------------------------------------
        match &spec.resume {
            ResumeMode::None => {
                if let Some(id) = spec.agent_session_id.as_deref().filter(|s| !s.is_empty()) {
                    validate_session_id(id)?;
                    plan.arg("--session-id").arg(id);
                }
            }
            ResumeMode::Continue => {
                plan.arg("--continue");
            }
            ResumeMode::Pick => {
                // Interactive picker of this profile's conversations.
                plan.arg("--resume");
            }
            ResumeMode::Session { id } => {
                validate_session_id(id)?;
                let exists = config_root.as_deref().map(|r| transcript_exists(r, id)).unwrap_or(false);
                if exists {
                    plan.arg("--resume").arg(id.clone());
                } else {
                    // No transcript (never written, or another profile): start a fresh
                    // conversation pinned to the same id so a later resume still works.
                    tracing::info!(session = %spec.id, "claude transcript not found; starting pinned new conversation");
                    plan.arg("--session-id").arg(id.clone());
                }
            }
        }
        Ok(())
    }
}
