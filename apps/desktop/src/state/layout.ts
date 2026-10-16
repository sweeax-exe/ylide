// Which panels are visible. Remembered per device in localStorage.

import { create } from 'zustand';
import { readStored } from '../lib/storage';

export type SidebarView = 'explorer' | 'search';
export type RightView = 'chat' | 'agents';
export type MainView = 'editor' | 'models' | 'settings';

interface LayoutState {
  sidebar: SidebarView | null;
  right: RightView | null;
  main: MainView;
  quickOpen: boolean;
  setSidebar(v: SidebarView | null): void;
  toggleSidebar(v: SidebarView): void;
  setRight(v: RightView | null): void;
  toggleRight(v: RightView): void;
  setMain(v: MainView): void;
  setQuickOpen(open: boolean): void;
}

const KEY = 'ylide.layout';
// Key used before the product was renamed; read once and migrated.
const LEGACY_KEY = 'anyon.layout';

function load(): Partial<LayoutState> {
  try {
    return JSON.parse(readStored(KEY, LEGACY_KEY) ?? '{}') as Partial<LayoutState>;
  } catch {
    return {};
  }
}

function save(s: LayoutState) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ sidebar: s.sidebar, right: s.right }));
  } catch {
    // storage may be unavailable (private mode); layout just resets next time
  }
}

const initial = load();

export const useLayout = create<LayoutState>((set, get) => ({
  sidebar: initial.sidebar === undefined ? 'explorer' : initial.sidebar,
  right: initial.right === undefined ? 'chat' : initial.right,
  main: 'editor',
  quickOpen: false,
  setSidebar(sidebar) {
    set({ sidebar });
    save(get());
  },
  toggleSidebar(v) {
    set({ sidebar: get().sidebar === v ? null : v, main: 'editor' });
    save(get());
  },
  setRight(right) {
    set({ right });
    save(get());
  },
  toggleRight(v) {
    set({ right: get().right === v ? null : v });
    save(get());
  },
  setMain(main) {
    set({ main });
  },
  setQuickOpen(quickOpen) {
    set({ quickOpen });
  },
}));
