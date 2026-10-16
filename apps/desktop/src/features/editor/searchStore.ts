// Project search state, kept outside the panel so the query and results
// survive while the sidebar shows the file tree.

import { create } from 'zustand';
import type { SearchResults } from '../../bindings/SearchResults';
import { errorText } from '../../lib/errors';
import { api } from '../../lib/ipc';
import { useApp } from '../../state/app';
import { parseGlobs } from './lib/search';

export const MAX_RESULTS = 500;

interface SearchState {
  pattern: string;
  globs: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
  running: boolean;
  results: SearchResults | null;
  /** The pattern `results` belong to (the field may already show a newer one). */
  searched: string;
  error: string | null;
  collapsed: Record<string, boolean>;
}

export const useSearch = create<SearchState>(() => ({
  pattern: '',
  globs: '',
  caseSensitive: false,
  wholeWord: false,
  regex: false,
  running: false,
  results: null,
  searched: '',
  error: null,
  collapsed: {},
}));

let seq = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

async function run() {
  const st = useSearch.getState();
  const id = ++seq;
  if (!st.pattern) {
    useSearch.setState({ running: false, results: null, error: null });
    return;
  }
  useSearch.setState({ running: true });
  try {
    const results = await api.fs.search({
      pattern: st.pattern,
      regex: st.regex,
      caseSensitive: st.caseSensitive,
      wholeWord: st.wholeWord,
      globs: parseGlobs(st.globs),
      maxResults: MAX_RESULTS,
    });
    if (id === seq) useSearch.setState({ running: false, results, searched: st.pattern, error: null, collapsed: {} });
  } catch (e) {
    if (id === seq) useSearch.setState({ running: false, results: null, error: errorText(e) });
  }
}

/** Updates the query and searches after a short pause in typing. */
export function updateQuery(patch: Partial<Pick<SearchState, 'pattern' | 'globs' | 'caseSensitive' | 'wholeWord' | 'regex'>>, delay = 250): void {
  useSearch.setState(patch);
  clearTimeout(timer);
  timer = setTimeout(() => void run(), delay);
}

export function searchNow(): void {
  clearTimeout(timer);
  void run();
}

export function toggleCollapsed(path: string): void {
  useSearch.setState((s) => ({ collapsed: { ...s.collapsed, [path]: !s.collapsed[path] } }));
}

export function setAllCollapsed(collapsed: boolean): void {
  const files = useSearch.getState().results?.files ?? [];
  useSearch.setState({ collapsed: Object.fromEntries(files.map((f) => [f.path, collapsed])) });
}

export function clearSearch(): void {
  clearTimeout(timer);
  seq++;
  useSearch.setState({ pattern: '', running: false, results: null, error: null, collapsed: {} });
}

// Results belong to one project.
let root = useApp.getState().workspace?.root ?? null;
useApp.subscribe((s) => {
  const next = s.workspace?.root ?? null;
  if (next === root) return;
  root = next;
  clearSearch();
});
