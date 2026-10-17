//! Agent adapters. STUB — to be implemented by the services owner.

use crate::profiles::ProfileStore;
use crate::types::*;

/// Resolve executable, arguments, environment and cwd for a session.
pub fn resolve_launch(_spec: &SessionSpec, _profiles: &ProfileStore, _settings: &Settings) -> AppResult<LaunchPlan> {
    Err(AppError::Other("not implemented".into()))
}

/// Discover installed agent executables and versions.
pub fn detect(_settings: &Settings) -> Vec<AgentAvailability> {
    Vec::new()
}
