//! Small helpers for running short-lived helper processes (`--version`,
//! `claude auth status`, `git ...`) without flashing a console window and
//! without ever hanging the caller.

use std::ffi::OsStr;
use std::io::{self, Read};
use std::process::{Command, Output, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// `CREATE_NO_WINDOW` process creation flag.
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// A `Command` that will not open a console window on Windows.
pub fn hidden_command(program: impl AsRef<OsStr>) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

fn drain<R: Read + Send + 'static>(pipe: Option<R>) -> mpsc::Receiver<Vec<u8>> {
    let (tx, rx) = mpsc::channel();
    if let Some(mut pipe) = pipe {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = pipe.read_to_end(&mut buf);
            let _ = tx.send(buf);
        });
    } else {
        let _ = tx.send(Vec::new());
    }
    rx
}

/// Run `cmd` to completion with stdin closed and stdout/stderr captured.
///
/// Both pipes are drained on background threads (a full pipe would otherwise
/// block the child). If the child does not exit within `timeout` it is killed
/// and `ErrorKind::TimedOut` is returned.
///
/// Caveat: `kill()` terminates the direct child only. When the program is a
/// `cmd.exe /c` wrapper, a grandchild may survive and keep the pipes open; we
/// therefore wait at most two extra seconds for the pipe readers after exit and
/// return whatever was collected (possibly nothing).
pub fn run_with_timeout(mut cmd: Command, timeout: Duration) -> io::Result<Output> {
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn()?;
    let out_rx = drain(child.stdout.take());
    let err_rx = drain(child.stderr.take());

    let deadline = Instant::now() + timeout;
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                format!("process did not finish within {} s", timeout.as_secs()),
            ));
        }
        std::thread::sleep(Duration::from_millis(25));
    };

    let grace = Duration::from_secs(2);
    let stdout = out_rx.recv_timeout(grace).unwrap_or_default();
    let stderr = err_rx.recv_timeout(grace).unwrap_or_default();
    Ok(Output { status, stdout, stderr })
}

/// Output of [`run_capped`]: stdout is at most `max_stdout` bytes.
pub struct CappedOutput {
    /// `None` when the child was killed because stdout exceeded the cap.
    pub status: Option<std::process::ExitStatus>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    /// stdout went over the cap; the child was killed and `stdout` holds the first `max_stdout` bytes.
    pub truncated: bool,
}

/// Collects at most `cap` bytes of `pipe`; sets `over` once more data arrives.
fn drain_capped<R: Read + Send + 'static>(
    pipe: Option<R>,
    cap: usize,
    over: std::sync::Arc<std::sync::atomic::AtomicBool>,
) -> mpsc::Receiver<Vec<u8>> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut pipe) = pipe {
            let mut chunk = [0u8; 16 * 1024];
            loop {
                match pipe.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let room = cap.saturating_sub(buf.len());
                        buf.extend_from_slice(&chunk[..n.min(room)]);
                        if n > room {
                            over.store(true, std::sync::atomic::Ordering::SeqCst);
                            break;
                        }
                    }
                }
            }
        }
        let _ = tx.send(buf);
    });
    rx
}

/// Like [`run_with_timeout`], but never buffers more than `max_stdout` bytes of stdout (and 64 KiB
/// of stderr): once stdout goes over the cap the child is killed and the result is marked truncated.
pub fn run_capped(mut cmd: Command, timeout: Duration, max_stdout: usize) -> io::Result<CappedOutput> {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn()?;
    let over = Arc::new(AtomicBool::new(false));
    let out_rx = drain_capped(child.stdout.take(), max_stdout, Arc::clone(&over));
    let err_rx = drain_capped(child.stderr.take(), 64 * 1024, Arc::new(AtomicBool::new(false)));

    let deadline = Instant::now() + timeout;
    let status = loop {
        if over.load(Ordering::SeqCst) {
            let _ = child.kill();
            let _ = child.wait();
            break None;
        }
        if let Some(status) = child.try_wait()? {
            break Some(status);
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                format!("process did not finish within {} s", timeout.as_secs()),
            ));
        }
        std::thread::sleep(Duration::from_millis(15));
    };
    let grace = Duration::from_secs(2);
    let stdout = out_rx.recv_timeout(grace).unwrap_or_default();
    let stderr = err_rx.recv_timeout(grace).unwrap_or_default();
    Ok(CappedOutput { status, stdout, stderr, truncated: over.load(Ordering::SeqCst) })
}

/// First non-empty, trimmed line of a byte buffer (lossy UTF-8), max 200 chars.
pub fn first_line(bytes: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(bytes);
    text.lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .map(|l| l.chars().take(200).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runs_and_captures() {
        let mut cmd = hidden_command("cmd.exe");
        cmd.args(["/d", "/c", "echo hello"]);
        let out = run_with_timeout(cmd, Duration::from_secs(10)).expect("cmd runs");
        assert!(out.status.success());
        assert_eq!(first_line(&out.stdout).as_deref(), Some("hello"));
    }

    #[test]
    fn times_out() {
        let mut cmd = hidden_command("cmd.exe");
        // `ping -n 30` takes ~29 s.
        cmd.args(["/d", "/c", "ping -n 30 127.0.0.1 >NUL"]);
        let start = Instant::now();
        let err = run_with_timeout(cmd, Duration::from_millis(500)).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::TimedOut);
        assert!(start.elapsed() < Duration::from_secs(10));
    }

    #[test]
    fn missing_program_is_error() {
        let cmd = hidden_command("definitely-not-a-real-program-gridkeeper.exe");
        assert!(run_with_timeout(cmd, Duration::from_secs(1)).is_err());
    }

    #[test]
    fn capped_output_is_cut_and_marked() {
        let mut cmd = hidden_command("cmd.exe");
        cmd.args(["/d", "/c", "for /l %i in (1,1,2000) do @echo 0123456789abcdef"]);
        let out = run_capped(cmd, Duration::from_secs(20), 1000).expect("cmd runs");
        assert!(out.truncated);
        assert_eq!(out.stdout.len(), 1000);

        let mut cmd = hidden_command("cmd.exe");
        cmd.args(["/d", "/c", "echo small"]);
        let out = run_capped(cmd, Duration::from_secs(10), 1000).expect("cmd runs");
        assert!(!out.truncated);
        assert!(out.status.is_some_and(|s| s.success()));
        assert_eq!(first_line(&out.stdout).as_deref(), Some("small"));
    }

    #[test]
    fn first_line_skips_blank() {
        assert_eq!(first_line(b"\r\n  \n 2.1.0 (Claude Code)\nmore").as_deref(), Some("2.1.0 (Claude Code)"));
        assert_eq!(first_line(b""), None);
    }
}
