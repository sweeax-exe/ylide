// Skills in the browser mock (see ./mock.ts): installed skills, the demo
// project's own skill, and a GitHub repository to add from. Like the core,
// it refuses GitHub while skill downloads are off and logs every request.
//
//   ?mock=skills       starts with installed skills (one broken)
//   ?mock=ratelimit    GitHub answers that its request limit is used up

import type { NetworkLogEntry } from '../bindings/NetworkLogEntry';
import type { RecommendedInfo } from '../bindings/RecommendedInfo';
import type { RepoListing } from '../bindings/RepoListing';
import type { SkillCandidate } from '../bindings/SkillCandidate';
import type { SkillContent } from '../bindings/SkillContent';
import type { SkillInfo } from '../bindings/SkillInfo';
import type { SkillUpdate } from '../bindings/SkillUpdate';

type Log = (purpose: NetworkLogEntry['purpose'], url: string, outcome: string) => void;

interface Context {
  failures: Set<string>;
  downloadsAllowed: boolean;
  projectOpen: boolean;
  log: Log;
}

interface MockSkill {
  info: SkillInfo;
  text: string;
  files: string[];
}

const COMMIT = '9744d07211ac750ae0273c4f91175eac0c890d9d';
const NEWER = '5c1f0e2b7d9a4c6e8f0a1b2c3d4e5f60718293a4';

const md = (name: string, description: string, body: string, version?: string) =>
  `---\nname: ${name}\ndescription: ${description}\n${version ? `metadata:\n  version: "${version}"\n` : ''}---\n\n${body}\n`;

/** Skills of the demo repository (short stand-ins, not the real texts). */
const REPO: Array<{ path: string; name: string; description: string; version?: string; files: string[]; body: string }> = [
  {
    path: '.agents/skills/reverse-engineer-anything',
    name: 'reverse-engineer-anything',
    description: 'Reverse engineer native, managed, Electron and browser targets with REA, from shipped artifacts or runtime evidence. Skip it for ordinary source code analysis.',
    version: '42',
    files: ['SKILL.md', 'references/connection-and-recovery.md', 'references/evidence-workflows.md', 'references/javascript-applications.md', 'references/native-and-artifacts.md'],
    body: '# REA\n\nUse REA when a claim depends on a shipped binary or package.\n\n## Connect only when needed\n\nThis skill supplies instructions only. It does not register the REA MCP server or install analysis engines.\n\nRead [connection and recovery](references/connection-and-recovery.md) when the tools are missing.\n',
  },
  {
    path: '.agents/skills/rea-analysis-optimization',
    name: 'rea-analysis-optimization',
    description: 'Optimize REA providers and shared analysis workflows for context, latency, CPU and memory while keeping results correct.',
    files: ['SKILL.md', 'agents/openai.yaml', 'references/kuna-case-study.md'],
    body: '# Analysis optimization\n\nFind a concrete source of unnecessary work, change it where it is owned, and measure before and after.\n',
  },
  {
    path: '.agents/skills/rea-changelog-update',
    name: 'rea-changelog-update',
    description: 'Write changelog entries for REA releases from merged changes.',
    files: ['SKILL.md'],
    body: '# Changelog\n\nCollect the merged changes since the last release and group them by user impact.\n',
  },
  {
    path: '.agents/skills/rea-ci-tests-audit',
    name: 'rea-ci-tests-audit',
    description: 'Audit CI and test correctness, drift and measured performance before proposing changes.',
    files: ['SKILL.md', 'agents/openai.yaml', 'references/measurement-and-ci.md'],
    body: '# CI and tests audit\n\nCheck that every test runs where it should, then measure before changing anything.\n',
  },
  {
    path: '.agents/skills/rea-tool-design',
    name: 'rea-tool-design',
    description: 'Design or change REA investigation tools, CLI and MCP contracts, provider capabilities and Evidence semantics.',
    files: ['SKILL.md'],
    body: '# Tool design\n\nInspect the current contract and the nearest existing tool before proposing a new one.\n',
  },
];

const PROJECT_SKILL: MockSkill = {
  info: {
    id: 'project:deploy-shop',
    name: 'deploy-shop',
    description: 'How this shop is built and deployed: the build command, the staging check and the release steps.',
    version: null,
    license: null,
    source: { kind: 'project' },
    enabled: false,
    reviewed: false,
    installedAtUnixMs: 0,
    files: 1,
    bytes: 640,
    error: null,
  },
  text: md('deploy-shop', 'How this shop is built and deployed: the build command, the staging check and the release steps.', '# Deploy\n\n1. Run `npm test`.\n2. Run `npm run build`.\n3. Open the staging address and check the cart.\n'),
  files: ['SKILL.md'],
};

function fromRepo(path: string, enabled = false, reviewed = false): MockSkill {
  const r = REPO.find((x) => x.path === path)!;
  const text = md(r.name, r.description, r.body, r.version);
  return {
    info: {
      id: r.name,
      name: r.name,
      description: r.description,
      version: r.version ?? null,
      license: null,
      source: { kind: 'github', repo: 'morluto/rea', gitRef: null, path: r.path, commit: COMMIT, tree: `tree-${r.name}` },
      enabled,
      reviewed,
      installedAtUnixMs: Date.now() - 86_400_000,
      files: r.files.length,
      bytes: text.length + (r.files.length - 1) * 4_800,
      error: null,
    },
    text,
    files: r.files,
  };
}

const folderSkill = (): MockSkill => {
  const text = md('pdf-forms', 'Fill in and check PDF forms with qpdf; use when the user asks about PDF forms or fields.', '# PDF forms\n\nList the fields with `qpdf --json`, then fill them with the helper in scripts/fill.py.\n', '1.2');
  return {
    info: {
      id: 'pdf-forms',
      name: 'pdf-forms',
      description: 'Fill in and check PDF forms with qpdf; use when the user asks about PDF forms or fields.',
      version: '1.2',
      license: 'Apache-2.0',
      source: { kind: 'folder', path: 'D:/skills/pdf-forms' },
      enabled: false,
      reviewed: false,
      installedAtUnixMs: Date.now(),
      files: 2,
      bytes: text.length + 1_900,
      error: null,
    },
    text,
    files: ['SKILL.md', 'scripts/fill.py'],
  };
};

// A recommended skill bundled with Ylide (the real one vendors REA's files;
// the mock uses a short stand-in text), pinned to a commit.
const REC_COMMIT = 'f4322b15ed1423d736bd2572cf7a8eadf2b466e1';
const REA_REC = {
  name: 'reverse-engineer-anything',
  description:
    'Reverse engineer native, managed, Electron/JavaScript, packaged, firmware, and browser targets with REA. Use shipped-artifact or requested runtime evidence to explain features, compare versions, decompile code, or guide a reconstruction. Skip REA for ordinary source-repository architecture analysis.',
  version: '42',
  files: ['SKILL.md', 'references/android-applications.md', 'references/connection-and-recovery.md', 'references/evidence-workflows.md', 'references/javascript-applications.md', 'references/native-and-artifacts.md', 'references/runtime-observation.md'],
  body: '# REA\n\nUse REA when a claim depends on a shipped binary or package, decompilation, or passive runtime evidence.\n\n## Connect only when needed\n\nInstalling this skill supplies instructions; it does not register the REA MCP server, install analysis engines, or add tools to an already-running agent.\n\nRead [connection and recovery](references/connection-and-recovery.md) when the tools are missing.\n',
  url: `https://github.com/morluto/rea/tree/${REC_COMMIT}/.agents/skills/reverse-engineer-anything`,
};

function reaText() {
  return md(REA_REC.name, REA_REC.description, REA_REC.body, REA_REC.version);
}

function recommendedList(): RecommendedInfo[] {
  const text = reaText();
  return [
    {
      id: REA_REC.name,
      name: REA_REC.name,
      description: REA_REC.description,
      version: REA_REC.version,
      repo: 'morluto/rea',
      commit: REC_COMMIT,
      license: 'MIT',
      url: REA_REC.url,
      docsUrl: 'https://rea.tools',
      needsMcp: true,
      mcpNote: "REA's server (the npm package rea-agents). Check the exact command for your setup at rea.tools; its analysis engines (Ghidra, IDA, …) are installed separately.",
      files: REA_REC.files.length,
      bytes: text.length + (REA_REC.files.length - 1) * 7_000,
      installed: installed.some((s) => s.info.name === REA_REC.name),
      error: null,
    },
  ];
}

function reaInstalled(): MockSkill {
  const text = reaText();
  return {
    info: {
      id: REA_REC.name,
      name: REA_REC.name,
      description: REA_REC.description,
      version: REA_REC.version,
      license: 'MIT',
      source: { kind: 'recommended', repo: 'morluto/rea', commit: REC_COMMIT, license: 'MIT', url: REA_REC.url },
      enabled: true,
      reviewed: true,
      installedAtUnixMs: Date.now(),
      files: REA_REC.files.length,
      bytes: text.length + (REA_REC.files.length - 1) * 7_000,
      error: null,
    },
    text,
    files: REA_REC.files,
  };
}

let installed: MockSkill[] = [];
let projectState = { enabled: false, reviewed: false };
let started = false;

function start(ctx: Context) {
  if (started) return;
  started = true;
  if (!ctx.failures.has('skills')) return;
  installed = [fromRepo('.agents/skills/reverse-engineer-anything', true, true), fromRepo('.agents/skills/rea-tool-design'), folderSkill()];
  installed.push({
    info: { ...folderSkill().info, id: 'old-notes', name: 'old-notes', description: '', version: null, license: null, source: { kind: 'folder', path: 'D:/skills/old-notes' }, error: 'the frontmatter has no description', files: 1, bytes: 120 },
    text: '---\nname: old-notes\n---\nNotes without a description.\n',
    files: ['SKILL.md'],
  });
}

function list(ctx: Context): SkillInfo[] {
  const own = [...installed].sort((a, b) => a.info.name.localeCompare(b.info.name)).map((s) => s.info);
  const project = ctx.projectOpen ? [{ ...PROJECT_SKILL.info, ...projectState }] : [];
  return structuredClone([...own, ...project]);
}

const fail = (code: string, message: string) => ({ code, message });

function github(ctx: Context, url: string) {
  if (!ctx.downloadsAllowed) throw fail('network_disabled', 'SkillDownload is disabled in the network settings');
  if (ctx.failures.has('ratelimit') && url.includes('api.github.com')) {
    ctx.log('skillDownload', url, '403');
    throw fail('skill_rate_limited', "GitHub's limit for requests without an account is used up for this hour");
  }
  ctx.log('skillDownload', url, '200');
}

function candidates(names: Set<string>): SkillCandidate[] {
  return REPO.map((r) => {
    const text = md(r.name, r.description, r.body, r.version);
    return { path: r.path, name: r.name, description: r.description, version: r.version ?? null, files: r.files.length, bytes: text.length + (r.files.length - 1) * 4_800, installed: names.has(r.name), content: text, error: null };
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function skillsCommand(command: string, args: Record<string, any>, ctx: Context): Promise<unknown> {
  start(ctx);
  const find = (name: string) => {
    const s = installed.find((x) => x.info.name === name);
    if (!s) throw fail('skill_not_found', `there is no skill '${name}'`);
    return s;
  };
  switch (command) {
    case 'skills_list':
      return list(ctx);
    case 'skills_set_enabled': {
      const { id, enabled } = args as { id: string; enabled: boolean };
      if (id === PROJECT_SKILL.info.id) projectState = { enabled, reviewed: projectState.reviewed || enabled };
      else {
        const s = find(id);
        if (s.info.error) throw fail('skill_not_found', id);
        s.info.enabled = enabled;
        s.info.reviewed ||= enabled;
      }
      return list(ctx);
    }
    case 'skills_remove':
      find(args.name);
      installed = installed.filter((s) => s.info.name !== args.name);
      return list(ctx);
    case 'skills_content': {
      const s = args.id === PROJECT_SKILL.info.id ? PROJECT_SKILL : find(args.id);
      return { text: s.text, files: s.files } satisfies SkillContent;
    }
    case 'skills_recommended':
      return recommendedList();
    case 'skills_recommended_content': {
      if (args.name !== REA_REC.name) throw fail('skill_not_found', `there is no skill '${args.name}'`);
      return { text: reaText(), files: REA_REC.files } satisfies SkillContent;
    }
    case 'skills_install_recommended': {
      if (args.name !== REA_REC.name) throw fail('skill_not_found', `there is no skill '${args.name}'`);
      if (installed.some((s) => s.info.name === REA_REC.name)) throw fail('skill_exists', `a skill called '${REA_REC.name}' is already installed`);
      await sleep(300);
      installed.push(reaInstalled());
      return list(ctx);
    }
    case 'skills_browse': {
      const address = String(args.address).trim();
      const m = address.match(/^(?:https?:\/\/)?(?:www\.)?(?:github\.com\/)?([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?(?:\/|$)/);
      if (!m || /^(?:https?:\/\/)?(?!github\.com)[a-z0-9-]+\.[a-z.]+\//i.test(address)) throw fail('skill_address', `'${address}' is not a GitHub address`);
      const repo = `${m[1]}/${m[2]}`;
      github(ctx, `https://api.github.com/repos/${repo}/commits/HEAD`);
      await sleep(350);
      github(ctx, `https://api.github.com/repos/${repo}/git/trees/${COMMIT}?recursive=1`);
      if (repo !== 'morluto/rea') throw fail('skill_none_found', `${repo}: there is no SKILL.md in it`);
      for (const r of REPO) github(ctx, `https://raw.githubusercontent.com/${repo}/${COMMIT}/${r.path}/SKILL.md`);
      await sleep(400);
      return { repo, gitRef: null, commit: COMMIT, candidates: candidates(new Set(installed.map((s) => s.info.name))) } satisfies RepoListing;
    }
    case 'skills_install_github': {
      const paths = args.paths as string[];
      for (const p of paths) {
        const r = REPO.find((x) => x.path === p)!;
        if (installed.some((s) => s.info.name === r.name)) throw fail('skill_exists', `a skill called '${r.name}' is already installed`);
        for (const f of r.files) github(ctx, `https://raw.githubusercontent.com/${args.repo}/${args.commit}/${p}/${f}`);
      }
      await sleep(500);
      const added = paths.map((p) => fromRepo(p));
      installed.push(...added);
      return added.map((s) => s.info);
    }
    case 'skills_install_folder': {
      await sleep(200);
      const s = folderSkill();
      if (installed.some((x) => x.info.name === s.info.name)) throw fail('skill_exists', `a skill called '${s.info.name}' is already installed`);
      installed.push(s);
      return [s.info];
    }
    case 'skills_check_update': {
      const s = find(args.name);
      const source = s.info.source;
      if (source.kind !== 'github') return { name: s.info.name, commit: '', upToDate: true, version: null, added: [], removed: [], changed: [], diff: '' } satisfies SkillUpdate;
      github(ctx, `https://api.github.com/repos/${source.repo}/commits/HEAD`);
      await sleep(300);
      if (s.info.name !== 'reverse-engineer-anything' || source.commit === NEWER) return { name: s.info.name, commit: source.commit, upToDate: true, version: null, added: [], removed: [], changed: [], diff: '' } satisfies SkillUpdate;
      github(ctx, `https://api.github.com/repos/${source.repo}/git/trees/${NEWER}?recursive=1`);
      return {
        name: s.info.name,
        commit: NEWER,
        upToDate: false,
        version: '43',
        added: ['references/runtime-observation.md'],
        removed: [],
        changed: ['SKILL.md'],
        diff: '--- SKILL.md (installed)\n+++ SKILL.md (new)\n@@ -2,7 +2,7 @@\n name: reverse-engineer-anything\n description: Reverse engineer native, managed, Electron and browser targets with REA, from shipped artifacts or runtime evidence. Skip it for ordinary source code analysis.\n metadata:\n-  version: "42"\n+  version: "43"\n ---\n \n # REA\n@@ -12,3 +12,5 @@\n This skill supplies instructions only. It does not register the REA MCP server or install analysis engines.\n \n Read [connection and recovery](references/connection-and-recovery.md) when the tools are missing.\n+\n+For live processes, read [runtime observation](references/runtime-observation.md).\n',
      } satisfies SkillUpdate;
    }
    case 'skills_update': {
      const s = find(args.name);
      if (s.info.source.kind === 'github') {
        s.info.source = { ...s.info.source, commit: args.commit, tree: `tree-${args.commit}` };
        s.info.version = '43';
        s.info.files += 1;
      }
      await sleep(300);
      return structuredClone(s.info);
    }
    default:
      return undefined;
  }
}

/** Context chips for the skills a chat mentions as "@name" (like the core). */
export function mentionedSkillItems(userTexts: string[]) {
  const enabled = [...installed.filter((s) => s.info.enabled && !s.info.error), ...(projectState.enabled ? [PROJECT_SKILL] : [])];
  const names: string[] = [];
  for (const text of userTexts) {
    for (const m of text.matchAll(/(?:^|[\s([{"'`])@([a-z0-9-]+)/gi)) {
      const name = m[1].toLowerCase().replace(/-+$/, '');
      if (enabled.some((s) => s.info.name === name) && !names.includes(name)) names.push(name);
    }
  }
  return names.slice(0, 3).map((name) => {
    const s = enabled.find((x) => x.info.name === name)!;
    return { kind: 'skill' as const, label: `@${name}`, path: null, content: s.text, tokens: Math.ceil(s.text.length / 3.5), truncated: false, error: null };
  });
}
