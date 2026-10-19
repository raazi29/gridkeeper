// Pure keyboard-navigation logic for menus with submenus (unit-tested; no DOM / React here).
//
// A menu is a list of items per level. `menuKey` maps a key press on the item at `index` of a level at
// `depth` (0 = root) to one action the component performs:
//   ArrowDown / ArrowUp  move (wrapping, skipping separators and disabled items); Home / End
//   ArrowRight           open the submenu of a parent item (focus its first item)
//   Enter / Space        open a parent item's submenu, else activate the item
//   ArrowLeft            close this submenu level (root: nothing)
//   (right-to-left documents: ArrowLeft opens and ArrowRight closes, since submenus open to the left)
//   Escape               close this submenu level (root: close the whole menu)
//   Tab                  close the whole menu
//   a printable letter   move to the next enabled item whose label starts with it (type-ahead)

export type NavItem = { label?: string; disabled?: boolean; hasChildren?: boolean } | "separator";

export type MenuKeyResult =
  | { type: "move"; index: number }
  | { type: "open"; index: number }
  | { type: "activate"; index: number }
  | { type: "close"; scope: "level" | "all" }
  | { type: "none" };

export function isFocusable(it: NavItem | undefined): boolean {
  return !!it && it !== "separator" && !it.disabled;
}

/** Next focusable index from `from` in direction `dir`, wrapping. `from` = -1 starts before the first item. */
export function moveIndex(items: readonly NavItem[], from: number, dir: 1 | -1): number {
  const n = items.length;
  if (n === 0) return -1;
  let i = from;
  for (let step = 0; step < n; step++) {
    i = from < 0 && step === 0 ? (dir === 1 ? 0 : n - 1) : (i + dir + n) % n;
    if (isFocusable(items[i])) return i;
  }
  return -1;
}

export function firstIndex(items: readonly NavItem[]): number {
  return moveIndex(items, -1, 1);
}

export function lastIndex(items: readonly NavItem[]): number {
  return moveIndex(items, -1, -1);
}

/** Next focusable item after `from` whose label starts with `ch` (case-insensitive), wrapping; -1 if none. */
export function typeaheadIndex(items: readonly NavItem[], from: number, ch: string): number {
  const c = ch.toLowerCase();
  const n = items.length;
  for (let step = 1; step <= n; step++) {
    const i = (Math.max(from, -1) + step + n) % n;
    const it = items[i];
    if (isFocusable(it) && it !== "separator" && (it.label ?? "").trim().toLowerCase().startsWith(c)) return i;
  }
  return -1;
}

export function menuKey(key: string, items: readonly NavItem[], index: number, depth: number, rtl = false): MenuKeyResult {
  const cur = items[index];
  if (rtl && (key === "ArrowLeft" || key === "ArrowRight")) key = key === "ArrowLeft" ? "ArrowRight" : "ArrowLeft";
  switch (key) {
    case "ArrowDown":
    case "ArrowUp": {
      const next = moveIndex(items, index, key === "ArrowDown" ? 1 : -1);
      return next >= 0 ? { type: "move", index: next } : { type: "none" };
    }
    case "Home":
    case "PageUp": {
      const i = firstIndex(items);
      return i >= 0 ? { type: "move", index: i } : { type: "none" };
    }
    case "End":
    case "PageDown": {
      const i = lastIndex(items);
      return i >= 0 ? { type: "move", index: i } : { type: "none" };
    }
    case "ArrowRight":
      return isFocusable(cur) && cur !== "separator" && cur.hasChildren ? { type: "open", index } : { type: "none" };
    case "Enter":
    case " ":
      if (!isFocusable(cur) || cur === "separator") return { type: "none" };
      return cur.hasChildren ? { type: "open", index } : { type: "activate", index };
    case "ArrowLeft":
      return depth > 0 ? { type: "close", scope: "level" } : { type: "none" };
    case "Escape":
      return { type: "close", scope: depth > 0 ? "level" : "all" };
    case "Tab":
      return { type: "close", scope: "all" };
    default:
      if (key.length === 1 && /\S/.test(key)) {
        const i = typeaheadIndex(items, index, key);
        return i >= 0 ? { type: "move", index: i } : { type: "none" };
      }
      return { type: "none" };
  }
}

// ---- placement (pure) ------------------------------------------------------------------------------

const EDGE = 4;

/**
 * Top-left corner for a root menu panel of `size` in a viewport of `view`, always fully inside it (4 px
 * margin). With `rect` (a dropdown hanging from a button) the panel opens below the button, else above
 * it, else wherever it fits best, never covering the button when either side has room; horizontally it
 * starts at the button's left edge and shifts left near the right edge. Without `rect` (a context menu at
 * the pointer) it opens at the point and flips above it near the bottom.
 */
export function placeMenu(
  anchor: { x: number; y: number; rect?: { top: number; bottom: number; left: number; right: number } },
  size: { width: number; height: number },
  view: { width: number; height: number },
  rtl = false,
): { left: number; top: number } {
  const maxLeft = Math.max(EDGE, view.width - size.width - EDGE);
  const maxTop = Math.max(EDGE, view.height - size.height - EDGE);
  const clampTop = (t: number) => Math.min(Math.max(EDGE, t), maxTop);
  const clampLeft = (l: number) => Math.min(Math.max(EDGE, l), maxLeft);
  const r = anchor.rect;
  if (r) {
    // Right-to-left: the panel lines up with the button's right edge instead of its left edge.
    const left = clampLeft(rtl ? r.right - size.width : r.left);
    const below = r.bottom + 2;
    const above = r.top - 2 - size.height;
    if (below + size.height <= view.height - EDGE) return { left, top: below };
    if (above >= EDGE) return { left, top: above };
    // Neither side has room for the whole panel: take the roomier side and let the panel scroll.
    return { left, top: clampTop(view.height - r.bottom > r.top ? below : above) };
  }
  // Right-to-left: a context menu opens to the left of the pointer.
  const left = clampLeft(rtl ? anchor.x - size.width : anchor.x);
  const top = anchor.y + size.height > view.height - EDGE ? anchor.y - size.height : anchor.y;
  return { left, top: clampTop(top) };
}
