import { useEffect, useMemo, useState } from 'react';
import type { Symbol as CodeSymbol } from '../../bindings/Symbol';
import { errorText } from '../../lib/errors';
import { api } from '../../lib/ipc';
import { pickerItems, SYMBOL_MIN_QUERY, type PickerItem } from './mentions';

interface Results {
  query: string;
  files: string[];
  symbols: CodeSymbol[];
}

export interface MentionSearch {
  items: PickerItem[];
  /** True while results for the current query are still on their way. */
  loading: boolean;
  error: string | null;
}

const DEBOUNCE_MS = 90;

/**
 * Searches files and symbols for the mention picker. `query` null means the
 * picker is closed. Earlier results stay visible while new ones load, so the
 * list does not flicker while typing.
 */
export function useMentionSearch(query: string | null, projectName: string): MentionSearch {
  const [results, setResults] = useState<Results | null>(null);
  const [error, setError] = useState<{ query: string; text: string } | null>(null);

  useEffect(() => {
    if (query === null) return;
    let live = true;
    const timer = setTimeout(
      () => {
        Promise.all([api.fs.findFiles(query, 40), query.length >= SYMBOL_MIN_QUERY ? api.fs.findSymbols(query, 20) : Promise.resolve<CodeSymbol[]>([])])
          .then(([files, symbols]) => {
            if (!live) return;
            setResults({ query, files, symbols });
            setError(null);
          })
          .catch((e: unknown) => {
            if (live) setError({ query, text: errorText(e) });
          });
      },
      query ? DEBOUNCE_MS : 0,
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query]);

  const items = useMemo(() => (results && query !== null ? pickerItems(results.query, results.files, results.symbols, projectName) : []), [results, query, projectName]);

  return {
    items: query === null ? [] : items,
    loading: query !== null && results?.query !== query && error?.query !== query,
    error: query !== null && error?.query === query ? error.text : null,
  };
}
