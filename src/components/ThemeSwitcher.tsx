// Quick theme switcher: a palette button in the workspace header and a theme chip in the status bar,
// both opening a compact popover of live theme cards. Hover / keyboard focus previews a theme on the
// whole chrome (applyTheme.previewTheme — never saved); leaving reverts unless a card was clicked.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useApp } from "../store/appStore";
import { useUi } from "../store/uiStore";
import { previewTheme } from "../theme/applyTheme";
import { resolveTheme, withSaber } from "../theme/saber";
import { THEMES, getTheme, type Theme } from "../theme/themes";
import { SaberPicker } from "./AppearanceExtras";
import { ThemeCard } from "./ThemeCard";
import { IconButton } from "./ui/Button";
import "../styles/experience.css";

export const IconPalette = ({ size = 15 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <path d="M8 1.9a6.1 6.1 0 1 0 0 12.2c.9 0 1.4-.6 1.4-1.3 0-.4-.2-.7-.4-1-.2-.3-.4-.6-.4-1 0-.8.6-1.3 1.4-1.3h1.5a2.9 2.9 0 0 0 2.9-2.9C14.4 4.1 11.6 1.9 8 1.9z" />
    <circle cx="4.9" cy="7.4" r="0.9" fill="currentColor" stroke="none" />
    <circle cx="6.9" cy="4.8" r="0.9" fill="currentColor" stroke="none" />
    <circle cx="10.1" cy="4.8" r="0.9" fill="currentColor" stroke="none" />
  </svg>
);

const COLS = 3;
const PREVIEW_DELAY_MS = 70;

type Placement = "below-end" | "above-start";

function ThemePopover({ anchor, placement, onClose }: { anchor: HTMLElement; placement: Placement; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<React.CSSProperties>({ visibility: "hidden", top: 0, left: 0 });
  const committed = getTheme(useApp((s) => s.persisted.settings.theme)).id;
  const saberColor = useApp((s) => s.persisted.settings.saberColor);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const schedulePreview = useCallback((t: Theme | null) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => previewTheme(t), t ? PREVIEW_DELAY_MS : 0);
  }, []);

  const revert = useCallback(() => {
    window.clearTimeout(timer.current);
    setHoverId(null);
    previewTheme(null);
  }, []);

  // Position next to the anchor, inside the viewport.
  useLayoutEffect(() => {
    const r = anchor.getBoundingClientRect();
    const el = ref.current;
    const w = el?.offsetWidth ?? 560;
    const h = el?.offsetHeight ?? 420;
    if (placement === "below-end") {
      const left = Math.min(Math.max(8, r.right - w), window.innerWidth - w - 8);
      const top = Math.min(r.bottom + 6, window.innerHeight - h - 8);
      setPos({ top: Math.max(8, top), left });
    } else {
      const left = Math.min(Math.max(8, r.left), window.innerWidth - w - 8);
      const top = Math.max(8, r.top - h - 6);
      setPos({ top, left });
    }
    (el?.querySelector<HTMLElement>(".theme-card.is-selected") ?? el?.querySelector<HTMLElement>(".theme-card"))?.focus({ preventScroll: true });
  }, [anchor, placement]);

  // Close on outside click, Esc, window blur; always revert an uncommitted preview on the way out.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchor.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
      anchor.focus();
    };
    const onBlur = () => onClose();
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onBlur);
    window.addEventListener("resize", onBlur);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("resize", onBlur);
      window.clearTimeout(timer.current);
      previewTheme(null);
    };
  }, [anchor, onClose]);

  const select = (t: Theme) => {
    window.clearTimeout(timer.current);
    previewTheme(null);
    setHoverId(null);
    useApp.getState().updateSettings({ theme: t.id });
    // Saber Duel stays open so the blade colour can be picked right away.
    if (!t.saber) {
      onClose();
      anchor.focus();
    }
  };

  const onGridKey = (e: React.KeyboardEvent) => {
    const cards = [...(ref.current?.querySelectorAll<HTMLElement>(".theme-card") ?? [])];
    const i = cards.indexOf(document.activeElement as HTMLElement);
    if (i < 0) return;
    const delta = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : e.key === "ArrowDown" ? COLS : e.key === "ArrowUp" ? -COLS : 0;
    if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      cards[e.key === "Home" ? 0 : cards.length - 1]?.focus();
      return;
    }
    if (!delta) return;
    e.preventDefault();
    const next = Math.min(cards.length - 1, Math.max(0, i + delta));
    cards[next]?.focus();
  };

  const shown = getTheme(hoverId ?? committed);
  const showSaber = resolveTheme({ theme: hoverId ?? committed, saberColor }).saber;

  return createPortal(
    <div
      ref={ref}
      className="theme-pop"
      role="dialog"
      aria-label="Choose a theme"
      style={pos}
      onBlur={(e) => {
        // Keyboard focus left the popover entirely.
        if (e.relatedTarget && !ref.current?.contains(e.relatedTarget as Node) && !anchor.contains(e.relatedTarget as Node)) onClose();
      }}
    >
      <div className="theme-pop-head">
        <span className="theme-pop-title">Theme</span>
        <span className="theme-pop-now" aria-live="polite">
          {hoverId && hoverId !== committed ? (
            <>
              Previewing <b>{shown.name}</b>
            </>
          ) : (
            <>
              <b>{shown.name}</b> · {shown.kind}
            </>
          )}
        </span>
        <span className="theme-pop-hint">Hover to preview · Enter to apply</span>
      </div>
      <div
        className="theme-pop-grid"
        role="radiogroup"
        aria-label="Theme"
        onKeyDown={onGridKey}
        onMouseLeave={revert}
      >
        {THEMES.map((t) => {
          const themed = withSaber(t, saberColor);
          return (
            <ThemeCard
              key={t.id}
              compact
              theme={themed}
              selected={t.id === committed}
              tabIndex={t.id === committed ? 0 : -1}
              onPreview={() => {
                setHoverId(t.id);
                schedulePreview(t.id === committed ? null : themed);
              }}
              onSelect={() => select(t)}
            />
          );
        })}
      </div>
      <div className="theme-pop-foot">
        {showSaber ? (
          <div className="theme-pop-saber">
            <span className="micro-label">Blade</span>
            <SaberPicker size="sm" />
          </div>
        ) : (
          <span className="theme-pop-tip">Themes recolour the terminals too. Effects like glow and scanlines live in Settings.</span>
        )}
        <button
          type="button"
          className="link-btn theme-pop-more"
          onClick={() => {
            onClose();
            useUi.getState().openDialog({ kind: "settings", section: "appearance" });
          }}
        >
          More in Settings ›
        </button>
      </div>
    </div>,
    document.body,
  );
}

function useThemePopover(placement: Placement) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const close = useCallback(() => setAnchor(null), []);
  const toggle = useCallback((el: HTMLElement) => setAnchor((a) => (a ? null : el)), []);
  const element = anchor ? <ThemePopover anchor={anchor} placement={placement} onClose={close} /> : null;
  return { open: !!anchor, toggle, element };
}

/** Palette button for the workspace header. */
export function ThemeSwitcherButton() {
  const pop = useThemePopover("below-end");
  return (
    <>
      <IconButton
        label="Theme"
        title="Theme — hover a card to preview"
        className={pop.open ? "is-active" : undefined}
        aria-haspopup="dialog"
        aria-expanded={pop.open}
        data-theme-switcher=""
        onClick={(e) => pop.toggle(e.currentTarget)}
      >
        <IconPalette size={15} />
      </IconButton>
      {pop.element}
    </>
  );
}

/** Status bar chip: swatch + current theme name. */
export function ThemeChip() {
  const themeId = useApp((s) => s.persisted.settings.theme);
  const saberColor = useApp((s) => s.persisted.settings.saberColor);
  const t = resolveTheme({ theme: themeId, saberColor });
  const pop = useThemePopover("above-start");
  return (
    <>
      <button
        type="button"
        className={`sb-item sb-btn theme-chip${pop.open ? " is-active" : ""}`}
        title="Change theme"
        aria-haspopup="dialog"
        aria-expanded={pop.open}
        data-theme-chip=""
        onClick={(e) => pop.toggle(e.currentTarget)}
      >
        <span className="theme-chip-swatch" aria-hidden="true" style={{ ["--sw-bg" as string]: t.ui["bg-2"], ["--sw-accent" as string]: t.ui.accent, ["--sw-accent-2" as string]: t.ui["accent-2"] }} />
        <span className="theme-chip-name">{t.name}</span>
      </button>
      {pop.element}
    </>
  );
}
