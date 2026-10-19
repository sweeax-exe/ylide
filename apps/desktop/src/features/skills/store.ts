// The skills the core knows (installed and the open project's own) and the
// recommended skills bundled with Ylide, shared by the Skills page and the
// chat's "@" picker.

import { create } from 'zustand';
import type { RecommendedInfo } from '../../bindings/RecommendedInfo';
import type { SkillInfo } from '../../bindings/SkillInfo';
import { errorText } from '../../lib/errors';
import { api } from '../../lib/ipc';

interface SkillsState {
  skills: SkillInfo[] | null;
  /** Recommended skills bundled with Ylide, not yet installed are offered on the page. */
  recommended: RecommendedInfo[] | null;
  error: string | null;
  /** Reads both lists again (after a project opens, or when the page is shown). */
  load(): Promise<void>;
  /** Takes the installed list a command returned (recommended is unchanged). */
  set(skills: SkillInfo[]): void;
}

export const useSkills = create<SkillsState>((set) => ({
  skills: null,
  recommended: null,
  error: null,
  async load() {
    try {
      const [skills, recommended] = await Promise.all([api.skills.list(), api.skills.recommended()]);
      set({ skills, recommended, error: null });
    } catch (e) {
      set({ error: errorText(e) });
    }
  },
  set(skills) {
    set({ skills, error: null });
  },
}));
