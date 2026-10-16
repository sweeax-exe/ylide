// Models on disk: which one is used for what, switching, deleting, importing.

import { Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { InstalledModel } from '../../../bindings/InstalledModel';
import type { ModelSelection } from '../../../bindings/ModelSelection';
import { Badge, Button, EmptyState, IconButton } from '../../../components/ui';
import { reportError } from '../../../lib/errors';
import { formatGB } from '../../../lib/format';
import { api } from '../../../lib/ipc';
import { useApp } from '../../../state/app';
import { saveSettings } from '../page/save';
import { keepFocusInSection } from '../page/focus';
import { MODEL_SECTIONS } from '../page/ids';
import { PageSection } from '../page/Page';
import { SettingsDialog } from '../page/SettingsDialog';
import { assignModel, slotFor } from './assign';
import { ImportButton } from './ImportButton';
import s from './InstalledModels.module.css';
import { UncensoredBadge } from './Uncensored';

const matches = (sel: ModelSelection | null, m: InstalledModel) => !!sel && sel.modelId === m.modelId && sel.quant === m.quant;
const bytes = (m: InstalledModel) => m.files.reduce((sum, f) => sum + f.sizeBytes, 0);

export function InstalledModels() {
  const { t } = useTranslation('settings');
  const installed = useApp((st) => st.installed);
  const importButton = useRef<HTMLButtonElement>(null);
  // The deleted row, and the button that opened its dialog, are gone; keep focus in this section.
  const focusSection = () => requestAnimationFrame(() => importButton.current?.focus());

  return (
    <PageSection
      id={MODEL_SECTIONS.installed}
      title={t('installed.title')}
      description={t('installed.description')}
      actions={installed.length > 0 ? <ImportButton ref={importButton} /> : undefined}
    >
      {installed.length === 0 ? (
        <div className={s.empty}>
          <EmptyState title={t('installed.emptyTitle')} body={t('installed.emptyBody')} action={<ImportButton ref={importButton} size="md" />} />
        </div>
      ) : (
        <ul className={s.list}>
          {installed.map((m) => (
            <InstalledRow key={`${m.modelId}::${m.quant}`} model={m} onRemoved={focusSection} />
          ))}
        </ul>
      )}
    </PageSection>
  );
}

function InstalledRow({ model, onRemoved }: { model: InstalledModel; onRemoved: () => void }) {
  const { t } = useTranslation('settings');
  const server = useApp((st) => st.server);
  const settings = useApp((st) => st.settings);
  const registry = useApp((st) => st.registry);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const entry = registry?.models.find((r) => r.id === model.modelId);
  const slot = slotFor(entry?.roles);
  const active = !!server && server.runtime !== 'external' && server.modelId === model.modelId && server.quant === model.quant && server.status.state !== 'stopped' && server.status.state !== 'crashed';
  const usedFor = (['chat', 'autocomplete', 'embedding'] as const).filter((k) => matches(settings?.models[k] ?? null, model));
  const assigned = usedFor.includes(slot);
  // The chat model can be started when it is selected but not running; other slots only need assigning.
  const action: 'use' | 'start' | null = slot === 'chat' ? (active ? null : assigned ? 'start' : 'use') : assigned ? null : 'use';

  const use = async (from: HTMLElement) => {
    // The button disappears once the model runs or is assigned.
    const restoreFocus = keepFocusInSection(from);
    setBusy(true);
    try {
      await assignModel(model, slot);
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(false);
      restoreFocus();
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      if (active) await api.server.stop();
      await api.models.remove(model.modelId, model.quant);
      if (usedFor.length) {
        await saveSettings((d) => {
          for (const k of usedFor) d.models[k] = null;
        });
      }
      await useApp.getState().refreshModels();
      setConfirm(false);
      onRemoved();
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(false);
    }
  };

  const path = model.files[0]?.path ?? '';
  return (
    <li className={s.row}>
      <div className={s.main}>
        <div className={s.titleLine}>
          <span className={s.name}>{model.name}</span>
          {entry?.uncensored && <UncensoredBadge />}
          <Badge tone="metal">{model.quant || t('installed.unknownQuant')}</Badge>
          {active && <Badge tone="success">{t('installed.active')}</Badge>}
          {usedFor.map((k) => (
            <Badge key={k} tone="accent">
              {t(`installed.usedFor.${k}`)}
            </Badge>
          ))}
          {model.custom && <Badge>{t('installed.custom')}</Badge>}
        </div>
        <div className={s.meta}>
          <span className="tabular">{t('installed.size', { size: formatGB(bytes(model)) })}</span>
          {model.files.length > 1 && <span className="tabular">{t('installed.files', { count: model.files.length })}</span>}
          <code className={`${s.path} selectable`} title={model.files.map((f) => f.path).join('\n')}>
            {path}
          </code>
        </div>
      </div>
      <div className={s.actions}>
        {action && (
          <Button size="sm" loading={busy && !confirm} disabled={busy} onClick={(e) => void use(e.currentTarget)}>
            {action === 'start' ? t('installed.start') : t(`installed.use.${slot}`)}
          </Button>
        )}
        <IconButton label={t('installed.delete', { name: `${model.name} ${model.quant}` })} onClick={() => setConfirm(true)} disabled={busy}>
          <Trash2 size={14} />
        </IconButton>
      </div>
      <SettingsDialog
        open={confirm}
        title={t('installed.deleteTitle', { name: `${model.name} ${model.quant}` })}
        onClose={() => !busy && setConfirm(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(false)} disabled={busy} data-autofocus>
              {t('common:actions.cancel')}
            </Button>
            <Button variant="danger" loading={busy} onClick={() => void remove()}>
              {t('common:actions.delete')}
            </Button>
          </>
        }
      >
        <div className={s.dialogBody}>
          <p>{model.custom ? t('installed.forgetBody') : t('installed.deleteBody', { size: formatGB(bytes(model)) })}</p>
          {active && <p className={s.warn}>{t('installed.deleteActive')}</p>}
          {usedFor.length > 0 && <p>{t('installed.deleteAssigned')}</p>}
          {!model.custom && <p>{t('installed.deleteAgain')}</p>}
        </div>
      </SettingsDialog>
    </li>
  );
}
