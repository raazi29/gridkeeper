//! ConPTY session management. STUB — to be implemented by the PTY-core owner.
//! The public API of `SessionManager` below is the contract used by commands.

use std::time::Duration;

use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::AppHandle;

use crate::types::*;

pub struct SessionManager {
    #[allow(dead_code)]
    app: AppHandle,
}

impl SessionManager {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }

    /// Spawn the process in a new pseudo console; `buffer_bytes` bounds the replay ring.
    pub fn start(&self, _spec: SessionSpec, _plan: LaunchPlan, _buffer_bytes: usize) -> AppResult<SessionInfo> {
        Err(AppError::Other("not implemented".into()))
    }
    pub fn attach(&self, _id: &str, _channel: Channel<InvokeResponseBody>) -> AppResult<SessionInfo> {
        Err(AppError::Other("not implemented".into()))
    }
    pub fn detach(&self, _id: &str) -> AppResult<()> {
        Ok(())
    }
    pub fn write(&self, _id: &str, _data: Vec<u8>) -> AppResult<()> {
        Ok(())
    }
    pub fn resize(&self, _id: &str, _cols: u16, _rows: u16) -> AppResult<()> {
        Ok(())
    }
    pub fn ack(&self, _id: &str, _bytes: u64) -> AppResult<()> {
        Ok(())
    }
    pub fn stop(&self, _id: &str, _force: bool) -> AppResult<()> {
        Ok(())
    }
    pub fn list(&self) -> Vec<SessionInfo> {
        Vec::new()
    }
    pub fn output_text(&self, _id: &str) -> AppResult<String> {
        Ok(String::new())
    }
    pub fn clear_buffer(&self, _id: &str) -> AppResult<()> {
        Ok(())
    }
    pub fn remove(&self, _id: &str) -> AppResult<()> {
        Ok(())
    }
    /// (session id, root pid) of every live session — used for diagnostics.
    pub fn root_pids(&self) -> Vec<(SessionId, u32)> {
        Vec::new()
    }
    /// Gracefully stop all sessions, force-killing whatever remains after `timeout`.
    pub fn shutdown_all(&self, _timeout: Duration) {}
}
