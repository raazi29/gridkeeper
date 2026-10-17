// Bundled, offline fonts (no network). Each @font-face is split by unicode-range, so only the subsets a
// page actually renders are loaded.
//   Geist            — UI text
//   Geist Mono       — UI numerics, paths, labels
//   Space Grotesk    — brand wordmark / display only
//   JetBrains Mono   — optional terminal face
//   IBM Plex Mono    — Phosphor theme UI + optional terminal face

import "@fontsource-variable/geist/wght.css";
import "@fontsource-variable/geist-mono/wght.css";
import "@fontsource-variable/space-grotesk/wght.css";
import "@fontsource-variable/jetbrains-mono/wght.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";

/** Families bundled with the app, by CSS family name. */
export const BUNDLED_FAMILIES = ["Geist Variable", "Geist Mono Variable", "Space Grotesk Variable", "JetBrains Mono Variable", "IBM Plex Mono"] as const;

/** Terminal font presets offered in Settings (value = xterm fontFamily string). */
export const TERMINAL_FONTS: { label: string; value: string }[] = [
  { label: "Cascadia Mono", value: '"Cascadia Mono", "Cascadia Code", Consolas, monospace' },
  { label: "JetBrains Mono", value: '"JetBrains Mono Variable", "Cascadia Mono", Consolas, monospace' },
  { label: "Geist Mono", value: '"Geist Mono Variable", "Cascadia Mono", Consolas, monospace' },
  { label: "IBM Plex Mono", value: '"IBM Plex Mono", "Cascadia Mono", Consolas, monospace' },
];

/**
 * xterm measures cell metrics when the font option is set and does not re-measure when a web font
 * finishes loading later, so load a bundled face before terminals use it. Resolves within `timeoutMs`
 * either way; system fonts resolve immediately.
 */
export function preloadFont(fontFamily: string, timeoutMs = 1500): Promise<void> {
  const first = fontFamily.split(",")[0]?.trim().replace(/^["']|["']$/g, "") ?? "";
  if (!(BUNDLED_FAMILIES as readonly string[]).includes(first) || typeof document === "undefined" || !document.fonts) return Promise.resolve();
  const load = Promise.all([document.fonts.load(`13px "${first}"`), document.fonts.load(`bold 13px "${first}"`)]).then(() => undefined);
  const timeout = new Promise<void>((r) => setTimeout(r, timeoutMs));
  return Promise.race([load, timeout]).catch(() => undefined);
}
