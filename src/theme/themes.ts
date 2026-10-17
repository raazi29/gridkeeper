// Theme registry: pure data (no DOM / store imports) so it can be unit-tested under node.
//
// A theme defines every BASE token below (enforced by the type). Derived tokens — hover shades, soft tints,
// focus rings, scrollbar thumbs — are computed in tokens.css with color-mix() from the base tokens, so a
// theme stays consistent without hand-tuning thirty values; a theme may still override them.
//
// To add a theme: append an object to THEMES (unique kebab-case id), run `npx vitest run src/theme` —
// the contrast test enforces the readability thresholds — and it shows up in Settings › Appearance and in
// the command palette automatically.

import type { ITheme } from "@xterm/xterm";

export const UI_TOKENS = [
  // surfaces, darkest/most-recessed first (for light themes: canvas first)
  "bg-0", // canvas behind panes
  "bg-1", // chrome: sidebar, headers, status bar
  "bg-2", // raised: menus, cards, dialogs
  "bg-3", // hover
  "bg-4", // pressed / selected
  "border", // hairline rules
  "border-strong", // control outlines
  "text-0", // primary
  "text-1", // secondary (≥ 4.5:1 on bg-0/1/2)
  "text-2", // muted labels (≥ 3:1)
  "accent", // the single signal colour
  "accent-2", // secondary signal (used sparingly: drag targets, streaks)
  "accent-fg", // accent used as text on chrome (≥ 4.5:1)
  "on-accent", // text on an accent fill (≥ 4.5:1)
  "ok",
  "warn",
  "err",
  "info",
  "ok-fg", // status colours used as text (≥ 4.5:1 on bg-1)
  "warn-fg",
  "err-fg",
  "shadow", // shadow colour (rgba)
  "backdrop", // modal scrim (rgba)
  "radius-s",
  "radius-m",
  "radius-l",
] as const;
export type UiToken = (typeof UI_TOKENS)[number];

/** Computed in tokens.css from the base tokens; optional per-theme overrides. */
export type DerivedToken = "accent-3" | "accent-soft" | "accent-ring" | "scroll-thumb" | "scroll-thumb-hover" | "selection";

export interface TerminalPalette {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export interface ThemeFonts {
  ui?: string;
  mono?: string;
  display?: string;
}

export interface Theme {
  id: string;
  name: string;
  description: string;
  kind: "dark" | "light";
  ui: Record<UiToken, string> & Partial<Record<DerivedToken, string>>;
  terminal: TerminalPalette;
  fonts?: ThemeFonts;
  effects?: { scanlines?: boolean; glow?: boolean };
}

export const DEFAULT_FONTS: Required<ThemeFonts> = {
  ui: '"Geist Variable", "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif',
  mono: '"Geist Mono Variable", "Cascadia Mono", Consolas, monospace',
  display: '"Space Grotesk Variable", "Geist Variable", "Segoe UI", sans-serif',
};

const R_SOFT = { "radius-s": "4px", "radius-m": "5px", "radius-l": "7px" };
const R_HARD = { "radius-s": "2px", "radius-m": "2px", "radius-l": "3px" };

// ---- the fleet -------------------------------------------------------------------------------

const deepSpace: Theme = {
  id: "deep-space",
  name: "Deep Space",
  description: "Blue-black neutrals, cool white text, one ion-blue signal.",
  kind: "dark",
  ui: {
    "bg-0": "#07090d",
    "bg-1": "#0c0f15",
    "bg-2": "#12161e",
    "bg-3": "#192029",
    "bg-4": "#212935",
    border: "#1a212b",
    "border-strong": "#29323f",
    "text-0": "#e7ecf4",
    "text-1": "#a2acbd",
    "text-2": "#6c7689",
    accent: "#4cc2ff",
    "accent-2": "#8b9dff",
    "accent-fg": "#7dd3ff",
    "on-accent": "#03121c",
    ok: "#3ddc97",
    warn: "#f5b84a",
    err: "#ff5c6c",
    info: "#6aa8ff",
    "ok-fg": "#5fe3aa",
    "warn-fg": "#f7c56b",
    "err-fg": "#ff8691",
    shadow: "rgba(0, 0, 0, 0.55)",
    backdrop: "rgba(3, 5, 9, 0.62)",
    ...R_SOFT,
  },
  terminal: {
    background: "#07090d",
    foreground: "#d5dbe6",
    cursor: "#4cc2ff",
    cursorAccent: "#07090d",
    selectionBackground: "rgba(76, 194, 255, 0.26)",
    black: "#1b212c",
    red: "#ff6b7a",
    green: "#5fd39a",
    yellow: "#f2c46d",
    blue: "#5ea8ff",
    magenta: "#c39bff",
    cyan: "#4fd6e6",
    white: "#c5cddb",
    brightBlack: "#5c6678",
    brightRed: "#ff8f9a",
    brightGreen: "#85e3b4",
    brightYellow: "#ffd88f",
    brightBlue: "#8cc2ff",
    brightMagenta: "#d6b8ff",
    brightCyan: "#7fe6f2",
    brightWhite: "#f2f5fa",
  },
};

const twinSuns: Theme = {
  id: "twin-suns",
  name: "Twin Suns",
  description: "Desert dusk: umber and sand, amber signal, rust highlights.",
  kind: "dark",
  ui: {
    "bg-0": "#120e0a",
    "bg-1": "#18130e",
    "bg-2": "#201912",
    "bg-3": "#2a2118",
    "bg-4": "#352a1f",
    border: "#2a2017",
    "border-strong": "#3e3125",
    "text-0": "#f2e7d7",
    "text-1": "#c3b099",
    "text-2": "#8c7965",
    accent: "#f0a43a",
    "accent-2": "#d9643a",
    "accent-fg": "#f5b965",
    "on-accent": "#1c1206",
    ok: "#a3c46b",
    warn: "#f0c24a",
    err: "#ec6a4c",
    info: "#86b6c9",
    "ok-fg": "#b4d085",
    "warn-fg": "#f4cf6f",
    "err-fg": "#f28c74",
    shadow: "rgba(0, 0, 0, 0.55)",
    backdrop: "rgba(10, 6, 2, 0.6)",
    ...R_SOFT,
  },
  terminal: {
    background: "#120e0a",
    foreground: "#eadac3",
    cursor: "#f0a43a",
    cursorAccent: "#120e0a",
    selectionBackground: "rgba(240, 164, 58, 0.24)",
    black: "#2e241b",
    red: "#e8735a",
    green: "#a8c46f",
    yellow: "#eab35a",
    blue: "#7fa7c4",
    magenta: "#cf8fa8",
    cyan: "#79bfae",
    white: "#d9c8b1",
    brightBlack: "#7d6c5a",
    brightRed: "#f2937d",
    brightGreen: "#c0d68d",
    brightYellow: "#f5cd82",
    brightBlue: "#9fc0d8",
    brightMagenta: "#e0a9be",
    brightCyan: "#9ad3c4",
    brightWhite: "#f7ecdc",
  },
};

const carbonite: Theme = {
  id: "carbonite",
  name: "Carbonite",
  description: "Graphite monochrome with a steel-blue trace. Built for twelve-hour sessions.",
  kind: "dark",
  ui: {
    "bg-0": "#111213",
    "bg-1": "#161719",
    "bg-2": "#1c1e20",
    "bg-3": "#242629",
    "bg-4": "#2d3033",
    border: "#25272a",
    "border-strong": "#35383c",
    "text-0": "#dcdfe3",
    "text-1": "#a1a6ad",
    "text-2": "#71767d",
    accent: "#86a3c0",
    "accent-2": "#a7b2be",
    "accent-fg": "#a3bbd3",
    "on-accent": "#0c1016",
    ok: "#82b08d",
    warn: "#cba86d",
    err: "#d27772",
    info: "#86a3c0",
    "ok-fg": "#9cc3a5",
    "warn-fg": "#d8bb89",
    "err-fg": "#e0938f",
    shadow: "rgba(0, 0, 0, 0.5)",
    backdrop: "rgba(6, 6, 7, 0.6)",
    ...R_SOFT,
  },
  terminal: {
    background: "#111213",
    foreground: "#cfd3d8",
    cursor: "#a3bbd3",
    cursorAccent: "#111213",
    selectionBackground: "rgba(134, 163, 192, 0.26)",
    black: "#2a2c2f",
    red: "#cd7f7b",
    green: "#8fb596",
    yellow: "#cfb27c",
    blue: "#84a2c0",
    magenta: "#a998bf",
    cyan: "#82b3b5",
    white: "#c2c6cc",
    brightBlack: "#6a6f76",
    brightRed: "#dc9c98",
    brightGreen: "#a9c9ae",
    brightYellow: "#ddc79c",
    brightBlue: "#a3bcd4",
    brightMagenta: "#c0b3d2",
    brightCyan: "#a2c8ca",
    brightWhite: "#eceef1",
  },
};

const icePlanet: Theme = {
  id: "ice-planet",
  name: "Ice Planet",
  description: "Daylight theme: frost whites, pale blue-greys, deep navy ink.",
  kind: "light",
  ui: {
    "bg-0": "#e9eff5",
    "bg-1": "#f3f6fa",
    "bg-2": "#ffffff",
    "bg-3": "#e2e9f1",
    "bg-4": "#d4dee9",
    border: "#d5dee8",
    "border-strong": "#b7c5d4",
    "text-0": "#0e1c30",
    "text-1": "#3c4d63",
    "text-2": "#64748a",
    accent: "#1b62d1",
    "accent-2": "#0b8aa2",
    "accent-fg": "#1955b5",
    "on-accent": "#ffffff",
    ok: "#1f8a55",
    warn: "#b37400",
    err: "#cc2b40",
    info: "#1b62d1",
    "ok-fg": "#156a40",
    "warn-fg": "#855400",
    "err-fg": "#b0233a",
    shadow: "rgba(22, 40, 66, 0.16)",
    backdrop: "rgba(204, 216, 230, 0.6)",
    "accent-soft": "rgba(27, 98, 209, 0.10)",
    "scroll-thumb": "rgba(14, 28, 48, 0.18)",
    "scroll-thumb-hover": "rgba(14, 28, 48, 0.3)",
    ...R_SOFT,
  },
  terminal: {
    background: "#fbfcfe",
    foreground: "#13233a",
    cursor: "#1b62d1",
    cursorAccent: "#fbfcfe",
    selectionBackground: "rgba(27, 98, 209, 0.18)",
    black: "#13233a",
    red: "#c42a3e",
    green: "#1b7a40",
    yellow: "#8c6200",
    blue: "#1d5fcf",
    magenta: "#9a3db3",
    cyan: "#0a7689",
    white: "#5d6c80",
    brightBlack: "#66768c",
    brightRed: "#d0374b",
    brightGreen: "#21854a",
    brightYellow: "#9a6c00",
    brightBlue: "#2d6cdc",
    brightMagenta: "#a94bc2",
    brightCyan: "#0b7b8e",
    brightWhite: "#3a4a5f",
  },
};

const imperial: Theme = {
  id: "imperial",
  name: "Imperial",
  description: "Pure black, stark white, crimson signal. Hard edges, maximum contrast.",
  kind: "dark",
  ui: {
    "bg-0": "#000000",
    "bg-1": "#070707",
    "bg-2": "#101010",
    "bg-3": "#1b1b1b",
    "bg-4": "#262626",
    border: "#222222",
    "border-strong": "#3a3a3a",
    "text-0": "#ffffff",
    "text-1": "#b5b5b5",
    "text-2": "#7d7d7d",
    accent: "#e5162c",
    "accent-2": "#ffffff",
    "accent-fg": "#ff4d5c",
    "on-accent": "#ffffff",
    ok: "#4fd17a",
    warn: "#ffc940",
    err: "#ff3b47",
    info: "#d9d9d9",
    "ok-fg": "#6ee094",
    "warn-fg": "#ffd466",
    "err-fg": "#ff6a73",
    shadow: "rgba(0, 0, 0, 0.8)",
    backdrop: "rgba(0, 0, 0, 0.72)",
    ...R_HARD,
  },
  terminal: {
    background: "#000000",
    foreground: "#f2f2f2",
    cursor: "#ff2a3c",
    cursorAccent: "#000000",
    selectionBackground: "rgba(229, 22, 44, 0.32)",
    black: "#1a1a1a",
    red: "#ff4d5a",
    green: "#5bd98a",
    yellow: "#ffd24d",
    blue: "#5c9dff",
    magenta: "#e07cff",
    cyan: "#4de1ff",
    white: "#d9d9d9",
    brightBlack: "#6e6e6e",
    brightRed: "#ff7a84",
    brightGreen: "#8af0b0",
    brightYellow: "#ffe28a",
    brightBlue: "#8cbaff",
    brightMagenta: "#eda6ff",
    brightCyan: "#8aecff",
    brightWhite: "#ffffff",
  },
};

const rebelSquadron: Theme = {
  id: "rebel-squadron",
  name: "Rebel Squadron",
  description: "Night-sortie navy with flight-suit orange. Pilot HUD energy.",
  kind: "dark",
  ui: {
    "bg-0": "#091021",
    "bg-1": "#0d1529",
    "bg-2": "#121c34",
    "bg-3": "#18243f",
    "bg-4": "#202e4d",
    border: "#1a2641",
    "border-strong": "#2a3a5c",
    "text-0": "#e9eef8",
    "text-1": "#a8b5ce",
    "text-2": "#7484a3",
    accent: "#ff7a1a",
    "accent-2": "#f2d36b",
    "accent-fg": "#ff9b52",
    "on-accent": "#1c0c00",
    ok: "#4cd18f",
    warn: "#ffc24d",
    err: "#ff5d5d",
    info: "#6fa8ff",
    "ok-fg": "#6fdca5",
    "warn-fg": "#ffcf73",
    "err-fg": "#ff8585",
    shadow: "rgba(2, 6, 16, 0.6)",
    backdrop: "rgba(4, 8, 20, 0.62)",
    "radius-s": "3px",
    "radius-m": "4px",
    "radius-l": "6px",
  },
  terminal: {
    background: "#091021",
    foreground: "#dbe3f2",
    cursor: "#ff7a1a",
    cursorAccent: "#091021",
    selectionBackground: "rgba(255, 122, 26, 0.26)",
    black: "#1c2741",
    red: "#ff6e6e",
    green: "#5fd49a",
    yellow: "#ffc457",
    blue: "#6ba6ff",
    magenta: "#c99bff",
    cyan: "#58d3e0",
    white: "#c8d2e4",
    brightBlack: "#62718f",
    brightRed: "#ff9393",
    brightGreen: "#8ae5b8",
    brightYellow: "#ffd78a",
    brightBlue: "#96c0ff",
    brightMagenta: "#dbbaff",
    brightCyan: "#86e2ec",
    brightWhite: "#f4f7fc",
  },
};

const hyperspace: Theme = {
  id: "hyperspace",
  name: "Hyperspace",
  description: "Indigo void with cyan and violet streaks. Status lamps glow.",
  kind: "dark",
  ui: {
    "bg-0": "#07061a",
    "bg-1": "#0b0a21",
    "bg-2": "#110f2b",
    "bg-3": "#191637",
    "bg-4": "#221e45",
    border: "#1c1939",
    "border-strong": "#2e2958",
    "text-0": "#eae8ff",
    "text-1": "#aba7d8",
    "text-2": "#7671a3",
    accent: "#41e2ff",
    "accent-2": "#a77bff",
    "accent-fg": "#7aeaff",
    "on-accent": "#031018",
    ok: "#4ef0b0",
    warn: "#ffcf5c",
    err: "#ff5c8a",
    info: "#a77bff",
    "ok-fg": "#74f4c2",
    "warn-fg": "#ffd97f",
    "err-fg": "#ff86a8",
    shadow: "rgba(2, 0, 14, 0.65)",
    backdrop: "rgba(4, 2, 18, 0.62)",
    ...R_SOFT,
  },
  terminal: {
    background: "#07061a",
    foreground: "#dddbf8",
    cursor: "#41e2ff",
    cursorAccent: "#07061a",
    selectionBackground: "rgba(167, 123, 255, 0.3)",
    black: "#1d1a3a",
    red: "#ff6b95",
    green: "#4fe3a6",
    yellow: "#ffd36b",
    blue: "#6f9fff",
    magenta: "#b98bff",
    cyan: "#45dcf5",
    white: "#c9c6ec",
    brightBlack: "#655f96",
    brightRed: "#ff93b2",
    brightGreen: "#85f0c4",
    brightYellow: "#ffe199",
    brightBlue: "#9bbdff",
    brightMagenta: "#d0b0ff",
    brightCyan: "#85ecfb",
    brightWhite: "#f4f3ff",
  },
  effects: { glow: true },
};

const phosphor: Theme = {
  id: "phosphor",
  name: "Phosphor",
  description: "P1 green CRT with optional scanlines. Monospace everything.",
  kind: "dark",
  ui: {
    "bg-0": "#030805",
    "bg-1": "#050d08",
    "bg-2": "#09150e",
    "bg-3": "#0e1f15",
    "bg-4": "#14291c",
    border: "#0f2218",
    "border-strong": "#1b3a28",
    "text-0": "#c4f7d1",
    "text-1": "#80c897",
    "text-2": "#4f8b63",
    accent: "#39ff7a",
    "accent-2": "#ffb000",
    "accent-fg": "#5cff94",
    "on-accent": "#021006",
    ok: "#39ff7a",
    warn: "#ffc23d",
    err: "#ff5f4f",
    info: "#5fe0c8",
    "ok-fg": "#5cff94",
    "warn-fg": "#ffcb5c",
    "err-fg": "#ff8577",
    shadow: "rgba(0, 0, 0, 0.7)",
    backdrop: "rgba(0, 6, 2, 0.7)",
    ...R_HARD,
  },
  terminal: {
    background: "#030805",
    foreground: "#9ff5b6",
    cursor: "#39ff7a",
    cursorAccent: "#030805",
    selectionBackground: "rgba(57, 255, 122, 0.22)",
    black: "#10251a",
    red: "#ff7a66",
    green: "#4cf07f",
    yellow: "#e8e36a",
    blue: "#5fb8ff",
    magenta: "#d38cff",
    cyan: "#4fe8c8",
    white: "#b8e8c4",
    brightBlack: "#4f7d5f",
    brightRed: "#ff9c8c",
    brightGreen: "#8cffaf",
    brightYellow: "#f5f29a",
    brightBlue: "#8fd0ff",
    brightMagenta: "#e3b0ff",
    brightCyan: "#8cf5dd",
    brightWhite: "#e6ffec",
  },
  fonts: {
    ui: '"IBM Plex Mono", "Cascadia Mono", Consolas, monospace',
    mono: '"IBM Plex Mono", "Cascadia Mono", Consolas, monospace',
    display: '"IBM Plex Mono", "Cascadia Mono", Consolas, monospace',
  },
  effects: { scanlines: true, glow: true },
};

const highContrast: Theme = {
  id: "high-contrast",
  name: "High Contrast",
  description: "Accessibility: white on black, yellow focus, heavy outlines.",
  kind: "dark",
  ui: {
    "bg-0": "#000000",
    "bg-1": "#000000",
    "bg-2": "#0a0a0a",
    "bg-3": "#1f1f1f",
    "bg-4": "#333333",
    border: "#8a8a8a",
    "border-strong": "#c0c0c0",
    "text-0": "#ffffff",
    "text-1": "#e6e6e6",
    "text-2": "#c4c4c4",
    accent: "#ffd60a",
    "accent-2": "#3ff0ff",
    "accent-fg": "#ffe14d",
    "on-accent": "#000000",
    ok: "#3dff8a",
    warn: "#ffd60a",
    err: "#ff5c5c",
    info: "#3ff0ff",
    "ok-fg": "#5cff9d",
    "warn-fg": "#ffe14d",
    "err-fg": "#ff8080",
    shadow: "rgba(0, 0, 0, 0.9)",
    backdrop: "rgba(0, 0, 0, 0.8)",
    "accent-soft": "rgba(255, 214, 10, 0.2)",
    "accent-ring": "#ffd60a",
    ...R_HARD,
  },
  terminal: {
    background: "#000000",
    foreground: "#ffffff",
    cursor: "#ffd60a",
    cursorAccent: "#000000",
    selectionBackground: "rgba(255, 214, 10, 0.4)",
    black: "#3a3a3a",
    red: "#ff6b6b",
    green: "#4dff91",
    yellow: "#ffe14d",
    blue: "#7ab0ff",
    magenta: "#ff8cff",
    cyan: "#5cf5ff",
    white: "#e6e6e6",
    brightBlack: "#a0a0a0",
    brightRed: "#ff9999",
    brightGreen: "#99ffbd",
    brightYellow: "#fff099",
    brightBlue: "#a8cbff",
    brightMagenta: "#ffb3ff",
    brightCyan: "#a3faff",
    brightWhite: "#ffffff",
  },
};

export const THEMES: readonly Theme[] = [deepSpace, twinSuns, carbonite, icePlanet, imperial, rebelSquadron, hyperspace, phosphor, highContrast];

export const DEFAULT_THEME_ID = deepSpace.id;

const byId = new Map(THEMES.map((t) => [t.id, t]));

/** The theme for an id; unknown / removed ids fall back to the default. */
export function getTheme(id: string | null | undefined): Theme {
  return (id && byId.get(id)) || deepSpace;
}

export function themeFonts(t: Theme): Required<ThemeFonts> {
  return { ...DEFAULT_FONTS, ...t.fonts };
}

/** Full xterm theme for a theme id (palette + derived scrollbar / inactive-selection colours). */
export function xtermTheme(id: string | null | undefined): ITheme {
  const t = getTheme(id);
  const light = t.kind === "light";
  const slider = light ? "14, 28, 48" : "255, 255, 255";
  return {
    ...t.terminal,
    selectionInactiveBackground: t.terminal.selectionBackground.replace(/[\d.]+\)$/, (a) => `${(parseFloat(a) * 0.55).toFixed(2)})`),
    scrollbarSliderBackground: `rgba(${slider}, ${light ? 0.16 : 0.08})`,
    scrollbarSliderHoverBackground: `rgba(${slider}, ${light ? 0.26 : 0.14})`,
    scrollbarSliderActiveBackground: `rgba(${slider}, ${light ? 0.34 : 0.2})`,
    overviewRulerBorder: "transparent",
  };
}

/** Search-match decorations in the theme's colours (xterm needs #RRGGBB). */
export function searchDecorations(id: string | null | undefined) {
  const t = getTheme(id);
  return {
    matchBackground: mixHex(t.terminal.background, t.ui.accent, 0.28),
    matchOverviewRuler: t.ui["text-2"].slice(0, 7),
    activeMatchBackground: mixHex(t.terminal.background, t.ui.accent, 0.6),
    activeMatchColorOverviewRuler: t.ui.accent.slice(0, 7),
  };
}

// ---- colour math (shared with the contrast test) ---------------------------------------------

export function parseColor(c: string): [number, number, number, number] {
  const s = c.trim();
  if (s.startsWith("#")) {
    const h = s.slice(1);
    const full = h.length === 3 ? h.replace(/./g, (x) => x + x) : h;
    return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16), full.length >= 8 ? parseInt(full.slice(6, 8), 16) / 255 : 1];
  }
  const m = s.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const [r, g, b, a] = m[1].split(",").map((x) => parseFloat(x));
    return [r, g, b, a ?? 1];
  }
  throw new Error(`unsupported colour: ${c}`);
}

function toHex(n: number) {
  return Math.round(Math.min(255, Math.max(0, n)))
    .toString(16)
    .padStart(2, "0");
}

/** Linear sRGB mix of two opaque colours; t = weight of `b`. */
export function mixHex(a: string, b: string, t: number): string {
  const [ar, ag, ab] = parseColor(a);
  const [br, bg, bb] = parseColor(b);
  return `#${toHex(ar + (br - ar) * t)}${toHex(ag + (bg - ag) * t)}${toHex(ab + (bb - ab) * t)}`;
}

export function relativeLuminance(c: string): number {
  const [r, g, b] = parseColor(c).map((v, i) => (i < 3 ? v / 255 : v));
  const lin = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG 2.x contrast ratio between two opaque colours. */
export function contrast(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
