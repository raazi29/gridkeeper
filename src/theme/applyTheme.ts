// Applies the active theme + appearance modes to the document:
//   - theme base tokens as CSS variables on :root (derived tokens recompute in tokens.css)
//   - data-theme / data-kind / color-scheme, data-glow / data-scanlines / data-holo effects
//   - data-density, data-reduce-motion (setting OR the OS preference)
//   - data-saber + --saber / --saber-core / --saber-rival (saber effects, every theme: theme/saberFx.ts)
//   - data-focus-mode / data-presentation (uiStore, not persisted)
//   - data-app-blurred while the window is in the background (pauses the few CSS loops)
//   - previewTheme(): temporary theme for the quick switcher's hover preview (never cached)
// The terminal palette is applied by terminal/registry.ts from the same settings.

import type { CSSProperties } from "react";
import "../styles/fonts";
import "../styles/signature.css";
import "../styles/saber.css";
import type { Settings } from "../lib/types";
import { useApp } from "../store/appStore";
import { isKeyCaptureSuspended, useUi } from "../store/uiStore";
import { useEffectPrefs } from "./effectPrefs";
import { resolveTheme } from "./saber";
import { duelPartner, resolveBlade, resolveSaberLevel, type SaberLevel } from "./saberFx";
import { UI_TOKENS, themeFonts, type DerivedToken, type Theme } from "./themes";

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
let appliedKey: string | null = null;
/** Theme shown temporarily by the quick switcher (hover / keyboard preview), if any. */
let previewing: Theme | null = null;

// Last applied theme id, cached per machine so the first paint (before the state file loads) already
// uses it: no dark flash on launch for light-theme users. Settings remain the source of truth.
const LS_THEME = "gridkeeper.ui.theme";
function readCachedTheme(): string | null {
  try {
    return globalThis.localStorage?.getItem(LS_THEME) ?? null;
  } catch {
    return null;
  }
}

/** Identity of what is on screen: theme id + accent (the Saber Duel blade changes only the accent). */
const themeKey = (t: Theme) => `${t.id}:${t.ui.accent}`;

function setThemeVars(t: Theme): void {
  const root = document.documentElement;
  const vars = themeVars(t);
  // Clear overrides from the previous theme that this one does not set (optional derived tokens).
  for (const k of appliedVars) if (!(k in vars)) root.style.removeProperty(k);
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  appliedVars = Object.keys(vars);
  root.dataset.theme = t.id;
  root.dataset.kind = t.kind;
  root.style.colorScheme = t.kind;
}

export function applyTheme(t: Theme): void {
  if (typeof document === "undefined") return;
  appliedKey = themeKey(t);
  try {
    globalThis.localStorage?.setItem(LS_THEME, t.id);
  } catch {
    /* storage unavailable */
  }
  if (!previewing) setThemeVars(t);
}

/**
 * Show a theme temporarily without saving or caching it (chrome only: terminals keep the saved palette,
 * so sweeping across the switcher never rebuilds WebGL glyph atlases). `null` restores the saved theme.
 * Commit by clearing the preview and updating settings.theme.
 */
export function previewTheme(t: Theme | null): void {
  if (typeof document === "undefined") return;
  if (t) {
    if (previewing && themeKey(previewing) === themeKey(t)) return;
    previewing = t;
    // The terminal area keeps the committed palette (xterm canvases are not re-themed during a preview),
    // so pane padding / viewport strips never mismatch the canvas — e.g. dark → Ice Planet.
    setThemeVars({ ...t, terminal: resolveTheme(useApp.getState().persisted.settings).terminal });
  } else {
    if (!previewing) return;
    previewing = null;
    setThemeVars(resolveTheme(useApp.getState().persisted.settings));
  }
  applyModes(useApp.getState().persisted.settings);
}

function toggleAttr(el: HTMLElement, name: string, on: boolean, value = "") {
  if (on) el.setAttribute(name, value);
  else el.removeAttribute(name);
}

const reduceQuery = typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;

/** Reduced motion: the setting or the OS preference. */
export function prefersReducedMotion(s: Pick<Settings, "reduceMotion"> = useApp.getState().persisted.settings): boolean {
  return s.reduceMotion || !!reduceQuery?.matches;
}

/** Saber effect level on screen right now (follows the quick switcher's preview theme). */
export function currentSaberLevel(s: Settings = useApp.getState().persisted.settings): SaberLevel {
  return resolveSaberLevel(s.saberEffects, previewing ?? resolveTheme(s), prefersReducedMotion(s));
}

function applyModes(s: Settings) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const ui = useUi.getState();
  const fx = useEffectPrefs.getState();
  const reduce = prefersReducedMotion(s);
  const shown = previewing ?? resolveTheme(s);
  const effects = shown.effects;
  // Saber: data-saber="subtle|full" (absent = off, incl. reduced motion) + the blade colours for every theme.
  const saber = resolveSaberLevel(s.saberEffects, shown, reduce);
  toggleAttr(root, "data-saber", saber !== "off", saber);
  const blade = resolveBlade(shown, s);
  root.style.setProperty("--saber", blade.color);
  root.style.setProperty("--saber-core", blade.core);
  root.style.setProperty("--saber-rival", duelPartner(blade, shown));
  root.dataset.density = s.uiDensity === "comfortable" ? "comfortable" : "compact";
  toggleAttr(root, "data-reduce-motion", reduce);
  toggleAttr(root, "data-glow", !!effects?.glow && fx.glow);
  // Scanlines are static (not motion), so only the explicit setting turns them off, not the OS preference.
  toggleAttr(root, "data-scanlines", !!effects?.scanlines && ui.scanlines && !s.reduceMotion);
  // The holo band moves: off under either reduced-motion source.
  toggleAttr(root, "data-holo", !!effects?.holo && fx.holo && !reduce);
  toggleAttr(root, "data-focus-mode", ui.focusMode);
  toggleAttr(root, "data-presentation", ui.presentation);
}

let installed = false;

/** Apply now and keep the document in sync with settings + UI modes. Idempotent. */
export function installAppearance(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  let prev = useApp.getState().persisted.settings;
  applyTheme(resolveTheme(useApp.getState().loaded ? prev : { ...prev, theme: readCachedTheme() ?? prev.theme }));
  applyModes(prev);

  useApp.subscribe((st) => {
    const s = st.persisted.settings;
    if (s === prev) return;
    prev = s;
    const t = resolveTheme(s);
    if (themeKey(t) !== appliedKey) applyTheme(t);
    applyModes(s);
  });
  let prevUi = useUi.getState();
  useUi.subscribe((u) => {
    if (u.focusMode === prevUi.focusMode && u.presentation === prevUi.presentation && u.scanlines === prevUi.scanlines) return;
    prevUi = u;
    applyModes(useApp.getState().persisted.settings);
  });
  useEffectPrefs.subscribe(() => applyModes(useApp.getState().persisted.settings));
  reduceQuery?.addEventListener("change", () => applyModes(useApp.getState().persisted.settings));

  // CSS loops (the holo band) pause while the window is in the background.
  const root = document.documentElement;
  const syncBlur = () => toggleAttr(root, "data-app-blurred", !document.hasFocus() || document.visibilityState !== "visible");
  window.addEventListener("focus", syncBlur);
  window.addEventListener("blur", syncBlur);
  document.addEventListener("visibilitychange", syncBlur);
  syncBlur();

  // Esc leaves focus mode — but never steals Esc from a terminal (agents use it to interrupt),
  // an input, a menu or a dialog.
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || e.defaultPrevented || e.ctrlKey || e.altKey || e.shiftKey || e.metaKey) return;
    if (!useUi.getState().focusMode || isKeyCaptureSuspended()) return;
    const t = e.target as HTMLElement | null;
    if (t?.closest?.(".xterm, input, textarea, select, [role=menu], .menu, .pane-menu, [role=dialog], [aria-modal]")) return;
    useUi.getState().setFocusMode(false);
  });
}

installAppearance();
