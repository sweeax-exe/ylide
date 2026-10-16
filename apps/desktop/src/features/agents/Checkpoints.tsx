import { TriangleAlert, Undo2 } from 'lucide-react';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Checkpoint } from '../../bindings/Checkpoint';
import { Dialog } from '../../components/Dialog';
import { Badge, Button } from '../../components/ui';
import { useToasts } from '../../state/toasts';
import s from './Checkpoints.module.css';
import { CodeText } from './parts';
import type { RunData } from './run';
import { useAgentRun } from './store';
import { clip, formatTimeOfDay } from './text';

export function Checkpoints({ run }: { run: RunData }) {
  const { t, i18n } = useTranslation('agents');
  const paused = useAgentRun((st) => st.paused);
  const restored = useAgentRun((st) => st.restored);
  const [confirm, setConfirm] = useState<Checkpoint | null>(null);
  const close = useCallback(() => setConfirm(null), []);
  // Undoing while agents still edit the same files would race with them.
  const canRestore = !!run.runId && (run.outcome !== null || paused);

  if (!run.checkpoints.length) return <p className={s.empty}>{t('checkpoints.empty')}</p>;
  return (
    <div className={s.wrap}>
      <p className={s.intro}>{t('checkpoints.intro')}</p>
      <ol className={s.list}>
        {run.checkpoints.map((cp) => {
          const undone = restored.has(cp.id);
          return (
            <li key={cp.id} className={`${s.item} ${undone ? s.undone : ''}`}>
              <span className={s.seq}>{cp.seq}</span>
              <div className={s.text}>
                <span className={s.label}>
                  <CodeText text={cp.label} />
                </span>
                <span className={s.time}>{formatTimeOfDay(cp.createdAtUnixMs, i18n.language)}</span>
              </div>
              {undone ? (
                <Badge tone="neutral">{t('checkpoints.undone')}</Badge>
              ) : (
                <Button size="sm" variant="ghost" icon={<Undo2 size={13} />} disabled={!canRestore} onClick={() => setConfirm(cp)} title={canRestore ? undefined : t('checkpoints.busyHint')}>
                  {t('checkpoints.undo')}
                </Button>
              )}
            </li>
          );
        })}
      </ol>
      {!canRestore && <p className={s.hint}>{t('checkpoints.busyHint')}</p>}
      {confirm && <RestoreDialog checkpoint={confirm} onClose={close} />}
    </div>
  );
}

function RestoreDialog({ checkpoint, onClose }: { checkpoint: Checkpoint; onClose: () => void }) {
  const { t } = useTranslation('agents');
  const restore = useAgentRun((st) => st.restore);
  const push = useToasts((st) => st.push);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    const files = await restore(checkpoint);
    setBusy(false);
    if (files === null) return;
    onClose();
    if (!files.length) {
      push({ tone: 'neutral', title: t('checkpoints.nothing') });
      return;
    }
    const shown = files.slice(0, 6).join(', ');
    const body = files.length > 6 ? t('checkpoints.restoredMore', { files: shown, more: files.length - 6 }) : shown;
    push({ tone: 'success', title: t('checkpoints.restored', { count: files.length }), body });
  };

  return (
    <Dialog
      open
      title={t('checkpoints.confirmTitle')}
      onClose={onClose}
      width={480}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t('common:actions.cancel')}
          </Button>
          <Button variant="danger" icon={<Undo2 size={14} />} onClick={() => void run()} loading={busy}>
            {t('checkpoints.confirm')}
          </Button>
        </>
      }
    >
      <div className={s.dialog}>
        <p className={s.dialogText}>{t('checkpoints.confirmBody', { label: clip(checkpoint.label, 120) })}</p>
        <p className={s.warning}>
          <TriangleAlert size={14} aria-hidden />
          {t('checkpoints.confirmWarning')}
        </p>
      </div>
    </Dialog>
  );
}
