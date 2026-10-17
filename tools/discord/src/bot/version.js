// The latest Ylide release, read from ylide.app's update manifest every ten
// minutes: the bug report form suggests its version, and the release
// announcer posts new versions to #releases. Only our own server is asked; if
// it cannot be reached, the last known release is kept and nothing happens.

import { links } from '../theme.js';

const REFRESH = 10 * 60 * 1000;
let latest = null;

/** Parses the manifest into { version, notes, date }, or null when it is not usable. */
export function parseManifest(json) {
  if (!json || !/^\d+\.\d+\.\d+$/.test(json.version ?? '')) return null;
  const date = Date.parse(json.pub_date ?? '');
  return { version: json.version, notes: typeof json.notes === 'string' ? json.notes.trim() : '', date: Number.isNaN(date) ? null : date };
}

async function refresh(onRelease) {
  let release = null;
  try {
    const response = await fetch(links.latest, { signal: AbortSignal.timeout(10000) });
    if (response.ok) release = parseManifest(await response.json());
  } catch {
    // Offline or not reachable: try again at the next refresh.
  }
  if (!release) return;
  latest = release;
  await onRelease?.(release);
}

/** Starts the refresh loop; `onRelease(release)` runs after every successful read. */
export function startVersionWatch(onRelease) {
  refresh(onRelease);
  setInterval(() => refresh(onRelease), REFRESH).unref();
}

export const latestVersion = () => latest?.version ?? null;
