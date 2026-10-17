import { describe, expect, it } from 'vitest';
import registryJson from '../../../../registry/models.json';
import type { Registry } from '../bindings/Registry';
import { addToDraft, dataUrlBytes, dragHasFiles, fitSize, imageFiles, isImageType, MAX_IMAGE_SIDE, MAX_IMAGES, outputType, visionModelNames, type DraftImage } from './images';

const registry = registryJson as unknown as Registry;
const draft = (n: number): DraftImage[] => Array.from({ length: n }, (_, i) => ({ id: `i${i}`, url: 'data:image/png;base64,', width: 1, height: 1, name: '' }));

describe('fitSize', () => {
  it('scales the longest side down to the limit and keeps the aspect', () => {
    expect(fitSize(3840, 2160)).toEqual({ width: 1568, height: 882, scaled: true });
    expect(fitSize(1080, 2400)).toEqual({ width: 706, height: 1568, scaled: true });
    expect(fitSize(4000, 4000)).toEqual({ width: MAX_IMAGE_SIDE, height: MAX_IMAGE_SIDE, scaled: true });
  });
  it('never enlarges, and keeps a thin image at least one pixel wide', () => {
    expect(fitSize(800, 600)).toEqual({ width: 800, height: 600, scaled: false });
    expect(fitSize(1568, 10)).toEqual({ width: 1568, height: 10, scaled: false });
    expect(fitSize(20000, 3)).toEqual({ width: 1568, height: 1, scaled: true });
    expect(fitSize(1000, 500, 100)).toEqual({ width: 100, height: 50, scaled: true });
  });
});

describe('image types', () => {
  it('keeps screenshots lossless and turns photos into JPEG', () => {
    expect(outputType('image/png')).toBe('image/png');
    expect(outputType('image/gif')).toBe('image/png');
    expect(outputType('image/bmp')).toBe('image/png');
    expect(outputType('image/jpeg')).toBe('image/jpeg');
    expect(outputType('image/webp')).toBe('image/jpeg');
  });
  it('accepts the formats a browser decodes and the model reads', () => {
    for (const type of ['image/png', 'image/jpeg', 'image/webp', 'image/gif']) expect(isImageType(type)).toBe(true);
    for (const type of ['image/svg+xml', 'image/heic', 'application/pdf', '']) expect(isImageType(type)).toBe(false);
  });
  it('measures data URLs', () => {
    expect(dataUrlBytes('data:image/png;base64,iVBORw0KGgo=')).toBe(8);
    expect(dataUrlBytes('data:image/png;base64,AAAA')).toBe(3);
    expect(dataUrlBytes('nonsense')).toBe(0);
  });
});

describe('pasted and dropped files', () => {
  const transfer = (files: Array<{ type: string; name: string }>, text = ''): DataTransfer =>
    ({ files, types: files.length ? ['Files'] : ['text/plain'], getData: (t: string) => (t === 'text/plain' ? text : '') }) as unknown as DataTransfer;

  it('takes the images among the files', () => {
    const data = transfer([{ type: 'image/png', name: 'image.png' }, { type: 'text/plain', name: 'notes.txt' }, { type: 'image/jpeg', name: 'photo.jpg' }]);
    expect(imageFiles(data).map((f) => f.name)).toEqual(['image.png', 'photo.jpg']);
    expect(dragHasFiles(data)).toBe(true);
    expect(imageFiles(null)).toEqual([]);
  });
  it('lets pasted text win (spreadsheets put a picture of the cells on the clipboard too)', () => {
    const data = transfer([{ type: 'image/png', name: 'image.png' }], 'A1\tB1');
    expect(imageFiles(data, { textWins: true })).toEqual([]);
    expect(imageFiles(data)).toHaveLength(1);
    expect(dragHasFiles(transfer([], 'text'))).toBe(false);
  });
});

describe('drafts', () => {
  it('holds at most MAX_IMAGES and says how many did not fit', () => {
    expect(addToDraft(draft(2), draft(3))).toEqual({ images: [...draft(2), ...draft(3)], dropped: 0 });
    const full = addToDraft(draft(MAX_IMAGES - 1), draft(3));
    expect(full.images).toHaveLength(MAX_IMAGES);
    expect(full.dropped).toBe(2);
    expect(addToDraft(draft(MAX_IMAGES), draft(1))).toEqual({ images: draft(MAX_IMAGES), dropped: 1 });
  });
});

describe('visionModelNames', () => {
  it('lists the chat models of the model list that see, without the uncensored ones', () => {
    const names = visionModelNames(registry);
    expect(names).toContain('Qwen3.6 35B-A3B');
    expect(names.some((n) => /uncensored/i.test(n))).toBe(false);
    expect(names.some((n) => /gpt-oss|Coder-Next/i.test(n))).toBe(false);
    expect(visionModelNames(null)).toEqual([]);
  });
});
