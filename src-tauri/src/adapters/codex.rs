//! OpenAI Codex CLI.
//!
//! The alternate screen is deliberately left ON (no `--no-alt-screen`):
//! inline mode loses history in xterm.js (openai/codex#27644).

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
        Capabilities { supports_resume: true, supports_profiles: false }
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
        if let Some(lad) = discovery::local_app_data() {
            let native = lad.join(r"Programs\OpenAI\Codex\bin\codex.exe");
            if native.is_file() {
                return Some(Executable::native(native));
            }
        }
        on_path
    }

    fn configure(&self, ctx: &LaunchContext<'_>, _exe: &Executable, plan: &mut PlanBuilder) -> AppResult<()> {
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
