//! Spend guard ledger: `<data>\spend-ledger.json`, a small JSON object the frontend keeps
//! (src/store/spend.ts: per-day totals per workspace and the last cost seen per Claude conversation;
//! numbers only, nothing from transcripts). Rust only checks that it is a JSON object of bounded size
//! and writes it atomically. It lives next to `workspaces.json`, outside the watched meter folder.

use std::io::Read;
use std::path::{Path, PathBuf};

use crate::types::{AppError, AppResult};

pub const FILE_NAME: &str = "spend-ledger.json";
/// Larger ledgers are refused (the frontend prunes to a few weeks, far below this).
pub const MAX_BYTES: usize = 512 * 1024;

pub fn path(data_dir: &Path) -> PathBuf {
    data_dir.join(FILE_NAME)
}

/// The ledger text, or `None` when there is none yet (or it is unreadable / oversize: start over).
pub fn read(data_dir: &Path) -> AppResult<Option<String>> {
    let p = path(data_dir);
    let f = match std::fs::File::open(&p) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    let mut bytes = Vec::new();
    f.take(MAX_BYTES as u64 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > MAX_BYTES {
        tracing::warn!("spend ledger is oversize; starting a new one");
        return Ok(None);
    }
    let text = String::from_utf8(bytes).ok();
    Ok(text.filter(|t| matches!(serde_json::from_str::<serde_json::Value>(t), Ok(serde_json::Value::Object(_)))))
}

/// Replace the ledger (atomic). `text` must be a JSON object of at most [`MAX_BYTES`].
pub fn write(data_dir: &Path, text: &str) -> AppResult<()> {
    if text.len() > MAX_BYTES {
        return Err(AppError::Invalid(format!("spend ledger is larger than {} KiB", MAX_BYTES / 1024)));
    }
    if !matches!(serde_json::from_str::<serde_json::Value>(text), Ok(serde_json::Value::Object(_))) {
        return Err(AppError::Invalid("spend ledger must be a JSON object".into()));
    }
    std::fs::create_dir_all(data_dir)?;
    Ok(super::write_atomic(&path(data_dir), text.as_bytes())?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_and_validation() {
        let t = tempfile::tempdir().unwrap();
        assert_eq!(read(t.path()).unwrap(), None);
        write(t.path(), r#"{"v":1,"days":{}}"#).unwrap();
        assert_eq!(read(t.path()).unwrap().as_deref(), Some(r#"{"v":1,"days":{}}"#));
        assert!(write(t.path(), "[1,2]").is_err());
        assert!(write(t.path(), "not json").is_err());
        assert!(write(t.path(), &format!(r#"{{"x":"{}"}}"#, "a".repeat(MAX_BYTES))).is_err());
        // A damaged file reads as "no ledger" (the frontend starts a new one).
        std::fs::write(path(t.path()), "{ broken").unwrap();
        assert_eq!(read(t.path()).unwrap(), None);
        let leftovers: Vec<_> = std::fs::read_dir(t.path()).unwrap().flatten().filter(|e| e.file_name() != FILE_NAME).collect();
        assert!(leftovers.is_empty(), "no temp files left");
    }
}
