// App-wide confirmation dialogs for actions that lose data (rendered by
// components/ConfirmHost). `ask` resolves to true when the user confirms.

import { create } from 'zustand';

export interface ConfirmRequest {
  title: string;
  body: string;
  confirmLabel: string;
  /** Styles the confirm button as destructive. */
  danger?: boolean;
}

interface ConfirmState {
  current: (ConfirmRequest & { resolve: (ok: boolean) => void }) | null;
  ask(request: ConfirmRequest): Promise<boolean>;
  settle(ok: boolean): void;
}

export const useConfirm = create<ConfirmState>((set, get) => ({
  current: null,
  ask: (request) =>
    new Promise<boolean>((resolve) => {
      // A newer question replaces an unanswered one, which counts as "no".
      get().current?.resolve(false);
      set({ current: { ...request, resolve } });
    }),
  settle: (ok) => {
    const current = get().current;
    if (!current) return;
    set({ current: null });
    current.resolve(ok);
  },
}));
