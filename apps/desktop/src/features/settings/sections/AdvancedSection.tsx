import { FolderOpen, RotateCcw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AppInfo } from '../../../bindings/AppInfo';
import type { Settings } from '../../../bindings/Settings';
import { Button, Select } from '../../../components/ui';
import { reportError } from '../../../lib/errors';
import { formatTokens } from '../../../lib/format';
import { api, pickFolder } from '../../../lib/ipc';
import { modelName, useApp } from '../../../state/app';
import { Group, LinesSetting, Note, NumberSetting, Row, StaticRow, SwitchRow } from '../page/controls';
import { keepFocusInSection } from '../page/focus';
import { SETTINGS_SECTIONS } from '../page/ids';
import { PageSection } from '../page/Page';
import s from './AdvancedSection.module.css';
import { AppPaths } from './AppPaths';
import { EndpointForm } from './EndpointForm';

/** App info is re-read after the models folder changes, so the shown path is the core's. */
function useAppInfo(): [AppInfo | null, () => void] {
  const fallback = useApp((st) => st.info);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const reload = useCallback(() => {
    api.appInfo().then(setInfo, reportError);
  }, []);
  useEffect(reload, [reload]);
  return [info ?? fallback, reload];
}

export function AdvancedSection({ settings }: { settings: Settings }) {
  const { t } = useTranslation('settings');
  const [info, reloadInfo] = useAppInfo();
  const runtime = useApp((st) => st.runtime);
  const registry = useApp((st) => st.registry);
  const server = useApp((st) => st.server);
  const models = settings.models;
  const chatModel = models.chat ? registry?.models.find((m) => m.id === models.chat?.modelId) : undefined;
  const [restarting, setRestarting] = useState(false);
  const changeDir = useRef<HTMLButtonElement>(null);

  const restart = async (from: HTMLElement) => {
    const restoreFocus = keepFocusInSection(from);
    setRestarting(true);
    try {
      await api.server.stop();
      await api.server.start();
    } catch (e) {
      reportError(e);
    } finally {
      setRestarting(false);
      restoreFocus();
    }
  };

  return (
    <PageSection id={SETTINGS_SECTIONS.advanced} title={t('advanced.title')} description={t('advanced.description')}>
      <Group title={t('advanced.storageTitle')}>
        {(save) => (
          <StaticRow wide label={t('advanced.modelsDir.label')} hint={t('advanced.modelsDir.hint')}>
            <div className={s.pathLine}>
              <code className={`${s.path} selectable`} title={models.dir ?? info?.modelsDir}>
                {models.dir ?? info?.modelsDir ?? '…'}
              </code>
              <Button
                ref={changeDir}
                size="sm"
                icon={<FolderOpen size={13} />}
                onClick={async () => {
                  try {
                    const dir = await pickFolder();
                    if (!dir) return;
                    if (
                      await save((d) => {
                        d.models.dir = dir;
                      })
                    )
                      reloadInfo();
                  } catch (e) {
                    reportError(e);
                  }
                }}
              >
                {t('advanced.modelsDir.change')}
              </Button>
              {models.dir !== null && (
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<RotateCcw size={13} />}
                  onClick={async () => {
                    const ok = await save((d) => {
                      d.models.dir = null;
                    });
                    if (!ok) return;
                    reloadInfo();
                    // This button disappears with the custom folder; keep focus next to it.
                    changeDir.current?.focus();
                  }}
                >
                  {t('advanced.modelsDir.useDefault')}
                </Button>
              )}
            </div>
          </StaticRow>
        )}
      </Group>

      <Group title={t('advanced.serverTitle')} description={t('advanced.serverDescription')}>
        {(save) => (
          <>
            <Row label={t('advanced.slots.label')} hint={t('advanced.slots.hint')}>
              {({ id, describedBy }) => (
                <NumberSetting
                  id={id}
                  describedBy={describedBy}
                  value={models.slots}
                  rule={{ min: 1, max: 16, integer: true }}
                  unit={t('units.slots')}
                  onCommit={(v) =>
                    v !== null &&
                    save((d) => {
                      d.models.slots = v;
                    })
                  }
                />
              )}
            </Row>
            <Row
              label={t('advanced.context.label')}
              hint={chatModel ? t('advanced.context.hintModel', { model: chatModel.name, tokens: formatTokens(chatModel.context.recommended), max: formatTokens(chatModel.context.max) }) : t('advanced.context.hint')}
            >
              {({ id, describedBy }) => (
                <NumberSetting
                  id={id}
                  describedBy={describedBy}
                  value={models.context}
                  rule={{ min: 512, max: 1_048_576, integer: true, optional: true }}
                  unit={t('units.tokens')}
                  placeholder={t('advanced.context.placeholder')}
                  onCommit={(v) =>
                    save((d) => {
                      d.models.context = v;
                    })
                  }
                />
              )}
            </Row>
            <Row label={t('advanced.runtime.label')} hint={t('advanced.runtime.hint')}>
              {({ id, describedBy }) => (
                <Select
                  id={id}
                  aria-describedby={describedBy}
                  value={models.runtimeVariant ?? ''}
                  onChange={async (e) => {
                    const v = e.target.value || null;
                    const ok = await save((d) => {
                      d.models.runtimeVariant = v;
                    });
                    // The core re-selects the runtime; show which one it picked.
                    if (ok) await useApp.getState().refreshRuntime().catch(reportError);
                  }}
                >
                  <option value="">{runtime?.selected && !models.runtimeVariant ? t('advanced.runtime.autoCurrent', { variant: runtime.selected }) : t('advanced.runtime.auto')}</option>
                  {runtime?.installed.map((r) => (
                    <option key={r.variant} value={r.variant}>
                      {t('advanced.runtime.option', { variant: r.variant, backend: t(`common:backend.${r.backend}`), version: r.version })}
                    </option>
                  ))}
                  {models.runtimeVariant && !runtime?.installed.some((r) => r.variant === models.runtimeVariant) && (
                    <option value={models.runtimeVariant}>{t('advanced.runtime.missing', { variant: models.runtimeVariant })}</option>
                  )}
                </Select>
              )}
            </Row>
            <SwitchRow
              label={t('advanced.kvQuant.label')}
              hint={t('advanced.kvQuant.hint')}
              checked={models.quantizeKv}
              onChange={(v) =>
                void save((d) => {
                  d.models.quantizeKv = v;
                })
              }
            />
            <Row label={t('advanced.extraArgs.label')} hint={t('advanced.extraArgs.hint')} wide>
              {({ id, describedBy }) => (
                <LinesSetting
                  id={id}
                  describedBy={describedBy}
                  rows={4}
                  value={models.extraArgs}
                  placeholder={t('advanced.extraArgs.placeholder')}
                  onCommit={(v) =>
                    save((d) => {
                      d.models.extraArgs = v;
                    })
                  }
                />
              )}
            </Row>
            <SwitchRow
              label={t('advanced.autostart.label')}
              hint={chatModel ? t('advanced.autostart.hintModel', { model: modelName(registry, chatModel.id) }) : t('advanced.autostart.hint')}
              checked={models.autostart}
              onChange={(v) =>
                void save((d) => {
                  d.models.autostart = v;
                })
              }
            />
          </>
        )}
      </Group>
      {server && server.runtime !== 'external' && (
        <div className={s.applyNote}>
          <Note
            action={
              <Button size="sm" loading={restarting} onClick={(e) => void restart(e.currentTarget)}>
                {t('advanced.restart')}
              </Button>
            }
          >
            {t('advanced.appliesOnRestart')}
          </Note>
        </div>
      )}

      <EndpointForm endpoint={settings.endpoint} />
      <AppPaths info={info} />
    </PageSection>
  );
}
