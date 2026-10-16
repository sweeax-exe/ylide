// Every string exists in every language, with the same {{placeholders}} and
// <0>markup</0>. Plurals follow each language's own rules: English has "_one"
// and "_other", Russian "_one", "_few", "_many" and "_other", Japanese only
// "_other" (the categories of Intl.PluralRules).

import { describe, expect, it } from 'vitest';
import { LANGUAGES, languages } from '.';

type Dict = Record<string, unknown>;
const modules = import.meta.glob('./locales/*/*.json', { eager: true, import: 'default' }) as Record<string, Dict>;

const byLang: Record<string, Record<string, Dict>> = {};
for (const [path, data] of Object.entries(modules)) {
  const m = path.match(/\.\/locales\/([^/]+)\/([^/]+)\.json$/);
  if (m) (byLang[m[1]] ??= {})[m[2]] = data;
}

function flatten(obj: unknown, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj as Dict)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (typeof v === 'string') out[key] = v;
      else Object.assign(out, flatten(v, key));
    }
  }
  return out;
}

const PLURAL = /_(zero|one|two|few|many|other)$/;
const placeholders = (s: string) => [...s.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]).sort();
const markup = (s: string) => [...s.matchAll(/<\/?(\d+)>/g)].map((m) => m[0]).sort();
const categories = (lang: string) => new Intl.PluralRules(lang).resolvedOptions().pluralCategories.slice().sort();

/** Keys without plural suffix; plural keys grouped under their base. */
function shape(flat: Record<string, string>) {
  const plain = new Set<string>();
  const plurals = new Map<string, Set<string>>();
  for (const key of Object.keys(flat)) {
    const m = key.match(PLURAL);
    if (m) {
      const base = key.slice(0, -m[0].length);
      if (!plurals.has(base)) plurals.set(base, new Set());
      plurals.get(base)!.add(m[1]);
    } else plain.add(key);
  }
  return { plain, plurals };
}

describe('locales', () => {
  it('has a translation for every listed language, and only those', () => {
    expect(Object.keys(byLang).sort()).toEqual(LANGUAGES.map((l) => l.code).sort());
    expect(languages[0]).toBe('en');
  });

  it('has the same namespaces in every language', () => {
    for (const lang of Object.keys(byLang)) expect(Object.keys(byLang[lang]).sort(), lang).toEqual(Object.keys(byLang.en).sort());
  });

  for (const ns of Object.keys(byLang.en)) {
    it(`${ns}: same keys, placeholders and markup in every language`, () => {
      const en = flatten(byLang.en[ns]);
      const enShape = shape(en);
      for (const lang of Object.keys(byLang)) {
        const other = flatten(byLang[lang][ns]);
        const otherShape = shape(other);
        expect([...otherShape.plain].sort(), `${lang}/${ns}`).toEqual([...enShape.plain].sort());
        expect([...otherShape.plurals.keys()].sort(), `${lang}/${ns} plural keys`).toEqual([...enShape.plurals.keys()].sort());
        for (const [base, forms] of otherShape.plurals) {
          expect([...forms].sort(), `${lang}/${ns}: ${base} needs the plural forms of ${lang}`).toEqual(categories(lang));
        }
        for (const key of Object.keys(other)) {
          const m = key.match(PLURAL);
          const source = m ? (en[`${key.slice(0, -m[0].length)}_other`] ?? '') : en[key];
          // A singular form may say "one" instead of {{count}}.
          const expected = placeholders(source).filter((p) => !(m && m[1] !== 'other' && p === 'count'));
          const actual = placeholders(other[key]).filter((p) => !(m && m[1] !== 'other' && p === 'count'));
          expect(actual, `${lang}/${ns}: ${key}`).toEqual(expected);
          expect(markup(other[key]), `${lang}/${ns}: ${key} markup`).toEqual(markup(source));
          expect(other[key].trim().length, `${lang}/${ns}: ${key} is empty`).toBeGreaterThan(0);
        }
      }
    });
  }
});
