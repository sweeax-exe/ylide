// Images in the chat composer and the agent request: thumbnails, the attach
// button, and paste/drop handling. Which model can see decides whether
// images are accepted at all; the hint says what to do otherwise.

import { ImagePlus, X } from 'lucide-react';
import { useCallback, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { Registry } from '../bindings/Registry';
import type { ServerInfo } from '../bindings/ServerInfo';
import i18n from '../i18n';
import { reportError } from '../lib/errors';
import { formatNumber } from '../lib/format';
import { addToDraft, dataUrlToBlob, dragHasFiles, ImageError, imageFiles, MAX_IMAGES, prepareFiles, prepareImage, visionModelNames, type DraftImage } from '../lib/images';
import { api, pickImages } from '../lib/ipc';
import { useApp } from '../state/app';
import { useToasts } from '../state/toasts';
import s from './ImageInput.module.css';
import { IconButton } from './ui';

export interface Vision {
  /** The running model takes images now. */
  canSee: boolean;
  /** Why not, and what to do (empty while it can). */
  hint: string;
}

/** Why the running model takes no images, in words. */
export function visionHint(server: ServerInfo | null, registry: Registry | null): string {
  const t = i18n.t.bind(i18n);
  const models = visionModelNames(registry);
  const list = models.length ? t('common:images.visionModels', { models: models.join(', ') }) : '';
  if (!server || server.status.state !== 'ready') return t('common:images.noModel');
  if (server.vision === 'on') return '';
  if (server.vision === 'missing' || server.vision === 'failed') return t(`common:images.${server.vision}`, { model: server.modelName });
  const entry = registry?.models.find((m) => m.id === server.modelId);
  if (entry?.capabilities.vision) return t('common:images.switchOn', { model: server.modelName });
  return `${t('common:images.cannotSee', { model: server.modelName })} ${list}`.trim();
}

/** Lets the user pick image files; the core reads them, the web view scales them down. */
async function pickAndPrepareImages(): Promise<DraftImage[]> {
  const out: DraftImage[] = [];
  for (const path of await pickImages()) {
    const url = await api.images.load(path);
    out.push(await prepareImage(dataUrlToBlob(url), path.split(/[\\/]/).pop() ?? ''));
  }
  return out;
}

export function useVision(): Vision {
  const server = useApp((st) => st.server);
  const registry = useApp((st) => st.registry);
  const canSee = server?.status.state === 'ready' && server.vision === 'on';
  return { canSee, hint: canSee ? '' : visionHint(server, registry) };
}

/** Images held by one form (an answer, a message to an agent), readable while new ones are prepared. */
export function useDraftImages(): [DraftImage[], () => DraftImage[], (images: DraftImage[]) => void] {
  const [images, setState] = useState<DraftImage[]>([]);
  const current = useRef(images);
  const set = useCallback((next: DraftImage[]) => {
    current.current = next;
    setState(next);
  }, []);
  const get = useCallback(() => current.current, []);
  return [images, get, set];
}

/** Paste, drop and the attach button for one draft (`images` reads it fresh: preparing takes a moment). */
export function useImageInput(images: () => DraftImage[], setImages: (images: DraftImage[]) => void, vision: Vision) {
  const { t } = useTranslation('common');
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);

  const add = async (prepare: () => Promise<DraftImage[]>) => {
    if (!vision.canSee) {
      useToasts.getState().push({ tone: 'warning', title: t('images.notSent'), body: vision.hint });
      return;
    }
    setBusy(true);
    try {
      const prepared = await prepare();
      if (!prepared.length) return;
      // The draft may have changed while the images were prepared.
      const { images: next, dropped } = addToDraft(images(), prepared);
      setImages(next);
      if (dropped) useToasts.getState().push({ tone: 'warning', title: t('images.problem.tooMany', { max: MAX_IMAGES }) });
    } catch (e) {
      if (e instanceof ImageError) useToasts.getState().push({ tone: 'warning', title: t(`images.problem.${e.problem}`) });
      else reportError(e, t('images.problem.damaged'));
    } finally {
      setBusy(false);
    }
  };

  return {
    busy,
    dragging,
    pick: () => void add(pickAndPrepareImages),
    remove: (id: string) => setImages(images().filter((i) => i.id !== id)),
    /** Pasted images are attached; pasted text is inserted as usual. */
    onPaste: (e: ClipboardEvent) => {
      const files = imageFiles(e.clipboardData, { textWins: true });
      if (!files.length) return;
      e.preventDefault();
      void add(() => prepareFiles(files));
    },
    onDragOver: (e: DragEvent) => {
      if (!dragHasFiles(e.dataTransfer)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = vision.canSee ? 'copy' : 'none';
      setDragging(true);
    },
    onDragLeave: (e: DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
    },
    onDrop: (e: DragEvent) => {
      if (!dragHasFiles(e.dataTransfer)) return;
      e.preventDefault();
      setDragging(false);
      const files = imageFiles(e.dataTransfer);
      if (files.length) void add(() => prepareFiles(files));
      else useToasts.getState().push({ tone: 'warning', title: t('images.problem.unsupported') });
    },
  };
}

/** The attach button: disabled with the reason as tooltip while the model cannot see. */
export function AttachImagesButton({ vision, onPick, busy, disabled }: { vision: Vision; onPick: () => void; busy?: boolean; disabled?: boolean }) {
  const { t } = useTranslation('common');
  return (
    <IconButton
      label={vision.canSee ? t('images.attach') : `${t('images.attach')}: ${vision.hint}`}
      onClick={onPick}
      disabled={!vision.canSee || busy || disabled}
      aria-busy={busy || undefined}
    >
      <ImagePlus size={15} />
    </IconButton>
  );
}

/** Thumbnails; with `onRemove`, each has a remove button. */
export function ImageStrip({ images, onRemove, size = 'md' }: { images: string[] | DraftImage[]; onRemove?: (id: string) => void; size?: 'sm' | 'md' }) {
  const { t } = useTranslation('common');
  if (!images.length) return null;
  const items = images.map((img, i) => (typeof img === 'string' ? { id: String(i), url: img, width: 0, height: 0, name: '' } : img));
  return (
    <ul className={`${s.strip} ${size === 'sm' ? s.small : ''}`} aria-label={t('images.attached', { n: items.length })}>
      {items.map((img, i) => {
        const label = img.width
          ? t('images.label', { n: i + 1, name: img.name || t('images.pasted'), size: `${formatNumber(img.width)} × ${formatNumber(img.height)}` })
          : t('images.labelShort', { n: i + 1 });
        return (
          <li key={img.id} className={s.item}>
            <img className={s.thumb} src={img.url} alt={label} title={label} draggable={false} />
            {onRemove && (
              <button type="button" className={s.remove} aria-label={t('images.remove', { label })} title={t('images.remove', { label })} onClick={() => onRemove(img.id)}>
                <X size={11} aria-hidden />
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
