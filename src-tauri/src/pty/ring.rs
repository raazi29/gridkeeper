//! Bounded byte ring addressed by absolute stream offsets.
//!
//! Every byte the PTY ever produced has a unique, monotonically increasing
//! `u64` offset. The ring keeps the most recent `capacity` bytes, i.e. the
//! half-open range `[start, end)`. Readers (the output pump, replay, text
//! export) address data by absolute offset, so they can tell whether the data
//! they want has already been dropped (`offset < start`).

use std::collections::VecDeque;

pub struct Ring {
    buf: VecDeque<u8>,
    cap: usize,
    /// Absolute offset of `buf[0]`.
    start: u64,
    /// True once bytes were dropped because the ring overflowed. In that case
    /// `start` is an arbitrary cut point (possibly inside an escape sequence or
    /// a UTF-8 code point) and replay should begin at a line boundary instead.
    trimmed: bool,
}

impl Ring {
    pub fn new(capacity: usize) -> Self {
        Self { buf: VecDeque::new(), cap: capacity.max(1), start: 0, trimmed: false }
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub fn capacity(&self) -> usize {
        self.cap
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub fn len(&self) -> usize {
        self.buf.len()
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub fn is_empty(&self) -> bool {
        self.buf.is_empty()
    }

    /// Absolute offset of the oldest retained byte.
    pub fn start(&self) -> u64 {
        self.start
    }

    /// Absolute offset one past the newest byte (= total bytes ever pushed).
    pub fn end(&self) -> u64 {
        self.start + self.buf.len() as u64
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub fn was_trimmed(&self) -> bool {
        self.trimmed
    }

    /// Append bytes, dropping the oldest data when over capacity.
    pub fn push(&mut self, data: &[u8]) {
        if data.is_empty() {
            return;
        }
        if data.len() >= self.cap {
            // The new chunk alone fills the ring: keep only its tail.
            let skip = data.len() - self.cap;
            self.start = self.end() + skip as u64;
            self.buf.clear();
            self.grow_for(self.cap);
            self.buf.extend(&data[skip..]);
            self.trimmed = true;
            return;
        }
        let overflow = (self.buf.len() + data.len()).saturating_sub(self.cap);
        if overflow > 0 {
            self.buf.drain(..overflow);
            self.start += overflow as u64;
            self.trimmed = true;
        }
        self.grow_for(self.buf.len() + data.len());
        self.buf.extend(data);
    }

    /// Grow the allocation geometrically but never beyond `cap`, so a session's
    /// memory is bounded by its configured buffer size rather than the next
    /// power of two above it. Small sessions never allocate the full buffer.
    fn grow_for(&mut self, needed: usize) {
        let have = self.buf.capacity();
        if have >= needed {
            return;
        }
        let target = (have.saturating_mul(2)).max(needed).max(4096).min(self.cap).max(needed);
        self.buf.reserve_exact(target - self.buf.len());
    }

    /// Drop all retained bytes. Offsets stay monotonic (`start` jumps to `end`),
    /// and the new start is a deliberate, clean boundary.
    pub fn clear(&mut self) {
        self.start = self.end();
        self.buf.clear();
        self.buf.shrink_to(0);
        self.trimmed = false;
    }

    /// Append up to `max` bytes starting at absolute offset `from` to `out`.
    /// Returns the number of bytes copied (0 if `from` is outside the ring).
    pub fn copy_into(&self, from: u64, max: usize, out: &mut Vec<u8>) -> usize {
        if from < self.start || from >= self.end() || max == 0 {
            return 0;
        }
        let rel = (from - self.start) as usize;
        let n = max.min(self.buf.len() - rel);
        let (a, b) = self.buf.as_slices();
        let mut remaining = n;
        let mut pos = rel;
        if pos < a.len() {
            let take = remaining.min(a.len() - pos);
            out.extend_from_slice(&a[pos..pos + take]);
            remaining -= take;
            pos = a.len();
        }
        if remaining > 0 {
            let bpos = pos - a.len();
            out.extend_from_slice(&b[bpos..bpos + remaining]);
        }
        n
    }

    /// Visit the retained bytes in `[from, to)` (clamped to the ring) as up to
    /// two contiguous slices, in order.
    pub fn for_each_slice(&self, from: u64, to: u64, mut f: impl FnMut(&[u8])) {
        let from = from.max(self.start);
        let to = to.min(self.end());
        if from >= to {
            return;
        }
        let lo = (from - self.start) as usize;
        let hi = (to - self.start) as usize;
        let (a, b) = self.buf.as_slices();
        if lo < a.len() {
            f(&a[lo..hi.min(a.len())]);
        }
        if hi > a.len() {
            f(&b[lo.saturating_sub(a.len())..hi - a.len()]);
        }
    }

    /// Copy of everything retained.
    pub fn contents(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(self.buf.len());
        self.copy_into(self.start, self.buf.len(), &mut out);
        out
    }

    /// Where a replay should start: `start` if it is a clean boundary,
    /// otherwise just after the first `'\n'` so the terminal does not begin
    /// inside an escape sequence or multi-byte character. Falls back to
    /// `start` when the retained data contains no newline at all.
    pub fn replay_start(&self) -> u64 {
        if !self.trimmed {
            return self.start;
        }
        match self.buf.iter().position(|&b| b == b'\n') {
            Some(i) => self.start + i as u64 + 1,
            None => self.start,
        }
    }
}

impl Ring {
    /// Like [`Ring::replay_start`], but limited to (roughly) the newest
    /// `tail` bytes: starts after the first newline at or beyond `end - tail`.
    /// Used when a view fell behind, so the replay does not start at the
    /// oldest edge that the producer is about to overwrite.
    pub fn replay_start_within(&self, tail: usize) -> u64 {
        let from = self.end().saturating_sub(tail as u64).max(self.start);
        if from == self.start {
            return self.replay_start();
        }
        let rel = (from - self.start) as usize;
        match self.buf.range(rel..).position(|&b| b == b'\n') {
            Some(i) => from + i as u64 + 1,
            None => from,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn collect(r: &Ring, from: u64, max: usize) -> Vec<u8> {
        let mut v = Vec::new();
        r.copy_into(from, max, &mut v);
        v
    }

    #[test]
    fn push_within_capacity() {
        let mut r = Ring::new(16);
        r.push(b"hello");
        r.push(b" world");
        assert_eq!(r.start(), 0);
        assert_eq!(r.end(), 11);
        assert_eq!(r.contents(), b"hello world");
        assert!(!r.was_trimmed());
        assert_eq!(r.replay_start(), 0);
    }

    #[test]
    fn trims_oldest_and_tracks_offsets() {
        let mut r = Ring::new(8);
        r.push(b"abcdef");
        r.push(b"ghij");
        assert_eq!(r.len(), 8);
        assert_eq!(r.start(), 2);
        assert_eq!(r.end(), 10);
        assert_eq!(r.contents(), b"cdefghij");
        assert!(r.was_trimmed());
        // Data before start is gone.
        assert_eq!(collect(&r, 1, 4), b"");
        assert_eq!(collect(&r, 2, 3), b"cde");
        assert_eq!(collect(&r, 8, 100), b"ij");
        assert_eq!(collect(&r, 10, 100), b"");
    }

    #[test]
    fn oversized_chunk_keeps_tail() {
        let mut r = Ring::new(4);
        r.push(b"xy");
        r.push(b"0123456789");
        assert_eq!(r.contents(), b"6789");
        assert_eq!(r.start(), 8);
        assert_eq!(r.end(), 12);
        assert!(r.capacity() >= 4);
    }

    #[test]
    fn wraparound_copy_across_slices() {
        let mut r = Ring::new(10);
        // Force the VecDeque to wrap internally by repeatedly trimming.
        for i in 0..50u8 {
            r.push(&[b'a' + (i % 26), b'-', b'0' + (i % 10)]);
            let all = r.contents();
            assert_eq!(all.len(), r.len());
            // Every sub-range copy must agree with the contiguous copy.
            for off in 0..r.len() {
                let got = collect(&r, r.start() + off as u64, 4);
                let want = &all[off..(off + 4).min(all.len())];
                assert_eq!(got, want);
            }
            let mut via_slices = Vec::new();
            r.for_each_slice(r.start() + 1, r.end() - 1, |s| via_slices.extend_from_slice(s));
            assert_eq!(via_slices, &all[1..all.len() - 1]);
        }
        assert_eq!(r.end(), 150);
        assert_eq!(r.start(), 140);
    }

    #[test]
    fn replay_starts_after_first_newline_when_trimmed() {
        let mut r = Ring::new(10);
        r.push(b"xxxxx\x1b[31mred\nline2\n");
        assert!(r.was_trimmed());
        let start = r.replay_start();
        assert_eq!(collect(&r, start, 100), b"line2\n");
        // No newline at all: fall back to start.
        let mut r = Ring::new(4);
        r.push(b"abcdefgh");
        assert_eq!(r.replay_start(), r.start());
    }

    #[test]
    fn replay_within_tail() {
        let mut r = Ring::new(64);
        r.push(b"aaaa\nbbbb\ncccc\ndddd\n");
        // Whole ring fits in the tail: same as replay_start (untrimmed => start).
        assert_eq!(r.replay_start_within(1000), 0);
        // Newest 8 bytes are "cc\ndddd\n": replay starts at "dddd".
        let s = r.replay_start_within(8);
        assert_eq!(collect(&r, s, 100), b"dddd\n");
    }

    #[test]
    fn clear_keeps_offsets_monotonic() {
        let mut r = Ring::new(8);
        r.push(b"0123456789");
        r.clear();
        assert!(r.is_empty());
        assert_eq!(r.start(), 10);
        assert_eq!(r.end(), 10);
        assert!(!r.was_trimmed());
        r.push(b"ab");
        assert_eq!(r.start(), 10);
        assert_eq!(r.end(), 12);
        assert_eq!(r.replay_start(), 10);
        assert_eq!(collect(&r, 10, 5), b"ab");
    }

    #[test]
    fn allocation_never_exceeds_capacity_by_much() {
        let mut r = Ring::new(100_000);
        for _ in 0..1000 {
            r.push(&[0u8; 1500]);
        }
        assert_eq!(r.len(), 100_000);
        // VecDeque may round up slightly but must not double past the cap.
        assert!(r.buf.capacity() < 150_000, "capacity {}", r.buf.capacity());
    }
}
