//! PowerShell: pwsh 7 preferred, Windows PowerShell 5.1 as fallback.

use std::path::PathBuf;

use super::discovery::{self, Executable};
use super::{AgentAdapter, Capabilities, LaunchContext, PlanBuilder};
use crate::types::*;

pub struct PowerShellAdapter;

fn is_windows_powershell(exe: &Executable) -> bool {
    exe.path
        .file_name()
        .map(|n| n.to_string_lossy().eq_ignore_ascii_case("powershell.exe"))
        .unwrap_or(false)
}

impl AgentAdapter for PowerShellAdapter {
    fn kind(&self) -> AgentKind {
        AgentKind::Powershell
    }
    fn display_name(&self) -> &'static str {
        "PowerShell"
    }
    fn capabilities(&self) -> Capabilities {
        Capabilities { supports_resume: false, supports_profiles: false }
    }
    fn settings_override<'s>(&self, settings: &'s Settings) -> Option<&'s str> {
        settings.agent_paths.powershell.as_deref()
    }

    fn discover(&self) -> Option<Executable> {
        if let Some(exe) = discovery::which_exe("pwsh").filter(|e| !e.via_cmd) {
            return Some(exe);
        }
        let mut candidates = Vec::new();
        for var in ["ProgramFiles", "ProgramW6432"] {
            if let Some(pf) = std::env::var_os(var) {
                candidates.push(PathBuf::from(pf).join(r"PowerShell\7\pwsh.exe"));
            }
        }
        candidates.push(PathBuf::from(r"C:\Program Files\PowerShell\7\pwsh.exe"));
        if let Some(found) = candidates.into_iter().find(|p| p.is_file()) {
            return Some(Executable::native(found));
        }
        if let Some(exe) = discovery::which_exe("powershell").filter(|e| !e.via_cmd) {
            return Some(exe);
        }
        let root = std::env::var_os("SystemRoot").unwrap_or_else(|| r"C:\Windows".into());
        let legacy = PathBuf::from(root).join(r"System32\WindowsPowerShell\v1.0\powershell.exe");
        legacy.is_file().then(|| Executable::native(legacy))
    }

    fn version_args(&self, exe: &Executable) -> Option<Vec<String>> {
        if is_windows_powershell(exe) {
            // Windows PowerShell 5.1 has no --version switch.
            Some(
                ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"]
                    .map(String::from)
                    .to_vec(),
            )
        } else {
            Some(vec!["--version".into()])
        }
    }

    fn configure(&self, _ctx: &LaunchContext<'_>, _exe: &Executable, plan: &mut PlanBuilder) -> AppResult<()> {
        plan.arg("-NoLogo");
        Ok(())
    }
}
