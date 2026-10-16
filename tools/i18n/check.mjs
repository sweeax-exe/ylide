#!/usr/bin/env node
// Checks one language of the app and the website against English: the same
// keys, {{placeholders}} and <0>markup</0>, plural forms by the language's own
// rules, and no empty strings. The app test (src/i18n/parity.test.ts) checks
// all languages at once; this script is for working on a single one.
//
//   node tools/i18n/check.mjs ru          app and website
//   node tools/i18n/check.mjs ar --site   website only

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const lang = process.argv[2];
const siteOnly = process.argv.includes('--site');
if (!lang) {
  console.error('usage: node tools/i18n/check.mjs <lang> [--site]');
  process.exit(2);
}

/** BCP 47 tags behind the folder codes, for the plural rules. */
const TAGS = { pt: 'pt-BR', zh: 'zh-Hans' };
const PLURAL = /_(zero|one|two|few|many|other)$/;
const problems = [];

const flatten = (obj, prefix = '') =>
  Object.entries(obj).reduce((out, [k, v]) => {
    const key = prefix ? `${prefix}.${k}` : k;
    return typeof v === 'string' ? { ...out, [key]: v } : { ...out, ...flatten(v, key) };
  }, {});
const placeholders = (s) => [...s.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]).sort().join(',');
const markup = (s) => [...s.matchAll(/<\/?[a-z0-9]+>/gi)].map((m) => m[0].toLowerCase()).sort().join(',');
const categories = new Intl.PluralRules(TAGS[lang] ?? lang).resolvedOptions().pluralCategories.slice().sort().join(',');

function compare(label, en, other, { skip = [] } = {}) {
  const e = flatten(en);
  const o = flatten(other);
  const base = (k) => k.replace(PLURAL, '');
  const enPlurals = new Set(Object.keys(e).filter((k) => PLURAL.test(k)).map(base));
  for (const key of Object.keys(e)) {
    if (skip.some((s) => key === s || key.startsWith(`${s}.`))) continue;
    if (PLURAL.test(key)) continue;
    if (!(key in o)) problems.push(`${label}: missing ${key}`);
  }
  for (const b of enPlurals) {
    const forms = Object.keys(o).filter((k) => PLURAL.test(k) && base(k) === b).map((k) => k.match(PLURAL)[1]).sort().join(',');
    if (forms !== categories) problems.push(`${label}: ${b} has plural forms [${forms}], ${lang} needs [${categories}]`);
  }
  for (const [key, value] of Object.entries(o)) {
    const m = key.match(PLURAL);
    const source = m ? e[`${base(key)}_other`] : e[key];
    if (source === undefined) {
      if (!skip.some((s) => key.startsWith(s))) problems.push(`${label}: extra key ${key}`);
      continue;
    }
    if (!value.trim()) problems.push(`${label}: ${key} is empty`);
    const strip = (p) => (m && m[1] !== 'other' ? p.split(',').filter((x) => x && x !== 'count').join(',') : p);
    if (strip(placeholders(value)) !== strip(placeholders(source))) problems.push(`${label}: ${key} placeholders {${placeholders(value)}} instead of {${placeholders(source)}}`);
    if (markup(value) !== markup(source)) problems.push(`${label}: ${key} markup [${markup(value)}] instead of [${markup(source)}]`);
  }
}

if (!siteOnly) {
  const enDir = join(root, 'apps', 'desktop', 'src', 'i18n', 'locales', 'en');
  const dir = join(root, 'apps', 'desktop', 'src', 'i18n', 'locales', lang);
  for (const file of readdirSync(enDir)) {
    const path = join(dir, file);
    if (!existsSync(path)) {
      problems.push(`app: missing file locales/${lang}/${file}`);
      continue;
    }
    let other;
    try {
      other = JSON.parse(readFileSync(path, 'utf8'));
    } catch (e) {
      problems.push(`app: locales/${lang}/${file} is not valid JSON: ${e.message}`);
      continue;
    }
    compare(`app ${file}`, JSON.parse(readFileSync(join(enDir, file), 'utf8')), other);
  }
}

const sitePath = join(root, 'website', 'src', 'i18n', `${lang}.json`);
if (existsSync(sitePath) || siteOnly) {
  if (!existsSync(sitePath)) problems.push(`website: missing website/src/i18n/${lang}.json`);
  else {
    const en = JSON.parse(readFileSync(join(root, 'website', 'src', 'i18n', 'en.json'), 'utf8'));
    const other = JSON.parse(readFileSync(sitePath, 'utf8'));
    // Legal pages exist in English and German only.
    const skip = lang === 'de' ? [] : ['privacyPage', 'imprintPage'];
    compare('website', en, other, { skip: [...skip, 'dir'] });
  }
}

if (problems.length) {
  console.log(problems.join('\n'));
  console.log(`\n${problems.length} problem(s) in ${lang}`);
  process.exit(1);
}
console.log(`${lang}: no problems`);
