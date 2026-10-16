// Flattening of the lazily loaded file tree into visible rows.

import type { FileNode } from '../../../bindings/FileNode';
import { dirname } from './paths';

export interface TreeRow {
  node: FileNode;
  depth: number;
}

/** Visible rows in display order: children of expanded folders follow their folder. */
export function visibleRows(children: Record<string, FileNode[] | undefined>, expanded: Record<string, boolean>, root = ''): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (dir: string, depth: number) => {
    for (const node of children[dir] ?? []) {
      rows.push({ node, depth });
      if (node.kind === 'dir' && expanded[node.path]) walk(node.path, depth + 1);
    }
  };
  walk(root, 0);
  return rows;
}

/** Index of the row's parent folder, or -1 at the top level. */
export function parentIndex(rows: TreeRow[], index: number): number {
  const depth = rows[index]?.depth ?? 0;
  for (let i = index - 1; i >= 0; i--) if (rows[i].depth < depth) return i;
  return -1;
}

/**
 * Folders to list again after the core reported changes at `paths`: a changed
 * path that is a loaded folder, and the deepest loaded folder above it, where
 * a new or removed entry shows up (also when its own parent was never opened).
 */
export function refreshTargets(paths: string[], isLoaded: (dir: string) => boolean): string[] {
  const out = new Set<string>();
  for (const path of paths) {
    if (isLoaded(path)) out.add(path);
    let dir = path;
    while (dir !== '') {
      dir = dirname(dir);
      if (isLoaded(dir)) {
        out.add(dir);
        break;
      }
    }
  }
  return [...out];
}
