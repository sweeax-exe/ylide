// Per-device settings in localStorage. Keys were renamed with the product;
// a value saved under the old key is read once, moved to the new key and the
// old key is removed, so saved layouts survive the update.

type KeyValueStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function browserStorage(): KeyValueStore | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    // storage may be unavailable (private mode)
    return null;
  }
}

/** The stored value for `key`, falling back to `legacyKey` (and migrating it). */
export function readStored(key: string, legacyKey: string, store: KeyValueStore | null = browserStorage()): string | null {
  if (!store) return null;
  try {
    const value = store.getItem(key);
    if (value !== null) return value;
    const legacy = store.getItem(legacyKey);
    if (legacy === null) return null;
    try {
      store.setItem(key, legacy);
      store.removeItem(legacyKey);
    } catch {
      // keep the old key if the new one cannot be written; reading still works
    }
    return legacy;
  } catch {
    return null;
  }
}
