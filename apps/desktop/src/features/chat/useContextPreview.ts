import { useEffect, useState } from 'react';
import type { ContextItem } from '../../bindings/ContextItem';
import type { Mention } from '../../bindings/Mention';
import { errorText } from '../../lib/errors';
import { api } from '../../lib/ipc';
import { contextTokens } from './conversation';
import { mentionKey } from './mentions';

export interface ContextPreview {
  /** Resolved items by mention key. */
  items: Map<string, ContextItem>;
  total: number;
  truncated: boolean;
  loading: boolean;
  error: string | null;
}

const EMPTY: ContextPreview = { items: new Map(), total: 0, truncated: false, loading: false, error: null };
const DEBOUNCE_MS = 250;

/** A selection with the same range but new text must be measured again. */
const signature = (m: Mention) => (m.type === 'selection' ? `${mentionKey(m)}#${m.text.length}` : mentionKey(m));

/** Token estimate of the attached mentions, as the core will resolve them (debounced). */
export function useContextPreview(mentions: Mention[], enabled: boolean): ContextPreview {
  const [state, setState] = useState<{ key: string; preview: ContextPreview } | null>(null);
  const key = enabled ? mentions.map(signature).join('|') : '';

  useEffect(() => {
    if (!key) return;
    let live = true;
    const current = mentions;
    const timer = setTimeout(() => {
      api.fs
        .contextPreview(current)
        .then((items) => {
          if (!live) return;
          // Items come back in the order of the mentions.
          const byKey = new Map(items.map((item, i) => [mentionKey(current[i]), item] as const));
          setState({ key, preview: { items: byKey, total: contextTokens(items), truncated: items.some((i) => i.truncated), loading: false, error: null } });
        })
        .catch((e: unknown) => {
          if (live) setState({ key, preview: { ...EMPTY, error: errorText(e) } });
        });
    }, DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // `mentions` is covered by `key`, which changes whenever they do.
  }, [key]);

  if (!key) return EMPTY;
  if (state?.key === key) return state.preview;
  return { ...(state?.preview ?? EMPTY), loading: true };
}
