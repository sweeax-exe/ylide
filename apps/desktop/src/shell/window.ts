// Window controls for the custom title bar (no-ops in the browser preview).

import { useEffect, useState } from 'react';
import { isTauri } from '../lib/ipc';

async function current() {
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  return getCurrentWindow();
}

export const windowControls = {
  minimize: async () => isTauri && (await current()).minimize(),
  toggleMaximize: async () => isTauri && (await current()).toggleMaximize(),
  close: async () => isTauri && (await current()).close(),
  setTitle: async (title: string) => {
    if (isTauri) await (await current()).setTitle(title);
    else document.title = title;
  },
  isMaximized: async () => isTauri && (await current()).isMaximized(),
  /**
   * Calls `cb` with the maximized state now and whenever it changes, including
   * changes made outside the app (Win+Up, Aero snap, double-click on the drag
   * region). Returns an unsubscribe function.
   */
  onMaximizedChange(cb: (maximized: boolean) => void): () => void {
    if (!isTauri) return () => undefined;
    let stopped = false;
    let unlisten: (() => void) | undefined;
    void (async () => {
      const win = await current();
      const report = async () => {
        if (!stopped) cb(await win.isMaximized());
      };
      await report();
      const off = await win.onResized(() => void report());
      if (stopped) off();
      else unlisten = off;
    })();
    return () => {
      stopped = true;
      unlisten?.();
    };
  },
};

/** Whether the window is maximized, following changes from outside the app too. */
export function useMaximized(): boolean {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => windowControls.onMaximizedChange(setMaximized), []);
  return maximized;
}
