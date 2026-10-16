// Download jobs: which to show and how far they are.

import type { DownloadJob } from '../../../bindings/DownloadJob';
import type { Progress } from '../../../bindings/Progress';

const VISIBLE = new Set(['running', 'paused', 'failed']);

/** Running, paused and failed jobs; finished and cancelled ones are not listed. */
export function visibleDownloads(jobs: Readonly<Record<string, DownloadJob>>): DownloadJob[] {
  return Object.values(jobs).filter((j) => VISIBLE.has(j.state.state));
}

/** The visible job for one model quantization, if any. */
export function jobFor(jobs: Readonly<Record<string, DownloadJob>>, modelId: string, quant: string): DownloadJob | undefined {
  return visibleDownloads(jobs).find((j) => j.modelId === modelId && j.quant === quant);
}

export function downloadedBytes(job: DownloadJob): number {
  return job.progress?.downloadedBytes ?? 0;
}

export function totalBytes(job: DownloadJob): number {
  return job.progress?.totalBytes || job.totalBytes;
}

/** 0..1 */
export function fraction(job: DownloadJob): number {
  const total = totalBytes(job);
  return total > 0 ? Math.max(0, Math.min(1, downloadedBytes(job) / total)) : 0;
}

/** Seconds left at the current speed, or `null` when the speed is unknown. */
export function remainingSeconds(progress: Progress | null): number | null {
  if (!progress || progress.bytesPerSecond <= 0) return null;
  return Math.max(0, progress.totalBytes - progress.downloadedBytes) / progress.bytesPerSecond;
}
