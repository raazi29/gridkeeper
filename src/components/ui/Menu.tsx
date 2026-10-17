// Context / dropdown menu rendered in a portal at fixed coordinates.
// Items: actions (label, hint = shortcut text, icon, danger, disabled, checked), "separator", and
// parent items with `children` (submenus, any depth). All panels live inside ONE portal root, so a click
// in a submenu is never an "outside" click. Keyboard: see menuNav.ts. While open the menu counts as a
// modal (app shortcuts are suspended, so e.g. Ctrl+Shift+W cannot close the pane under it).

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { popModal, pushModal } from "../../store/uiStore";
import { firstIndex, menuKey, type NavItem } from "./menuNav";
import "../../styles/menus.css";

export interface MenuAction {
  label: string;
  /** Required for leaf items; parents (with `children`) open their submenu instead. */
  onSelect?: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** Right-aligned hint, usually the keyboard shortcut. */
  hint?: string;
  icon?: ReactNode;
  /** Shows a check mark (toggle / radio state). */
  checked?: boolean;
  /** Submenu items. */
  children?: MenuItem[];
}

export type MenuItem = MenuAction | "separator";

const toNav = (items: MenuItem[]): NavItem[] =>
  items.map((it) => (it === "separator" ? it : { label: it.label, disabled: it.disabled || (it.children !== undefined && it.children.length === 0), hasChildren: !!it.children }));

interface Level {
  items: MenuItem[];
}

export function Menu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  const prevFocus = useRef<HTMLElement | null>(null);
  /** Open submenu index per level (path[0] = index in the root menu whose submenu is open). */
  const [path, setPath] = useState<number[]>([]);
  /** Level whose first item should take focus after it renders (keyboard-opened submenu). */
  const [focusLevel, setFocusLevel] = useState<number | null>(0);
  const closed = useRef(false);

  const levels: Level[] = [{ items }];
  for (let d = 0; d < path.length; d++) {
    const parent = levels[d].items[path[d]];
    if (!parent || parent === "separator" || !parent.children) break;
    levels.push({ items: parent.children });
  }

  useLayoutEffect(() => {
    prevFocus.current = document.activeElement as HTMLElement | null;
    const id = pushModal();
    return () => popModal(id);
  }, []);

  const close = useCallback(
    (restore: boolean) => {
      if (closed.current) return;
      closed.current = true;
      onClose();
      if (restore && prevFocus.current?.isConnected) prevFocus.current.focus();
    },
    [onClose],
  );

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) close(false);
    };
    const onBlur = () => close(false);
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("blur", onBlur);
    window.addEventListener("resize", onBlur);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("resize", onBlur);
    };
  }, [close]);

  const button = (level: number, index: number) =>
    root.current?.querySelector<HTMLButtonElement>(`[data-level="${level}"] [data-index="${index}"]`) ?? null;

  // Focus goes back to where it was (terminal, card, button) BEFORE the action runs, so actions that
  // move focus themselves (rename input, find bar, dialogs, jump) still win.
  const activate = (it: MenuAction) => {
    close(true);
    it.onSelect?.();
  };

  const openSub = (level: number, index: number, focus: boolean) => {
    setPath((p) => (p.length === level + 1 && p[level] === index ? p : [...p.slice(0, level), index]));
    setFocusLevel(focus ? level + 1 : null);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const active = document.activeElement as HTMLElement | null;
    const levelEl = active?.closest<HTMLElement>("[data-level]");
    const level = levelEl ? Number(levelEl.dataset.level) : levels.length - 1;
    const index = active?.dataset.index !== undefined ? Number(active.dataset.index) : -1;
    const list = levels[level]?.items ?? [];
    const r = menuKey(e.key, toNav(list), index, level);
    if (r.type === "none") {
      if (e.key !== "Shift" && e.key !== "Control" && e.key !== "Alt") e.stopPropagation();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    switch (r.type) {
      case "move":
        button(level, r.index)?.focus();
        if (path.length > level) setPath((p) => p.slice(0, level));
        break;
      case "open":
        openSub(level, r.index, true);
        break;
      case "activate": {
        const it = list[r.index];
        if (it && it !== "separator") activate(it);
        break;
      }
      case "close":
        if (r.scope === "all") close(true);
        else {
          const parentIndex = path[level - 1];
          setPath((p) => p.slice(0, level - 1));
          setFocusLevel(null);
          requestAnimationFrame(() => button(level - 1, parentIndex)?.focus());
        }
        break;
    }
  };

  return createPortal(
    <div ref={root} className="menu-root" onKeyDown={onKeyDown} onContextMenu={(e) => e.preventDefault()}>
      {levels.map((lv, d) => (
        <MenuPanel
          key={d === 0 ? "root" : `${d}:${path.slice(0, d).join(".")}`}
          level={d}
          items={lv.items}
          anchor={d === 0 ? { x, y } : () => button(d - 1, path[d - 1])}
          openIndex={path[d] ?? -1}
          autoFocus={focusLevel === d}
          onFocused={() => setFocusLevel(null)}
          onHover={(index, hasChildren) => {
            if (hasChildren) openSub(d, index, false);
            else if (path.length > d) setPath((p) => p.slice(0, d));
          }}
          onPick={(index) => {
            const it = lv.items[index];
            if (!it || it === "separator" || it.disabled) return;
            if (it.children) openSub(d, index, true);
            else activate(it);
          }}
        />
      ))}
    </div>,
    document.body,
  );
}

function MenuPanel({
  level,
  items,
  anchor,
  openIndex,
  autoFocus,
  onFocused,
  onHover,
  onPick,
}: {
  level: number;
  items: MenuItem[];
  anchor: { x: number; y: number } | (() => HTMLElement | null);
  openIndex: number;
  autoFocus: boolean;
  onFocused: () => void;
  onHover: (index: number, hasChildren: boolean) => void;
  onPick: (index: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const anchorX = typeof anchor === "function" ? null : anchor.x;
  const anchorY = typeof anchor === "function" ? null : anchor.y;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (typeof anchor !== "function") {
      const left = Math.max(4, Math.min(anchor.x, vw - r.width - 4));
      const top = Math.max(4, anchor.y + r.height > vh - 4 ? Math.max(4, anchor.y - r.height) : anchor.y);
      setPos({ left, top: Math.min(top, Math.max(4, vh - r.height - 4)) });
    } else {
      const a = anchor()?.getBoundingClientRect();
      if (!a) return;
      let left = a.right + 2;
      if (left + r.width > vw - 4) left = Math.max(4, a.left - r.width - 2);
      const top = Math.max(4, Math.min(a.top - 5, vh - r.height - 4));
      setPos({ left, top });
    }
    // Re-position when the anchor point changes; submenus are keyed by their path.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchorX, anchorY]);

  useLayoutEffect(() => {
    if (!autoFocus || !ref.current) return;
    const i = firstIndex(toNav(items));
    ref.current.querySelector<HTMLElement>(`[data-index="${i}"]`)?.focus();
    onFocused();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoFocus]);

  const hasChecks = items.some((it) => it !== "separator" && it.checked !== undefined);

  return (
    <div
      ref={ref}
      className="menu"
      role="menu"
      data-level={level}
      style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: "hidden" }}
    >
      {items.map((it, i) =>
        it === "separator" ? (
          <div key={`sep${i}`} className="menu-sep" role="separator" />
        ) : (
          <button
            key={`${i}:${it.label}`}
            type="button"
            role={it.checked !== undefined ? "menuitemcheckbox" : "menuitem"}
            aria-checked={it.checked !== undefined ? it.checked : undefined}
            aria-haspopup={it.children ? "menu" : undefined}
            aria-expanded={it.children ? openIndex === i : undefined}
            data-index={i}
            tabIndex={-1}
            disabled={it.disabled || (it.children !== undefined && it.children.length === 0)}
            className={`menu-item${it.danger ? " is-danger" : ""}${openIndex === i ? " is-open" : ""}`}
            onMouseEnter={(e) => {
              if (e.currentTarget.disabled) return;
              e.currentTarget.focus({ preventScroll: true });
              onHover(i, !!it.children);
            }}
            onClick={() => onPick(i)}
          >
            {hasChecks && (
              <span className="menu-check" aria-hidden="true">
                {it.checked ? "✓" : ""}
              </span>
            )}
            <span className="menu-icon">{it.icon}</span>
            <span className="menu-label">{it.label}</span>
            {it.hint && <span className="menu-hint">{it.hint}</span>}
            {it.children && (
              <span className="menu-sub-arrow" aria-hidden="true">
                ›
              </span>
            )}
          </button>
        ),
      )}
    </div>
  );
}

export interface MenuState {
  x: number;
  y: number;
  items: MenuItem[];
}

/** Local context-menu state helper: `open(event, items)` + render `element`. */
export function useContextMenu() {
  const [state, setState] = useState<MenuState | null>(null);
  const close = useCallback(() => setState(null), []);
  const open = useCallback((e: { clientX: number; clientY: number; preventDefault?: () => void; stopPropagation?: () => void }, items: MenuItem[]) => {
    e.preventDefault?.();
    e.stopPropagation?.();
    setState({ x: e.clientX, y: e.clientY, items });
  }, []);
  /** Open anchored under an element (for "…" buttons). */
  const openAt = useCallback((el: HTMLElement, items: MenuItem[]) => {
    const r = el.getBoundingClientRect();
    setState({ x: r.left, y: r.bottom + 2, items });
  }, []);
  const element = state ? <Menu key={`${state.x},${state.y}`} x={state.x} y={state.y} items={state.items} onClose={close} /> : null;
  return { open, openAt, close, element, isOpen: state !== null };
}
