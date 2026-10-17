// The skills the core knows (installed and the open project's own), shared
// by the Skills page and the chat's "@" picker.

import { create } from 'zustand';
import type { SkillInfo } from '../../bindings/SkillInfo';
import { errorText } from '../../lib/errors';
import { api } from '../../lib/ipc';

interface SkillsState {
  skills: SkillInfo[] | null;
  error: string | null;
  /** Reads the list again (after a project opens, or when the page is shown). */
  load(): Promise<void>;
  /** Takes the list a command returned. */
  set(skills: SkillInfo[]): void;
}

export const useSkills = create<SkillsState>((set) => ({
  skills: null,
  error: null,
  async load() {
    try {
      set({ skills: await api.skills.list(), error: null });
    } catch (e) {
      set({ error: errorText(e) });
    }
  },
  set(skills) {
    set({ skills, error: null });
  },
}));
