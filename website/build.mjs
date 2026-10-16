#!/usr/bin/env node
// Builds the website into website/dist and, with --publish, puts it on the
// server. No framework and no bundler: one template per page, the texts per
// language in src/i18n, everything served from ylide.app itself.
//
//   node website/build.mjs             build website/dist
//   node website/build.mjs --publish   build, then upload to the server
//
// website/operator.json names who runs the site (name and email, see
// operator.example.json); the privacy page needs it, so --publish refuses
// without it. An imprint page is built only when website/imprint.json exists
// (see imprint.example.json). Both files stay out of the repository.

import { execSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const src = join(here, 'src');
const dist = join(here, 'dist');
const publish = process.argv.includes('--publish');

const read = (p) => readFileSync(p, 'utf8');
const conf = JSON.parse(read(join(root, 'apps', 'desktop', 'src-tauri', 'tauri.conf.json')));
const version = conf.version;
const installerName = `${conf.productName}_${version}_x64-setup.exe`;
const installer = `/updates/${installerName}`;
const built = join(root, 'target', 'release', 'bundle', 'updates', installerName);
// Size shown next to the download button; taken from the built installer.
const sizeMb = existsSync(built) ? Math.round(statSync(built).size / 1e6) : 23;

const imprintFile = join(here, 'imprint.json');
const imprint = existsSync(imprintFile) ? JSON.parse(read(imprintFile)) : null;
const operatorFile = join(here, 'operator.json');
const operator = existsSync(operatorFile) ? JSON.parse(read(operatorFile)) : imprint && { name: imprint.name, email: imprint.email };
if (publish && !operator) {
  console.error('website/operator.json is missing; the privacy page must name who runs the site (see operator.example.json)');
  process.exit(1);
}

// Languages in menu order; a language joins once its texts exist in src/i18n.
const ORDER = ['en', 'de', 'es', 'fr', 'pt', 'ru', 'ar', 'hi', 'id', 'ja', 'ko', 'zh'];
const langs = Object.fromEntries(
  ORDER.filter((code) => existsSync(join(src, 'i18n', `${code}.json`))).map((code) => [code, JSON.parse(read(join(src, 'i18n', `${code}.json`)))]),
);
const homePath = (code) => (code === 'en' ? '/' : `/${code}/`);
// The legal pages exist in English and German; other languages link to English.
const legal = {
  privacy: { en: '/privacy/', de: '/de/datenschutz/' },
  imprint: { en: '/imprint/', de: '/de/impressum/' },
};
if (!imprint) delete legal.imprint;
const pages = {
  home: Object.fromEntries(Object.keys(langs).map((code) => [code, homePath(code)])),
  ...legal,
};
const legalHref = (page, code) => (legal[page] ? (legal[page][code] ?? legal[page].en) : null);

const globe = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z"/></svg>';

const escape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function lookup(ctx, key) {
  const value = key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), ctx);
  if (value === undefined) throw new Error(`missing text or value: ${key}`);
  return value;
}

/** Fills {{key}} placeholders; texts may contain placeholders themselves. */
function render(template, ctx) {
  let out = template;
  for (let pass = 0; pass < 4 && out.includes('{{'); pass++) {
    out = out.replace(/\{\{([\w.]+)\}\}/g, (_, key) => lookup(ctx, key));
  }
  if (out.includes('{{')) throw new Error(`unresolved placeholder near ${out.slice(out.indexOf('{{'), out.indexOf('{{') + 40)}`);
  return out;
}

/** The Ylide mark: two world lines braiding into a Y (docs/brand/ylide-mark.svg). */
function mark(id, cls, { draw = false } = {}) {
  const len = draw ? ' pathLength="1"' : '';
  return `<svg class="${cls}" viewBox="0 0 1024 1024" fill="none" aria-hidden="true" focusable="false"><defs><clipPath id="${id}-cut"><rect x="0" y="128" width="1024" height="768"/></clipPath><clipPath id="${id}-under"><path clip-rule="evenodd" d="M-64 -64 H1088 V1088 H-64 Z M430.04 83.53 L725.72 435.91 L593.96 546.47 L298.28 194.09 Z"/></clipPath></defs><g clip-path="url(#${id}-cut)" stroke="#E6ECF5" stroke-width="120" stroke-linecap="butt"><path${len} d="M736.04 48 L512 315 L436.05 405.51 A175 175 0 0 0 436.05 630.49 L474.57 676.39 A160 160 0 0 1 512 779.24 L512 976" clip-path="url(#${id}-under)"/><path${len} d="M287.96 48 L512 315 L587.95 405.51 A175 175 0 0 1 587.95 630.49 L549.43 676.39 A160 160 0 0 0 512 779.24 L512 976"/></g></svg>`;
}

function imprintBody(t) {
  if (!imprint) return `<p class="missing">${t.imprintPage.missing}</p>`;
  const lines = [imprint.name, imprint.street, imprint.city, imprint.country].filter(Boolean).map(escape).join('<br>');
  return [
    `<h2>${t.imprintPage.law}</h2>`,
    `<address>${lines}</address>`,
    `<h2>${t.imprintPage.contact}</h2>`,
    `<p>${t.imprintPage.email}: <a href="mailto:${escape(imprint.email)}">${escape(imprint.email)}</a></p>`,
    `<h2>${t.imprintPage.responsible}</h2>`,
    `<p>${escape(imprint.name)}, ${escape([imprint.street, imprint.city].filter(Boolean).join(', '))}</p>`,
  ].join('\n  ');
}

rmSync(dist, { recursive: true, force: true });
const build = Date.now().toString(36);
const layout = read(join(src, 'layout.html'));
for (const [page, paths] of Object.entries(pages)) {
  const body = read(join(src, `${page}.html`));
  for (const [lang, t] of Object.entries(langs)) {
    if (!paths[lang]) continue;
    // Each language links to this page in that language, or to its home page.
    const target = (code) => paths[code] ?? pages.home[code];
    const menu = Object.entries(langs)
      .map(([code, lt]) => `<li><a href="${target(code)}" hreflang="${lt.lang}" lang="${lt.lang}"${code === lang ? ' aria-current="page"' : ''}>${escape(lt.langName)}</a></li>`)
      .join('');
    const alternates = Object.entries(paths)
      .map(([code, p]) => `<link rel="alternate" hreflang="${langs[code].lang}" href="https://ylide.app${p}">`)
      .concat(`<link rel="alternate" hreflang="x-default" href="https://ylide.app${paths.en}">`)
      .join('\n');
    const offers = Object.fromEntries(Object.entries(langs).map(([code, lt]) => [code, { path: target(code), lang: lt.lang, dir: lt.dir ?? 'ltr', suggest: lt.suggest }]));
    const numberLocale = t.lang === 'ar' ? 'ar-u-nu-latn' : t.lang;
    const ctx = {
      t,
      version,
      size: sizeMb,
      installer,
      build,
      path: paths[lang],
      dir: t.dir ?? 'ltr',
      alternates,
      langMenu: `<details class="lang-menu"><summary aria-label="${escape(t.nav.language)}">${globe}<span>${escape(t.langName)}</span></summary><ul>${menu}</ul></details>`,
      langData: page === 'home' ? `<script type="application/json" id="langs" data-current="${lang}">${JSON.stringify(offers).replace(/</g, '\\u003c')}</script>` : '',
      contextTokens: new Intl.NumberFormat(numberLocale).format(131072),
      home: pages.home[lang],
      privacyHref: legalHref('privacy', lang),
      imprintLink: imprint ? `<a href="${legalHref('imprint', lang)}">${escape(t.footer.imprint)}</a>` : '',
      operatorContact: operator
        ? `${escape(operator.name)}, <a href="mailto:${escape(operator.email)}">${escape(operator.email)}</a>`
        : `<span class="missing">${escape(t.privacyPage.missingOperator ?? 'website/operator.json is missing')}</span>`,
      pageClass: page,
      title: page === 'home' ? 'Ylide: Your Local IDE' : page === 'privacy' ? t.meta.privacyTitle : t.meta.imprintTitle,
      brandMark: mark(`brand-${page}`, 'brand-mark'),
      heroMark: mark('hero', 'hero-mark', { draw: true }),
      imprintBody: page === 'imprint' ? imprintBody(t) : '',
    };
    const html = render(layout.replace('{{body}}', body), ctx);
    const out = join(dist, paths[lang], 'index.html');
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, html);
  }
}

// Assets: styles, script, fonts (OFL, from the app's own font packages), icons.
const assets = join(dist, 'assets');
mkdirSync(join(assets, 'fonts'), { recursive: true });
copyFileSync(join(src, 'site.css'), join(assets, 'site.css'));
copyFileSync(join(src, 'site.js'), join(assets, 'site.js'));
const fonts = join(root, 'node_modules', '@fontsource-variable');
const fontFiles = {
  'instrument-sans-latin.woff2': join(fonts, 'instrument-sans', 'files', 'instrument-sans-latin-standard-normal.woff2'),
  'instrument-sans-latin-ext.woff2': join(fonts, 'instrument-sans', 'files', 'instrument-sans-latin-ext-standard-normal.woff2'),
  'jetbrains-mono-latin.woff2': join(fonts, 'jetbrains-mono', 'files', 'jetbrains-mono-latin-wght-normal.woff2'),
};
for (const [name, from] of Object.entries(fontFiles)) copyFileSync(from, join(assets, 'fonts', name));
const icons = join(root, 'apps', 'desktop', 'src-tauri', 'icons');
copyFileSync(join(icons, 'ylide.svg'), join(assets, 'favicon.svg'));
copyFileSync(join(icons, '32x32.png'), join(assets, 'favicon-32.png'));
writeFileSync(join(dist, 'robots.txt'), 'User-agent: *\nAllow: /\n');
copyFileSync(join(src, '404.html'), join(dist, '404.html'));
mkdirSync(join(assets, 'shots'), { recursive: true });
for (const name of readdirSync(join(src, 'shots'))) copyFileSync(join(src, 'shots', name), join(assets, 'shots', name));
console.log(`built website/dist for Ylide ${version} in ${Object.keys(langs).length} languages (${Object.keys(langs).join(', ')}); installer ${installerName}, ${sizeMb} MB`);

if (publish) {
  // Upload into a fresh release folder, then switch the "site" link to it in
  // one rename, so visitors never see a half-copied site.
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
  const remote = `/var/www/ylide/releases/${stamp}`;
  const script = [
    'set -e',
    `mkdir -p ${remote}`,
    `tar -C ${remote} -xf -`,
    'cd /var/www/ylide',
    // The first deploy replaces the placeholder folder with a link.
    'if [ -d site ] && [ ! -L site ]; then mkdir -p releases && mv site releases/placeholder; fi',
    `ln -sfn releases/${stamp} site.next && mv -T site.next site`,
    // Keep the last five releases.
    'ls -1dt releases/*/ | tail -n +6 | xargs -r rm -rf',
  ].join(' && ');
  execSync(`tar -C "${dist}" -cf - . | ssh deploy@ylide "${script}"`, { stdio: 'inherit' });
  console.log('published https://ylide.app');
}
