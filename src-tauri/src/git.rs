//! Git integration. STUB — to be implemented by the services owner.

use crate::types::*;

pub fn info(_path: &str) -> AppResult<GitInfo> {
    Ok(GitInfo::default())
}

pub fn worktree_add(_repo: &str, _path: &str, _branch: &str, _new_branch: bool) -> AppResult<WorktreeInfo> {
    Err(AppError::Other("not implemented".into()))
}
