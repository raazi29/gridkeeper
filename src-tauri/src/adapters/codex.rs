//! OpenAI Codex CLI.
//!
//! The alternate screen is deliberately left ON (no `--no-alt-screen`):
//! inline mode loses history in xterm.js (openai/codex#27644).
//!
//! Accounts: each Codex account is a `CODEX_HOME` directory (documented; it must exist when
//! set). With an account: a named account sets `CODEX_HOME` (the folder must exist), the
//! default account REMOVES an inherited `CODEX_HOME` so `~/.codex` is used. Without an account
//! id (sessions created before accounts) the environment is left untouched.
//! `OPENAI_API_KEY` / `CODEX_API_KEY` are removed for NAMED accounts only (a global key must not
//! silently replace that account's login); the default account keeps the user's environment.
//! Status checks always strip them (see `accounts::check_status`). A user can re-add either
//! through the session's own environment, which is applied last.

use super::discovery::{self, Executable};
use super::{validate_session_id, AgentAdapter, Capabilities, LaunchContext, PlanBuilder};
use crate::types::*;

pub struct CodexAdapter;

impl AgentAdapter for CodexAdapter {
    fn kind(&self) -> AgentKind {
        AgentKind::Codex
    }
    fn display_name(&self) -> &'static str {
        "Codex"
    }
    fn capabilities(&self) -> Capabilities {
        Capabilities { supports_resume: true, supports_profiles: true }
    }
    fn settings_override<'s>(&self, settings: &'s Settings) -> Option<&'s str> {
        settings.agent_paths.codex.as_deref()
    }

    /// PATH (native exe preferred) → `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin\codex.exe`
    /// → npm `.cmd` shim via cmd.exe.
    fn discover(&self) -> Option<Executable> {
        let on_path = discovery::which_exe("codex");
        if let Some(exe) = on_path.as_ref().filter(|e| !e.via_cmd) {
            return Some(exe.clone());
        }
        #[cfg(windows)]
        if let Some(lad) = discovery::local_app_data() {
            let native = lad.join(r"Programs\OpenAI\Codex\bin\codex.exe");
            if native.is_file() {
                return Some(Executable::native(native));
            }
        }
        on_path
    }

    fn configure(&self, ctx: &LaunchContext<'_>, _exe: &Executable, plan: &mut PlanBuilder) -> AppResult<()> {
        if let Some(id) = ctx.spec.profile_id.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            let spec = crate::accounts::spec_for(AgentKind::Codex, None).expect("codex account spec");
            let account = crate::accounts::resolve_account(ctx.profiles, spec, id)?;
            crate::accounts::apply_launch_env(spec, &account, plan)?;
        }
        match &ctx.spec.resume {
            ResumeMode::None => {}
            ResumeMode::Continue => {
                plan.arg("resume").arg("--last");
            }
            ResumeMode::Pick => {
                // Interactive picker (cwd-filtered): used when several panes would otherwise share --last.
                plan.arg("resume");
            }
            ResumeMode::Session { id } => {
                validate_session_id(id)?;
                plan.arg("resume").arg(id.clone());
            }
        }
        Ok(())
    }
}
