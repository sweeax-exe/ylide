// A skill's SKILL.md in full, as the models get it. Shown on "View content"
// and before a skill is switched on for the first time. Works for an installed
// skill and for a recommended one that is not installed yet (the loader
// decides where the text comes from).

import { ShieldAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { SkillContent } from '../../bindings/SkillContent';
import { Button, Spinner } from '../../components/ui';
import { errorText } from '../../lib/errors';
import { Note } from '../settings/page/controls';
import { SettingsDialog } from '../settings/page/SettingsDialog';
import s from './Skills.module.css';

type Load = { state: 'loading' } | { state: 'ready'; content: SkillContent } | { state: 'error'; message: string };

export function ContentDialog({
  name,
  load,
  open,
  confirm,
  busy,
  note,
  enableLabel,
  onEnable,
  onClose,
}: {
  name: string;
  /** Reads the content; for installed skills from the store, for recommended ones from the bundle. */
  load: () => Promise<SkillContent>;
  open: boolean;
  /** Asks to switch the skill on (its first time) instead of only showing it. */
  confirm: boolean;
  busy?: boolean;
  /** An extra note under the trust note (e.g. a recommended skill needs an MCP server). */
  note?: ReactNode;
  /** Label of the confirm button; defaults to "Switch on". */
  enableLabel?: string;
  onEnable: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation('skills');
  const [content, setContent] = useState<Load>({ state: 'loading' });

  useEffect(() => {
    if (!open) return;
    let live = true;
    setContent({ state: 'loading' });
    load()
      .then((c) => live && setContent({ state: 'ready', content: c }))
      .catch((e: unknown) => live && setContent({ state: 'error', message: errorText(e) }));
    return () => {
      live = false;
    };
    // `load` is recreated per render; `open` and `name` are the real inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, name]);

  const others = content.state === 'ready' ? content.content.files.filter((f) => f !== 'SKILL.md') : [];
  return (
    <SettingsDialog
      open={open}
      width={780}
      title={t('content.title', { name })}
      onClose={() => !busy && onClose()}
      footer={
        confirm ? (
          <>
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              {t('common:actions.cancel')}
            </Button>
            <Button variant="primary" loading={busy} disabled={content.state !== 'ready'} onClick={onEnable} data-autofocus>
              {enableLabel ?? t('content.enable')}
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
        {note}
        {content.state === 'loading' && (
          <div className={s.loading}>
            <Spinner label={t('content.loading')} />
          </div>
        )}
        {content.state === 'error' && <Note tone="danger">{t('content.failed', { message: content.message })}</Note>}
        {content.state === 'ready' && (
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
            <pre className={`${s.text} selectable`} tabIndex={0} aria-label={t('content.textLabel', { name })}>
              {content.content.text}
            </pre>
          </>
        )}
      </div>
    </SettingsDialog>
  );
}
