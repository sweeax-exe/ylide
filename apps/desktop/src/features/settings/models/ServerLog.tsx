// llama-server output: a snapshot from the core plus live lines, auto-scrolling
// while the reader stays at the bottom.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Spinner } from '../../../components/ui';
import { errorText } from '../../../lib/errors';
import { api } from '../../../lib/ipc';
import { useApp } from '../../../state/app';
import { mergeLines } from '../logic/logs';
import s from './ActiveModel.module.css';

const MAX_LINES = 2000;

export function ServerLog() {
  const { t } = useTranslation('settings');
  const [lines, setLines] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const box = useRef<HTMLPreElement>(null);
  const atBottom = useRef(true);

  useEffect(() => {
    let alive = true;
    let ready = false;
    const pending: string[] = [];
    // Lines that arrived since the last frame; llama-server prints hundreds while
    // a model loads, so they are rendered once per frame instead of once per line.
    let batch: string[] = [];
    let frame = 0;
    const flush = () => {
      frame = 0;
      const add = batch;
      batch = [];
      setLines((l) => [...(l ?? []), ...add].slice(-MAX_LINES));
    };
    // Each runtime://log event appends exactly one line to serverLog.
    const unsubscribe = useApp.subscribe((state, prev) => {
      if (state.serverLog === prev.serverLog || state.serverLog.length === 0) return;
      const line = state.serverLog[state.serverLog.length - 1];
      if (!ready) {
        pending.push(line);
        return;
      }
      batch.push(line);
      if (!frame) frame = requestAnimationFrame(flush);
    });
    setLines(null);
    setError(null);
    api.server
      .logs()
      .then((snapshot) => {
        if (!alive) return;
        ready = true;
        setLines(mergeLines(snapshot, pending, MAX_LINES));
      })
      .catch((e: unknown) => alive && setError(errorText(e)));
    return () => {
      alive = false;
      cancelAnimationFrame(frame);
      unsubscribe();
    };
  }, [attempt]);

  useLayoutEffect(() => {
    const el = box.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  if (error) {
    return (
      <div className={s.logState}>
        <span className={s.logError}>{t('active.logFailed', { message: error })}</span>
        <Button size="sm" onClick={() => setAttempt((a) => a + 1)}>
          {t('common:actions.retry')}
        </Button>
      </div>
    );
  }
  if (!lines) {
    return (
      <div className={s.logState}>
        <Spinner label={t('active.logLoading')} />
      </div>
    );
  }
  if (lines.length === 0) return <div className={s.logState}>{t('active.logEmpty')}</div>;
  return (
    <pre
      ref={box}
      className={`${s.log} selectable`}
      tabIndex={0}
      aria-label={t('active.log')}
      onScroll={(e) => {
        const el = e.currentTarget;
        atBottom.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 8;
      }}
    >
      {lines.join('\n')}
    </pre>
  );
}
