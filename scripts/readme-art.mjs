#!/usr/bin/env node
// Renders the README graphics in docs/images with headless Edge, in Ylide's
// brand: cryostat blue, qubit cyan for the AI, brass for what is local, the braid.
//
//   node scripts/readme-art.mjs                      every graphic
//   node scripts/readme-art.mjs how-it-works         only the names that contain a word
//   node scripts/readme-art.mjs --out <dir> [...]    somewhere else, to compare first
//
// Windows only (it needs Microsoft Edge). The screenshots of the app
// (docs/images/screenshot-*.png) are not made here.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const outAt = args.indexOf('--out');
const out = outAt >= 0 ? resolve(args[outAt + 1]) : join(root, 'docs', 'images');
const only = args.filter((_, i) => outAt < 0 || (i !== outAt && i !== outAt + 1));

const edge = [
  join(process.env['ProgramFiles(x86)'] ?? '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  join(process.env.ProgramFiles ?? '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
].find((p) => existsSync(p));
if (!edge) throw new Error('Microsoft Edge was not found');

// The website's fonts (OFL), from the app's own font packages.
const fonts = join(root, 'node_modules', '@fontsource-variable');
const font = (pkg, file) => readFileSync(join(fonts, pkg, 'files', file)).toString('base64');
const FONTS = `
@font-face { font-family: 'Instrument Sans'; src: url(data:font/woff2;base64,${font('instrument-sans', 'instrument-sans-latin-standard-normal.woff2')}) format('woff2'); font-weight: 400 700; font-stretch: 75% 100%; }
@font-face { font-family: 'JetBrains Mono'; src: url(data:font/woff2;base64,${font('jetbrains-mono', 'jetbrains-mono-latin-wght-normal.woff2')}) format('woff2'); font-weight: 100 800; }`;

const THEMES = {
  dark: { card: '#0C111B', tile: '#111726', raised: '#111726', line: '#273246', line2: '#35425B', t1: '#E7ECF4', t2: '#9AA6BB', t3: '#808CA6', qubit: '#22D3EE', brass: '#C9A66B', frost: '#E6ECF5', ok: '#3DD68C', warn: '#F2A93B' },
  light: { card: '#F5F7FA', tile: '#111726', raised: '#FFFFFF', line: '#D6DCE5', line2: '#B9C1CE', t1: '#121826', t2: '#4A5468', t3: '#667085', qubit: '#0E7490', brass: '#7E5F24', frost: '#121826', ok: '#0F7A45', warn: '#945600' },
};

// The mark from docs/brand/ylide-mark.svg, in one colour.
const mark = (color, size) => `<svg width="${size}" height="${size}" viewBox="0 0 1024 1024" fill="none" aria-hidden="true">
  <defs>
    <clipPath id="cut"><rect x="0" y="128" width="1024" height="768"/></clipPath>
    <clipPath id="under"><path clip-rule="evenodd" d="M-64 -64 H1088 V1088 H-64 Z M430.04 83.53 L725.72 435.91 L593.96 546.47 L298.28 194.09 Z"/></clipPath>
  </defs>
  <g clip-path="url(#cut)" stroke="${color}" stroke-width="120" stroke-linecap="butt">
    <path d="M736.04 48 L512 315 L436.05 405.51 A175 175 0 0 0 436.05 630.49 L474.57 676.39 A160 160 0 0 1 512 779.24 L512 976" clip-path="url(#under)"/>
    <path d="M287.96 48 L512 315 L587.95 405.51 A175 175 0 0 1 587.95 630.49 L549.43 676.39 A160 160 0 0 0 512 779.24 L512 976"/>
  </g>
</svg>`;

// Two world lines braiding: sinusoids in opposite phase, crossing every half
// wave. At each crossing the line on top is redrawn over a gap in the
// background colour, the way knots are drawn; which one is on top alternates.
function braid(c, w, h, { waves = 2, amp = 0.32, stroke = 3, dots = true } = {}) {
  const cy = h / 2;
  const A = h * amp;
  const lam = w / waves;
  const pts = (sign) => {
    const p = [];
    for (let x = 0; x <= w; x += 2) p.push(`${x.toFixed(1)},${(cy + sign * A * Math.cos((2 * Math.PI * x) / lam)).toFixed(1)}`);
    return 'M' + p.join(' L');
  };
  const a = pts(1);
  const b = pts(-1);
  const crossings = [];
  for (let k = 0; lam / 4 + (k * lam) / 2 < w; k++) crossings.push(lam / 4 + (k * lam) / 2);
  const over = crossings.map((x, i) => {
    const top = i % 2 === 0 ? { d: a, col: c.qubit } : { d: b, col: c.brass };
    const r = Math.max(18, stroke * 7);
    return `<clipPath id="x${i}"><circle cx="${x}" cy="${cy}" r="${r}"/></clipPath>
      <g clip-path="url(#x${i})"><path d="${top.d}" stroke="${c.card}" stroke-width="${stroke * 4.5}" fill="none"/><path d="${top.d}" stroke="${top.col}" stroke-width="${stroke}" fill="none" stroke-linecap="round"/></g>`;
  }).join('');
  const marks = dots
    ? [0.5, 1].filter((f) => lam * f < w - 4).flatMap((f) => {
        const x = lam * f;
        const ya = cy + A * Math.cos((2 * Math.PI * x) / lam);
        const yb = cy - A * Math.cos((2 * Math.PI * x) / lam);
        return [
          `<circle cx="${x}" cy="${ya}" r="${stroke * 2.2}" fill="${c.card}" stroke="${c.qubit}" stroke-width="${stroke * 0.8}"/>`,
          `<circle cx="${x}" cy="${yb}" r="${stroke * 2.2}" fill="${c.card}" stroke="${c.brass}" stroke-width="${stroke * 0.8}"/>`,
        ];
      }).join('')
    : '';
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" fill="none" aria-hidden="true" style="overflow:visible">
    <path d="${b}" stroke="${c.brass}" stroke-width="${stroke}" stroke-linecap="round"/>
    <path d="${a}" stroke="${c.qubit}" stroke-width="${stroke}" stroke-linecap="round"/>
    ${over}${marks}
  </svg>`;
}

const framed = (c, pad, body) => `<div style="position:absolute;inset:0;background:${c.card};border:1px solid ${c.line};border-radius:20px"></div><div style="position:absolute;left:${pad[0]}px;top:${pad[1]}px;right:0;bottom:0">${body}</div>`;
const page = (w, h, css, body) => `<!doctype html><html><head><meta charset="utf-8"><style>${FONTS}
* { box-sizing: border-box; margin: 0; }
html, body { width: ${w}px; height: ${h}px; background: transparent; overflow: hidden; }
body { font-family: 'Instrument Sans', system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
.mono { font-family: 'JetBrains Mono', ui-monospace, monospace; }
${css}</style></head><body>${body}</body></html>`;

// ------------------------------------------------------------------ banner
function banner(t) {
  const c = THEMES[t];
  return page(1280, 360, `
.card { position: absolute; inset: 0; background: ${c.card}; border: 1px solid ${c.line}; border-radius: 20px; overflow: hidden; }
.left { position: absolute; left: 64px; top: 0; bottom: 0; display: flex; align-items: center; gap: 36px; }
.tile { width: 132px; height: 132px; border-radius: 28px; background: ${c.tile}; display: grid; place-items: center; border: 1px solid ${t === 'dark' ? c.line : c.tile}; }
.name { font-size: 76px; font-weight: 600; letter-spacing: -0.03em; color: ${c.t1}; line-height: 1; }
.slogan { margin-top: 14px; font-size: 15px; letter-spacing: 0.22em; text-transform: uppercase; color: ${c.brass}; }
.claim { margin-top: 22px; font-size: 21px; line-height: 1.45; color: ${c.t2}; max-width: 520px; }
.art { position: absolute; right: 56px; top: 72px; }`,
  `<div class="card"><div class="left"><div class="tile">${mark('#E6ECF5', 96)}</div><div>
    <div class="name">Ylide</div><div class="slogan mono">Your Local IDE</div>
    <p class="claim">Chat, inline edits and coding agents, powered only by models on your own computer.</p>
  </div></div><div class="art">${braid(c, 420, 216, { waves: 1.5, amp: 0.36, stroke: 3 })}</div></div>`);
}

// ------------------------------------------------------------------ social preview
function social() {
  const c = THEMES.dark;
  return page(1280, 640, `
body { background: ${c.card}; }
.wrap { position: absolute; inset: 0; padding: 88px 96px; }
.row { display: flex; align-items: center; gap: 40px; }
.tile { width: 156px; height: 156px; border-radius: 34px; background: ${c.tile}; display: grid; place-items: center; border: 1px solid ${c.line}; }
.name { font-size: 104px; font-weight: 600; letter-spacing: -0.03em; color: ${c.t1}; line-height: 1; }
.slogan { margin-top: 16px; font-size: 19px; letter-spacing: 0.22em; text-transform: uppercase; color: ${c.brass}; }
.claim { margin-top: 56px; font-size: 34px; line-height: 1.35; color: ${c.t1}; max-width: 760px; font-weight: 500; letter-spacing: -0.01em; }
.claim span { color: ${c.t2}; }
.foot { position: absolute; left: 96px; bottom: 72px; display: flex; gap: 28px; font-size: 18px; color: ${c.t3}; }
.foot b { color: ${c.qubit}; font-weight: 500; }
.art { position: absolute; right: 64px; top: 150px; }`,
  `<div class="wrap"><div class="row"><div class="tile">${mark('#E6ECF5', 112)}</div><div><div class="name">Ylide</div><div class="slogan mono">Your Local IDE</div></div></div>
   <p class="claim">The open-source AI coding IDE <span>that runs models only on your own computer.</span></p></div>
   <div class="foot mono"><b>ylide.app</b><span>Apache-2.0</span><span>Windows 10/11</span><span>llama.cpp</span></div>
   <div class="art">${braid(c, 330, 340, { waves: 1, amp: 0.4, stroke: 4 })}</div>`);
}

// ------------------------------------------------------------------ how it works
// What stays on the computer, and the network doors (apps/desktop/src-tauri/src/network.rs).
function how(t) {
  const c = THEMES[t];
  const card = (x, y, w, h, accent, title, lines) => `<div class="box" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px;border-left-color:${accent}"><div class="bt">${title}</div>${lines.map((l) => `<div class="bl">${l}</div>`).join('')}</div>`;
  const arrow = (x1, y1, x2, y2, col, dash = '') => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${col}" stroke-width="2" ${dash}/><path d="M${x2} ${y2} l-10 -6 v12 z" fill="${col}" transform="rotate(${(Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI} ${x2} ${y2})"/>`;
  // [name, host, what protects it, off until the user allows it]
  const doors = [
    ['Model list', 'ylide.app', 'signed'],
    ['Update check', 'ylide.app', 'signed installers'],
    ['Model downloads', 'huggingface.co', 'SHA-256 checked'],
    ['Runtime downloads', 'github.com/ggml-org', 'SHA-256 checked'],
    ['Skill downloads', 'api.github.com<br>raw.githubusercontent.com', 'off until you allow it, pinned to a commit', true],
  ];
  const doorY = (i) => 112 + i * 84;
  const door = ([name, host, note, off], i) =>
    `<div class="door" style="top:${doorY(i)}px"><b>${name}</b><span class="mono">${host}</span>${off ? `<i class="own">${note}</i>` : ` · <i>${note}</i>`}</div>`;
  return page(1360, 620, `
.zone { position: absolute; left: 24px; top: 40px; width: 840px; height: 492px; border: 2px dashed ${c.brass}; border-radius: 22px; }
.zl { position: absolute; left: 52px; top: 30px; padding: 0 12px; background: ${c.card}; font-size: 14px; letter-spacing: 0.2em; color: ${c.brass}; text-transform: uppercase; }
.zl2 { position: absolute; left: 56px; top: 494px; font-size: 15px; color: ${c.t2}; }
.box { position: absolute; background: ${c.raised}; border: 1px solid ${c.line}; border-left: 4px solid; border-radius: 12px; padding: 16px 18px; }
.bt { font-size: 21px; font-weight: 600; color: ${c.t1}; letter-spacing: -0.01em; margin-bottom: 6px; }
.bl { font-size: 14px; line-height: 1.5; color: ${c.t2}; }
.bl.m { font-family: 'JetBrains Mono', monospace; font-size: 13px; }
.dt { position: absolute; left: 920px; top: 60px; font-size: 14px; letter-spacing: 0.2em; color: ${c.t3}; text-transform: uppercase; }
.door { position: absolute; left: 920px; width: 380px; }
.door b { display: block; font-size: 18px; font-weight: 600; color: ${c.t1}; }
.door span { font-size: 14px; color: ${c.t2}; }
.door i { font-style: normal; font-size: 13px; color: ${c.qubit}; }
.door i.own { display: block; margin-top: 2px; }
svg.lines { position: absolute; inset: 0; }`,
  framed(c, [40, 30], `<div class="zone"></div><div class="zl mono">Your computer</div>
   <div class="zl2">Your code, prompts and chats never leave this box. No account, no telemetry.</div>
   <svg class="lines" width="1280" height="560">
     ${arrow(308, 168, 362, 248, c.t3)}${arrow(308, 280, 362, 280, c.t3)}${arrow(308, 392, 362, 312, c.t3)}
     ${arrow(586, 280, 636, 280, c.t3)}
     ${doors.map(([, , , off], i) => arrow(908, doorY(i) + 22, 852, doorY(i) + 22, off ? c.line2 : c.t3, 'stroke-dasharray="3 6"')).join('')}
   </svg>
   ${card(64, 112, 244, 104, c.qubit, 'Editor', ['Monaco, tabs, search', 'Inline edit with Ctrl+K'])}
   ${card(64, 228, 244, 104, c.qubit, 'Chat', ['@file, @folder, @symbol', 'Token count for everything'])}
   ${card(64, 344, 244, 104, c.qubit, 'Agents', ['Orchestrator, Coder, Reviewer', 'Checkpoints, approvals'])}
   ${card(362, 196, 224, 168, c.qubit, 'llama-server', ['<span class="mono">llama.cpp</span>, started by Ylide', 'Listens on 127.0.0.1 only, with a random key', 'CPU, Vulkan or CUDA'])}
   ${card(636, 196, 210, 168, c.brass, 'Model files', ['GGUF on your disk', 'Your own GGUF files too', 'Checked against SHA-256'])}
   <div class="dt mono">Five doors, all switchable</div>
   ${doors.map(door).join('')}`));
}

// ------------------------------------------------------------------ agents
function agents(t) {
  const c = THEMES[t];
  const lanes = { O: 92, C: 196, R: 300 };
  const laneCol = { O: c.t2, C: c.qubit, R: c.brass };
  // The run as a world line: lane per stretch of time, and what happens there.
  const steps = [
    ['O', 150, 300, 'plan: 2 tasks'],
    ['C', 360, 480, 'T1 · fix total()'],
    ['R', 540, 620, 'changes requested'],
    ['C', 680, 760, 'T1 · fix'],
    ['R', 820, 880, 'approved'],
    ['C', 940, 1040, 'T2 · add test'],
    ['R', 1100, 1150, 'approved'],
    ['O', 1200, 1240, 'done'],
  ];
  const segs = [];
  steps.forEach(([lane, x1, x2], i) => {
    const y = lanes[lane];
    if (i > 0) {
      const [pl, , px2] = steps[i - 1];
      const py = lanes[pl];
      const mx = (px2 + x1) / 2;
      segs.push(`<path d="M${px2} ${py} C${mx} ${py} ${mx} ${y} ${x1} ${y}" stroke="${laneCol[lane]}" stroke-width="3" fill="none"/>`);
    }
    segs.push(`<path d="M${x1} ${y} L${x2} ${y}" stroke="${laneCol[lane]}" stroke-width="3" stroke-linecap="round" fill="none"/>`);
  });
  const labels = steps.map(([lane, x1, , text]) => `<div class="lab" style="left:${x1}px;top:${lane === 'R' ? lanes[lane] + 12 : lanes[lane] - 36}px;color:${lane === 'R' && text.startsWith('changes') ? c.warn : lane === 'R' ? c.ok : c.t1}">${text}</div>`).join('');
  const checkpoints = steps.filter(([lane]) => lane === 'C').map(([, x1]) => `<rect x="${x1 - 7}" y="${lanes.C - 7}" width="14" height="14" transform="rotate(45 ${x1} ${lanes.C})" fill="${c.card}" stroke="${c.t1}" stroke-width="2"/>`).join('');
  const gate = `<g transform="translate(392 ${lanes.C + 30})"><rect x="-58" y="-2" width="150" height="28" rx="6" fill="${c.raised}" stroke="${c.line}"/><text x="17" y="17" text-anchor="middle" font-family="JetBrains Mono" font-size="13" fill="${c.warn}">npm test · asks</text></g>`;
  return page(1360, 500, `
.lane { position: absolute; left: 0; font-size: 18px; font-weight: 600; }
.lane small { display: block; font-size: 13px; font-weight: 400; color: ${c.t3}; margin-top: 2px; }
.lab { position: absolute; font-size: 14px; white-space: nowrap; }
.legend { position: absolute; left: 0; top: 368px; display: flex; gap: 40px; font-size: 15px; color: ${c.t2}; }
.legend b { color: ${c.t1}; font-weight: 600; }
svg { position: absolute; inset: 0; }`,
  framed(c, [44, 40], `<svg width="1280" height="420">
     ${Object.values(lanes).map((y) => `<line x1="150" y1="${y}" x2="1250" y2="${y}" stroke="${c.line}" stroke-width="1.5" stroke-dasharray="2 7"/>`).join('')}
     ${segs.join('')}${checkpoints}${gate}
   </svg>
   <div class="lane" style="top:${lanes.O - 20}px;color:${c.t1}">Orchestrator<small>plans small tasks</small></div>
   <div class="lane" style="top:${lanes.C - 20}px;color:${c.qubit}">Coder<small>reads, edits, runs</small></div>
   <div class="lane" style="top:${lanes.R - 20}px;color:${c.brass}">Reviewer<small>checks each task</small></div>
   ${labels}
   <div class="legend"><span><b>◆ Checkpoint</b> before every task: undo any step</span><span><b>Approvals</b>: commands and deletions ask first</span><span><b>Every prompt</b> and role is editable</span></div>`));
}

// ------------------------------------------------------------------ download button
function button(t) {
  const bg = t === 'dark' ? '#22D3EE' : '#0E7490';
  const fg = t === 'dark' ? '#0B2530' : '#FFFFFF';
  return page(460, 76, `
.b { position: absolute; inset: 0; background: ${bg}; color: ${fg}; border-radius: 12px; display: flex; align-items: center; gap: 16px; padding: 0 26px; }
.l { font-size: 23px; font-weight: 600; letter-spacing: -0.01em; }
.s { margin-left: auto; padding-left: 18px; border-left: 1px solid ${fg}55; font-size: 15px; opacity: 0.85; }`,
  `<div class="b"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="${fg}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg><span class="l">Download for Windows</span><span class="s mono">ylide.app</span></div>`);
}

// [file name, CSS width, CSS height, page, pixel ratio]
const jobs = [
  ['download-dark', 460, 76, () => button('dark')],
  ['download-light', 460, 76, () => button('light')],
  ['banner-dark', 1280, 360, () => banner('dark')],
  ['banner-light', 1280, 360, () => banner('light')],
  ['social-preview', 1280, 640, social, 1],
  ['how-it-works-dark', 1360, 620, () => how('dark')],
  ['how-it-works-light', 1360, 620, () => how('light')],
  ['agents-dark', 1360, 500, () => agents('dark')],
  ['agents-light', 1360, 500, () => agents('light')],
];

const tmp = join(tmpdir(), `ylide-readme-art-${process.pid}`);
mkdirSync(tmp, { recursive: true });
mkdirSync(out, { recursive: true });

for (const [name, width, height, html, scale = 2] of jobs) {
  if (only.length && !only.some((w) => name.includes(w))) continue;
  const file = join(tmp, `${name}.html`);
  const png = join(tmp, `${name}.png`);
  writeFileSync(file, html());
  try {
    execFileSync(
      edge,
      [
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        '--no-first-run',
        `--force-device-scale-factor=${scale}`,
        '--default-background-color=00000000',
        // A fresh profile per shot: a second launch on the same one can hang.
        `--user-data-dir=${join(tmp, `profile-${name}`)}`,
        `--window-size=${width},${height}`,
        '--virtual-time-budget=2000',
        `--screenshot=${png}`,
        pathToFileURL(file).href,
      ],
      { stdio: 'ignore', timeout: 60_000 },
    );
  } catch {
    // Edge reports the written file on stderr and may exit non-zero; check the file instead.
  }
  if (!existsSync(png)) throw new Error(`Edge did not write ${name}.png`);
  writeFileSync(join(out, `${name}.png`), readFileSync(png));
  console.log(`wrote ${join(out, `${name}.png`)}`);
}

rmSync(tmp, { recursive: true, force: true });
