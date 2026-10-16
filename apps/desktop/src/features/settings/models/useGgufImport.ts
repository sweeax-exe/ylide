// Importing a GGUF file the user already has: pick it, register it, refresh
// the installed models. Used on the Models page and in onboarding.

import { useRef, useState } from 'react';
import type { InstalledModel } from '../../../bindings/InstalledModel';
import { reportError } from '../../../lib/errors';
import { api, pickGguf } from '../../../lib/ipc';
import { useApp } from '../../../state/app';
import { keepFocusInSection } from '../page/focus';

/**
 * `importFile(from)` opens the file picker and imports the chosen file;
 * `onImported` runs once the installed models include it. Errors are shown
 * under `failedTitle`. With `from`, focus stays in its section if the button
 * is replaced (an empty state that fills).
 */
export function useGgufImport(failedTitle: string, onImported: (model: InstalledModel) => void): { importing: boolean; importFile: (from?: HTMLElement) => Promise<void> } {
  const [importing, setImporting] = useState(false);
  // One picker at a time: the button only shows that it is busy once a file is chosen.
  const picking = useRef(false);

  const importFile = async (from?: HTMLElement) => {
    if (picking.current) return;
    picking.current = true;
    const restoreFocus = keepFocusInSection(from ?? null);
    try {
      const path = await pickGguf();
      if (!path) return;
      setImporting(true);
      const model = await api.models.import(path);
      await useApp.getState().refreshModels();
      onImported(model);
    } catch (e) {
      reportError(e, failedTitle);
    } finally {
      picking.current = false;
      setImporting(false);
      restoreFocus();
    }
  };

  return { importing, importFile };
}
