// Images for models that see: pasted, dropped or picked images are scaled
// down and re-encoded here before they go to the model. Fewer pixels mean
// fewer image tokens (the core caps an image at 2048), and re-encoding drops
// metadata such as the GPS position of a photo. The sizes are pure functions
// so they can be tested without a browser.

import type { Registry } from '../bindings/Registry';

/** Longest side after scaling down: enough to read a screenshot, about 1,350 tokens at 16:9. */
export const MAX_IMAGE_SIDE = 1568;
/** Images per message or agent request. */
export const MAX_IMAGES = 6;
/** Larger source files are refused before decoding (the core takes 20 MB). */
export const MAX_SOURCE_BYTES = 20 << 20;

const SOURCE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp'];

export interface DraftImage {
  id: string;
  /** `data:image/png;base64,...` or `data:image/jpeg;base64,...`, as sent. */
  url: string;
  width: number;
  height: number;
  /** File name, or empty for pasted images. */
  name: string;
}

export type ImageProblem = 'unsupported' | 'tooLarge' | 'damaged' | 'tooMany';

export class ImageError extends Error {
  constructor(readonly problem: ImageProblem) {
    super(problem);
  }
}

/** The size an image is scaled down to: the longest side at most `max`, the aspect kept, never enlarged. */
export function fitSize(width: number, height: number, max = MAX_IMAGE_SIDE): { width: number; height: number; scaled: boolean } {
  const longest = Math.max(width, height);
  if (longest <= max) return { width, height, scaled: false };
  const factor = max / longest;
  return { width: Math.max(1, Math.round(width * factor)), height: Math.max(1, Math.round(height * factor)), scaled: true };
}

/** Screenshots and graphics stay lossless PNG; photos become JPEG. */
export function outputType(sourceType: string): 'image/png' | 'image/jpeg' {
  return sourceType === 'image/jpeg' || sourceType === 'image/webp' ? 'image/jpeg' : 'image/png';
}

export function isImageType(type: string): boolean {
  return SOURCE_TYPES.includes(type);
}

/** Bytes behind a base64 data URL. */
export function dataUrlBytes(url: string): number {
  const comma = url.indexOf(',');
  const payload = comma < 0 ? '' : url.slice(comma + 1);
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((payload.length * 3) / 4) - padding);
}

/** Image files of a paste or drop. Pasted text wins: copying from an app such as Excel puts both on the clipboard. */
export function imageFiles(data: DataTransfer | null, { textWins = false } = {}): File[] {
  if (!data) return [];
  if (textWins && data.getData('text/plain').trim()) return [];
  return Array.from(data.files).filter((f) => isImageType(f.type));
}

/** Whether a drag carries files (the images among them are only known on drop). */
export function dragHasFiles(data: DataTransfer | null): boolean {
  return !!data && Array.from(data.types).includes('Files');
}

/** Names of the registry's models that can see images, for "use one of these" hints. */
export function visionModelNames(registry: Registry | null): string[] {
  return (registry?.models ?? []).filter((m) => m.capabilities.vision && !m.uncensored && (m.roles.includes('chat') || m.roles.includes('agent'))).map((m) => m.name);
}

let counter = 0;
const nextId = () => `img-${Date.now().toString(36)}-${++counter}`;

/** Scales an image down to MAX_IMAGE_SIDE and encodes it as a data URL. */
export async function prepareImage(blob: Blob, name = ''): Promise<DraftImage> {
  if (!isImageType(blob.type)) throw new ImageError('unsupported');
  if (blob.size > MAX_SOURCE_BYTES) throw new ImageError('tooLarge');
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    throw new ImageError('damaged');
  }
  const size = fitSize(bitmap.width, bitmap.height);
  const type = outputType(blob.type);
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new ImageError('damaged');
  if (type === 'image/jpeg') {
    // JPEG has no transparency; transparent parts of a WebP become white, not black.
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, size.width, size.height);
  }
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, size.width, size.height);
  bitmap.close();
  return { id: nextId(), url: canvas.toDataURL(type, 0.9), width: size.width, height: size.height, name };
}

/** A data URL from the core, as a Blob (the web view may not fetch data URLs). */
export function dataUrlToBlob(url: string): Blob {
  const [head, payload = ''] = url.split(',', 2);
  const type = head.replace(/^data:/, '').replace(/;base64$/, '');
  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type });
}

/** Prepares pasted or dropped files; files that are no images are skipped. */
export async function prepareFiles(files: File[]): Promise<DraftImage[]> {
  return Promise.all(files.filter((f) => isImageType(f.type)).map((f) => prepareImage(f, f.name === 'image.png' ? '' : f.name)));
}

/** Adds images to a draft, up to MAX_IMAGES; `dropped` did not fit. */
export function addToDraft(draft: DraftImage[], added: DraftImage[]): { images: DraftImage[]; dropped: number } {
  const room = Math.max(0, MAX_IMAGES - draft.length);
  return { images: [...draft, ...added.slice(0, room)], dropped: Math.max(0, added.length - room) };
}
