import { describe, expect, it } from 'vitest';
import { applyTrigger, findMentionTrigger, isSubsequence, mentionKey, mentionLabel, mergeMentions, parentFolders, pickerItems } from './mentions';

describe('findMentionTrigger', () => {
  it('finds an @ at the start or after whitespace', () => {
    expect(findMentionTrigger('@car', 4)).toEqual({ start: 0, query: 'car' });
    expect(findMentionTrigger('look at @src/ca', 15)).toEqual({ start: 8, query: 'src/ca' });
    expect(findMentionTrigger('fix (@tot', 9)).toEqual({ start: 5, query: 'tot' });
    expect(findMentionTrigger('just @', 6)).toEqual({ start: 5, query: '' });
  });
  it('ignores e-mail addresses and finished words', () => {
    expect(findMentionTrigger('me@host', 7)).toBeNull();
    expect(findMentionTrigger('@cart done', 10)).toBeNull();
    expect(findMentionTrigger('no mention', 10)).toBeNull();
  });
  it('only looks at the text before the caret', () => {
    expect(findMentionTrigger('@cart is', 3)).toEqual({ start: 0, query: 'ca' });
  });
});

describe('applyTrigger', () => {
  it('replaces the typed query with the reference and a space', () => {
    expect(applyTrigger('explain @car', { start: 8, query: 'car' }, 12, 'src/cart.ts')).toEqual({ text: 'explain src/cart.ts ', caret: 20 });
  });
  it('reuses an existing space after the caret', () => {
    expect(applyTrigger('how @ works', { start: 4, query: '' }, 5, 'total')).toEqual({ text: 'how total works', caret: 10 });
  });
});

describe('mentions', () => {
  it('labels mentions like the core labels context', () => {
    expect(mentionLabel({ type: 'file', path: 'src/cart.ts' }, 'shop')).toBe('cart.ts');
    expect(mentionLabel({ type: 'folder', path: 'src/lib' }, 'shop')).toBe('lib/');
    expect(mentionLabel({ type: 'folder', path: '' }, 'shop')).toBe('shop/');
    expect(mentionLabel({ type: 'selection', path: 'src/cart.ts', startLine: 3, endLine: 7, text: '' }, 'shop')).toBe('cart.ts:3-7');
  });
  it('merges without duplicates and replaces a re-attached selection', () => {
    const sel = { type: 'selection' as const, path: 'a.ts', startLine: 1, endLine: 2, text: 'old' };
    const merged = mergeMentions([{ type: 'file', path: 'a.ts' }, sel], [{ type: 'file', path: 'a.ts' }, { ...sel, text: 'new' }]);
    expect(merged).toHaveLength(2);
    expect(merged[1]).toMatchObject({ text: 'new' });
    expect(mentionKey(merged[1])).toBe('selection:a.ts:1-2');
  });
});

describe('picker', () => {
  it('derives unique ancestor folders', () => {
    expect(parentFolders(['src/a/b.ts', 'src/c.ts', 'test/d.ts', 'README.md'])).toEqual(['src/a', 'src', 'test']);
  });
  it('matches subsequences case-insensitively', () => {
    expect(isSubsequence('sct', 'src/cart.ts')).toBe(true);
    expect(isSubsequence('zz', 'src')).toBe(false);
    expect(isSubsequence('', 'x')).toBe(true);
  });
  it('builds files, folders (with the project root) and symbols', () => {
    const items = pickerItems('', ['src/cart.ts', 'test/cart.test.ts'], [{ name: 'total', kind: 'function', path: 'src/cart.ts', line: 7 }], 'shop');
    expect(items.map((i) => `${i.section}:${i.title}`)).toEqual(['files:cart.ts', 'files:cart.test.ts', 'folders:shop/', 'folders:src/', 'folders:test/', 'symbols:total']);
    expect(items.find((i) => i.root)?.mention).toEqual({ type: 'folder', path: '' });
    expect(items.slice(0, 2).map((i) => i.detail)).toEqual(['src/', 'test/']);
    expect(items[items.length - 1].mention).toEqual({ type: 'symbol', name: 'total', path: 'src/cart.ts', line: 7 });
  });
  it('filters folders by the query and prefers name matches', () => {
    const items = pickerItems('te', ['src/te/x.ts', 'test/cart.test.ts'], [], 'shop');
    expect(items.filter((i) => i.section === 'folders').map((i) => i.mention)).toEqual([
      { type: 'folder', path: 'src/te' },
      { type: 'folder', path: 'test' },
    ]);
    expect(items.filter((i) => i.section === 'folders').map((i) => i.detail)).toEqual(['src/', '']);
  });
  it('offers enabled skills last, inserted as "@name" without a chip', () => {
    const skills = [{ name: 'reverse-engineer-anything', description: 'Reverse engineer binaries.' }, { name: 'pdf-forms', description: 'Fill PDF forms.' }];
    const items = pickerItems('rev', ['src/review.ts'], [], 'shop', skills);
    expect(items.map((i) => `${i.section}:${i.title}`)).toEqual(['files:review.ts', 'skills:@reverse-engineer-anything']);
    const skill = items[items.length - 1];
    expect(skill).toMatchObject({ insert: '@reverse-engineer-anything', detail: 'Reverse engineer binaries.' });
    expect(skill.mention).toBeUndefined();
    expect(applyTrigger('Use @rev', { start: 4, query: 'rev' }, 8, skill.insert)).toEqual({ text: 'Use @reverse-engineer-anything ', caret: 31 });
  });
});
