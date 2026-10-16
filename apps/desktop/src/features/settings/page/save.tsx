// Saving settings. Saves run one after another so that two quick edits never
// start from the same stale copy (updateSettings clones the current settings).

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Settings } from '../../../bindings/Settings';
import { reportError } from '../../../lib/errors';
import { useApp } from '../../../state/app';

export type Change = (draft: Settings) => void;
export type Saver = (change: Change) => Promise<boolean>;
export type SaveStatus = 'idle' | 'saved';

let queue: Promise<unknown> = Promise.resolve();

/** Persists a change after all earlier changes are saved. */
export function saveSettings(change: Change): Promise<void> {
  const run = queue.then(() => useApp.getState().updateSettings(change));
  queue = run.catch(() => undefined);
  return run;
}

const SAVED_VISIBLE_MS = 2200;

/** A saver that reports errors and remembers when it last saved, for a quiet "Saved" label. */
export function useSaverState(): { save: Saver; status: SaveStatus } {
  const { t } = useTranslation('settings');
  const [status, setStatus] = useState<SaveStatus>('idle');
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const save = useCallback<Saver>(
    async (change) => {
      try {
        await saveSettings(change);
        window.clearTimeout(timer.current);
        setStatus('saved');
        timer.current = window.setTimeout(() => setStatus('idle'), SAVED_VISIBLE_MS);
        return true;
      } catch (e) {
        reportError(e, t('saveFailed'));
        return false;
      }
    },
    [t],
  );
  return { save, status };
}

const SaveContext = createContext<Saver>(async (change) => {
  try {
    await saveSettings(change);
    return true;
  } catch (e) {
    reportError(e);
    return false;
  }
});

export const SaveProvider = SaveContext.Provider;

/** The saver of the surrounding settings group. */
export function useSave(): Saver {
  return useContext(SaveContext);
}

/** Current settings; the workbench only renders once they are loaded. */
export function useSettings(): Settings | null {
  return useApp((s) => s.settings);
}
