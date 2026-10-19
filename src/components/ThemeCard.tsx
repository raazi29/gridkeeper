// Theme card with a live miniature of the app in that theme (sidebar, pane, terminal lines).
// Shared by Settings › Appearance, the quick theme switcher and the welcome sheet. The card scopes the
// theme's CSS variables to itself, so it previews without touching the document.

import { memo } from "react";
import { isMessageKey, t as translate, useT } from "../i18n";
import { themeScopeStyle } from "../theme/applyTheme";
import type { Theme } from "../theme/themes";

/** A theme's description in the UI language (`theme.description.<camelCaseId>`); the English text in themes.ts as fallback. */
export function themeDescription(theme: Theme): string {
  const key = `theme.description.${theme.id.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase())}`;
  return isMessageKey(key) ? translate(key) : theme.description;
}

/** "dark" / "light" in the UI language. Theme names are names and stay as they are. */
export function themeKindLabel(kind: Theme["kind"]): string {
  return kind === "light" ? translate("theme.kindLight") : translate("theme.kindDark");
}

const PREVIEW_LINES = (t: Theme) => {
  const c = t.terminal;
  return [
    [
      [c.green, "❯ "],
      [c.blue, "claude "],
      [c.brightBlack, "--continue"],
    ],
    [
      [c.yellow, "● "],
      [c.foreground, "edit "],
      [c.cyan, "app.ts "],
      [c.brightBlack, "+12 −3"],
    ],
    [
      [c.green, "✓ 41 "],
      [c.red, "✗ 1 "],
      [c.magenta, "0.8s "],
      [c.brightBlack, "vitest"],
    ],
  ] as [string, string][][];
};

export interface ThemeCardProps {
  theme: Theme;
  selected: boolean;
  onSelect: () => void;
  /** Smaller card without the description (quick switcher, welcome sheet). */
  compact?: boolean;
  /** Hover / keyboard focus: the switcher previews the theme live. */
  onPreview?: () => void;
  tabIndex?: number;
}

export const ThemeCard = memo(function ThemeCard({ theme, selected, onSelect, compact, onPreview, tabIndex }: ThemeCardProps) {
  useT(); // re-render on a language change (description and kind are translated below)
  const description = themeDescription(theme);
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      className={`theme-card${selected ? " is-selected" : ""}${compact ? " theme-card--compact" : ""}`}
      style={themeScopeStyle(theme)}
      data-theme-scope={theme.id}
      data-theme-id={theme.id}
      data-autofocus={selected || undefined}
      tabIndex={tabIndex}
      onClick={onSelect}
      onMouseEnter={onPreview}
      onFocus={onPreview}
      title={description}
    >
      <span className="tcp" aria-hidden="true">
        <span className="tcp-side">
          <i className="is-on" />
          <i />
          <i />
        </span>
        <span className="tcp-main">
          <span className="tcp-pane">
            <span className="tcp-head">
              <b />
              <i />
            </span>
            <span className="tcp-term">
              {PREVIEW_LINES(theme).map((line, i) => (
                <span key={i} style={{ display: "block" }}>
                  {line.map(([color, text], j) => (
                    <span key={j} style={{ color }}>
                      {text}
                    </span>
                  ))}
                </span>
              ))}
            </span>
          </span>
        </span>
      </span>
      <span className="theme-card-meta">
        <span className="theme-card-name">{theme.name}</span>
        <span className="theme-card-kind">{themeKindLabel(theme.kind)}</span>
      </span>
      {!compact && <span className="theme-card-desc">{description}</span>}
    </button>
  );
});
