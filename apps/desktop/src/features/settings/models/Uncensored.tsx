// The marker of an uncensored variant (refusal training removed), the same in
// the catalog, under Installed models and for the running model.

import { ShieldOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Badge } from '../../../components/ui';
import { Note } from '../page/controls';

export function UncensoredBadge() {
  const { t } = useTranslation('settings');
  return (
    <>
      <Badge tone="warning" title={t('catalog.uncensored.badgeHint')}>
        <ShieldOff size={12} aria-hidden />
        {t('catalog.uncensored.badge')}
      </Badge>
      {/* The tooltip explains the badge; say it for screen readers too. */}
      <span className="visually-hidden">: {t('catalog.uncensored.badgeHint')}</span>
    </>
  );
}

/** What uncensored variants are, above their group and in each one's details. */
export function UncensoredNote() {
  const { t } = useTranslation('settings');
  return (
    <Note tone="warning" icon={<ShieldOff size={15} aria-hidden />}>
      {t('catalog.uncensored.note')}
    </Note>
  );
}
