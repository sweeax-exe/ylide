// Where the model list comes from, and fetching a newer one.

import { RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { localeOf } from '../../../i18n';
import type { RefreshOutcome } from '../../../bindings/RefreshOutcome';
import { Badge, Button } from '../../../components/ui';
import { errorText } from '../../../lib/errors';
import { api } from '../../../lib/ipc';
import { useApp } from '../../../state/app';
import { Panel } from '../page/controls';
import { keepFocusInSection } from '../page/focus';
import { MODEL_SECTIONS, SETTINGS_SECTIONS } from '../page/ids';
import { openSection } from '../page/navigation';
import { PageSection } from '../page/Page';
import s from './RegistryCard.module.css';

type Outcome = RefreshOutcome | { result: 'error'; message: string };

export function RegistryCard() {
  const { t, i18n } = useTranslation('settings');
  const registry = useApp((st) => st.registry);
  const origin = useApp((st) => st.registryOrigin);
  const allowed = useApp((st) => st.settings?.network.allowRegistryUpdates ?? false);
  const url = useApp((st) => st.settings?.network.registryUrl ?? '');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const refresh = async (from: HTMLElement) => {
    const restoreFocus = keepFocusInSection(from);
    setBusy(true);
    setOutcome(null);
    try {
      setOutcome(await api.registry.refresh());
    } catch (e) {
      setOutcome({ result: 'error', message: errorText(e) });
    } finally {
      setBusy(false);
      restoreFocus();
    }
  };

  const locale = localeOf(i18n.language);
  const updated = registry ? new Date(registry.updatedAt) : null;
  const updatedText = updated && !Number.isNaN(updated.getTime()) ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(updated) : (registry?.updatedAt ?? '–');

  const outcomeText = (o: Outcome) => {
    switch (o.result) {
      case 'updated':
        return t('registry.updated', { version: o.version });
      case 'upToDate':
        return t('registry.upToDate');
      case 'disabled':
        return t('registry.disabled');
      case 'failed':
      case 'error':
        return t('registry.failed', { message: o.message });
    }
  };
  const outcomeTone = (o: Outcome) => (o.result === 'failed' || o.result === 'error' ? s.bad : o.result === 'disabled' ? s.warn : s.good);

  return (
    <PageSection
      id={MODEL_SECTIONS.registry}
      title={t('registry.title')}
      description={t('registry.description')}
      actions={
        <Button size="sm" icon={<RefreshCw size={13} />} loading={busy} disabled={!allowed} title={!allowed ? t('registry.disabled') : undefined} onClick={(e) => void refresh(e.currentTarget)}>
          {t('registry.refresh')}
        </Button>
      }
    >
      <Panel>
      <dl className={s.list}>
        <div className={s.item}>
          <dt>{t('registry.version')}</dt>
          <dd className="tabular">{registry?.registryVersion ?? '–'}</dd>
        </div>
        <div className={s.item}>
          <dt>{t('registry.updatedAt')}</dt>
          <dd className="tabular">{updatedText}</dd>
        </div>
        <div className={s.item}>
          <dt>{t('registry.origin')}</dt>
          <dd className={s.originLine}>
            {origin && <Badge tone={origin === 'remote' ? 'accent' : origin === 'cache' ? 'neutral' : 'metal'}>{t(`registry.originName.${origin}`)}</Badge>}
            <span className={s.muted}>{origin ? t(`registry.originHint.${origin}`) : '–'}</span>
          </dd>
        </div>
        <div className={s.item}>
          <dt>{t('registry.models')}</dt>
          <dd className="tabular">{registry?.models.length ?? 0}</dd>
        </div>
        <div className={s.item}>
          <dt>{t('registry.url')}</dt>
          <dd>
            <code className={`${s.url} selectable`} title={url}>
              {url}
            </code>
          </dd>
        </div>
      </dl>
      <div className={s.foot} role="status" aria-live="polite">
        {outcome ? (
          <span className={outcomeTone(outcome)}>{outcomeText(outcome)}</span>
        ) : !allowed ? (
          <span className={s.muted}>
            {t('registry.disabledHint')}{' '}
            <button type="button" className={s.link} onClick={() => openSection('settings', SETTINGS_SECTIONS.network)}>
              {t('catalog.openNetwork')}
            </button>
          </span>
        ) : (
          <span className={s.muted}>{t('registry.refreshHint')}</span>
        )}
      </div>
      </Panel>
    </PageSection>
  );
}
