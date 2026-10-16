// The messages Ylide itself sends to agents during a run.

import { useTranslation } from 'react-i18next';
import type { PromptTemplates } from '../../../bindings/PromptTemplates';
import { availablePlaceholders, TEMPLATE_KEYS, templateIssues } from '../logic/templates';
import { Group, GroupResetButton } from '../page/controls';
import { PromptEditor } from '../page/PromptEditor';
import s from './TemplatesEditor.module.css';

const braces = (names: string[]) => names.map((n) => `{${n}}`).join(', ');

export function TemplatesEditor({ templates, defaults }: { templates: PromptTemplates; defaults: PromptTemplates | undefined }) {
  const { t } = useTranslation('settings');
  const allDefault = defaults !== undefined && TEMPLATE_KEYS.every((k) => templates[k] === defaults[k]);

  const issues = (known: readonly string[]) => (draft: string) => {
    const { unknown, missing } = templateIssues(draft, known);
    if (!unknown.length && !missing.length) return null;
    return (
      <span className={s.issues}>
        {unknown.length > 0 && <span className={s.unknown}>{t('templates.unknown', { names: braces(unknown) })}</span>}
        {missing.length > 0 && <span>{t('templates.missing', { names: braces(missing) })}</span>}
      </span>
    );
  };

  return (
    <Group
      title={t('templates.title')}
      description={t('templates.description')}
      actions={(save) => (
        <GroupResetButton
          disabled={!defaults || allDefault}
          onReset={() =>
            defaults &&
            save((d) => {
              d.agent.templates = structuredClone(defaults);
            })
          }
        >
          {t('templates.resetAll')}
        </GroupResetButton>
      )}
    >
      {(save) =>
        TEMPLATE_KEYS.map((key) => {
          const known = availablePlaceholders(key, defaults?.[key]);
          return (
            <PromptEditor
              key={key}
              label={t(`templates.${key}.label`)}
              hint={t(`templates.${key}.hint`)}
              value={templates[key]}
              defaultValue={defaults?.[key]}
              rows={Math.min(8, Math.max(3, (defaults?.[key] ?? templates[key]).split('\n').length + 1))}
              placeholders={known}
              issues={issues(known)}
              onSave={(v) =>
                save((d) => {
                  d.agent.templates[key] = v;
                })
              }
            />
          );
        })
      }
    </Group>
  );
}
