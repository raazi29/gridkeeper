// Terminal colours come from the active UI theme (src/theme/themes.ts), so the terminal and the chrome
// around it always match. registry.ts applies these on creation and whenever settings.theme changes.

import type { ITheme } from "@xterm/xterm";
import type { Settings } from "../lib/types";
import { searchDecorations, xtermTheme } from "../theme/themes";

/** xterm theme for the given settings (current theme id; unknown ids fall back to the default). */
export function getTerminalTheme(s: Pick<Settings, "theme">): ITheme {
  return xtermTheme(s.theme);
}

/** Search-match decoration colours for the given settings. */
export function getSearchDecorations(s: Pick<Settings, "theme">) {
  return searchDecorations(s.theme);
}

/** Extra terminal font size while presentation mode is on. */
export const PRESENTATION_FONT_BOOST = 3;
