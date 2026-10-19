// Pure helpers of the Skills page and the chat's "@" picker.

import type { RepoListing } from '../../bindings/RepoListing';
import type { SkillCandidate } from '../../bindings/SkillCandidate';
import type { SkillInfo } from '../../bindings/SkillInfo';
import type { SkillSource } from '../../bindings/SkillSource';
import type { SkillUpdate } from '../../bindings/SkillUpdate';

/** The first seven characters of a commit id, as GitHub shows them. */
export const shortCommit = (sha: string): string => sha.slice(0, 7);

export const isProjectSkill = (skill: SkillInfo): boolean => skill.source.kind === 'project';

/** Installed skills (any project) and the open project's own, each in the core's order. */
export function splitSkills(list: SkillInfo[]): { installed: SkillInfo[]; project: SkillInfo[] } {
  return { installed: list.filter((s) => !isProjectSkill(s)), project: list.filter(isProjectSkill) };
}

/** Where a skill came from, in one line: "owner/repo · folder", a folder on disk, or the project folder. */
export function sourceText(source: SkillSource): string {
  switch (source.kind) {
    case 'github':
      return source.path ? `${source.repo} · ${source.path}` : source.repo;
    case 'folder':
      return source.path;
    case 'recommended':
      return source.repo;
    case 'project':
      return '.agents/skills';
  }
}

/** The skill's folder on GitHub at the installed commit; null for other sources. */
export function sourceUrl(source: SkillSource): string | null {
  if (source.kind === 'recommended') return source.url;
  if (source.kind !== 'github') return null;
  const path = source.path ? `/${source.path.split('/').map(encodeURIComponent).join('/')}` : '';
  return `https://github.com/${source.repo}/tree/${source.commit}${path}`;
}

/** Switching on a skill whose content the user has not confirmed yet shows the content first. */
export const needsReview = (skill: SkillInfo, on: boolean): boolean => on && !skill.reviewed;

/** A skill of a listed repository that can be installed now. */
export const installable = (c: SkillCandidate): boolean => !c.error && !c.installed;

/** Adds or removes `path` from the chosen folders, keeping the listing's order. */
export function toggleChoice(chosen: string[], path: string, listing: RepoListing): string[] {
  const next = chosen.includes(path) ? chosen.filter((p) => p !== path) : [...chosen, path];
  const order = listing.candidates.map((c) => c.path);
  return next.filter((p) => order.includes(p)).sort((a, b) => order.indexOf(a) - order.indexOf(b));
}

/** Every installable folder, or none when all of them are chosen already. */
export function toggleAll(chosen: string[], listing: RepoListing): string[] {
  const all = listing.candidates.filter(installable).map((c) => c.path);
  return all.length > 0 && all.every((p) => chosen.includes(p)) ? [] : all;
}

/** How many files an update adds, changes and removes. */
export function updateCounts(u: SkillUpdate): { added: number; changed: number; removed: number } {
  return { added: u.added.length, changed: u.changed.length, removed: u.removed.length };
}

/** A skill as the chat's "@" picker offers it. */
export interface SkillMention {
  name: string;
  description: string;
}

/**
 * Enabled skills whose name contains the typed letters in order, those that
 * start with the query first. The chat attaches a skill written as "@name".
 */
export function matchSkills(query: string, skills: SkillMention[], limit = 5): SkillMention[] {
  const q = query.toLowerCase();
  const subsequence = (name: string) => {
    let at = 0;
    for (const ch of q) {
      at = name.indexOf(ch, at);
      if (at < 0) return false;
      at++;
    }
    return true;
  };
  const rank = (name: string) => (name.startsWith(q) ? 0 : name.includes(q) ? 1 : 2);
  return skills
    .filter((s) => subsequence(s.name))
    .map((s, i) => ({ s, i }))
    .sort((a, b) => rank(a.s.name) - rank(b.s.name) || a.i - b.i)
    .slice(0, limit)
    .map(({ s }) => s);
}

/** The enabled, usable skills of a list, for the "@" picker. */
export const mentionable = (list: SkillInfo[]): SkillMention[] => list.filter((s) => s.enabled && !s.error).map((s) => ({ name: s.name, description: s.description }));
