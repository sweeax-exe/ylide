// Every network request the core made since it started, updated live.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { NetworkLogEntry } from '../../../bindings/NetworkLogEntry';
import { Badge, Button, Spinner } from '../../../components/ui';
import { errorText } from '../../../lib/errors';
import { api, onEvent } from '../../../lib/ipc';
import { entryKey, formatLogTime, mergeEntries, NETWORK_LOG_LIMIT, outcomeTone } from '../logic/logs';
import { Note } from '../page/controls';
import s from './NetworkLog.module.css';

type Load = { state: 'loading' } | { state: 'ready'; entries: NetworkLogEntry[] } | { state: 'error'; message: string };

export function NetworkLog() {
  const { t, i18n } = useTranslation('settings');
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const live = useRef<NetworkLogEntry[]>([]);
  const loaded = useRef(false);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let alive = true;
    void onEvent('network://log', (entry) => {
      if (!loaded.current) {
        live.current = [...live.current, entry].slice(-NETWORK_LOG_LIMIT);
        return;
      }
      setLoad((l) => (l.state === 'ready' ? { state: 'ready', entries: mergeEntries(l.entries, [entry]) } : l));
    }).then((off) => {
      if (alive) unlisten = off;
      else off();
    });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  const fetchLog = useCallback(() => {
    setLoad({ state: 'loading' });
    loaded.current = false;
    api
      .networkLog()
      .then((entries) => {
        loaded.current = true;
        setLoad({ state: 'ready', entries: mergeEntries(entries, live.current) });
        live.current = [];
      })
      .catch((e: unknown) => setLoad({ state: 'error', message: errorText(e) }));
  }, []);

  useEffect(fetchLog, [fetchLog]);

  if (load.state === 'loading') {
    return (
      <div className={s.loading}>
        <Spinner label={t('network.logLoading')} />
      </div>
    );
  }
  if (load.state === 'error') {
    return (
      <Note
        tone="danger"
        action={
          <Button size="sm" onClick={fetchLog}>
            {t('common:actions.retry')}
          </Button>
        }
      >
        {t('network.logFailed', { message: load.message })}
      </Note>
    );
  }
  if (load.entries.length === 0) {
    return <div className={s.empty}>{t('network.logEmpty')}</div>;
  }

  const locale = i18n.language === 'de' ? 'de-DE' : 'en-US';
  return (
    <div className={s.wrap}>
      <table className={s.table}>
        <caption className="visually-hidden">{t('network.logTitle')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('network.logTime')}</th>
            <th scope="col">{t('network.logPurpose')}</th>
            <th scope="col">{t('network.logUrl')}</th>
            <th scope="col">{t('network.logOutcome')}</th>
          </tr>
        </thead>
        <tbody>
          {load.entries.map((e) => (
            <tr key={entryKey(e)}>
              <td className={s.time}>{formatLogTime(e.atUnixMs, locale)}</td>
              <td className={s.purpose}>{t(`common:netPurpose.${e.purpose}`)}</td>
              <td className={s.url} title={e.url}>
                <span className="selectable">{e.url}</span>
              </td>
              <td className={s.outcome}>
                <Badge tone={outcomeTone(e.outcome)}>{e.outcome}</Badge>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
