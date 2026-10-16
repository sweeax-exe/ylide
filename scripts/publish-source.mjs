#!/usr/bin/env node
// Publishes the source code of a released version to the public GitHub
// repository: one commit per release ("Ylide 0.1.5", tagged v0.1.5), made from
// exactly the committed files of the release commit (`git archive`), so files
// that git ignores can never end up there. The development history stays here.
// See docs/releasing.md.
//
//   node scripts/publish-source.mjs                 dry run: build the snapshot, check it, show what changes
//   node scripts/publish-source.mjs --publish       commit, tag, push and create the GitHub release
//   ... --commit <rev>     the release commit (default: HEAD)
//   ... --docs-from <rev>  take the public-facing documents (README, .github, docs/images, ...) from
//                          another commit, for a release whose documents were written later
//   ... --init             start the public repository (first release only)
//   ... --trailer <text>   append a line to the commit message (repeatable)
//
// The snapshot is checked before anything is committed: no key files, no
// private keys or tokens, no local paths of this machine, and none of the
// terms listed in ~/.ylide-publish-deny (one per line, kept out of the
// repository on purpose: it names things that must stay private).

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'sweeax-exe/ylide';
const REMOTE = `https://github.com/${REPO}.git`;
const clone = join(root, 'target', 'public-repo');
const DOCS = ['README.md', 'README.de.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CODE_OF_CONDUCT.md', 'docs/trust.md', 'docs/images', '.github', '.gitignore'];

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const options = (name) => args.flatMap((a, i) => (a === name ? [args[i + 1]] : []));
const publish = flag('--publish');

const run = (cmd, cmdArgs, opts = {}) => execFileSync(cmd, cmdArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 30, ...opts });
const git = (cwd, ...a) => run('git', a, { cwd }).trim();
const fail = (msg) => {
  console.error(`publish-source: ${msg}`);
  process.exit(1);
};

// ------------------------------------------------------------------ the release
const commit = git(root, 'rev-parse', '--verify', `${option('--commit') ?? 'HEAD'}^{commit}`);
const docsFrom = option('--docs-from') ? git(root, 'rev-parse', '--verify', `${option('--docs-from')}^{commit}`) : null;
const conf = JSON.parse(git(root, 'show', `${commit}:apps/desktop/src-tauri/tauri.conf.json`));
const version = conf.version;
const cargoVersion = git(root, 'show', `${commit}:Cargo.toml`).match(/^version\s*=\s*"([^"]+)"/m)?.[1];
if (cargoVersion !== version) fail(`tauri.conf.json says ${version}, Cargo.toml says ${cargoVersion}`);

// Only a version that is out: the update server must offer this one.
const latest = await (await fetch('https://ylide.app/updates/latest.json', { headers: { 'User-Agent': 'ylide-publish-source' } })).json();
if (latest.version !== version) fail(`ylide.app offers ${latest.version}, the commit is ${version}: publish the release first (release.mjs --publish)`);
const tag = `v${version}`;

// ------------------------------------------------------------------ the public clone
if (!existsSync(join(clone, '.git'))) {
  mkdirSync(dirname(clone), { recursive: true });
  if (flag('--init')) {
    mkdirSync(clone, { recursive: true });
    git(clone, 'init', '--initial-branch=main');
    git(clone, 'remote', 'add', 'origin', REMOTE);
  } else {
    run('git', ['clone', '--quiet', REMOTE, clone]);
  }
}
for (const key of ['user.name', 'user.email']) git(clone, 'config', key, git(root, 'config', '--get', key));
// Start from what GitHub has (the clone is this script's own workspace).
if (!flag('--init')) {
  git(clone, 'fetch', '--quiet', '--tags', 'origin');
  if (git(clone, 'branch', '--remotes', '--list', 'origin/main')) git(clone, 'checkout', '--quiet', '--force', '-B', 'main', 'origin/main');
}
const hasHistory = (() => {
  try {
    git(clone, 'rev-parse', '--verify', 'HEAD');
    return true;
  } catch {
    return false;
  }
})();
if (git(clone, 'tag', '--list', tag)) fail(`${tag} is already in the public repository; a published version never changes`);

// Empty the working tree (but not .git), then unpack the release commit.
for (const entry of readdirSync(clone)) if (entry !== '.git') rmSync(join(clone, entry), { recursive: true, force: true });
const unpack = (rev, paths = []) => {
  const tar = execFileSync('git', ['archive', '--format=tar', rev, ...paths], { cwd: root, maxBuffer: 1 << 30 });
  // Unpack in place: GNU tar would read "D:\..." as a remote host.
  execFileSync('tar', ['-x'], { cwd: clone, input: tar });
};
unpack(commit);
if (docsFrom) {
  const present = DOCS.filter((p) => git(root, 'ls-tree', '--name-only', docsFrom, p));
  for (const p of present) rmSync(join(clone, p), { recursive: true, force: true });
  unpack(docsFrom, present);
}
git(clone, 'add', '--all');

// ------------------------------------------------------------------ checks
const files = git(clone, 'ls-files').split('\n').filter(Boolean);
const problems = [];
const denyFile = join(homedir(), '.ylide-publish-deny');
const deny = existsSync(denyFile) ? readFileSync(denyFile, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#')) : [];
const user = userInfo().username;
function literal(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
const patterns = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
  // Written so that this file does not match itself.
  [/rsign encrypted secret[ ]key|cnNpZ24gZW5jcnlwdGVkIHNlY3JldCBrZX[k]/, 'a minisign secret key'],
  [/\b(ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|hf_[A-Za-z0-9]{30,}|sk-[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16})\b/, 'an access token'],
  [/\b[MNO][A-Za-z0-9_-]{23,27}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,40}\b/, 'a Discord bot token'],
  [new RegExp(`[A-Za-z]:[\\\\/]+Users[\\\\/]+${user}\\b`, 'i'), 'this machine\'s home folder'],
  [new RegExp(dirname(root).split(/[\\/]+/).filter(Boolean).map(literal).join('[\\\\/]+'), 'i'), 'the path of this checkout'],
  [new RegExp(`[\\\\/]${literal(basename(dirname(root)))}([\\\\/]|$)`, 'im'), 'the path of this checkout'],
  ...deny.map((term) => [new RegExp(literal(term), 'i'), `a term from ${denyFile}`]),
];
const BAD_NAMES = /(^|\/)(\.env(\..*)?|imprint\.json|operator\.json|[^/]*\.(key|pem|p12|pfx|gguf))$/i;
let bytes = 0;
for (const f of files) {
  const full = join(clone, f);
  const size = statSync(full).size;
  bytes += size;
  if (BAD_NAMES.test(f) && !f.endsWith('.example')) problems.push(`${f}: file that must stay private`);
  if (size > 5e6) problems.push(`${f}: ${(size / 1e6).toFixed(1)} MB, too large for the repository`);
  const text = readFileSync(full).toString('latin1');
  for (const [re, what] of patterns) if (re.test(text)) problems.push(`${f}: contains ${what}`);
}

const top = [...new Set(files.map((f) => (f.includes('/') ? `${f.split('/')[0]}/` : f)))];
console.log(`Ylide ${version} from ${commit.slice(0, 12)}${docsFrom ? `, documents from ${docsFrom.slice(0, 12)}` : ''}`);
console.log(`${files.length} files, ${(bytes / 1e6).toFixed(1)} MB: ${top.join(' ')}`);
console.log(hasHistory ? git(clone, 'diff', '--cached', '--stat', 'HEAD').split('\n').slice(-1)[0] : 'first commit of the public repository');
console.log(`checked against ${patterns.length} patterns${deny.length ? ` (${deny.length} from ${denyFile})` : `; ${denyFile} does not exist`}`);
if (problems.length) {
  console.error(problems.map((p) => `  ${p}`).join('\n'));
  fail(`${problems.length} problem(s): nothing was committed`);
}
console.log('no private data found');

if (!publish) {
  console.log(`dry run: the snapshot is in ${relative(root, clone)}; run with --publish to commit "Ylide ${version}", tag ${tag} and push`);
  process.exit(0);
}

// ------------------------------------------------------------------ commit, tag, push, release
const notes = latest.notes ?? '';
const date = (latest.pub_date ?? new Date().toISOString()).slice(0, 10);
const message = [
  `Ylide ${version}`,
  '',
  `Source code of Ylide ${version}, released on ${date}.`,
  ...(docsFrom ? ['The documents (README, .github and docs/images among them) were written after the release.'] : []),
  'Download: https://ylide.app',
  ...(notes ? ['', notes] : []),
  ...(options('--trailer').length ? ['', ...options('--trailer')] : []),
].join('\n');
run('git', ['commit', '--quiet', '--file', '-'], { cwd: clone, input: message, stdio: ['pipe', 'pipe', 'pipe'] });
git(clone, 'tag', '--annotate', tag, '--message', `Ylide ${version}`);
run('git', ['push', '--quiet', 'origin', 'main', tag], { cwd: clone, stdio: 'inherit' });
console.log(`pushed "Ylide ${version}" and ${tag} to https://github.com/${REPO}`);

// The GitHub release links to the download on ylide.app. The installer and its
// signature are attached as well when the local build is the published one.
const installerName = `${conf.productName}_${version}_x64-setup.exe`;
const local = join(root, 'target', 'release', 'bundle', 'updates', installerName);
const sha256 = async (stream) => {
  const { createHash } = await import('node:crypto');
  const h = createHash('sha256');
  for await (const chunk of stream) h.update(chunk);
  return h.digest('hex');
};
let assets = [];
let checksum = null;
if (existsSync(local) && existsSync(`${local}.sig`)) {
  const { createReadStream } = await import('node:fs');
  const { Readable } = await import('node:stream');
  const mine = await sha256(createReadStream(local));
  const res = await fetch(`https://ylide.app/updates/${installerName}`, { headers: { 'User-Agent': 'ylide-publish-source' } });
  const theirs = res.ok ? await sha256(Readable.fromWeb(res.body)) : null;
  if (mine === theirs) {
    assets = [local, `${local}.sig`];
    checksum = mine;
  } else console.log(`not attaching ${installerName}: the local build differs from the one on ylide.app`);
}
const shot = files.includes('docs/images/screenshot-chat.png') ? `![Ylide ${version}](https://raw.githubusercontent.com/${REPO}/${tag}/docs/images/screenshot-chat.png)\n\n` : '';
const body = [
  `${shot}**[Download Ylide ${version} for Windows](https://ylide.app/updates/${installerName})** from ylide.app. Installed copies update themselves.`,
  '',
  ...(notes ? [notes, ''] : []),
  ...(checksum ? [`SHA-256 of \`${installerName}\`: \`${checksum}\``, ''] : []),
  `The installer is signed with Ylide's release key; [docs/trust.md](https://github.com/${REPO}/blob/${tag}/docs/trust.md) shows how to verify it.`,
].join('\n');
run('gh', ['release', 'create', tag, '--repo', REPO, '--title', `Ylide ${version}`, '--notes', body, '--verify-tag', ...assets], { stdio: 'inherit' });
console.log(`release https://github.com/${REPO}/releases/tag/${tag}`);
