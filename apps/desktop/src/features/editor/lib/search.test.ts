import { describe, expect, it } from 'vitest';
import { highlightRuns, matchIndices, parseGlobs, parseQuickOpen, previewLine } from './search';

const marked = (p: ReturnType<typeof previewLine>) => p.segments.map((s) => (s.match ? `[${s.text}]` : s.text)).join('');

describe('search helpers', () => {
  it('parses glob lists', () => {
    expect(parseGlobs(' *.ts, !test/** ,,')).toEqual(['*.ts', '!test/**']);
    expect(parseGlobs('')).toEqual([]);
  });

  it('highlights character ranges and drops indentation', () => {
    expect(marked(previewLine('    return total(items);', [[11, 16]]))).toBe('return [total](items);');
    expect(marked(previewLine('a a a', [[0, 1], [4, 5], [2, 3]]))).toBe('[a] [a] [a]');
  });

  it('counts code points, not UTF-16 units', () => {
    expect(marked(previewLine('😀 alpha', [[2, 7]]))).toBe('😀 [alpha]');
  });

  it('shortens a long lead before the first match', () => {
    const line = `${'x'.repeat(80)}needle`;
    const p = previewLine(line, [[80, 86]], 20);
    expect(p.clipped).toBe(true);
    expect(marked(p)).toBe(`${'x'.repeat(10)}[needle]`);
  });

  it('clamps ranges beyond the trimmed line', () => {
    expect(marked(previewLine('abc', [[1, 99]]))).toBe('a[bc]');
  });

  it('parses quick open line suffixes', () => {
    expect(parseQuickOpen('cart.ts:12')).toEqual({ query: 'cart.ts', line: 12 });
    expect(parseQuickOpen('cart')).toEqual({ query: 'cart', line: null });
    expect(parseQuickOpen('cart:')).toEqual({ query: 'cart', line: null });
  });

  it('prefers matches in the file name', () => {
    expect(matchIndices('cart', 'src/cart.ts')).toEqual([4, 5, 6, 7]);
    expect(matchIndices('src', 'src/cart.ts')).toEqual([0, 1, 2]);
    expect(matchIndices('src\\cart', 'src/cart.ts')).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(matchIndices('sct', 'src/cart.ts')).toEqual([0, 4, 9]);
    expect(matchIndices('zz', 'src/cart.ts')).toEqual([]);
    expect(matchIndices('', 'src/cart.ts')).toEqual([]);
  });

  it('groups highlighted runs', () => {
    expect(highlightRuns('cart.ts', [4, 5, 6, 7], 4)).toEqual([
      { text: 'cart', match: true },
      { text: '.ts', match: false },
    ]);
  });
});
