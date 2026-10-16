// Parsing for settings fields. Inputs keep raw text while the user types and
// are only parsed when they are committed (blur, Enter, Save).

export interface NumberRule {
  min?: number;
  max?: number;
  integer?: boolean;
  /** An empty field is valid and means "use the default" (`null`). */
  optional?: boolean;
}

export type NumberProblem = 'required' | 'notNumber' | 'notInteger' | 'tooSmall' | 'tooLarge';

export type ParsedNumber = { ok: true; value: number | null } | { ok: false; problem: NumberProblem };

/** Parses a number field; accepts a decimal comma (German input) and ignores spaces. */
export function parseNumber(text: string, rule: NumberRule): ParsedNumber {
  const raw = text.replace(/[\s ]/g, '');
  if (raw === '') return rule.optional ? { ok: true, value: null } : { ok: false, problem: 'required' };
  if (!/^[-+]?(\d+([.,]\d*)?|[.,]\d+)$/.test(raw)) return { ok: false, problem: 'notNumber' };
  const value = Number(raw.replace(',', '.'));
  if (!Number.isFinite(value)) return { ok: false, problem: 'notNumber' };
  if (rule.integer && !Number.isInteger(value)) return { ok: false, problem: 'notInteger' };
  if (rule.min !== undefined && value < rule.min) return { ok: false, problem: 'tooSmall' };
  if (rule.max !== undefined && value > rule.max) return { ok: false, problem: 'tooLarge' };
  return { ok: true, value };
}

/** Text for a number field; `null` becomes an empty field. */
export function numberText(value: number | null): string {
  return value === null ? '' : String(value);
}

/** One entry per line; surrounding spaces and empty lines are dropped. */
export function parseLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

export function formatLines(lines: string[]): string {
  return lines.join('\n');
}

export function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Empty or whitespace-only text becomes `null` (optional string settings). */
export function optionalText(text: string): string | null {
  const t = text.trim();
  return t ? t : null;
}

/** True for an absolute http(s) URL. */
export function isHttpUrl(text: string): boolean {
  try {
    const u = new URL(text.trim());
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname.length > 0;
  } catch {
    return false;
  }
}
