#!/usr/bin/env node
// Downloads the llama.cpp runtimes that ship inside the installer (the
// "bundled" assets of registry/models.json for this OS), verifies their
// SHA-256 and unpacks them to apps/desktop/src-tauri/resources/runtime/<variant>/,
// together with the license texts the release archives leave out.
//
//   node scripts/fetch-runtime.mjs              bundled runtimes for this machine
//   node scripts/fetch-runtime.mjs --if-missing only when not present yet
//   node scripts/fetch-runtime.mjs cuda-13.4    a specific variant (e.g. for local testing)

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
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
const cliBinary = process.platform === 'win32' ? 'llama.exe' : 'llama';

/**
 * License texts of llama.cpp and of the libraries its release builds link in. The archives
 * carry none of them (only LICENSE-LLVM-OpenMP), so they are kept in licensesDir, checked
 * against the files of the pinned release here and written next to the binaries. The app
 * does the same for the CUDA and ROCm builds it downloads itself (src-tauri/src/runtime.rs).
 * `title` is the name under which llama.cpp embeds the text in llama.exe.
 */
const licensesDir = join(root, 'apps', 'desktop', 'src-tauri', 'licenses');
const LICENSES = [
  { file: 'LICENSE-llama.cpp', title: 'llama.cpp', source: (v) => `ggml-org/llama.cpp/${v.tag}/LICENSE` },
  { file: 'LICENSE-httplib', title: 'cpp-httplib', source: (v) => `ggml-org/llama.cpp/${v.tag}/vendor/cpp-httplib/LICENSE` },
  { file: 'LICENSE-jsonhpp', title: 'jsonhpp', source: (v) => `ggml-org/llama.cpp/${v.tag}/licenses/LICENSE-jsonhpp` },
  { file: 'LICENSE-BoringSSL', title: 'BoringSSL', source: (v) => `google/boringssl/${v.boringssl}/LICENSE` },
];
/** Licenses llama.exe embeds whose text the archives already contain. */
const ARCHIVE_LICENSES = { 'LLVM OpenMP': 'LICENSE-LLVM-OpenMP' };

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

async function fetchText(path) {
  const url = `https://raw.githubusercontent.com/${path}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'ylide-build' } });
  if (!res.ok) throw new Error(`${res.status} for ${url}`);
  return (await res.text()).replace(/\r\n/g, '\n');
}

const storedLicense = (file) => readFileSync(join(licensesDir, file), 'utf8').replace(/\r\n/g, '\n');

let licensesChecked = false;
/** Compares the stored license texts with the files of the pinned llama.cpp release (once per run). */
async function checkLicenses() {
  if (licensesChecked) return;
  const cmake = await fetchText(`ggml-org/llama.cpp/${runtime.version}/vendor/cpp-httplib/CMakeLists.txt`);
  const boringssl = /BORINGSSL_VERSION "([^"]+)"/.exec(cmake)?.[1];
  if (!boringssl) throw new Error(`no BoringSSL version in vendor/cpp-httplib/CMakeLists.txt of llama.cpp ${runtime.version}`);
  for (const license of LICENSES) {
    const source = license.source({ tag: runtime.version, boringssl });
    if (storedLicense(license.file) !== (await fetchText(source))) {
      throw new Error(`${license.file} differs from https://raw.githubusercontent.com/${source}; review the new text and update ${relative(root, join(licensesDir, license.file))}`);
    }
  }
  licensesChecked = true;
}

const licensesPresent = (dir) =>
  LICENSES.every(({ file }) => existsSync(join(dir, file)) && readFileSync(join(dir, file), 'utf8') === storedLicense(file));

/** Writes the license texts next to the binaries and makes sure llama.exe embeds no others. */
async function addLicenses(dir) {
  await checkLicenses();
  for (const { file } of LICENSES) writeFileSync(join(dir, file), storedLicense(file));
  if (!existsSync(join(dir, cliBinary))) return;
  const embedded = readFileSync(join(dir, cliBinary)).toString('latin1');
  for (const [, title] of embedded.matchAll(/License for ([^\n]+)\n=+\n/g)) {
    if (LICENSES.some((l) => l.title === title)) continue;
    const file = ARCHIVE_LICENSES[title];
    if (!file) throw new Error(`llama.cpp ${runtime.version} also embeds the license of ${title}; add its text to LICENSES in scripts/fetch-runtime.mjs`);
    if (!existsSync(join(dir, file))) throw new Error(`${file} (license of ${title}) is missing from the ${runtime.version} archive`);
  }
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
    if (licensesPresent(dir)) {
      console.log(`${asset.variant}: present`);
    } else {
      await addLicenses(dir);
      console.log(`${asset.variant}: present, license texts added`);
    }
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
    await addLicenses(dir);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
writeFileSync(join(target, 'version.txt'), `${runtime.version}\n`);
console.log(`runtimes ready in ${target}`);
