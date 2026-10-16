// Open documents: one Monaco model per file, kept outside React so buffers,
// undo history and view state survive while the editor view is hidden (for
// example while the settings are open). Publishes tabs and dirty files to the
// editor bridge and keeps buffers in sync with changes on disk.

import { create } from 'zustand';
import type { LineEnding } from '../../bindings/LineEnding';
import type { TextFile } from '../../bindings/TextFile';
import i18n from '../../i18n';
import { reportError } from '../../lib/errors';
import { api, onEvent } from '../../lib/ipc';
import { useApp } from '../../state/app';
import { useEditorBridge } from '../../state/editorBridge';
import { useLayout } from '../../state/layout';
import { basename, isWithin, replacePrefix } from './lib/paths';
import { minimalEdit, normalizeEol } from './lib/text';
import { monaco } from './monaco/setup';
import { onPathEvents, takeEditorFocusRequest } from './pathEvents';

export type DiskState = 'ok' | 'changed' | 'deleted';

export interface DocTab {
  path: string;
  dirty: boolean;
  /** Whether the file on disk still matches what the buffer was loaded from. */
  disk: DiskState;
}

export interface RevealRequest {
  path: string;
  line: number;
  seq: number;
}

interface DocumentsState {
  tabs: DocTab[];
  active: string | null;
  /** A line to reveal once the editor shows `path`. */
  reveal: RevealRequest | null;
  /** A dirty tab waiting for the "save changes?" answer. */
  closing: string | null;
  /** Increments when something asks the editor to take keyboard focus. */
  focusSeq: number;
}

export const useDocuments = create<DocumentsState>(() => ({ tabs: [], active: null, reveal: null, closing: null, focusSeq: 0 }));

interface Doc {
  model: monaco.editor.ITextModel;
  viewState: monaco.editor.ICodeEditorViewState | null;
  lineEnding: LineEnding;
  hasBom: boolean;
  savedVersion: number;
  /** The buffer differs from disk even if the version says otherwise (after a rename or a deletion). */
  forcedDirty: boolean;
  /** Text of the last save, to recognise the change event our own write causes. */
  lastWritten: string | null;
  subscription: monaco.IDisposable;
}

const docs = new Map<string, Doc>();
const loading = new Map<string, Promise<boolean>>();
let recent: string[] = [];
let revealSeq = 0;
let captureActiveViewState: (() => monaco.editor.ICodeEditorViewState | null) | null = null;

const BOM = String.fromCharCode(0xfeff);
const eolOf = (lineEnding: LineEnding) => (lineEnding === 'crlf' ? '\r\n' : '\n');
const uriFor = (path: string) => monaco.Uri.from({ scheme: 'file', path: `/${path}` });
const isDirty = (doc: Doc) => doc.forcedDirty || doc.model.getAlternativeVersionId() !== doc.savedVersion;

function patchTab(path: string, patch: Partial<DocTab>) {
  useDocuments.setState((s) => ({ tabs: s.tabs.map((t) => (t.path === path ? { ...t, ...patch } : t)) }));
}

function syncDirty(path: string) {
  const doc = docs.get(path);
  const tab = useDocuments.getState().tabs.find((t) => t.path === path);
  if (doc && tab && tab.dirty !== isDirty(doc)) patchTab(path, { dirty: isDirty(doc) });
}

function markSaved(path: string, doc: Doc) {
  doc.savedVersion = doc.model.getAlternativeVersionId();
  doc.forcedDirty = false;
  patchTab(path, { dirty: false, disk: 'ok' });
}

function createDoc(path: string, content: string, lineEnding: LineEnding, hasBom: boolean): Doc {
  const uri = uriFor(path);
  monaco.editor.getModel(uri)?.dispose();
  const model = monaco.editor.createModel(content, undefined, uri);
  if (model.getEOL() !== eolOf(lineEnding)) model.setEOL(lineEnding === 'crlf' ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF);
  // Brackets keep the operator colour (see editorOptions for the editor side).
  model.updateOptions({ bracketColorizationOptions: { enabled: false, independentColorPoolPerBracketType: false } });
  return {
    model,
    viewState: null,
    lineEnding,
    hasBom,
    savedVersion: model.getAlternativeVersionId(),
    forcedDirty: false,
    lastWritten: null,
    subscription: model.onDidChangeContent(() => syncDirty(path)),
  };
}

function disposeDoc(path: string) {
  const doc = docs.get(path);
  if (!doc) return;
  doc.subscription.dispose();
  doc.model.dispose();
  docs.delete(path);
}

/** Replaces the buffer with `text` as one undoable step that touches only the changed part, so cursors stay put. */
function applyText(doc: Doc, text: string) {
  const edit = minimalEdit(doc.model.getValue(), text);
  if (!edit) return;
  const start = doc.model.getPositionAt(edit.start);
  const end = doc.model.getPositionAt(edit.end);
  doc.model.pushStackElement();
  doc.model.pushEditOperations([], [{ range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column), text: edit.text }], () => null);
  doc.model.pushStackElement();
}

// ------------------------------------------------------------------ public API

export function getModel(path: string): monaco.editor.ITextModel | null {
  return docs.get(path)?.model ?? null;
}

export function getViewState(path: string): monaco.editor.ICodeEditorViewState | null {
  return docs.get(path)?.viewState ?? null;
}

export function setViewState(path: string, state: monaco.editor.ICodeEditorViewState | null): void {
  const doc = docs.get(path);
  if (doc) doc.viewState = state;
}

/** The mounted editor registers how to read its live view state (used when a renamed file gets a new model). */
export function registerViewStateCapture(capture: (() => monaco.editor.ICodeEditorViewState | null) | null): void {
  captureActiveViewState = capture;
}

/** Moves keyboard focus into the editor (e.g. after Enter on a tab). */
export function focusEditor(): void {
  useDocuments.setState((s) => ({ focusSeq: s.focusSeq + 1 }));
}

export function activate(path: string): void {
  if (!docs.has(path)) return;
  recent = [path, ...recent.filter((p) => p !== path)];
  if (useDocuments.getState().active !== path) useDocuments.setState({ active: path });
}

async function load(path: string): Promise<boolean> {
  try {
    const file: TextFile = await api.fs.readFile(path);
    if (docs.has(path)) return true;
    docs.set(path, createDoc(path, file.content, file.lineEnding, file.hasBom));
    useDocuments.setState((s) => {
      const tabs = [...s.tabs];
      const at = s.active ? tabs.findIndex((t) => t.path === s.active) + 1 : tabs.length;
      tabs.splice(at > 0 ? at : tabs.length, 0, { path, dirty: false, disk: 'ok' });
      return { tabs };
    });
    return true;
  } catch (e) {
    reportError(e, i18n.t('editor:errors.open', { name: basename(path) }));
    return false;
  }
}

/** Opens `path` in a tab (or switches to it) and reveals `line` when given. */
export async function openDocument(path: string, line?: number): Promise<void> {
  if (line) useDocuments.setState({ reveal: { path, line, seq: ++revealSeq } });
  if (!docs.has(path)) {
    let pending = loading.get(path);
    if (!pending) {
      pending = load(path).finally(() => loading.delete(path));
      loading.set(path, pending);
    }
    if (!(await pending)) return;
  }
  activate(path);
}

export function closeDocument(path: string): void {
  disposeDoc(path);
  recent = recent.filter((p) => p !== path);
  useDocuments.setState((s) => {
    const index = s.tabs.findIndex((t) => t.path === path);
    const tabs = s.tabs.filter((t) => t.path !== path);
    let active = s.active;
    if (active === path) active = recent.find((p) => tabs.some((t) => t.path === p)) ?? tabs[Math.min(index, tabs.length - 1)]?.path ?? null;
    return { tabs, active, closing: s.closing === path ? null : s.closing };
  });
}

/** Closes the tab, or asks first when it has unsaved changes. */
export function requestClose(path: string): void {
  const tab = useDocuments.getState().tabs.find((t) => t.path === path);
  if (!tab) return;
  if (tab.dirty) useDocuments.setState({ closing: path });
  else closeDocument(path);
}

export function cancelClose(): void {
  useDocuments.setState({ closing: null });
}

export async function saveDocument(path: string): Promise<boolean> {
  const doc = docs.get(path);
  if (!doc) return false;
  const version = doc.model.getAlternativeVersionId();
  const text = normalizeEol(doc.model.getValue(), eolOf(doc.lineEnding));
  try {
    await api.fs.writeFile(path, (doc.hasBom ? BOM : '') + text);
    if (docs.get(path) !== doc) return true;
    doc.lastWritten = text;
    doc.savedVersion = version;
    doc.forcedDirty = false;
    patchTab(path, { dirty: isDirty(doc), disk: 'ok' });
    return true;
  } catch (e) {
    reportError(e, i18n.t('editor:errors.save', { name: basename(path) }));
    return false;
  }
}

/** Steps through the tabs (Ctrl+Tab / Ctrl+Shift+Tab). */
export function cycleTab(step: 1 | -1): void {
  const { tabs, active } = useDocuments.getState();
  if (tabs.length < 2) return;
  const index = tabs.findIndex((t) => t.path === active);
  activate(tabs[(index + step + tabs.length) % tabs.length].path);
}

/** Replaces the buffer with the file on disk (the "Reload" answer to an external change). */
export async function reloadDocument(path: string): Promise<void> {
  const doc = docs.get(path);
  if (!doc) return;
  try {
    const file = await api.fs.readFile(path);
    if (docs.get(path) !== doc) return;
    applyText(doc, normalizeEol(file.content, doc.model.getEOL() as '\n' | '\r\n'));
    doc.lineEnding = file.lineEnding;
    doc.hasBom = file.hasBom;
    markSaved(path, doc);
  } catch (e) {
    reportError(e, i18n.t('editor:errors.reload', { name: basename(path) }));
  }
}

/** Keeps the buffer after an external change; saving then overwrites the file. */
export function keepMine(path: string): void {
  const doc = docs.get(path);
  const tab = useDocuments.getState().tabs.find((t) => t.path === path);
  if (!doc || !tab) return;
  if (tab.disk === 'deleted') doc.forcedDirty = true;
  patchTab(path, { disk: 'ok', dirty: isDirty(doc) });
}

// ------------------------------------------------------------------ disk changes

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function readOrNull(path: string): Promise<TextFile | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await api.fs.readFile(path);
    } catch {
      // A file that is being replaced atomically can be briefly unreadable.
      if (attempt === 0) await pause(150);
    }
  }
  return null;
}

async function syncFromDisk(path: string) {
  const doc = docs.get(path);
  if (!doc) return;
  const file = await readOrNull(path);
  if (docs.get(path) !== doc) return;
  if (!file) {
    patchTab(path, { disk: 'deleted' });
    return;
  }
  const eol = doc.model.getEOL() as '\n' | '\r\n';
  const disk = normalizeEol(file.content, eol);
  if (disk === doc.model.getValue()) {
    markSaved(path, doc);
    return;
  }
  if (doc.lastWritten !== null && normalizeEol(doc.lastWritten, eol) === disk) return;
  if (isDirty(doc)) {
    patchTab(path, { disk: 'changed' });
    return;
  }
  applyText(doc, disk);
  doc.lineEnding = file.lineEnding;
  doc.hasBom = file.hasBom;
  markSaved(path, doc);
}

function onDiskChanged(paths: string[]) {
  for (const path of [...docs.keys()]) {
    if (paths.some((changed) => isWithin(path, changed))) void syncFromDisk(path);
  }
}

// ------------------------------------------------------------------ renames and deletions from the tree

function moveDoc(from: string, to: string) {
  const doc = docs.get(from);
  if (!doc || docs.has(to)) return;
  const isActive = useDocuments.getState().active === from;
  const viewState = (isActive ? captureActiveViewState?.() : null) ?? doc.viewState;
  const dirty = isDirty(doc);
  const value = doc.model.getValue();
  disposeDoc(from);
  const next = createDoc(to, value, doc.lineEnding, doc.hasBom);
  next.viewState = viewState;
  next.forcedDirty = dirty;
  docs.set(to, next);
  recent = recent.map((p) => (p === from ? to : p));
  useDocuments.setState((s) => ({
    tabs: s.tabs.map((t) => (t.path === from ? { ...t, path: to, dirty } : t)),
    active: s.active === from ? to : s.active,
    closing: s.closing === from ? to : s.closing,
    reveal: s.reveal?.path === from ? { ...s.reveal, path: to } : s.reveal,
  }));
}

onPathEvents({
  moved(from, to) {
    for (const path of [...docs.keys()]) if (isWithin(path, from)) moveDoc(path, replacePrefix(path, from, to));
  },
  removed(path) {
    for (const open of [...docs.keys()]) if (isWithin(open, path)) closeDocument(open);
  },
});

// ------------------------------------------------------------------ wiring

function closeAll() {
  for (const path of [...docs.keys()]) disposeDoc(path);
  recent = [];
  useDocuments.setState({ tabs: [], active: null, reveal: null, closing: null });
}

let workspaceRoot = useApp.getState().workspace?.root ?? null;
useApp.subscribe((s) => {
  const root = s.workspace?.root ?? null;
  if (root === workspaceRoot) return;
  workspaceRoot = root;
  closeAll();
});

useDocuments.subscribe((s, prev) => {
  const bridge = useEditorBridge.getState();
  if (s.tabs !== prev.tabs) {
    bridge.setOpenPaths(s.tabs.map((t) => t.path));
    bridge.setDirtyPaths(s.tabs.filter((t) => t.dirty).map((t) => t.path));
  }
  if (s.active !== prev.active) {
    bridge.setActive(s.active);
    if (!s.active) bridge.setSelection(null);
  }
});

// Requests from chat, agents, search and the tree. Requests made before the
// editor bundle loaded are picked up here too.
let handledRequest = 0;
function handleOpenRequest() {
  const request = useEditorBridge.getState().openRequest;
  if (!request || request.seq <= handledRequest) return;
  handledRequest = request.seq;
  const layout = useLayout.getState();
  if (layout.main !== 'editor') layout.setMain('editor');
  const focus = takeEditorFocusRequest() || request.focus === true;
  void openDocument(request.path, request.line).then(() => {
    if (focus) focusEditor();
  });
}
useEditorBridge.subscribe((s, prev) => {
  if (s.openRequest !== prev.openRequest) handleOpenRequest();
});
handleOpenRequest();

void onEvent('fs://changed', onDiskChanged);

// This module owns live Monaco models and subscriptions; a hot update would
// leave a second copy behind, so development reloads the page instead.
import.meta.hot?.dispose(() => window.location.reload());
