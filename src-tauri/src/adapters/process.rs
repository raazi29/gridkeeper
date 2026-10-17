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
        let cmd = hidden_command("definitely-not-a-real-program-altera.exe");
        assert!(run_with_timeout(cmd, Duration::from_secs(1)).is_err());
    }

    #[test]
    fn first_line_skips_blank() {
        assert_eq!(first_line(b"\r\n  \n 2.1.0 (Claude Code)\nmore").as_deref(), Some("2.1.0 (Claude Code)"));
        assert_eq!(first_line(b""), None);
    }
}
