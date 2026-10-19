// Every catalog against the English source: same keys, valid syntax, same placeholders / tags / select cases,
// plural categories that exist in the language. Run after editing any src/i18n/locales/*.json.

import { describe, expect, it } from "vitest";
import en from "./locales/en.json";
import { messageShape } from "./format";
import { LOCALES, intlTag, type LocaleCode } from "./locales";
import { loadCatalog } from "./index";

const EN: Record<string, string> = en;
const EN_KEYS = Object.keys(EN);
const TRANSLATED = LOCALES.map((l) => l.code).filter((c) => c !== "en") as Exclude<LocaleCode, "en">[];

const sorted = (s: Iterable<string>) => [...s].sort();

describe("en.json (source)", () => {
  it("has non-empty string values that parse", () => {
    for (const [k, v] of Object.entries(EN)) {
      expect(typeof v, k).toBe("string");
      expect(v.trim().length, k).toBeGreaterThan(0);
      expect(() => messageShape(v), k).not.toThrow();
    }
  });
  it("uses dotted keys where no key is a prefix of another (nested JSON stays possible)", () => {
    const set = new Set(EN_KEYS);
    for (const k of EN_KEYS) {
      expect(k, k).toMatch(/^[a-z][A-Za-z0-9]*(\.[A-Za-z0-9][A-Za-z0-9-]*)+$/);
      const parts = k.split(".");
      for (let i = 1; i < parts.length; i++) expect(set.has(parts.slice(0, i).join(".")), `${parts.slice(0, i).join(".")} is a prefix of ${k}`).toBe(false);
    }
  });
});

describe.each(TRANSLATED)("%s catalog", (code) => {
  it("has exactly the English keys", async () => {
    const cat = await loadCatalog(code);
    const keys = new Set(Object.keys(cat));
    const missing = EN_KEYS.filter((k) => !keys.has(k));
    const extra = [...keys].filter((k) => !(k in EN));
    expect(missing, `missing in ${code}`).toEqual([]);
    expect(extra, `not in en.json`).toEqual([]);
  });

  it("matches English placeholders, tags, selects and plural syntax", async () => {
    const cat = await loadCatalog(code);
    const categories = new Set<string>(new Intl.PluralRules(intlTag(code)).resolvedOptions().pluralCategories);
    const problems: string[] = [];
    for (const key of EN_KEYS) {
      const value = cat[key];
      if (typeof value !== "string" || !value.trim()) {
        problems.push(`${key}: empty`);
        continue;
      }
      let tr;
      try {
        tr = messageShape(value);
      } catch (e) {
        problems.push(`${key}: ${(e as Error).message}`);
        continue;
      }
      const src = messageShape(EN[key]);
      if (sorted(tr.names).join() !== sorted(src.names).join()) problems.push(`${key}: params {${sorted(tr.names)}} ≠ English {${sorted(src.names)}}`);
      if (sorted(tr.tags).join() !== sorted(src.tags).join()) problems.push(`${key}: tags <${sorted(tr.tags)}> ≠ English <${sorted(src.tags)}>`);
      for (const [name, cases] of src.selects) {
        const mine = tr.selects.get(name);
        if (!mine || sorted(mine).join() !== sorted(cases).join()) problems.push(`${key}: select {${name}} cases differ from English`);
      }
      // A plural may become a plain {count} in a language without plural forms, but never a select.
      for (const name of src.plurals) if (tr.selects.has(name)) problems.push(`${key}: {${name}} must stay a plural`);
      for (const k of tr.pluralKeys) if (!k.startsWith("=") && !categories.has(k)) problems.push(`${key}: plural category "${k}" does not exist in ${code}`);
    }
    expect(problems).toEqual([]);
  });

  it("is actually translated (few long strings identical to English)", async () => {
    const cat = await loadCatalog(code);
    const same = EN_KEYS.filter((k) => cat[k] === EN[k] && EN[k].split(/\s+/).filter((w) => /^[A-Za-z]{3,}$/.test(w)).length >= 4);
    expect(same.length, `untranslated in ${code}: ${same.slice(0, 10).join(", ")}`).toBeLessThanOrEqual(Math.ceil(EN_KEYS.length * 0.02));
  });
});
