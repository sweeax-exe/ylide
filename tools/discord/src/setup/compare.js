// Pure comparison helpers for the setup. They decide whether the live server
// already matches the spec, so a second run changes nothing.

/**
 * True when every field in `desired` equals the same field in `actual`.
 * Extra fields in `actual` (ids Discord adds, proxy URLs) are ignored. Arrays
 * must have the same length. An `attachment://name` URL matches a CDN URL
 * whose file name is `name`.
 */
export function matches(desired, actual) {
  if (desired === undefined) return true;
  if (desired === null) return actual === null || actual === undefined;
  if (Array.isArray(desired)) {
    return Array.isArray(actual) && desired.length === actual.length && desired.every((d, i) => matches(d, actual[i]));
  }
  if (typeof desired === 'object') {
    if (actual === null || typeof actual !== 'object') return false;
    return Object.keys(desired).every((key) => matches(desired[key], actual[key]));
  }
  if (typeof desired === 'string' && desired.startsWith('attachment://') && typeof actual === 'string') {
    return fileNameOf(actual) === desired.slice('attachment://'.length);
  }
  if (typeof desired === 'bigint') return actual !== undefined && actual !== null && BigInt(actual) === desired;
  return desired === actual;
}

export function fileNameOf(url) {
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').pop());
  } catch {
    return url;
  }
}

/** Normalises overwrites to a sorted list of {id, type, allow, deny} strings. */
export function normalizeOverwrites(list) {
  return (list ?? [])
    .map((o) => ({ id: String(o.id), type: Number(o.type), allow: BigInt(o.allow ?? 0).toString(), deny: BigInt(o.deny ?? 0).toString() }))
    .filter((o) => o.allow !== '0' || o.deny !== '0')
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function sameOverwrites(a, b) {
  return JSON.stringify(normalizeOverwrites(a)) === JSON.stringify(normalizeOverwrites(b));
}

/**
 * Merges category and channel overwrites the way the setup applies them: the
 * channel's own allow and deny win over the category's for the same target.
 */
export function mergeOverwrites(base, extra) {
  const byTarget = new Map();
  for (const o of base) byTarget.set(o.target, { ...o });
  for (const o of extra) {
    const prev = byTarget.get(o.target);
    if (!prev) {
      byTarget.set(o.target, { ...o });
      continue;
    }
    byTarget.set(o.target, {
      target: o.target,
      allow: (prev.allow & ~o.deny) | o.allow,
      deny: (prev.deny & ~o.allow) | o.deny,
    });
  }
  return [...byTarget.values()];
}

/** Sorts channels the way the Discord client shows them inside one category. */
export function sidebarOrder(channels) {
  return [...channels].sort((a, b) => a.position - b.position || (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
}

/** True when the ids appear in `wanted` order among `actualSorted`. */
export function inOrder(actualSorted, wanted) {
  const positions = wanted.map((id) => actualSorted.findIndex((c) => c.id === id));
  return positions.every((p, i) => p !== -1 && (i === 0 || p > positions[i - 1]));
}
