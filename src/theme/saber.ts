// Saber Duel blade colours: a theme with `saber: true` takes its signal colours from the user's preset
// (settings.saberColor). Pure data + one pure function so the contrast test can check every blade.

import { getTheme, type Theme } from "./themes";

export interface SaberPreset {
  id: string;
  name: string;
  /** Blade colour: focus frame, lamps, primary buttons. */
  accent: string;
  /** Lighter blade used as text on chrome (≥ 4.5:1 on bg-1 / bg-2). */
  accentFg: string;
  /** Text on a blade-coloured fill (≥ 4.5:1). */
  onAccent: string;
  /** White-hot core of the blade (secondary signal). */
  core: string;
}

export const SABER_PRESETS: readonly SaberPreset[] = [
  { id: "blue", name: "Blue", accent: "#3d9bff", accentFg: "#7ab8ff", onAccent: "#020a16", core: "#b9d9ff" },
  { id: "green", name: "Green", accent: "#3fdc5f", accentFg: "#72e88a", onAccent: "#021307", core: "#c4f7cf" },
  { id: "red", name: "Red", accent: "#ff3d3d", accentFg: "#ff7a7a", onAccent: "#160202", core: "#ffc4c4" },
  { id: "purple", name: "Purple", accent: "#a35cff", accentFg: "#c093ff", onAccent: "#0d0219", core: "#e2cfff" },
  { id: "amber", name: "Amber", accent: "#ffae1f", accentFg: "#ffc65a", onAccent: "#1a1000", core: "#ffe6b3" },
  { id: "white", name: "White", accent: "#e6ecf5", accentFg: "#f0f4fa", onAccent: "#0b0b0d", core: "#ffffff" },
];

export const DEFAULT_SABER = SABER_PRESETS[0].id;

export function getSaber(id: string | null | undefined): SaberPreset {
  return SABER_PRESETS.find((p) => p.id === id) ?? SABER_PRESETS[0];
}

/** The theme with the blade colour applied (themes without `saber` are returned unchanged). */
export function withSaber(theme: Theme, saberId: string | null | undefined): Theme {
  if (!theme.saber) return theme;
  const p = getSaber(saberId);
  return { ...theme, ui: { ...theme.ui, accent: p.accent, "accent-fg": p.accentFg, "on-accent": p.onAccent, "accent-2": p.core } };
}

/** The theme the UI should show for these settings (id + blade colour). */
export function resolveTheme(s: { theme: string; saberColor?: string }): Theme {
  return withSaber(getTheme(s.theme), s.saberColor);
}
