import { describe, expect, it } from 'vitest';
import type { Candidate } from '../../bindings/Candidate';
import type { ComputeBudget } from '../../bindings/ComputeBudget';
import type { Plan } from '../../bindings/Plan';
import type { Recommendation } from '../../bindings/Recommendation';
import type { RuntimeStatus } from '../../bindings/RuntimeStatus';
import { candidateKey, footprint, memoryBars, modelOptions, pickLocalized, reasonParams, runtimeOffer } from './recommend';

const GiB = 1024 ** 3;

const budget: ComputeBudget = { vramBytes: 12 * GiB, gpuBandwidthGbps: 896, ramBytes: 50 * GiB, ramBandwidthGbps: 65, unified: false, unifiedBytes: 0, diskFreeBytes: null, backend: 'cuda', gpuName: 'RTX' };

const plan = (over: Partial<Plan>): Plan => ({
  placement: { kind: 'gpu' },
  context: 32768,
  kvCacheType: 'f16',
  weightsBytes: 8 * GiB,
  kvBytes: 2 * GiB,
  overheadBytes: 1 * GiB,
  vramBytes: 11 * GiB,
  ramBytes: 0,
  estTokensPerSec: 50,
  ...over,
});

const cand = (modelId: string, quant: string, p: Partial<Plan> = {}): Candidate => ({ modelId, quant, plan: plan(p), score: 1, downloadBytes: 1, reasons: [] });

describe('memoryBars', () => {
  it('puts weights, context cache and buffers on the GPU when everything fits', () => {
    expect(memoryBars(plan({}), budget)).toEqual([
      {
        kind: 'vram',
        capacity: 12 * GiB,
        used: 11 * GiB,
        parts: [
          { part: 'weights', bytes: 8 * GiB },
          { part: 'kv', bytes: 2 * GiB },
          { part: 'overhead', bytes: 1 * GiB },
        ],
      },
    ]);
  });

  it('shows offloaded experts as weights in system memory', () => {
    const bars = memoryBars(plan({ placement: { kind: 'moeOffload', cpuExpertLayers: 22 }, vramBytes: 10 * GiB, ramBytes: 8 * GiB }), budget);
    expect(bars.map((b) => b.kind)).toEqual(['vram', 'ram']);
    expect(bars[0].parts[0]).toEqual({ part: 'weights', bytes: 7 * GiB });
    expect(bars[1]).toEqual({ kind: 'ram', capacity: 50 * GiB, used: 8 * GiB, parts: [{ part: 'weights', bytes: 8 * GiB }] });
  });

  it('keeps everything in system memory on the CPU', () => {
    const bars = memoryBars(plan({ placement: { kind: 'cpu' }, vramBytes: 0, ramBytes: 11 * GiB }), budget);
    expect(bars).toHaveLength(1);
    expect(bars[0].kind).toBe('ram');
    expect(bars[0].parts.map((p) => p.part)).toEqual(['weights', 'kv', 'overhead']);
  });

  it('never draws more than the capacity holds', () => {
    const [bar] = memoryBars(plan({ vramBytes: 14 * GiB }), budget);
    expect(bar.capacity).toBe(14 * GiB);
    expect(bar.parts.reduce((s, p) => s + p.bytes, 0)).toBe(14 * GiB);
  });

  it('uses one pool for unified memory', () => {
    const bars = memoryBars(plan({ placement: { kind: 'unified' }, vramBytes: 0, ramBytes: 9 * GiB }), { ...budget, unified: true, unifiedBytes: 24 * GiB });
    expect(bars).toEqual([{ kind: 'unified', capacity: 24 * GiB, used: 9 * GiB, parts: expect.any(Array) }]);
  });
});

describe('modelOptions', () => {
  it('lists the recommendation first and drops duplicates', () => {
    const primary = cand('a', 'Q4');
    const rec = {
      primary,
      alternatives: [
        { kind: 'faster', candidate: cand('a', 'Q3') },
        { kind: 'stronger', candidate: cand('b', 'Q3') },
        { kind: 'lighter', candidate: cand('a', 'Q4') },
      ],
    } as Recommendation;
    expect(modelOptions(rec).map((o) => [o.kind, o.key])).toEqual([
      ['primary', 'a@Q4'],
      ['faster', 'a@Q3'],
      ['stronger', 'b@Q3'],
    ]);
  });

  it('offers only alternatives when there is no primary pick', () => {
    expect(modelOptions({ primary: null, alternatives: [] } as unknown as Recommendation)).toEqual([]);
  });

  it('computes keys and footprints', () => {
    expect(candidateKey({ modelId: 'x', quant: 'Q8_0' })).toBe('x@Q8_0');
    expect(footprint(cand('a', 'b', { vramBytes: 3, ramBytes: 4 }))).toBe(7);
  });
});

describe('pickLocalized', () => {
  it('prefers the UI language, then English', () => {
    expect(pickLocalized({ en: 'Fast', de: 'Schnell' }, 'de')).toBe('Schnell');
    expect(pickLocalized({ en: 'Fast' }, 'de')).toBe('Fast');
    expect(pickLocalized({ fr: 'Rapide' }, 'de')).toBe('Rapide');
    expect(pickLocalized(undefined, 'de')).toBe('');
  });
});

describe('reasonParams', () => {
  const fmt = {
    number: (n: number, d: number) => n.toFixed(d).replace('.', ','),
    tokens: (n: number) => `${n / 1024}K`,
    toolLevel: (l: string) => `level:${l}`,
  };

  it('localizes numbers with their precision, token counts and tool levels', () => {
    expect(reasonParams({ code: 'moeOffload', params: { vramGb: '10.5', ramGb: '8.2', cpuExpertLayers: '22' } }, fmt)).toEqual({ vramGb: '10,5', ramGb: '8,2', cpuExpertLayers: '22' });
    expect(reasonParams({ code: 'longContext', params: { tokens: '131072' } }, fmt)).toEqual({ tokens: '128K' });
    expect(reasonParams({ code: 'toolCalling', params: { level: 'good' } }, fmt)).toEqual({ level: 'level:good' });
  });

  it('passes names and codes through', () => {
    expect(reasonParams({ code: 'benchmark', params: { name: 'SWE-bench Verified', score: '73.4', unit: '%', selfReported: 'true' } }, fmt)).toEqual({ name: 'SWE-bench Verified', score: '73,4', unit: '%', selfReported: 'true' });
    expect(reasonParams({ code: 'quantizedKvCache', params: { type: 'q8_0' } }, fmt)).toEqual({ type: 'q8_0' });
  });
});

describe('runtimeOffer', () => {
  it('offers the recommended pack only', () => {
    const status: RuntimeStatus = {
      installed: [],
      downloadable: [
        { variant: 'cuda-12.4', backend: 'cuda', version: 'b1', sizeBytes: 2, recommended: false },
        { variant: 'cuda-13.4', backend: 'cuda', version: 'b1', sizeBytes: 1, recommended: true },
      ],
      selected: 'vulkan',
      install: null,
    };
    expect(runtimeOffer(status)?.variant).toBe('cuda-13.4');
    expect(runtimeOffer({ ...status, downloadable: [] })).toBeNull();
    expect(runtimeOffer(null)).toBeNull();
  });
});
