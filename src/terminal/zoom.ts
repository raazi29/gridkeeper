// Per-pane font zoom (pure; unit-tested). The zoom is a font-size offset on top of the Settings font size,
// so changing the global size keeps each pane's relative zoom.

/** Same bounds as Settings › Terminal › Font size. */
export const ZOOM_MIN_FONT = 8;
export const ZOOM_MAX_FONT = 32;
export const ZOOM_STEP = 1;

/** Offset clamped so that base + offset stays within the font bounds. */
export function clampZoom(base: number, delta: number): number {
  if (!Number.isFinite(base) || !Number.isFinite(delta)) return 0;
  const size = Math.min(ZOOM_MAX_FONT, Math.max(ZOOM_MIN_FONT, base + delta));
  return Math.round((size - base) * 100) / 100;
}

/** Next offset for zoom in (1), out (-1) or reset (0). */
export function zoomStep(base: number, delta: number, dir: 1 | -1 | 0): number {
  if (dir === 0) return 0;
  return clampZoom(base, clampZoom(base, delta) + dir * ZOOM_STEP);
}
