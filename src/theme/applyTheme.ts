// Applies the active theme + appearance modes to the document:
//   - theme base tokens as CSS variables on :root (derived tokens recompute in tokens.css)
//   - data-theme / data-kind / color-scheme, data-glow / data-scanlines effects
//   - data-density, data-reduce-motion (setting OR the OS preference)
//   - data-focus-mode / data-presentation (uiStore, not persisted)
// The terminal palette is applied by terminal/registry.ts from the same settings.

import type { CSSProperties } from "react";
import "../styles/fonts";
import type { Settings } from "../lib/types";
import { useApp } from "../store/appStore";
import { isKeyCaptureSuspended, useUi } from "../store/uiStore";
import { UI_TOKENS, getTheme, themeFonts, type DerivedToken, type Theme } from "./themes";

const DERIVED: DerivedToken[] = ["accent-3", "accent-soft", "accent-ring", "scroll-thumb", "scroll-thumb-hover", "selection"];

/** CSS custom properties for a theme (used on :root and on preview cards). */
export function themeVars(t: Theme): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of UI_TOKENS) out[`--${k}`] = t.ui[k];
  for (const k of DERIVED) {
    const v = t.ui[k];
    if (v) out[`--${k}`] = v;
  }
  const f = themeFonts(t);
  out["--font-ui"] = f.ui;
  out["--font-mono"] = f.mono;
  out["--font-display"] = f.display;
  out["--term-bg"] = t.terminal.background;
  out["--term-fg"] = t.terminal.foreground;
  return out;
}

/** React style object scoping a theme to one element (theme picker previews). */
export function themeScopeStyle(t: Theme): CSSProperties {
  return { ...themeVars(t), colorScheme: t.kind } as CSSProperties;
}

let appliedVars: string[] = [];

export function applyTheme(t: Theme): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const vars = themeVars(t);
  // Clear overrides from the previous theme that this one does not set (optional derived tokens).
  for (const k of appliedVars) if (!(k in vars)) root.style.removeProperty(k);
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  appliedVars = Object.keys(vars);
  root.dataset.theme = t.id;
  root.dataset.kind = t.kind;
  root.style.colorScheme = t.kind;
  toggleAttr(root, "data-glow", !!t.effects?.glow);
}

function toggleAttr(el: HTMLElement, name: string, on: boolean, value = "") {
  if (on) el.setAttribute(name, value);
  else el.removeAttribute(name);
}

const reduceQuery = typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;

function applyModes(s: Settings) {
  const root = document.documentElement;
  const ui = useUi.getState();
  const reduce = s.reduceMotion || !!reduceQuery?.matches;
  root.dataset.density = s.uiDensity === "comfortable" ? "comfortable" : "compact";
  toggleAttr(root, "data-reduce-motion", reduce);
  // Scanlines are static (not motion), so only the explicit setting turns them off, not the OS preference.
  toggleAttr(root, "data-scanlines", !!getTheme(s.theme).effects?.scanlines && ui.scanlines && !s.reduceMotion);
  toggleAttr(root, "data-focus-mode", ui.focusMode);
  toggleAttr(root, "data-presentation", ui.presentation);
}

let installed = false;

/** Apply now and keep the document in sync with settings + UI modes. Idempotent. */
export function installAppearance(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  let prev = useApp.getState().persisted.settings;
  applyTheme(getTheme(prev.theme));
  applyModes(prev);

  useApp.subscribe((st) => {
    const s = st.persisted.settings;
    if (s === prev) return;
    const themeChanged = s.theme !== prev.theme;
    prev = s;
    if (themeChanged) applyTheme(getTheme(s.theme));
    applyModes(s);
  });
  let prevUi = useUi.getState();
  useUi.subscribe((u) => {
    if (u.focusMode === prevUi.focusMode && u.presentation === prevUi.presentation && u.scanlines === prevUi.scanlines) return;
    prevUi = u;
    applyModes(useApp.getState().persisted.settings);
  });
  reduceQuery?.addEventListener("change", () => applyModes(useApp.getState().persisted.settings));

  // Esc leaves focus mode — but never steals Esc from a terminal (agents use it to interrupt),
  // an input, a menu or a dialog.
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || e.defaultPrevented || e.ctrlKey || e.altKey || e.shiftKey || e.metaKey) return;
    if (!useUi.getState().focusMode || isKeyCaptureSuspended()) return;
    const t = e.target as HTMLElement | null;
    if (t?.closest?.(".xterm, input, textarea, select, [role=menu], .menu, .pane-menu")) return;
    useUi.getState().setFocusMode(false);
  });
}

installAppearance();
