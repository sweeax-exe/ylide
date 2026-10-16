// Checks lazily whether a path mentioned in an answer exists in the open
// project. Full relative paths are checked directly with `fs.exists`. Only a
// bare or partial name (e.g. `cart.ts` for src/cart.ts) needs the project's
// file list, which is fetched once and dropped when files change.

import { useEffect, useState, useSyncExternalStore } from 'react';
import { api, onEvent } from '../../lib/ipc';
import { useApp } from '../../state/app';
import { useEditorBridge } from '../../state/editorBridge';
import { useLayout } from '../../state/layout';
import { findSnippetLine, pickExisting, type PathRef } from './paths';

/** Upper bound of files listed; the core walks at most this many as well. */
const MAX_FILES = 100_000;

/** Bursts of file changes (an agent at work, a branch switch) re-check links once. */
const RECHECK_MS = 600;

let files: { root: string; list: Promise<string[]> } | null = null;
let version = 0;
const listeners = new Set<() => void>();
let watching = false;
let recheck: ReturnType<typeof setTimeout> | null = null;

function watchChanges() {
  if (watching) return;
  watching = true;
  void onEvent('fs://changed', () => {
    files = null;
    if (recheck !== null) clearTimeout(recheck);
    recheck = setTimeout(() => {
      recheck = null;
      version++;
      for (const listener of listeners) listener();
    }, RECHECK_MS);
  });
}

function projectFiles(root: string): Promise<string[]> {
  watchChanges();
  if (files?.root !== root) {
    const list = api.fs.findFiles('', MAX_FILES).catch(() => {
      // Try again next time instead of remembering the failure.
      if (files?.list === list) files = null;
      return [] as string[];
    });
    files = { root, list };
  }
  return files.list;
}

/** Resolves `ref` to an existing project-relative file path, or null. */
export async function resolveProjectPath(root: string, ref: string): Promise<string | null> {
  watchChanges();
  const direct = await api.fs.exists([ref]).catch(() => [] as string[]);
  if (direct.length) return direct[0];
  return pickExisting(ref, await projectFiles(root));
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const currentVersion = () => version;

/** The existing file `ref` points at; null while unknown, if missing, or when `enabled` is false. */
export function useResolvedPath(ref: PathRef | null, enabled: boolean): string | null {
  const root = useApp((s) => s.workspace?.root ?? null);
  const filesVersion = useSyncExternalStore(subscribe, currentVersion);
  const want = enabled && root && ref ? ref.path : null;
  const [resolved, setResolved] = useState<{ root: string; want: string; path: string | null } | null>(null);

  useEffect(() => {
    if (!want || !root) return;
    let live = true;
    void resolveProjectPath(root, want).then((path) => {
      if (live) setResolved({ root, want, path });
    });
    return () => {
      live = false;
    };
  }, [root, want, filesVersion]);

  // After a file change the last result stays visible until the new list is in.
  return want && resolved && resolved.root === root && resolved.want === want ? resolved.path : null;
}

/** Shows `path` in the editor, at `line` if given. */
export function openInEditor(path: string, line?: number | null) {
  useLayout.getState().setMain('editor');
  useEditorBridge.getState().open(path, line ?? undefined);
}

/** Opens `path` at the place where `snippet` starts, if it can be found. */
export async function openSnippet(path: string, snippet: string) {
  let line: number | null = null;
  try {
    line = findSnippetLine((await api.fs.readFile(path)).content, snippet);
  } catch {
    // The file opens at the top; the editor reports read errors itself.
  }
  openInEditor(path, line);
}
