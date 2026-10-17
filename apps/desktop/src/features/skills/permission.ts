// Skill downloads are a network door of their own and stay closed until the
// user opens it. These helpers ask the first time one is needed.

import i18n from '../../i18n';
import { useApp } from '../../state/app';
import { useConfirm } from '../../state/confirm';
import { saveSettings } from '../settings/page/save';

export const skillDownloadsAllowed = (): boolean => !!useApp.getState().settings?.network.allowSkillDownloads;

/** Switches skill downloads on (Settings › Network shows and switches it too). */
export function allowSkillDownloads(): Promise<void> {
  return saveSettings((d) => {
    d.network.allowSkillDownloads = true;
  });
}

/** True when skill downloads are allowed, after asking the user if they are not yet. */
export async function ensureSkillDownloads(): Promise<boolean> {
  if (skillDownloadsAllowed()) return true;
  const t = i18n.getFixedT(null, 'skills');
  const ok = await useConfirm.getState().ask({ title: t('permission.title'), body: t('permission.body'), confirmLabel: t('permission.allow') });
  if (ok) await allowSkillDownloads();
  return ok;
}
