// Models on disk: which one is used for what, switching, deleting, importing.

import { ImagePlus, Trash2, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { InstalledModel } from '../../../bindings/InstalledModel';
import type { ModelSelection } from '../../../bindings/ModelSelection';
import { Badge, Button, EmptyState, IconButton, Switch } from '../../../components/ui';
import { reportError } from '../../../lib/errors';
import { formatGB, formatNumber } from '../../../lib/format';
import { api, pickProjector } from '../../../lib/ipc';
import { useApp } from '../../../state/app';
import { fraction } from '../logic/downloads';
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
const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;
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
        <VisionControl model={model} active={active} />
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

/**
 * Image input of a model: a switch for registry models with a vision
 * projector (it downloads the projector, off deletes it again), and a file
 * of the user's own for imported models. It takes effect at the next start.
 */
function VisionControl({ model, active }: { model: InstalledModel; active: boolean }) {
  const { t } = useTranslation('settings');
  const registry = useApp((st) => st.registry);
  const server = useApp((st) => st.server);
  const job = useApp((st) => st.downloads[`${model.modelId}@mmproj`]);
  const [busy, setBusy] = useState(false);
  const projector = registry?.models.find((r) => r.id === model.modelId)?.projector ?? null;
  const downloading = job?.state.state === 'running';
  const on = !!model.projector;
  if (!projector && !model.custom) return null;

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
      await useApp.getState().refreshModels();
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(false);
    }
  };
  const toggle = (v: boolean) =>
    void run(async () => {
      if (v) await api.models.downloadProjector(model.modelId);
      else if (downloading && job) await api.models.cancel(job.jobId);
      else await api.models.setProjector(model.modelId, null);
    });
  const pick = () =>
    void run(async () => {
      const path = await pickProjector();
      if (path) await api.models.setProjector(model.modelId, path);
    });

  // The running server shows what was loaded; a change waits for the next start.
  const running = active && server?.status.state === 'ready';
  const loaded = server?.vision === 'on';
  const pending = running && on !== loaded && !downloading && server?.vision !== 'missing' && server?.vision !== 'failed';
  const restart = () => void run(() => api.server.start({ modelId: model.modelId, quant: model.quant }));

  let status: string | null = null;
  if (downloading && job) status = t('installed.vision.downloading', { percent: formatNumber(Math.round(fraction(job) * 100)) });
  else if (job?.state.state === 'failed') status = t('installed.vision.downloadFailed');
  else if (running && on && (server?.vision === 'missing' || server?.vision === 'failed')) status = t(`installed.vision.${server.vision}`);
  else if (pending) status = t('installed.vision.pending');

  return (
    <div className={s.vision}>
      {projector ? (
        <Switch
          checked={on || downloading}
          disabled={busy}
          onChange={toggle}
          label={t('installed.vision.label', { size: formatGB(projector.sizeBytes) })}
        />
      ) : on && model.projector ? (
        <span className={s.visionFile}>
          <span>{t('installed.vision.own', { file: fileName(model.projector.path) })}</span>
          <IconButton label={t('installed.vision.removeOwn')} onClick={() => void run(() => api.models.setProjector(model.modelId, null))} disabled={busy}>
            <X size={13} />
          </IconButton>
        </span>
      ) : (
        <Button size="sm" variant="ghost" icon={<ImagePlus size={13} />} onClick={pick} loading={busy}>
          {t('installed.vision.pick')}
        </Button>
      )}
      {status && <span className={s.visionStatus}>{status}</span>}
      {pending && (
        <Button size="sm" variant="ghost" onClick={restart} disabled={busy}>
          {t('installed.vision.restart')}
        </Button>
      )}
    </div>
  );
}
