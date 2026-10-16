// Merging a log snapshot with lines that arrived live while it was fetched.

import type { NetworkLogEntry } from '../../../bindings/NetworkLogEntry';

/**
 * Appends `live` lines to `snapshot`, skipping the leading live lines that the
 * snapshot already ends with (they arrived while the snapshot was taken).
 */
export function mergeLines(snapshot: readonly string[], live: readonly string[], max = 2000): string[] {
  let overlap = Math.min(snapshot.length, live.length);
  while (overlap > 0) {
    let same = true;
    for (let i = 0; i < overlap; i++) {
      if (snapshot[snapshot.length - overlap + i] !== live[i]) {
        same = false;
        break;
      }
    }
    if (same) break;
    overlap--;
  }
  const merged = [...snapshot, ...live.slice(overlap)];
  return merged.length > max ? merged.slice(merged.length - max) : merged;
}

export const entryKey = (e: NetworkLogEntry) => `${e.atUnixMs}|${e.purpose}|${e.url}|${e.outcome}`;

/** The core keeps this many entries (LOG_LIMIT in src-tauri/src/network.rs); the view keeps no more. */
export const NETWORK_LOG_LIMIT = 500;

/** Snapshot plus live entries without duplicates, newest first, at most `max`. */
export function mergeEntries(snapshot: readonly NetworkLogEntry[], live: readonly NetworkLogEntry[], max = NETWORK_LOG_LIMIT): NetworkLogEntry[] {
  const seen = new Set<string>();
  const out: NetworkLogEntry[] = [];
  for (const e of [...snapshot, ...live]) {
    const k = entryKey(e);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out.sort((a, b) => b.atUnixMs - a.atUnixMs).slice(0, max);
}

export type OutcomeTone = 'success' | 'danger' | 'neutral';

/**
 * HTTP 2xx/304 and finished downloads ("completed, checksum verified",
 * "installed, checksums verified") read as success; 4xx/5xx and failures as danger.
 */
export function outcomeTone(outcome: string): OutcomeTone {
  const o = outcome.trim().toLowerCase();
  if (/^[45]\d\d\b/.test(o) || /fail|error|denied|blocked|timeout|mismatch|refused/.test(o)) return 'danger';
  if (/^(2\d\d|304)\b/.test(o) || o === 'ok' || /^(completed|installed)\b/.test(o)) return 'success';
  return 'neutral';
}

/** Clock time, with the date when it is not today. */
export function formatLogTime(atUnixMs: number, locale: string, now = Date.now()): string {
  const d = new Date(atUnixMs);
  const today = new Date(now).toDateString() === d.toDateString();
  const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(d);
  if (today) return time;
  return `${new Intl.DateTimeFormat(locale, { day: '2-digit', month: '2-digit' }).format(d)} ${time}`;
}
