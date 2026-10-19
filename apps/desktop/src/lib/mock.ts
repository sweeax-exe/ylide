// In-browser stand-in for the Rust core, used when the UI runs outside Tauri
// (design work, screenshots, UI development without a model). It simulates
// realistic behaviour: downloads progress, models load, chat streams, and an
// agent run asks for approval. It never touches the network or disk.
//
// Failure modes for checking error UIs, set with `?mock=<mode>[,<mode>]`:
//   offline   downloads fail with network_disabled
//   diskfull  downloads fail with disk_full
//   jobfail   model downloads fail halfway (checksum mismatch)
//   notgguf   importing a model file fails with not_gguf
//   crash     the model server crashes while loading
//   question  the coder asks the user a question with answers to click during the run
//   clarify   the orchestrator asks two questions before it plans
//   chatask   the chat answers a first message with a question and answers to click
//   changes   the reviewer requests changes once
//   lastrun   the project has a failed agent run from an earlier session, with open tasks
//   norecap   the orchestrator writes no summary at the end (the task list stands in)
//   skills    starts with installed skills, one of them broken (see ./mockSkills.ts)
//   novision  the installed model starts with image input off (no projector)
//   ratelimit GitHub refuses skill listings: its request limit is used up
//   fastram   the RAM already runs at its rated speed (no EXPO/XMP tip)
//   calibrated the chat model was calibrated for this PC before ("Optimize for this PC")
//   calstale  ... and the RAM speed changed since
//   calfail   the calibration fails (the model does not start)

import registryJson from '../../../../registry/models.json';
import orchestratorPrompt from '../../../../crates/agent/prompts/orchestrator.md?raw';
import coderPrompt from '../../../../crates/agent/prompts/coder.md?raw';
import reviewerPrompt from '../../../../crates/agent/prompts/reviewer.md?raw';
import templatesJson from '../../../../crates/agent/prompts/templates.json';
import chatPrompt from '../../src-tauri/prompts/chat.md?raw';
import inlinePrompt from '../../src-tauri/prompts/inline.md?raw';
import type { StoredChat } from '../bindings/StoredChat';
import type { AgentEvent } from '../bindings/AgentEvent';
import type { CalibrationResult } from '../bindings/CalibrationResult';
import type { ChatEvent } from '../bindings/ChatEvent';
import type { DownloadJob } from '../bindings/DownloadJob';
import type { FileChange } from '../bindings/FileChange';
import type { FileNode } from '../bindings/FileNode';
import type { HardwareProfile } from '../bindings/HardwareProfile';
import type { HardwareTips } from '../bindings/HardwareTips';
import type { InlineEvent } from '../bindings/InlineEvent';
import type { InstalledModel } from '../bindings/InstalledModel';
import type { LastRun } from '../bindings/LastRun';
import type { Mention } from '../bindings/Mention';
import type { NetworkLogEntry } from '../bindings/NetworkLogEntry';
import type { Placement } from '../bindings/Placement';
import type { Plan } from '../bindings/Plan';
import type { TaskPlan } from '../bindings/TaskPlan';
import type { Question } from '../bindings/Question';
import type { Recommendation } from '../bindings/Recommendation';
import type { Registry } from '../bindings/Registry';
import type { RuntimeStatus } from '../bindings/RuntimeStatus';
import type { ServerInfo } from '../bindings/ServerInfo';
import type { Settings } from '../bindings/Settings';
import type { Task } from '../bindings/Task';
import { planningCommand, planningControl } from './mockPlanning';
import { mentionedSkillItems, skillsCommand } from './mockSkills';

const registry = registryJson as unknown as Registry;
const failures = new Set((new URLSearchParams(location.search).get('mock') ?? '').split(',').filter(Boolean));
const GiB = 1024 ** 3;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ events

type Handler = (payload: unknown) => void;
const listeners = new Map<string, Set<Handler>>();

export function mockListen(name: string, handler: Handler): () => void {
  if (!listeners.has(name)) listeners.set(name, new Set());
  listeners.get(name)!.add(handler);
  return () => listeners.get(name)?.delete(handler);
}

function emit(name: string, payload: unknown) {
  listeners.get(name)?.forEach((h) => h(payload));
}

// ------------------------------------------------------------------ data

const role = (id: string, name: string, description: string, systemPrompt: string, tools: string[], maxSteps: number) => ({
  id,
  name,
  description,
  systemPrompt: systemPrompt.trim(),
  tools,
  model: null,
  temperature: null,
  maxSteps,
  builtin: true,
});
const read = ['list_dir', 'read_file', 'search', 'find_files'];

let settings: Settings = {
  version: 1,
  language: null,
  theme: 'dark',
  onboardingDone: new URLSearchParams(location.search).has('workbench'),
  lastProject: null,
  network: {
    allowRegistryUpdates: true,
    allowModelDownloads: true,
    allowRuntimeDownloads: true,
    allowUpdateChecks: true,
    allowSkillDownloads: false,
    registryUrl: 'https://ylide.app/registry/v2/models.json',
  },
  models: { dir: null, chat: null, autocomplete: null, embedding: null, context: null, runtimeVariant: null, slots: 2, extraArgs: [], autostart: true, quantizeKv: false },
  endpoint: { enabled: false, baseUrl: '', apiKey: null, model: null, context: null },
  agent: {
    permissions: { mode: 'autoSafe', confirmCommands: true, confirmDeletes: true, allowedCommands: [], confirmPlan: null },
    roles: [
      role('orchestrator', 'Orchestrator', 'Understands the request, explores the project and plans small tasks.', orchestratorPrompt, [...read, 'submit_plan'], 12),
      role('coder', 'Coder', 'Implements tasks: reads, edits and creates files, runs builds and tests.', coderPrompt, [...read, 'write_file', 'edit_file', 'delete_file', 'run_command', 'ask', 'finish'], 40),
      role('reviewer', 'Reviewer', "Reviews each task's diff, runs checks and requests changes when needed.", reviewerPrompt, [...read, 'run_command', 'ask', 'submit_review'], 16),
    ],
    templates: templatesJson as Settings['agent']['templates'],
    reviewEnabled: true,
    maxReviewRounds: 2,
    shell: { program: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'], defaultTimeoutSecs: 120, maxOutputChars: 20000 },
    updateProjectNotes: true,
  },
  chat: { systemPrompt: chatPrompt.trim(), inlinePrompt: inlinePrompt.trim(), contextBudgetTokens: 24000, saveHistory: true },
  editor: { fontSize: 13, fontFamily: '"JetBrains Mono Variable", "JetBrains Mono", Consolas, monospace', tabSize: 4, wordWrap: false, minimap: false, lineHeight: 1.55 },
  questions: 'ifNeeded',
};
const defaultSettings: Settings = structuredClone(settings);

const hardware: HardwareProfile = {
  os: { family: 'windows', version: 'Windows 11 Pro (26200)', arch: 'x86_64' },
  cpu: { brand: 'AMD Ryzen 9 9950X3D 16-Core Processor', physicalCores: 16, logicalCores: 32, features: { avx2: true, avx512: true, fma: true, neon: false } },
  memory: { totalBytes: 64 * GiB, availableBytes: 37 * GiB },
  gpus: [
    { index: 0, name: 'NVIDIA GeForce RTX 5070 Ti', vendor: 'nvidia', vendorId: 0x10de, deviceId: 0x2c05, kind: 'discrete', dedicatedVramBytes: 15.6 * GiB, sharedMemoryBytes: 45.6 * GiB, vramBudgetBytes: 14.9 * GiB, vramFreeBytes: 13.85 * GiB, computeCapability: '12.0' },
    { index: 1, name: 'AMD Radeon(TM) Graphics', vendor: 'amd', vendorId: 0x1002, deviceId: 0x13c0, kind: 'integrated', dedicatedVramBytes: 2 * GiB, sharedMemoryBytes: 45.6 * GiB, vramBudgetBytes: null, vramFreeBytes: null, computeCapability: null },
  ],
  acceleration: { cudaDriver: '13.3', vulkan: true, directml: true, metal: false, rocm: false },
  disk: { mountPoint: 'D:\\', totalBytes: 1863 * GiB, freeBytes: 282 * GiB },
  probedAtUnixMs: Date.now(),
  warnings: [],
};

/** This PC: a 6000 MT/s kit running at the JEDEC 4800 because EXPO is off. */
const ddr5 = { kind: 'DDR5', sizeBytes: 32 * GiB, manufacturer: 'Unknown', partNumber: '6000 Series', speedMts: 4800, configuredMts: 4800, configuredMv: 1100, ratedMts: 6000 };
const hardwareTips: HardwareTips = {
  ramSpeed: { kind: 'DDR5', configuredMts: 4800, ratedMts: 6000, partNumber: '6000 Series' },
  memoryModules: [ddr5, { ...ddr5 }],
};

const plan = (placement: Placement, context: number, vram: number, ram: number, tps: number, weights: number): Plan => ({
  placement,
  context,
  kvCacheType: 'f16' as const,
  weightsBytes: weights,
  kvBytes: context * 20480,
  overheadBytes: 0.9 * GiB,
  projectorBytes: 0,
  vramBytes: vram * GiB,
  ramBytes: ram * GiB,
  estTokensPerSec: tps,
});
const fileSize = (id: string, quant: string) =>
  registry.models.find((m) => m.id === id)?.variants.find((v) => v.quant === quant)?.files.reduce((s, f) => s + f.sizeBytes, 0) ?? 0;
const reason = (code: string, params: Record<string, string> = {}) => ({ code, params }) as Recommendation['notices'][number];

// A rough estimate of every variant with the whole machine, for the catalog's
// "on this computer": up to 12 GiB runs on the GPU, larger MoE models keep
// their experts in RAM, larger dense models split their layers. The largest
// variants are left out, so the catalog also shows ones that do not fit.
function estimateFits(): Recommendation['fits'] {
  return registry.models.flatMap((m) =>
    m.variants.flatMap((v) => {
      const weights = fileSize(m.id, v.quant);
      if (weights > 25 * GiB) return [];
      const context = m.roles.includes('chat') ? Math.min(m.context.recommended, 65536) : 8192;
      // Like plan(): 0.9 GiB overhead and 20 KiB of KV cache per token.
      const need = (weights + context * 20480) / GiB + 0.9;
      const vram = Math.min(need, 12);
      const ram = need - vram;
      const layers = m.architecture.layers;
      const placement: Placement =
        ram === 0
          ? { kind: 'gpu' }
          : m.architecture.type === 'moe'
            ? { kind: 'moeOffload', cpuExpertLayers: Math.round((layers * ram) / need) }
            : { kind: 'partialOffload', gpuLayers: Math.round((layers * vram) / need) };
      // Each token reads the active weights, at GPU or RAM speed.
      const active = (weights * m.architecture.paramsActiveB) / m.architecture.paramsTotalB;
      const tps = Math.round(Math.min(300, 0.6 / ((active * vram) / need / 896e9 + (active * ram) / need / 65e9)));
      const round = (gib: number) => Math.round(gib * 10) / 10;
      return [{ modelId: m.id, quant: v.quant, plan: plan(placement, context, round(vram), round(ram), tps, weights), score: 0, downloadBytes: weights, reasons: [] }];
    }),
  );
}

const recommendation: Recommendation = {
  budget: { vramBytes: 12.85 * GiB, gpuBandwidthGbps: 896, ramBytes: 51.2 * GiB, ramBandwidthGbps: 65, unified: false, unifiedBytes: 0, diskFreeBytes: 282 * GiB, backend: 'cuda', gpuName: 'NVIDIA GeForce RTX 5070 Ti' },
  primary: {
    modelId: 'qwen3.6-35b-a3b',
    quant: 'UD-IQ4_XS',
    plan: plan({ kind: 'moeOffload', cpuExpertLayers: 22 }, 131072, 10.5, 8.2, 55, fileSize('qwen3.6-35b-a3b', 'UD-IQ4_XS')),
    score: 80.3,
    downloadBytes: fileSize('qwen3.6-35b-a3b', 'UD-IQ4_XS'),
    reasons: [
      reason('moeOffload', { vramGb: '10.5', ramGb: '8.2', cpuExpertLayers: '22' }),
      reason('speedEstimate', { tps: '55' }),
      reason('benchmark', { name: 'SWE-bench Verified', score: '73.4', unit: '%', selfReported: 'true' }),
      reason('toolCalling', { level: 'good' }),
      reason('longContext', { tokens: '131072' }),
      reason('reasoningModel'),
      reason('permissiveLicense', { license: 'Apache License 2.0' }),
    ],
  },
  alternatives: [
    {
      kind: 'faster',
      candidate: {
        modelId: 'qwen3.6-35b-a3b',
        quant: 'UD-IQ3_XXS',
        plan: plan({ kind: 'moeOffload', cpuExpertLayers: 18 }, 131072, 10.6, 5, 81, fileSize('qwen3.6-35b-a3b', 'UD-IQ3_XXS')),
        score: 78,
        downloadBytes: fileSize('qwen3.6-35b-a3b', 'UD-IQ3_XXS'),
        reasons: [reason('moeOffload', { vramGb: '10.6', ramGb: '5.0', cpuExpertLayers: '18' }), reason('speedEstimate', { tps: '81' }), reason('permissiveLicense', { license: 'Apache License 2.0' })],
      },
    },
    {
      kind: 'stronger',
      candidate: {
        modelId: 'qwen3.8-27b',
        quant: 'UD-IQ3_XXS',
        plan: { ...plan({ kind: 'gpu' }, 32768, 12, 0, 49, fileSize('qwen3.8-27b', 'UD-IQ3_XXS')), kvCacheType: 'q8_0' },
        score: 78.3,
        downloadBytes: fileSize('qwen3.8-27b', 'UD-IQ3_XXS'),
        reasons: [reason('fitsInVram', { vramGb: '12.0' }), reason('speedEstimate', { tps: '49' }), reason('topQualityForBudget'), reason('toolCalling', { level: 'excellent' }), reason('quantizedKvCache', { type: 'q8_0' }), reason('autocompleteMovesToCpu'), reason('permissiveLicense', { license: 'Apache License 2.0' })],
      },
    },
    {
      kind: 'lighter',
      candidate: {
        modelId: 'qwen3.5-9b',
        quant: 'Q6_K',
        plan: plan({ kind: 'gpu' }, 65536, 9.5, 0, 72, fileSize('qwen3.5-9b', 'Q6_K')),
        score: 59,
        downloadBytes: fileSize('qwen3.5-9b', 'Q6_K'),
        reasons: [reason('fitsInVram', { vramGb: '9.5' }), reason('speedEstimate', { tps: '72' }), reason('permissiveLicense', { license: 'Apache License 2.0' })],
      },
    },
  ],
  autocomplete: {
    modelId: 'qwen2.5-coder-1.5b-fim',
    quant: 'Q8_0',
    plan: plan({ kind: 'gpu' }, 8192, 2.1, 0, 326, fileSize('qwen2.5-coder-1.5b-fim', 'Q8_0')),
    score: 70,
    downloadBytes: fileSize('qwen2.5-coder-1.5b-fim', 'Q8_0'),
    reasons: [reason('sharesGpuWithMain'), reason('fitsInVram', { vramGb: '2.1' })],
  },
  embedding: {
    modelId: 'qwen3-embedding-0.6b',
    quant: 'Q8_0',
    plan: plan({ kind: 'cpu' }, 8192, 0, 1.8, 46, fileSize('qwen3-embedding-0.6b', 'Q8_0')),
    score: 73.8,
    downloadBytes: fileSize('qwen3-embedding-0.6b', 'Q8_0'),
    reasons: [reason('runsOnCpu')],
  },
  notices: [],
  fits: estimateFits(),
};

/** The projector file of a registry model, as the core records it once downloaded. */
const projectorFile = (modelId: string) => {
  const p = registry.models.find((m) => m.id === modelId)?.projector;
  return p ? { path: `D:/models/${modelId}/${p.path}`, sizeBytes: p.sizeBytes, sha256: p.sha256 } : null;
};

// The demo model sees images, so the attach flow can be tried in the browser.
let installed: InstalledModel[] = settings.onboardingDone
  ? [
      {
        modelId: 'qwen3.6-35b-a3b',
        quant: 'UD-IQ4_XS',
        name: 'Qwen3.6 35B-A3B',
        files: [{ path: 'D:/models/Qwen3.6-35B-A3B-UD-IQ4_XS.gguf', sizeBytes: fileSize('qwen3.6-35b-a3b', 'UD-IQ4_XS'), sha256: null }],
        installedAtUnixMs: Date.now(),
        custom: false,
        projector: failures.has('novision') ? null : projectorFile('qwen3.6-35b-a3b'),
      },
    ]
  : [];
if (settings.onboardingDone) settings.models.chat = { modelId: 'qwen3.6-35b-a3b', quant: 'UD-IQ4_XS' };

const jobs = new Map<string, DownloadJob & { timer?: number }>();
let server: ServerInfo | null = null;

/** A calibration of the chat model like the reference PC's: experts in RAM, 16 cores on two CCDs. */
function mockCalibrationTrials(): CalibrationResult['trials'] {
  const tuning: CalibrationResult['tuning'] = { kv: null, noMmap: null, ubatch: null, threads: null, cpuMask: null, cpuMaskBatch: null, moeCacheMib: null };
  const trial = (kind: CalibrationResult['trials'][number]['kind'], change: Partial<typeof tuning>, promptTps: number, genTps: number, outcome: CalibrationResult['trials'][number]['outcome'], note: string | null = null) => ({
    kind,
    tuning: { ...tuning, ...change },
    speeds: { promptTps, genTps },
    outcome,
    note,
  });
  const ccd = { threads: 8, cpuMask: '0x5555', cpuMaskBatch: '0x55555555' };
  return [
    trial('baseline', {}, 2140, 50.2, 'measured'),
    trial('loadMode', { noMmap: false }, 1318, 50.0, 'worse'),
    trial('batchSize', { ubatch: 1024 }, 2052, 53.8, 'better'),
    trial('threads', { ubatch: 1024, ...ccd }, 2047, 56.9, 'better'),
    trial('expertCache', { ubatch: 1024, ...ccd, moeCacheMib: 1280 }, 2011, 58.4, 'different'),
    trial('confirm', { ubatch: 1024, ...ccd }, 2060, 56.7, 'measured'),
  ];
}

function mockCalibration(): CalibrationResult {
  const trials = mockCalibrationTrials();
  return {
    key: { modelPath: 'D:/models/model.gguf', modelBytes: 21_233_608_512, modelModified: 0, runtime: 'b11669/cuda-13.4', gpu: 'NVIDIA GeForce RTX 5070 Ti, 16303 MiB, driver 13.3', cpu: 'AMD Ryzen 9 9950X3D (16C/32T)', ram: '63 GiB DDR5-4800', context: 131072, slots: 2, projector: false },
    modelId: settings.models.chat?.modelId ?? 'qwen3.6-35b-a3b',
    quant: settings.models.chat?.quant ?? 'UD-IQ4_XS',
    baseline: trials[0].speeds!,
    best: trials[trials.length - 1].speeds!,
    tuning: trials[trials.length - 1].tuning,
    trials,
    createdAtUnixMs: Date.now() - 3_600_000,
  };
}

let calibration: CalibrationResult | null = failures.has('calibrated') || failures.has('calstale') ? mockCalibration() : null;
let calibrating = false;
let calibrationCancelled = false;

/** Plays a calibration: one server restart and measurement per trial. */
async function runMockCalibration() {
  const trials = mockCalibrationTrials();
  const done: CalibrationResult['trials'] = [];
  const base = server;
  for (const trial of trials) {
    emit('runtime://calibration', { state: 'running', current: trial.kind, trials: [...done], total: trials.length });
    if (base) emit('runtime://server', { ...base, status: { state: 'loading' } });
    await sleep(1100);
    if (calibrationCancelled || failures.has('calfail')) {
      calibrating = false;
      server = base;
      emit('runtime://server', server);
      emit('runtime://calibration', calibrationCancelled ? { state: 'cancelled' } : { state: 'failed', message: 'llama-server exited with code 1 while loading' });
      return;
    }
    if (base) emit('runtime://server', { ...base, status: { state: 'ready' } });
    done.push(trial);
  }
  calibration = { ...mockCalibration(), trials: done, createdAtUnixMs: Date.now() };
  calibrating = false;
  server = base ? { ...base, tuned: true, status: { state: 'ready' } } : null;
  emit('runtime://server', server);
  emit('runtime://calibration', { state: 'done', result: calibration });
}
const netLog: NetworkLogEntry[] = [];
const savedChats = new Map<string, StoredChat>();

function logNet(purpose: NetworkLogEntry['purpose'], url: string, outcome: string) {
  const e = { atUnixMs: Date.now(), purpose, url, outcome };
  netLog.push(e);
  emit('network://log', e);
}

const runtime = (): RuntimeStatus => ({
  installed: [
    { variant: 'cpu', backend: 'cpu', version: 'b11669', dir: 'C:/Program Files/Ylide/runtime/cpu', bundled: true },
    { variant: 'vulkan', backend: 'vulkan', version: 'b11669', dir: 'C:/Program Files/Ylide/runtime/vulkan', bundled: true },
    ...(cudaInstalled ? [{ variant: 'cuda-13.4', backend: 'cuda' as const, version: 'b11669', dir: 'C:/Users/me/AppData/Local/app.ylide/runtimes/b11669/cuda-13.4', bundled: false }] : []),
  ],
  downloadable: cudaInstalled
    ? []
    : [
        { variant: 'cuda-13.4', backend: 'cuda', version: 'b11669', sizeBytes: 578_100_000, recommended: true },
        { variant: 'cuda-12.4', backend: 'cuda', version: 'b11669', sizeBytes: 658_000_000, recommended: false },
      ],
  selected: cudaInstalled ? 'cuda-13.4' : 'vulkan',
  install: null,
});
let cudaInstalled = false;

// ------------------------------------------------------------------ demo project

const files = new Map<string, string>([
  ['README.md', '# Demo shop\n\nA tiny web shop used to try Ylide.\n\n```sh\nnpm install\nnpm test\n```\n'],
  ['package.json', '{\n  "name": "demo-shop",\n  "version": "1.0.0",\n  "scripts": { "test": "vitest run" }\n}\n'],
  ['src/cart.ts', "export interface Item {\n  id: string;\n  price: number;\n  quantity: number;\n}\n\nexport function total(items: Item[]): number {\n  return items.reduce((sum, item) => sum + item.price, 0);\n}\n\nexport function addItem(items: Item[], item: Item): Item[] {\n  return [...items, item];\n}\n"],
  ['src/format.ts', "export function formatPrice(cents: number, locale = 'de-DE'): string {\n  return new Intl.NumberFormat(locale, { style: 'currency', currency: 'EUR' }).format(cents / 100);\n}\n"],
  ['src/main.ts', "import { addItem, total } from './cart';\nimport { formatPrice } from './format';\n\nconst cart = addItem([], { id: 'tea', price: 450, quantity: 2 });\nconsole.log(formatPrice(total(cart)));\n"],
  ['test/cart.test.ts', "import { expect, it } from 'vitest';\nimport { total } from '../src/cart';\n\nit('sums prices times quantity', () => {\n  expect(total([{ id: 'a', price: 100, quantity: 3 }])).toBe(300);\n});\n"],
  ['.gitignore', 'node_modules\ndist\n'],
]);

function listDir(path: string): FileNode[] {
  const prefix = path ? `${path}/` : '';
  const children = new Map<string, FileNode>();
  for (const [p, content] of files) {
    if (!p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length);
    const [head, ...tail] = rest.split('/');
    const full = prefix + head;
    if (tail.length) children.set(head, { name: head, path: full, kind: 'dir', sizeBytes: null });
    else children.set(head, { name: head, path: full, kind: 'file', sizeBytes: content.length });
  }
  return [...children.values()].sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1));
}

function contextItems(mentions: Mention[]) {
  return mentions.map((m) => {
    if (m.type === 'selection') return { kind: 'selection' as const, label: `${m.path.split('/').pop()}:${m.startLine}-${m.endLine}`, path: m.path, content: m.text, tokens: Math.ceil(m.text.length / 3.5), truncated: false, error: null };
    if (m.type === 'file') {
      const c = files.get(m.path);
      return { kind: 'file' as const, label: m.path.split('/').pop()!, path: m.path, content: c ?? '', tokens: Math.ceil((c ?? '').length / 3.5), truncated: false, error: c ? null : 'not found' };
    }
    if (m.type === 'folder') return { kind: 'folder' as const, label: `${m.path.split('/').pop() || 'demo-shop'}/`, path: m.path, content: listDir(m.path).map((n) => n.name).join('\n'), tokens: 40, truncated: false, error: null };
    return { kind: 'symbol' as const, label: m.name, path: 'src/cart.ts', content: 'export function total(items: Item[]): number { … }', tokens: 30, truncated: false, error: null };
  });
}

/** Like the core's watcher: reports changed paths shortly after the change. */
function changed(paths: string[]) {
  setTimeout(() => emit('fs://changed', paths), 150);
}

// ------------------------------------------------------------------ streaming helpers

async function streamText(text: string, onChunk: (t: string) => void, cancelled: () => boolean, delay = 18) {
  const parts = text.match(/\S+\s*|\s+/g) ?? [];
  for (const part of parts) {
    if (cancelled()) return false;
    onChunk(part);
    await sleep(delay);
  }
  return true;
}

const cancelledRequests = new Set<string>();

const chatAnswer = `The total ignores the quantity: \`reduce\` adds \`item.price\` once per item, so two teas at 4,50 € count as 4,50 €.

Multiply by the quantity in \`src/cart.ts\`:

\`\`\`ts
export function total(items: Item[]): number {
  return items.reduce((sum, item) => sum + item.price * item.quantity, 0);
}
\`\`\`

The existing test in \`test/cart.test.ts\` (3 × 100 = 300) will pass after this change.

\`\`\`suggestions
Why did no test catch this?
change: Fix total() in src/cart.ts
change: Add a test for an empty cart
\`\`\``;

/** A first message the chat asks back on (`?mock=chatask`). */
const chatQuestion = `Which part should get faster: loading the cart page, or the \`total()\` calculation in \`src/cart.ts\`?

\`\`\`suggestions
Loading the cart page
The total() calculation
Both
\`\`\``;

const chatReasoning = 'The user asks why the cart total is wrong. total() reduces over items and adds item.price, but Item has a quantity field that is never used. The test expects 3 × 100 = 300, so the fix is to multiply by quantity.';

const chatImageReasoning = 'A screenshot of the shop: a cart with two rows and a total line. Two teas at 4,50 € each, but the total says 4,50 €.';

const chatImageAnswer = (count: number) => `${count > 1 ? `I looked at all ${count} images. ` : ''}The screenshot shows the cart page of demo-shop: two teas at **4,50 €** each, but the total line says **4,50 €** instead of 9,00 €.

That is the bug in \`total()\` in \`src/cart.ts\`: it adds \`item.price\` once per item and ignores \`item.quantity\`. Multiply by the quantity and the page shows 9,00 €.`;

/** A small fake screenshot (what `image_load` returns for the picked demo file). */
function demoScreenshot(): string {
  const canvas = document.createElement('canvas');
  canvas.width = 960;
  canvas.height = 600;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  ctx.fillStyle = '#f4f2ee';
  ctx.fillRect(0, 0, 960, 600);
  ctx.fillStyle = '#1d1b19';
  ctx.font = '600 34px sans-serif';
  ctx.fillText('demo-shop · Cart', 48, 80);
  ctx.font = '24px sans-serif';
  ['Green tea × 2      4,50 €', 'Total               4,50 €'].forEach((line, i) => ctx.fillText(line, 48, 170 + i * 70));
  ctx.strokeStyle = '#c2410c';
  ctx.lineWidth = 4;
  ctx.strokeRect(36, 200, 520, 60);
  return canvas.toDataURL('image/png');
}

// ------------------------------------------------------------------ agent simulation

/** Resolvers of what the simulated run waits for (approvals, answers). */
const pendingApprovals = new Map<string, (approved: boolean) => void>();
const pendingAnswers = new Map<string, (answers: string[]) => void>();
/** `handover`: the user switched to Planen; the run stops after its current task. */
let runControl: { paused: boolean; cancelled: boolean; handover: boolean; abort: () => void } = { paused: false, cancelled: false, handover: false, abort: () => undefined };
let runSend: ((e: AgentEvent) => void) | null = null;
let runId = '';
/** Last status per agent, so pause/resume can report it like the core. */
const lastStatus = new Map<string, Extract<AgentEvent, { type: 'status' }>['status']>();
/** Each run's record, as the core keeps it, so a later run can continue it. */
const runRecords = new Map<string, LastRun>();
/** The project's last run, kept across restarts in the core (the mock has one project). */
let lastRun: LastRun | null = failures.has('lastrun') ? storedRun() : null;

/** A run from an earlier session that failed with tasks left open (`?mock=lastrun`). */
function storedRun(): LastRun {
  const finished = Date.now() - 20 * 3600_000;
  const task = (id: string, title: string, status: Task['status'], result: string | null): Task => ({ id, title, description: '', files: ['src/cart.ts'], assignee: 'coder', status, attempts: 0, result, review: null });
  const failed = 'Stopped: step limit reached before the task was finished.';
  return {
    runId: 'run-earlier',
    goal: 'Add discount codes to the cart',
    startedAtUnixMs: finished - 9 * 60_000,
    finishedAtUnixMs: finished,
    outcome: 'failed',
    summary: `✔ T1 Discount model\n   Added a list of codes to src/cart.ts.\n✘ T2 Apply codes in total()\n   ${failed}\n… T3 Test the discounts\n\nChanged files: src/cart.ts`,
    plan: {
      goal: 'Add discount codes to the cart',
      summary: 'Model first, then total(), then tests.',
      tasks: [task('T1', 'Discount model', 'done', 'Added a list of codes to src/cart.ts.'), task('T2', 'Apply codes in total()', 'failed', failed), task('T3', 'Test the discounts', 'pending', null)],
    },
    changes: [{ path: 'src/cart.ts', kind: 'modified', diff: '', checkpointId: 'run-earlier-1' }],
    earlierGoals: [],
    recap: null,
  };
}

/** The previous run's open tasks, open again with a note on the last attempt (like the core). */
function openTasks(previous: LastRun): Task[] {
  return (previous.plan?.tasks ?? [])
    .filter((t) => t.status !== 'done')
    .map((t) => {
      const base = t.description.split('Earlier attempt: ')[0].trim();
      const note = t.status === 'failed' ? `Earlier attempt: failed (${t.result ?? 'no result'}).` : t.status === 'pending' ? '' : 'Earlier attempt: stopped before it was done; changes made so far are in the project.';
      return { ...t, description: [base, note].filter(Boolean).join('\n\n'), status: 'pending', attempts: 0, result: null, review: null };
    });
}

/** With `previous`, a short run that continues it: its open tasks first, then the new request. */
async function simulateRun(id: string, goal: string, deliver: (e: AgentEvent) => void, previous: LastRun | null = null, language = 'en') {
  const carried = previous ? openTasks(previous) : [];
  const record: LastRun = {
    runId: id,
    goal,
    startedAtUnixMs: Date.now(),
    finishedAtUnixMs: 0,
    outcome: 'cancelled',
    summary: '',
    plan: carried.length ? { goal, summary: '', tasks: carried } : null,
    changes: [],
    earlierGoals: previous ? [...previous.earlierGoals, previous.goal].slice(-3) : [],
    recap: null,
  };
  // Keeps the record the core would store when the run ends.
  const send = (e: AgentEvent) => {
    if (e.type === 'planReady') record.plan = e.plan;
    if (e.type === 'taskUpdated' && record.plan) record.plan = { ...record.plan, tasks: record.plan.tasks.map((t) => (t.id === e.task.id ? e.task : t)) };
    if (e.type === 'toolResult' && e.change) record.changes.push({ ...e.change, diff: '' });
    if (e.type === 'runFinished') {
      Object.assign(record, { outcome: e.outcome, summary: e.summary, recap: e.recap, finishedAtUnixMs: Date.now() });
      runRecords.set(id, record);
      lastRun = record;
    }
    deliver(e);
  };
  runId = id;
  runSend = send;
  lastStatus.clear();
  let counter = 0;
  const nextId = (prefix: string) => `${prefix}-${++counter}`;
  const cancelled = new Promise<never>((_, reject) => {
    runControl.abort = () => reject(new Error('cancelled'));
  });
  cancelled.catch(() => undefined);
  const status = (agentId: string, roleId: string, state: string, step: string, taskId: string | null, tps = 0) => {
    const st = { agentId, role: roleId, state: state as never, step, taskId, tokensPerSecond: tps, totalTokens: Math.round(tps * 7) };
    lastStatus.set(agentId, st);
    send({ type: 'status', runId, status: st });
  };
  const wait = async (ms: number) => {
    const end = Date.now() + ms;
    while (Date.now() < end || runControl.paused) {
      if (runControl.cancelled) throw new Error('cancelled');
      await sleep(80);
    }
  };
  /** Streams an agent's visible text, as the core forwards deltas. */
  const think = async (agentId: string, text: string) => {
    for (const part of text.match(/\S+\s*/g) ?? []) {
      await wait(35);
      send({ type: 'delta', runId, agentId, delta: { kind: 'content', text: part } });
    }
  };
  /** A tool call and its result, paired by the call id like the core. */
  const tool = async (agentId: string, name: string, args: string, summary: string, change: FileChange | null = null, ms = 400) => {
    const callId = nextId('call');
    send({ type: 'toolCall', runId, agentId, callId, tool: name, arguments: args });
    await wait(ms);
    send({ type: 'toolResult', runId, agentId, callId, ok: true, summary, change });
  };
  const until = <T,>(p: Promise<T>) => Promise.race([p, cancelled]);
  /** Like the core after a run: the orchestrator rewrites Ylide's section of AGENTS.md. */
  const writeNotes = async (notes: string) => {
    if (!settings.agent.updateProjectNotes) return;
    status('orchestrator', 'orchestrator', 'thinking', 'updating project notes', null, 54);
    await think('orchestrator', 'Noting what this run showed about the project.');
    const before = files.get('AGENTS.md');
    const block = `<!-- ylide:start -->\n## What Ylide's agents know about this project\n\n${notes}\n<!-- ylide:end -->`;
    const after =
      before === undefined
        ? `# AGENTS.md\n\nNotes for coding agents working on this project. Write your own rules for the agents outside the Ylide section; Ylide only changes the part between its markers.\n\n${block}\n`
        : before.includes('<!-- ylide:start -->')
          ? before.replace(/<!-- ylide:start -->[\s\S]*<!-- ylide:end -->/, block)
          : `${before.trimEnd()}\n\n${block}\n`;
    const callId = nextId('call');
    send({ type: 'toolCall', runId, agentId: 'orchestrator', callId, tool: 'write_file', arguments: JSON.stringify({ path: 'AGENTS.md', content: after }) });
    if (settings.agent.permissions.mode === 'ask') {
      const approvalId = nextId('approval');
      status('orchestrator', 'orchestrator', 'waitingForApproval', 'write_file AGENTS.md', null);
      send({ type: 'approvalRequested', runId, request: { id: approvalId, agentId: 'orchestrator', tool: 'write_file', risk: 'write', title: 'write_file AGENTS.md', detail: after } });
      if (!(await until(new Promise<boolean>((resolve) => pendingApprovals.set(approvalId, resolve))))) {
        send({ type: 'toolResult', runId, agentId: 'orchestrator', callId, ok: false, summary: 'The user rejected this action.', change: null });
        status('orchestrator', 'orchestrator', 'idle', '', null);
        return;
      }
    }
    const checkpointId = `${runId}-notes`;
    send({ type: 'checkpointCreated', runId, checkpoint: { id: checkpointId, runId, seq: 99, label: 'write_file AGENTS.md (orchestrator)', createdAtUnixMs: Date.now(), files: [] } });
    files.set('AGENTS.md', after);
    emit('fs://changed', ['AGENTS.md']);
    const diff = `--- a/AGENTS.md\n+++ b/AGENTS.md\n@@ -1,0 +1,${after.split('\n').length} @@\n${after.split('\n').map((l) => `+${l}`).join('\n')}\n`;
    const summary = before === undefined ? 'Created AGENTS.md' : 'Updated AGENTS.md';
    send({ type: 'toolResult', runId, agentId: 'orchestrator', callId, ok: true, summary, change: { path: 'AGENTS.md', kind: before === undefined ? 'created' : 'modified', diff, checkpointId } });
    status('orchestrator', 'orchestrator', 'idle', '', null);
  };
  /** Like the core at the end: the orchestrator's summary in the user's language, streamed to its row. */
  const writeRecap = async (texts: { de: string; en: string }) => {
    if (failures.has('norecap')) return null;
    status('orchestrator', 'orchestrator', 'thinking', 'writing the summary', null, 54);
    const recap = language.startsWith('de') ? texts.de : texts.en;
    await think('orchestrator', recap);
    status('orchestrator', 'orchestrator', 'idle', '', null);
    return recap;
  };
  /** Like the core when the user switched to Planen: the run stops before the next task. */
  const stopForPlanning = () => {
    status('coder', 'coder', 'idle', '', null);
    send({ type: 'runFinished', runId, outcome: 'cancelled', summary: 'Stopped for planning.', recap: null });
  };
  const cartNotes = '**Run and build:** `npm install`\n**Tests:** `npm test` (vitest) passes.\n**Structure:** cart logic in `src/cart.ts`, tests in `test/cart.test.ts`.\n**Decisions:** `total()` multiplies price by quantity.';

  try {
    send({ type: 'runStarted', runId, goal });
    status('orchestrator', 'orchestrator', 'thinking', 'thinking', null, 54);
    const intro = !previous
      ? 'Looking at the project layout first, then the cart logic.'
      : carried.length
        ? `This continues "${previous.goal}". ${carried.map((t) => t.id).join(', ')} carry over as they are; planning only what the new request adds.`
        : `This continues "${previous.goal}". Its changes are already in place, so only the new step needs a plan.`;
    await think('orchestrator', intro);
    await tool('orchestrator', 'list_dir', '{"path":""}', '9 entries');
    const task = (tid: string, title: string, description: string, paths: string[]) => ({ id: tid, title, description, files: paths, assignee: 'coder', status: 'pending' as const, attempts: 0, result: null, review: null });

    if (previous) {
      // "Go on" adds nothing: only the open tasks run.
      const goOn = /^\s*(mach weiter|weiter|weitermachen|continue|go on)\b/i.test(goal) && carried.length > 0;
      const last = Math.max(0, ...(previous.plan?.tasks ?? []).map((t) => Number(t.id.slice(1)) || 0));
      const title = goal.length > 60 ? `${goal.slice(0, 59)}…` : goal;
      const planned: Task[] = [...carried];
      if (!goOn) planned.push(task(carried.length ? `T${last + 1}` : 'T1', title, goal, ['src/cart.ts']));
      const first: TaskPlan = { goal, summary: carried.length ? 'Finish the open tasks, then the new request.' : 'One step on top of the previous run.', tasks: planned };
      send({ type: 'planReady', runId, plan: first });
      status('orchestrator', 'orchestrator', 'idle', 'plan ready', null);
      const tasks = first.tasks;
      const lines: string[] = [];
      for (const [i, t] of tasks.entries()) {
        if (runControl.handover) return stopForPlanning();
        const checkpointId = `${runId}-${i + 1}`;
        send({ type: 'checkpointCreated', runId, checkpoint: { id: checkpointId, runId, seq: i + 1, label: `${t.id}: ${t.title} (coder)`, createdAtUnixMs: Date.now(), files: [] } });
        send({ type: 'taskUpdated', runId, task: { ...t, status: 'inProgress' } });
        status('coder', 'coder', 'thinking', 'thinking', t.id, 62);
        await think('coder', carried.includes(t) ? `Picking up ${t.id} where the last run stopped.` : 'Reading the cart module before the next change.');
        await tool('coder', 'read_file', '{"path":"src/cart.ts"}', 'src/cart.ts (1-14 of 14)');
        const doc = '/** Sum of price × quantity over all items. */\n';
        const source = files.get('src/cart.ts')!;
        if (!source.includes(doc)) {
          files.set('src/cart.ts', source.replace('export function total(', `${doc}export function total(`));
          emit('fs://changed', ['src/cart.ts']);
          await tool('coder', 'edit_file', '{"path":"src/cart.ts"}', 'Edited src/cart.ts (+1 -0)', {
            path: 'src/cart.ts',
            kind: 'modified',
            checkpointId,
            diff: `--- a/src/cart.ts\n+++ b/src/cart.ts\n@@ -6,2 +6,3 @@\n \n+${doc}export function total(items: Item[]): number {\n`,
          });
        }
        const result = carried.includes(t) ? `${t.title}: done now.` : 'Done on top of the previous run; total() is documented.';
        send({ type: 'taskUpdated', runId, task: { ...t, status: 'inReview', result } });
        status('coder', 'coder', 'done', 'finished', t.id);
        status('reviewer', 'reviewer', 'thinking', 'reviewing diff', t.id, 58);
        await think('reviewer', 'Small change, consistent with the earlier work.');
        send({ type: 'taskUpdated', runId, task: { ...t, status: 'done', result, review: { verdict: 'approve', summary: 'Good.', comments: [] } } });
        status('reviewer', 'reviewer', 'idle', '', t.id);
        lines.push(`✔ ${t.id} ${t.title}\n   ${result}`);
      }
      await writeNotes(`${cartNotes}\n**Docs:** \`total()\` has a doc comment.`);
      const notes = settings.agent.updateProjectNotes && files.has('AGENTS.md') ? ', AGENTS.md' : '';
      const done = tasks.map((t) => `\`${t.id}\` ${t.title}`).join(', ');
      const changed = `\`src/cart.ts\`${notes ? ', `AGENTS.md`' : ''}`;
      const recap = await writeRecap({
        de: `- **Erledigt:** ${done}. Das baut auf dem letzten Lauf auf, der die Summe im Warenkorb schon korrigiert hat.\n- **Geänderte Dateien:** ${changed}.\n- **Zum Prüfen:** Führe \`npm test\` aus und sieh dir \`total()\` in \`src/cart.ts\` an.\n- **Offen:** nichts.`,
        en: `- **Done:** ${done}. This builds on the last run, which already fixed the cart total.\n- **Changed files:** ${changed}.\n- **To check:** run \`npm test\` and look at \`total()\` in \`src/cart.ts\`.\n- **Open:** nothing.`,
      });
      send({ type: 'runFinished', runId, outcome: 'completed', summary: `${lines.join('\n')}\n\nChanged files: src/cart.ts${notes}`, recap });
      return;
    }
    if (failures.has('clarify') && settings.questions !== 'never') {
      const de = language.startsWith('de');
      const questions: Question[] = de
        ? [
            { question: 'Soll total() auch Rabattcodes berücksichtigen?', options: [{ label: 'Nein, nur Preis × Menge', recommended: true }, { label: 'Ja, mit Rabattcodes', recommended: false }], multiple: false },
            { question: 'Welche Tests sollen dazukommen?', options: [{ label: 'Leerer Warenkorb', recommended: false }, { label: 'Menge größer 1', recommended: false }, { label: 'Negative Preise', recommended: false }], multiple: true },
          ]
        : [
            { question: 'Should total() also apply discount codes?', options: [{ label: 'No, only price × quantity', recommended: true }, { label: 'Yes, with discount codes', recommended: false }], multiple: false },
            { question: 'Which tests should be added?', options: [{ label: 'Empty cart', recommended: false }, { label: 'Quantity above 1', recommended: false }, { label: 'Negative prices', recommended: false }], multiple: true },
          ];
      const text = questions.map((q, i) => `${i + 1}. ${q.question}\nOptions: ${q.options.map((o) => (o.recommended ? `${o.label} (recommended)` : o.label)).join(' / ')}`).join('\n');
      status('orchestrator', 'orchestrator', 'waitingForAnswer', 'asking the user', null);
      send({ type: 'message', runId, message: { id: nextId('msg'), from: 'orchestrator', to: 'user', kind: 'question', content: text, taskId: null } });
      const questionId = nextId('question');
      send({ type: 'questionForUser', runId, questionId, agentId: 'orchestrator', question: text, questions, clarify: true });
      const answers = await until(new Promise<string[]>((resolve) => pendingAnswers.set(questionId, resolve)));
      const reply = answers.every((a) => !a.trim()) ? 'The user skipped the questions.' : questions.map((q, i) => `${i + 1}. ${q.question}\nAnswer: ${answers[i]?.trim() || '(no answer)'}`).join('\n\n');
      send({ type: 'message', runId, message: { id: nextId('msg'), from: 'user', to: 'orchestrator', kind: 'answer', content: reply, taskId: null } });
      status('orchestrator', 'orchestrator', 'thinking', 'thinking', null, 54);
      await think('orchestrator', 'Planning with your answers.');
    }
    const first: TaskPlan = {
      goal,
      summary: 'Fix the total so it multiplies price by quantity, then make sure the tests cover it.',
      tasks: [
        task('T1', 'Fix total()', 'Multiply price by quantity in src/cart.ts. Verify with npm test.', ['src/cart.ts']),
        task('T2', 'Add a test for empty carts', 'Add a test that total([]) is 0.', ['test/cart.test.ts']),
      ],
    };
    send({ type: 'planReady', runId, plan: first });
    status('orchestrator', 'orchestrator', 'idle', 'plan ready', null);
    const plan = first;
    send({ type: 'checkpointCreated', runId, checkpoint: { id: `${runId}-1`, runId, seq: 1, label: 'T1: Fix total() (coder)', createdAtUnixMs: Date.now(), files: [] } });
    send({ type: 'taskUpdated', runId, task: { ...plan.tasks[0], status: 'inProgress' } });
    status('coder', 'coder', 'thinking', 'thinking', 'T1', 61);
    await think('coder', 'Reading the cart module to see how total() is computed.');
    status('coder', 'coder', 'callingTool', 'read_file src/cart.ts', 'T1', 61);
    await tool('coder', 'read_file', '{"path":"src/cart.ts"}', 'src/cart.ts (1-14 of 14)');

    if (failures.has('question')) {
      const questionId = nextId('question');
      status('coder', 'coder', 'waitingForAnswer', 'waiting for your answer', 'T1');
      const question = 'Should prices stay in cents (integers), or may total() return fractional euros?';
      const options = [
        { label: 'Keep integer cents', recommended: true },
        { label: 'Fractional euros', recommended: false },
      ];
      send({ type: 'message', runId, message: { id: nextId('msg'), from: 'coder', to: 'user', kind: 'question', content: `${question}\nOptions: Keep integer cents (recommended) / Fractional euros`, taskId: 'T1' } });
      send({ type: 'questionForUser', runId, questionId, agentId: 'coder', question, questions: [{ question, options, multiple: false }], clarify: false });
      const answer = (await until(new Promise<string[]>((resolve) => pendingAnswers.set(questionId, resolve))))[0]?.trim() || '(no answer)';
      send({ type: 'message', runId, message: { id: nextId('msg'), from: 'user', to: 'coder', kind: 'answer', content: answer, taskId: 'T1' } });
      status('coder', 'coder', 'thinking', 'thinking', 'T1', 61);
      await think('coder', 'Understood, keeping integer cents.');
    }

    const before = files.get('src/cart.ts')!;
    files.set('src/cart.ts', before.replace('sum + item.price, 0', 'sum + item.price * item.quantity, 0'));
    emit('fs://changed', ['src/cart.ts']);
    await tool('coder', 'edit_file', '{"path":"src/cart.ts"}', 'Edited src/cart.ts (+1 -1)', {
      path: 'src/cart.ts',
      kind: 'modified',
      checkpointId: `${runId}-1`,
      diff: '--- a/src/cart.ts\n+++ b/src/cart.ts\n@@ -6,5 +6,5 @@\n \n export function total(items: Item[]): number {\n-  return items.reduce((sum, item) => sum + item.price, 0);\n+  return items.reduce((sum, item) => sum + item.price * item.quantity, 0);\n }\n',
    });
    await wait(300);
    const approvalId = nextId('approval');
    const commandCall = nextId('call');
    send({ type: 'toolCall', runId, agentId: 'coder', callId: commandCall, tool: 'run_command', arguments: '{"command":"npm test"}' });
    status('coder', 'coder', 'waitingForApproval', 'run `npm test`', 'T1');
    send({ type: 'approvalRequested', runId, request: { id: approvalId, agentId: 'coder', tool: 'run_command', risk: 'execute', title: 'run `npm test`', detail: 'npm test' } });
    const approved = await until(new Promise<boolean>((resolve) => pendingApprovals.set(approvalId, resolve)));
    if (approved) {
      status('coder', 'coder', 'callingTool', 'run `npm test`', 'T1', 61);
      await wait(1100);
      send({ type: 'toolResult', runId, agentId: 'coder', callId: commandCall, ok: true, summary: '`npm test` exited with 0 after 1.1s', change: null });
    } else {
      send({ type: 'toolResult', runId, agentId: 'coder', callId: commandCall, ok: false, summary: 'The user rejected this action.', change: null });
    }
    const t1Result = approved ? 'total() now multiplies price by quantity; npm test passes.' : 'total() now multiplies price by quantity (tests not run).';
    send({ type: 'taskUpdated', runId, task: { ...plan.tasks[0], status: 'inReview', result: t1Result } });
    status('coder', 'coder', 'done', 'finished', 'T1');
    status('reviewer', 'reviewer', 'thinking', 'reviewing diff', 'T1', 58);
    await think('reviewer', 'Checking the diff against the task and the existing test.');
    await tool('reviewer', 'read_file', '{"path":"src/cart.ts"}', 'src/cart.ts (1-14 of 14)');

    if (failures.has('changes')) {
      const review = {
        verdict: 'request_changes' as const,
        summary: 'The fix is right, but addItem() should not accept a quantity below 1.',
        comments: [
          { file: 'src/cart.ts', line: 11, severity: 'major' as const, message: 'Reject items with quantity < 1, otherwise total() can go negative.' },
          { file: 'src/cart.ts', line: 7, severity: 'nit' as const, message: 'A short doc comment on total() would help.' },
        ],
      };
      send({ type: 'taskUpdated', runId, task: { ...plan.tasks[0], status: 'inProgress', attempts: 1, result: t1Result, review } });
      send({ type: 'message', runId, message: { id: nextId('msg'), from: 'reviewer', to: 'coder', kind: 'feedback', content: review.summary, taskId: 'T1' } });
      status('reviewer', 'reviewer', 'idle', '', 'T1');
      status('coder', 'coder', 'thinking', 'addressing review', 'T1', 60);
      await think('coder', 'Adding a guard for quantities below one.');
      const guard = "  if (item.quantity < 1) throw new Error('quantity must be at least 1');\n";
      files.set('src/cart.ts', files.get('src/cart.ts')!.replace('export function addItem(items: Item[], item: Item): Item[] {\n', `export function addItem(items: Item[], item: Item): Item[] {\n${guard}`));
      emit('fs://changed', ['src/cart.ts']);
      await tool('coder', 'edit_file', '{"path":"src/cart.ts"}', 'Edited src/cart.ts (+1 -0)', {
        path: 'src/cart.ts',
        kind: 'modified',
        checkpointId: `${runId}-1`,
        diff: `--- a/src/cart.ts\n+++ b/src/cart.ts\n@@ -11,3 +11,4 @@\n export function addItem(items: Item[], item: Item): Item[] {\n+${guard} return [...items, item];\n }\n`,
      });
      send({ type: 'taskUpdated', runId, task: { ...plan.tasks[0], status: 'inReview', attempts: 1, result: `${t1Result} addItem() rejects quantities below 1.`, review } });
      status('coder', 'coder', 'done', 'finished', 'T1');
      status('reviewer', 'reviewer', 'thinking', 'reviewing diff', 'T1', 58);
      await wait(900);
    }

    const attempts = failures.has('changes') ? 1 : 0;
    send({ type: 'taskUpdated', runId, task: { ...plan.tasks[0], status: 'done', attempts, result: t1Result, review: { verdict: 'approve', summary: 'Correct and covered by the existing test.', comments: [] } } });
    status('reviewer', 'reviewer', 'idle', '', 'T1');
    if (runControl.handover) return stopForPlanning();
    send({ type: 'checkpointCreated', runId, checkpoint: { id: `${runId}-2`, runId, seq: 2, label: 'T2: Add a test for empty carts (coder)', createdAtUnixMs: Date.now(), files: [] } });
    send({ type: 'taskUpdated', runId, task: { ...plan.tasks[1], status: 'inProgress' } });
    status('coder', 'coder', 'thinking', 'thinking', 'T2', 63);
    await think('coder', 'An empty cart should total zero; adding that case to the existing test file.');
    files.set('test/cart.test.ts', files.get('test/cart.test.ts')! + "\nit('is zero for an empty cart', () => {\n  expect(total([])).toBe(0);\n});\n");
    emit('fs://changed', ['test/cart.test.ts']);
    await tool('coder', 'edit_file', '{"path":"test/cart.test.ts"}', 'Edited test/cart.test.ts (+4 -0)', {
      path: 'test/cart.test.ts',
      kind: 'modified',
      checkpointId: `${runId}-2`,
      diff: "--- a/test/cart.test.ts\n+++ b/test/cart.test.ts\n@@ -6,1 +6,5 @@\n });\n+\n+it('is zero for an empty cart', () => {\n+  expect(total([])).toBe(0);\n+});\n",
    });
    send({ type: 'taskUpdated', runId, task: { ...plan.tasks[1], status: 'inReview', result: 'Added an empty-cart test.' } });
    status('coder', 'coder', 'done', 'finished', 'T2');
    status('reviewer', 'reviewer', 'thinking', 'reviewing diff', 'T2', 57);
    await wait(1000);
    send({ type: 'taskUpdated', runId, task: { ...plan.tasks[1], status: 'done', result: 'Added an empty-cart test.', review: { verdict: 'approve', summary: 'Good.', comments: [] } } });
    status('reviewer', 'reviewer', 'idle', '', 'T2');
    await writeNotes(cartNotes);
    const notes = settings.agent.updateProjectNotes && files.has('AGENTS.md') ? ', AGENTS.md' : '';
    const changed = `\`src/cart.ts\`, \`test/cart.test.ts\`${notes ? ', `AGENTS.md`' : ''}`;
    const recap = await writeRecap({
      de: `- **Erledigt:** \`total()\` in \`src/cart.ts\` multipliziert jetzt den Preis mit der Menge. Vorher wurde die Menge ignoriert, darum war die Summe zu klein.\n- **Test:** \`test/cart.test.ts\` prüft zusätzlich, dass ein leerer Warenkorb 0 ergibt.\n- **Geänderte Dateien:** ${changed}.\n- **Zum Prüfen:** ${approved ? '`npm test` lief erfolgreich; führe es gern selbst aus.' : '`npm test` lief nicht, weil du den Befehl abgelehnt hast. Führe ihn selbst aus.'}\n- **Offen:** nichts.`,
      en: `- **Done:** \`total()\` in \`src/cart.ts\` now multiplies the price by the quantity. Before, the quantity was ignored, so the total was too small.\n- **Test:** \`test/cart.test.ts\` also checks that an empty cart totals 0.\n- **Changed files:** ${changed}.\n- **To check:** ${approved ? '`npm test` passed; feel free to run it yourself.' : '`npm test` did not run because you rejected the command. Run it yourself.'}\n- **Open:** nothing.`,
    });
    send({ type: 'runFinished', runId, outcome: 'completed', summary: `✔ T1 Fix total()\n✔ T2 Add a test for empty carts\n\nChanged files: src/cart.ts, test/cart.test.ts${notes}`, recap });
  } catch {
    send({ type: 'runFinished', runId, outcome: 'cancelled', summary: 'Stopped by the user.', recap: null });
  } finally {
    pendingApprovals.clear();
    pendingAnswers.clear();
    runSend = null;
  }
}

/** Reports every busy agent as paused (or back to its state), like the core at a step boundary. */
function reportPause(paused: boolean) {
  for (const st of lastStatus.values()) {
    if (st.state === 'idle' || st.state === 'done' || st.state === 'failed') continue;
    runSend?.({ type: 'status', runId, status: paused ? { ...st, state: 'paused', tokensPerSecond: 0 } : st });
  }
}

// ------------------------------------------------------------------ command dispatch

export async function mockInvoke<T>(command: string, args: Record<string, any>): Promise<T> {
  await sleep(command.startsWith('fs_') ? 20 : 60);
  const r = (v: unknown) => v as T;
  if (command.startsWith('plan_') || command === 'agent_handover') {
    const env = {
      modelReady: server?.status.state === 'ready',
      files,
      changed: (paths: string[]) => emit('fs://changed', paths),
      setHandover: (on: boolean) => void (runControl.handover = on),
      record: (run: LastRun) => {
        runRecords.set(run.runId, run);
        lastRun = run;
      },
      previous: (id: string) => runRecords.get(id) ?? (lastRun?.runId === id ? lastRun : null),
    };
    return r(await planningCommand(command, args, env));
  }
  if (command.startsWith('skills_')) {
    return r(await skillsCommand(command, args, { failures, downloadsAllowed: settings.network.allowSkillDownloads, projectOpen: settings.onboardingDone, log: logNet }));
  }
  switch (command) {
    case 'app_info':
      return r({ version: '0.1.0', os: 'windows', arch: 'x86_64', configDir: 'C:/Users/me/AppData/Roaming/app.ylide', dataDir: 'C:/Users/me/AppData/Local/app.ylide', modelsDir: 'C:/Users/me/AppData/Local/app.ylide/models', logFile: 'C:/Users/me/AppData/Local/app.ylide/logs/ylide.log' });
    case 'settings_get':
      return r(structuredClone(settings));
    case 'settings_defaults':
      return r(structuredClone(defaultSettings));
    case 'settings_set':
      settings = structuredClone(args.settings);
      return r(structuredClone(settings));
    case 'network_log':
      return r([...netLog]);
    case 'hardware_probe':
      await sleep(600);
      return r(hardware);
    case 'hardware_tips':
      // `?mock=fastram` stands for RAM that already runs at its rated speed.
      return r(failures.has('fastram') ? { ramSpeed: null, memoryModules: [] } : hardwareTips);
    case 'registry_info':
      return r({ registry, origin: 'bundled' });
    case 'registry_refresh':
      logNet('registry', settings.network.registryUrl, '304');
      return r({ result: 'upToDate' });
    case 'update_check':
      // `?mock=update` offers a newer version.
      if (!settings.network.allowUpdateChecks) return r({ result: 'disabled' });
      await sleep(400);
      logNet('updateCheck', 'https://ylide.app/updates/latest.json', '200');
      return r(failures.has('update') ? { result: 'available', version: '0.2.0', notes: 'Faster agents and a new model list.', date: '2026-11-02T10:00:00Z' } : { result: 'upToDate' });
    case 'update_launch':
      return r(undefined);
    case 'update_download': {
      if (!failures.has('update')) throw { code: 'update_none', message: 'no update to install; check for updates first' };
      const send = args.onProgress as (p: { downloaded: number; total: number | null }) => void;
      const total = 84_000_000;
      for (let i = 1; i <= 20; i++) {
        await sleep(120);
        send({ downloaded: (total * i) / 20, total });
      }
      logNet('updateDownload', 'https://ylide.app/updates/Ylide_0.2.0_x64-setup.exe', 'completed, signature verified');
      return r(undefined);
    }
    case 'recommend':
      await sleep(300);
      return r(recommendation);
    case 'models_installed':
      return r([...installed]);
    case 'downloads':
      return r([...jobs.values()].map(({ timer: _t, ...j }) => j));
    case 'model_download': {
      const id = `${args.modelId}@${args.quant}`;
      const model = registry.models.find((m) => m.id === args.modelId)!;
      const total = fileSize(args.modelId, args.quant);
      const existing = jobs.get(id);
      // Like the core: a running job is returned as it is.
      if (existing?.state.state === 'running') {
        const { timer: _t, ...snapshot } = existing;
        return r(snapshot);
      }
      if (failures.has('offline')) throw { code: 'network_disabled', message: 'model downloads are switched off' };
      if (failures.has('diskfull')) throw { code: 'disk_full', message: `${(total / 1e9).toFixed(1)} GB needed, 0.8 GB free` };
      const job: DownloadJob & { timer?: number } = existing ?? { jobId: id, modelId: args.modelId, quant: args.quant, name: `${model.name} ${args.quant}`, projector: false, state: { state: 'running' }, progress: null, totalBytes: total };
      job.state = { state: 'running' };
      jobs.set(id, job);
      logNet('modelDownload', `https://huggingface.co/${model.source.hfRepo}/resolve/${model.source.revision}/${model.variants.find((v) => v.quant === args.quant)!.files[0].path}`, 'requested');
      let done = job.progress?.downloadedBytes ?? 0;
      // About 20 seconds per model, at the speed it reports, so the progress can be looked at.
      const speed = total / 20;
      job.timer = window.setInterval(() => {
        done = Math.min(total, done + speed * 0.12);
        if (failures.has('jobfail') && done >= total / 2) {
          window.clearInterval(job.timer);
          job.state = { state: 'failed', message: 'checksum mismatch: the file was changed on the server' };
          const { timer: _t, ...snapshot } = job;
          emit('models://job', snapshot);
          return;
        }
        job.progress = { jobId: id, phase: done >= total ? 'done' : 'downloading', fileIndex: 0, fileCount: 1, downloadedBytes: done, totalBytes: total, bytesPerSecond: speed };
        if (done >= total) {
          window.clearInterval(job.timer);
          job.state = { state: 'completed' };
          // Like the core: image input is per model, a new variant loads the projector too.
          const projector = installed.find((m) => m.modelId === args.modelId && m.projector)?.projector ?? null;
          installed = installed.filter((m) => !(m.modelId === args.modelId && m.quant === args.quant));
          installed.push({ modelId: args.modelId, quant: args.quant, name: model.name, files: [{ path: `D:/models/${args.quant}.gguf`, sizeBytes: total, sha256: null }], installedAtUnixMs: Date.now(), custom: false, projector });
        }
        const { timer: _t, ...snapshot } = job;
        emit('models://job', snapshot);
      }, 120);
      const { timer: _t, ...snapshot } = job;
      return r(snapshot);
    }
    case 'model_pause': {
      const job = jobs.get(args.jobId);
      if (job) {
        window.clearInterval(job.timer);
        job.state = { state: 'paused' };
        const { timer: _t, ...s } = job;
        emit('models://job', s);
      }
      return r(undefined);
    }
    case 'model_cancel': {
      const job = jobs.get(args.jobId);
      if (job) {
        window.clearInterval(job.timer);
        job.state = { state: 'cancelled' };
        const { timer: _t, ...s } = job;
        emit('models://job', s);
        jobs.delete(args.jobId);
      }
      return r(undefined);
    }
    case 'model_delete':
      installed = installed.filter((m) => !(m.modelId === args.modelId && m.quant === args.quant));
      return r(undefined);
    case 'model_import': {
      await sleep(500);
      if (failures.has('notgguf')) throw { code: 'not_gguf', message: args.path };
      // Like the core for a file that matches no registry variant.
      const stem = String(args.path).split(/[\\/]/).pop()!.replace(/\.gguf$/i, '');
      const model: InstalledModel = { modelId: `custom:${stem}`, quant: 'custom', name: stem, files: [{ path: args.path, sizeBytes: 4_920_734_016, sha256: null }], installedAtUnixMs: Date.now(), custom: true, projector: null };
      installed = [...installed.filter((m) => !(m.modelId === model.modelId && m.quant === model.quant)), model];
      return r(model);
    }
    case 'model_projector_download': {
      // Like a variant download, a little faster; when done, every variant of the model loads it.
      const id = `${args.modelId}@mmproj`;
      const model = registry.models.find((m) => m.id === args.modelId);
      const file = projectorFile(args.modelId);
      if (!model?.projector || !file) throw { code: 'no_projector', message: args.modelId };
      if (failures.has('offline')) throw { code: 'network_disabled', message: 'model downloads are switched off' };
      const total = file.sizeBytes;
      const job: DownloadJob & { timer?: number } = jobs.get(id) ?? { jobId: id, modelId: args.modelId, quant: 'mmproj', name: `${model.name} mmproj`, projector: true, state: { state: 'running' }, progress: null, totalBytes: total };
      job.state = { state: 'running' };
      jobs.set(id, job);
      logNet('modelDownload', `https://huggingface.co/${model.source.hfRepo}/resolve/${model.source.revision}/${model.projector.path}`, 'requested');
      let done = job.progress?.downloadedBytes ?? 0;
      const speed = total / 6;
      job.timer = window.setInterval(() => {
        done = Math.min(total, done + speed * 0.12);
        job.progress = { jobId: id, phase: done >= total ? 'done' : 'downloading', fileIndex: 0, fileCount: 1, downloadedBytes: done, totalBytes: total, bytesPerSecond: speed };
        if (done >= total) {
          window.clearInterval(job.timer);
          job.state = { state: 'completed' };
          installed = installed.map((m) => (m.modelId === args.modelId ? { ...m, projector: file } : m));
        }
        const { timer: _t, ...snapshot } = job;
        emit('models://job', snapshot);
      }, 120);
      const { timer: _t, ...snapshot } = job;
      return r(snapshot);
    }
    case 'model_projector_set': {
      await sleep(200);
      const projector = args.path ? { path: String(args.path), sizeBytes: 899_283_680, sha256: null } : null;
      installed = installed.map((m) => (m.modelId === args.modelId ? { ...m, projector } : m));
      return r([...installed]);
    }
    case 'image_load':
      await sleep(150);
      return r(demoScreenshot());
    case 'runtime_status':
      return r(runtime());
    case 'runtime_install': {
      if (failures.has('offline')) throw { code: 'network_disabled', message: 'runtime downloads are switched off' };
      if (failures.has('diskfull')) throw { code: 'disk_full', message: '0.6 GB needed, 0.2 GB free' };
      const steps = 20;
      for (let i = 1; i <= steps; i++) {
        setTimeout(() => {
          const progress = { jobId: 'runtime', phase: 'downloading', fileIndex: 0, fileCount: 2, downloadedBytes: (578_100_000 * i) / steps, totalBytes: 578_100_000, bytesPerSecond: 95_000_000 };
          emit('runtime://install', { variant: args.variant, state: i < steps ? { state: 'downloading', progress } : { state: 'done' } });
          if (i === steps) cudaInstalled = true;
        }, i * 150);
      }
      logNet('runtimeDownload', `https://github.com/ggml-org/llama.cpp/releases/download/b11669/llama-b11669-bin-win-${args.variant}-x64.zip`, 'requested');
      return r(undefined);
    }
    case 'server_start': {
      const sel = args.selection ?? settings.models.chat;
      const model = registry.models.find((m) => m.id === sel?.modelId);
      const projector = installed.find((m) => m.modelId === sel?.modelId && m.quant === sel?.quant)?.projector ?? null;
      const command = ['llama-server.exe', '-m', 'model.gguf', '-c', '131072', '-np', '2', '-kvu', '-fa', 'on', '--fit', 'on', ...(projector ? ['--mmproj', projector.path, '--image-max-tokens', '2048'] : [])];
      const base: ServerInfo = { modelId: sel?.modelId ?? 'x', quant: sel?.quant ?? '', modelName: model?.name ?? 'Model', runtime: runtime().selected ?? 'vulkan', device: cudaInstalled ? 'CUDA0' : 'Vulkan0', context: 131072, slots: 2, status: { state: 'starting' }, toolCalls: 'unknown', vision: projector ? 'on' : 'off', command, tuned: !!calibration && !failures.has('calstale') };
      server = base;
      emit('runtime://server', server);
      await sleep(700);
      server = { ...base, status: { state: 'loading' } };
      emit('runtime://server', server);
      await sleep(1400);
      if (failures.has('crash')) {
        server = { ...base, status: { state: 'crashed', code: 3, message: 'llama_model_load: error loading model: out of memory' } };
        emit('runtime://server', server);
        emit('runtime://log', 'llama_model_load: error loading model: out of memory');
        throw { code: 'server', message: 'llama-server exited with code 3 while loading (out of memory)' };
      }
      server = { ...base, status: { state: 'ready' } };
      emit('runtime://server', server);
      setTimeout(() => {
        if (server) {
          server = { ...server, toolCalls: 'native' };
          emit('runtime://server', server);
        }
      }, 1500);
      return r(server);
    }
    case 'server_stop':
      server = null;
      emit('runtime://server', null);
      return r(undefined);
    case 'calibration_get':
      return r({ result: calibration, changes: calibration && failures.has('calstale') ? ['ram'] : [], running: calibrating });
    case 'calibration_run':
      if (!server || server.status.state !== 'ready') throw { code: 'calibration_not_running', message: 'start the model first' };
      if (calibrating) throw { code: 'calibration_running', message: 'a calibration is already running' };
      calibrating = true;
      calibrationCancelled = false;
      void runMockCalibration();
      return r(undefined);
    case 'calibration_cancel':
      calibrationCancelled = true;
      return r(undefined);
    case 'calibration_reset':
      calibration = null;
      if (server) {
        server = { ...server, tuned: false };
        emit('runtime://server', server);
      }
      return r(undefined);
    case 'server_info':
      return r(server);
    case 'server_logs':
      return r(['main: build = 11669 (0.7.0)', 'load_tensors: offloaded 41/41 layers to GPU', 'srv  init: 2 slots, n_ctx = 131072 (unified)', 'main: server is listening on http://127.0.0.1:52811']);
    case 'workspace_open':
      return r({ root: args.path, name: String(args.path).split(/[\\/]/).pop() });
    case 'workspace_current':
      return r(settings.onboardingDone ? { root: 'D:/projects/demo-shop', name: 'demo-shop' } : null);
    case 'workspace_close':
      return r(undefined);
    case 'fs_list_dir':
      return r(listDir(args.path));
    case 'fs_read_file': {
      const content = files.get(args.path);
      if (content === undefined) throw { code: 'workspace', message: `'${args.path}' does not exist` };
      return r({ path: args.path, content, lineEnding: 'lf', hasBom: false, sizeBytes: content.length });
    }
    case 'fs_write_file':
      files.set(args.path, args.content);
      changed([args.path]);
      return r(undefined);
    case 'fs_create':
      if (!args.directory) files.set(args.path, '');
      else files.set(`${args.path}/.keep`, '');
      changed([args.path]);
      return r(undefined);
    case 'fs_rename': {
      // Files and, for folders, everything inside them.
      for (const [k, c] of [...files]) {
        if (k !== args.from && !k.startsWith(`${args.from}/`)) continue;
        files.delete(k);
        files.set(args.to + k.slice(args.from.length), c);
      }
      changed([args.from, args.to]);
      return r(undefined);
    }
    case 'fs_delete':
      for (const k of [...files.keys()]) if (k === args.path || k.startsWith(`${args.path}/`)) files.delete(k);
      changed([args.path]);
      return r(undefined);
    case 'fs_find_files': {
      const q = String(args.query).toLowerCase();
      return r([...files.keys()].filter((p) => p.toLowerCase().includes(q)).slice(0, args.limit));
    }
    case 'fs_exists': {
      const wanted = (args.paths as string[]).map((p) => p.trim().replace(/\\/g, '/').replace(/^\.\//, ''));
      return r([...new Set(wanted.filter((p) => files.has(p)))]);
    }
        case 'fs_find_symbols': {
      const q = String(args.query).toLowerCase();
      const syms = [
        { name: 'total', kind: 'function', path: 'src/cart.ts', line: 7 },
        { name: 'addItem', kind: 'function', path: 'src/cart.ts', line: 11 },
        { name: 'Item', kind: 'interface', path: 'src/cart.ts', line: 1 },
        { name: 'formatPrice', kind: 'function', path: 'src/format.ts', line: 1 },
      ];
      return r(syms.filter((s) => s.name.toLowerCase().includes(q)));
    }
    case 'fs_search': {
      const q = String(args.query.pattern).toLowerCase();
      const out = [];
      let totalMatches = 0;
      for (const [path, content] of files) {
        const matches = content.split('\n').flatMap((line, i) => {
          const at = line.toLowerCase().indexOf(q);
          return q && at >= 0 ? [{ lineNumber: i + 1, line, ranges: [[at, at + q.length] as [number, number]] }] : [];
        });
        if (matches.length) {
          totalMatches += matches.length;
          out.push({ path, matches });
        }
      }
      return r({ files: out, totalMatches, truncated: false });
    }
    case 'context_preview':
      return r(contextItems(args.mentions));
    case 'chat_send': {
      const req = args.request;
      const send = args.onEvent as (e: ChatEvent) => void;
      if (!server) throw { code: 'no_model', message: 'start a model first' };
      const messages = req.messages as Array<{ role: string; content: string; images?: string[] }>;
      const images = messages[messages.length - 1]?.images ?? [];
      if (images.length && server.vision !== 'on') throw { code: 'no_vision', message: 'the model that is running cannot see images' };
      const userTexts = messages.filter((m) => m.role === 'user').map((m) => m.content);
      send({ type: 'context', items: [...contextItems(req.mentions), ...mentionedSkillItems(userTexts)] });
      await sleep(250);
      const isCancelled = () => cancelledRequests.has(req.id);
      let reasoning = '';
      let content = '';
      const askBack = failures.has('chatask') && messages.length === 1 && !images.length;
      let ok = await streamText(askBack ? 'The request does not say what should be faster.' : images.length ? chatImageReasoning : chatReasoning, (text) => {
        reasoning += text;
        send({ type: 'delta', delta: { kind: 'reasoning', text } });
      }, isCancelled, 10);
      if (ok) {
        ok = await streamText(askBack ? chatQuestion : images.length ? chatImageAnswer(images.length) : chatAnswer, (text) => {
          content += text;
          send({ type: 'delta', delta: { kind: 'content', text } });
        }, isCancelled);
      }
      const completionTokens = Math.ceil((reasoning.length + content.length) / 3.6);
      send({ type: 'done', result: { message: { role: 'assistant', content, reasoning_content: reasoning || null, tool_calls: [], tool_call_id: null } as never, finishReason: ok ? 'stop' : 'cancelled', usage: { promptTokens: 1840, completionTokens, cachedTokens: 1200 }, timings: { promptTokensPerSecond: 3100, generationTokensPerSecond: 57.3, promptMs: 210, generationMs: Math.round((completionTokens / 57.3) * 1000) } } });
      cancelledRequests.delete(req.id);
      return r(undefined);
    }
    case 'chats_list':
      return r(settings.chat.saveHistory ? [...savedChats.values()].map((c) => c.summary).sort((a, b) => b.updatedAtUnixMs - a.updatedAtUnixMs) : []);
    case 'chat_load': {
      const c = savedChats.get(args.id);
      if (!c) throw { code: 'chat_missing', message: `no saved chat ${args.id}` };
      return r(structuredClone(c));
    }
    case 'chat_save':
      if (!settings.chat.saveHistory) return r(null);
      savedChats.set(args.chat.summary.id, structuredClone(args.chat));
      return r(args.chat.summary);
    case 'chat_delete':
      savedChats.delete(args.id);
      return r(undefined);
    case 'chats_delete_all':
      savedChats.clear();
      return r(undefined);
    case 'request_cancel':
      cancelledRequests.add(args.id);
      return r(undefined);
    case 'inline_edit': {
      const req = args.request;
      const send = args.onEvent as (e: InlineEvent) => void;
      if (!server) throw { code: 'no_model', message: 'start a model first' };
      const lines = String(req.content).split('\n').slice(req.startLine - 1, req.endLine);
      const indent = lines[0]?.match(/^\s*/)?.[0] ?? '';
      const replacement = [`${indent}// ${req.instruction}`, ...lines].join('\n').replace('item.price, 0', 'item.price * item.quantity, 0');
      await streamText(replacement, (text) => send({ type: 'delta', text }), () => cancelledRequests.has(req.id), 12);
      send({ type: 'done', replacement });
      return r(undefined);
    }
    case 'agent_start': {
      if (!server) throw { code: 'no_model', message: 'start a model first' };
      if ((args.images ?? []).length && server.vision !== 'on') throw { code: 'no_vision', message: 'the model that is running cannot see images' };
      const wanted = args.previousRun ? String(args.previousRun) : null;
      // In memory, or the stored last run after a restart.
      const previous = wanted ? (runRecords.get(wanted) ?? (lastRun?.runId === wanted ? lastRun : undefined)) : null;
      if (previous === undefined) throw { code: 'unknown_run', message: wanted };
      const id = `run-${Date.now()}`;
      runControl = { paused: false, cancelled: false, handover: false, abort: () => undefined };
      void simulateRun(id, args.goal, args.onEvent as (e: AgentEvent) => void, previous, String(args.language ?? 'en'));
      return r(id);
    }
    case 'agent_last_run':
      return r(lastRun);
    case 'agent_approve': {
      const resolve = pendingApprovals.get(args.requestId);
      pendingApprovals.delete(args.requestId);
      resolve?.(args.response.decision !== 'reject');
      return r(resolve !== undefined);
    }
    case 'agent_answer': {
      if ((args.images ?? []).length && server?.vision !== 'on') throw { code: 'no_vision', message: 'the model that is running cannot see images' };
      const resolve = pendingAnswers.get(args.questionId);
      pendingAnswers.delete(args.questionId);
      resolve?.(args.answers ?? [args.answer]);
      return r(resolve !== undefined);
    }
    case 'agent_control':
      if (planningControl(String(args.runId), String(args.action))) return r(undefined);
      if (args.action === 'pause' && !runControl.paused) {
        runControl.paused = true;
        setTimeout(() => reportPause(true), 300);
      }
      if (args.action === 'resume' && runControl.paused) {
        runControl.paused = false;
        reportPause(false);
      }
      if (args.action === 'cancel') {
        runControl.cancelled = true;
        runControl.abort();
      }
      return r(undefined);
    case 'agent_intervene': {
      if ((args.images ?? []).length && server?.vision !== 'on') throw { code: 'no_vision', message: 'the model that is running cannot see images' };
      // The core posts the message when the agent picks it up at its next step.
      const send = runSend;
      const to = String(args.agentId);
      setTimeout(() => send?.({ type: 'message', runId, message: { id: `msg-${Date.now()}`, from: 'user', to, kind: 'intervention', content: args.text, taskId: null } }), 600);
      return r(undefined);
    }
    case 'checkpoints_list':
      return r([]);
    case 'checkpoint_restore':
      return r(['src/cart.ts']);
    default:
      throw { code: 'generic', message: `mock: unknown command ${command}` };
  }
}
