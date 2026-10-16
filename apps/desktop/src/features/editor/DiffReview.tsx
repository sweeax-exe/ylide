// Review of an inline edit in Monaco's diff editor: the buffer before and
// after, unified by default, with unchanged regions folded away.

import { Check, RotateCcw, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Segmented } from '../../components/ui';
import { useApp } from '../../state/app';
import { editorOptions } from './CodeEditor';
import s from './DiffReview.module.css';
import { monaco, reanchorEditorServices } from './monaco/setup';

interface Props {
  language: string;
  original: string;
  modified: string;
  instruction: string;
  onAccept(): void;
  onReject(): void;
  onRetry(): void;
}

type Layout = 'inline' | 'split';

export function DiffReview({ language, original, modified, instruction, onAccept, onReject, onRetry }: Props) {
  const { t } = useTranslation('editor');
  const host = useRef<HTMLDivElement>(null);
  const diffRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const handlers = useRef({ onAccept, onReject });
  const labels = useRef({ accept: t('review.accept'), reject: t('review.reject') });
  const [stats, setStats] = useState<{ added: number; removed: number } | null>(null);
  const [layout, setLayout] = useState<Layout>('inline');
  const editorSettings = useApp((st) => st.settings?.editor);

  useEffect(() => {
    handlers.current = { onAccept, onReject };
  }, [onAccept, onReject]);

  useEffect(() => {
    const diff = monaco.editor.createDiffEditor(host.current!, {
      ...editorOptions(useApp.getState().settings?.editor),
      automaticLayout: true,
      fixedOverflowWidgets: true,
      readOnly: true,
      originalEditable: false,
      renderSideBySide: false,
      useInlineViewWhenSpaceIsLimited: true,
      hideUnchangedRegions: { enabled: true, contextLineCount: 3, minimumLineCount: 3, revealLineCount: 20 },
      ignoreTrimWhitespace: false,
      renderOverviewRuler: false,
      renderMarginRevertIcon: false,
      renderGutterMenu: false,
      scrollBeyondLastLine: false,
      minimap: { enabled: false },
      stickyScroll: { enabled: false },
      padding: { top: 8, bottom: 8 },
      scrollbar: { useShadows: false, verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
    });
    const before = monaco.editor.createModel(original, language);
    const after = monaco.editor.createModel(modified, language);
    diff.setModel({ original: before, modified: after });
    diffRef.current = diff;
    // Actions (unlike addCommand) are scoped to this editor and removed with it.
    const keys = [
      diff.addAction({
        id: 'ylide.review.accept',
        label: labels.current.accept,
        keybindings: [monaco.KeyCode.Enter, monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
        run: () => handlers.current.onAccept(),
      }),
      diff.addAction({ id: 'ylide.review.reject', label: labels.current.reject, keybindings: [monaco.KeyCode.Escape], run: () => handlers.current.onReject() }),
    ];
    let revealed = false;
    const sub = diff.onDidUpdateDiff(() => {
      const changes = diff.getLineChanges() ?? [];
      const span = (start: number, end: number) => (end >= start && end > 0 ? end - start + 1 : 0);
      setStats({
        added: changes.reduce((n, c) => n + span(c.modifiedStartLineNumber, c.modifiedEndLineNumber), 0),
        removed: changes.reduce((n, c) => n + span(c.originalStartLineNumber, c.originalEndLineNumber), 0),
      });
      if (!revealed) {
        revealed = true;
        void diff.revealFirstDiff();
        diff.getModifiedEditor().focus();
      }
    });
    diff.getModifiedEditor().focus();
    return () => {
      keys.forEach((k) => k.dispose());
      sub.dispose();
      diffRef.current = null;
      diff.dispose();
      reanchorEditorServices();
      // A diff computation still running in the worker fails noisily when its
      // models vanish, so the temporary models outlive it briefly.
      window.setTimeout(() => {
        before.dispose();
        after.dispose();
      }, 3000);
    };
  }, [language, original, modified]);

  useEffect(() => {
    diffRef.current?.updateOptions(editorOptions(editorSettings));
  }, [editorSettings]);

  useEffect(() => {
    diffRef.current?.updateOptions({ renderSideBySide: layout === 'split' });
  }, [layout]);

  return (
    <section
      className={s.review}
      aria-label={t('review.title')}
      onKeyDown={(e) => {
        // Monaco handles Escape itself while the diff has focus; this covers the toolbar.
        if (e.key !== 'Escape' || e.defaultPrevented) return;
        e.preventDefault();
        onReject();
      }}
    >
      <header className={s.bar}>
        <div className={s.summary}>
          <span className={s.title}>{t('review.title')}</span>
          {instruction && (
            <span className={s.instruction} title={instruction}>
              {instruction}
            </span>
          )}
          {stats && (
            <span className={s.stats}>
              <span className={s.added} aria-hidden>
                +{stats.added}
              </span>
              <span className={s.removed} aria-hidden>
                −{stats.removed}
              </span>
              <span className="visually-hidden">
                {t('review.added', { count: stats.added })}, {t('review.removed', { count: stats.removed })}
              </span>
            </span>
          )}
        </div>
        <div className={s.actions}>
          <Segmented<Layout>
            label={t('review.layout')}
            value={layout}
            onChange={setLayout}
            options={[
              { value: 'inline', label: t('review.inline') },
              { value: 'split', label: t('review.split') },
            ]}
          />
          <Button size="sm" variant="ghost" icon={<X size={13} />} onClick={onReject} title={t('review.rejectHint')} aria-keyshortcuts="Escape">
            <span className={s.collapsible}>{t('review.reject')}</span>
          </Button>
          <Button size="sm" variant="secondary" icon={<RotateCcw size={13} />} onClick={onRetry} title={t('review.retry')}>
            <span className={s.collapsible}>{t('review.retry')}</span>
          </Button>
          <Button size="sm" variant="primary" icon={<Check size={13} />} onClick={onAccept} title={t('review.acceptHint')} aria-keyshortcuts="Enter">
            {t('review.accept')}
          </Button>
        </div>
      </header>
      <div ref={host} className={`${s.diff} monaco-component`} />
    </section>
  );
}
