// Presentation helpers for project search and quick open.

/** Splits the glob field ("*.ts, !test/**") into the core's glob list. */
export function parseGlobs(input: string): string[] {
  return input
    .split(/[,\n]/)
    .map((g) => g.trim())
    .filter(Boolean);
}

export interface Segment {
  text: string;
  match: boolean;
}

export interface LinePreview {
  segments: Segment[];
  /** Text before the first match was cut off. */
  clipped: boolean;
}

/**
 * Splits a result line into plain and matched parts. `ranges` count Unicode
 * characters (code points), like the core reports them. Leading indentation
 * is dropped, and a long lead before the first match is shortened so the
 * match stays visible in a narrow sidebar.
 */
export function previewLine(line: string, ranges: Array<[number, number]>, maxLead = 28): LinePreview {
  const chars = Array.from(line);
  let from = 0;
  while (from < chars.length && /\s/.test(chars[from])) from++;
  const sorted = ranges
    .map(([a, b]) => [Math.max(0, Math.min(a, chars.length)), Math.max(0, Math.min(b, chars.length))] as [number, number])
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  const firstMatch = sorted[0]?.[0] ?? from;
  from = Math.min(from, firstMatch);
  let clipped = false;
  if (firstMatch - from > maxLead) {
    from = firstMatch - Math.floor(maxLead / 2);
    clipped = true;
  }
  const segments: Segment[] = [];
  let at = from;
  const push = (end: number, match: boolean) => {
    if (end <= at) return;
    segments.push({ text: chars.slice(at, end).join(''), match });
    at = end;
  };
  for (const [a, b] of sorted) {
    if (b <= at) continue;
    push(a, false);
    push(b, true);
  }
  push(chars.length, false);
  return { segments, clipped };
}

/** "src/cart.ts:12" -> path query and line. */
export function parseQuickOpen(input: string): { query: string; line: number | null } {
  const m = input.trim().match(/^(.*?)(?::(\d+))?:?$/);
  const query = (m?.[1] ?? input).trim();
  const line = m?.[2] ? Number(m[2]) : null;
  return { query, line: line && line > 0 ? line : null };
}

/**
 * Indices (UTF-16) of `path` characters to highlight for `query`. Prefers a
 * contiguous hit in the file name, then anywhere in the path, then a fuzzy
 * subsequence matched from the end so the file name wins.
 */
export function matchIndices(query: string, path: string): number[] {
  // Like the core's file search, backslashes in the query mean '/'.
  const q = query.toLowerCase().replace(/\\/g, '/').replace(/\s+/g, '');
  if (!q) return [];
  const lower = path.toLowerCase();
  const nameStart = path.lastIndexOf('/') + 1;
  const range = (start: number) => Array.from({ length: q.length }, (_, i) => start + i);
  const inName = lower.indexOf(q, nameStart);
  if (inName >= 0) return range(inName);
  const anywhere = lower.lastIndexOf(q);
  if (anywhere >= 0) return range(anywhere);
  const out: number[] = [];
  let qi = q.length - 1;
  for (let i = lower.length - 1; i >= 0 && qi >= 0; i--) {
    if (lower[i] === q[qi]) {
      out.push(i);
      qi--;
    }
  }
  return qi < 0 ? out.reverse() : [];
}

/** Splits `text` (starting at `offset` within the full string) into highlighted and plain parts. */
export function highlightRuns(text: string, indices: number[], offset = 0): Segment[] {
  const set = new Set(indices);
  const out: Segment[] = [];
  for (let i = 0; i < text.length; i++) {
    const match = set.has(i + offset);
    const last = out[out.length - 1];
    if (last && last.match === match) last.text += text[i];
    else out.push({ text: text[i], match });
  }
  return out;
}
