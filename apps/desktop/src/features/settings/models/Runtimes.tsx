// llama.cpp runtimes: installed, in use, and downloadable for this machine.

import { Download } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { RuntimeInstall } from '../../../bindings/RuntimeInstall';
import { Badge, Button, Progress, Spinner } from '../../../components/ui';
import { errorText, reportError } from '../../../lib/errors';
import { formatBytes, formatNumber } from '../../../lib/format';
import { api } from '../../../lib/ipc';
import { useApp } from '../../../state/app';
import { Note } from '../page/controls';
import { keepFocusInSection } from '../page/focus';
import { MODEL_SECTIONS, SETTINGS_SECTIONS } from '../page/ids';
import { openSection } from '../page/navigation';
import { saveSettings } from '../page/save';
import { PageSection } from '../page/Page';
import s from './Runtimes.module.css';

export function Runtimes() {
  const { t } = useTranslation('settings');
  const runtime = useApp((st) => st.runtime);
  // The event-driven state, or the install the core reported before any event arrived (e.g. one started before this window opened).
  const install = useApp((st) => st.runtimeInstall ?? st.runtime?.install ?? null);
  const override = useApp((st) => st.settings?.models.runtimeVariant ?? null);
  const allowed = useApp((st) => st.settings?.network.allowRuntimeDownloads ?? false);
  const server = useApp((st) => st.server);
  const [pending, setPending] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // The store loads the status after the hardware probe and does not report
  // failures; ask once more here so a failed load ends in a visible state.
  const load = useCallback(() => {
    setLoadError(null);
    useApp
      .getState()
      .refreshRuntime()
      .catch((e: unknown) => setLoadError(errorText(e)));
  }, []);
  useEffect(() => {
    if (!useApp.getState().runtime) load();
  }, [load]);

  const choose = async (variant: string | null, from: HTMLElement) => {
    // The button turns into a badge (or disappears for "Choose automatically").
    const restoreFocus = keepFocusInSection(from);
    setPending(variant ?? 'auto');
    try {
      await saveSettings((d) => {
        d.models.runtimeVariant = variant;
      });
      await useApp.getState().refreshRuntime();
    } catch (e) {
      reportError(e);
    } finally {
      setPending(null);
      restoreFocus();
    }
  };

  const installRuntime = async (variant: string, from: HTMLElement) => {
    const restoreFocus = keepFocusInSection(from);
    setPending(variant);
    try {
      await api.runtime.install(variant);
    } catch (e) {
      reportError(e);
    } finally {
      setPending(null);
      restoreFocus();
    }
  };

  const installing = install && (install.state.state === 'downloading' || install.state.state === 'extracting') ? install.variant : null;

  return (
    <PageSection
      id={MODEL_SECTIONS.runtimes}
      title={t('runtimes.title')}
      description={t('runtimes.description')}
      actions={
        override && (
          <Button size="sm" variant="ghost" loading={pending === 'auto'} onClick={(e) => void choose(null, e.currentTarget)}>
            {t('runtimes.chooseAuto')}
          </Button>
        )
      }
    >
      {!runtime && loadError ? (
        <Note
          tone="danger"
          action={
            <Button size="sm" onClick={load}>
              {t('common:actions.retry')}
            </Button>
          }
        >
          {t('runtimes.loadFailed', { message: loadError })}
        </Note>
      ) : !runtime ? (
        <div className={s.loading}>
          <Spinner label={t('runtimes.loading')} />
          <span>{t('runtimes.loading')}</span>
        </div>
      ) : (
        <div className={s.stack}>
          {override && <Note>{t('runtimes.fixed', { variant: override })}</Note>}
          <div className={s.tableWrap}>
            <table className={s.table}>
              <caption className="visually-hidden">{t('runtimes.installed')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('runtimes.variant')}</th>
                  <th scope="col">{t('runtimes.backend')}</th>
                  <th scope="col">{t('runtimes.version')}</th>
                  <th scope="col">{t('runtimes.origin')}</th>
                  <th scope="col" className={s.actionHead}>
                    <span className="visually-hidden">{t('runtimes.action')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {runtime.installed.length === 0 && (
                  <tr>
                    <td colSpan={5} className={s.emptyCell}>
                      {t('runtimes.noneInstalled')}
                    </td>
                  </tr>
                )}
                {runtime.installed.map((r) => {
                  const selected = runtime.selected === r.variant;
                  return (
                    <tr key={r.variant} className={selected ? s.selected : undefined}>
                      <td>
                        <code className={s.variant} title={r.dir}>
                          {r.variant}
                        </code>
                      </td>
                      <td>{t(`common:backend.${r.backend}`)}</td>
                      <td className="tabular">{r.version}</td>
                      <td>{r.bundled ? <Badge>{t('runtimes.bundled')}</Badge> : <Badge tone="metal">{t('runtimes.downloaded')}</Badge>}</td>
                      <td className={s.actionCell}>
                        {selected ? (
                          <Badge tone="accent">{server && server.runtime === r.variant ? t('runtimes.inUse') : t('runtimes.selected')}</Badge>
                        ) : (
                          <Button size="sm" loading={pending === r.variant} onClick={(e) => void choose(r.variant, e.currentTarget)}>
                            {t('runtimes.use')}
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {runtime.downloadable.length > 0 && (
            <>
              <h4 id={`${MODEL_SECTIONS.runtimes}-available`} className={s.subTitle}>
                {t('runtimes.available')}
              </h4>
              {!allowed && (
                <Note
                  tone="warning"
                  action={
                    <Button size="sm" onClick={() => openSection('settings', SETTINGS_SECTIONS.network)}>
                      {t('catalog.openNetwork')}
                    </Button>
                  }
                >
                  {t('runtimes.downloadsOff')}
                </Note>
              )}
              <div className={s.tableWrap}>
                <table className={s.table} aria-labelledby={`${MODEL_SECTIONS.runtimes}-available`}>
                  <thead>
                    <tr>
                      <th scope="col">{t('runtimes.variant')}</th>
                      <th scope="col">{t('runtimes.backend')}</th>
                      <th scope="col">{t('runtimes.version')}</th>
                      <th scope="col" className={s.num}>
                        {t('runtimes.size')}
                      </th>
                      <th scope="col" className={s.actionHead}>
                        <span className="visually-hidden">{t('runtimes.action')}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {runtime.downloadable.map((r) => (
                      <tr key={r.variant}>
                        <td>
                          <span className={s.variantLine}>
                            <code className={s.variant}>{r.variant}</code>
                            {r.recommended && <Badge tone="accent">{t('runtimes.recommended')}</Badge>}
                          </span>
                        </td>
                        <td>{t(`common:backend.${r.backend}`)}</td>
                        <td className="tabular">{r.version}</td>
                        <td className={s.num}>{formatBytes(r.sizeBytes)}</td>
                        <td className={s.actionCell}>
                          {installing === r.variant && install ? (
                            <InstallProgress install={install} />
                          ) : (
                            <Button
                              size="sm"
                              variant={r.recommended ? 'primary' : 'secondary'}
                              icon={<Download size={13} />}
                              loading={pending === r.variant}
                              disabled={!allowed || installing !== null}
                              title={!allowed ? t('runtimes.downloadsOff') : installing ? t('runtimes.busy') : undefined}
                              aria-label={t('runtimes.installNamed', { variant: r.variant })}
                              onClick={(e) => void installRuntime(r.variant, e.currentTarget)}
                            >
                              {t('runtimes.install')}
                            </Button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {install?.state.state === 'failed' && <Note tone="danger">{t('runtimes.failed', { variant: install.variant, message: install.state.message })}</Note>}
          {install?.state.state === 'done' && <Note>{t('runtimes.done', { variant: install.variant })}</Note>}
          <p className={s.hint}>{t('runtimes.applyHint')}</p>
        </div>
      )}
    </PageSection>
  );
}

function InstallProgress({ install }: { install: RuntimeInstall }) {
  const { t } = useTranslation('settings');
  if (install.state.state === 'extracting') {
    return (
      <span className={s.progress}>
        <Spinner label={t('runtimes.extracting')} />
        <span>{t('runtimes.extracting')}</span>
      </span>
    );
  }
  const p = install.state.state === 'downloading' ? install.state.progress : null;
  const value = p && p.totalBytes > 0 ? p.downloadedBytes / p.totalBytes : 0;
  return (
    <span className={s.progress}>
      <span className={s.progressBar}>
        <Progress value={value} label={t('runtimes.progressLabel', { variant: install.variant })} />
      </span>
      <span className="tabular">{t('runtimes.percent', { percent: formatNumber(value * 100) })}</span>
      {p && p.bytesPerSecond > 0 && <span className="tabular">{t('downloads.speed', { speed: formatBytes(p.bytesPerSecond) })}</span>}
    </span>
  );
}
