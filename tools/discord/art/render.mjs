// Renders the Discord artwork with headless Edge (like scripts/installer-art.ps1)
// into tools/discord/assets, where the setup picks it up:
//   banner.png         the image at the top of #welcome
//   server-icon.png    the server icon: the mark on a full-bleed tile (Discord crops it round)
//   emoji/<name>.png   the bot's emojis: Lucide icons (ISC) in qubit cyan on
//                      the flat app-icon tile, plus the Ylide mark
//
//   node art/render.mjs        (Windows, from tools/discord; needs the repo's node_modules)
//
// The PNGs are committed, so the server never needs to render anything.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const repo = join(here, '..', '..', '..');
const out = join(here, '..', 'assets');
const edge = [
  join(process.env['ProgramFiles(x86)'] ?? '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  join(process.env.ProgramFiles ?? '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
].find((p) => existsSync(p));
if (!edge) throw new Error('Microsoft Edge was not found');

const tmp = join(tmpdir(), `ylide-discord-art-${process.pid}`);
mkdirSync(join(out, 'emoji'), { recursive: true });
mkdirSync(tmp, { recursive: true });

const font = readFileSync(join(repo, 'node_modules', '@fontsource-variable', 'instrument-sans', 'files', 'instrument-sans-latin-standard-normal.woff2')).toString('base64');

// The Ylide mark (docs/brand/ylide-mark.svg), drawn in `color`.
const mark = (color) => `
  <defs>
    <clipPath id="cut"><rect x="0" y="128" width="1024" height="768"/></clipPath>
    <clipPath id="under"><path clip-rule="evenodd" d="M-64 -64 H1088 V1088 H-64 Z M430.04 83.53 L725.72 435.91 L593.96 546.47 L298.28 194.09 Z"/></clipPath>
  </defs>
  <g clip-path="url(#cut)" fill="none" stroke="${color}" stroke-width="120" stroke-linecap="butt">
    <path d="M736.04 48 L512 315 L436.05 405.51 A175 175 0 0 0 436.05 630.49 L474.57 676.39 A160 160 0 0 1 512 779.24 L512 976" clip-path="url(#under)"/>
    <path d="M287.96 48 L512 315 L587.95 405.51 A175 175 0 0 1 587.95 630.49 L549.43 676.39 A160 160 0 0 0 512 779.24 L512 976"/>
  </g>`;

const page = (width, height, body) => `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:"Instrument Sans";src:url(data:font/woff2;base64,${font}) format("woff2");font-weight:400 700;font-stretch:75% 100%}
html,body{margin:0;width:${width}px;height:${height}px;overflow:hidden;background:transparent}
</style></head><body>${body}</body></html>`;

function shoot(name, width, height, html, target) {
  const file = join(tmp, `${name}.html`);
  const png = join(tmp, `${name}.png`);
  writeFileSync(file, html);
  rmSync(png, { force: true });
  try {
    execFileSync(
      edge,
      [
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        '--no-first-run',
        '--force-device-scale-factor=1',
        '--default-background-color=00000000',
        `--user-data-dir=${join(tmp, 'profile')}`,
        `--window-size=${width},${height}`,
        '--virtual-time-budget=2000',
        `--screenshot=${png}`,
        pathToFileURL(file).href,
      ],
      { stdio: 'ignore' },
    );
  } catch {
    // Edge reports the written file on stderr and may exit non-zero; check the file instead.
  }
  if (!existsSync(png)) throw new Error(`Edge did not write ${name}.png`);
  writeFileSync(target, readFileSync(png));
  console.log(`wrote ${target}`);
}

// --- emojis -----------------------------------------------------------------

const icons = {
  ylide_bug: 'bug',
  ylide_help: 'life-buoy',
  ylide_idea: 'lightbulb',
  ylide_other: 'ellipsis',
  ylide_claim: 'user-round-check',
  ylide_close: 'lock',
  ylide_reopen: 'lock-open',
  ylide_delete: 'trash',
  ylide_transcript: 'file-text',
};

async function lucide(name) {
  const file = join(repo, 'node_modules', 'lucide-react', 'dist', 'esm', 'icons', `${name}.mjs`);
  const { __iconData } = await import(pathToFileURL(file).href);
  return __iconData.node
    .map(([tag, attrs]) => {
      const a = Object.entries(attrs)
        .filter(([k]) => k !== 'key')
        .map(([k, v]) => `${k}="${v}"`)
        .join(' ');
      return `<${tag} ${a}/>`;
    })
    .join('');
}

const tile = (inner) => `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
  <rect width="128" height="128" rx="29" fill="#111726"/>${inner}</svg>`;

for (const [emoji, icon] of Object.entries(icons)) {
  const glyph = `<g transform="translate(24 24) scale(3.333)" fill="none" stroke="#22D3EE" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round">${await lucide(icon)}</g>`;
  shoot(emoji, 128, 128, page(128, 128, tile(glyph)), join(out, 'emoji', `${emoji}.png`));
}
shoot(
  'ylide_mark',
  128,
  128,
  page(128, 128, tile(`<svg x="12.8" y="12.8" width="102.4" height="102.4" viewBox="0 0 1024 1024">${mark('#E6ECF5')}</svg>`)),
  join(out, 'emoji', 'ylide_mark.png'),
);

shoot(
  'server-icon',
  512,
  512,
  page(512, 512, `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><rect width="512" height="512" fill="#111726"/><svg x="66" y="66" width="380" height="380" viewBox="0 0 1024 1024">${mark('#E6ECF5')}</svg></svg>`),
  join(out, 'server-icon.png'),
);

// --- banner -----------------------------------------------------------------
// 2400 x 800, shown about 520 px wide in Discord. Flat cryostat blue, the mark,
// the name and the slogan, and two world lines that braid across the bottom.

function worldLines() {
  // Two waves in counter-phase; at each crossing the "under" line gets a gap,
  // like the logo and knot diagrams.
  const wave = (phase) => {
    const points = [];
    for (let x = -40; x <= 2440; x += 20) points.push([x, 620 + Math.sin((x / 2400) * Math.PI * 3 + phase) * 70]);
    return points.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  };
  const crossings = [0, 1, 2, 3].map((k) => (k * 2400) / 3);
  const gaps = crossings.map((x, k) => (k % 2 ? `<rect x="${x - 26}" y="560" width="52" height="120" fill="black"/>` : '')).join('');
  return `
    <defs><mask id="gap"><rect width="2400" height="800" fill="white"/>${gaps}</mask>
    <mask id="gap2"><rect width="2400" height="800" fill="white"/>${crossings.map((x, k) => (k % 2 ? '' : `<rect x="${x - 26}" y="560" width="52" height="120" fill="black"/>`)).join('')}</mask></defs>
    <path d="${wave(0)}" fill="none" stroke="#273246" stroke-width="6" mask="url(#gap)"/>
    <path d="${wave(Math.PI)}" fill="none" stroke="#0B4F5F" stroke-width="6" mask="url(#gap2)"/>`;
}

const banner = `
<div style="position:relative;width:2400px;height:800px;background:#111726;font-family:'Instrument Sans',sans-serif;overflow:hidden">
  <svg style="position:absolute;inset:0" width="2400" height="800" viewBox="0 0 2400 800">${worldLines()}</svg>
  <svg style="position:absolute;left:190px;top:150px" width="380" height="380" viewBox="0 0 1024 1024">${mark('#E6ECF5')}</svg>
  <div style="position:absolute;left:640px;top:150px">
    <div style="font-size:236px;line-height:1;font-weight:600;letter-spacing:-0.035em;color:#E7ECF4;font-stretch:100%">Ylide</div>
    <div style="font-size:76px;line-height:1.2;margin-top:28px;color:#9AA6BB;letter-spacing:-0.01em">Your Local IDE</div>
  </div>
  <div style="position:absolute;right:190px;top:178px;text-align:right;font-size:42px;line-height:1.75;color:#808CA6">
    <div>Open source</div><div>Runs on your computer</div><div>No cloud, no telemetry</div>
  </div>
</div>`;
shoot('banner', 2400, 800, page(2400, 800, banner), join(out, 'banner.png'));

rmSync(tmp, { recursive: true, force: true });
