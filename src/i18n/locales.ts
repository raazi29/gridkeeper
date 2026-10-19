// Supported UI languages and system-language matching (pure; unit-tested in node).

export interface LocaleInfo {
  code: string;
  /** The language's own name, shown in the language picker whatever the UI language is. */
  nativeName: string;
  /** English name (fallback when Intl.DisplayNames is unavailable). */
  englishName: string;
  dir: "ltr" | "rtl";
}

export const LOCALES = [
  { code: "en", nativeName: "English", englishName: "English", dir: "ltr" },
  { code: "es", nativeName: "Español", englishName: "Spanish", dir: "ltr" },
  { code: "pt-BR", nativeName: "Português (Brasil)", englishName: "Portuguese (Brazil)", dir: "ltr" },
  { code: "fr", nativeName: "Français", englishName: "French", dir: "ltr" },
  { code: "de", nativeName: "Deutsch", englishName: "German", dir: "ltr" },
  { code: "ja", nativeName: "日本語", englishName: "Japanese", dir: "ltr" },
  { code: "zh-CN", nativeName: "简体中文", englishName: "Chinese (Simplified)", dir: "ltr" },
  { code: "ko", nativeName: "한국어", englishName: "Korean", dir: "ltr" },
  { code: "hi", nativeName: "हिन्दी", englishName: "Hindi", dir: "ltr" },
  { code: "ru", nativeName: "Русский", englishName: "Russian", dir: "ltr" },
  { code: "ar", nativeName: "العربية", englishName: "Arabic", dir: "rtl" },
  { code: "tr", nativeName: "Türkçe", englishName: "Turkish", dir: "ltr" },
] as const satisfies readonly LocaleInfo[];

export type LocaleCode = (typeof LOCALES)[number]["code"];
/** The Settings choice: follow the system language, or a fixed locale. */
export type LanguagePref = "system" | LocaleCode;

export const SOURCE_LOCALE: LocaleCode = "en";

const BY_LOWER = new Map<string, LocaleCode>(LOCALES.map((l) => [l.code.toLowerCase(), l.code]));

/** Base language -> the locale that serves it when there is no exact match (pt-PT -> pt-BR, zh-TW -> zh-CN). */
const BY_BASE: Record<string, LocaleCode> = {
  en: "en",
  es: "es",
  pt: "pt-BR",
  fr: "fr",
  de: "de",
  ja: "ja",
  zh: "zh-CN",
  ko: "ko",
  hi: "hi",
  ru: "ru",
  ar: "ar",
  tr: "tr",
};

export function isLocaleCode(v: unknown): v is LocaleCode {
  return typeof v === "string" && LOCALES.some((l) => l.code === v);
}

export function isLanguagePref(v: unknown): v is LanguagePref {
  return v === "system" || isLocaleCode(v);
}

/**
 * The best supported locale for a list of BCP 47 tags in preference order (navigator.languages): the first tag
 * with an exact match or a supported base language wins; English when none matches.
 */
export function matchLocale(tags: readonly (string | null | undefined)[]): LocaleCode {
  for (const raw of tags) {
    if (!raw) continue;
    const tag = raw.trim().replace(/_/g, "-").toLowerCase();
    if (!tag) continue;
    const exact = BY_LOWER.get(tag);
    if (exact) return exact;
    const base = BY_BASE[tag.split("-")[0]];
    if (base) return base;
  }
  return SOURCE_LOCALE;
}

export function localeInfo(code: LocaleCode): LocaleInfo {
  return LOCALES.find((l) => l.code === code) ?? LOCALES[0];
}

export function dirOf(code: LocaleCode): "ltr" | "rtl" {
  return localeInfo(code).dir;
}

/**
 * Locale tag handed to Intl. Arabic keeps Western digits (0-9): numbers in the UI then match terminal output,
 * paths and version strings, which are always Latin.
 */
export function intlTag(code: LocaleCode): string {
  return code === "ar" ? "ar-u-nu-latn" : code;
}
