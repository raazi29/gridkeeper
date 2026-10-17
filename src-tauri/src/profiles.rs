//! Claude account profiles. STUB — to be implemented by the services owner.

use std::path::PathBuf;

use crate::types::*;

pub struct ProfileStore {
    #[allow(dead_code)]
    path: PathBuf,
}

impl ProfileStore {
    pub fn load(path: PathBuf) -> Self {
        Self { path }
    }
    pub fn list(&self) -> Vec<ClaudeProfile> {
        Vec::new()
    }
    pub fn get(&self, _id: &str) -> Option<ClaudeProfile> {
        None
    }
    pub fn create(&self, _name: String, _config_dir: Option<String>, _color: Option<String>) -> AppResult<ClaudeProfile> {
        Err(AppError::Other("not implemented".into()))
    }
    pub fn update(&self, _profile: ClaudeProfile) -> AppResult<ClaudeProfile> {
        Err(AppError::Other("not implemented".into()))
    }
    pub fn delete(&self, _id: &str) -> AppResult<()> {
        Ok(())
    }
}

/// Verify login state by running `claude auth status --json` with the profile's environment.
pub fn check_status(_profile: &ClaudeProfile, _settings: &Settings) -> AppResult<ProfileStatus> {
    Err(AppError::Other("not implemented".into()))
}
