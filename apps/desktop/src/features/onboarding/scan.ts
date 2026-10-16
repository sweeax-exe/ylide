// The hardware readout: which rows the scan shows, and the timeline that
// reveals them. Pure functions; the component only renders what they return.

import type { GpuInfo } from '../../bindings/GpuInfo';
import type { GpuVendor } from '../../bindings/GpuVendor';
import type { HardwareProfile } from '../../bindings/HardwareProfile';

export type RowKind = 'gpu' | 'memory' | 'cpu' | 'disk' | 'acceleration';

/** `used`: the device can run models. The other states explain why a row is shown but not used. */
export type RowStatus = 'used' | 'integrated' | 'software' | 'missing' | 'unknown';

export type MetricId = 'dedicated' | 'free' | 'compute' | 'total' | 'available' | 'cores' | 'threads' | 'diskFree' | 'diskTotal';

export type Metric =
  | { id: MetricId; kind: 'bytes'; value: number }
  | { id: MetricId; kind: 'count'; value: number }
  | { id: MetricId; kind: 'text'; text: string }
  /** The value exists in principle but the platform did not report it. */
  | { id: MetricId; kind: 'unmeasured' };

export type FlagId = 'cuda' | 'vulkan' | 'directml' | 'metal' | 'rocm' | 'avx2' | 'avx512' | 'neon';

export interface Flag {
  id: FlagId;
  present: boolean;
  /** Extra fact, e.g. the CUDA driver version. */
  detail: string | null;
}

export interface ReadoutRow {
  key: string;
  kind: RowKind;
  /** Device name as reported by the system (not translated). */
  title: string | null;
  vendor: GpuVendor | null;
  status: RowStatus;
  metrics: Metric[];
  flags: Flag[];
}

function gpuStatus(gpu: GpuInfo, hw: HardwareProfile): RowStatus {
  if (gpu.kind === 'discrete') return 'used';
  if (gpu.kind === 'software') return 'software';
  // Apple GPUs are integrated but run models in unified memory.
  return gpu.vendor === 'apple' && hw.acceleration.metal ? 'used' : 'integrated';
}

function gpuRow(gpu: GpuInfo, hw: HardwareProfile): ReadoutRow {
  const status = gpuStatus(gpu, hw);
  const metrics: Metric[] = [{ id: 'dedicated', kind: 'bytes', value: gpu.dedicatedVramBytes }];
  if (status === 'used') {
    metrics.push(gpu.vramFreeBytes !== null ? { id: 'free', kind: 'bytes', value: gpu.vramFreeBytes } : { id: 'free', kind: 'unmeasured' });
  }
  if (gpu.computeCapability) metrics.push({ id: 'compute', kind: 'text', text: gpu.computeCapability });
  return { key: `gpu-${gpu.index}`, kind: 'gpu', title: gpu.name, vendor: gpu.vendor, status, metrics, flags: [] };
}

/** One row per measured component, in the order the scan reveals them. */
export function buildReadout(hw: HardwareProfile): ReadoutRow[] {
  // Discrete GPUs first: they decide what fits.
  const gpus = [...hw.gpus].sort((a, b) => Number(gpuStatus(b, hw) === 'used') - Number(gpuStatus(a, hw) === 'used') || a.index - b.index);
  const rows: ReadoutRow[] = gpus.map((g) => gpuRow(g, hw));
  if (rows.length === 0) rows.push({ key: 'gpu-none', kind: 'gpu', title: null, vendor: null, status: 'missing', metrics: [], flags: [] });

  rows.push({
    key: 'memory',
    kind: 'memory',
    title: null,
    vendor: null,
    status: 'used',
    metrics: [
      { id: 'total', kind: 'bytes', value: hw.memory.totalBytes },
      { id: 'available', kind: 'bytes', value: hw.memory.availableBytes },
    ],
    flags: [],
  });

  const arm = hw.os.arch === 'aarch64' || hw.os.arch === 'arm64';
  rows.push({
    key: 'cpu',
    kind: 'cpu',
    title: hw.cpu.brand.trim() || null,
    vendor: null,
    status: 'used',
    metrics: [
      { id: 'cores', kind: 'count', value: hw.cpu.physicalCores },
      { id: 'threads', kind: 'count', value: hw.cpu.logicalCores },
    ],
    flags: arm
      ? [{ id: 'neon', present: hw.cpu.features.neon, detail: null }]
      : [
          { id: 'avx2', present: hw.cpu.features.avx2, detail: null },
          { id: 'avx512', present: hw.cpu.features.avx512, detail: null },
        ],
  });

  rows.push(
    hw.disk
      ? {
          key: 'disk',
          kind: 'disk',
          title: hw.disk.mountPoint,
          vendor: null,
          status: 'used',
          metrics: [
            { id: 'diskFree', kind: 'bytes', value: hw.disk.freeBytes },
            { id: 'diskTotal', kind: 'bytes', value: hw.disk.totalBytes },
          ],
          flags: [],
        }
      : { key: 'disk', kind: 'disk', title: null, vendor: null, status: 'unknown', metrics: [], flags: [] },
  );

  const acc = hw.acceleration;
  const flags: Flag[] = [
    { id: 'cuda', present: acc.cudaDriver !== null, detail: acc.cudaDriver },
    { id: 'vulkan', present: acc.vulkan, detail: null },
    { id: 'directml', present: acc.directml, detail: null },
  ];
  if (acc.metal || hw.os.family === 'macos') flags.push({ id: 'metal', present: acc.metal, detail: null });
  if (acc.rocm) flags.push({ id: 'rocm', present: true, detail: null });
  rows.push({ key: 'acceleration', kind: 'acceleration', title: null, vendor: null, status: 'used', metrics: [], flags });

  return rows;
}

/** Placeholder rows shown while the probe runs, so the user sees what is being measured. */
export const PENDING_KINDS: RowKind[] = ['gpu', 'memory', 'cpu', 'disk', 'acceleration'];

export interface RowTiming {
  /** The world lines are drawn through this row between lineStart and lineEnd (ms). */
  lineStart: number;
  lineEnd: number;
  /** The row's values count up between revealStart and revealEnd (ms). */
  revealStart: number;
  revealEnd: number;
}

/**
 * Timeline of the reveal. The world lines travel down the rows during the
 * first three quarters of `total`; each row starts counting when the lines
 * reach it, and the last row finishes exactly at `total`.
 */
export function scanSchedule(rows: number, total: number): RowTiming[] {
  if (rows <= 0) return [];
  const travel = total * 0.75;
  const segment = travel / rows;
  const reveal = total - segment * (rows - 1);
  return Array.from({ length: rows }, (_, i) => ({
    lineStart: i * segment,
    lineEnd: (i + 1) * segment,
    revealStart: i * segment,
    revealEnd: i * segment + reveal,
  }));
}

export function progressBetween(elapsed: number, start: number, end: number): number {
  if (end <= start) return elapsed >= end ? 1 : 0;
  return Math.min(1, Math.max(0, (elapsed - start) / (end - start)));
}

/** Matches the feel of --motion-ease: quick start, long settle. */
export function easeOut(p: number): number {
  const c = Math.min(1, Math.max(0, p));
  return 1 - (1 - c) ** 3;
}

/** The value shown while counting up, rounded to the precision it is displayed with. */
export function countUp(target: number, p: number, step = 1): number {
  if (p >= 1) return target;
  return Math.round((target * easeOut(p)) / step) * step;
}

/**
 * Horizontal position of a world line at progress `t` through one row
 * segment. The segments are cubic curves with vertical tangents at both
 * ends, whose x component is the smoothstep between the two columns.
 */
export function strandX(t: number, from: number, to: number): number {
  const c = Math.min(1, Math.max(0, t));
  return from + (to - from) * (3 * c * c - 2 * c * c * c);
}
