import { Download, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button, Progress } from '../../../components/ui';
import { formatBytes } from '../../../lib/format';
import { useApp } from '../../../state/app';
import { useUpdates } from '../../../state/updates';
import { Group, StaticRow } from '../page/controls';
import { SETTINGS_SECTIONS } from '../page/ids';
import { openSection } from '../page/navigation';

/** Installed version, the last update check and the install button. */
export function UpdatesGroup() {
  const { t } = useTranslation('settings');
  const version = useApp((st) => st.info?.version ?? '');
  const allowed = useApp((st) => st.settings?.network.allowUpdateChecks ?? false);
  const { phase, outcome, progress, installError, check, install } = useUpdates();

  let status: string;
  if (phase === 'checking') status = t('general.updates.checking');
  else if (phase === 'handedOver') status = t('general.updates.handedOver');
  else if (phase === 'ready') status = t('general.updates.ready');
  else if (phase === 'downloading')
    status = progress
      ? progress.total
        ? t('general.updates.downloading', { done: formatBytes(progress.downloaded), total: formatBytes(progress.total) })
        : t('general.updates.downloadingUnknown', { done: formatBytes(progress.downloaded) })
      : t('general.updates.preparing');
  else if (!allowed) status = t('general.updates.disabled');
  else if (installError) status = t('general.updates.installFailed', { message: installError });
  // "disabled" is an answer from before the switch was turned on.
  else if (!outcome || outcome.result === 'disabled') status = t('general.updates.notChecked');
  else if (outcome.result === 'available') status = t('general.updates.available', { version: outcome.version });
  else if (outcome.result === 'upToDate') status = t('general.updates.upToDate');
  else status = t('general.updates.failed', { message: outcome.message });

  const available = outcome?.result === 'available' ? outcome : null;
  const busy = phase === 'checking' || phase === 'downloading' || phase === 'handedOver';

  return (
    <Group title={t('general.updates.title')}>
      <StaticRow label={t('general.updates.version')}>
        <span>{t('general.updates.versionValue', { version })}</span>
      </StaticRow>
      <StaticRow label={t('general.updates.label')} hint={<span role="status">{status}</span>}>
        {!allowed ? (
          <Button size="sm" onClick={() => openSection('settings', SETTINGS_SECTIONS.network)}>
            {t('general.updates.openNetwork')}
          </Button>
        ) : available && phase !== 'checking' ? (
          <Button size="sm" variant="primary" icon={<Download size={14} />} loading={busy} onClick={() => void install()}>
            {phase === 'ready' ? t('general.updates.installReady') : t('general.updates.install', { version: available.version })}
          </Button>
        ) : (
          <Button size="sm" icon={<RefreshCw size={14} />} loading={phase === 'checking'} onClick={() => void check()}>
            {t('general.updates.check')}
          </Button>
        )}
      </StaticRow>
      {phase === 'downloading' && progress?.total ? (
        <StaticRow label={t('general.updates.progress')} wide>
          <Progress value={progress.downloaded / progress.total} label={t('general.updates.progress')} />
        </StaticRow>
      ) : null}
      {available?.notes && (
        <StaticRow label={t('general.updates.notes')} wide>
          <span>{available.notes}</span>
        </StaticRow>
      )}
    </Group>
  );
}
