import { describe, expect, it } from 'vitest';
import { inlineTarget, minimalEdit, normalizeEol, selectedLines, spliceLines } from './text';

const apply = (before: string, after: string) => {
  const e = minimalEdit(before, after);
  return e ? before.slice(0, e.start) + e.text + before.slice(e.end) : before;
};

describe('minimalEdit', () => {
  it('returns null for equal text', () => {
    expect(minimalEdit('abc', 'abc')).toBeNull();
  });

  it('replaces only the changed middle', () => {
    expect(minimalEdit('let a = 1;\nlet b = 2;\n', 'let a = 1;\nlet b = 3;\n')).toEqual({ start: 19, end: 20, text: '3' });
    expect(minimalEdit('abc', 'abxc')).toEqual({ start: 2, end: 2, text: 'x' });
    expect(minimalEdit('abc', '')).toEqual({ start: 0, end: 3, text: '' });
  });

  it('round-trips arbitrary changes', () => {
    const cases: Array<[string, string]> = [
      ['', 'new'],
      ['aaaa', 'aa'],
      ['one\r\ntwo\r\n', 'one\r\n\r\ntwo\r\n'],
      ['x😀y', 'x😁y'],
      ['a\r\nb', 'a\nb'],
    ];
    for (const [a, b] of cases) expect(apply(a, b)).toBe(b);
  });

  it('never splits surrogate pairs or CRLF', () => {
    const e = minimalEdit('x😀y', 'x😁y')!;
    expect(e.start).toBe(1);
    expect(e.text).toBe('😁');
    expect(minimalEdit('a\r\nb', 'a\r\r\nb')).toEqual({ start: 1, end: 3, text: '\r\r\n' });
  });
});

describe('lines', () => {
  it('normalizes line endings', () => {
    expect(normalizeEol('a\r\nb\nc', '\n')).toBe('a\nb\nc');
    expect(normalizeEol('a\r\nb\nc', '\r\n')).toBe('a\r\nb\r\nc');
  });

  it('splices whole lines', () => {
    const lines = ['a', 'b', 'c', 'd'];
    expect(spliceLines(lines, 2, 3, 'X\nY\nZ')).toEqual(['a', 'X', 'Y', 'Z', 'd']);
    expect(spliceLines(lines, 2, 1, 'new')).toEqual(['a', 'new', 'b', 'c', 'd']);
    expect(spliceLines(lines, 4, 4, '')).toEqual(['a', 'b', 'c', '']);
    expect(spliceLines(lines, 1, 0, 'top')).toEqual(['top', 'a', 'b', 'c', 'd']);
  });

  it('maps selections to line spans', () => {
    expect(selectedLines({ startLineNumber: 2, startColumn: 3, endLineNumber: 4, endColumn: 1 })).toEqual({ startLine: 2, endLine: 3 });
    expect(selectedLines({ startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 1 })).toEqual({ startLine: 2, endLine: 2 });
    expect(selectedLines({ startLineNumber: 2, startColumn: 1, endLineNumber: 5, endColumn: 4 })).toEqual({ startLine: 2, endLine: 5 });
  });

  it('chooses the inline edit target', () => {
    const lines = ['function a() {', '', '  return 1;', '}'];
    const lineAt = (n: number) => lines[n - 1];
    expect(inlineTarget({ startLineNumber: 1, startColumn: 1, endLineNumber: 4, endColumn: 2 }, lineAt)).toEqual({ startLine: 1, endLine: 4, mode: 'rewrite' });
    expect(inlineTarget({ startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 1 }, lineAt)).toEqual({ startLine: 2, endLine: 2, mode: 'insert' });
    expect(inlineTarget({ startLineNumber: 3, startColumn: 5, endLineNumber: 3, endColumn: 5 }, lineAt)).toEqual({ startLine: 3, endLine: 2, mode: 'insert' });
  });
});
