#!/usr/bin/env node
// Signs registry/models.json and puts it on the server as the official model
// list. Ylide accepts that list only with a valid release signature. See
// docs/releasing.md.
//
//   node scripts/publish-registry.mjs            check, sign and verify (target/registry)
//   node scripts/publish-registry.mjs --publish  the same, then upload
//
// Two lists come out of the one file:
//   https://ylide.app/registry/v2/models.json  the list as it is (schema 2), read by Ylide 0.1.4 and newer
//   https://ylide.app/registry/models.json     schema 1 without the uncensored models, for Ylide 0.1.3
//                                              and older, which do not know the flag and could recommend them
//
// The signing key is read like in release.mjs (TAURI_SIGNING_PRIVATE_KEY_PATH
// or ~/.tauri/ylide-updater.key).

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(root, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
const outDir = join(root, 'target', 'registry');
const SERVER = 'deploy@ylide';
const SERVER_DIR = '/var/www/ylide/registry';
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });

const keyPath = process.env.TAURI_SIGNING_PRIVATE_KEY_PATH ?? join(homedir(), '.tauri', 'ylide-updater.key');
if (!existsSync(keyPath)) {
  console.error(`signing key not found at ${keyPath} (see docs/releasing.md)`);
  process.exit(1);
}

// The registry crate's tests parse the list and check it against its schema.
console.log('checking registry/models.json');
run('cargo', ['test', '-q', '-p', 'registry'], { cwd: root });

const source = readFileSync(join(root, 'registry', 'models.json'), 'utf8');
const registry = JSON.parse(source);
if (registry.schemaVersion !== 2) {
  console.error(`registry/models.json has schema ${registry.schemaVersion}; this script publishes schema 2 and the schema 1 list derived from it`);
  process.exit(1);
}
const legacy = {
  ...registry,
  schemaVersion: 1,
  models: registry.models.filter((m) => !m.uncensored).map(({ uncensored, ...m }) => m),
};
const dropped = registry.models.length - legacy.models.length;
// Ylide 0.1.3 and older must get exactly the models they understand.
if (legacy.models.some((m) => 'uncensored' in m) || legacy.models.length !== registry.models.filter((m) => m.uncensored !== true).length) {
  console.error('the schema 1 list still contains uncensored models');
  process.exit(1);
}

/** Published path under /registry/ -> file content. Both are named models.json: the signature names the file. */
const lists = [
  { path: 'v2/models.json', text: source, label: `schema 2, ${registry.models.length} models` },
  { path: 'models.json', text: `${JSON.stringify(legacy, null, 2)}\n`, label: `schema 1 for Ylide 0.1.3 and older, ${legacy.models.length} models (${dropped} uncensored left out)` },
];

rmSync(outDir, { recursive: true, force: true });
const env = { ...process.env, TAURI_SIGNING_PRIVATE_KEY_PATH: keyPath, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? '' };
delete env.TAURI_SIGNING_PRIVATE_KEY;
for (const list of lists) {
  const file = join(outDir, list.path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, list.text);
  console.log(`signing model list ${registry.registryVersion} (${list.label})`);
  run(process.execPath, [cli, 'signer', 'sign', file], { cwd: join(root, 'apps', 'desktop'), env, stdio: ['ignore', 'ignore', 'inherit'] });
  console.log('checking the signature against the key built into the app');
  run('cargo', ['test', '-q', '-p', 'ylide-desktop', '--lib', 'registry_service::tests::release_registry_is_signed_with_the_app_key', '--', '--ignored'], {
    cwd: root,
    env: { ...process.env, YLIDE_RELEASE_REGISTRY: file },
  });
}

if (process.argv.includes('--publish')) {
  run('ssh', [SERVER, `mkdir -p ${SERVER_DIR}/v2`]);
  for (const list of lists) {
    const file = join(outDir, list.path);
    const target = `${SERVER_DIR}/${list.path}`;
    console.log(`uploading to ${SERVER}:${target}`);
    run('scp', ['-q', file, `${SERVER}:${target}.new`]);
    run('scp', ['-q', `${file}.sig`, `${SERVER}:${target}.sig.new`]);
    // The signature first, then the list: an app that reads in between gets a
    // mismatch, keeps its current list and tries again at the next start.
    run('ssh', [SERVER, `mv ${target}.sig.new ${target}.sig && mv ${target}.new ${target}`]);
    console.log(`published https://ylide.app/registry/${list.path}`);
  }
  console.log(`published model list ${registry.registryVersion}`);
} else {
  console.log(`ready in ${outDir}; run with --publish to upload`);
}
