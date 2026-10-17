//! Workspace state persistence. STUB — to be implemented by the services owner.

use std::path::PathBuf;

use parking_lot::Mutex;

use crate::types::*;

pub struct StateStore {
    #[allow(dead_code)]
    path: PathBuf,
    state: Mutex<PersistedState>,
}

impl StateStore {
    pub fn load(path: PathBuf) -> Self {
        Self { path, state: Mutex::new(PersistedState::default()) }
    }
    pub fn get(&self) -> PersistedState {
        self.state.lock().clone()
    }
    pub fn settings(&self) -> Settings {
        self.state.lock().settings.clone()
    }
    pub fn save(&self, state: PersistedState) -> AppResult<()> {
        *self.state.lock() = state;
        Ok(())
    }
}
