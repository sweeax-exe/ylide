// Go to file (Ctrl+P): a centred palette with fuzzy file search. Open tabs
// come first while the query is empty; "path:12" opens at line 12.

import { Search } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Kbd, Spinner } from '../../components/ui';
import { errorText } from '../../lib/errors';
import { api } from '../../lib/ipc';
import { useApp } from '../../state/app';
import { useEditorBridge } from '../../state/editorBridge';
import { FileIcon } from './FileIcon';
import { basename } from './lib/paths';
import { highlightRuns, matchIndices, parseQuickOpen } from './lib/search';
import { requestEditorFocus } from './pathEvents';
import s from './QuickOpen.module.css';

const LIMIT = 50;

export function QuickOpen({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('editor');
  const listId = useId();
  const workspace = useApp((st) => st.workspace);
  const openPaths = useEditorBridge((st) => st.openPaths);
  const activePath = useEditorBridge((st) => st.activePath);
  const [input, setInput] = useState('');
  const [found, setFound] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const restoreFocus = useRef<HTMLElement | null>(null);
  const restoreOnClose = useRef(true);
  const { query, line } = parseQuickOpen(input);

  // Focus returns to where it was, unless a file was opened (the editor takes it then).
  useEffect(() => {
    restoreFocus.current = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    return () => {
      if (restoreOnClose.current) restoreFocus.current?.focus();
    };
  }, []);

  useEffect(() => {
    if (!workspace) return;
    let current = true;
    setLoading(true);
    const timer = window.setTimeout(() => {
      api.fs
        .findFiles(query, LIMIT)
        .then((paths) => {
          if (!current) return;
          setFound(paths);
          setError(null);
        })
        .catch((e: unknown) => current && setError(errorText(e)))
        .finally(() => current && setLoading(false));
    }, query ? 60 : 0);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [query, workspace]);

  // Open tabs (most relevant first) lead while nothing is typed.
  const items = useMemo(() => {
    if (query) return found;
    const recent = [...openPaths.filter((p) => p !== activePath), ...(activePath ? [activePath] : [])];
    return [...recent, ...found.filter((p) => !recent.includes(p))].slice(0, LIMIT);
  }, [query, found, openPaths, activePath]);

  useEffect(() => setIndex(0), [items]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${index}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  const close = (restore: boolean) => {
    restoreOnClose.current = restore;
    onClose();
  };

  const choose = (path: string | undefined) => {
    if (!path) return;
    requestEditorFocus();
    useEditorBridge.getState().open(path, line ?? undefined);
    close(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') setIndex((i) => (items.length ? (i + 1) % items.length : 0));
    else if (e.key === 'ArrowUp') setIndex((i) => (items.length ? (i - 1 + items.length) % items.length : 0));
    else if (e.key === 'PageDown') setIndex((i) => Math.min(items.length - 1, i + 8));
    else if (e.key === 'PageUp') setIndex((i) => Math.max(0, i - 8));
    else if (e.key === 'Enter') choose(items[index]);
    else if (e.key === 'Escape') close(true);
    else if (e.key === 'Tab') {
      // The palette has one control; keep focus in it.
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };

  const activeId = items[index] ? `${listId}-${index}` : undefined;

  return (
    <div className={s.backdrop} onMouseDown={(e) => e.target === e.currentTarget && close(true)}>
      <div className={s.palette} role="dialog" aria-modal="true" aria-label={t('quickOpen.title')}>
        <div className={s.inputRow}>
          <Search size={15} className={s.searchIcon} aria-hidden />
          <input
            ref={inputRef}
            className={s.input}
            value={input}
            placeholder={workspace ? t('quickOpen.placeholder') : t('quickOpen.noProject')}
            readOnly={!workspace}
            spellCheck={false}
            role="combobox"
            aria-expanded={items.length > 0}
            aria-controls={listId}
            aria-activedescendant={activeId}
            aria-autocomplete="list"
            aria-label={t('quickOpen.title')}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
          />
          {loading && <Spinner label={t('quickOpen.loading')} />}
        </div>
        <ul ref={listRef} id={listId} className={s.list} role="listbox" aria-label={t('quickOpen.results')}>
          {items.map((path, i) => (
            <Option key={path} id={`${listId}-${i}`} index={i} path={path} query={query} selected={i === index} open={openPaths.includes(path)} onHover={() => setIndex(i)} onChoose={() => choose(path)} />
          ))}
        </ul>
        {!loading && !error && workspace && items.length === 0 && <p className={s.empty}>{t('quickOpen.empty', { query })}</p>}
        {error && (
          <p className={`${s.empty} ${s.error}`} role="alert">
            {error}
          </p>
        )}
        <footer className={s.footer} aria-hidden>
          <span>
            <Kbd>↑</Kbd> <Kbd>↓</Kbd> {t('quickOpen.hintMove')}
          </span>
          <span>
            <Kbd>{t('keys.enter')}</Kbd> {t('quickOpen.hintOpen')}
          </span>
          <span>
            <Kbd>:</Kbd> {t('quickOpen.hintLine')}
          </span>
        </footer>
      </div>
    </div>
  );
}

function Option({ id, index, path, query, selected, open, onHover, onChoose }: { id: string; index: number; path: string; query: string; selected: boolean; open: boolean; onHover(): void; onChoose(): void }) {
  const { t } = useTranslation('editor');
  const name = basename(path);
  const nameStart = path.length - name.length;
  const indices = matchIndices(query, path);
  const dir = path.slice(0, Math.max(0, nameStart - 1));
  return (
    <li id={id} data-index={index} role="option" aria-selected={selected} className={`${s.option} ${selected ? s.selected : ''}`} onMouseMove={onHover} onMouseDown={(e) => e.preventDefault()} onClick={onChoose}>
      <FileIcon name={name} className={s.icon} />
      <span className={s.name}>
        {highlightRuns(name, indices, nameStart).map((r, i) => (r.match ? <mark key={i}>{r.text}</mark> : <span key={i}>{r.text}</span>))}
      </span>
      {dir && (
        <span className={s.dir}>
          {highlightRuns(dir, indices, 0).map((r, i) => (r.match ? <mark key={i}>{r.text}</mark> : <span key={i}>{r.text}</span>))}
        </span>
      )}
      {open && <span className={s.openTag}>{t('quickOpen.open')}</span>}
    </li>
  );
}
