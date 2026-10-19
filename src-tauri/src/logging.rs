//! Structured logging.
//!
//! - JSON lines in `<logs_dir>/gridkeeper.<YYYY-MM-DD>.log` (daily rotation by
//!   `tracing-appender`, which names files `<prefix>.<date>.<suffix>`; at most
//!   `MAX_LOG_FILES` are kept — older ones are pruned when the appender is
//!   built and on every rollover).
//! - Writes go through a non-blocking worker; every line is passed through
//!   `redact::redact` on that worker thread before it reaches disk.
//! - Filter: `info` by default, overridable with the `GRIDKEEPER_LOG` env var
//!   (standard `EnvFilter` syntax, e.g. `GRIDKEEPER_LOG=debug,gridkeeper_lib::pty=trace`).
//! - Debug builds also log human-readable lines to stdout (also redacted).

use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use tracing_appender::non_blocking::WorkerGuard;
use tracing_appender::rolling::{RollingFileAppender, Rotation};
use tracing_subscriber::fmt::MakeWriter;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::{EnvFilter, Layer};

pub const LOG_PREFIX: &str = "gridkeeper";
pub const LOG_SUFFIX: &str = "log";
pub const MAX_LOG_FILES: usize = 7;
pub const LOG_ENV: &str = "GRIDKEEPER_LOG";

static INITIALIZED: AtomicBool = AtomicBool::new(false);

/// Keeps the background log writer alive; dropping it flushes pending lines.
pub struct LogGuard {
    _file: WorkerGuard,
    pub logs_dir: PathBuf,
}

/// A `Write` adapter that redacts complete lines before forwarding them.
/// Partial lines are buffered until their newline arrives (or flush/drop).
pub struct RedactingWriter<W: Write> {
    inner: W,
    pending: Vec<u8>,
}

impl<W: Write> RedactingWriter<W> {
    pub fn new(inner: W) -> Self {
        Self { inner, pending: Vec::new() }
    }

    fn emit(&mut self, line: &[u8]) -> io::Result<()> {
        let text = String::from_utf8_lossy(line);
        self.inner.write_all(crate::redact::redact(&text).as_bytes())
    }
}

impl<W: Write> Write for RedactingWriter<W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.pending.extend_from_slice(buf);
        while let Some(pos) = self.pending.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = self.pending.drain(..=pos).collect();
            self.emit(&line)?;
        }
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        if !self.pending.is_empty() {
            let rest = std::mem::take(&mut self.pending);
            self.emit(&rest)?;
        }
        self.inner.flush()
    }
}

impl<W: Write> Drop for RedactingWriter<W> {
    fn drop(&mut self) {
        let _ = self.flush();
    }
}

/// `MakeWriter` for stdout that redacts each event.
struct RedactingStdout;

impl<'a> MakeWriter<'a> for RedactingStdout {
    type Writer = RedactingWriter<io::Stdout>;
    fn make_writer(&'a self) -> Self::Writer {
        RedactingWriter::new(io::stdout())
    }
}

/// All `gridkeeper.*.log` files in `logs_dir`, newest (by modification time) first.
pub fn log_files(logs_dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(logs_dir) else {
        return Vec::new();
    };
    let mut files: Vec<(std::time::SystemTime, PathBuf)> = entries
        .flatten()
        .filter(|e| {
            let n = e.file_name().to_string_lossy().to_ascii_lowercase();
            n.starts_with(&format!("{LOG_PREFIX}.")) && n.ends_with(&format!(".{LOG_SUFFIX}"))
        })
        .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
        .collect();
    files.sort_by_key(|a| std::cmp::Reverse(a.0));
    files.into_iter().map(|(_, p)| p).collect()
}

/// The log file currently being written (newest), if any.
pub fn current_log_file(logs_dir: &Path) -> Option<PathBuf> {
    log_files(logs_dir).into_iter().next()
}

fn build_appender(logs_dir: &Path) -> anyhow::Result<RollingFileAppender> {
    std::fs::create_dir_all(logs_dir)?;
    Ok(RollingFileAppender::builder()
        .rotation(Rotation::DAILY)
        .filename_prefix(LOG_PREFIX)
        .filename_suffix(LOG_SUFFIX)
        .max_log_files(MAX_LOG_FILES)
        .build(logs_dir)?)
}

/// Install the global subscriber. Returns `Err` (without side effects on the
/// existing subscriber) if logging was already initialized.
pub fn init(logs_dir: &Path) -> anyhow::Result<LogGuard> {
    if INITIALIZED.swap(true, Ordering::SeqCst) {
        anyhow::bail!("logging already initialized");
    }
    let result = (|| {
        let appender = build_appender(logs_dir)?;
        let (writer, guard) = tracing_appender::non_blocking::NonBlockingBuilder::default()
            .lossy(true)
            .thread_name("gridkeeper-log")
            .finish(RedactingWriter::new(appender));

        let filter = EnvFilter::try_from_env(LOG_ENV).unwrap_or_else(|_| EnvFilter::new("info"));
        let file_layer = tracing_subscriber::fmt::layer()
            .json()
            .flatten_event(true)
            .with_current_span(true)
            .with_span_list(false)
            .with_target(true)
            .with_thread_names(true)
            .with_ansi(false)
            .with_writer(writer)
            .boxed();

        let stdout_layer = if cfg!(debug_assertions) {
            Some(tracing_subscriber::fmt::layer().with_target(true).with_writer(RedactingStdout).boxed())
        } else {
            None
        };

        tracing_subscriber::registry()
            .with(filter)
            .with(file_layer)
            .with(stdout_layer)
            .try_init()?;
        Ok(LogGuard { _file: guard, logs_dir: logs_dir.to_path_buf() })
    })();
    if result.is_err() {
        INITIALIZED.store(false, Ordering::SeqCst);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacting_writer_buffers_partial_lines() {
        let mut out = Vec::new();
        {
            let mut w = RedactingWriter::new(&mut out);
            w.write_all(b"{\"message\":\"token=abc").unwrap();
            w.write_all(b"def\"}\nplain line\n").unwrap();
            w.write_all(b"tail password=x").unwrap();
        }
        let text = String::from_utf8(out).unwrap();
        assert!(!text.contains("abcdef"), "{text}");
        assert!(!text.contains("password=x"), "{text}");
        assert!(text.contains("plain line\n"));
        let first = text.lines().next().unwrap();
        serde_json::from_str::<serde_json::Value>(first).expect("still JSON");
    }

    #[test]
    fn log_file_listing() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("gridkeeper.2026-10-01.log"), "a\n").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(dir.path().join("gridkeeper.2026-10-02.log"), "b\n").unwrap();
        std::fs::write(dir.path().join("other.txt"), "c\n").unwrap();
        let files = log_files(dir.path());
        assert_eq!(files.len(), 2);
        assert!(current_log_file(dir.path()).unwrap().ends_with("gridkeeper.2026-10-02.log"));
    }

    /// The only test that installs the global subscriber.
    #[test]
    fn init_writes_redacted_json_and_rejects_second_call() {
        let dir = tempfile::tempdir().unwrap();
        // Old files beyond the retention limit are pruned when the appender is built.
        for day in 1..=10 {
            std::fs::write(dir.path().join(format!("gridkeeper.2020-01-{day:02}.log")), "old\n").unwrap();
        }
        let guard = init(dir.path()).expect("first init");
        assert!(init(dir.path()).is_err(), "second init must fail");
        tracing::info!(target: "altera_test", api_key = "sk-ant-api03-SECRETSECRETSECRET", "hello token=abc123");
        drop(guard); // flush (the worker waits at most 1 s, which a loaded CI machine can exceed)
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let line = loop {
            let text = current_log_file(dir.path()).and_then(|p| std::fs::read_to_string(p).ok()).unwrap_or_default();
            if let Some(l) = text.lines().find(|l| l.contains("altera_test")) {
                break l.to_string();
            }
            assert!(std::time::Instant::now() < deadline, "event written");
            std::thread::sleep(std::time::Duration::from_millis(50));
        };
        assert!(!line.contains("SECRETSECRET") && !line.contains("abc123"), "{line}");
        let v: serde_json::Value = serde_json::from_str(&line).expect("JSON line");
        assert_eq!(v["level"], "INFO");
        assert!(log_files(dir.path()).len() <= MAX_LOG_FILES, "{:?}", log_files(dir.path()));
    }
}
