import { describe, expect, it } from 'vitest';
import type { DownloadJob } from '../../bindings/DownloadJob';
import type { Runtime } from '../../bindings/Runtime';
import { jobStage, latestJob, parseVariant, runtimeBusy, runtimeSource, sourceLabel, transferView } from './download';

describe('transferView', () => {
  it('computes fraction and remaining time while downloading', () => {
    const v = transferView({ jobId: 'j', phase: 'downloading', fileIndex: 0, fileCount: 1, downloadedBytes: 250, totalBytes: 1000, bytesPerSecond: 50 }, 0);
    expect(v.fraction).toBe(0.25);
    expect(v.remainingSeconds).toBe(15);
  });

  it('has no remaining time while verifying or without speed', () => {
    expect(transferView({ jobId: 'j', phase: 'verifying', fileIndex: 0, fileCount: 1, downloadedBytes: 1000, totalBytes: 1000, bytesPerSecond: 50 }, 0).remainingSeconds).toBeNull();
    expect(transferView({ jobId: 'j', phase: 'downloading', fileIndex: 0, fileCount: 1, downloadedBytes: 0, totalBytes: 1000, bytesPerSecond: 0 }, 0).remainingSeconds).toBeNull();
  });

  it('falls back to the job size before the first progress event', () => {
    expect(transferView(null, 5000)).toMatchObject({ fraction: 0, totalBytes: 5000, phase: 'starting' });
  });
});

describe('jobStage', () => {
  it('maps job states', () => {
    expect(jobStage(undefined)).toBe('starting');
    expect(jobStage({ state: { state: 'paused' } } as DownloadJob)).toBe('paused');
    expect(jobStage({ state: { state: 'failed', message: 'x' } } as DownloadJob)).toBe('failed');
  });
});

describe('runtime sources', () => {
  it('parses variants', () => {
    expect(parseVariant('cuda-13.4')).toEqual({ backend: 'cuda', version: '13.4' });
    expect(parseVariant('vulkan')).toEqual({ backend: 'vulkan', version: null });
  });

  it('names the host and repository a file comes from', () => {
    expect(sourceLabel('https://github.com/ggml-org/llama.cpp/releases/download/b1/x.zip')).toBe('github.com/ggml-org/llama.cpp');
    expect(sourceLabel('https://example.com')).toBe('example.com');
    expect(sourceLabel('not a url')).toBe('not a url');
  });

  it('finds the asset of a variant in the registry', () => {
    const runtimes = [
      {
        id: 'llama.cpp',
        version: 'b1',
        license: { id: 'MIT', name: 'MIT', url: '', commercialUse: true, notes: null },
        assets: [{ os: 'windows', arch: 'x86_64', backend: 'cuda', variant: 'cuda-13.4', files: [{ url: 'https://github.com/ggml-org/llama.cpp/releases/x.zip', sizeBytes: 1, sha256: '' }], bundled: false, minCudaDriver: '13.0' }],
      },
    ] as Runtime[];
    expect(runtimeSource(runtimes, 'cuda-13.4')).toBe('github.com/ggml-org/llama.cpp');
    expect(runtimeSource(runtimes, 'rocm')).toBeNull();
  });
});

describe('latestJob', () => {
  const job = (state: DownloadJob['state']) => ({ jobId: 'j', modelId: 'm', quant: 'Q4', name: 'M', state, progress: null, totalBytes: 10 }) as DownloadJob;

  it('uses the request answer while the store only has the state from before', () => {
    const paused = job({ state: 'paused' });
    const running = job({ state: 'running' });
    expect(latestJob({ job: running, stale: paused }, paused)).toBe(running);
    expect(latestJob({ job: running, stale: undefined }, undefined)).toBe(running);
  });

  it('follows the store once a newer event arrived', () => {
    const paused = job({ state: 'paused' });
    const completed = job({ state: 'completed' });
    expect(latestJob({ job: job({ state: 'running' }), stale: paused }, completed)).toBe(completed);
    expect(latestJob(null, completed)).toBeNull();
  });
});

describe('runtimeBusy', () => {
  it('is true only while the same variant downloads or unpacks', () => {
    expect(runtimeBusy(null, 'cuda-13.4')).toBe(false);
    expect(runtimeBusy({ variant: 'cuda-13.4', state: { state: 'downloading', progress: null } }, 'cuda-13.4')).toBe(true);
    expect(runtimeBusy({ variant: 'cuda-13.4', state: { state: 'extracting' } }, 'cuda-13.4')).toBe(true);
    expect(runtimeBusy({ variant: 'cuda-13.4', state: { state: 'failed', message: 'x' } }, 'cuda-13.4')).toBe(false);
    expect(runtimeBusy({ variant: 'cuda-12.4', state: { state: 'extracting' } }, 'cuda-13.4')).toBe(false);
  });
});
