// Updates: the check at startup (or by hand), the installer download and the
// handover to the installer. The core decides whether checking is allowed and
// verifies the installer; this store shows the result and asks right before
// Ylide closes, so unsaved files or a running agent are never lost unasked.

import { create } from 'zustand';
import type { UpdateOutcome } from '../bindings/UpdateOutcome';
import type { UpdateProgress } from '../bindings/UpdateProgress';
import i18n from '../i18n';
import { errorText } from '../lib/errors';
import { api } from '../lib/ipc';
import { useConfirm } from './confirm';
import { useEditorBridge } from './editorBridge';
import { useToasts } from './toasts';

/**
 * idle → checking → idle (with an outcome); for an available update:
 * downloading → ready (verified installer on disk) → handedOver (Ylide closes).
 */
export type UpdatePhase = 'idle' | 'checking' | 'downloading' | 'ready' | 'handedOver';

interface UpdateState {
  phase: UpdatePhase;
  /** Result of the last check; `null` before the first one. */
  outcome: UpdateOutcome | null;
  progress: UpdateProgress | null;
  /** Why the last download or install failed. */
  installError: string | null;
  /**
   * Checks for a newer version. The startup check stays silent unless it finds
   * one, which it then offers in a notice.
   */
  check(options?: { startup?: boolean }): Promise<void>;
  /** Downloads and verifies the update (if needed), then asks and hands over to the installer. */
  install(): Promise<void>;
}

const t = (key: string, options?: Record<string, unknown>) => i18n.t(`common:update.${key}`, options);

/** Whether an agent run is active; loaded lazily so this store does not depend on the agents feature. */
async function agentRunning(): Promise<boolean> {
  const { useAgentRun } = await import('../features/agents/store');
  const phase = useAgentRun.getState().phase;
  return phase === 'starting' || phase === 'running';
}

export const useUpdates = create<UpdateState>((set, get) => ({
  phase: 'idle',
  outcome: null,
  progress: null,
  installError: null,

  async check(options) {
    if (get().phase !== 'idle') return;
    set({ phase: 'checking' });
    let outcome: UpdateOutcome;
    try {
      outcome = await api.updates.check(options?.startup ?? false);
    } catch (e) {
      outcome = { result: 'failed', message: errorText(e) };
    }
    set({ phase: 'idle', outcome });
    if (options?.startup && outcome.result === 'available') {
      const version = outcome.version;
      useToasts.getState().push({
        tone: 'neutral',
        title: t('availableTitle', { version }),
        body: t('availableBody'),
        duration: 0,
        action: { label: t('install'), run: () => void get().install() },
      });
    }
  },

  async install() {
    const outcome = get().outcome;
    if (outcome?.result !== 'available') return;
    if (get().phase === 'idle') {
      // Downloading changes nothing yet, so it needs no question.
      set({ phase: 'downloading', progress: null, installError: null });
      try {
        await api.updates.download((progress) => set({ progress }));
      } catch (e) {
        const message = errorText(e);
        set({ phase: 'idle', installError: message });
        useToasts.getState().push({ tone: 'danger', title: t('failedTitle'), body: message });
        return;
      }
      set({ phase: 'ready' });
    }
    if (get().phase !== 'ready') return;
    // Ask now, right before Ylide closes: the download may have taken a while.
    const dirty = useEditorBridge.getState().dirtyPaths.length;
    const notes = [t('confirmBody')];
    if (dirty > 0) notes.push(t('confirmDirty', { count: dirty }));
    if (await agentRunning()) notes.push(t('confirmAgent'));
    const ok = await useConfirm.getState().ask({
      title: t('confirmTitle', { version: outcome.version }),
      body: notes.join(' '),
      confirmLabel: t('confirm'),
      danger: dirty > 0,
    });
    if (!ok) return;
    try {
      await api.updates.launch();
      // The installer runs now and closes Ylide; nothing more to do here.
      set({ phase: 'handedOver' });
    } catch (e) {
      const message = errorText(e);
      set({ installError: message });
      useToasts.getState().push({ tone: 'danger', title: t('failedTitle'), body: message });
    }
  },
}));
