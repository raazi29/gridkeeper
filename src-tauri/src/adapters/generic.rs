//! Any other command-line program. `SessionSpec.command` is required; bare
//! names are resolved on PATH; `.cmd`/`.bat` files run via `cmd.exe /d /c`.

use super::discovery::Executable;
use super::{AgentAdapter, Capabilities, LaunchContext, PlanBuilder};
use crate::types::*;

pub struct GenericAdapter;

impl AgentAdapter for GenericAdapter {
    fn kind(&self) -> AgentKind {
        AgentKind::Generic
    }
    fn display_name(&self) -> &'static str {
        "Command"
    }
    fn capabilities(&self) -> Capabilities {
        Capabilities { supports_resume: false, supports_profiles: false }
    }

    fn discover(&self) -> Option<Executable> {
        None
    }

    fn version_args(&self, _exe: &Executable) -> Option<Vec<String>> {
        None
    }

    fn configure(&self, ctx: &LaunchContext<'_>, _exe: &Executable, _plan: &mut PlanBuilder) -> AppResult<()> {
        // `resolve_executable` already used `spec.command`; reaching here without
        // one is impossible because discovery returns None. Keep the explicit
        // check so the error message is precise if that ever changes.
        if ctx.spec.command.as_deref().map(str::trim).unwrap_or("").is_empty() {
            return Err(AppError::Invalid("A command is required for a generic session".into()));
        }
        Ok(())
    }
}
