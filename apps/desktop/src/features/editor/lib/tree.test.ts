import { describe, expect, it } from 'vitest';
import type { FileNode } from '../../../bindings/FileNode';
import { parentIndex, refreshTargets, visibleRows } from './tree';

const dir = (path: string): FileNode => ({ name: path.split('/').pop()!, path, kind: 'dir', sizeBytes: null });
const file = (path: string): FileNode => ({ name: path.split('/').pop()!, path, kind: 'file', sizeBytes: 1 });

const children = {
  '': [dir('src'), dir('test'), file('README.md')],
  src: [dir('src/lib'), file('src/cart.ts')],
  'src/lib': [file('src/lib/a.ts')],
};

describe('visibleRows', () => {
  it('shows only the top level when nothing is expanded', () => {
    expect(visibleRows(children, {}).map((r) => r.node.path)).toEqual(['src', 'test', 'README.md']);
  });

  it('nests expanded folders with depth', () => {
    const rows = visibleRows(children, { src: true, 'src/lib': true, test: true });
    expect(rows.map((r) => `${r.depth}:${r.node.path}`)).toEqual(['0:src', '1:src/lib', '2:src/lib/a.ts', '1:src/cart.ts', '0:test', '0:README.md']);
    expect(parentIndex(rows, 2)).toBe(1);
    expect(parentIndex(rows, 3)).toBe(0);
    expect(parentIndex(rows, 0)).toBe(-1);
  });

  it('skips collapsed subfolders even when loaded', () => {
    expect(visibleRows(children, { 'src/lib': true }).length).toBe(3);
  });
});

describe('refreshTargets', () => {
  const loaded = (dir: string) => dir in children;

  it('lists the folder that holds a changed file', () => {
    expect(refreshTargets(['src/cart.ts'], loaded)).toEqual(['src']);
  });

  it('reaches the nearest loaded folder when new folders appear below it', () => {
    expect(refreshTargets(['src/new/deep/file.ts'], loaded)).toEqual(['src']);
    expect(refreshTargets(['docs/a.md'], loaded)).toEqual(['']);
  });

  it('includes a changed folder that is loaded itself, once per folder', () => {
    expect(refreshTargets(['src/lib', 'src/lib/a.ts', 'src/cart.ts'], loaded).sort()).toEqual(['src', 'src/lib']);
  });
});
