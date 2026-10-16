// Moves focus to the chat composer from elsewhere in the chat (Retry) and on
// Ctrl+L. The shell opens the chat panel on Ctrl+L; when the panel is only
// being mounted by that shortcut, the composer takes focus as soon as it
// registers.

/** How long a focus request waits for a composer that is still mounting. */
const PENDING_MS = 1000;

let focusFn: (() => void) | null = null;
let requestedAt = 0;

export function registerComposer(focus: () => void): () => void {
  focusFn = focus;
  if (Date.now() - requestedAt < PENDING_MS) focus();
  return () => {
    if (focusFn === focus) focusFn = null;
  };
}

export function focusComposer(): void {
  requestedAt = Date.now();
  focusFn?.();
}

// Capture phase: runs before the shell's handler that mounts the panel.
function onKey(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'l') focusComposer();
}

window.addEventListener('keydown', onKey, true);
import.meta.hot?.dispose(() => window.removeEventListener('keydown', onKey, true));
