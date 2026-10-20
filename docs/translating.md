# Translating Gridkeeper

Gridkeeper's interface ships in 12 languages. English is the source. The other 11 catalogs started as
**machine-assisted translations**: they were checked for consistent terminology, placeholders and tone, but not
every language has been reviewed by a native speaker yet. If a phrase reads oddly, is too long for its button, or
uses the wrong term for your platform, a pull request is very welcome. Small fixes are fine: one string is a
perfectly good PR.

| Code | Language | Catalog |
|---|---|---|
| `en` | English (source) | [`src/i18n/locales/en.json`](../src/i18n/locales/en.json) |
| `es` | Español | [`es.json`](../src/i18n/locales/es.json) |
| `pt-BR` | Português (Brasil) | [`pt-BR.json`](../src/i18n/locales/pt-BR.json) |
| `fr` | Français | [`fr.json`](../src/i18n/locales/fr.json) |
| `de` | Deutsch | [`de.json`](../src/i18n/locales/de.json) |
| `ja` | 日本語 | [`ja.json`](../src/i18n/locales/ja.json) |
| `zh-CN` | 简体中文 | [`zh-CN.json`](../src/i18n/locales/zh-CN.json) |
| `ko` | 한국어 | [`ko.json`](../src/i18n/locales/ko.json) |
| `hi` | हिन्दी | [`hi.json`](../src/i18n/locales/hi.json) |
| `ru` | Русский | [`ru.json`](../src/i18n/locales/ru.json) |
| `ar` | العربية (right-to-left) | [`ar.json`](../src/i18n/locales/ar.json) |
| `tr` | Türkçe | [`tr.json`](../src/i18n/locales/tr.json) |

How the runtime works (keys, syntax, what is never translated) is in [`src/i18n/README.md`](../src/i18n/README.md).

## Fixing a translation

1. Find the English text in `src/i18n/locales/en.json`; note its key (e.g. `"settings.terminal.cursorBlink"`).
2. Change the value of the same key in your language's file. Keep the key, and keep every `{placeholder}`,
   `<tag>…</tag>` and the plural / select structure (details below).
3. Check it: `npx vitest run src/i18n` (every catalog must have every key with matching placeholders).
4. See it: Settings › Interface › Language. In a dev build (`npm run tauri dev`, or the sandbox instance described
   in [CONTRIBUTING.md](../CONTRIBUTING.md)) the change shows after a reload.
5. Open a PR titled e.g. `i18n(de): clearer wording for the paste warning`.

You don't need Rust or a Tauri build to translate: Node and `npm install` are enough to run the check.

## Rules for every language

- **Placeholders** such as `{name}`, `{count}`, `{error}` must appear exactly as in English (same names, no
  translation of the name). You may move them anywhere in the sentence.
- **Plurals**: `{count, plural, one {# session} other {# sessions}}`. Keep the variable and the word `plural`;
  translate the branches and use your language's plural categories: `one` / `other` (German, Spanish, French,
  Portuguese, Hindi, Turkish; `many` is also accepted for large numbers in Spanish, French and Portuguese),
  `one` / `few` / `many` / `other` (Russian), `zero` / `one` / `two` / `few` / `many` / `other` (Arabic), only
  `other` (Japanese, Chinese, Korean). `#` is the number. `=0 {…}` matches exactly zero.
- **Select**: `{os, select, macos {…} other {…}}`. Keep the variable and the case keys (`macos`, `other`), translate
  only the text inside the braces.
- **Tags**: `<code>--settings</code>` renders as code. Keep the tags and the code inside them unchanged.
- **Don't translate**: product names (Gridkeeper, Claude Code, Codex, PowerShell, Mission Control, WebGL, WebView2,
  Windows Terminal, Explorer, Finder), file names, command lines, environment variables, key names inside
  shortcuts written as `⌘C` or `Ctrl+letter` (but see `keys.*` below), and anything inside `<code>`.
- **Keep it short**: buttons, tabs and segmented options sit in narrow spaces. Prefer the shortest natural wording.
- **Typography**: use your language's quotation marks (the English `“{name}”` may become `„{name}“`, `« {name} »`,
  `«{name}»`, `「{name}」` …), keep `…` (one character) where English has it, and no trailing period on labels.
- **Text typed into agents stays English.** You won't find mission briefs, hand-off messages or `team.md` text in
  the catalogs: agents and shared files are English-first, by design.
- **`keys.*`** are keyboard key caps (`Ctrl`, `Shift`, `Del`, `PgDn` …). Use the labels printed on keyboards sold
  in your language (German `Strg`, `Umschalt`, `Entf`; French `Maj`, `Suppr`; Spanish `Mayús`, `Supr`); where
  keyboards are printed in English, keep English.

## Style per language

| Language | Address | Conventions and key terms |
|---|---|---|
| Español | tú | Buttons in infinitive (Guardar, Cerrar). One variant throughout (Agregar, video, costo). sesión, espacio de trabajo, panel, agente; rama, commit, worktree. Flota, Comunicaciones, Difusión, Inspector, Diagnóstico, Cambios, Cuentas, Skills, Formaciones, Bitácora de vuelo, Repetición. Key caps Mayús, Supr, AvPág. |
| Português (Brasil) | você | Buttons in infinitive (Salvar, Fechar). sessão, espaço de trabalho, painel, agente; branch, commit, worktree stay English. Frota, Comunicações, Transmissão, Inspetor, Diagnóstico, Alterações, Contas, Skills, Formações, Diário de bordo, Replay. English key caps. |
| Français | vous | Buttons in infinitive (Enregistrer, Fermer). Non-breaking space before `: ; ! ? %` and inside « ». session, espace de travail, volet, agent; branche, commit, worktree. Flotte, Transmissions, Diffusion, Inspecteur, Diagnostics, Modifications, Comptes, Skills, Formations, Journal de bord, Replay de mission. Key caps Maj, Suppr, Échap. |
| Deutsch | Sie | Nouns capitalized, compounds joined or hyphenated (Projektordner, Git-Status). Buttons in infinitive. Sitzung, Arbeitsbereich, Bereich, Agent; Branch, Commit, Worktree stay English. Flotte, Funk, Rundruf, Inspektor, Diagnose, Änderungen, Konten, Skills, Formationen, Logbuch, Missions-Replay. Quotes „…“. Key caps Strg, Umschalt, Entf. |
| 日本語 | です・ます for sentences; nouns for labels | Katakana loanwords with the final long vowel (フォルダー). Half-width space between Japanese and Latin letters or digits. Quotes 「…」. セッション, ワークスペース, ペイン, エージェント; ブランチ, コミット, worktree. フリート, 通信, 一斉送信, インスペクター, スキル, フライトログ, ミッションリプレイ. English key caps. |
| 简体中文 | no pronoun where possible (你 when needed) | Full-width punctuation, half-width space between Chinese and Latin letters or digits. 会话, 工作区, 窗格, 代理; 分支, 提交, worktree (working tree 工作树). 舰队, 通讯, 广播, 检查器, 技能, 编队, 飞行日志, 任务回放. English key caps. |
| 한국어 | 합니다 / 하세요 | Labels and buttons as nouns (저장, 닫기). 세션, 작업 영역, 창, 에이전트; 브랜치, 커밋, worktree. 함대, 통신, 일괄 전송, 검사기, 스킬, 비행 기록, 미션 리플레이. Quotes ‘…’. English key caps. |
| हिन्दी | आप | Common technical nouns transliterated in Devanagari (सेशन, वर्कस्पेस, पेन, एजेंट, ब्रांच, कमिट); product names and code stay Latin. फ़्लीट, कॉम्स, ब्रॉडकास्ट, इंस्पेक्टर, स्किल्स, फ़्लाइट लॉग, मिशन रीप्ले. English key caps. |
| Русский | вы (lower case) | Buttons in infinitive (Сохранить). Quotes «…». сеанс, рабочая область, панель, агент; ветка, коммит, worktree. Флот, Связь, Рассылка, Инспектор, Навыки, Бортовой журнал, Повтор миссии. Plurals always use one / few / many / other. English key caps. |
| العربية | formal Modern Standard Arabic | Right-to-left; Western digits (0-9). Product names, paths and code stay Latin and left-to-right. Quotes «…». Buttons as verbal nouns (حفظ، إغلاق). جلسة، مساحة عمل، لوحة، وكيل؛ فرع، إيداع، worktree. الأسطول، الاتصالات، البث، الفاحص، المهارات، سجل الطيران، إعادة المهمة. Plurals use zero / one / two / few / many / other. English key caps. |
| Türkçe | siz | Buttons as short imperatives (Kaydet, Kapat); placeholders placed where they need no case suffix. oturum, çalışma alanı, bölme; dal, commit, worktree. Filo, İletişim, toplu gönderim, Denetçi, Beceriler, Uçuş günlüğü, Görev tekrarı. English key caps. |

*Mission Control* and the theme names stay English everywhere. Other feature names describe what they do and are
translated. The command palette also matches English command ids, so an English name still finds the command.

## Adding a language

1. Add the locale to `LOCALES` in `src/i18n/locales.ts` (code, native name, English name, `dir`), its base language
   in `BY_BASE`, and a loader in `LOADERS` in `src/i18n/index.ts`.
2. Copy `en.json` to `<code>.json` and translate every value.
3. `npx vitest run src/i18n` and fix what it reports (plural categories are checked against `Intl.PluralRules`).
4. Add a row to the style table above and to the table at the top.

## For developers adding UI text

Add the English message to `en.json` and use it through `t()` / `useT()` (see `src/i18n/README.md`). A new key
makes `catalogs.test.ts` fail for the other languages until they have it too: add the English text to each catalog
as a placeholder if you can't translate it, and mention it in the PR, or translate it with your best effort and
say so. Never build sentences from translated fragments.
