//! Resource diagnostics. STUB — to be implemented by the services owner.

use crate::state::AppCtx;
use crate::types::*;

pub struct DiagSampler;

impl DiagSampler {
    pub fn new() -> Self {
        Self
    }
    pub fn snapshot(&self, _roots: &[(SessionId, u32)]) -> Diagnostics {
        Diagnostics::default()
    }
}

pub fn export(_ctx: &AppCtx, _roots: &[(SessionId, u32)], _frontend: serde_json::Value) -> AppResult<String> {
    Err(AppError::Other("not implemented".into()))
}
