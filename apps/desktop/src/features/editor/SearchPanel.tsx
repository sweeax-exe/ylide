// Project-wide text search in the sidebar. Results are grouped by file and
// open at the matching line through the editor bridge.

import { CaseSensitive, ChevronRight, ChevronsDownUp, ChevronsUpDown, Regex, WholeWord, X } from 'lucide-react';
import { memo, useEffect, useRef, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge, IconButton, SectionHeader, Spinner, TextInput } from '../../components/ui';
import type { FileMatch } from '../../bindings/FileMatch';
import { formatNumber } from '../../lib/format';
import { useApp } from '../../state/app';
import { useEditorBridge } from '../../state/editorBridge';
import { FileIcon } from './FileIcon';
import { basename, dirname } from './lib/paths';
import { previewLine } from './lib/search';
import { requestEditorFocus } from './pathEvents';
import { clearSearch, MAX_RESULTS, searchNow, setAllCollapsed, toggleCollapsed, updateQuery, useSearch } from './searchStore';
import s from './SearchPanel.module.css';

function openMatch(path: string, line: number, takeFocus: boolean) {
  if (takeFocus) requestEditorFocus();
  useEditorBridge.getState().open(path, line);
}

/** Arrow keys move between result rows; Enter opens and Space previews. */
function onResultsKeyDown(e: KeyboardEvent<HTMLDivElement>) {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[data-result]'));
  const index = items.indexOf(document.activeElement as HTMLElement);
  const next = items[Math.max(0, Math.min(items.length - 1, index + (e.key === 'ArrowDown' ? 1 : -1)))];
  next?.focus();
  e.preventDefault();
}

export function SearchPanel() {
  const { t } = useTranslation('editor');
  const workspace = useApp((st) => st.workspace);
  const st = useSearch();
  const input = useRef<HTMLInputElement>(null);

  // Opening the panel (or pressing Ctrl+Shift+F while it is open) focuses the
  // query, seeded with a short single-line selection from the editor.
  useEffect(() => {
    const focusQuery = () => {
      const selection = useEditorBridge.getState().selection;
      const seed = selection && !selection.text.includes('\n') && selection.text.trim() && selection.text.length <= 200 ? selection.text : null;
      if (seed && seed !== useSearch.getState().pattern) updateQuery({ pattern: seed }, 0);
      input.current?.focus();
      input.current?.select();
    };
    focusQuery();
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') focusQuery();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const files = st.results?.files ?? [];
  const allCollapsed = files.length > 0 && files.every((f) => st.collapsed[f.path]);

  return (
    <div className={s.panel}>
      <SectionHeader
        title={t('search.title')}
        actions={
          <>
            <IconButton label={allCollapsed ? t('search.expandAll') : t('search.collapseAll')} disabled={!files.length} onClick={() => setAllCollapsed(!allCollapsed)}>
              {allCollapsed ? <ChevronsUpDown size={15} /> : <ChevronsDownUp size={15} />}
            </IconButton>
            <IconButton label={t('search.clear')} disabled={!st.pattern} onClick={clearSearch}>
              <X size={15} />
            </IconButton>
          </>
        }
      />
      {!workspace ? (
        <p className={s.message}>{t('search.noProject')}</p>
      ) : (
        <>
          <div className={s.form} role="search">
            <div className={s.queryBox}>
              <input
                ref={input}
                className={s.query}
                value={st.pattern}
                placeholder={t('search.placeholder')}
                aria-label={t('search.placeholder')}
                spellCheck={false}
                onChange={(e) => updateQuery({ pattern: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') searchNow();
                  if (e.key === 'Escape' && st.pattern) {
                    e.stopPropagation();
                    clearSearch();
                  }
                }}
              />
              <IconButton className={s.toggle} label={t('search.matchCase')} pressed={st.caseSensitive} onClick={() => updateQuery({ caseSensitive: !st.caseSensitive }, 0)}>
                <CaseSensitive size={15} />
              </IconButton>
              <IconButton className={s.toggle} label={t('search.wholeWord')} pressed={st.wholeWord} onClick={() => updateQuery({ wholeWord: !st.wholeWord }, 0)}>
                <WholeWord size={15} />
              </IconButton>
              <IconButton className={s.toggle} label={t('search.regex')} pressed={st.regex} onClick={() => updateQuery({ regex: !st.regex }, 0)}>
                <Regex size={14} />
              </IconButton>
            </div>
            <TextInput
              className={s.globs}
              value={st.globs}
              placeholder={t('search.globsPlaceholder')}
              aria-label={t('search.globsLabel')}
              title={t('search.globsHint')}
              onChange={(e) => updateQuery({ globs: e.target.value })}
              onKeyDown={(e) => e.key === 'Enter' && searchNow()}
            />
          </div>
          <div className={s.status} role="status" aria-live="polite">
            {st.running ? (
              <>
                <Spinner />
                <span>{t('search.searching')}</span>
              </>
            ) : st.results && st.pattern ? (
              st.results.totalMatches > 0 ? (
                <span>
                  {t('search.summary', {
                    results: t('search.resultCount', { count: st.results.totalMatches, value: formatNumber(st.results.totalMatches) }),
                    files: t('search.fileCount', { count: files.length, value: formatNumber(files.length) }),
                  })}
                </span>
              ) : (
                <span>{t('search.noResults', { pattern: st.searched })}</span>
              )
            ) : null}
          </div>
          {st.error && (
            <p className={`${s.message} ${s.error}`} role="alert">
              {st.error}
            </p>
          )}
          {st.results?.truncated && <p className={s.notice}>{t('search.truncated', { max: formatNumber(MAX_RESULTS) })}</p>}
          {!st.pattern && !st.error && <p className={s.message}>{t('search.hint')}</p>}
          <div className={s.results} onKeyDown={onResultsKeyDown} data-preserve-focus>
            {files.map((file) => (
              <FileGroup key={file.path} file={file} collapsed={!!st.collapsed[file.path]} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// Memoised: typing in the query re-renders the panel, while up to 500 result rows stay as they are until new results arrive.
const FileGroup = memo(function FileGroup({ file, collapsed }: { file: FileMatch; collapsed: boolean }) {
  const { t } = useTranslation('editor');
  const name = basename(file.path);
  const dir = dirname(file.path);
  return (
    <section className={s.group} aria-label={file.path}>
      <button type="button" className={s.fileRow} data-result aria-expanded={!collapsed} title={file.path} onClick={() => toggleCollapsed(file.path)}>
        <ChevronRight size={14} className={`${s.chevron} ${collapsed ? '' : s.open}`} aria-hidden />
        <FileIcon name={name} className={s.icon} />
        <span className={s.fileName}>{name}</span>
        {dir && <span className={s.dir}>{dir}</span>}
        <span className={s.count}>
          <Badge>{formatNumber(file.matches.length)}</Badge>
        </span>
      </button>
      {!collapsed && (
        <ul className={s.matches}>
          {file.matches.map((m, i) => {
            const preview = previewLine(m.line, m.ranges);
            return (
              <li key={`${m.lineNumber}-${i}`}>
                <button
                  type="button"
                  className={s.matchRow}
                  data-result
                  aria-label={t('search.matchLabel', { line: m.lineNumber, text: m.line.trim() })}
                  onClick={() => openMatch(file.path, m.lineNumber, true)}
                  onKeyDown={(e) => {
                    if (e.key === ' ') {
                      e.preventDefault();
                      openMatch(file.path, m.lineNumber, false);
                    }
                  }}
                >
                  <span className={s.line}>{m.lineNumber}</span>
                  <span className={s.text}>
                    {preview.clipped && '…'}
                    {preview.segments.map((seg, j) => (seg.match ? <mark key={j} className={s.hit}>{seg.text}</mark> : <span key={j}>{seg.text}</span>))}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
});
