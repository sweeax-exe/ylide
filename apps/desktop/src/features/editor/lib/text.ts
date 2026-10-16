// Text helpers for buffers: minimal edits, line splicing and selections.

export interface TextEdit {
  /** Offsets into the old text (UTF-16 code units). */
  start: number;
  end: number;
  text: string;
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/**
 * The smallest single replacement that turns `before` into `after`. Applying
 * only the changed middle keeps cursors and scroll position where they were.
 * Never splits a surrogate pair or a CRLF line break. Null when equal.
 */
export function minimalEdit(before: string, after: string): TextEdit | null {
  if (before === after) return null;
  const max = Math.min(before.length, after.length);
  let start = 0;
  while (start < max && before.charCodeAt(start) === after.charCodeAt(start)) start++;
  let endB = before.length;
  let endA = after.length;
  while (endB > start && endA > start && before.charCodeAt(endB - 1) === after.charCodeAt(endA - 1)) {
    endB--;
    endA--;
  }
  const adjustStart = () =>
    start > 0 &&
    ((isLowSurrogate(before.charCodeAt(start)) || isLowSurrogate(after.charCodeAt(start))) ||
      (before[start - 1] === '\r' && (before[start] === '\n' || after[start] === '\n')));
  while (adjustStart()) start--;
  const adjustEnd = () =>
    endB < before.length &&
    endA < after.length &&
    (isHighSurrogate(before.charCodeAt(endB - 1)) || isHighSurrogate(after.charCodeAt(endA - 1)) || (before[endB] === '\n' && (before[endB - 1] === '\r' || after[endA - 1] === '\r')));
  while (adjustEnd()) {
    endB++;
    endA++;
  }
  return { start, end: endB, text: after.slice(start, endA) };
}

export function normalizeEol(text: string, eol: '\n' | '\r\n'): string {
  const lf = text.replace(/\r\n/g, '\n');
  return eol === '\n' ? lf : lf.replace(/\n/g, '\r\n');
}

/** Replaces lines `startLine..endLine` (1-based, inclusive) with `replacement`. `endLine = startLine - 1` inserts before `startLine`. */
export function spliceLines(lines: string[], startLine: number, endLine: number, replacement: string): string[] {
  const start = Math.max(0, Math.min(startLine - 1, lines.length));
  const end = Math.max(start, Math.min(endLine, lines.length));
  return [...lines.slice(0, start), ...replacement.replace(/\r\n/g, '\n').split('\n'), ...lines.slice(end)];
}

export interface LineSelection {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

/** 1-based inclusive line span of a selection. A selection that ends at column 1 does not include that line. */
export function selectedLines(sel: LineSelection): { startLine: number; endLine: number } {
  const endLine = sel.endLineNumber > sel.startLineNumber && sel.endColumn === 1 ? sel.endLineNumber - 1 : sel.endLineNumber;
  return { startLine: sel.startLineNumber, endLine };
}

export const isEmptySelection = (sel: LineSelection) => sel.startLineNumber === sel.endLineNumber && sel.startColumn === sel.endColumn;

export interface InlineTarget {
  startLine: number;
  /** `startLine - 1` when new code is inserted before `startLine`. */
  endLine: number;
  mode: 'rewrite' | 'insert';
}

/**
 * Lines an inline edit works on. A selection is rewritten as whole lines. An
 * empty selection inserts at the cursor line: a blank line is replaced, a
 * line with code gets the new code above it.
 */
export function inlineTarget(sel: LineSelection, lineAt: (line: number) => string): InlineTarget {
  if (!isEmptySelection(sel)) {
    const { startLine, endLine } = selectedLines(sel);
    return { startLine, endLine, mode: 'rewrite' };
  }
  const line = sel.startLineNumber;
  if (lineAt(line).trim() === '') return { startLine: line, endLine: line, mode: 'insert' };
  return { startLine: line, endLine: line - 1, mode: 'insert' };
}
