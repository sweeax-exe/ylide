import { ShieldCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Settings } from '../../../bindings/Settings';
import { isHttpUrl } from '../logic/forms';
import { Group, Note, ResetButton, Row, SwitchRow, TextSetting } from '../page/controls';
import { useDefaults } from '../page/defaults';
import { SETTINGS_SECTIONS } from '../page/ids';
import { PageSection } from '../page/Page';
import s from './NetworkSection.module.css';
import { NetworkLog } from './NetworkLog';

export function NetworkSection({ settings }: { settings: Settings }) {
  const { t } = useTranslation('settings');
  const defaults = useDefaults();
  const net = settings.network;

  return (
    <PageSection id={SETTINGS_SECTIONS.network} title={t('network.title')}>
      <div className={s.statement}>
        <Note tone="metal" icon={<ShieldCheck size={16} />}>
          <strong className={s.statementTitle}>{t('network.statementTitle')}</strong>
          <span className={s.statementBody}>{t('network.statementBody')}</span>
        </Note>
      </div>
      <Group title={t('network.allowedTitle')} description={t('network.allowedDescription')}>
        {(save) => (
          <>
            <SwitchRow
              label={t('network.registry.label')}
              hint={t('network.registry.hint')}
              checked={net.allowRegistryUpdates}
              onChange={(v) =>
                void save((d) => {
                  d.network.allowRegistryUpdates = v;
                })
              }
            />
            <Row label={t('network.registryUrl.label')} hint={t('network.registryUrl.hint')} wide>
              {({ id, describedBy }) => (
                <div className={s.urlLine}>
                  <TextSetting
                    id={id}
                    describedBy={describedBy}
                    mono
                    value={net.registryUrl}
                    validate={(v) => (isHttpUrl(v) ? null : t('validation.url'))}
                    onCommit={(v) =>
                      save((d) => {
                        d.network.registryUrl = v.trim();
                      })
                    }
                  />
                  <ResetButton
                    label={t('prompt.resetNamed', { name: t('network.registryUrl.label') })}
                    fieldId={id}
                    visible={!!defaults && defaults.network.registryUrl !== net.registryUrl}
                    onReset={() =>
                      defaults &&
                      void save((d) => {
                        d.network.registryUrl = defaults.network.registryUrl;
                      })
                    }
                  />
                </div>
              )}
            </Row>
            <SwitchRow
              label={t('network.models.label')}
              hint={t('network.models.hint')}
              checked={net.allowModelDownloads}
              onChange={(v) =>
                void save((d) => {
                  d.network.allowModelDownloads = v;
                })
              }
            />
            <SwitchRow
              label={t('network.runtimes.label')}
              hint={t('network.runtimes.hint')}
              checked={net.allowRuntimeDownloads}
              onChange={(v) =>
                void save((d) => {
                  d.network.allowRuntimeDownloads = v;
                })
              }
            />
            <SwitchRow
              label={t('network.updates.label')}
              hint={t('network.updates.hint')}
              checked={net.allowUpdateChecks}
              onChange={(v) =>
                void save((d) => {
                  d.network.allowUpdateChecks = v;
                })
              }
            />
          </>
        )}
      </Group>
      <Group title={t('network.logTitle')} description={t('network.logDescription')} flush>
        <NetworkLog />
      </Group>
    </PageSection>
  );
}
