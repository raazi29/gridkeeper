// Mission Control canvas navigation, pure (unit-tested): zoom around a point, pan limits, fit to screen, reveal a
// box, screen <-> canvas coordinates, minimap mapping and rubber-band rectangles. The canvas is laid out at the
// viewport's width (100 % = the layout before zoom existed) and drawn with `translate(x, y) scale(k)` from its
// top-left corner, so a canvas point p is on screen at (x + p.x * k, y + p.y * k), relative to the viewport.

export interface View {
  x: number;
  y: number;
  k: number;
}

export interface Size {
  w: number;
  h: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 2;
/** Stops for the − / + buttons and keys. */
export const ZOOM_STEPS: readonly number[] = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
export const HOME: View = { x: 0, y: 0, k: 1 };

const round = (n: number, d = 1000) => Math.round(n * d) / d;

export function clampZoom(k: number): number {
  if (!Number.isFinite(k)) return 1;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, k));
}

/** Zoom to `k` keeping the canvas point under the viewport point (px, py) where it is. */
export function zoomAt(v: View, k: number, px: number, py: number): View {
  const nk = clampZoom(k);
  const cx = (px - v.x) / v.k;
  const cy = (py - v.y) / v.k;
  return { x: round(px - cx * nk), y: round(py - cy * nk), k: round(nk, 10000) };
}

/** Next stop up (dir 1) or down (dir -1) from `k` (a value between stops goes to the nearer stop that way). */
export function stepZoom(k: number, dir: 1 | -1): number {
  if (dir > 0) return ZOOM_STEPS.find((s) => s > k + 0.001) ?? ZOOM_MAX;
  for (let i = ZOOM_STEPS.length - 1; i >= 0; i--) if (ZOOM_STEPS[i] < k - 0.001) return ZOOM_STEPS[i];
  return ZOOM_MIN;
}

/**
 * Zoom factor for one wheel event (Ctrl/⌘ + wheel or a trackpad pinch, which Chromium reports as a Ctrl wheel).
 * Line / page deltas are scaled to pixels; one mouse notch (~100 px) is about ±10 %, a pinch is proportional.
 */
export function wheelZoomFactor(deltaY: number, deltaMode = 0): number {
  const px = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY;
  const d = Math.max(-300, Math.min(300, px));
  return Math.exp(-d * 0.001);
}

/**
 * Keep the canvas from leaving the viewport: at least `margin` px of it (or all of it when it is smaller) stay
 * visible on each axis. `content` is the canvas's layout size (before scaling).
 */
export function clampPan(v: View, content: Size, viewport: Size, margin = 96): View {
  const axis = (pos: number, len: number, span: number) => {
    const m = Math.min(margin, len, span);
    const lo = m - len; // content's far edge at least m px inside the left / top edge
    const hi = span - m; // content's near edge at least m px inside the right / bottom edge
    return Math.min(hi, Math.max(lo, pos));
  };
  const w = content.w * v.k;
  const h = content.h * v.k;
  return { x: round(axis(v.x, w, viewport.w)), y: round(axis(v.y, h, viewport.h)), k: v.k };
}

/** The whole canvas in view, centred, at most `maxK` (fit never magnifies a small canvas past 100 %). */
export function fitView(content: Size, viewport: Size, pad = 24, maxK = 1): View {
  if (content.w <= 0 || content.h <= 0 || viewport.w <= 0 || viewport.h <= 0) return HOME;
  const k = clampZoom(Math.min(maxK, (viewport.w - pad * 2) / content.w, (viewport.h - pad * 2) / content.h));
  return { x: round((viewport.w - content.w * k) / 2), y: round(Math.max(pad, (viewport.h - content.h * k) / 2)), k: round(k, 10000) };
}

/** Viewport point -> canvas point. */
export function toCanvas(v: View, px: number, py: number): { x: number; y: number } {
  return { x: (px - v.x) / v.k, y: (py - v.y) / v.k };
}

/** Canvas point -> viewport point. */
export function toScreen(v: View, cx: number, cy: number): { x: number; y: number } {
  return { x: v.x + cx * v.k, y: v.y + cy * v.k };
}

/**
 * Smallest pan that brings canvas rect `r` into the viewport with `pad` px to spare (unchanged when it is
 * already inside; a rect larger than the viewport aligns its top-left).
 */
export function revealView(v: View, r: Rect, viewport: Size, pad = 24): View {
  const axis = (pos: number, start: number, len: number, span: number) => {
    const a = pos + start * v.k;
    const b = a + len * v.k;
    if (b - a > span - pad * 2 || a < pad) return pos + (pad - a);
    if (b > span - pad) return pos - (b - (span - pad));
    return pos;
  };
  return { x: round(axis(v.x, r.x, r.w, viewport.w)), y: round(axis(v.y, r.y, r.h, viewport.h)), k: v.k };
}

/** Pan so canvas point (cx, cy) sits at the viewport's centre. */
export function centerOn(v: View, cx: number, cy: number, viewport: Size): View {
  return { x: round(viewport.w / 2 - cx * v.k), y: round(viewport.h / 2 - cy * v.k), k: v.k };
}

/** Same view (within a hair): skips redundant state updates. */
export function sameView(a: View, b: View): boolean {
  return Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.k - b.k) < 0.0005;
}

/** A stored view, or null when it is not a usable one. */
export function parseView(raw: unknown): View | null {
  if (!raw || typeof raw !== "object") return null;
  const { x, y, k } = raw as Record<string, unknown>;
  if (typeof x !== "number" || typeof y !== "number" || typeof k !== "number") return null;
  if (![x, y, k].every(Number.isFinite)) return null;
  return { x, y, k: clampZoom(k) };
}

// ---- minimap ------------------------------------------------------------------------------------

/** Scale that fits `content` (canvas size) into a minimap box of `box` px. */
export function minimapScale(content: Size, box: Size): number {
  if (content.w <= 0 || content.h <= 0) return 1;
  return Math.min(box.w / content.w, box.h / content.h);
}

/** The viewport as a canvas rect (what the minimap frames). */
export function visibleRect(v: View, viewport: Size): Rect {
  return { x: -v.x / v.k, y: -v.y / v.k, w: viewport.w / v.k, h: viewport.h / v.k };
}

// ---- rubber band ----------------------------------------------------------------------------------

/** Rect from two corner points (any drag direction). */
export function normRect(x1: number, y1: number, x2: number, y2: number): Rect {
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
}

export function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}
