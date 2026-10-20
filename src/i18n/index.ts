// UI translation runtime: `t(key, params?)`, `useT()`, the language setting, and Intl formatting for the
// current locale. English (./locales/en.json) is bundled and is the typed source of keys; every other catalog is
// loaded on demand (dynamic import, one chunk per language). Message syntax: ./format.ts. Guide: ./README.md.
//
// Rules for callers:
// - Never call `t()` at module top level (it would freeze the text in the language active at import time).
//   Call it in render (components use `const t = useT()`, which also re-renders on a language change) or in the
//   function that produces the text (toasts, menus, confirm dialogs).
// - Command ids, keybinding ids, settings values and anything written to disk or typed into agents never go
//   through `t()`: agents, briefs, hand-off messages, team.md and the outbox protocol are English-first.

import { createElement, Fragment, type ReactNode } from "react";
import { create } from "zustand";
import en from "./locales/en.json";
import { dateFormat, formatMessage, formatParts, numberFormat, type ParamValue, type Params, type PartParams } from "./format";
import { LOCALES, SOURCE_LOCALE, dirOf, intlTag, isLanguagePref, localeInfo, matchLocale, type LanguagePref, type LocaleCode } from "./locales";

export { LOCALES, dirOf, isLanguagePref, isLocaleCode, localeInfo, matchLocale } from "./locales";
export type { LanguagePref, LocaleCode, LocaleInfo } from "./locales";
export type { Params } from "./format";

export type MessageKey = keyof typeof en;
type Catalog = Readonly<Record<string, string>>;

const EN: Catalog = en;

const LOADERS: Record<Exclude<LocaleCode, "en">, () => Promise<{ default: Catalog }>> = {
  es: () => import("./locales/es.json"),
  "pt-BR": () => import("./locales/pt-BR.json"),
  fr: () => import("./locales/fr.json"),
  de: () => import("./locales/de.json"),
  ja: () => import("./locales/ja.json"),
  "zh-CN": () => import("./locales/zh-CN.json"),
  ko: () => import("./locales/ko.json"),
  hi: () => import("./locales/hi.json"),
  ru: () => import("./locales/ru.json"),
  ar: () => import("./locales/ar.json"),
  tr: () => import("./locales/tr.json"),
};

const overrides = new Map<LocaleCode, Catalog>();

/** Tests only: serve `catalog` for `code` instead of the bundled file (null restores it). */
export function __overrideCatalogForTests(code: LocaleCode, catalog: Catalog | null): void {
  if (catalog) overrides.set(code, catalog);
  else overrides.delete(code);
}

/** Load a locale's catalog (English is bundled). Exposed for the catalog tests. */
export async function loadCatalog(code: LocaleCode): Promise<Catalog> {
  const o = overrides.get(code);
  if (o) return o;
  if (code === "en") return EN;
  return (await LOADERS[code]()).default;
}

// ---- current locale --------------------------------------------------------------

let locale: LocaleCode = SOURCE_LOCALE;
let intl = intlTag(SOURCE_LOCALE);
let catalog: Catalog = EN;
const warned = new Set<string>();

const DEV = (() => {
  try {
    return Boolean(import.meta.env?.DEV);
  } catch {
    return false;
  }
})();

function lookup(key: string): string {
  const v = catalog[key];
  if (v !== undefined) return v;
  const fallback = EN[key];
  if (DEV && !warned.has(`${locale}:${key}`)) {
    warned.add(`${locale}:${key}`);
    console.warn(fallback === undefined ? `[i18n] unknown message key "${key}"` : `[i18n] "${key}" missing in ${locale}; using English`);
  }
  return fallback ?? key;
}

/** True when `key` is a message key (for keys built at runtime, e.g. `command.${id}`). */
export function isMessageKey(key: string): key is MessageKey {
  return Object.prototype.hasOwnProperty.call(EN, key);
}

/** Translate `key` into the current language. Missing translations fall back to English. */
export function t(key: MessageKey, params?: Params): string {
  return formatMessage(lookup(key), params, intl);
}

/** Rich-text params: values, React nodes, and `<tag>` renderers such as `code: (c) => <code>{c}</code>`. */
export type RichParams = Record<string, ParamValue | ReactNode | ((chunks: ReactNode) => ReactNode)>;

/** Translate to React nodes: `<tag>…</tag>` markers call the param of the same name, node params are inserted. */
export function rich(key: MessageKey, params?: RichParams): ReactNode {
  const p: PartParams = {};
  for (const [k, v] of Object.entries(params ?? {})) {
    p[k] = typeof v === "function" ? (children: unknown[]) => (v as (c: ReactNode) => ReactNode)(createElement(Fragment, null, ...(children as ReactNode[]))) : v;
  }
  let parts: unknown[];
  try {
    parts = formatParts(lookup(key), p, intl);
  } catch {
    parts = [lookup(key)];
  }
  return createElement(Fragment, null, ...(parts as ReactNode[]));
}

export function getLocale(): LocaleCode {
  return locale;
}

/** The locale tag for Intl / toLocale*String calls (Arabic keeps Western digits). */
export function intlLocale(): string {
  return intl;
}

export function formatNumber(n: number, opts?: Intl.NumberFormatOptions): string {
  return numberFormat(intl, opts).format(n);
}

export function formatDate(d: Date | number, opts?: Intl.DateTimeFormatOptions): string {
  return dateFormat(intl, opts).format(d);
}

/** A language's name in the current UI language ("Deutsch" -> "German" / "Allemand"); English name as fallback. */
export function languageName(code: LocaleCode): string {
  try {
    // zh-Hans names the script ("Simplified Chinese"), which is what the zh-CN catalog is; zh-CN would say "(China)".
    const name = new Intl.DisplayNames([intl], { type: "language" }).of(code === "zh-CN" ? "zh-Hans" : code);
    if (name && name !== code) return name;
  } catch {
    // Intl.DisplayNames unavailable
  }
  return localeInfo(code).englishName;
}

// ---- React binding ------------------------------------------------------------------

export interface Translator {
  (key: MessageKey, params?: Params): string;
  rich: typeof rich;
  locale: LocaleCode;
}

function makeTranslator(): Translator {
  const fn = ((key: MessageKey, params?: Params) => t(key, params)) as Translator;
  fn.rich = rich;
  fn.locale = locale;
  return fn;
}

interface I18nState {
  locale: LocaleCode;
  pref: LanguagePref;
  dir: "ltr" | "rtl";
  /** New identity on every language change, so `useT()` callers re-render. */
  t: Translator;
}

export const useI18n = create<I18nState>()(() => ({ locale: SOURCE_LOCALE, pref: "system", dir: "ltr", t: makeTranslator() }));

/** The translator for components: re-renders the caller when the language changes. */
export function useT(): Translator {
  return useI18n((s) => s.t);
}

// ---- language setting (per machine: localStorage) ------------------------------------
// Stored like the other per-machine UI prefs (welcome, flight log) because it must be known synchronously at boot,
// before workspaces.json is loaded, so the first frame is already in the right language and direction.

export const LANGUAGE_STORAGE_KEY = "gridkeeper.language";

export function readLanguagePref(): LanguagePref {
  try {
    const v = globalThis.localStorage?.getItem(LANGUAGE_STORAGE_KEY);
    return isLanguagePref(v) ? v : "system";
  } catch {
    return "system";
  }
}

function writeLanguagePref(pref: LanguagePref) {
  try {
    if (pref === "system") globalThis.localStorage?.removeItem(LANGUAGE_STORAGE_KEY);
    else globalThis.localStorage?.setItem(LANGUAGE_STORAGE_KEY, pref);
  } catch {
    // storage unavailable: the choice lasts for this run
  }
}

/** The system's preferred languages (navigator.languages), most preferred first. */
export function systemLanguages(): readonly string[] {
  const nav = (globalThis as { navigator?: { languages?: readonly string[]; language?: string } }).navigator;
  if (!nav) return [];
  if (nav.languages && nav.languages.length > 0) return nav.languages;
  return nav.language ? [nav.language] : [];
}

/** The locale a preference resolves to right now. */
export function resolveLanguage(pref: LanguagePref): LocaleCode {
  return pref === "system" ? matchLocale(systemLanguages()) : pref;
}

function applyDocument(code: LocaleCode) {
  const root = (globalThis as { document?: Document }).document?.documentElement;
  if (!root) return;
  root.lang = code;
  root.dir = dirOf(code);
}

let applySeq = 0;

async function applyLocale(code: LocaleCode, pref: LanguagePref): Promise<void> {
  const seq = ++applySeq;
  let cat: Catalog = EN;
  let chosen = code;
  if (code !== SOURCE_LOCALE) {
    try {
      cat = await loadCatalog(code);
    } catch (e) {
      console.warn(`[i18n] could not load ${code}; using English`, e);
      chosen = SOURCE_LOCALE;
    }
  }
  if (seq !== applySeq) return; // a later change won
  locale = chosen;
  intl = intlTag(chosen);
  catalog = cat;
  applyDocument(chosen);
  useI18n.setState({ locale: chosen, pref, dir: dirOf(chosen), t: makeTranslator() });
}

/** Change the UI language (Settings › Interface › Language). Resolves once the catalog is active. */
export async function setLanguage(pref: LanguagePref): Promise<void> {
  writeLanguagePref(pref);
  await applyLocale(resolveLanguage(pref), pref);
}

let systemListener = false;

/**
 * Boot: apply the saved preference before the first render (main.tsx awaits this; a non-English catalog is one
 * small local chunk). Follows system language changes while the preference is "system".
 */
export async function initI18n(): Promise<void> {
  const pref = readLanguagePref();
  await applyLocale(resolveLanguage(pref), pref);
  const w = (globalThis as { window?: Window }).window;
  if (w && !systemListener) {
    systemListener = true;
    w.addEventListener("languagechange", () => {
      const cur = useI18n.getState().pref;
      if (cur === "system") void applyLocale(resolveLanguage("system"), "system");
    });
  }
}

/** Every supported locale code (source first). */
export const LOCALE_CODES: readonly LocaleCode[] = LOCALES.map((l) => l.code);
