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

// The public repository: one commit per release (scripts/publish-source.mjs).
const githubRepo = 'https://github.com/sweeax-exe/ylide';
// GitHub's mark in one colour (path from Simple Icons, CC0), as GitHub's logo
// guidelines allow for linking to a repository.
const githubLogo = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false"><path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/></svg>';

// The Ylide Discord server: the permanent invite kept by tools/discord's setup.
const discordInvite = 'https://discord.gg/GRzTvRGHpr';
// Discord's logo in one colour (path from Simple Icons, CC0). Discord's brand
// guidelines allow the logo in white or black when linking to a server.
const discordLogo = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false"><path d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z"/></svg>';

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
      discord: discordInvite,
      discordLogo,
      github: githubRepo,
      githubLogo,
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
