import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatMessage, formatParts, messageShape, parseMessage } from "./format";
import { dirOf, intlTag, matchLocale } from "./locales";
import {
  LANGUAGE_STORAGE_KEY,
  __overrideCatalogForTests,
  formatNumber,
  getLocale,
  intlLocale,
  isMessageKey,
  languageName,
  readLanguagePref,
  resolveLanguage,
  rich,
  setLanguage,
  t,
  useI18n,
  type MessageKey,
} from "./index";
import { COMMANDS, THEME_COMMAND_PREFIX, commandTitle } from "../actions/commands";

describe("formatMessage", () => {
  it("passes plain text through, apostrophes included", () => {
    expect(formatMessage("Can't stop now", undefined, "en")).toBe("Can't stop now");
  });
  it("substitutes {name} params; numbers are not grouped; missing params are empty", () => {
    expect(formatMessage("Close “{name}”?", { name: "api" }, "en")).toBe("Close “api”?");
    expect(formatMessage("Port {port}", { port: 51730 }, "en")).toBe("Port 51730");
    expect(formatMessage("[{missing}]", {}, "en")).toBe("[]");
  });
  it("formats {n, number} for the locale", () => {
    expect(formatMessage("{n, number} MB", { n: 1234.5 }, "en")).toBe("1,234.5 MB");
    expect(formatMessage("{n, number} MB", { n: 1234.5 }, "de")).toBe("1.234,5 MB");
  });
  it("picks plural branches with Intl.PluralRules, exact =N first, # is the formatted count", () => {
    const msg = "{count, plural, =0 {no sessions} one {# session} other {# sessions}}";
    expect(formatMessage(msg, { count: 0 }, "en")).toBe("no sessions");
    expect(formatMessage(msg, { count: 1 }, "en")).toBe("1 session");
    expect(formatMessage(msg, { count: 1200 }, "en")).toBe("1,200 sessions");
  });
  it("handles languages with more plural categories (ru, ar)", () => {
    const ru = "{n, plural, one {# сессия} few {# сессии} many {# сессий} other {# сессии}}";
    expect(formatMessage(ru, { n: 1 }, "ru")).toBe("1 сессия");
    expect(formatMessage(ru, { n: 3 }, "ru")).toBe("3 сессии");
    expect(formatMessage(ru, { n: 5 }, "ru")).toBe("5 сессий");
    const ar = "{n, plural, zero {لا شيء} one {واحد} two {اثنان} few {# قليل} many {# كثير} other {# آخر}}";
    expect(formatMessage(ar, { n: 0 }, intlTag("ar"))).toBe("لا شيء");
    expect(formatMessage(ar, { n: 2 }, intlTag("ar"))).toBe("اثنان");
    expect(formatMessage(ar, { n: 11 }, intlTag("ar"))).toBe("11 كثير"); // Western digits for Arabic
  });
  it("selects branches and falls back to other", () => {
    const msg = "Reveal in {os, select, macos {Finder} linux {the file manager} other {Explorer}}";
    expect(formatMessage(msg, { os: "macos" }, "en")).toBe("Reveal in Finder");
    expect(formatMessage(msg, { os: "beos" }, "en")).toBe("Reveal in Explorer");
  });
  it("nests plural inside select and keeps # bound to the plural", () => {
    const msg = "{kind, select, live {{n, plural, one {# running} other {# running}} first} other {none}}";
    expect(formatMessage(msg, { kind: "live", n: 2 }, "en")).toBe("2 running first");
  });
  it("strips rich-text tags in plain strings and leaves unmatched < as text", () => {
    expect(formatMessage("a <code>--settings</code> file", undefined, "en")).toBe("a --settings file");
    expect(formatMessage("<0.1% CPU", undefined, "en")).toBe("<0.1% CPU");
    expect(formatMessage("<repo>-worktrees/<branch>", undefined, "en")).toBe("<repo>-worktrees/<branch>");
  });
  it("returns a malformed message unchanged instead of throwing", () => {
    expect(formatMessage("broken {count, plural, one {x}", { count: 1 }, "en")).toBe("broken {count, plural, one {x}");
    expect(() => parseMessage("{n, plural, one {x}}")).toThrow(); // no "other"
  });
  it("formatParts passes opaque params and tag renderers through", () => {
    const parts = formatParts("Use <b>{name}</b> now {icon}", { name: "pwsh", b: (c: unknown[]) => ({ bold: c }), icon: { el: 1 } }, "en");
    expect(parts).toEqual(["Use ", { bold: ["pwsh"] }, " now ", { el: 1 }]);
  });
  it("messageShape lists names, plurals, selects and tags", () => {
    const s = messageShape("{a} {n, plural, one {# x} other {# xs}} {k, select, p {q} other {r}} <code>{b}</code>");
    expect([...s.names].sort()).toEqual(["a", "b", "k", "n"]);
    expect([...s.plurals]).toEqual(["n"]);
    expect([...(s.selects.get("k") ?? [])].sort()).toEqual(["other", "p"]);
    expect([...s.tags]).toEqual(["code"]);
  });
});

describe("matchLocale", () => {
  it("matches exact tags case-insensitively and with underscores", () => {
    expect(matchLocale(["pt-BR"])).toBe("pt-BR");
    expect(matchLocale(["zh-cn"])).toBe("zh-CN");
    expect(matchLocale(["fr_CA"])).toBe("fr");
  });
  it("maps base languages: pt -> pt-BR, zh -> zh-CN, regional variants -> base", () => {
    expect(matchLocale(["pt"])).toBe("pt-BR");
    expect(matchLocale(["pt-PT"])).toBe("pt-BR");
    expect(matchLocale(["zh-TW"])).toBe("zh-CN");
    expect(matchLocale(["zh-Hans-CN"])).toBe("zh-CN");
    expect(matchLocale(["de-AT"])).toBe("de");
    expect(matchLocale(["en-GB"])).toBe("en");
    expect(matchLocale(["ar-EG"])).toBe("ar");
  });
  it("walks the preference list and falls back to English", () => {
    expect(matchLocale(["xx-YY", "ja-JP", "de"])).toBe("ja");
    expect(matchLocale(["nl-NL", "sv"])).toBe("en");
    expect(matchLocale([])).toBe("en");
    expect(matchLocale([null, undefined, ""])).toBe("en");
  });
  it("knows text direction and Intl tags", () => {
    expect(dirOf("ar")).toBe("rtl");
    expect(dirOf("he" as never)).toBe("ltr");
    expect(dirOf("de")).toBe("ltr");
    expect(intlTag("ar")).toBe("ar-u-nu-latn");
    expect(intlTag("pt-BR")).toBe("pt-BR");
  });
});

describe("runtime", () => {
  const root = { lang: "", dir: "" };
  const store = new Map<string, string>();

  beforeEach(() => {
    vi.stubGlobal("document", { documentElement: root });
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
  });
  afterEach(async () => {
    __overrideCatalogForTests("de", null);
    await setLanguage("en");
    store.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("is English by default and formats params", () => {
    expect(getLocale()).toBe("en");
    expect(t("common.cancel")).toBe("Cancel");
    expect(t("command.closeSession.title", { name: "api" })).toBe("Close “api”?");
    expect(t("command.toast.ports", { count: 1 })).toBe("1 listening port in your sessions");
    expect(t("command.toast.ports", { count: 3 })).toBe("3 listening ports in your sessions");
  });

  it("switches language, sets <html lang dir>, persists the choice and notifies subscribers", async () => {
    const seen: string[] = [];
    const unsub = useI18n.subscribe((s) => seen.push(s.locale));
    await setLanguage("ar");
    expect(getLocale()).toBe("ar");
    expect(root).toEqual({ lang: "ar", dir: "rtl" });
    expect(intlLocale()).toBe("ar-u-nu-latn");
    expect(store.get(LANGUAGE_STORAGE_KEY)).toBe("ar");
    expect(readLanguagePref()).toBe("ar");
    expect(t("common.cancel")).not.toBe("Cancel");
    await setLanguage("de");
    expect(root).toEqual({ lang: "de", dir: "ltr" });
    expect(formatNumber(1234.5)).toBe("1.234,5");
    unsub();
    expect(seen).toEqual(["ar", "de"]);
  });

  it("gives every useT() caller a new translator identity on change", async () => {
    const before = useI18n.getState().t;
    await setLanguage("fr");
    const after = useI18n.getState().t;
    expect(after).not.toBe(before);
    expect(after.locale).toBe("fr");
  });

  it("'system' follows navigator.languages and is not stored", async () => {
    vi.stubGlobal("navigator", { languages: ["pt-PT", "en-US"], language: "pt-PT" });
    expect(resolveLanguage("system")).toBe("pt-BR");
    await setLanguage("system");
    expect(getLocale()).toBe("pt-BR");
    expect(store.has(LANGUAGE_STORAGE_KEY)).toBe(false);
    expect(useI18n.getState().pref).toBe("system");
  });

  it("names languages in the current UI language", async () => {
    expect(languageName("de")).toBe("German");
    expect(languageName("zh-CN")).toBe("Simplified Chinese");
    await setLanguage("de");
    expect(languageName("ja")).toBe("Japanisch");
  });

  it("ignores an unknown stored preference", () => {
    store.set(LANGUAGE_STORAGE_KEY, "tlh");
    expect(readLanguagePref()).toBe("system");
  });

  it("falls back to English for a key missing in the catalog, warning once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    __overrideCatalogForTests("de", { "common.cancel": "Abbrechen" });
    await setLanguage("de");
    expect(t("common.cancel")).toBe("Abbrechen");
    expect(t("common.close")).toBe("Close");
    expect(t("common.close")).toBe("Close");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/common\.close.*de/);
  });

  it("returns the key itself for an unknown key", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(t("no.such.key" as MessageKey)).toBe("no.such.key");
    expect(isMessageKey("no.such.key")).toBe(false);
    expect(isMessageKey("common.cancel")).toBe(true);
  });

  it("renders rich text with tag renderers", () => {
    const html = renderToStaticMarkup(createElement("p", null, rich("settings.agents.costMeterDisclosure", { code: (c) => createElement("code", null, c) })));
    expect(html).toContain("<code>--settings</code>");
    expect(html).toContain("<code>statusLine</code>");
    expect(html).not.toContain("&lt;code");
  });
});

describe("command titles", () => {
  it("every command has a catalog title (never the raw id)", () => {
    for (const c of COMMANDS) {
      expect(c.title, c.id).not.toBe(c.id);
      expect(c.title.length, c.id).toBeGreaterThan(0);
    }
  });
  it("builds theme and focus titles from templates and keeps ids stable", () => {
    expect(commandTitle("session.focus3")).toBe("Focus pane 3");
    const theme = COMMANDS.find((c) => c.id.startsWith(THEME_COMMAND_PREFIX));
    expect(theme?.title).toMatch(/^Theme: /);
    expect(commandTitle("session.new")).toBe("New session…");
  });
  it("titles follow the language", async () => {
    await setLanguage("de");
    expect(commandTitle("session.new")).not.toBe("New session…");
    await setLanguage("en");
    expect(commandTitle("session.new")).toBe("New session…");
  });
});
