// Pure decisions for native browser panes (no DOM, no stores): what to send to a pane's view given
// its host box, what covers it and what was sent before. Driven by nativeViews.ts; unit-tested.

import type { BrowserViewRect, BrowserViewVisibility } from "../lib/types";

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export type Point = [number, number];

/** Host box (viewport CSS px) -> what the host command expects. */
export function toViewRect(box: Box, dpr: number): BrowserViewRect {
  return { x: box.left, y: box.top, width: box.width, height: box.height, scale: Number.isFinite(dpr) && dpr > 0 ? dpr : 1 };
}

export function sameRect(a: BrowserViewRect | null | undefined, b: BrowserViewRect | null | undefined): boolean {
  if (!a || !b) return a === b;
  return Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5 && a.scale === b.scale;
}

/**
 * Points to hit-test over a host box: a grid at most `step` px apart (so anything larger than
 * step x step on top of the box is found), inset from the edges, at most `max` points.
 */
export function samplePoints(box: Box, step = 80, inset = 4, max = 400): Point[] {
  const w = box.width - 2 * inset;
  const h = box.height - 2 * inset;
  if (w <= 0 || h <= 0) return [];
  let cols = Math.max(2, Math.ceil(w / step) + 1);
  let rows = Math.max(2, Math.ceil(h / step) + 1);
  while (cols * rows > max) {
    cols = Math.max(2, Math.ceil(cols / 1.5));
    rows = Math.max(2, Math.ceil(rows / 1.5));
  }
  const pts: Point[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      pts.push([box.left + inset + (w * c) / (cols - 1), box.top + inset + (h * r) / (rows - 1)]);
    }
  }
  return pts;
}

interface HostLike {
  contains(other: unknown): boolean;
}

/**
 * True when something other than the host (or its own children) is on top at any of the points.
 * `ignore` skips elements that must not hide the view (toasts while the user types in the page).
 */
export function coveredAt(points: Point[], hit: (x: number, y: number) => unknown, host: HostLike, ignore?: (el: unknown) => boolean): boolean {
  for (const [x, y] of points) {
    const el = hit(x, y);
    if (el && el !== host && !host.contains(el) && !ignore?.(el)) return true;
  }
  return false;
}

/** shown / occluded / parked from what the pane looks like right now. */
export function decideVisibility(o: { box: Box | null; pageVisible: boolean; dragging: boolean; covered: boolean }): BrowserViewVisibility {
  if (!o.box || !o.pageVisible) return "parked";
  if (o.dragging || o.covered) return "occluded";
  return "shown";
}

export interface PlanInput {
  /** The view exists (created and not busy creating). */
  exists: boolean;
  /** An operation is in flight (create, snapshot): plan nothing. */
  busy: boolean;
  /** What was last sent for this view. */
  sent: { vis: BrowserViewVisibility; rect: BrowserViewRect | null } | null;
  /** nav.nonce the view last loaded. */
  appliedNonce: number;
  /** The page the pane should show, or null when it shows a card / the start page. */
  wantUrl: string | null;
  nonce: number;
  vis: BrowserViewVisibility;
  rect: BrowserViewRect | null;
  /** A recent snapshot exists, so hiding needs no new one. */
  snapFresh: boolean;
}

export type PlanOp =
  | { kind: "create"; url: string; rect: BrowserViewRect }
  | { kind: "navigate"; url: string }
  | { kind: "show"; rect: BrowserViewRect }
  | { kind: "snapshot" }
  | { kind: "hide"; vis: "occluded" | "parked"; rect: BrowserViewRect | null };

/**
 * The next operations for one view. Views are created lazily the first time their pane is on screen
 * and uncovered; a pane that shows a card (start page, unreachable, blocked) parks its view.
 */
export function planView(i: PlanInput): PlanOp[] {
  const vis: BrowserViewVisibility = i.wantUrl ? i.vis : "parked";
  if (i.busy) return [];
  if (!i.exists) return i.wantUrl && vis === "shown" && i.rect ? [{ kind: "create", url: i.wantUrl, rect: i.rect }] : [];
  const ops: PlanOp[] = [];
  if (i.wantUrl && i.nonce !== i.appliedNonce) ops.push({ kind: "navigate", url: i.wantUrl });
  const was = i.sent?.vis ?? "parked";
  if (vis === "shown") {
    if (i.rect && (was !== "shown" || !sameRect(i.sent?.rect, i.rect))) ops.push({ kind: "show", rect: i.rect });
  } else if (was === "shown" && vis === "occluded" && !i.snapFresh) {
    ops.push({ kind: "snapshot" });
  } else if (was !== vis) {
    ops.push({ kind: "hide", vis, rect: i.rect });
  }
  return ops;
}
