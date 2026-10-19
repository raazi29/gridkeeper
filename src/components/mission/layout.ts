// Layout positions inside Mission Control's canvas, independent of zoom, pan and running transform animations
// (FLIP, the entry assembly): offsetLeft / offsetTop ignore CSS transforms. Used by the connectors, comets,
// the minimap and FLIP.

import type { Rect } from "./viewport";

/** `el`'s box in `root`'s layout coordinates (root must be positioned). Falls back to client rects / scale. */
export function layoutRect(el: HTMLElement, root: HTMLElement): Rect | null {
  let x = 0;
  let y = 0;
  let cur: HTMLElement | null = el;
  while (cur && cur !== root) {
    x += cur.offsetLeft;
    y += cur.offsetTop;
    const parent = cur.offsetParent as HTMLElement | null;
    if (!parent) break;
    if (parent !== root && !root.contains(parent)) {
      cur = null;
      break;
    }
    // Borders of intermediate offset parents are not part of offsetLeft / offsetTop.
    if (parent !== root) {
      x += parent.clientLeft;
      y += parent.clientTop;
    }
    cur = parent;
  }
  if (cur === root) return { x, y, w: el.offsetWidth, h: el.offsetHeight };
  // Not under root's offset chain (should not happen): measure on screen and undo the current scale.
  const r = el.getBoundingClientRect();
  const base = root.getBoundingClientRect();
  const k = root.offsetWidth > 0 ? base.width / root.offsetWidth : 1;
  if (!(k > 0)) return null;
  return { x: (r.left - base.left) / k, y: (r.top - base.top) / k, w: r.width / k, h: r.height / k };
}

/** Rects of every element matching `selector` under `root`, keyed by `attr`'s value. */
export function layoutRects(root: HTMLElement, selector: string, attr: string): Map<string, Rect> {
  const out = new Map<string, Rect>();
  for (const el of root.querySelectorAll<HTMLElement>(selector)) {
    const key = el.getAttribute(attr);
    if (!key) continue;
    const r = layoutRect(el, root);
    if (r) out.set(key, r);
  }
  return out;
}
