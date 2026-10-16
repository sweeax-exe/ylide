// File tree state, kept outside the panel so expanded folders survive when
// the sidebar switches to search and back. Folders load lazily and refresh
// when the core reports changes below them.

import { create } from 'zustand';
import type { FileNode } from '../../bindings/FileNode';
import { errorText } from '../../lib/errors';
import { api, onEvent } from '../../lib/ipc';
import { useApp } from '../../state/app';
import { ancestors, dirname, isWithin } from './lib/paths';
import { refreshTargets } from './lib/tree';

interface TreeState {
  /** Children per loaded folder; `''` is the project root. */
  children: Record<string, FileNode[] | undefined>;
  expanded: Record<string, boolean>;
  loading: Record<string, boolean>;
  /** Error text when the root could not be listed. */
  rootError: string | null;
  focused: string | null;
}

export const useTree = create<TreeState>(() => ({ children: {}, expanded: {}, loading: {}, rootError: null, focused: null }));

const without = <T,>(record: Record<string, T>, drop: (key: string) => boolean): Record<string, T> =>
  Object.fromEntries(Object.entries(record).filter(([k]) => !drop(k)));

export async function loadDir(path: string): Promise<void> {
  useTree.setState((s) => ({ loading: { ...s.loading, [path]: true } }));
  try {
    const nodes = await api.fs.listDir(path);
    useTree.setState((s) => ({
      children: { ...s.children, [path]: nodes },
      loading: without(s.loading, (k) => k === path),
      rootError: path === '' ? null : s.rootError,
    }));
  } catch (e) {
    // A folder that vanished is forgotten and its parent listed again, so its
    // row goes too; only the root reports errors.
    useTree.setState((s) => ({
      children: without(s.children, (k) => k !== '' && isWithin(k, path)),
      expanded: without(s.expanded, (k) => isWithin(k, path)),
      loading: without(s.loading, (k) => k === path),
      rootError: path === '' ? errorText(e) : s.rootError,
    }));
    if (path !== '' && useTree.getState().children[dirname(path)]) void loadDir(dirname(path));
  }
}

export function setFocused(path: string | null): void {
  useTree.setState({ focused: path });
}

export function setExpanded(path: string, open: boolean): void {
  useTree.setState((s) => ({ expanded: { ...s.expanded, [path]: open } }));
  if (open && !useTree.getState().children[path]) void loadDir(path);
}

export function toggleExpanded(path: string): void {
  setExpanded(path, !useTree.getState().expanded[path]);
}

export function collapseAll(): void {
  useTree.setState({ expanded: {} });
}

/** Reloads the root and every loaded folder. */
export async function refreshAll(): Promise<void> {
  const loaded = Object.keys(useTree.getState().children);
  await Promise.all((loaded.length ? loaded : ['']).map(loadDir));
}

/** Expands the folders above `path` and focuses it. */
export async function reveal(path: string): Promise<void> {
  const parents = ancestors(path);
  for (const dir of ['', ...parents]) {
    if (!useTree.getState().children[dir]) await loadDir(dir);
  }
  useTree.setState((s) => ({ expanded: { ...s.expanded, ...Object.fromEntries(parents.map((p) => [p, true])) }, focused: path }));
}

/** Drops cached state below a removed or renamed path. */
export function forget(path: string): void {
  useTree.setState((s) => ({
    children: without(s.children, (k) => k !== '' && isWithin(k, path)),
    expanded: without(s.expanded, (k) => isWithin(k, path)),
    focused: s.focused && isWithin(s.focused, path) ? null : s.focused,
  }));
}

// ------------------------------------------------------------------ wiring

const pending = new Set<string>();
let flushTimer: ReturnType<typeof setTimeout> | undefined;

function onChanged(paths: string[]) {
  const loaded = useTree.getState().children;
  for (const dir of refreshTargets(paths, (d) => loaded[d] !== undefined)) pending.add(dir);
  if (!pending.size) return;
  clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    const dirs = [...pending];
    pending.clear();
    dirs.forEach((d) => void loadDir(d));
  }, 80);
}

let wired = false;
/** Subscribes once to file changes and project switches. */
export function wireTree(): void {
  if (wired) return;
  wired = true;
  void onEvent('fs://changed', onChanged);
  let root = useApp.getState().workspace?.root ?? null;
  useApp.subscribe((s) => {
    const next = s.workspace?.root ?? null;
    if (next === root) return;
    root = next;
    useTree.setState({ children: {}, expanded: {}, loading: {}, rootError: null, focused: null });
    if (next) void loadDir('');
  });
}
