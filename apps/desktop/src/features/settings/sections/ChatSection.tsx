import { useTranslation } from 'react-i18next';
import type { Settings } from '../../../bindings/Settings';
import { formatTokens } from '../../../lib/format';
import { Button } from '../../../components/ui';
import { reportError } from '../../../lib/errors';
import { api } from '../../../lib/ipc';
import { useConfirm } from '../../../state/confirm';
import { useToasts } from '../../../state/toasts';
import { useChat } from '../../chat/store';
import { Group, NumberSetting, ResetButton, Row, StaticRow, SwitchRow } from '../page/controls';
import { useDefaults } from '../page/defaults';
import { SETTINGS_SECTIONS } from '../page/ids';
import { PageSection } from '../page/Page';
import { PromptEditor } from '../page/PromptEditor';

async function deleteAllChats(t: (key: string) => string) {
  const ok = await useConfirm.getState().ask({
    title: t('chat.deleteAll.confirmTitle'),
    body: t('chat.deleteAll.confirmBody'),
    confirmLabel: t('chat.deleteAll.confirm'),
    danger: true,
  });
  if (!ok) return;
  // The chat on screen goes first, so no save of it can follow the delete.
  useChat.getState().forgetHistory();
  try {
    await api.chats.removeAll();
    useToasts.getState().push({ tone: 'success', title: t('chat.deleteAll.done') });
  } catch (e) {
    reportError(e);
    void useChat.getState().loadHistory();
  }
}

export function ChatSection({ settings }: { settings: Settings }) {
  const { t } = useTranslation('settings');
  const defaults = useDefaults();
  const chat = settings.chat;

  return (
    <PageSection id={SETTINGS_SECTIONS.chat} title={t('chat.title')} description={t('chat.description')}>
      <Group title={t('chat.chatTitle')}>
        {(save) => (
          <>
            <PromptEditor
              label={t('chat.systemPrompt.label')}
              hint={t('chat.systemPrompt.hint')}
              value={chat.systemPrompt}
              defaultValue={defaults?.chat.systemPrompt}
              rows={12}
              onSave={(v) =>
                save((d) => {
                  d.chat.systemPrompt = v;
                })
              }
            />
            <SwitchRow
              label={t('chat.history.label')}
              hint={t('chat.history.hint')}
              checked={chat.saveHistory}
              onChange={(v) =>
                void save((d) => {
                  d.chat.saveHistory = v;
                })
              }
            />
            <StaticRow label={t('chat.deleteAll.label')} hint={t('chat.deleteAll.hint')}>
              <Button size="sm" variant="danger" onClick={() => void deleteAllChats(t)}>
                {t('chat.deleteAll.button')}
              </Button>
            </StaticRow>
            <Row label={t('chat.contextBudget.label')} hint={t('chat.contextBudget.hint', { tokens: formatTokens(chat.contextBudgetTokens) })}>
              {({ id, describedBy }) => (
                <NumberSetting
                  id={id}
                  describedBy={describedBy}
                  value={chat.contextBudgetTokens}
                  rule={{ min: 1000, max: 1_000_000, integer: true }}
                  unit={t('units.tokens')}
                  onCommit={(v) =>
                    v !== null &&
                    save((d) => {
                      d.chat.contextBudgetTokens = v;
                    })
                  }
                  trailing={
                    <ResetButton
                      label={t('prompt.resetNamed', { name: t('chat.contextBudget.label') })}
                      fieldId={id}
                      visible={!!defaults && defaults.chat.contextBudgetTokens !== chat.contextBudgetTokens}
                      onReset={() =>
                        defaults &&
                        void save((d) => {
                          d.chat.contextBudgetTokens = defaults.chat.contextBudgetTokens;
                        })
                      }
                    />
                  }
                />
              )}
            </Row>
          </>
        )}
      </Group>
      <Group title={t('chat.inlineTitle')} description={t('chat.inlineDescription')}>
        {(save) => (
          <PromptEditor
            label={t('chat.inlinePrompt.label')}
            hint={t('chat.inlinePrompt.hint')}
            value={chat.inlinePrompt}
            defaultValue={defaults?.chat.inlinePrompt}
            rows={9}
            onSave={(v) =>
              save((d) => {
                d.chat.inlinePrompt = v;
              })
            }
          />
        )}
      </Group>
    </PageSection>
  );
}
