// Jumping to a section of the settings or models view from elsewhere in the
// feature, e.g. "Open network settings" next to a disabled download button.

import { create } from 'zustand';
import { useLayout } from '../../../state/layout';

export type View = 'settings' | 'models';

interface NavState {
  target: { view: View; section: string } | null;
  clear(): void;
}

export const useSectionTarget = create<NavState>((set) => ({
  target: null,
  clear: () => set({ target: null }),
}));

/** Shows the view and scrolls to the section (ids as passed to `Page`). */
export function openSection(view: View, section: string): void {
  useSectionTarget.setState({ target: { view, section } });
  useLayout.getState().setMain(view);
}
