// i18n: one JSON file per feature and language (`locales/<lang>/<namespace>.json`).
// Features use their own namespace, e.g. `useTranslation('chat')`.

import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

type Dict = Record<string, unknown>;

const modules = import.meta.glob('./locales/*/*.json', { eager: true, import: 'default' }) as Record<string, Dict>;

export const resources: Record<string, Record<string, Dict>> = {};
for (const [path, data] of Object.entries(modules)) {
  const m = path.match(/\.\/locales\/([^/]+)\/([^/]+)\.json$/);
  if (!m) continue;
  const [, lng, ns] = m;
  (resources[lng] ??= {})[ns] = data;
}

/**
 * Every UI language: its name in that language (as language pickers show it),
 * the locale for numbers and dates, and Monaco's own translation if there is one.
 */
export const LANGUAGES = [
  { code: 'en', name: 'English', locale: 'en-US', monaco: null },
  { code: 'de', name: 'Deutsch', locale: 'de-DE', monaco: 'de' },
  { code: 'es', name: 'Español', locale: 'es-ES', monaco: 'es' },
  { code: 'fr', name: 'Français', locale: 'fr-FR', monaco: 'fr' },
  { code: 'pt', name: 'Português (Brasil)', locale: 'pt-BR', monaco: 'pt-br' },
  { code: 'zh', name: '简体中文', locale: 'zh-CN', monaco: 'zh-cn' },
  { code: 'ja', name: '日本語', locale: 'ja-JP', monaco: 'ja' },
  { code: 'ko', name: '한국어', locale: 'ko-KR', monaco: 'ko' },
  { code: 'ru', name: 'Русский', locale: 'ru-RU', monaco: 'ru' },
  { code: 'hi', name: 'हिन्दी', locale: 'hi-IN', monaco: null },
  { code: 'id', name: 'Bahasa Indonesia', locale: 'id-ID', monaco: null },
] as const;

type LanguageInfo = (typeof LANGUAGES)[number];
export type Language = LanguageInfo['code'];

/** The languages that have translations in this build, English first. */
export const languages: readonly Language[] = LANGUAGES.filter((l) => resources[l.code]).map((l) => l.code);

const info = (code: string): LanguageInfo => LANGUAGES.find((l) => l.code === code) ?? LANGUAGES[0];

/** Name of a language in that language, e.g. "Deutsch". */
export const languageName = (code: string): string => info(code).name;

/** Locale for numbers and dates in the given UI language. */
export const localeOf = (code: string): string => info(code).locale;

/** Monaco's translation for the given UI language, if Monaco has one. */
export const monacoLanguage = (code: string): string | null => info(code).monaco;

/** The saved choice if it is a known language, otherwise the first system language Ylide speaks. */
export function detectLanguage(preference?: string | null): Language {
  if (preference && (languages as readonly string[]).includes(preference)) return preference as Language;
  const wanted = typeof navigator !== 'undefined' ? (navigator.languages?.length ? navigator.languages : [navigator.language]) : [];
  for (const tag of wanted) {
    const primary = tag.toLowerCase().split('-')[0];
    const match = languages.find((l) => l === primary);
    if (match) return match;
  }
  return 'en';
}

void i18n.use(initReactI18next).init({
  resources,
  lng: detectLanguage(),
  fallbackLng: 'en',
  ns: Object.keys(resources.en ?? {}),
  defaultNS: 'common',
  interpolation: { escapeValue: false },
  returnNull: false,
});

export function setLanguage(preference?: string | null): void {
  const lng = detectLanguage(preference);
  if (i18n.language !== lng) void i18n.changeLanguage(lng);
  document.documentElement.lang = lng;
}

export default i18n;
