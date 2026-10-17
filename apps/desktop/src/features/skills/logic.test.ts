import { describe, expect, it } from 'vitest';
import type { RepoListing } from '../../bindings/RepoListing';
import type { SkillCandidate } from '../../bindings/SkillCandidate';
import type { SkillInfo } from '../../bindings/SkillInfo';
import { installable, matchSkills, mentionable, needsReview, shortCommit, sourceText, sourceUrl, splitSkills, toggleAll, toggleChoice, updateCounts } from './logic';

const skill = (name: string, over: Partial<SkillInfo> = {}): SkillInfo => ({
  id: name,
  name,
  description: `About ${name}.`,
  version: null,
  license: null,
  source: { kind: 'folder', path: `D:/skills/${name}` },
  enabled: false,
  reviewed: false,
  installedAtUnixMs: 0,
  files: 1,
  bytes: 100,
  error: null,
  ...over,
});

const candidate = (path: string, over: Partial<SkillCandidate> = {}): SkillCandidate => ({
  path,
  name: path.split('/').pop()!,
  description: '',
  version: null,
  files: 1,
  bytes: 10,
  installed: false,
  content: '',
  error: null,
  ...over,
});

const listing = (candidates: SkillCandidate[]): RepoListing => ({ repo: 'morluto/rea', gitRef: null, commit: '9744d07211ac750ae0273c4f91175eac0c890d9d', candidates });

describe('skills page', () => {
  it('splits installed skills from the project’s own', () => {
    const project = skill('deploy', { id: 'project:deploy', source: { kind: 'project' } });
    const { installed, project: own } = splitSkills([skill('pdf'), project, skill('rea')]);
    expect(installed.map((s) => s.id)).toEqual(['pdf', 'rea']);
    expect(own.map((s) => s.id)).toEqual(['project:deploy']);
  });

  it('names and links the source', () => {
    const github = { kind: 'github' as const, repo: 'morluto/rea', gitRef: null, path: '.agents/skills/reverse engineer', commit: '9744d07211ac750ae0273c4f91175eac0c890d9d', tree: 't' };
    expect(sourceText(github)).toBe('morluto/rea · .agents/skills/reverse engineer');
    expect(sourceUrl(github)).toBe('https://github.com/morluto/rea/tree/9744d07211ac750ae0273c4f91175eac0c890d9d/.agents/skills/reverse%20engineer');
    expect(sourceText({ ...github, path: '' })).toBe('morluto/rea');
    expect(sourceUrl({ ...github, path: '' })).toBe('https://github.com/morluto/rea/tree/9744d07211ac750ae0273c4f91175eac0c890d9d');
    expect(sourceText({ kind: 'folder', path: 'D:/skills/pdf' })).toBe('D:/skills/pdf');
    expect(sourceUrl({ kind: 'folder', path: 'D:/skills/pdf' })).toBeNull();
    expect(sourceText({ kind: 'project' })).toBe('.agents/skills');
    expect(shortCommit('9744d07211ac750ae0273c4f91175eac0c890d9d')).toBe('9744d07');
  });

  it('shows the content before the first switch-on only', () => {
    expect(needsReview(skill('a'), true)).toBe(true);
    expect(needsReview(skill('a'), false)).toBe(false);
    expect(needsReview(skill('a', { reviewed: true }), true)).toBe(false);
  });

  it('chooses installable skills of a repository in the listed order', () => {
    const l = listing([candidate('a'), candidate('b', { installed: true }), candidate('c', { error: 'too large' }), candidate('d')]);
    expect(l.candidates.filter(installable).map((c) => c.path)).toEqual(['a', 'd']);
    let chosen = toggleChoice([], 'd', l);
    chosen = toggleChoice(chosen, 'a', l);
    expect(chosen).toEqual(['a', 'd']);
    expect(toggleChoice(chosen, 'a', l)).toEqual(['d']);
    // Paths of an earlier listing drop out.
    expect(toggleChoice(['gone'], 'a', l)).toEqual(['a']);
    expect(toggleAll([], l)).toEqual(['a', 'd']);
    expect(toggleAll(['a', 'd'], l)).toEqual([]);
    expect(toggleAll(['a'], l)).toEqual(['a', 'd']);
    expect(toggleAll([], listing([candidate('x', { installed: true })]))).toEqual([]);
  });

  it('counts the changes of an update', () => {
    expect(updateCounts({ name: 'a', commit: 'c', upToDate: false, version: null, added: ['x', 'y'], removed: [], changed: ['SKILL.md'], diff: '' })).toEqual({ added: 2, changed: 1, removed: 0 });
  });
});

describe('skills in the chat picker', () => {
  it('offers enabled, usable skills only', () => {
    const list = [skill('pdf', { enabled: true }), skill('off'), skill('broken', { enabled: true, error: 'no description' })];
    expect(mentionable(list)).toEqual([{ name: 'pdf', description: 'About pdf.' }]);
  });

  it('matches by letters in order, names that start with the query first', () => {
    const skills = ['reverse-engineer-anything', 'rea-tool-design', 'pdf-forms', 'area'].map((name) => ({ name, description: '' }));
    expect(matchSkills('', skills).map((s) => s.name)).toEqual(['reverse-engineer-anything', 'rea-tool-design', 'pdf-forms', 'area']);
    expect(matchSkills('rea', skills).map((s) => s.name)).toEqual(['rea-tool-design', 'area', 'reverse-engineer-anything']);
    expect(matchSkills('REA', skills)).toHaveLength(3);
    expect(matchSkills('pf', skills).map((s) => s.name)).toEqual(['pdf-forms']);
    expect(matchSkills('zzz', skills)).toEqual([]);
    expect(matchSkills('', skills, 2)).toHaveLength(2);
  });
});
