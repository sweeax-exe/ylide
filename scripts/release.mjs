#!/usr/bin/env node
// Builds a release of Ylide and, with --publish, puts it on the update server.
// See docs/releasing.md.
//
//   node scripts/release.mjs                       build the installer, sign it, write latest.json
//   node scripts/release.mjs --notes "Fixes ..."   the same, with release notes for the update notice
//   node scripts/release.mjs --publish             build, then upload to ylide.app/updates
//   node scripts/release.mjs --publish-only        upload the files of the last build
//   ... --replace                                  allow replacing an already published installer
//                                                  of the same version (only if nobody can have it)
//
// The signing key is read from TAURI_SIGNING_PRIVATE_KEY_PATH, or from
// ~/.tauri/ylide-updater.key; its password (if any) from
// TAURI_SIGNING_PRIVATE_KEY_PASSWORD. The key never enters the repository.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const desktop = join(root, 'apps', 'desktop');
const cli = join(root, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

/** Where the app looks for updates (apps/desktop/src-tauri/src/updates.rs). */
const UPDATE_BASE = 'https://ylide.app/updates';
/** SSH target and folder of the update files on the server. */
const SERVER = 'deploy@ylide';
const SERVER_DIR = '/var/www/ylide/updates';

const conf = JSON.parse(readFileSync(join(desktop, 'src-tauri', 'tauri.conf.json'), 'utf8'));
const version = conf.version;
const cargoVersion = /\[workspace\.package\][^[]*?version\s*=\s*"([^"]+)"/s.exec(readFileSync(join(root, 'Cargo.toml'), 'utf8'))?.[1];
if (cargoVersion !== version) {
  console.error(`tauri.conf.json has version ${version}, Cargo.toml ${cargoVersion}; set both to the same version first`);
  process.exit(1);
}

const installerName = `${conf.productName}_${version}_x64-setup.exe`;
const nsisDir = join(root, 'target', 'release', 'bundle', 'nsis');
const outDir = join(root, 'target', 'release', 'bundle', 'updates');
const run = (cmd, cmdArgs, opts = {}) => execFileSync(cmd, cmdArgs, { stdio: 'inherit', ...opts });

function build() {
  const keyPath = process.env.TAURI_SIGNING_PRIVATE_KEY_PATH ?? join(homedir(), '.tauri', 'ylide-updater.key');
  if (!existsSync(keyPath)) {
    console.error(`signing key not found at ${keyPath} (see docs/releasing.md)`);
    process.exit(1);
  }
  // The installer carries the runtimes with their license texts and the license texts of
  // all dependencies; both must match what is being built.
  run(process.execPath, [join(root, 'scripts', 'fetch-runtime.mjs'), '--if-missing']);
  run(process.execPath, [join(root, 'scripts', 'third-party-licenses.mjs'), '--check']);
  console.log(`building Ylide ${version}`);
  run(process.execPath, [cli, 'build', '--bundles', 'nsis'], { cwd: desktop });
  const installer = join(nsisDir, installerName);
  if (!existsSync(installer)) {
    console.error(`the build did not produce ${installer}`);
    process.exit(1);
  }
  console.log('signing the installer');
  rmSync(`${installer}.sig`, { force: true });
  // The key path goes through the environment so it never shows up in a process list.
  const env = { ...process.env, TAURI_SIGNING_PRIVATE_KEY_PATH: keyPath, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? '' };
  delete env.TAURI_SIGNING_PRIVATE_KEY;
  run(process.execPath, [cli, 'signer', 'sign', installer], { cwd: desktop, env, stdio: ['ignore', 'ignore', 'inherit'] });
  const signature = readFileSync(`${installer}.sig`, 'utf8').trim();
  console.log('checking the signature against the key built into the app');
  run('cargo', ['test', '-q', '-p', 'ylide-desktop', '--lib', 'updates::tests::release_installer_is_signed_with_the_app_key', '--', '--ignored'], {
    cwd: root,
    env: { ...process.env, YLIDE_RELEASE_INSTALLER: installer },
  });

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  copyFileSync(installer, join(outDir, installerName));
  copyFileSync(`${installer}.sig`, join(outDir, `${installerName}.sig`));
  const entry = { signature, url: `${UPDATE_BASE}/${installerName}` };
  const manifest = {
    version,
    notes: option('--notes') ?? '',
    pub_date: new Date().toISOString(),
    // Both keys Tauri's tooling uses; the app prefers the "-nsis" one.
    platforms: { 'windows-x86_64-nsis': entry, 'windows-x86_64': entry },
  };
  writeFileSync(join(outDir, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const mb = (statSync(installer).size / 1e6).toFixed(1);
  console.log(`ready in ${outDir}: ${installerName} (${mb} MB), its signature and latest.json`);
}

/** The model list address this version reads (apps/desktop/src-tauri/src/settings.rs). */
const registryUrl = /pub const DEFAULT_REGISTRY_URL: &str = "([^"]+)";/.exec(readFileSync(join(desktop, 'src-tauri', 'src', 'settings.rs'), 'utf8'))?.[1];

/** A version must not go out before the model list it reads is on the server (scripts/publish-registry.mjs). */
async function checkRegistryIsLive() {
  if (!registryUrl) {
    console.error('DEFAULT_REGISTRY_URL not found in settings.rs');
    process.exit(1);
  }
  for (const url of [registryUrl, `${registryUrl}.sig`]) {
    const res = await fetch(url, { method: 'HEAD', headers: { 'User-Agent': 'ylide-release' } }).catch((e) => ({ ok: false, status: String(e) }));
    if (!res.ok) {
      console.error(`${url} answers ${res.status}. Publish the model list first: node scripts/publish-registry.mjs --publish`);
      process.exit(1);
    }
  }
}

async function publish() {
  for (const f of [installerName, `${installerName}.sig`, 'latest.json']) {
    if (!existsSync(join(outDir, f))) {
      console.error(`missing ${join(outDir, f)}; run the build first`);
      process.exit(1);
    }
  }
  await checkRegistryIsLive();
  // A published version never changes: an app may already be downloading it,
  // and its signature must keep matching the file behind the link.
  const local = createHash('sha256').update(readFileSync(join(outDir, installerName))).digest('hex');
  const remote = execFileSync('ssh', [SERVER, `sha256sum ${SERVER_DIR}/${installerName} 2>/dev/null || true`], { encoding: 'utf8' }).split(/\s+/)[0];
  if (remote && remote !== local && !flag('--replace')) {
    console.error(`Ylide ${version} is already published with a different installer. Bump the version (or pass --replace for a version nobody can have installed yet).`);
    process.exit(1);
  }
  console.log(`uploading to ${SERVER}:${SERVER_DIR}`);
  run('scp', ['-q', join(outDir, installerName), join(outDir, `${installerName}.sig`), `${SERVER}:${SERVER_DIR}/`]);
  // latest.json last and renamed into place, so no app ever sees it before
  // the installer it points to is complete.
  run('scp', ['-q', join(outDir, 'latest.json'), `${SERVER}:${SERVER_DIR}/latest.json.new`]);
  run('ssh', [SERVER, `mv ${SERVER_DIR}/latest.json.new ${SERVER_DIR}/latest.json`]);
  console.log(`published Ylide ${version}: ${UPDATE_BASE}/latest.json`);
}

// Checked before the build too, so a missing list does not cost a whole build.
if (flag('--publish') || flag('--publish-only')) await checkRegistryIsLive();
if (!flag('--publish-only')) build();
if (flag('--publish') || flag('--publish-only')) await publish();
