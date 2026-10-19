// Mission Control multi-selection, pure (unit-tested): click with Ctrl/⌘ (toggle) and Shift (range over the cards'
// display order), Shift+arrow extension and the rubber band's hit test. The "anchor" is where a Shift range starts.

import type { SessionId } from "../../lib/types";
import { intersects, type Rect } from "./viewport";

export interface Selection {
  ids: SessionId[];
  anchor: SessionId | null;
}

export const EMPTY_SELECTION: Selection = { ids: [], anchor: null };

/** Ids from `a` to `b` (inclusive) in `order`; just `b` when either is not in it. */
export function rangeIds(order: readonly SessionId[], a: SessionId | null, b: SessionId): SessionId[] {
  const i = a ? order.indexOf(a) : -1;
  const j = order.indexOf(b);
  if (i < 0 || j < 0) return [b];
  return order.slice(Math.min(i, j), Math.max(i, j) + 1);
}

/** Union in `order` (ids not in `order` keep their place at the end). */
function inOrder(order: readonly SessionId[], ids: Iterable<SessionId>): SessionId[] {
  const set = new Set(ids);
  const out = order.filter((id) => set.has(id));
  for (const id of set) if (!order.includes(id)) out.push(id);
  return out;
}

/**
 * A click on card `id`: plain = only it; toggle (Ctrl/⌘) = add / remove it; range (Shift) = anchor → it
 * (Ctrl/⌘+Shift adds the range to the selection).
 */
export function clickSelect(sel: Selection, id: SessionId, mods: { toggle: boolean; range: boolean }, order: readonly SessionId[]): Selection {
  if (mods.range) {
    const span = rangeIds(order, sel.anchor ?? sel.ids[sel.ids.length - 1] ?? null, id);
    return { ids: inOrder(order, mods.toggle ? [...sel.ids, ...span] : span), anchor: sel.anchor ?? id };
  }
  if (mods.toggle) {
    const has = sel.ids.includes(id);
    return { ids: inOrder(order, has ? sel.ids.filter((x) => x !== id) : [...sel.ids, id]), anchor: id };
  }
  return { ids: [id], anchor: id };
}

/** Shift+←/→: move the focus to its neighbour and select anchor → focus. Returns the new focus too. */
export function extendSelect(sel: Selection, focus: SessionId, dir: 1 | -1, order: readonly SessionId[]): { sel: Selection; focus: SessionId } {
  const i = order.indexOf(focus);
  if (i < 0) return { sel, focus };
  const next = order[Math.max(0, Math.min(order.length - 1, i + dir))];
  const anchor = sel.anchor && order.includes(sel.anchor) ? sel.anchor : focus;
  return { sel: { ids: rangeIds(order, anchor, next), anchor }, focus: next };
}

/** Cards whose box intersects the rubber band (any coordinate space, as long as both use the same). */
export function idsInRect(items: readonly { id: SessionId; rect: Rect }[], band: Rect): SessionId[] {
  return items.filter((it) => intersects(it.rect, band)).map((it) => it.id);
}

/** Keeps only ids that still exist (cards removed while selected). Returns `sel` itself when nothing changed. */
export function pruneSelection(sel: Selection, alive: readonly SessionId[]): Selection {
  const ids = sel.ids.filter((id) => alive.includes(id));
  const anchor = sel.anchor && alive.includes(sel.anchor) ? sel.anchor : null;
  return ids.length === sel.ids.length && anchor === sel.anchor ? sel : { ids, anchor };
}
