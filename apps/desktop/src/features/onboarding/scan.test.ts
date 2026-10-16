import { describe, expect, it } from 'vitest';
import type { HardwareProfile } from '../../bindings/HardwareProfile';
import { buildReadout, countUp, easeOut, progressBetween, scanSchedule, strandX } from './scan';

const GiB = 1024 ** 3;

const hardware: HardwareProfile = {
  os: { family: 'windows', version: 'Windows 11 Pro (26200)', arch: 'x86_64' },
  cpu: { brand: 'AMD Ryzen 9 9950X3D 16-Core Processor ', physicalCores: 16, logicalCores: 32, features: { avx2: true, avx512: false, fma: true, neon: false } },
  memory: { totalBytes: 64 * GiB, availableBytes: 37 * GiB },
  gpus: [
    { index: 0, name: 'AMD Radeon(TM) Graphics', vendor: 'amd', vendorId: 0x1002, deviceId: 1, kind: 'integrated', dedicatedVramBytes: 2 * GiB, sharedMemoryBytes: 0, vramBudgetBytes: null, vramFreeBytes: null, computeCapability: null },
    { index: 1, name: 'NVIDIA GeForce RTX 5070 Ti', vendor: 'nvidia', vendorId: 0x10de, deviceId: 2, kind: 'discrete', dedicatedVramBytes: 16 * GiB, sharedMemoryBytes: 0, vramBudgetBytes: null, vramFreeBytes: 14 * GiB, computeCapability: '12.0' },
  ],
  acceleration: { cudaDriver: '13.3', vulkan: true, directml: true, metal: false, rocm: false },
  disk: { mountPoint: 'D:\\', totalBytes: 1000 * GiB, freeBytes: 282 * GiB },
  probedAtUnixMs: 0,
  warnings: [],
};

describe('buildReadout', () => {
  const rows = buildReadout(hardware);

  it('lists the GPU that runs models first and keeps integrated GPUs, marked as unused', () => {
    expect(rows.map((r) => r.key)).toEqual(['gpu-1', 'gpu-0', 'memory', 'cpu', 'disk', 'acceleration']);
    expect(rows[0].status).toBe('used');
    expect(rows[1].status).toBe('integrated');
  });

  it('reports measured free VRAM and compute capability for the discrete GPU', () => {
    expect(rows[0].metrics).toEqual([
      { id: 'dedicated', kind: 'bytes', value: 16 * GiB },
      { id: 'free', kind: 'bytes', value: 14 * GiB },
      { id: 'compute', kind: 'text', text: '12.0' },
    ]);
    // The integrated GPU only shows its carve-out.
    expect(rows[1].metrics).toEqual([{ id: 'dedicated', kind: 'bytes', value: 2 * GiB }]);
  });

  it('marks free VRAM as unmeasured when the platform does not report it', () => {
    const hw = { ...hardware, gpus: [{ ...hardware.gpus[1], vramFreeBytes: null }] };
    expect(buildReadout(hw)[0].metrics[1]).toEqual({ id: 'free', kind: 'unmeasured' });
  });

  it('describes the CPU and its vector extensions', () => {
    const cpu = rows.find((r) => r.kind === 'cpu')!;
    expect(cpu.title).toBe('AMD Ryzen 9 9950X3D 16-Core Processor');
    expect(cpu.flags).toEqual([
      { id: 'avx2', present: true, detail: null },
      { id: 'avx512', present: false, detail: null },
    ]);
  });

  it('shows NEON instead of AVX on ARM', () => {
    const hw = { ...hardware, os: { ...hardware.os, arch: 'aarch64' } };
    expect(buildReadout(hw).find((r) => r.kind === 'cpu')!.flags.map((f) => f.id)).toEqual(['neon']);
  });

  it('lists acceleration with the CUDA driver version', () => {
    const acc = rows.find((r) => r.kind === 'acceleration')!;
    expect(acc.flags).toEqual([
      { id: 'cuda', present: true, detail: '13.3' },
      { id: 'vulkan', present: true, detail: null },
      { id: 'directml', present: true, detail: null },
    ]);
  });

  it('keeps a row when there is no GPU or the disk is unknown', () => {
    const r = buildReadout({ ...hardware, gpus: [], disk: null });
    expect(r[0]).toMatchObject({ kind: 'gpu', status: 'missing' });
    expect(r.find((x) => x.kind === 'disk')).toMatchObject({ status: 'unknown', metrics: [] });
  });
});

describe('scanSchedule', () => {
  it('ends the last count-up exactly at the total duration', () => {
    const s = scanSchedule(6, 1600);
    expect(s).toHaveLength(6);
    expect(s[5].revealEnd).toBeCloseTo(1600);
    expect(s[5].lineEnd).toBeCloseTo(1200);
  });

  it('reveals rows one after another as the world lines reach them', () => {
    const s = scanSchedule(4, 1600);
    for (let i = 1; i < s.length; i++) {
      expect(s[i].revealStart).toBeGreaterThan(s[i - 1].revealStart);
      expect(s[i].lineStart).toBeCloseTo(s[i - 1].lineEnd);
      expect(s[i].revealStart).toBeCloseTo(s[i].lineStart);
    }
  });

  it('handles a single row and no rows', () => {
    expect(scanSchedule(1, 1600)[0]).toEqual({ lineStart: 0, lineEnd: 1200, revealStart: 0, revealEnd: 1600 });
    expect(scanSchedule(0, 1600)).toEqual([]);
  });
});

describe('counting', () => {
  it('clamps progress', () => {
    expect(progressBetween(-10, 0, 100)).toBe(0);
    expect(progressBetween(50, 0, 100)).toBe(0.5);
    expect(progressBetween(500, 0, 100)).toBe(1);
    expect(progressBetween(5, 5, 5)).toBe(1);
  });

  it('eases out and lands exactly on the target', () => {
    expect(easeOut(0)).toBe(0);
    expect(easeOut(1)).toBe(1);
    expect(easeOut(0.5)).toBeGreaterThan(0.5);
    expect(countUp(15.6, 1, 0.1)).toBe(15.6);
    expect(countUp(32, 0)).toBe(0);
    expect(countUp(32, 0.5)).toBe(28);
  });

  it('moves a strand smoothly between the two columns', () => {
    expect(strandX(0, 6, 18)).toBe(6);
    expect(strandX(0.5, 6, 18)).toBe(12);
    expect(strandX(1, 6, 18)).toBe(18);
  });
});
