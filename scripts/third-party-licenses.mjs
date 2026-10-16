#!/usr/bin/env node
// Writes THIRD_PARTY_LICENSES.txt: the full license texts of the Rust crates compiled into
// ylide.exe and of the npm packages bundled into its user interface. The installer ships the
// file next to THIRD_PARTY_NOTICES.md (bundle.resources in tauri.conf.json).
//
//   node scripts/third-party-licenses.mjs           regenerate the file after dependency changes
//   node scripts/third-party-licenses.mjs --check   fail if it is out of date (release.mjs runs this)
//
// The texts are the license files each package ships. Packages that ship none, or that contain
// code under further licenses, get theirs from scripts/license-supplements/<package>/.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const desktop = join(root, 'apps', 'desktop');
const output = join(root, 'THIRD_PARTY_LICENSES.txt');
const supplements = join(root, 'scripts', 'license-supplements');
const check = process.argv.includes('--check');

/** The installer is only built for this target, so its crate graph is what ylide.exe contains. */
const TARGET = 'x86_64-pc-windows-msvc';
const APP_CRATE = 'ylide-desktop';
const LICENSE_FILE = /^(licen[cs]e|copying|copyright|notice|unlicense|third[-_ ]?party[-_ ]?notices)/i;
const LICENSE_DIR = /^licen[cs]es?$/i;
const NOT_A_LICENSE = /\.(rs|js|cjs|mjs|ts|json|toml|ya?ml|py|sh|html?)$/i;
const RULE = '='.repeat(80);

/** License files in a package folder (and in a LICENSES/ subfolder), sorted by name. */
function licenseFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (LICENSE_DIR.test(entry)) {
        for (const f of readdirSync(path).sort()) if (statSync(join(path, f)).isFile()) found.push({ name: `${entry}/${f}`, path: join(path, f) });
      }
    } else if (LICENSE_FILE.test(entry) && !NOT_A_LICENSE.test(entry)) {
      found.push({ name: entry, path });
    }
  }
  return found;
}

/** Same text on every machine: no BOM, LF line endings, no trailing spaces or blank lines. */
const normalize = (text) =>
  text
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();

function rustCrates() {
  const meta = JSON.parse(
    execFileSync('cargo', ['metadata', '--format-version', '1', '--locked', '--filter-platform', TARGET], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 256 << 20,
    }),
  );
  const packages = new Map(meta.packages.map((p) => [p.id, p]));
  const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
  const app = meta.packages.find((p) => p.name === APP_CRATE && p.source === null);
  // Normal dependencies only: build and dev dependencies never end up in the executable.
  const seen = new Set();
  const stack = [app.id];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const dep of nodes.get(id).deps) if (dep.dep_kinds.some((k) => k.kind === null)) stack.push(dep.pkg);
  }
  return [...seen]
    .map((id) => packages.get(id))
    .filter((p) => p.source !== null) // the workspace's own crates
    .map((p) => ({
      name: p.name,
      version: p.version,
      license: p.license ?? 'see license file',
      url: p.source.startsWith('registry+') ? `https://crates.io/crates/${p.name}/${p.version}` : (p.repository ?? p.source),
      dir: dirname(p.manifest_path),
    }));
}

function resolvePackage(name, from) {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    if (dir === root || dirname(dir) === dir) return null;
  }
}

const npmLicense = (pkg) =>
  typeof pkg.license === 'string'
    ? pkg.license
    : Array.isArray(pkg.licenses)
      ? pkg.licenses.map((l) => l.type ?? l).join(' OR ')
      : (pkg.license?.type ?? 'see license file');

/** The runtime dependencies of the UI and theirs: what Vite can bundle. */
function npmPackages() {
  const found = new Map();
  const visited = new Set();
  const visit = (name, from, optional) => {
    if (name.startsWith('@types/')) return; // type declarations, never part of the bundle
    const dir = resolvePackage(name, from);
    if (!dir) {
      if (optional) return;
      throw new Error(`${name} (needed by ${from}) is not installed; run npm install first`);
    }
    if (visited.has(dir)) return;
    visited.add(dir);
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    const key = `${pkg.name}@${pkg.version}`;
    if (!found.has(key)) {
      found.set(key, {
        name: pkg.name,
        version: pkg.version,
        license: npmLicense(pkg),
        url: `https://www.npmjs.com/package/${pkg.name}/v/${pkg.version}`,
        dir,
      });
    }
    for (const dep of Object.keys(pkg.dependencies ?? {})) visit(dep, dir, false);
    for (const dep of Object.keys(pkg.optionalDependencies ?? {})) visit(dep, dir, true);
  };
  const app = JSON.parse(readFileSync(join(desktop, 'package.json'), 'utf8'));
  for (const dep of Object.keys(app.dependencies)) visit(dep, desktop, false);
  return [...found.values()];
}

const byName = (a, b) => a.name.localeCompare(b.name, 'en') || a.version.localeCompare(b.version, 'en', { numeric: true });

function render() {
  const groups = [
    { title: 'Rust crates compiled into ylide.exe', components: rustCrates().sort(byName) },
    { title: 'npm packages bundled into the user interface', components: npmPackages().sort(byName) },
  ];
  const texts = new Map(); // normalized text with collapsed whitespace -> { id, text, first, users }
  const missing = [];
  for (const { components } of groups) {
    for (const c of components) {
      const files = [...licenseFiles(c.dir), ...(existsSync(join(supplements, c.name)) ? licenseFiles(join(supplements, c.name)) : [])];
      if (!files.length) missing.push(`${c.name} ${c.version}`);
      c.texts = [];
      for (const file of files) {
        const text = normalize(readFileSync(file.path, 'utf8'));
        if (!text) continue;
        const key = text.replace(/\s+/g, ' ');
        let entry = texts.get(key);
        if (!entry) {
          entry = { id: texts.size + 1, text, first: `${file.name} of ${c.name} ${c.version}`, users: 0 };
          texts.set(key, entry);
        }
        entry.users++;
        if (!c.texts.includes(entry.id)) c.texts.push(entry.id);
      }
    }
  }
  if (missing.length) {
    throw new Error(`no license file in ${missing.join(', ')}; add the texts from their repositories to scripts/license-supplements/<package>/`);
  }

  const out = [
    'Third-party licenses',
    '====================',
    '',
    'Ylide is licensed under the Apache License 2.0 (see LICENSE). This file holds the',
    'license texts of the third-party code compiled into it:',
    '',
    ...groups.map((g) => `  * ${g.components.length} ${g.title}`),
    '',
    'llama.cpp and the libraries linked into it carry their license texts next to the',
    'binaries in runtime/<variant>/ (see THIRD_PARTY_NOTICES.md). The source code of every',
    'component is available at the address listed with it.',
    '',
    'Generated by scripts/third-party-licenses.mjs from Cargo.lock and package-lock.json.',
    '',
  ];
  for (const g of groups) {
    out.push('', g.title, '-'.repeat(g.title.length), '');
    for (const c of g.components) {
      out.push(`${c.name} ${c.version}`, `    License: ${c.license} (texts ${c.texts.map((id) => `#${id}`).join(', ')})`, `    Source:  ${c.url}`);
    }
  }
  out.push('', '', 'License texts', '-------------');
  for (const entry of texts.values()) {
    const more = entry.users > 1 ? ` and ${entry.users - 1} more` : '';
    out.push('', RULE, `#${entry.id} - ${entry.first}${more}`, RULE, '', entry.text);
  }
  return `${out.join('\n')}\n`;
}

const text = render();
if (check) {
  const current = existsSync(output) ? readFileSync(output, 'utf8').replace(/\r\n/g, '\n') : '';
  if (current !== text) {
    console.error('THIRD_PARTY_LICENSES.txt is out of date; run `node scripts/third-party-licenses.mjs` and commit it');
    process.exit(1);
  }
  console.log('THIRD_PARTY_LICENSES.txt is up to date');
} else {
  writeFileSync(output, text);
  console.log(`wrote THIRD_PARTY_LICENSES.txt (${(text.length / 1024).toFixed(0)} KB)`);
}
