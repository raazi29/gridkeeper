//! Structured logging. STUB — to be implemented by the services owner.

use std::path::Path;

pub struct LogGuard;

pub fn init(_logs_dir: &Path) -> anyhow::Result<LogGuard> {
    Ok(LogGuard)
}
