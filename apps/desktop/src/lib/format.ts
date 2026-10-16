// Number and size formatting that follows the UI language.

import i18n, { localeOf } from '../i18n';

const locale = () => localeOf(i18n.language);

/** Bytes as GB with one decimal (decimal units, like download pages). */
export function formatGB(bytes: number, digits = 1): string {
  return new Intl.NumberFormat(locale(), { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(bytes / 1e9);
}

/** Bytes as GiB with one decimal (binary units, like VRAM sizes). */
export function formatGiB(bytes: number, digits = 1): string {
  return new Intl.NumberFormat(locale(), { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(bytes / 1024 ** 3);
}

export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let u = 0;
  while (v >= 1000 && u < units.length - 1) {
    v /= 1000;
    u++;
  }
  return `${new Intl.NumberFormat(locale(), { maximumFractionDigits: u >= 2 ? 1 : 0 }).format(v)} ${units[u]}`;
}

export function formatNumber(n: number, digits = 0): string {
  return new Intl.NumberFormat(locale(), { maximumFractionDigits: digits }).format(n);
}

/** 131072 -> "128K" */
export function formatTokens(n: number): string {
  if (n >= 1024 && n % 1024 === 0) return `${n / 1024}K`;
  if (n >= 1000) return `${formatNumber(n / 1000, 1)}K`;
  return String(n);
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '–';
  if (seconds < 60) return `${Math.round(seconds)} s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m < 60) return `${m}:${String(s).padStart(2, '0')} min`;
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')} h`;
}
