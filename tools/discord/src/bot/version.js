// The latest Ylide version, read from ylide.app's update manifest, so the bug
// report form can suggest it. Only our own server is asked; if it cannot be
// reached the field simply stays empty.

import { links } from '../theme.js';

const REFRESH = 6 * 60 * 60 * 1000;
let latest = null;

async function refresh() {
  try {
    const response = await fetch(links.latest, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return;
    const { version } = await response.json();
    if (/^\d+\.\d+\.\d+$/.test(version)) latest = version;
  } catch {
    // Offline or not reachable: keep the last known version.
  }
}

export function startVersionWatch() {
  refresh();
  setInterval(refresh, REFRESH).unref();
}

export const latestVersion = () => latest;
