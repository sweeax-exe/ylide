// Small pure helpers for presenting agent data.

import { localeOf } from '../../i18n';

/** Elapsed milliseconds as a clock: "0:42", "12:05", "1:02:03". */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** Wall-clock time of day, e.g. "14:03:27". */
export function formatTimeOfDay(ms: number, language: string): string {
  return new Intl.DateTimeFormat(localeOf(language), { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(ms);
}

export interface TextPart {
  code: boolean;
  text: string;
}

/** Splits "run `npm test` now" into plain and `code` parts. */
export function splitCode(text: string): TextPart[] {
  const parts: TextPart[] = [];
  const re = /`([^`]+)`/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) parts.push({ code: false, text: text.slice(last, m.index) });
    parts.push({ code: true, text: m[1] });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ code: false, text: text.slice(last) });
  return parts;
}

const ARG_KEYS = ['path', 'command', 'query', 'pattern', 'to', 'question', 'summary', 'title'];

/** The one argument worth showing next to a tool name, e.g. the path of read_file. */
export function summarizeArgs(args: string | null, max = 80): string {
  if (!args) return '';
  let value: unknown;
  try {
    value = JSON.parse(args);
  } catch {
    return clip(args.replace(/\s+/g, ' ').trim(), max);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const obj = value as Record<string, unknown>;
  for (const key of ARG_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return clip(v.replace(/\s+/g, ' ').trim(), max);
  }
  return '';
}

export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** CSS colour of a role's world line. */
export function roleColor(role: string): string {
  if (role === 'orchestrator') return 'var(--text-2)';
  if (role === 'coder') return 'var(--accent)';
  if (role === 'reviewer') return 'var(--metal)';
  return 'var(--text-1)';
}
