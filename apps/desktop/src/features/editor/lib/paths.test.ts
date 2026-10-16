import { describe, expect, it } from 'vitest';
import { ancestors, basename, dirname, extension, isWithin, joinPath, replacePrefix, tabLabels, validateName } from './paths';

describe('paths', () => {
  it('splits names and folders', () => {
    expect(basename('src/cart.ts')).toBe('cart.ts');
    expect(basename('README.md')).toBe('README.md');
    expect(dirname('src/a/cart.ts')).toBe('src/a');
    expect(dirname('README.md')).toBe('');
    expect(joinPath('', 'a.ts')).toBe('a.ts');
    expect(joinPath('src', '/a.ts')).toBe('src/a.ts');
    expect(extension('src/App.TSX')).toBe('tsx');
    expect(extension('.gitignore')).toBe('');
  });

  it('knows what lies inside a folder', () => {
    expect(isWithin('src/a.ts', 'src')).toBe(true);
    expect(isWithin('src', 'src')).toBe(true);
    expect(isWithin('srcx/a.ts', 'src')).toBe(false);
    expect(isWithin('anything', '')).toBe(true);
    expect(replacePrefix('src/a/b.ts', 'src/a', 'lib')).toBe('lib/b.ts');
    expect(replacePrefix('src/ab.ts', 'src/a', 'lib')).toBe('src/ab.ts');
    expect(ancestors('a/b/c.ts')).toEqual(['a', 'a/b']);
    expect(ancestors('c.ts')).toEqual([]);
  });

  it('validates new names', () => {
    expect(validateName('  ')).toBe('empty');
    expect(validateName('a.ts')).toBeNull();
    expect(validateName('nested/a.ts')).toBeNull();
    expect(validateName('../a.ts')).toBe('invalid');
    expect(validateName('a\\b')).toBe('invalid');
    expect(validateName('a//b')).toBe('invalid');
  });

  it('disambiguates tabs with the same file name', () => {
    const labels = tabLabels(['src/index.ts', 'test/index.ts', 'README.md', 'a/x/mod.rs', 'b/x/mod.rs', 'mod.rs']);
    expect(labels['README.md']).toEqual({ name: 'README.md', hint: null });
    expect(labels['src/index.ts'].hint).toBe('src');
    expect(labels['test/index.ts'].hint).toBe('test');
    expect(labels['a/x/mod.rs'].hint).toBe('a/x');
    expect(labels['b/x/mod.rs'].hint).toBe('b/x');
    expect(labels['mod.rs'].hint).toBeNull();
  });
});
