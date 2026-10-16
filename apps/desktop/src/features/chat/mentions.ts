// Mentions in the composer: identity, labels, the "@" trigger and the items
// shown in the mention picker. Pure functions; the picker UI lives in
// MentionPicker.tsx.

import type { Mention } from '../../bindings/Mention';
import type { Symbol as CodeSymbol } from '../../bindings/Symbol';
import type { SymbolKind } from '../../bindings/SymbolKind';

export function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed.slice(trimmed.lastIndexOf('/') + 1);
}

/** The folder part of a project-relative path with a trailing slash, or '' at the top level. */
export function dirname(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const at = trimmed.lastIndexOf('/');
  return at < 0 ? '' : `${trimmed.slice(0, at)}/`;
}

/** Stable identity of a mention, used to avoid duplicates. */
export function mentionKey(m: Mention): string {
  switch (m.type) {
    case 'file':
      return `file:${m.path}`;
    case 'folder':
      return `folder:${m.path}`;
    case 'symbol':
      return `symbol:${m.name}@${m.path ?? ''}:${m.line ?? ''}`;
    case 'selection':
      return `selection:${m.path}:${m.startLine}-${m.endLine}`;
  }
}

/** Short chip label, matching the labels the core gives resolved context. */
export function mentionLabel(m: Mention, projectName: string): string {
  switch (m.type) {
    case 'file':
      return basename(m.path);
    case 'folder':
      return `${m.path ? basename(m.path) : projectName}/`;
    case 'symbol':
      return m.name;
    case 'selection':
      return `${basename(m.path)}:${m.startLine}-${m.endLine}`;
  }
}

/** Project-relative path a mention points at, if any (for "open in editor"). */
export function mentionPath(m: Mention): string | null {
  if (m.type === 'symbol') return m.path;
  if (m.type === 'folder') return null;
  return m.path;
}

/** Adds mentions, replacing an existing one with the same identity (e.g. a re-attached selection). */
export function mergeMentions(existing: Mention[], added: Mention[]): Mention[] {
  const out = existing.slice();
  for (const m of added) {
    const key = mentionKey(m);
    const at = out.findIndex((e) => mentionKey(e) === key);
    if (at >= 0) out[at] = m;
    else out.push(m);
  }
  return out;
}

export interface MentionTrigger {
  /** Index of the "@" in the text. */
  start: number;
  /** What was typed after the "@" up to the caret. */
  query: string;
}

const MAX_QUERY = 80;

/**
 * Finds an "@mention" being typed at `caret`: an "@" at the start or after
 * whitespace or an opening bracket, followed by non-space characters.
 * E-mail addresses (`me@host`) do not trigger.
 */
export function findMentionTrigger(text: string, caret: number): MentionTrigger | null {
  for (let i = caret - 1; i >= 0 && caret - i <= MAX_QUERY + 1; i--) {
    const c = text[i];
    if (/\s/.test(c)) return null;
    if (c === '@') {
      const before = i === 0 ? '' : text[i - 1];
      if (before !== '' && !/[\s([{"'`]/.test(before)) return null;
      return { start: i, query: text.slice(i + 1, caret) };
    }
  }
  return null;
}

/**
 * Replaces the typed "@query" with `insert` (a readable reference such as the
 * file path) and a following space. Returns the new text and caret position.
 */
export function applyTrigger(text: string, trigger: MentionTrigger, caret: number, insert: string): { text: string; caret: number } {
  const after = text.slice(caret);
  const spacer = after.startsWith(' ') || after.startsWith('\n') ? '' : ' ';
  const head = text.slice(0, trigger.start) + insert + spacer;
  return { text: head + after, caret: head.length + (spacer ? 0 : 1) };
}

/** True if every character of `query` occurs in `candidate` in order (case-insensitive). */
export function isSubsequence(query: string, candidate: string): boolean {
  const q = query.toLowerCase().replace(/\s+/g, '');
  const c = candidate.toLowerCase();
  let at = 0;
  for (const ch of q) {
    at = c.indexOf(ch, at);
    if (at < 0) return false;
    at++;
  }
  return true;
}

/** All ancestor folders of the given project-relative file paths, unique, in first-seen order. */
export function parentFolders(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of paths) {
    const parts = p.split('/');
    for (let n = parts.length - 1; n >= 1; n--) {
      const dir = parts.slice(0, n).join('/');
      if (seen.has(dir)) continue;
      seen.add(dir);
      out.push(dir);
    }
  }
  return out;
}

export type PickerSection = 'files' | 'folders' | 'symbols';

export interface PickerItem {
  key: string;
  section: PickerSection;
  mention: Mention;
  /** Main line: file name, folder name or symbol name. */
  title: string;
  /** Secondary text: the folder it is in, or the line of a symbol. */
  detail: string;
  /** Text that replaces "@query" in the message. */
  insert: string;
  symbolKind?: SymbolKind;
  /** The project root entry (its detail is translated by the UI). */
  root?: boolean;
}

export const PICKER_LIMITS: Record<PickerSection, number> = { files: 8, folders: 5, symbols: 8 };

function folderRank(query: string, dir: string): number {
  const q = query.toLowerCase();
  const name = basename(dir).toLowerCase();
  if (!q) return dir.split('/').length;
  if (name === q) return 0;
  if (name.startsWith(q)) return 1;
  if (name.includes(q)) return 2;
  return 3;
}

/** Builds the picker entries for `query` from file and symbol search results. */
export function pickerItems(query: string, files: string[], symbols: CodeSymbol[], projectName: string): PickerItem[] {
  const fileItems: PickerItem[] = files.slice(0, PICKER_LIMITS.files).map((path) => ({
    key: `file:${path}`,
    section: 'files',
    mention: { type: 'file', path },
    title: basename(path),
    detail: dirname(path),
    insert: path,
  }));

  const dirs = parentFolders(files)
    .filter((d) => isSubsequence(query, d))
    .map((d, i) => ({ d, i }))
    .sort((a, b) => folderRank(query, a.d) - folderRank(query, b.d) || a.i - b.i)
    .map(({ d }) => d);
  const folderItems: PickerItem[] = [];
  if (!query || isSubsequence(query, projectName)) {
    folderItems.push({ key: 'folder:', section: 'folders', mention: { type: 'folder', path: '' }, title: `${projectName}/`, detail: '', insert: `${projectName}/`, root: true });
  }
  for (const dir of dirs) {
    if (folderItems.length >= PICKER_LIMITS.folders) break;
    folderItems.push({ key: `folder:${dir}`, section: 'folders', mention: { type: 'folder', path: dir }, title: `${basename(dir)}/`, detail: dirname(dir), insert: `${dir}/` });
  }

  const symbolItems: PickerItem[] = symbols.slice(0, PICKER_LIMITS.symbols).map((sym) => ({
    key: `symbol:${sym.name}@${sym.path}:${sym.line}`,
    section: 'symbols',
    mention: { type: 'symbol', name: sym.name, path: sym.path, line: sym.line },
    title: sym.name,
    detail: `${sym.path}:${sym.line}`,
    insert: sym.name,
    symbolKind: sym.kind,
  }));

  return [...fileItems, ...folderItems, ...symbolItems];
}

/** Symbol search reads many files, so it starts at this query length. */
export const SYMBOL_MIN_QUERY = 2;
