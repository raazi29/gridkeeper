// Terminal theme derived from the design tokens (tokens.css). xterm needs literal colors, so the
// values are mirrored here; keep them in sync with --bg-0 / --accent.

import type { ITheme } from "@xterm/xterm";

export const TERMINAL_BG = "#0b0b0e";

/** Refined dark theme: calm, readable ANSI colors on near-black (no neon). */
export const terminalTheme: ITheme = {
  background: TERMINAL_BG,
  foreground: "#d9d9e3",
  cursor: "#8b5cf6",
  cursorAccent: TERMINAL_BG,
  selectionBackground: "rgba(123, 97, 255, 0.35)",
  selectionInactiveBackground: "rgba(123, 97, 255, 0.18)",
  scrollbarSliderBackground: "rgba(255, 255, 255, 0.08)",
  scrollbarSliderHoverBackground: "rgba(255, 255, 255, 0.14)",
  scrollbarSliderActiveBackground: "rgba(255, 255, 255, 0.2)",
  overviewRulerBorder: "transparent",

  black: "#2a2a33",
  red: "#e5646e",
  green: "#7cc48a",
  yellow: "#e2b86b",
  blue: "#6fa8f5",
  magenta: "#b48ef7",
  cyan: "#5fc3c9",
  white: "#c9c9d4",
  brightBlack: "#686877",
  brightRed: "#f4838b",
  brightGreen: "#98d9a5",
  brightYellow: "#efcb8a",
  brightBlue: "#8fbdfa",
  brightMagenta: "#c9a8fb",
  brightCyan: "#82d6db",
  brightWhite: "#ececf1",
};
