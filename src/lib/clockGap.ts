// Wall-clock gap detection for sleep / long-absence recovery (pure; unit-tested).

/** A gap longer than this between "window went away" and "window came back" triggers a resync. */
export const RESUME_GAP_MS = 60_000;

/** True when `now - last` exceeds the threshold, or the clock moved backwards (manual/NTP change). */
export function isLongGap(last: number, now: number, threshold = RESUME_GAP_MS): boolean {
  return now - last > threshold || now < last;
}
