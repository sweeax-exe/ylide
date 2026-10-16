// Every option and every prompt Ylide uses, visible and editable.

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Spinner } from '../../components/ui';
import { SETTINGS_SECTIONS } from './page/ids';
import { Page } from './page/Page';
import { useSettings } from './page/save';
import { AdvancedSection } from './sections/AdvancedSection';
import { AgentsSection } from './sections/AgentsSection';
import { ChatSection } from './sections/ChatSection';
import { EditorSection } from './sections/EditorSection';
import { GeneralSection } from './sections/GeneralSection';
import { NetworkSection } from './sections/NetworkSection';
import s from './Views.module.css';

export function SettingsView() {
  const { t } = useTranslation('settings');
  const settings = useSettings();
  const sections = useMemo(
    () => [
      { id: SETTINGS_SECTIONS.general, title: t('general.title') },
      { id: SETTINGS_SECTIONS.editor, title: t('editor.title') },
      { id: SETTINGS_SECTIONS.chat, title: t('chat.title') },
      { id: SETTINGS_SECTIONS.agents, title: t('agents.title') },
      { id: SETTINGS_SECTIONS.network, title: t('network.title') },
      { id: SETTINGS_SECTIONS.advanced, title: t('advanced.title') },
    ],
    [t],
  );

  if (!settings) {
    return (
      <div className={s.loading}>
        <Spinner label={t('page.loading')} />
      </div>
    );
  }

  return (
    <Page view="settings" title={t('page.title')} intro={t('page.intro')} sections={sections}>
      <GeneralSection settings={settings} />
      <EditorSection settings={settings} />
      <ChatSection settings={settings} />
      <AgentsSection settings={settings} />
      <NetworkSection settings={settings} />
      <AdvancedSection settings={settings} />
    </Page>
  );
}
