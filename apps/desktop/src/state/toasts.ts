import { create } from 'zustand';

export type ToastTone = 'neutral' | 'success' | 'warning' | 'danger';

export interface Toast {
  id: number;
  tone: ToastTone;
  title: string;
  body?: string;
  /** Milliseconds; 0 keeps it until dismissed. */
  duration: number;
  /** A button in the toast; clicking it runs `run` and closes the toast. */
  action?: { label: string; run: () => void };
}

interface ToastState {
  toasts: Toast[];
  push(t: Omit<Toast, 'id' | 'duration'> & { duration?: number }): void;
  dismiss(id: number): void;
}

let next = 1;

export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],
  push(t) {
    const toast: Toast = { duration: t.tone === 'danger' ? 0 : 4500, ...t, id: next++ };
    set({ toasts: [...get().toasts.slice(-4), toast] });
    if (toast.duration > 0) setTimeout(() => get().dismiss(toast.id), toast.duration);
  },
  dismiss(id) {
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },
}));
