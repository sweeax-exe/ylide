import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matches, mergeOverwrites, sameOverwrites, inOrder, sidebarOrder } from '../src/setup/compare.js';

test('matches ignores fields Discord adds', () => {
  const desired = { type: 17, accent_color: 1, components: [{ type: 10, content: 'Hi' }] };
  const live = { type: 17, id: 1, accent_color: 1, spoiler: false, components: [{ type: 10, id: 2, content: 'Hi' }] };
  assert.ok(matches(desired, live));
  assert.ok(!matches({ ...desired, accent_color: 2 }, live));
  assert.ok(!matches({ ...desired, components: [] }, live));
});

test('attachment URLs match the uploaded file name', () => {
  const desired = { media: { url: 'attachment://banner-abc.png' } };
  assert.ok(matches(desired, { media: { url: 'https://cdn.discordapp.com/attachments/1/2/banner-abc.png?ex=1&is=2' } }));
  assert.ok(!matches(desired, { media: { url: 'https://cdn.discordapp.com/attachments/1/2/banner-old.png?ex=1' } }));
});

test('permissions compare as numbers', () => {
  assert.ok(matches(8n, '8'));
  assert.ok(!matches(8n, '0'));
});

test('channel overwrites win over the category', () => {
  const merged = mergeOverwrites(
    [{ target: 'everyone', allow: 0n, deny: 0b0110n }],
    [{ target: 'everyone', allow: 0b0010n, deny: 0b1000n }, { target: 'support', allow: 1n, deny: 0n }],
  );
  assert.deepEqual(merged, [
    { target: 'everyone', allow: 0b0010n, deny: 0b1100n },
    { target: 'support', allow: 1n, deny: 0n },
  ]);
});

test('overwrites compare regardless of order and string/number form', () => {
  const a = [
    { id: '2', type: 0, allow: 1n, deny: 0n },
    { id: '1', type: 1, allow: '0', deny: '1024' },
  ];
  const b = [
    { id: '1', type: 1, allow: '0', deny: '1024' },
    { id: '2', type: 0, allow: '1', deny: '0' },
    { id: '3', type: 0, allow: '0', deny: '0' },
  ];
  assert.ok(sameOverwrites(a, b));
  assert.ok(!sameOverwrites(a, [b[0]]));
});

test('sidebar order uses position, then id', () => {
  const sorted = sidebarOrder([
    { id: '30', position: 1 },
    { id: '20', position: 0 },
    { id: '10', position: 1 },
  ]);
  assert.deepEqual(
    sorted.map((c) => c.id),
    ['20', '10', '30'],
  );
  assert.ok(inOrder(sorted, ['20', '30']));
  assert.ok(!inOrder(sorted, ['30', '10']));
  assert.ok(!inOrder(sorted, ['20', '99']));
});
