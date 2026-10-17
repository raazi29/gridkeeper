// Saber effects (every theme, strongest in Saber Duel): pure decisions only — effect level, blade colour,
// the sound rate limit and the "duel" detector — so they are unit-tested under node. The DOM side lives
// in applyTheme.ts (root attributes + blade variables), layout/saberBlade.ts (pane ignition) and
// components/SaberDuel.tsx.

import type { SaberEffectsMode } from "../lib/types";
import { getSaber, SABER_PRESETS } from "./saber";
import type { Theme } from "./themes";

export type SaberLevel = "off" | "subtle" | "full";

/** Ignition sweep (focus gained / session started), ms. */
export const IGNITE_MS = 260;
/** Ignite + fade back to the theme's own focus line (subtle mode, unfocused panes), ms. */
export const IGNITE_SETTLE_MS = 400;
/** Retract on exit / stop, ms. */
export const RETRACT_MS = 180;
/** Crossed blades near the bell, ms. */
export const DUEL_MS = 600;
/** Two sessions of one group finishing within this window = a duel. */
export const DUEL_WINDOW_MS = 1500;
/** At most one blade sound per this interval. */
export const SOUND_GAP_MS = 600;

/** The effect level for a setting + theme. "auto" (and unknown values) = full with a saber theme, subtle elsewhere. */
export function resolveSaberLevel(mode: SaberEffectsMode | string | undefined, theme: Pick<Theme, "saber">, reducedMotion: boolean): SaberLevel {
  if (reducedMotion) return "off";
  if (mode === "off" || mode === "subtle" || mode === "full") return mode;
  return theme.saber ? "full" : "subtle";
}

export interface Blade {
  /** Coloured edge + glow. */
  color: string;
  /** White-hot core. */
  core: string;
  /** Preset id, or null when the blade follows the theme accent. */
  preset: string | null;
}

function parseHex(c: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c.trim());
  if (!m) return null;
  const h = m[1].length === 3 ? [...m[1]].map((x) => x + x).join("") : m[1];
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

/** `a` mixed toward `b` by `t` (0 = a, 1 = b). Non-hex input returns `a` unchanged. */
export function mixHex(a: string, b: string, t: number): string {
  const x = parseHex(a);
  const y = parseHex(b);
  if (!x || !y) return a;
  const k = Math.max(0, Math.min(1, t));
  return `#${x.map((v, i) => Math.round(v + (y[i] - v) * k).toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Blade colour for a theme: saber themes always use the preset (it is also their accent); other themes
 * follow their own accent until the user picks a blade colour (`saberBladeFromTheme: false`).
 */
export function resolveBlade(theme: Theme, s: { saberColor?: string; saberBladeFromTheme?: boolean }): Blade {
  const light = theme.kind === "light";
  if (theme.saber || s.saberBladeFromTheme === false) {
    const p = getSaber(s.saberColor);
    // A white blade would vanish on a light canvas: use a steel edge there, keep the white core.
    if (light && p.id === "white") return { color: theme.ui["text-2"], core: "#ffffff", preset: p.id };
    return { color: p.accent, core: p.core, preset: p.id };
  }
  const accent = theme.ui.accent;
  return { color: accent, core: mixHex(accent, "#ffffff", light ? 0.45 : 0.72), preset: null };
}

/** The opposing blade in a duel: a classic contrast for presets, the theme's secondary signal otherwise. */
export function duelPartner(blade: Blade, theme: Theme): string {
  const pairs: Record<string, string> = { blue: "red", red: "blue", green: "purple", purple: "green", amber: "blue", white: "red" };
  if (blade.preset) return getSaber(pairs[blade.preset] ?? SABER_PRESETS[2].id).accent;
  return theme.ui["accent-2"];
}

/** Next blade preset (cycling); from "follow the theme" it starts at the first preset. */
export function nextSaberColor(current: string | undefined, fromTheme: boolean): string {
  if (fromTheme) return SABER_PRESETS[0].id;
  const i = SABER_PRESETS.findIndex((p) => p.id === current);
  return SABER_PRESETS[(i + 1) % SABER_PRESETS.length].id;
}

/** `allow(now)` is true at most once per `gapMs` (pass a monotonic clock, e.g. performance.now()). */
export function createRateLimiter(gapMs: number): (now: number) => boolean {
  let last = Number.NEGATIVE_INFINITY;
  return (now) => {
    if (now - last < gapMs) return false;
    last = now;
    return true;
  };
}

/**
 * Feed it every session that just finished ("done"); returns true when a different session of the same
 * group finished within `windowMs` before it. A detected duel consumes both finishes.
 */
export function createDuelDetector(windowMs = DUEL_WINDOW_MS): (groupId: string, sessionId: string, now: number) => boolean {
  const last = new Map<string, { id: string; at: number }>();
  return (groupId, sessionId, now) => {
    const prev = last.get(groupId);
    if (prev && prev.id !== sessionId && now - prev.at <= windowMs) {
      last.delete(groupId);
      return true;
    }
    last.set(groupId, { id: sessionId, at: now });
    return false;
  };
}
