import { describe, expect, it } from 'vitest';
import { codeBlockPath, findSnippetLine, normalizeRef, parsePathRef, pickExisting } from './paths';

describe('parsePathRef', () => {
  it('accepts paths, bare file names, dotfiles and line suffixes', () => {
    expect(parsePathRef('src/cart.ts')).toEqual({ path: 'src/cart.ts', line: null });
    expect(parsePathRef('./src/cart.ts:12')).toEqual({ path: 'src/cart.ts', line: 12 });
    expect(parsePathRef('cart.test.ts:3:5')).toEqual({ path: 'cart.test.ts', line: 3 });
    expect(parsePathRef('.gitignore')).toEqual({ path: '.gitignore', line: null });
    expect(parsePathRef('Dockerfile')).toEqual({ path: 'Dockerfile', line: null });
    expect(parsePathRef('src\\main.rs')).toEqual({ path: 'src/main.rs', line: null });
  });
  it('rejects code, numbers, folders and URLs', () => {
    for (const text of ['reduce', 'total()', 'Item[]', '3.14', 'v1.2', 'src/', 'a b.ts', 'https://x.io/a.js', '..', 'item.price * 2']) {
      expect(parsePathRef(text), text).toBeNull();
    }
  });
  it('needs a known file extension for a bare name, but not in a folder', () => {
    for (const text of ['item.price', 'this.state', 'console.log', 'os.path', 'self.items']) {
      expect(parsePathRef(text), text).toBeNull();
    }
    expect(parsePathRef('Cargo.toml')?.path).toBe('Cargo.toml');
    expect(parsePathRef('README.md')?.path).toBe('README.md');
    expect(parsePathRef('logs/server.log')?.path).toBe('logs/server.log');
  });
  it('strips the project root from absolute paths', () => {
    expect(parsePathRef('D:/projects/shop/src/cart.ts', 'D:\\projects\\shop')).toEqual({ path: 'src/cart.ts', line: null });
    expect(normalizeRef('D:/Projects/Shop/a.ts', 'd:/projects/shop/')).toBe('a.ts');
  });
});

describe('codeBlockPath', () => {
  const block = (before: string, fence: string, code: string) => {
    const source = `${before}${fence}\n${code}\n\`\`\`\n`;
    return codeBlockPath(source, before.length, code);
  };
  it('reads the fence info string', () => {
    expect(block('', '```ts src/cart.ts', 'x')).toEqual({ path: 'src/cart.ts', line: null });
    expect(block('', '```ts:src/cart.ts', 'x')?.path).toBe('src/cart.ts');
    expect(block('', '```ts title="src/cart.ts"', 'x')?.path).toBe('src/cart.ts');
  });
  it('reads a first-line comment', () => {
    expect(block('', '```ts', '// src/cart.ts\nexport {}')?.path).toBe('src/cart.ts');
    expect(block('', '```py', '# file: app/main.py\nprint()')?.path).toBe('app/main.py');
    expect(block('', '```sh', '# install dependencies\nnpm i')).toBeNull();
  });
  it('reads a lead-in paragraph that ends with a colon', () => {
    expect(block('Text.\n\nMultiply by the quantity in `src/cart.ts`:\n\n', '```ts', 'code')?.path).toBe('src/cart.ts');
    expect(block('Change src/format.ts like this:\n', '```ts', 'code')?.path).toBe('src/format.ts');
    expect(block('See `src/cart.ts`.\n\n', '```ts', 'code')).toBeNull();
    expect(block('In `a.ts`:\n\n```ts\nx\n```\n\nThen:\n\n', '```ts', 'code')).toBeNull();
  });
});

describe('pickExisting', () => {
  const files = ['src/cart.ts', 'test/cart.test.ts', 'src/format.ts', 'lib/format.ts'];
  it('prefers an exact match, then a unique suffix match', () => {
    expect(pickExisting('src/cart.ts', files)).toBe('src/cart.ts');
    expect(pickExisting('cart.ts', files)).toBe('src/cart.ts');
    expect(pickExisting('format.ts', files)).toBeNull();
    expect(pickExisting('missing.ts', files)).toBeNull();
  });
});

describe('findSnippetLine', () => {
  const file = 'export interface Item {\n  id: string;\n}\n\nexport function total(items: Item[]): number {\n  return 0;\n}\n';
  it('finds the first meaningful line of a snippet', () => {
    expect(findSnippetLine(file, '// change this\nexport function total(items: Item[]): number {\n  return 1;\n}')).toBe(5);
  });
  it('returns null when the snippet is new or ambiguous', () => {
    expect(findSnippetLine(file, 'export const x = 1;')).toBeNull();
    expect(findSnippetLine('return 0;\nreturn 0;', 'return 0;')).toBeNull();
  });
});
