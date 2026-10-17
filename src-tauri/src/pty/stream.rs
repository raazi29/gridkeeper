//! Output side of a session: the replay ring, the attachment state, and the
//! pump that streams coalesced binary frames to the frontend with
//! ack-based flow control.
//!
//! Threading model
//! ---------------
//! * The session's reader thread calls [`Output::ingest`]. It only appends to
//!   the ring under a short lock and (sometimes) signals the condvar; it never
//!   waits on the frontend, so a slow, hidden or detached view can never stall
//!   the child process.
//! * Each attachment gets its own pump thread ("pty-pump-<id>"), tagged with a
//!   generation number. Re-attaching bumps the generation, which makes the
//!   previous pump exit on its next wake-up. A per-attachment thread (rather
//!   than one shared pump) keeps a slow `Channel::send` for one session from
//!   delaying every other session, needs no scheduler/timer wheel, and costs
//!   nothing while idle: an idle pump is parked on the condvar with no timeout,
//!   so there are no periodic wake-ups.
//!
//! Coalescing and flow control
//! ---------------------------
//! A frame is flushed when at least [`FLUSH_BYTES`] are pending or
//! [`FLUSH_DELAY`] has passed since the oldest unsent byte arrived. Frames
//! carry at most [`MAX_FRAME`] payload bytes. The pump counts DATA payload
//! bytes sent but not yet acknowledged via [`Output::ack`]; it stops at
//! [`HIGH_WATER`] and resumes once the backlog drops to [`LOW_WATER`]. If the
//! view falls so far behind that its next byte has been dropped from the ring,
//! the pump sends RESET and replays from the ring's tail boundary.
//!
//! Terminal queries and CPR
//! ------------------------
//! ConPTY (portable-pty always passes `PSEUDOCONSOLE_INHERIT_CURSOR`) asks the
//! host for the cursor position (`ESC[6n`) at startup and may block until it is
//! answered; TUIs also query it. Invariant maintained here: every `ESC[6n` is
//! answered exactly once — by xterm.js if the bytes are delivered *live*, by
//! Rust (`ESC[1;1R`, via the responder) otherwise. Bytes below `filter_upto`
//! were either already answered by Rust or are replay; they are sent with all
//! terminal queries removed ([`filter_queries`]) so a newly attached terminal
//! does not inject stale responses into the child's input.

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use parking_lot::{Condvar, Mutex, MutexGuard};

use super::ring::Ring;
use super::text::{CprScanner, filter_queries, incomplete_tail_start};
use crate::types::frame;

/// Flush as soon as this many bytes are pending.
pub const FLUSH_BYTES: u64 = 64 * 1024;
/// Otherwise flush this long after the oldest unsent byte arrived.
pub const FLUSH_DELAY: Duration = Duration::from_millis(8);
/// Maximum DATA payload per frame.
pub const MAX_FRAME: usize = 64 * 1024;
/// Stop sending while more than this many payload bytes are unacknowledged.
pub const HIGH_WATER: u64 = 1024 * 1024;
/// Resume once the unacknowledged backlog is at or below this.
pub const LOW_WATER: u64 = 256 * 1024;

/// The receiver of an [`OutputSink`] is gone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SinkClosed;

/// Receives binary frames (`[frame::DATA | frame::RESET, payload...]`).
pub trait OutputSink: Send + 'static {
    /// Deliver one frame. An error means the receiver is gone; the attachment
    /// is then treated as detached.
    fn send_frame(&mut self, frame: Vec<u8>) -> Result<(), SinkClosed>;
}

impl<F> OutputSink for F
where
    F: FnMut(Vec<u8>) -> Result<(), SinkClosed> + Send + 'static,
{
    fn send_frame(&mut self, frame: Vec<u8>) -> Result<(), SinkClosed> {
        self(frame)
    }
}

/// Called with a count of cursor-position requests Rust must answer.
pub type CprResponder = Box<dyn Fn(usize) + Send + Sync>;

pub struct Output {
    st: Mutex<OutState>,
    cv: Condvar,
    bytes_out: AtomicU64,
    cpr: CprResponder,
    label: String,
}

struct OutState {
    ring: Ring,
    /// Generation of the current attachment (bumped on attach/detach/close).
    generation: u64,
    /// A pump of generation `generation` is live.
    attached: bool,
    /// Next absolute offset to send to the attached view.
    send_off: u64,
    /// Bytes below this offset are sent with terminal queries stripped.
    filter_upto: u64,
    /// DATA payload bytes sent but not yet acknowledged.
    unacked: u64,
    /// Flow-control pause (hysteresis between HIGH_WATER and LOW_WATER).
    paused: bool,
    /// Arrival time of the oldest unsent byte.
    first_pending: Option<Instant>,
    /// Time of the last ingest (used to let ConPTY drain on exit).
    last_ingest: Instant,
    /// Reader reached EOF / error: no more output will arrive.
    eof: bool,
    /// Session removed or replaced: pumps must exit, attach is refused.
    closed: bool,
}

impl OutState {
    fn pending(&self) -> u64 {
        self.ring.end().saturating_sub(self.send_off)
    }
}

impl Output {
    pub fn new(capacity: usize, label: impl Into<String>, cpr: CprResponder) -> Self {
        Self {
            st: Mutex::new(OutState {
                ring: Ring::new(capacity),
                generation: 0,
                attached: false,
                send_off: 0,
                filter_upto: 0,
                unacked: 0,
                paused: false,
                first_pending: None,
                last_ingest: Instant::now(),
                eof: false,
                closed: false,
            }),
            cv: Condvar::new(),
            bytes_out: AtomicU64::new(0),
            cpr,
            label: label.into(),
        }
    }

    /// Total bytes received from the PTY.
    pub fn bytes_out(&self) -> u64 {
        self.bytes_out.load(Ordering::Relaxed)
    }

    /// Reader side: append a chunk. `cprs` is how many `ESC[6n` requests the
    /// reader's streaming scanner completed inside this chunk.
    pub fn ingest(&self, data: &[u8], cprs: usize) {
        if data.is_empty() {
            return;
        }
        self.bytes_out.fetch_add(data.len() as u64, Ordering::Relaxed);
        let now = Instant::now();
        let answer;
        {
            let mut st = self.st.lock();
            let before = st.pending();
            st.ring.push(data);
            st.last_ingest = now;
            // Nobody will answer live: no view, or the view is flow-controlled
            // and these bytes may only be delivered much later.
            answer = cprs > 0 && (!st.attached || st.paused);
            if answer {
                st.filter_upto = st.ring.end();
            }
            if st.attached {
                if before == 0 {
                    st.first_pending = Some(now);
                }
                let after = st.pending();
                if before == 0 || (before < FLUSH_BYTES && after >= FLUSH_BYTES) {
                    self.cv.notify_all();
                }
            }
        }
        if answer {
            (self.cpr)(cprs);
        }
    }

    /// Reader side: no more data will arrive.
    pub fn mark_eof(&self) {
        let mut st = self.st.lock();
        st.eof = true;
        self.cv.notify_all();
    }

    /// Block until EOF or `timeout`; returns whether EOF was reached.
    pub fn wait_eof(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        let mut st = self.st.lock();
        while !st.eof {
            if self.cv.wait_until(&mut st, deadline).timed_out() {
                break;
            }
        }
        st.eof
    }

    /// Block until no output has arrived for `idle`, EOF, or `max` elapsed.
    pub fn wait_quiet(&self, idle: Duration, max: Duration) {
        let deadline = Instant::now() + max;
        let mut st = self.st.lock();
        loop {
            let now = Instant::now();
            if st.eof || now >= deadline || now.duration_since(st.last_ingest) >= idle {
                return;
            }
            let until = (st.last_ingest + idle).min(deadline);
            self.cv.wait_until(&mut st, until);
        }
    }

    /// Plain copy of the retained output.
    pub fn contents(&self) -> Vec<u8> {
        self.st.lock().ring.contents()
    }

    /// Copy of (roughly) the newest `max` bytes, starting at a line boundary
    /// when there is one, so plain-text export does not begin mid-sequence.
    pub fn tail(&self, max: usize) -> Vec<u8> {
        let st = self.st.lock();
        let from = st.ring.replay_start_within(max);
        let mut out = Vec::with_capacity(max.min(st.ring.len()));
        st.ring.for_each_slice(from, st.ring.end(), |s| out.extend_from_slice(s));
        out
    }

    /// Answer (and mark as filtered) every CPR in bytes that were destined for
    /// live delivery but will not be delivered live after all.
    fn settle_undelivered(&self, st: &mut OutState) {
        let from = st.send_off.max(st.filter_upto).max(st.ring.start());
        let to = st.ring.end();
        let mut scanner = CprScanner::new();
        let mut n = 0;
        st.ring.for_each_slice(from, to, |s| n += scanner.feed(s));
        st.filter_upto = st.filter_upto.max(to);
        if n > 0 {
            // Non-blocking (queues to the writer thread).
            (self.cpr)(n);
        }
    }

    /// Attach a new sink, replacing any existing one. A RESET frame, the
    /// replay of the ring, and then live output are sent to it.
    pub fn attach(self: &Arc<Self>, sink: Box<dyn OutputSink>) -> std::io::Result<()> {
        let generation = {
            let mut st = self.st.lock();
            if st.closed {
                return Err(std::io::Error::new(std::io::ErrorKind::NotConnected, "session closed"));
            }
            if st.attached {
                self.settle_undelivered(&mut st);
            }
            st.generation += 1;
            st.attached = true;
            st.unacked = 0;
            st.paused = false;
            st.send_off = st.ring.replay_start();
            st.filter_upto = st.ring.end();
            st.first_pending = None;
            self.cv.notify_all();
            st.generation
        };
        let out = Arc::clone(self);
        let spawned = std::thread::Builder::new().name(format!("pty-pump-{}", self.label)).spawn(move || {
            let out2 = Arc::clone(&out);
            if let Err(p) = catch_unwind(AssertUnwindSafe(move || out2.pump(generation, sink))) {
                tracing::error!(session = %out.label, panic = %super::panic_message(&p), "output pump panicked");
            }
            out.pump_ended(generation);
        });
        if let Err(e) = spawned {
            self.pump_ended(generation);
            return Err(e);
        }
        Ok(())
    }

    /// Drop the current sink (no-op if none).
    pub fn detach(&self) {
        let mut st = self.st.lock();
        if st.attached {
            self.settle_undelivered(&mut st);
            st.attached = false;
        }
        st.generation += 1;
        self.cv.notify_all();
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub fn is_attached(&self) -> bool {
        self.st.lock().attached
    }

    /// The view finished processing `n` more DATA payload bytes.
    pub fn ack(&self, n: u64) {
        let mut st = self.st.lock();
        st.unacked = st.unacked.saturating_sub(n);
        if st.paused && st.unacked <= LOW_WATER {
            self.cv.notify_all();
        }
    }

    /// Empty the ring (offsets stay monotonic). Undelivered bytes for an
    /// attached view are discarded with it.
    pub fn clear(&self) {
        let mut st = self.st.lock();
        if st.attached {
            self.settle_undelivered(&mut st);
        }
        st.ring.clear();
        let end = st.ring.end();
        st.send_off = st.send_off.max(end);
        st.filter_upto = st.filter_upto.max(end);
        st.first_pending = None;
    }

    /// The session is gone: stop pumps and refuse further attaches.
    pub fn close(&self) {
        let mut st = self.st.lock();
        st.closed = true;
        st.attached = false;
        st.generation += 1;
        self.cv.notify_all();
    }

    /// Called when the pump of generation `generation` exits for any reason
    /// (stale generation, send error, panic).
    fn pump_ended(&self, generation: u64) {
        let mut st = self.st.lock();
        if st.generation == generation && st.attached {
            self.settle_undelivered(&mut st);
            st.attached = false;
            tracing::debug!(session = %self.label, "output channel closed; treating as detached");
        }
    }

    fn send(
        &self,
        st: &mut MutexGuard<'_, OutState>,
        sink: &mut dyn OutputSink,
        frame: Vec<u8>,
    ) -> Result<(), SinkClosed> {
        MutexGuard::unlocked(st, || sink.send_frame(frame))
    }

    fn pump(&self, generation: u64, mut sink: Box<dyn OutputSink>) {
        let mut st = self.st.lock();
        if st.generation != generation || st.closed {
            return;
        }
        if self.send(&mut st, sink.as_mut(), vec![frame::RESET]).is_err() {
            return;
        }
        // True while no DATA has been sent since the last RESET.
        let mut just_reset = true;
        loop {
            if st.closed || st.generation != generation {
                return;
            }

            // Fell behind: the next byte for this view was dropped from the
            // ring (or the ring was cleared). Restart the view from the newer
            // half of the ring so the replay has headroom before the producer
            // laps it again, and send at most one RESET until data follows
            // (otherwise a fast producer could cause a RESET storm).
            if st.send_off < st.ring.start() {
                self.settle_undelivered(&mut st);
                let half = st.ring.len() / 2;
                st.send_off = st.ring.replay_start_within(half);
                st.filter_upto = st.ring.end();
                st.first_pending = None;
                if !just_reset {
                    tracing::debug!(session = %self.label, "view fell behind the ring; resetting");
                    just_reset = true;
                    // A view may discard queued writes on RESET and never ack
                    // them; start a fresh window (late acks saturate at 0).
                    st.unacked = 0;
                    st.paused = false;
                    if self.send(&mut st, sink.as_mut(), vec![frame::RESET]).is_err() {
                        return;
                    }
                }
                continue;
            }

            let pending = st.pending();
            if pending == 0 {
                st.first_pending = None;
                self.cv.wait(&mut st);
                continue;
            }
            if st.paused {
                if st.unacked > LOW_WATER {
                    self.cv.wait(&mut st);
                    continue;
                }
                st.paused = false;
            }
            if st.unacked >= HIGH_WATER {
                st.paused = true;
                // Pending bytes may now be delivered arbitrarily late.
                self.settle_undelivered(&mut st);
                self.cv.wait(&mut st);
                continue;
            }

            let now = Instant::now();
            let first = *st.first_pending.get_or_insert(now);
            let filtered = st.send_off < st.filter_upto;
            let due = pending >= FLUSH_BYTES || filtered || st.eof || now >= first + FLUSH_DELAY;
            if !due {
                self.cv.wait_until(&mut st, first + FLUSH_DELAY);
                continue;
            }

            let chunk_start = st.send_off;
            let mut take = pending.min(MAX_FRAME as u64) as usize;
            if filtered {
                take = take.min((st.filter_upto - chunk_start) as usize);
            }
            let mut frame_buf = Vec::with_capacity(take + 1);
            frame_buf.push(frame::DATA);
            take = st.ring.copy_into(chunk_start, take, &mut frame_buf);
            if filtered {
                // Do not split a query across two filtered chunks.
                if chunk_start + (take as u64) < st.filter_upto
                    && let Some(cut) = incomplete_tail_start(&frame_buf[1..])
                    && cut > 0
                {
                    frame_buf.truncate(1 + cut);
                    take = cut;
                }
                let clean = filter_queries(&frame_buf[1..]);
                frame_buf.truncate(1);
                frame_buf.extend_from_slice(&clean);
            }
            st.send_off = chunk_start + take as u64;
            if st.pending() == 0 {
                st.first_pending = None;
            }
            let payload = (frame_buf.len() - 1) as u64;
            if payload == 0 {
                continue;
            }
            st.unacked += payload;
            just_reset = false;
            if self.send(&mut st, sink.as_mut(), frame_buf).is_err() {
                // The frame was not delivered: rewind so pump_ended settles
                // any CPR it contained (filtered chunks are already settled).
                if st.generation == generation {
                    st.send_off = chunk_start;
                }
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use std::sync::mpsc;

    struct Harness {
        out: Arc<Output>,
        cprs: Arc<AtomicUsize>,
    }

    fn harness(cap: usize) -> Harness {
        let cprs = Arc::new(AtomicUsize::new(0));
        let c = cprs.clone();
        let out = Arc::new(Output::new(
            cap,
            "test",
            Box::new(move |n| {
                c.fetch_add(n, Ordering::SeqCst);
            }),
        ));
        Harness { out, cprs }
    }

    fn channel_sink() -> (Box<dyn OutputSink>, mpsc::Receiver<Vec<u8>>) {
        let (tx, rx) = mpsc::channel();
        (Box::new(move |f: Vec<u8>| tx.send(f).map_err(|_| SinkClosed)), rx)
    }

    /// Collect frames until `pred(data_so_far)` or timeout.
    fn collect_until(rx: &mpsc::Receiver<Vec<u8>>, mut pred: impl FnMut(&[Vec<u8>]) -> bool) -> Vec<Vec<u8>> {
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut frames = Vec::new();
        while !pred(&frames) {
            let left = deadline.saturating_duration_since(Instant::now());
            match rx.recv_timeout(left) {
                Ok(f) => frames.push(f),
                Err(_) => break,
            }
        }
        frames
    }

    fn data_of(frames: &[Vec<u8>]) -> Vec<u8> {
        let mut v = Vec::new();
        for f in frames {
            if f[0] == frame::DATA {
                v.extend_from_slice(&f[1..]);
            } else {
                v.clear();
            }
        }
        v
    }

    #[test]
    fn unattached_cpr_is_answered_by_rust_and_filtered_on_replay() {
        let h = harness(1024);
        h.out.ingest(b"start\x1b[6nafter\n", 1);
        assert_eq!(h.cprs.load(Ordering::SeqCst), 1);
        let (sink, rx) = channel_sink();
        h.out.attach(sink).unwrap();
        let frames = collect_until(&rx, |f| data_of(f).len() >= 11);
        assert_eq!(frames[0], vec![frame::RESET]);
        assert_eq!(data_of(&frames), b"startafter\n");
        // Live output after attach is unfiltered (xterm.js answers it).
        h.out.ingest(b"live\x1b[6n", 1);
        let frames = collect_until(&rx, |f| data_of(f).len() >= 8);
        assert_eq!(data_of(&frames), b"live\x1b[6n");
        assert_eq!(h.cprs.load(Ordering::SeqCst), 1, "attached view answers live requests");
    }

    #[test]
    fn replay_with_aborted_csi_keeps_streaming() {
        // Replayed (filtered) bytes containing `ESC [ ESC` used to panic the
        // pump, silently detaching the view.
        let h = harness(1024);
        h.out.ingest(b"x\x1b[\x1b[6ny\n", 1);
        let (sink, rx) = channel_sink();
        h.out.attach(sink).unwrap();
        let frames = collect_until(&rx, |f| data_of(f).ends_with(b"y\n"));
        assert_eq!(data_of(&frames), b"x\x1b[y\n");
        h.out.ingest(b"live\n", 0);
        let frames = collect_until(&rx, |f| data_of(f).ends_with(b"live\n"));
        assert!(data_of(&frames).ends_with(b"live\n"));
        assert!(h.out.is_attached());
    }

    #[test]
    fn coalesces_small_writes() {
        let h = harness(1 << 20);
        let (sink, rx) = channel_sink();
        h.out.attach(sink).unwrap();
        assert_eq!(rx.recv_timeout(Duration::from_secs(2)).unwrap(), vec![frame::RESET]);
        for _ in 0..100 {
            h.out.ingest(b"x", 0);
        }
        let frames = collect_until(&rx, |f| data_of(f).len() >= 100);
        assert_eq!(data_of(&frames).len(), 100);
        assert!(frames.len() <= 5, "expected coalescing, got {} frames", frames.len());
    }

    #[test]
    fn flow_control_pauses_and_resumes() {
        let h = harness(16 << 20);
        let (sink, rx) = channel_sink();
        h.out.attach(sink).unwrap();
        let chunk = vec![b'a'; 32 * 1024];
        for _ in 0..128 {
            h.out.ingest(&chunk, 0); // 4 MiB total
        }
        // Without acks delivery stops near the high-water mark.
        std::thread::sleep(Duration::from_millis(300));
        let mut got: u64 = 0;
        while let Ok(f) = rx.try_recv() {
            if f[0] == frame::DATA {
                got += (f.len() - 1) as u64;
            }
        }
        assert!(got >= HIGH_WATER && got < HIGH_WATER + MAX_FRAME as u64, "sent {got} unacked bytes");
        // Acking below the low-water mark resumes the stream.
        h.out.ack(got);
        let deadline = Instant::now() + Duration::from_secs(5);
        let total = 4u64 << 20;
        while got < total && Instant::now() < deadline {
            if let Ok(f) = rx.recv_timeout(Duration::from_millis(200))
                && f[0] == frame::DATA
            {
                let n = (f.len() - 1) as u64;
                got += n;
                h.out.ack(n);
            }
        }
        assert_eq!(got, total);
    }

    #[test]
    fn fallen_behind_view_gets_reset_and_tail_replay() {
        let h = harness(64 * 1024);
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        // The view stalls inside its first DATA frame until released, so the
        // producer laps it deterministically.
        let (gate_tx, gate_rx) = mpsc::channel::<()>();
        let mut stalled = false;
        h.out
            .attach(Box::new(move |f: Vec<u8>| {
                if f[0] == frame::DATA && !stalled {
                    stalled = true;
                    let _ = gate_rx.recv();
                }
                tx.send(f).map_err(|_| SinkClosed)
            }))
            .unwrap();
        h.out.ingest(b"first\n", 0);
        std::thread::sleep(Duration::from_millis(50)); // pump is now stalled in send
        let mut line = Vec::new();
        for i in 0..50_000u32 {
            line.clear();
            line.extend_from_slice(format!("line {i}\n").as_bytes());
            h.out.ingest(&line, 0);
        }
        gate_tx.send(()).unwrap();
        let frames = collect_until(&rx, |f| data_of(f).ends_with(b"line 49999\n"));
        let resets = frames.iter().filter(|f| f[0] == frame::RESET).count();
        assert_eq!(resets, 2, "initial RESET + exactly one catch-up RESET");
        let data = data_of(&frames);
        assert!(data.starts_with(b"line "), "replay must start at a line boundary");
        assert!(data.ends_with(b"line 49999\n"));
        // Replay comes from the newer half of the ring.
        assert!(data.len() <= 32 * 1024 + 16, "replayed {} bytes", data.len());
    }

    #[test]
    fn reattach_replaces_old_sink_and_detach_stops() {
        let h = harness(4096);
        h.out.ingest(b"hello\n", 0);
        let (s1, rx1) = channel_sink();
        h.out.attach(s1).unwrap();
        collect_until(&rx1, |f| data_of(f) == b"hello\n");
        let (s2, rx2) = channel_sink();
        h.out.attach(s2).unwrap();
        let f2 = collect_until(&rx2, |f| data_of(f) == b"hello\n");
        assert_eq!(f2[0], vec![frame::RESET]);
        h.out.ingest(b"more\n", 0);
        collect_until(&rx2, |f| data_of(f).ends_with(b"more\n"));
        // The old pump exited: its receiver is disconnected (sink dropped).
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            match rx1.try_recv() {
                Err(mpsc::TryRecvError::Disconnected) => break,
                _ if Instant::now() > deadline => panic!("old pump still alive"),
                _ => std::thread::sleep(Duration::from_millis(10)),
            }
        }
        h.out.detach();
        assert!(!h.out.is_attached());
        // A CPR arriving while detached is answered by Rust.
        h.out.ingest(b"\x1b[6n", 1);
        assert_eq!(h.cprs.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn undelivered_cpr_is_settled_on_detach() {
        let h = harness(4096);
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        // A sink that blocks until told to proceed, so data stays undelivered.
        let (gate_tx, gate_rx) = mpsc::channel::<()>();
        h.out
            .attach(Box::new(move |f: Vec<u8>| {
                let _ = gate_rx.recv();
                tx.send(f).map_err(|_| SinkClosed)
            }))
            .unwrap();
        // Pump is blocked sending RESET; this CPR is pending, undelivered.
        h.out.ingest(b"\x1b[6n", 1);
        assert_eq!(h.cprs.load(Ordering::SeqCst), 0);
        h.out.detach();
        assert_eq!(h.cprs.load(Ordering::SeqCst), 1);
        drop(gate_tx);
        drop(rx);
    }

    #[test]
    fn send_error_marks_detached() {
        let h = harness(4096);
        h.out.attach(Box::new(|_f: Vec<u8>| Err(SinkClosed))).unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        while h.out.is_attached() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(!h.out.is_attached());
    }

    #[test]
    fn clear_discards_and_keeps_offsets() {
        let h = harness(4096);
        h.out.ingest(b"abc\n", 0);
        h.out.clear();
        assert!(h.out.contents().is_empty());
        h.out.ingest(b"def\n", 0);
        assert_eq!(h.out.contents(), b"def\n");
        assert_eq!(h.out.bytes_out(), 8);
    }
}
