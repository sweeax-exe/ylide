import { describe, expect, it } from 'vitest';
import { readStored } from './storage';

function memoryStore(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

describe('readStored', () => {
  it('returns the value under the current key', () => {
    const store = memoryStore({ 'ylide.layout': '{"sidebar":null}', 'anyon.layout': '{"sidebar":"search"}' });
    expect(readStored('ylide.layout', 'anyon.layout', store)).toBe('{"sidebar":null}');
    expect(store.data.get('anyon.layout')).toBe('{"sidebar":"search"}');
  });

  it('falls back to the legacy key once and migrates it', () => {
    const store = memoryStore({ 'anyon.panelSizes': '{"sidebar":300}' });
    expect(readStored('ylide.panelSizes', 'anyon.panelSizes', store)).toBe('{"sidebar":300}');
    expect(store.data.get('ylide.panelSizes')).toBe('{"sidebar":300}');
    expect(store.data.has('anyon.panelSizes')).toBe(false);
    expect(readStored('ylide.panelSizes', 'anyon.panelSizes', store)).toBe('{"sidebar":300}');
  });

  it('returns null when nothing is stored or storage is missing', () => {
    expect(readStored('ylide.layout', 'anyon.layout', memoryStore())).toBeNull();
    expect(readStored('ylide.layout', 'anyon.layout', null)).toBeNull();
  });

  it('returns null when storage throws', () => {
    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {},
      removeItem: () => {},
    };
    expect(readStored('ylide.layout', 'anyon.layout', broken)).toBeNull();
  });
});
