import { describe, expect, it } from 'vitest';
import type { Candidate } from '../../bindings/Candidate';
import { type ModelPath, needsDownload, railProgress, stepAfterModel, stepStates } from './flow';

const candidate = { modelId: 'm', quant: 'Q4' } as Candidate;
const registry = (needsModel: boolean, runtimeVariant: string | null): ModelPath => ({ kind: 'registry', candidate, needsModel, runtimeVariant });

describe('flow', () => {
  it('downloads only what is missing', () => {
    expect(needsDownload(registry(true, null))).toBe(true);
    expect(needsDownload(registry(false, 'cuda-13.4'))).toBe(true);
    expect(needsDownload(registry(false, null))).toBe(false);
    expect(needsDownload({ kind: 'external', baseUrl: 'http://127.0.0.1:11434', model: null })).toBe(false);
    expect(needsDownload(null)).toBe(false);
  });

  it('skips the download step for imported files and external servers', () => {
    expect(stepAfterModel(registry(true, null))).toBe('download');
    expect(stepAfterModel({ kind: 'external', baseUrl: 'http://x', model: null })).toBe('ready');
  });

  it('marks steps before the current one as done', () => {
    expect(stepStates('model', null)).toEqual({ welcome: 'done', scan: 'done', model: 'current', download: 'upcoming', ready: 'upcoming' });
  });

  it('shows the download step as skipped once the user is past it without needing it', () => {
    const external: ModelPath = { kind: 'external', baseUrl: 'http://x', model: null };
    expect(stepStates('ready', external).download).toBe('skipped');
    // While still choosing, the step is just upcoming.
    expect(stepStates('model', external).download).toBe('upcoming');
    expect(stepStates('ready', registry(true, null)).download).toBe('done');
  });

  it('measures progress along the rail', () => {
    expect(railProgress('welcome')).toBe(0);
    expect(railProgress('model')).toBe(0.5);
    expect(railProgress('ready')).toBe(1);
  });
});
