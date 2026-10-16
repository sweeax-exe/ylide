#!/usr/bin/env node
// Fills in file sizes and SHA-256 hashes in registry/models.json from the
// upstream sources, so maintainers never type a hash by hand.
//
//   node tools/registry/fill.mjs            fill missing sizes/hashes in place
//   node tools/registry/fill.mjs --pin      also pin model revisions to commit hashes
//   node tools/registry/fill.mjs --check    verify everything, write nothing (CI)
//
// Model files: Hugging Face tree API (LFS oid = SHA-256 of the file).
// Runtime assets: GitHub release API (asset "digest" field).

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const check = args.includes('--check');
const pin = args.includes('--pin');
const registryPath = args.find((a) => !a.startsWith('--')) ??
  fileURLToPath(new URL('../../registry/models.json', import.meta.url));

const headers = { 'User-Agent': 'local-ide-registry-tool' };
if (process.env.HF_TOKEN) headers.Authorization = `Bearer ${process.env.HF_TOKEN}`;

async function getJson(url, extraHeaders = {}) {
  const res = await fetch(url, { headers: { ...headers, ...extraHeaders } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return { json: await res.json(), link: res.headers.get('link') };
}

const treeCache = new Map();
/** Map of path -> { size, sha256 } for every file in a repo revision. */
async function hfTree(repo, revision) {
  const key = `${repo}@${revision}`;
  if (treeCache.has(key)) return treeCache.get(key);
  const files = new Map();
  let url = `https://huggingface.co/api/models/${repo}/tree/${encodeURIComponent(revision)}?recursive=true`;
  while (url) {
    const { json, link } = await getJson(url);
    for (const entry of json) {
      if (entry.type !== 'file') continue;
      files.set(entry.path, {
        size: entry.lfs?.size ?? entry.size,
        sha256: entry.lfs?.oid ?? null,
      });
    }
    const next = link?.match(/<([^>]+)>;\s*rel="next"/);
    url = next ? next[1] : null;
  }
  treeCache.set(key, files);
  return files;
}

async function hfCommit(repo, revision) {
  const { json } = await getJson(`https://huggingface.co/api/models/${repo}/revision/${encodeURIComponent(revision)}`);
  return json.sha;
}

const releaseCache = new Map();
async function githubAsset(url) {
  const m = url.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/releases\/download\/([^/]+)\/(.+)$/);
  if (!m) return null;
  const [, repo, tag, name] = m;
  const key = `${repo}@${tag}`;
  if (!releaseCache.has(key)) {
    const gh = process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {};
    const { json } = await getJson(`https://api.github.com/repos/${repo}/releases/tags/${tag}`, gh);
    releaseCache.set(key, json.assets);
  }
  const asset = releaseCache.get(key).find((a) => a.name === decodeURIComponent(name));
  if (!asset) return null;
  return { size: asset.size, sha256: asset.digest?.replace(/^sha256:/, '') ?? null };
}

const registry = JSON.parse(await readFile(registryPath, 'utf8'));
const problems = [];
let changed = 0;

function apply(target, found, label) {
  if (!found) {
    problems.push(`missing upstream: ${label}`);
    return;
  }
  if (!found.sha256) {
    problems.push(`no sha256 upstream: ${label}`);
    return;
  }
  if (target.sizeBytes !== found.size || target.sha256 !== found.sha256) {
    if (check) problems.push(`out of date: ${label}`);
    target.sizeBytes = found.size;
    target.sha256 = found.sha256;
    changed++;
  }
}

for (const model of registry.models) {
  const { hfRepo } = model.source;
  if (pin && !/^[0-9a-f]{40}$/.test(model.source.revision)) {
    const sha = await hfCommit(hfRepo, model.source.revision);
    if (check) problems.push(`unpinned revision: ${model.id}`);
    model.source.revision = sha;
    changed++;
  }
  const tree = await hfTree(hfRepo, model.source.revision);
  for (const variant of model.variants) {
    for (const file of variant.files) {
      apply(file, tree.get(file.path), `${model.id}/${variant.quant}/${file.path}`);
    }
  }
}

for (const runtime of registry.runtimes ?? []) {
  for (const asset of runtime.assets) {
    for (const file of asset.files) {
      apply(file, await githubAsset(file.url), `${runtime.id}/${asset.variant}/${file.url}`);
    }
  }
}

if (problems.length) {
  console.error(problems.map((p) => `  - ${p}`).join('\n'));
}
if (!check && changed) {
  await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
  console.log(`updated ${changed} entr${changed === 1 ? 'y' : 'ies'} in ${registryPath}`);
} else if (!problems.length) {
  console.log('registry is up to date');
}
process.exit(problems.length ? 1 : 0);
