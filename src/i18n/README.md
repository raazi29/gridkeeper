# UI translations (`src/i18n`)

Gridkeeper's interface is available in 12 languages: English (source), Spanish, Portuguese (Brazil), French,
German, Japanese, Chinese (Simplified), Korean, Hindi, Russian, Arabic (right-to-left) and Turkish.

> **The non-English catalogs are machine-assisted translations.** They were reviewed for consistency, placeholders
> and tone, not by a native speaker of every language. Corrections are very welcome: see
> [docs/translating.md](../../docs/translating.md).

## Files

| File | What |
|---|---|
| `index.ts` | Runtime: `t()`, `useT()`, `rich()`, language setting, `formatNumber` / `formatDate`, lazy catalog loading. |
| `format.ts` | ICU-lite message parser and formatter (pure, tested in node). |
| `locales.ts` | Supported locales, native names, system-language matching, text direction. |
| `locales/en.json` | **The source catalog.** Its keys are the `MessageKey` type: a typo in a key is a type error. |
| `locales/<code>.json` | One catalog per language, same keys as `en.json`. Loaded on demand (one chunk each). |
| `i18n.test.ts`, `catalogs.test.ts` | Formatter / runtime tests; every catalog has every key with matching placeholders. |

## Using it

```tsx
import { t, useT } from "../i18n";

function Panel() {
  const t = useT(); // re-renders this component when the language changes
  return <button title={t("fleet.refreshTitle")}>{t("common.refresh")}</button>;
}

notify("info", t("command.toast.ports", { count: n })); // outside components: plain t()
```

- **Never call `t()` at module top level.** The text would be frozen in the language that was active when the
  module loaded. Store a `MessageKey` in static tables and translate at render time (see `SECTIONS` in
  `SettingsDialog.tsx`), or make the property a getter (see `AGENT_LABEL` in `components/util/session.ts` and the
  command titles in `actions/commands.ts`).
- Components call `const t = useT()`; everything else imports `t`.
- One key per **whole sentence**. Don't glue translated fragments together: word order differs between languages.
  Use separate keys, `{x, select, …}` or `{n, plural, …}` instead.
- Rich text: `t.rich("settings.agents.costMeterHint", { code: (c) => <code>{c}</code> })` renders `<code>…</code>`
  markers in the message. Plain `t()` strips the markers.
- Numbers, dates: `formatNumber`, `formatDate`, or `intlLocale()` for `toLocale*String` calls.
- Keys built at runtime: check with `isMessageKey(key)` first.

### What is never translated

- Command ids, keybinding ids, settings values, file formats, IPC.
- **Text typed into agents or written to files**: mission briefs, hand-off messages, `team.md`, the outbox
  protocol, `mission.md`. Agents and those files are English-first; translating them would make agents misread
  instructions and make shared files depend on one person's UI language.
- Terminal content.
- Product and tool names: Gridkeeper, Claude Code, Codex, PowerShell, WebGL, WebView2, git, npm.

## Message syntax

| Syntax | Example |
|---|---|
| `{name}` | `Close “{name}”?` (values inserted as text: numbers are not grouped, so ports stay `5173`) |
| `{n, number}` | `{n, number} MB` (locale grouping and decimals) |
| `{d, date}` / `{d, time}` | `Last run {when, time}` |
| `{n, plural, …}` | `{count, plural, one {# session} other {# sessions}}` (`#` = the formatted number, `=0 {…}` exact match) |
| `{x, select, …}` | `{os, select, macos {Finder} other {Explorer}}` |
| `<tag>…</tag>` | `starts Claude with a <code>--settings</code> file` |

No escaping: braces are always syntax and an apostrophe is an ordinary character. Plural categories follow
`Intl.PluralRules` for each language (Russian uses `one` / `few` / `many` / `other`, Arabic adds `zero` and `two`,
Japanese, Chinese and Korean only need `other`).

## Keys

- Flat, dotted, lowerCamel segments, grouped by area: `settings.terminal.renderer`, `command.session.new`,
  `fleet.empty`. Areas: `common`, `settings`, `command`, `keys`, `palette`, `session`, `pick`, `platform`, `shell`,
  `pane`, `menu`, …
- No key is a dotted prefix of another (`a.b` and `a.b.c` can't both exist), so the catalogs could become nested
  JSON later. The tests enforce it.
- `common.*` holds only words used verbatim in many places (Cancel, Close, Browse…). When a context could need a
  different translation, give it its own key.
- Command titles live at `command.<command id>`.

## Language setting

Settings › Interface › Language: *System default* (follows `navigator.languages`: `pt-PT` → Português (Brasil),
`zh-TW` → 简体中文, unmatched → English) or a fixed language. Stored per machine in `localStorage`
(`gridkeeper.language`) so the first frame is already in the right language and direction, before
`workspaces.json` is loaded. A missing translation falls back to English (with a dev-only console warning).

## Right-to-left

Choosing Arabic sets `<html lang="ar" dir="rtl">`. The shell mirrors (flex rows follow the direction; the CSS uses
logical properties such as `margin-inline-start` / `inset-inline-end` where it matters, and
`src/styles/i18n.css` holds the RTL-specific rules). Terminals, code, paths, key combos and other monospace text
stay left-to-right. The pane grid keeps its left-to-right order (pane 1 top left, as `Alt+1` and "Move left /
right" expect); each pane's own header is right-to-left. Chevrons carry `icon-dir` and mirror. Arabic numbers use
Western digits (0-9) so they match terminal output and version strings.

Mission Control's stylesheets (`mission.css`, `missionBoard.css`, `leadControl.css`, `mcDrag.css`,
`signoff.css`) still use physical `left` / `right` in places: they are converted together with the Mission Control
strings.
