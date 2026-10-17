// A skill's SKILL.md in full, as the models get it. Shown on "View content"
// and before a skill is switched on for the first time.

import { ShieldAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { SkillContent } from '../../bindings/SkillContent';
import type { SkillInfo } from '../../bindings/SkillInfo';
import { Button, Spinner } from '../../components/ui';
import { errorText } from '../../lib/errors';
import { api } from '../../lib/ipc';
import { Note } from '../settings/page/controls';
import { SettingsDialog } from '../settings/page/SettingsDialog';
import s from './Skills.module.css';

type Load = { state: 'loading' } | { state: 'ready'; content: SkillContent } | { state: 'error'; message: string };

export function ContentDialog({
  skill,
  open,
  confirm,
  busy,
  onEnable,
  onClose,
}: {
  skill: SkillInfo;
  open: boolean;
  /** Asks to switch the skill on (its first time) instead of only showing it. */
  confirm: boolean;
  busy?: boolean;
  onEnable: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation('skills');
  const [load, setLoad] = useState<Load>({ state: 'loading' });

  useEffect(() => {
    if (!open) return;
    let live = true;
    setLoad({ state: 'loading' });
    api.skills
      .content(skill.id)
      .then((content) => live && setLoad({ state: 'ready', content }))
      .catch((e: unknown) => live && setLoad({ state: 'error', message: errorText(e) }));
    return () => {
      live = false;
    };
  }, [open, skill.id]);

  const others = load.state === 'ready' ? load.content.files.filter((f) => f !== 'SKILL.md') : [];
  return (
    <SettingsDialog
      open={open}
      width={780}
      title={t('content.title', { name: skill.name })}
      onClose={() => !busy && onClose()}
      footer={
        confirm ? (
          <>
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              {t('common:actions.cancel')}
            </Button>
            <Button variant="primary" loading={busy} disabled={load.state !== 'ready'} onClick={onEnable} data-autofocus>
              {t('content.enable')}
            </Button>
          </>
        ) : (
          <Button onClick={onClose} data-autofocus>
            {t('common:actions.close')}
          </Button>
        )
      }
    >
      <div className={s.dialogBody}>
        <Note icon={<ShieldAlert size={15} aria-hidden />}>{confirm ? t('content.confirmNote') : t('content.note')}</Note>
        {load.state === 'loading' && (
          <div className={s.loading}>
            <Spinner label={t('content.loading')} />
          </div>
        )}
        {load.state === 'error' && <Note tone="danger">{t('content.failed', { message: load.message })}</Note>}
        {load.state === 'ready' && (
          <>
            {others.length > 0 && (
              <p className={s.fileList}>
                {t('content.files', { count: others.length })}{' '}
                {others.map((f, i) => (
                  <span key={f}>
                    {i > 0 && ', '}
                    <code>{f}</code>
                  </span>
                ))}
              </p>
            )}
            <pre className={`${s.text} selectable`} tabIndex={0} aria-label={t('content.textLabel', { name: skill.name })}>
              {load.content.text}
            </pre>
          </>
        )}
      </div>
    </SettingsDialog>
  );
}
