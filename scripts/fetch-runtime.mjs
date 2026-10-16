#!/usr/bin/env node
// Downloads the llama.cpp runtimes that ship inside the installer (the
// "bundled" assets of registry/models.json for this OS), verifies their
// SHA-256 and unpacks them to apps/desktop/src-tauri/resources/runtime/<variant>/.
//
//   node scripts/fetch-runtime.mjs              bundled runtimes for this machine
//   node scripts/fetch-runtime.mjs --if-missing only when not present yet
//   node scripts/fetch-runtime.mjs cuda-13.4    a specific variant (e.g. for local testing)

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(root, 'apps', 'desktop', 'src-tauri', 'resources', 'runtime');
const args = process.argv.slice(2);
const ifMissing = args.includes('--if-missing');
const wanted = args.filter((a) => !a.startsWith('--'));

const os = { win32: 'windows', darwin: 'macos', linux: 'linux' }[process.platform];
const arch = { x64: 'x86_64', arm64: 'aarch64' }[process.arch];
const binary = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';

const registry = JSON.parse(readFileSync(join(root, 'registry', 'models.json'), 'utf8'));
const runtime = registry.runtimes.find((r) => r.id === 'llama.cpp');
const assets = runtime.assets.filter((a) => a.os === os && a.arch === arch && (wanted.length ? wanted.includes(a.variant) : a.bundled));
if (!assets.length) {
  console.error(`no runtime assets for ${os}/${arch}${wanted.length ? ` (${wanted.join(', ')})` : ''}`);
  process.exit(1);
}

async function download(url, dest, expectedSha, expectedSize) {
  const res = await fetch(url, { headers: { 'User-Agent': 'ylide-build' } });
  if (!res.ok) throw new Error(`${res.status} for ${url}`);
  const hash = createHash('sha256');
  let bytes = 0;
  const counting = new TransformStream({
    transform(chunk, controller) {
      hash.update(chunk);
      bytes += chunk.length;
      if (bytes % (8 << 20) < chunk.length) process.stdout.write(`\r  ${(bytes / 1e6).toFixed(0)} / ${(expectedSize / 1e6).toFixed(0)} MB`);
      controller.enqueue(chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body.pipeThrough(counting)), createWriteStream(dest));
  process.stdout.write('\n');
  const sha = hash.digest('hex');
  if (sha !== expectedSha) throw new Error(`checksum mismatch for ${url}: ${sha}`);
  if (bytes !== expectedSize) throw new Error(`size mismatch for ${url}: ${bytes}`);
}

/** Moves the folder that contains the server binary up to `dir` if it ended up nested. */
function flatten(dir) {
  if (existsSync(join(dir, binary))) return;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) stack.push(p);
      else if (e === binary) {
        for (const f of readdirSync(d)) renameSync(join(d, f), join(dir, f));
        return;
      }
    }
  }
}

mkdirSync(target, { recursive: true });
for (const asset of assets) {
  const dir = join(target, asset.variant);
  if (ifMissing && existsSync(join(dir, binary))) {
    console.log(`${asset.variant}: present`);
    continue;
  }
  console.log(`${asset.variant}: ${runtime.version}`);
  // Downloads go to a fresh, empty temporary folder first.
  const work = mkdtempSync(join(tmpdir(), 'ylide-runtime-'));
  try {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    for (const file of asset.files) {
      const name = file.url.split('/').pop();
      const archive = join(work, name);
      await download(file.url, archive, file.sha256, file.sizeBytes);
      // bsdtar (bundled with Windows 10+, macOS and most Linux distributions) unpacks .zip and .tar.gz.
      execFileSync('tar', ['-xf', archive, '-C', dir], { stdio: 'inherit' });
    }
    flatten(dir);
    if (!existsSync(join(dir, binary))) throw new Error(`${binary} not found after unpacking ${asset.variant}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
writeFileSync(join(target, 'version.txt'), `${runtime.version}\n`);
console.log(`runtimes ready in ${target}`);
