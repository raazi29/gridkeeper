//! Byte-level VT/ANSI escape handling:
//! - [`scan_escape`]: a small tokenizer for 7-bit escape sequences,
//! - [`strip_ansi`]: plain-text export of terminal output,
//! - [`filter_queries`]: removes terminal *queries* from replayed output so a
//!   freshly attached terminal does not answer stale requests,
//! - [`CprScanner`]: streaming detector for the cursor-position request `ESC[6n`.
//!
//! All control characters and escape introducers are ASCII, and UTF-8 never
//! uses ASCII bytes inside multi-byte sequences, so working on raw bytes is
//! safe: stripping cannot split a code point.

const ESC: u8 = 0x1b;
const BEL: u8 = 0x07;
const CAN: u8 = 0x18;
const SUB: u8 = 0x1a;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EscKind {
    /// `ESC [ params intermediates final`
    Csi,
    /// `ESC ] ... (BEL | ESC \)`
    Osc,
    /// `ESC P ... ESC \`
    Dcs,
    /// SOS / PM / APC strings (`ESC X`, `ESC ^`, `ESC _`).
    Str,
    /// Two-or-more byte escape such as `ESC 7`, `ESC ( B`, `ESC M`.
    Simple,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EscScan {
    /// A sequence of `len` bytes (including the leading ESC).
    Complete { len: usize, kind: EscKind },
    /// The buffer ends before the sequence does.
    Incomplete,
}

/// Scan the escape sequence that starts at `b[0]` (which must be ESC).
///
/// Malformed sequences are terminated at the first byte that cannot belong to
/// them (that byte is *not* consumed), mirroring how terminals recover.
pub fn scan_escape(b: &[u8]) -> EscScan {
    debug_assert!(b.first() == Some(&ESC));
    let Some(&intro) = b.get(1) else { return EscScan::Incomplete };
    match intro {
        b'[' => {
            let mut i = 2;
            while let Some(&c) = b.get(i) {
                match c {
                    0x20..=0x3f => i += 1,
                    0x40..=0x7e => return EscScan::Complete { len: i + 1, kind: EscKind::Csi },
                    _ => return EscScan::Complete { len: i, kind: EscKind::Csi },
                }
            }
            EscScan::Incomplete
        }
        b']' | b'P' | b'X' | b'^' | b'_' => {
            let kind = match intro {
                b']' => EscKind::Osc,
                b'P' => EscKind::Dcs,
                _ => EscKind::Str,
            };
            let mut i = 2;
            while let Some(&c) = b.get(i) {
                match c {
                    BEL => return EscScan::Complete { len: i + 1, kind },
                    CAN | SUB => return EscScan::Complete { len: i + 1, kind },
                    ESC => match b.get(i + 1) {
                        Some(b'\\') => return EscScan::Complete { len: i + 2, kind },
                        // A new escape aborts the string; it is not consumed.
                        Some(_) => return EscScan::Complete { len: i, kind },
                        None => return EscScan::Incomplete,
                    },
                    _ => i += 1,
                }
            }
            EscScan::Incomplete
        }
        // nF sequences: intermediates then a final byte (e.g. ESC ( B).
        0x20..=0x2f => {
            let mut i = 2;
            while let Some(&c) = b.get(i) {
                match c {
                    0x20..=0x2f => i += 1,
                    0x30..=0x7e => return EscScan::Complete { len: i + 1, kind: EscKind::Simple },
                    _ => return EscScan::Complete { len: i, kind: EscKind::Simple },
                }
            }
            EscScan::Incomplete
        }
        0x30..=0x7e => EscScan::Complete { len: 2, kind: EscKind::Simple },
        // ESC followed by a control or high byte: drop the lone ESC.
        _ => EscScan::Complete { len: 1, kind: EscKind::Simple },
    }
}

/// Convert raw terminal output to plain text: escape sequences removed,
/// `\r\n` (and runs of `\r` before `\n`) normalized to `\n`, a lone `\r`
/// treated as a line break, other C0 controls dropped, cursor-forward
/// (`CSI n C`, which ConPTY uses instead of runs of spaces) expanded to
/// spaces, and invalid UTF-8 replaced lossily.
pub fn strip_ansi(input: &[u8]) -> String {
    let mut out: Vec<u8> = Vec::with_capacity(input.len());
    let mut i = 0;
    while i < input.len() {
        let c = input[i];
        match c {
            ESC => match scan_escape(&input[i..]) {
                EscScan::Complete { len, kind } => {
                    if kind == EscKind::Csi && input[i + len - 1] == b'C' {
                        let n = csi_first_param(&input[i + 2..i + len - 1]).unwrap_or(1).clamp(1, 1000);
                        out.extend(std::iter::repeat_n(b' ', n as usize));
                    }
                    i += len;
                }
                EscScan::Incomplete => break,
            },
            b'\r' => {
                let mut j = i;
                while j < input.len() && input[j] == b'\r' {
                    j += 1;
                }
                out.push(b'\n');
                // "\r\n" (or "\r\r\n") is a single line break.
                if j < input.len() && input[j] == b'\n' {
                    j += 1;
                }
                i = j;
            }
            b'\n' | b'\t' => {
                out.push(c);
                i += 1;
            }
            0x00..=0x1f | 0x7f => i += 1,
            _ => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn csi_first_param(params: &[u8]) -> Option<u32> {
    let digits: &[u8] = params.split(|&b| b == b';' || b == b':').next()?;
    if digits.is_empty() || !digits.iter().all(u8::is_ascii_digit) {
        return None;
    }
    std::str::from_utf8(digits).ok()?.parse().ok()
}

/// Is this complete escape sequence a request the terminal would answer?
fn is_query(seq: &[u8], kind: EscKind) -> bool {
    match kind {
        EscKind::Csi => {
            // A CSI aborted right after `ESC [` (by a control byte, ESC or a
            // high byte) is two bytes long: no final byte, never a query.
            if seq.len() < 3 {
                return false;
            }
            let fin = seq[seq.len() - 1];
            let body = &seq[2..seq.len() - 1];
            match fin {
                // DSR (5n status, 6n / ?6n cursor position, ...).
                b'n' => true,
                // DA1 / DA2 / DA3.
                b'c' => true,
                // DECRQM: CSI ? Ps $ p / CSI Ps $ p.
                b'p' => body.last() == Some(&b'$'),
                // XTVERSION: CSI > q.
                b'q' => body.first() == Some(&b'>'),
                // Kitty keyboard flags query: CSI ? u.
                b'u' => body == b"?",
                _ => false,
            }
        }
        // Color queries: OSC 4;n;? / 10;? / 11;? / 12;? ... (payload ends in '?').
        EscKind::Osc => {
            let payload = osc_payload(seq);
            payload.last() == Some(&b'?')
        }
        // DECRQSS (DCS $ q ...) and XTGETTCAP (DCS + q ...).
        EscKind::Dcs => {
            let p = &seq[2..];
            p.starts_with(b"$q") || p.starts_with(b"+q")
        }
        _ => false,
    }
}

fn osc_payload(seq: &[u8]) -> &[u8] {
    let mut end = seq.len();
    if seq.ends_with(b"\x1b\\") {
        end -= 2;
    } else if matches!(seq.last(), Some(&BEL) | Some(&CAN) | Some(&SUB)) {
        end -= 1;
    }
    &seq[2.min(end)..end]
}

/// Remove terminal queries (DSR, DA, DECRQM, XTVERSION, kitty-flags, OSC color
/// queries, DECRQSS/XTGETTCAP) from replayed output. Everything else, including
/// incomplete trailing sequences, is passed through unchanged.
pub fn filter_queries(input: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(input.len());
    let mut i = 0;
    let mut copied = 0;
    while let Some(off) = input[i..].iter().position(|&b| b == ESC) {
        let at = i + off;
        match scan_escape(&input[at..]) {
            EscScan::Complete { len, kind } => {
                if is_query(&input[at..at + len], kind) {
                    out.extend_from_slice(&input[copied..at]);
                    copied = at + len;
                }
                i = at + len.max(1);
            }
            EscScan::Incomplete => break,
        }
    }
    out.extend_from_slice(&input[copied..]);
    out
}

/// If `b` ends with an unfinished short escape sequence, return the index of
/// its ESC so a caller can cut the chunk before it. Only the last 64 bytes are
/// examined: queries are short, and long strings (OSC 52, hyperlinks) need not
/// be kept whole for filtering purposes.
pub fn incomplete_tail_start(b: &[u8]) -> Option<usize> {
    let from = b.len().saturating_sub(64);
    let rel = b[from..].iter().rposition(|&c| c == ESC)?;
    let at = from + rel;
    match scan_escape(&b[at..]) {
        EscScan::Incomplete => Some(at),
        EscScan::Complete { .. } => None,
    }
}

/// Streaming detector for the cursor position request `ESC [ 6 n`, robust to
/// the sequence being split across reads.
#[derive(Debug, Default, Clone)]
pub struct CprScanner {
    state: u8,
}

impl CprScanner {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed the next chunk; returns how many complete requests it finished.
    pub fn feed(&mut self, data: &[u8]) -> usize {
        let mut count = 0;
        for &b in data {
            self.state = match (self.state, b) {
                (_, ESC) => 1,
                (1, b'[') => 2,
                (2, b'6') => 3,
                (3, b'n') => {
                    count += 1;
                    0
                }
                _ => 0,
            };
        }
        count
    }
}

/// Count `ESC[6n` occurrences in a self-contained buffer.
pub fn count_cpr(data: &[u8]) -> usize {
    CprScanner::new().feed(data)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scan_csi_osc_dcs_simple() {
        assert_eq!(scan_escape(b"\x1b[31mX"), EscScan::Complete { len: 5, kind: EscKind::Csi });
        assert_eq!(scan_escape(b"\x1b[?25l"), EscScan::Complete { len: 6, kind: EscKind::Csi });
        assert_eq!(scan_escape(b"\x1b[1;2"), EscScan::Incomplete);
        assert_eq!(scan_escape(b"\x1b]0;title\x07rest"), EscScan::Complete { len: 10, kind: EscKind::Osc });
        assert_eq!(scan_escape(b"\x1b]0;title\x1b\\"), EscScan::Complete { len: 11, kind: EscKind::Osc });
        assert_eq!(scan_escape(b"\x1b]0;tit"), EscScan::Incomplete);
        assert_eq!(scan_escape(b"\x1bP$qm\x1b\\"), EscScan::Complete { len: 7, kind: EscKind::Dcs });
        assert_eq!(scan_escape(b"\x1b(B"), EscScan::Complete { len: 3, kind: EscKind::Simple });
        assert_eq!(scan_escape(b"\x1b7"), EscScan::Complete { len: 2, kind: EscKind::Simple });
        assert_eq!(scan_escape(b"\x1b"), EscScan::Incomplete);
    }

    #[test]
    fn strip_removes_all_sequence_kinds() {
        let raw = b"\x1b[?25l\x1b[2J\x1b[H\x1b]0;C:\\WINDOWS\\system32\x07\x1b[32mgreen\x1b[0m text\x1bP1$r0m\x1b\\\x1b(B\x1b=end";
        assert_eq!(strip_ansi(raw), "green textend");
    }

    #[test]
    fn strip_osc_with_st_and_hyperlink() {
        let raw = b"a\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\b";
        assert_eq!(strip_ansi(raw), "alinkb");
    }

    #[test]
    fn strip_normalizes_line_endings() {
        assert_eq!(strip_ansi(b"one\r\ntwo\r\r\nthree\rfour\n"), "one\ntwo\nthree\nfour\n");
    }

    #[test]
    fn strip_drops_controls_keeps_tabs_and_utf8() {
        assert_eq!(strip_ansi("a\x07b\x08c\td\u{00e9}\u{1F600}".as_bytes()), "abc\td\u{00e9}\u{1F600}");
        // Invalid UTF-8 is replaced, not dropped silently.
        assert_eq!(strip_ansi(b"x\xffy"), "x\u{FFFD}y");
    }

    #[test]
    fn strip_expands_cursor_forward() {
        assert_eq!(strip_ansi(b"hello\x1b[3Cworld\x1b[Cx"), "hello   world x");
    }

    #[test]
    fn strip_truncated_trailing_sequence() {
        assert_eq!(strip_ansi(b"done\x1b[3"), "done");
        assert_eq!(strip_ansi(b"done\x1b]0;unterminated"), "done");
    }

    #[test]
    fn filter_removes_queries_only() {
        let raw = b"a\x1b[6nb\x1b[cc\x1b[>0cd\x1b[?2026$pe\x1b[>qf\x1b[?ug\x1b]11;?\x07h\x1bP$qm\x1b\\i\x1b[31mj\x1b]0;t\x07k";
        assert_eq!(filter_queries(raw), b"abcdefghi\x1b[31mj\x1b]0;t\x07k".to_vec());
    }

    #[test]
    fn filter_survives_aborted_csi() {
        // `ESC [` followed by ESC / a control byte / a high byte scans as a
        // 2-byte CSI; classifying it used to slice `seq[2..1]` and panic.
        assert_eq!(filter_queries(b"a\x1b[\x1b[6nb"), b"a\x1b[b".to_vec());
        assert_eq!(filter_queries(b"a\x1b[\x07b"), b"a\x1b[\x07b".to_vec());
        assert_eq!(filter_queries(b"a\x1b[\xffb"), b"a\x1b[\xffb".to_vec());
        assert_eq!(filter_queries(b"\x1b[\r\n"), b"\x1b[\r\n".to_vec());
        // Every 3-byte prefix `ESC [ x` must be handled without panicking.
        for x in 0..=255u8 {
            let _ = filter_queries(&[b'z', ESC, b'[', x, b'z']);
            let _ = strip_ansi(&[b'z', ESC, b'[', x, b'z']);
        }
    }

    #[test]
    fn filter_passes_incomplete_tail() {
        assert_eq!(filter_queries(b"x\x1b[6nx\x1b[6"), b"xx\x1b[6".to_vec());
    }

    #[test]
    fn incomplete_tail_detection() {
        assert_eq!(incomplete_tail_start(b"abc\x1b[6"), Some(3));
        assert_eq!(incomplete_tail_start(b"abc\x1b[6n"), None);
        assert_eq!(incomplete_tail_start(b"abc"), None);
        assert_eq!(incomplete_tail_start(b"abc\x1b"), Some(3));
    }

    #[test]
    fn cpr_scanner_across_split_reads() {
        let mut s = CprScanner::new();
        assert_eq!(s.feed(b"hello\x1b"), 0);
        assert_eq!(s.feed(b"["), 0);
        assert_eq!(s.feed(b"6"), 0);
        assert_eq!(s.feed(b"n world"), 1);
        assert_eq!(s.feed(b"\x1b[6n\x1b[6n"), 2);
        // Near-misses do not count.
        assert_eq!(s.feed(b"\x1b[?6n\x1b[16n\x1b[6m\x1b6n"), 0);
        // A broken prefix followed by a real request.
        assert_eq!(s.feed(b"\x1b[\x1b[6n"), 1);
        assert_eq!(count_cpr(b"\x1b[6n..\x1b[6n"), 2);
    }
}
