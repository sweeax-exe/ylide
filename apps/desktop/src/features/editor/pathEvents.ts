// File tree -> open editors: renames and deletions made in the tree. Kept free
// of Monaco so the tree does not pull the editor bundle in.

export interface PathListener {
  moved(from: string, to: string): void;
  removed(path: string): void;
}

const listeners = new Set<PathListener>();

export function onPathEvents(listener: PathListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function pathMoved(from: string, to: string): void {
  listeners.forEach((l) => l.moved(from, to));
}

export function pathRemoved(path: string): void {
  listeners.forEach((l) => l.removed(path));
}

// Opening a file normally moves focus into the editor. Views that keep focus
// for keyboard navigation (the file tree, the tab strip) mark themselves with
// `data-preserve-focus` and ask for focus explicitly when they want it.
let focusRequested = false;

/** The next file opened through the bridge takes keyboard focus. */
export function requestEditorFocus(): void {
  focusRequested = true;
}

export function takeEditorFocusRequest(): boolean {
  const requested = focusRequested;
  focusRequested = false;
  return requested;
}

/** True while focus is in a view that keeps it when a file opens. */
export function focusIsPreserved(): boolean {
  if (typeof document === 'undefined') return false;
  return document.activeElement?.closest('[data-preserve-focus]') != null;
}
