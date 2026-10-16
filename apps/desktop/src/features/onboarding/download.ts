// Progress arithmetic for the download step.

import type { DownloadJob } from '../../bindings/DownloadJob';
import type { DownloadPhase } from '../../bindings/DownloadPhase';
import type { Progress } from '../../bindings/Progress';
import type { Runtime } from '../../bindings/Runtime';
import type { RuntimeInstall } from '../../bindings/RuntimeInstall';

export interface TransferView {
  /** 0..1 */
  fraction: number;
  doneBytes: number;
  totalBytes: number;
  bytesPerSecond: number;
  /** Null while the speed is unknown or the transfer is not running. */
  remainingSeconds: number | null;
  phase: DownloadPhase | 'starting';
  fileIndex: number;
  fileCount: number;
}

export function transferView(progress: Progress | null, fallbackTotal: number): TransferView {
  const total = progress?.totalBytes || fallbackTotal;
  const done = Math.min(progress?.downloadedBytes ?? 0, total);
  const bps = progress?.bytesPerSecond ?? 0;
  const moving = progress !== null && (progress.phase === 'downloading' || progress.phase === 'resuming');
  return {
    fraction: total > 0 ? done / total : 0,
    doneBytes: done,
    totalBytes: total,
    bytesPerSecond: bps,
    remainingSeconds: moving && bps > 0 ? (total - done) / bps : null,
    phase: progress?.phase ?? 'starting',
    fileIndex: progress?.fileIndex ?? 0,
    fileCount: progress?.fileCount ?? 1,
  };
}

export type JobStage = 'starting' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';

export function jobStage(job: DownloadJob | null | undefined): JobStage {
  if (!job) return 'starting';
  return job.state.state;
}

/** The answer of a download request, with the store's value of that job at the time. */
export interface Started {
  job: DownloadJob;
  stale: DownloadJob | undefined;
}

/**
 * The job to show: the store's value once an event arrived after the request
 * (a new object), otherwise what the request returned. Without this, resuming
 * a paused job would show "paused" until the next progress event.
 */
export function latestJob(started: Started | null, stored: DownloadJob | undefined): DownloadJob | null {
  if (!started) return null;
  return stored !== undefined && stored !== started.stale ? stored : started.job;
}

/** True while an install of `variant` is in progress, so it must not be requested again. */
export function runtimeBusy(install: RuntimeInstall | null, variant: string): boolean {
  return install?.variant === variant && (install.state.state === 'downloading' || install.state.state === 'extracting');
}

/** "cuda-13.4" -> { backend: "cuda", version: "13.4" }; "vulkan" -> { backend: "vulkan", version: null }. */
export function parseVariant(variant: string): { backend: string; version: string | null } {
  const at = variant.indexOf('-');
  return at < 0 ? { backend: variant, version: null } : { backend: variant.slice(0, at), version: variant.slice(at + 1) };
}

/** "https://github.com/ggml-org/llama.cpp/releases/…" -> "github.com/ggml-org/llama.cpp". */
export function sourceLabel(url: string): string {
  try {
    const u = new URL(url);
    const repo = u.pathname.split('/').filter(Boolean).slice(0, 2).join('/');
    return repo ? `${u.host}/${repo}` : u.host;
  } catch {
    return url;
  }
}

/** Where a runtime variant is downloaded from, according to the registry. */
export function runtimeSource(runtimes: Runtime[], variant: string): string | null {
  for (const rt of runtimes) {
    const asset = rt.assets.find((a) => a.variant === variant && a.files.length > 0);
    if (asset) return sourceLabel(asset.files[0].url);
  }
  return null;
}
