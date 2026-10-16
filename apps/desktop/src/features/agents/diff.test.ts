import { describe, expect, it } from 'vitest';
import { diffStats, firstChangedLine, looksLikeDiff, parseUnifiedDiff } from './diff';

describe('parseUnifiedDiff', () => {
  it('parses headers, hunks and line numbers', () => {
    const files = parseUnifiedDiff('--- a/src/cart.ts\n+++ b/src/cart.ts\n@@ -6,4 +6,4 @@\n \n export function total() {\n-  return a;\n+  return a * b;\n }\n');
    expect(files).toHaveLength(1);
    const [f] = files;
    expect(f.oldPath).toBe('src/cart.ts');
    expect(f.newPath).toBe('src/cart.ts');
    expect(f.lines.map((l) => l.kind)).toEqual(['hunk', 'context', 'context', 'del', 'add', 'context']);
    expect(f.lines[3]).toMatchObject({ text: '  return a;', oldNo: 8, newNo: null });
    expect(f.lines[4]).toMatchObject({ text: '  return a * b;', oldNo: null, newNo: 8 });
    expect(diffStats(files)).toEqual({ additions: 1, deletions: 1 });
    expect(firstChangedLine(files)).toBe(8);
  });

  it('does not mistake content lines that look like headers', () => {
    const files = parseUnifiedDiff('--- a/q.sql\n+++ b/q.sql\n@@ -1,2 +1,2 @@\n--- old comment\n+++ new comment\n select 1;\n');
    expect(files).toHaveLength(1);
    expect(files[0].lines.map((l) => l.kind)).toEqual(['hunk', 'del', 'add', 'context']);
    expect(files[0].lines[1].text).toBe('-- old comment');
  });

  it('splits several files and handles created files and missing newlines', () => {
    const files = parseUnifiedDiff('--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1,1 @@\n+export {};\n\\ No newline at end of file\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b\n');
    expect(files.map((f) => [f.oldPath, f.newPath])).toEqual([
      [null, 'new.ts'],
      ['x.ts', 'x.ts'],
    ]);
    expect(files[0].lines.map((l) => l.kind)).toEqual(['hunk', 'add', 'note']);
    expect(diffStats(files)).toEqual({ additions: 2, deletions: 1 });
  });

  it('recovers when a hunk count is too large', () => {
    const files = parseUnifiedDiff('--- a/a.ts\n+++ b/a.ts\n@@ -1,9 +1,9 @@\n-a\n+b\n--- a/b.ts\n+++ b/b.ts\n@@ -1 +1 @@\n-c\n+d\n');
    expect(files.map((f) => f.newPath)).toEqual(['a.ts', 'b.ts']);
  });

  it('points "Open file" at the new-file position of a pure deletion', () => {
    // Lines 3-4 of the old file are gone after 10 lines were added above them.
    const files = parseUnifiedDiff('--- a/a.ts\n+++ b/a.ts\n@@ -1,4 +11,2 @@\n a\n b\n-c\n-d\n');
    expect(firstChangedLine(files)).toBe(13);
  });

  it('keeps headerless +/- text visible', () => {
    const [f] = parseUnifiedDiff('+added\n-removed\nplain');
    expect(f.lines.map((l) => l.kind)).toEqual(['add', 'del', 'context']);
  });
});

describe('looksLikeDiff', () => {
  it('detects diffs but not commands', () => {
    expect(looksLikeDiff('--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b')).toBe(true);
    expect(looksLikeDiff('@@ -1,2 +1,2 @@\n a')).toBe(true);
    expect(looksLikeDiff('npm test')).toBe(false);
    expect(looksLikeDiff('src/old.ts')).toBe(false);
  });
});
