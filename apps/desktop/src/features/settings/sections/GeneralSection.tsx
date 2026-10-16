import { useTranslation } from 'react-i18next';
import type { Settings } from '../../../bindings/Settings';
import type { ThemeChoice } from '../../../bindings/ThemeChoice';
import { LanguageSelect } from '../../../components/LanguageSelect';
import { Segmented } from '../../../components/ui';
import { detectLanguage, languageName } from '../../../i18n';
import { Group, StaticRow } from '../page/controls';
import { SETTINGS_SECTIONS } from '../page/ids';
import { PageSection } from '../page/Page';
import { UpdatesGroup } from './UpdatesGroup';

export function GeneralSection({ settings }: { settings: Settings }) {
  const { t } = useTranslation('settings');
  const systemLanguage = detectLanguage(null);

  return (
    <PageSection id={SETTINGS_SECTIONS.general} title={t('general.title')} description={t('general.description')}>
      <Group title={t('general.lookTitle')}>
        {(save) => (
          <>
            <StaticRow label={t('general.language.label')} hint={t('general.language.hint', { language: languageName(systemLanguage) })}>
              <LanguageSelect
                label={t('general.language.label')}
                systemLabel={t('general.language.system')}
                value={settings.language}
                onChange={(v) =>
                  void save((d) => {
                    d.language = v;
                  })
                }
              />
            </StaticRow>
            <StaticRow label={t('general.theme.label')} hint={t('general.theme.hint')}>
              <Segmented<ThemeChoice>
                label={t('general.theme.label')}
                value={settings.theme}
                options={[
                  { value: 'dark', label: t('general.theme.dark') },
                  { value: 'light', label: t('general.theme.light') },
                  { value: 'system', label: t('general.theme.system') },
                ]}
                onChange={(v) =>
                  void save((d) => {
                    d.theme = v;
                  })
                }
              />
            </StaticRow>
          </>
        )}
      </Group>
      <UpdatesGroup />
    </PageSection>
  );
}
