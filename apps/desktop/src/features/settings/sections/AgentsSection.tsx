import { useTranslation } from 'react-i18next';
import type { ApprovalMode } from '../../../bindings/ApprovalMode';
import type { Settings } from '../../../bindings/Settings';
import { Group, GroupResetButton, LinesSetting, NumberSetting, Row, StaticRow, SwitchRow, TextSetting } from '../page/controls';
import { useDefaults } from '../page/defaults';
import { SETTINGS_SECTIONS } from '../page/ids';
import { PageSection } from '../page/Page';
import s from './AgentsSection.module.css';
import { CommandList } from './CommandList';
import { RolesEditor } from './RolesEditor';
import { TemplatesEditor } from './TemplatesEditor';

const MODES: ApprovalMode[] = ['ask', 'autoSafe', 'autonomous'];

export function AgentsSection({ settings }: { settings: Settings }) {
  const { t } = useTranslation('settings');
  const defaults = useDefaults();
  const agent = settings.agent;
  const perms = agent.permissions;
  const askMode = perms.mode === 'ask';
  // The confirm switches only matter in autonomous mode (see crates/agent permissions).
  const guarded = perms.mode !== 'autonomous';

  return (
    <PageSection id={SETTINGS_SECTIONS.agents} title={t('agents.title')} description={t('agents.description')}>
      <Group title={t('agents.approvalsTitle')} description={t('agents.approvalsDescription')}>
        {(save) => (
          <>
            <StaticRow wide label={t('agents.mode.label')}>
              <div className={s.modes} role="radiogroup" aria-label={t('agents.mode.label')}>
                {MODES.map((mode) => (
                  <label key={mode} className={s.mode}>
                    <input
                      type="radio"
                      name="approval-mode"
                      value={mode}
                      checked={perms.mode === mode}
                      onChange={() =>
                        void save((d) => {
                          d.agent.permissions.mode = mode;
                        })
                      }
                    />
                    <span className={s.modeTitle}>{t(`agents.mode.${mode}.title`)}</span>
                    <span className={s.modeBody}>{t(`agents.mode.${mode}.body`)}</span>
                  </label>
                ))}
              </div>
            </StaticRow>
            <SwitchRow
              label={t('agents.confirmCommands.label')}
              hint={guarded ? t('agents.onlyAutonomous') : t('agents.confirmCommands.hint')}
              warning={!perms.confirmCommands && !guarded ? t('agents.confirmCommands.off') : undefined}
              checked={perms.confirmCommands}
              onChange={(v) =>
                void save((d) => {
                  d.agent.permissions.confirmCommands = v;
                })
              }
            />
            <SwitchRow
              label={t('agents.confirmDeletes.label')}
              hint={guarded ? t('agents.onlyAutonomous') : t('agents.confirmDeletes.hint')}
              warning={!perms.confirmDeletes && !guarded ? t('agents.confirmDeletes.off') : undefined}
              checked={perms.confirmDeletes}
              onChange={(v) =>
                void save((d) => {
                  d.agent.permissions.confirmDeletes = v;
                })
              }
            />
          </>
        )}
      </Group>

      <Group title={t('agents.commands.title')} description={t('agents.commands.description')} flush>
        {(save) => <CommandList commands={perms.allowedCommands} askMode={askMode} save={save} />}
      </Group>

      <Group title={t('agents.reviewTitle')}>
        {(save) => (
          <>
            <SwitchRow
              label={t('agents.reviewEnabled.label')}
              hint={t('agents.reviewEnabled.hint')}
              checked={agent.reviewEnabled}
              onChange={(v) =>
                void save((d) => {
                  d.agent.reviewEnabled = v;
                })
              }
            />
            <Row label={t('agents.maxReviewRounds.label')} hint={t('agents.maxReviewRounds.hint')}>
              {({ id, describedBy }) => (
                <NumberSetting
                  id={id}
                  describedBy={describedBy}
                  value={agent.maxReviewRounds}
                  disabled={!agent.reviewEnabled}
                  rule={{ min: 0, max: 10, integer: true }}
                  unit={t('units.rounds')}
                  onCommit={(v) =>
                    v !== null &&
                    save((d) => {
                      d.agent.maxReviewRounds = v;
                    })
                  }
                />
              )}
            </Row>
          </>
        )}
      </Group>

      <Group
        title={t('agents.shellTitle')}
        description={t('agents.shellDescription')}
        actions={(save) => (
          <GroupResetButton
            disabled={!defaults || JSON.stringify(defaults.agent.shell) === JSON.stringify(agent.shell)}
            onReset={() =>
              defaults &&
              save((d) => {
                d.agent.shell = structuredClone(defaults.agent.shell);
              })
            }
          >
            {t('common:actions.reset')}
          </GroupResetButton>
        )}
      >
        {(save) => {
          const shell = agent.shell;
          return (
            <>
              <Row label={t('agents.shellProgram.label')} hint={t('agents.shellProgram.hint')}>
                {({ id, describedBy }) => (
                  <TextSetting
                    id={id}
                    describedBy={describedBy}
                    mono
                    value={shell.program}
                    validate={(v) => (v.trim() ? null : t('validation.required'))}
                    onCommit={(v) =>
                      save((d) => {
                        d.agent.shell.program = v.trim();
                      })
                    }
                  />
                )}
              </Row>
              <Row label={t('agents.shellArgs.label')} hint={t('agents.shellArgs.hint')}>
                {({ id, describedBy }) => (
                  <LinesSetting
                    id={id}
                    describedBy={describedBy}
                    rows={4}
                    value={shell.args}
                    onCommit={(v) =>
                      save((d) => {
                        d.agent.shell.args = v;
                      })
                    }
                  />
                )}
              </Row>
              <Row label={t('agents.shellTimeout.label')} hint={t('agents.shellTimeout.hint')}>
                {({ id, describedBy }) => (
                  <NumberSetting
                    id={id}
                    describedBy={describedBy}
                    value={shell.defaultTimeoutSecs}
                    rule={{ min: 1, max: 86_400, integer: true }}
                    unit={t('units.seconds')}
                    onCommit={(v) =>
                      v !== null &&
                      save((d) => {
                        d.agent.shell.defaultTimeoutSecs = v;
                      })
                    }
                  />
                )}
              </Row>
              <Row label={t('agents.shellOutput.label')} hint={t('agents.shellOutput.hint')}>
                {({ id, describedBy }) => (
                  <NumberSetting
                    id={id}
                    describedBy={describedBy}
                    value={shell.maxOutputChars}
                    rule={{ min: 1000, max: 1_000_000, integer: true }}
                    unit={t('units.characters')}
                    onCommit={(v) =>
                      v !== null &&
                      save((d) => {
                        d.agent.shell.maxOutputChars = v;
                      })
                    }
                  />
                )}
              </Row>
            </>
          );
        }}
      </Group>

      <RolesEditor roles={agent.roles} defaults={defaults?.agent.roles} />
      <TemplatesEditor templates={agent.templates} defaults={defaults?.agent.templates} />
    </PageSection>
  );
}
