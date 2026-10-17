// Flow-control ack batching (pure; no DOM / IPC imports so it is unit-testable in node).
//
// The backend stops streaming a session when more than ~1 MiB is unacknowledged. The frontend acks
// bytes only after xterm has PARSED them (write callback). Acking every chunk would mean one IPC call
// per frame, so parsed bytes are accumulated and flushed when either
//   - at least `threshold` bytes are pending (flush immediately), or
//   - `delayMs` elapsed since the last parse with something pending (trailing flush).

export interface AckBatcherOptions {
  /** Flush as soon as this many bytes are pending. Default 64 KiB. */
  threshold?: number;
  /** Trailing flush delay after the last parsed chunk. Default 30 ms. */
  delayMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export class AckBatcher {
  private pending = 0;
  private timer: unknown = null;
  private disposed = false;
  private readonly threshold: number;
  private readonly delayMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(
    private readonly send: (bytes: number) => void,
    opts: AckBatcherOptions = {},
  ) {
    this.threshold = opts.threshold ?? 64 * 1024;
    this.delayMs = opts.delayMs ?? 30;
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /** Record `bytes` as parsed. */
  add(bytes: number): void {
    if (this.disposed || bytes <= 0) return;
    this.pending += bytes;
    if (this.pending >= this.threshold) {
      this.flush();
      return;
    }
    this.cancelTimer();
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.flush();
    }, this.delayMs);
  }

  /** Send everything pending now. */
  flush(): void {
    this.cancelTimer();
    if (this.disposed || this.pending <= 0) return;
    const n = this.pending;
    this.pending = 0;
    this.send(n);
  }

  get pendingBytes(): number {
    return this.pending;
  }

  /** Drop pending acks (they belong to a channel that no longer exists) and ignore future adds. */
  dispose(): void {
    this.cancelTimer();
    this.pending = 0;
    this.disposed = true;
  }

  private cancelTimer() {
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }
}
