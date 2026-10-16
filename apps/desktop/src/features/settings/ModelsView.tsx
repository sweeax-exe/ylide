// Models, runtimes and the registry: what runs, what is installed, what is available.

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { ActiveModel } from './models/ActiveModel';
import { Catalog } from './models/Catalog';
import { Downloads } from './models/Downloads';
import { InstalledModels } from './models/InstalledModels';
import { RegistryCard } from './models/RegistryCard';
import { Runtimes } from './models/Runtimes';
import { MODEL_SECTIONS } from './page/ids';
import { Page, PageSection } from './page/Page';

export function ModelsView() {
  const { t } = useTranslation('settings');
  const sections = useMemo(
    () => [
      { id: MODEL_SECTIONS.active, title: t('active.title') },
      { id: MODEL_SECTIONS.installed, title: t('installed.title') },
      { id: MODEL_SECTIONS.downloads, title: t('downloads.title') },
      { id: MODEL_SECTIONS.catalog, title: t('catalog.title') },
      { id: MODEL_SECTIONS.runtimes, title: t('runtimes.title') },
      { id: MODEL_SECTIONS.registry, title: t('registry.title') },
    ],
    [t],
  );

  return (
    <Page view="models" title={t('modelsPage.title')} intro={t('modelsPage.intro')} sections={sections}>
      <PageSection id={MODEL_SECTIONS.active} title={t('active.title')} description={t('active.description')}>
        <ActiveModel />
      </PageSection>
      <InstalledModels />
      <Downloads />
      <Catalog />
      <Runtimes />
      <RegistryCard />
    </Page>
  );
}
